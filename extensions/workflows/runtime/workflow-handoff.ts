/**
 * Durable operator handoff contract and source-adjacent claim state.
 *
 * The workflow declares questions; the runner supplies origin and executable
 * identity. result.json remains immutable after publication. Mutable
 * cross-process exclusion lives only in the adjacent claim sidecar.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { WorkflowArtifactRef, WorkflowContinuation } from "./workflow-artifacts.js";
import {
  readWorkflowRunResult,
  readWorkflowRunSummary,
  workflowPersistedResultInvalidity,
} from "./workflow-journal.js";
import { resolveWorkflowRunDir } from "./workflow-run-layout.js";
import { projectWorkflowDisposition, workflowResultFile } from "./workflow-result.js";
import {
  readWorkflowRunTextFile,
  removeWorkflowRunFile,
  renameWorkflowRunFile,
  workflowRunFileExists,
  workflowRunFileMtimeMs,
  workflowRunRuntimeFile,
  writeWorkflowRunFile,
} from "./workflow-run-layout.js";
import {
  assessWorkflowSourceIdentity,
  sha256WorkflowBytes,
  type WorkflowScriptIdentity,
} from "./workflow-script-identity.js";
import { parseWorkflowTargetIdentity, workflowTargetIdentityKey } from "./workflow-saved-name.js";
import { isWorkflowPathWithinRoot } from "./workflow-output.js";

import {
  SAFE_COMPONENT,
  SHA256,
  assertSafeComponent,
  cloneArtifactRef,
  isRecord,
  normalizeArtifactRefs,
  normalizeWorkflowOperatorHandoffDeclaration,
  requireAllowedKeys,
  requireExactRecord,
  requireRecord,
  sameArtifactRef,
  type WorkflowOperatorHandoffDeclaration,
  type WorkflowOperatorQuestion,
} from "./workflow-handoff-contract.js";

/**
 * The declaration half is re-exported so a caller that reads both a declaration
 * and the envelope published from it keeps one import. A caller that needs only
 * the declaration should import `./workflow-handoff-contract.js` directly.
 */
export {
  normalizeWorkflowAwaitOperatorDeclaration,
  normalizeWorkflowOperatorHandoffDeclaration,
} from "./workflow-handoff-contract.js";
export type {
  WorkflowAwaitOperatorDeclaration,
  WorkflowOperatorHandoffDeclaration,
  WorkflowOperatorQuestion,
  WorkflowOperatorSelectQuestion,
  WorkflowOperatorTextQuestion,
} from "./workflow-handoff-contract.js";

export const WORKFLOW_OPERATOR_HANDOFF_VERSION = "locus.workflow.operator-handoff.v1" as const;
export const WORKFLOW_HANDOFF_CLAIM_VERSION = "locus.workflow.operator-handoff-claim.v1" as const;
const WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION = "locus.workflow.operator-handoff-claim-lock.v1" as const;

/**
 * The two lease timers of this module, kept together because they are read together
 * and are constantly mistaken for each other.
 *
 * Neither bounds anybody's work, and neither one alone hands a claim to a second
 * operator:
 *
 *  - PRESTART lease (5 minutes): how long a claim with no continuation run bound to
 *    it is treated as still being prepared. Expiry only makes the claim ELIGIBLE for
 *    takeover. The takeover itself happens under the exclusive lock below, after
 *    re-reading the claim state, and only while `childRunId` is still absent — i.e.
 *    only while no run exists whose liveness could be checked. Once a run is bound,
 *    time never decides anything: `readWorkflowRunSummary` does, and only a `failed`
 *    or `cancelled` child releases the claim.
 *  - LOCK lease (30 seconds): how long an unreleased claim-transition lock file is
 *    honoured before a peer may break it. A broken lock never grants ownership by
 *    itself either: every mutation re-checks `ownerToken` through
 *    `assertClaimLockOwned`, and every lease-driven mutation re-checks the claim's
 *    own `claimId` through `assertClaimOwnedByLease`. A displaced holder therefore
 *    fails loudly on its next write instead of silently writing beside the winner.
 *
 * Both are overridable per call (`prestartStaleMs`, `lockStaleMs`) for tests and for
 * an operator surface that knows better.
 */
export const DEFAULT_WORKFLOW_HANDOFF_PRESTART_STALE_MS = 5 * 60 * 1000;
const DEFAULT_WORKFLOW_HANDOFF_LOCK_STALE_MS = 30 * 1000;
const HANDOFF_CLAIM_FILE = "operator-handoff-claim.json";
const HANDOFF_CLAIM_LOCK_FILE = "operator-handoff-claim.lock";

export interface WorkflowOperatorTargetIdentity {
  kind: "name" | "scriptPath";
  ref: string;
  source: "project" | "personal" | "package";
}

export interface WorkflowOperatorScriptIdentity {
  schemaVersion: 2;
  identityPolicy: "static-node-only-v1";
  scriptSha256: string;
  identityCoverage: "self-contained-static" | "entry-only";
  executionSource: "snapshot" | "source";
}

export interface WorkflowOperatorHandoffEnvelope {
  version: typeof WORKFLOW_OPERATOR_HANDOFF_VERSION;
  handoffId: string;
  originRunId: string;
  title: string;
  questions: WorkflowOperatorQuestion[];
  continuationArtifactRefs: WorkflowArtifactRef[];
  target: WorkflowOperatorTargetIdentity;
  scriptIdentity: WorkflowOperatorScriptIdentity;
}

export type WorkflowOperatorHandoffRead =
  | { status: "absent" }
  | { status: "invalid"; message: string }
  | { status: "ready"; handoff: WorkflowOperatorHandoffEnvelope };

export interface WorkflowHandoffClaimState {
  version: typeof WORKFLOW_HANDOFF_CLAIM_VERSION;
  handoffId: string;
  sourceRunId: string;
  claimId: string;
  claimedAt: string;
  childRunId?: string;
}

export interface WorkflowHandoffClaimLease {
  projectRoot: string;
  handoffId: string;
  sourceRunId: string;
  claimId: string;
}

export type WorkflowHandoffClaimRead =
  { status: "absent" } | { status: "invalid"; message: string } | { status: "ready"; state: WorkflowHandoffClaimState };

export type WorkflowHandoffClaimAttempt =
  | { status: "claimed"; claim: WorkflowHandoffClaimLease }
  | { status: "active"; state?: WorkflowHandoffClaimState; message: string }
  | { status: "invalid"; message: string };

export type WorkflowHandoffProjectedState =
  | { status: "pending" }
  | { status: "running"; childRunId?: string }
  | { status: "resolved"; childRunId: string }
  | { status: "retryable"; childRunId?: string; message: string };

export interface WorkflowHandoffClaimOptions {
  now?: () => Date;
  prestartStaleMs?: number;
  lockStaleMs?: number;
}

export function createWorkflowOperatorHandoffEnvelope(input: {
  declaration: WorkflowOperatorHandoffDeclaration;
  runId: string;
  target: WorkflowOperatorTargetIdentity;
  scriptIdentity: WorkflowScriptIdentity;
  terminalArtifactRefs: readonly WorkflowArtifactRef[];
}): WorkflowOperatorHandoffEnvelope {
  assertSafeComponent(input.runId, "operatorHandoff originRunId");
  const declaration = normalizeWorkflowOperatorHandoffDeclaration(input.declaration);
  const target = normalizeTarget(input.target, true);
  const scriptIdentity = normalizeScriptIdentity(input.scriptIdentity, true);
  // The complete published/primary set of the terminal run, not the compact
  // projection result.json prints. A run that published more artifacts than the
  // summary shows can still hand any of them to its continuation.
  const terminalRefs = normalizeArtifactRefs(input.terminalArtifactRefs, true);
  for (const ref of declaration.continuationArtifactRefs) {
    if (ref.runId !== input.runId) {
      throw new Error("Every operatorHandoff continuation artifact must belong to the terminal source run");
    }
    if (!terminalRefs.some((candidate) => sameArtifactRef(candidate, ref))) {
      throw new Error("operatorHandoff continuation artifact is not present in the terminal artifact projection");
    }
  }
  assertQuestionDetailArtifactRefs(declaration.questions, declaration.continuationArtifactRefs, input.runId);
  const envelope: WorkflowOperatorHandoffEnvelope = {
    version: WORKFLOW_OPERATOR_HANDOFF_VERSION,
    handoffId: stableWorkflowHandoffId(input.runId),
    originRunId: input.runId,
    title: declaration.title,
    questions: declaration.questions,
    continuationArtifactRefs: declaration.continuationArtifactRefs,
    target,
    scriptIdentity,
  };
  return normalizeWorkflowOperatorHandoffEnvelope(envelope);
}

export function normalizeWorkflowOperatorHandoffEnvelope(value: unknown): WorkflowOperatorHandoffEnvelope {
  const record = requireExactRecord(
    value,
    [
      "continuationArtifactRefs",
      "handoffId",
      "originRunId",
      "questions",
      "scriptIdentity",
      "target",
      "title",
      "version",
    ],
    "operatorHandoff envelope",
  );
  if (record.version !== WORKFLOW_OPERATOR_HANDOFF_VERSION) {
    throw new Error(`Unsupported operatorHandoff version: ${String(record.version)}`);
  }
  assertSafeComponent(record.handoffId, "operatorHandoff handoffId");
  assertSafeComponent(record.originRunId, "operatorHandoff originRunId");
  if (record.handoffId !== stableWorkflowHandoffId(record.originRunId)) {
    throw new Error("operatorHandoff handoffId does not match its origin run");
  }
  const declaration = normalizeWorkflowOperatorHandoffDeclaration({
    title: record.title,
    questions: record.questions,
    continuationArtifactRefs: record.continuationArtifactRefs,
  });
  for (const ref of declaration.continuationArtifactRefs) {
    if (ref.runId !== record.originRunId) {
      throw new Error("Every operatorHandoff continuation artifact must belong to originRunId");
    }
  }
  assertQuestionDetailArtifactRefs(declaration.questions, declaration.continuationArtifactRefs, record.originRunId);
  return {
    version: WORKFLOW_OPERATOR_HANDOFF_VERSION,
    handoffId: record.handoffId,
    originRunId: record.originRunId,
    ...declaration,
    target: normalizeTarget(record.target),
    scriptIdentity: normalizeScriptIdentity(record.scriptIdentity),
  };
}

/**
 * Parse the handoff from an already parsed result envelope. Absence is the only
 * legacy state; a present malformed/future field is always invalid.
 */
export function readWorkflowOperatorHandoff(value: unknown, projectRoot?: string): WorkflowOperatorHandoffRead {
  if (!isRecord(value)) return { status: "invalid", message: "Workflow result envelope must be an object." };
  if (!Object.prototype.hasOwnProperty.call(value, "operatorHandoff")) return { status: "absent" };
  try {
    const parsedHandoff = normalizeWorkflowOperatorHandoffEnvelope(value.operatorHandoff);
    const handoff: WorkflowOperatorHandoffEnvelope = {
      ...parsedHandoff,
      target: normalizeTarget(parsedHandoff.target, false, projectRoot),
    };
    if (value.runId !== handoff.originRunId) {
      throw new Error("operatorHandoff originRunId does not match the result runId");
    }
    if (value.ok !== true) throw new Error("operatorHandoff requires a successful awaiting result");
    const disposition = projectWorkflowDisposition({
      ok: value.ok,
      result: value.result,
      disposition: value.disposition,
    });
    if (disposition.status !== "awaiting_operator") {
      throw new Error("operatorHandoff requires an exact awaiting_operator disposition with bounded detail");
    }
    if (
      !sameTarget(normalizeTarget(value.target, true, projectRoot), normalizeTarget(handoff.target, false, projectRoot))
    ) {
      throw new Error("operatorHandoff target identity does not match the result target");
    }
    if (!sameScriptIdentity(normalizeScriptIdentity(value.scriptIdentity, true), handoff.scriptIdentity)) {
      throw new Error("operatorHandoff script identity does not match the result script identity");
    }
    // result.json carries only the display projection of artifactRefs, so a
    // continuation artifact published earlier in the run is legitimately absent from
    // it. Identity, digest and provenance of each continuation ref are verified where
    // the bytes are read (`consumeText` against the source run's full index), so
    // membership in this projection is not a precondition here — it would only
    // re-impose the ceiling this envelope was built to survive. Every ref is still
    // structurally validated and confined to the origin run above.
    normalizeArtifactRefs(value.artifactRefs, true);
    return { status: "ready", handoff };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function readPersistedWorkflowOperatorHandoff(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowOperatorHandoffRead {
  try {
    assertSafeComponent(runId, "workflow runId");
    const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, runId);
    const resultPath = workflowResultFile(runDir);
    // A run directory with no result.json has not published a terminal result
    // yet — it is still executing, or it was interrupted. Such a run cannot
    // carry an operator handoff, so absence is the honest answer; calling it
    // invalid would surface every live or abandoned run as a corrupt-evidence
    // warning on the operator surfaces that scan run history.
    if (!workflowRunFileExists(runDir, resultPath)) return { status: "absent" };
    const persisted = readWorkflowRunResult(projectRoot, runId, runDir);
    const invalidity = workflowPersistedResultInvalidity(persisted);
    if (invalidity !== undefined) {
      return { status: "invalid", message: `Workflow result has malformed persisted metadata (${invalidity}).` };
    }
    return readWorkflowOperatorHandoff(JSON.parse(readWorkflowRunTextFile(runDir, resultPath)) as unknown, projectRoot);
  } catch (error) {
    return { status: "invalid", message: handoffFileErrorMessage(error, "Workflow result") };
  }
}

export function workflowContinuationForHandoff(handoff: WorkflowOperatorHandoffEnvelope): WorkflowContinuation {
  const normalized = normalizeWorkflowOperatorHandoffEnvelope(handoff);
  return {
    originRunId: normalized.originRunId,
    artifactRefs: normalized.continuationArtifactRefs.map(cloneArtifactRef),
  };
}

export function assertWorkflowHandoffContinuationEligibility(
  handoff: WorkflowOperatorHandoffEnvelope,
  current: {
    target: WorkflowOperatorTargetIdentity;
    scriptIdentity: WorkflowScriptIdentity | WorkflowOperatorScriptIdentity;
  },
  projectRoot?: string,
): void {
  const normalized = normalizeWorkflowOperatorHandoffEnvelope(handoff);
  if (normalized.scriptIdentity.identityCoverage !== "self-contained-static") {
    throw new Error(
      "Workflow handoff is not actionable because its script identity coverage is not self-contained-static",
    );
  }
  const handoffTarget = normalizeTarget(normalized.target, false, projectRoot);
  const target = normalizeTarget(current.target, true, projectRoot);
  if (!sameTarget(handoffTarget, target)) {
    throw new Error("Workflow handoff target has changed; start the workflow again");
  }
  const identity = normalizeScriptIdentity(current.scriptIdentity, true);
  if (!sameScriptIdentity(normalized.scriptIdentity, identity)) {
    throw new Error("Workflow handoff script identity has changed; start the workflow again");
  }
}

/** Read and assess one exact current source byte sequence without creating a
 * run or snapshot. Controllers pair this with the freshly resolved target. */
export function readCurrentWorkflowScriptIdentity(sourcePath: string): WorkflowOperatorScriptIdentity {
  const bytes = readFileSync(sourcePath);
  const assessment = assessWorkflowSourceIdentity(bytes.toString("utf8"));
  return {
    schemaVersion: 2,
    identityPolicy: "static-node-only-v1",
    scriptSha256: sha256WorkflowBytes(bytes),
    identityCoverage: assessment.identityCoverage,
    executionSource: assessment.identityCoverage === "self-contained-static" ? "snapshot" : "source",
  };
}

export function assertWorkflowHandoffClaimForContinuation(
  claim: WorkflowHandoffClaimLease,
  continuation: WorkflowContinuation,
  projectRoot = claim.projectRoot,
): void {
  assertClaimLease(claim);
  if (path.resolve(projectRoot) !== path.resolve(claim.projectRoot)) {
    throw new Error("Workflow handoff claim belongs to another project root");
  }
  if (continuation.originRunId !== claim.sourceRunId) {
    throw new Error("Workflow handoff claim does not match the continuation origin run");
  }
  const persisted = readPersistedWorkflowOperatorHandoff(claim.projectRoot, claim.sourceRunId);
  if (persisted.status !== "ready") {
    throw new Error(
      persisted.status === "invalid" ? persisted.message : "Workflow handoff claim has no persisted source handoff",
    );
  }
  if (persisted.handoff.handoffId !== claim.handoffId) {
    throw new Error("Workflow handoff claim does not match the persisted source handoff");
  }
  const expected = workflowContinuationForHandoff(persisted.handoff);
  if (
    continuation.artifactRefs.length !== expected.artifactRefs.length ||
    continuation.artifactRefs.some((ref, index) => !sameArtifactRef(ref, expected.artifactRefs[index]!))
  ) {
    throw new Error("Workflow handoff continuation artifacts do not match the persisted handoff");
  }
}

export function assertWorkflowHandoffClaimEligibility(
  claim: WorkflowHandoffClaimLease,
  current: {
    target: WorkflowOperatorTargetIdentity;
    scriptIdentity: WorkflowScriptIdentity | WorkflowOperatorScriptIdentity;
  },
): void {
  assertClaimLease(claim);
  const persisted = readPersistedWorkflowOperatorHandoff(claim.projectRoot, claim.sourceRunId);
  if (persisted.status !== "ready") {
    throw new Error(
      persisted.status === "invalid" ? persisted.message : "Workflow handoff claim has no persisted source handoff",
    );
  }
  if (persisted.handoff.handoffId !== claim.handoffId) {
    throw new Error("Workflow handoff claim does not match the persisted source handoff");
  }
  assertWorkflowHandoffContinuationEligibility(persisted.handoff, current, claim.projectRoot);
}

export function claimWorkflowOperatorHandoff(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
  options: WorkflowHandoffClaimOptions = {},
): WorkflowHandoffClaimAttempt {
  let normalized: WorkflowOperatorHandoffEnvelope;
  let paths: WorkflowHandoffClaimPaths;
  try {
    normalized = requirePersistedHandoff(projectRoot, handoff);
    paths = claimPaths(projectRoot, normalized.originRunId);
  } catch (error) {
    return { status: "invalid", message: handoffFileErrorMessage(error, "Workflow handoff claim sidecar") };
  }
  const now = options.now?.() ?? new Date();
  const lock = acquireClaimLock(paths, now, options.lockStaleMs);
  if (lock === undefined) return { status: "active", message: "Workflow handoff claim transition is active." };
  try {
    const existing = readClaimState(paths.runDir, paths.claimPath);
    if (existing.status === "invalid") return existing;
    if (existing.status === "ready") {
      if (!claimMatchesHandoff(existing.state, normalized)) {
        return { status: "invalid", message: "Workflow handoff claim does not match the persisted handoff." };
      }
      const staleMs = boundedDuration(options.prestartStaleMs, DEFAULT_WORKFLOW_HANDOFF_PRESTART_STALE_MS);
      const childIsRetryable =
        existing.state.childRunId !== undefined &&
        ["failed", "cancelled"].includes(readWorkflowRunSummary(projectRoot, existing.state.childRunId).status);
      if (
        childIsRetryable ||
        (existing.state.childRunId === undefined && now.getTime() - Date.parse(existing.state.claimedAt) >= staleMs)
      ) {
        unlinkClaimState(paths.runDir, paths.claimPath, lock);
      } else {
        return { status: "active", state: existing.state, message: "Workflow handoff already has an active claim." };
      }
    }
    const state: WorkflowHandoffClaimState = {
      version: WORKFLOW_HANDOFF_CLAIM_VERSION,
      handoffId: normalized.handoffId,
      sourceRunId: normalized.originRunId,
      claimId: randomUUID(),
      claimedAt: now.toISOString(),
    };
    writeClaimStateAtomic(paths, state, lock);
    return {
      status: "claimed",
      claim: {
        projectRoot: path.resolve(projectRoot),
        handoffId: state.handoffId,
        sourceRunId: state.sourceRunId,
        claimId: state.claimId,
      },
    };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  } finally {
    releaseClaimLock(lock);
  }
}

export function readWorkflowHandoffClaim(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
): WorkflowHandoffClaimRead {
  try {
    const normalized = requirePersistedHandoff(projectRoot, handoff);
    const paths = claimPaths(projectRoot, normalized.originRunId);
    const read = readClaimState(paths.runDir, paths.claimPath);
    if (read.status === "ready" && !claimMatchesHandoff(read.state, normalized)) {
      return { status: "invalid", message: "Workflow handoff claim does not match the persisted handoff." };
    }
    return read;
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function bindWorkflowHandoffClaim(
  claim: WorkflowHandoffClaimLease,
  childRunId: string,
): WorkflowHandoffClaimState {
  assertClaimLease(claim);
  assertSafeComponent(childRunId, "workflow handoff childRunId");
  const paths = claimPaths(claim.projectRoot, claim.sourceRunId);
  const lock = acquireClaimLock(paths, new Date());
  if (lock === undefined) throw new Error("Workflow handoff claim transition is active.");
  try {
    const read = readClaimState(paths.runDir, paths.claimPath);
    if (read.status !== "ready") {
      throw new Error(read.status === "invalid" ? read.message : "Workflow handoff claim is missing.");
    }
    assertClaimOwnedByLease(read.state, claim);
    if (read.state.childRunId !== undefined && read.state.childRunId !== childRunId) {
      throw new Error("Workflow handoff claim is already bound to another child run.");
    }
    if (read.state.childRunId === childRunId) return read.state;
    const state = { ...read.state, childRunId };
    writeClaimStateAtomic(paths, state, lock);
    return state;
  } finally {
    releaseClaimLock(lock);
  }
}

export function releaseWorkflowHandoffClaim(claim: WorkflowHandoffClaimLease): boolean {
  assertClaimLease(claim);
  const paths = claimPaths(claim.projectRoot, claim.sourceRunId);
  const lock = acquireClaimLock(paths, new Date());
  if (lock === undefined) throw new Error("Workflow handoff claim transition is active.");
  try {
    const read = readClaimState(paths.runDir, paths.claimPath);
    if (read.status === "absent") return false;
    if (read.status === "invalid") throw new Error(read.message);
    assertClaimOwnedByLease(read.state, claim);
    unlinkClaimState(paths.runDir, paths.claimPath, lock);
    return true;
  } finally {
    releaseClaimLock(lock);
  }
}

export function projectWorkflowHandoffState(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
  options: Pick<WorkflowHandoffClaimOptions, "now" | "prestartStaleMs"> = {},
): WorkflowHandoffProjectedState {
  const read = readWorkflowHandoffClaim(projectRoot, handoff);
  if (read.status === "absent") return { status: "pending" };
  if (read.status === "invalid") throw new Error(read.message);
  const childRunId = read.state.childRunId;
  if (childRunId === undefined) {
    const now = options.now?.() ?? new Date();
    const staleMs = boundedDuration(options.prestartStaleMs, DEFAULT_WORKFLOW_HANDOFF_PRESTART_STALE_MS);
    return now.getTime() - Date.parse(read.state.claimedAt) >= staleMs
      ? { status: "retryable", message: "Workflow handoff claim expired before a continuation run started." }
      : { status: "running" };
  }
  const child = readWorkflowRunSummary(projectRoot, childRunId);
  if (child.status === "completed" || child.status === "awaiting_operator") {
    return { status: "resolved", childRunId };
  }
  if (child.status === "failed" || child.status === "cancelled") {
    return { status: "retryable", childRunId, message: `Continuation run ${childRunId} ${child.status}.` };
  }
  return { status: "running", childRunId };
}

function assertQuestionDetailArtifactRefs(
  questions: readonly WorkflowOperatorQuestion[],
  continuationArtifactRefs: readonly WorkflowArtifactRef[],
  originRunId: string,
): void {
  for (const question of questions) {
    const ref = question.detailArtifactRef;
    if (ref === undefined) continue;
    if (ref.runId !== originRunId) {
      throw new Error(`operatorHandoff question ${question.id} detail artifact must belong to originRunId`);
    }
    if (!continuationArtifactRefs.some((candidate) => sameArtifactRef(candidate, ref))) {
      throw new Error(`operatorHandoff question ${question.id} detail artifact must be a continuation artifact`);
    }
  }
}

function normalizeTarget(
  value: unknown,
  allowRunnerPath = false,
  projectRoot?: string,
): WorkflowOperatorTargetIdentity {
  const record = requireExactRecord(
    value,
    ["kind", "ref", "source"],
    "workflow target",
    allowRunnerPath ? ["path"] : [],
  );
  // The exact-record check above owns runner-only `path` presence. Generic
  // readers without project context retain raw refs; persisted readers pass
  // the selected project root so physical identity is proven before use.
  const parsed = parseWorkflowTargetIdentity(record);
  if (projectRoot !== undefined && parsed.kind === "scriptPath" && parsed.source === "project") {
    const candidate = path.resolve(projectRoot, parsed.ref);
    const root = path.resolve(projectRoot);
    try {
      const physicalRoot = realpathSync(root);
      // `realpathSync()` may expose macOS `/private` aliases. A persisted
      // physical ref must therefore be checked against both lexical spellings
      // before its own realpath is resolved; this keeps repeated normalization
      // stable without allowing an external absolute path.
      if (!isWorkflowPathWithinRoot(root, candidate) && !isWorkflowPathWithinRoot(physicalRoot, candidate)) {
        throw new Error("Workflow target path escapes the project root.");
      }
      const physicalPath = realpathSync(candidate);
      if (!isWorkflowPathWithinRoot(physicalRoot, physicalPath)) {
        throw new Error("Workflow target path escapes the project root through a symlink.");
      }
      return { ...parsed, ref: physicalPath };
    } catch (error) {
      if (error instanceof Error && error.message.includes("escapes the project root")) throw error;
      // Removed historical paths remain represented by their raw ref and are
      // rejected by the source resolver before continuation launch.
    }
  }
  if (allowRunnerPath && parsed.kind === "scriptPath" && typeof record.path === "string") {
    if (!path.isAbsolute(record.path)) throw new Error("Workflow target path must be absolute.");
    if (path.basename(record.path) !== path.basename(parsed.ref)) {
      throw new Error("Workflow target path basename does not match scriptPath ref.");
    }
  }
  return parsed;
}

function normalizeScriptIdentity(value: unknown, allowRunnerFields = false): WorkflowOperatorScriptIdentity {
  const record = requireRecord(value, "workflow script identity");
  requireAllowedKeys(
    record,
    [
      "executionSource",
      "identityCoverage",
      "identityPolicy",
      "schemaVersion",
      "scriptSha256",
      ...(allowRunnerFields
        ? ["arch", "builtinImports", "nodeVersion", "platform", "snapshotPath", "sourcePath", "unboundDependencies"]
        : []),
    ],
    "workflow script identity",
  );
  if (record.schemaVersion !== 2 || record.identityPolicy !== "static-node-only-v1") {
    throw new Error("Workflow script identity is not a supported v2 identity");
  }
  if (typeof record.scriptSha256 !== "string" || !SHA256.test(record.scriptSha256)) {
    throw new Error("Workflow script identity sha256 is invalid");
  }
  if (record.identityCoverage !== "self-contained-static" && record.identityCoverage !== "entry-only") {
    throw new Error("Workflow script identity coverage is invalid");
  }
  if (record.executionSource !== "snapshot" && record.executionSource !== "source") {
    throw new Error("Workflow script execution source is invalid");
  }
  if (
    (record.identityCoverage === "self-contained-static" && record.executionSource !== "snapshot") ||
    (record.identityCoverage === "entry-only" && record.executionSource !== "source")
  ) {
    throw new Error("Workflow script identity coverage and execution source are inconsistent");
  }
  return {
    schemaVersion: 2,
    identityPolicy: "static-node-only-v1",
    scriptSha256: record.scriptSha256,
    identityCoverage: record.identityCoverage,
    executionSource: record.executionSource,
  };
}

function requirePersistedHandoff(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
): WorkflowOperatorHandoffEnvelope {
  const normalized = normalizeWorkflowOperatorHandoffEnvelope(handoff);
  const persisted = readPersistedWorkflowOperatorHandoff(projectRoot, normalized.originRunId);
  if (persisted.status !== "ready") {
    throw new Error(
      persisted.status === "invalid" ? persisted.message : "Workflow run has no actionable operator handoff.",
    );
  }
  if (!sameHandoffEnvelope(persisted.handoff, normalized, projectRoot)) {
    throw new Error("Workflow handoff does not match immutable source result evidence.");
  }
  return normalized;
}

/**
 * Compare the immutable handoff envelope while treating target refs as an
 * identity projection. Persisted reads may replace a project scriptPath ref
 * with its confined physical path; direct callers intentionally retain the
 * raw ref for display and must still be able to claim that handoff.
 */
function sameHandoffEnvelope(
  persisted: WorkflowOperatorHandoffEnvelope,
  candidate: WorkflowOperatorHandoffEnvelope,
  projectRoot: string,
): boolean {
  if (
    !sameTarget(
      normalizeTarget(persisted.target, false, projectRoot),
      normalizeTarget(candidate.target, false, projectRoot),
    )
  ) {
    return false;
  }
  const { target: _persistedTarget, ...persistedWithoutTarget } = persisted;
  const { target: _candidateTarget, ...candidateWithoutTarget } = candidate;
  return JSON.stringify(persistedWithoutTarget) === JSON.stringify(candidateWithoutTarget);
}

interface WorkflowHandoffClaimPaths {
  runDir: string;
  claimPath: string;
  lockPath: string;
}

function claimPaths(projectRoot: string, runId: string): WorkflowHandoffClaimPaths {
  const runDir = resolveWorkflowRunDir(projectRoot, runId);
  return {
    runDir,
    claimPath: workflowRunRuntimeFile(runDir, HANDOFF_CLAIM_FILE),
    lockPath: workflowRunRuntimeFile(runDir, HANDOFF_CLAIM_LOCK_FILE),
  };
}

function readClaimState(runDir: string, claimPath: string): WorkflowHandoffClaimRead {
  try {
    if (!workflowRunFileExists(runDir, claimPath)) return { status: "absent" };
    const parsed: unknown = JSON.parse(readWorkflowRunTextFile(runDir, claimPath));
    return { status: "ready", state: normalizeClaimState(parsed) };
  } catch (error) {
    return { status: "invalid", message: handoffFileErrorMessage(error, "Workflow handoff claim sidecar") };
  }
}

function normalizeClaimState(value: unknown): WorkflowHandoffClaimState {
  const record = requireRecord(value, "workflow handoff claim");
  const allowed =
    record.childRunId === undefined
      ? ["claimId", "claimedAt", "handoffId", "sourceRunId", "version"]
      : ["childRunId", "claimId", "claimedAt", "handoffId", "sourceRunId", "version"];
  requireAllowedKeys(record, allowed, "workflow handoff claim");
  if (record.version !== WORKFLOW_HANDOFF_CLAIM_VERSION) throw new Error("Workflow handoff claim version is invalid.");
  assertSafeComponent(record.handoffId, "workflow handoff claim handoffId");
  assertSafeComponent(record.sourceRunId, "workflow handoff claim sourceRunId");
  assertSafeComponent(record.claimId, "workflow handoff claim claimId");
  if (typeof record.claimedAt !== "string" || !Number.isFinite(Date.parse(record.claimedAt))) {
    throw new Error("Workflow handoff claim claimedAt is invalid.");
  }
  if (record.childRunId !== undefined) assertSafeComponent(record.childRunId, "workflow handoff claim childRunId");
  return {
    version: WORKFLOW_HANDOFF_CLAIM_VERSION,
    handoffId: record.handoffId,
    sourceRunId: record.sourceRunId,
    claimId: record.claimId,
    claimedAt: record.claimedAt,
    ...(record.childRunId !== undefined ? { childRunId: record.childRunId } : {}),
  };
}

function writeClaimStateAtomic(
  paths: WorkflowHandoffClaimPaths,
  state: WorkflowHandoffClaimState,
  lock: ClaimLock,
): void {
  const normalized = normalizeClaimState(state);
  const tempPath = workflowRunRuntimeFile(
    paths.runDir,
    `${HANDOFF_CLAIM_FILE}.${normalized.claimId}.${randomUUID()}.tmp`,
  );
  try {
    writeWorkflowRunFile(paths.runDir, tempPath, `${JSON.stringify(normalized)}\n`, {
      durable: true,
      exclusive: true,
    });
    assertClaimLockOwned(lock);
    renameWorkflowRunFile(paths.runDir, tempPath, paths.claimPath);
  } finally {
    try {
      if (workflowRunFileExists(paths.runDir, tempPath)) removeWorkflowRunFile(paths.runDir, tempPath);
    } catch {
      // The canonical state either won the rename or the caller receives the
      // original write error. Temp cleanup must not hide it.
    }
  }
}

interface ClaimLock {
  runDir: string;
  path: string;
  ownerToken: string;
}

interface ClaimLockState {
  version: typeof WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION;
  ownerToken: string;
  acquiredAt: string;
}

function acquireClaimLock(
  paths: WorkflowHandoffClaimPaths,
  now: Date,
  configuredStaleMs?: number,
): ClaimLock | undefined {
  const staleMs = boundedDuration(configuredStaleMs, DEFAULT_WORKFLOW_HANDOFF_LOCK_STALE_MS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state: ClaimLockState = {
      version: WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION,
      ownerToken: randomUUID(),
      acquiredAt: now.toISOString(),
    };
    try {
      writeWorkflowRunFile(paths.runDir, paths.lockPath, `${JSON.stringify(state)}\n`, {
        durable: true,
        exclusive: true,
      });
      return { runDir: paths.runDir, path: paths.lockPath, ownerToken: state.ownerToken };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const lockMtime = workflowRunFileMtimeMs(paths.runDir, paths.lockPath);
      if (lockMtime === undefined) continue;
      if (now.getTime() - lockMtime < staleMs) return undefined;
      removeWorkflowRunFile(paths.runDir, paths.lockPath);
    }
  }
  return undefined;
}

function releaseClaimLock(lock: ClaimLock): void {
  try {
    const state = readClaimLockState(lock.runDir, lock.path);
    if (state === undefined || state.ownerToken !== lock.ownerToken) return;
    removeWorkflowRunFile(lock.runDir, lock.path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) {
      // A malformed or replaced lock is not ours to remove. Claim mutation has
      // already verified ownership independently and reports its own failure.
    }
  }
}

function unlinkClaimState(runDir: string, claimPath: string, lock: ClaimLock): void {
  assertClaimLockOwned(lock);
  removeWorkflowRunFile(runDir, claimPath);
}

function assertClaimLockOwned(lock: ClaimLock): void {
  const state = readClaimLockState(lock.runDir, lock.path);
  if (state === undefined || state.ownerToken !== lock.ownerToken) {
    throw new Error("Workflow handoff claim lock ownership was lost before mutation.");
  }
}

function readClaimLockState(runDir: string, lockPath: string): ClaimLockState | undefined {
  if (!workflowRunFileExists(runDir, lockPath)) return undefined;
  const value: unknown = JSON.parse(readWorkflowRunTextFile(runDir, lockPath));
  const record = requireExactRecord(value, ["acquiredAt", "ownerToken", "version"], "workflow handoff claim lock");
  if (record.version !== WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION) {
    throw new Error("Workflow handoff claim lock version is invalid.");
  }
  assertSafeComponent(record.ownerToken, "workflow handoff claim lock ownerToken");
  if (typeof record.acquiredAt !== "string" || !Number.isFinite(Date.parse(record.acquiredAt))) {
    throw new Error("Workflow handoff claim lock acquiredAt is invalid.");
  }
  return {
    version: WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION,
    ownerToken: record.ownerToken,
    acquiredAt: record.acquiredAt,
  };
}

function stableWorkflowHandoffId(runId: string): string {
  return `handoff-${createHash("sha256")
    .update(`${WORKFLOW_OPERATOR_HANDOFF_VERSION}\0${runId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function assertClaimLease(value: WorkflowHandoffClaimLease): void {
  if (!isRecord(value)) throw new Error("Workflow handoff claim lease must be an object.");
  if (typeof value.projectRoot !== "string" || value.projectRoot.trim() === "") {
    throw new Error("Workflow handoff claim lease projectRoot is invalid.");
  }
  assertSafeComponent(value.handoffId, "workflow handoff claim lease handoffId");
  assertSafeComponent(value.sourceRunId, "workflow handoff claim lease sourceRunId");
  assertSafeComponent(value.claimId, "workflow handoff claim lease claimId");
}

function assertClaimOwnedByLease(state: WorkflowHandoffClaimState, claim: WorkflowHandoffClaimLease): void {
  if (
    state.claimId !== claim.claimId ||
    state.handoffId !== claim.handoffId ||
    state.sourceRunId !== claim.sourceRunId
  ) {
    throw new Error("Workflow handoff claim lease no longer owns the active claim.");
  }
}

function claimMatchesHandoff(state: WorkflowHandoffClaimState, handoff: WorkflowOperatorHandoffEnvelope): boolean {
  return state.handoffId === handoff.handoffId && state.sourceRunId === handoff.originRunId;
}

function sameTarget(left: WorkflowOperatorTargetIdentity, right: WorkflowOperatorTargetIdentity): boolean {
  return workflowTargetIdentityKey(left) === workflowTargetIdentityKey(right);
}

function sameScriptIdentity(left: WorkflowOperatorScriptIdentity, right: WorkflowOperatorScriptIdentity): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.identityPolicy === right.identityPolicy &&
    left.scriptSha256 === right.scriptSha256 &&
    left.identityCoverage === right.identityCoverage &&
    left.executionSource === right.executionSource
  );
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

function handoffFileErrorMessage(error: unknown, label: string): string {
  const message = errorMessage(error);
  return message.startsWith("Workflow run path is unsafe:") ? `${label} is not a regular non-symlink file.` : message;
}
