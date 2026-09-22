/**
 * workflow-run-resume.ts — Resume authority: what a stopped run proves about itself.
 *
 * One owner answers every "may this run continue that one?" question asked by the
 * runner, the workflow tool and the operator handoff. It READS persisted state —
 * the result envelope readback, the host launch binding, the retained snapshot,
 * the replay log — and returns a verdict or throws a named refusal.
 *
 * Deliberately incapable of two things, so a refusal can never repair itself into
 * an admission: it never creates a workspace (every workspace it resolves is
 * resolved with `create: false`), and it never executes a workflow. Admission
 * ORDERING lives in `workflow-run-admission.ts`, which imports this module; this
 * module must not import that one, and neither imports the runner.
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import type { WorkflowContinuation } from "./workflow-artifacts.js";
import type { ResolvedWorkflowTarget } from "./workflow-discovery.js";
import type { WorkflowHandoffClaimLease } from "./workflow-handoff.js";
import { readWorkflowRunResult, workflowPersistedResultInvalidity } from "./workflow-journal.js";
import type { WorkflowRunResultEnvelope } from "./workflow-journal.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingExists,
  workflowLaunchBindingMatchesResult,
  type WorkflowLaunchBinding,
} from "./workflow-launch-binding.js";
import {
  isWorkflowPathWithinRoot,
  resolveWorkflowOutputDirectoryForReuse,
  type WorkflowOutputDirectory,
  type WorkflowWorkspaceReuseBinding,
} from "./workflow-output.js";
import {
  readWorkflowReplayLog,
  type WorkflowReplayController,
  type WorkflowReplayEntry,
  type WorkflowReplayEnvelope,
  type WorkflowReplayNotRecordedReason,
  type WorkflowReplayRefusalReason,
} from "./workflow-replay.js";
import { readWorkflowRunTextFile } from "./workflow-run-layout.js";
import {
  isPostCodeReviewTargetProjection,
  workflowTargetIdentityKey,
  type WorkflowTargetIdentity,
} from "./workflow-saved-name.js";
import {
  assessWorkflowReplaySafety,
  sha256WorkflowBytes,
  type WorkflowReplaySafety,
  type WorkflowScriptIdentity,
} from "./workflow-script-identity.js";

// ---------------------------------------------------------------------------
// Target identity keys
// ---------------------------------------------------------------------------

/** T-154 owner policy: only this workflow has a fresh-namespace requirement. */
export function isPostCodeReviewTarget(target: ResolvedWorkflowTarget, projectRoot?: string): boolean {
  return isPostCodeReviewTargetProjection(
    { kind: target.kind, ref: target.ref, source: target.source },
    { projectRoot, resolvedPath: target.path },
  );
}

export function targetIdentityKey(target: ResolvedWorkflowTarget, projectRoot: string): string {
  return workflowTargetIdentityKey(
    { kind: target.kind, ref: target.ref, source: target.source },
    { projectRoot, resolvedPath: target.path },
  );
}

export function persistedTargetIdentityKey(
  target: WorkflowTargetIdentity,
  projectRoot: string,
  sourcePath?: string,
): string {
  return workflowTargetIdentityKey(target, { projectRoot, resolvedPath: sourcePath });
}

// ---------------------------------------------------------------------------
// Resume identity
// ---------------------------------------------------------------------------

export interface WorkflowResumeWorkspaceIdentity {
  relativePath: string;
  absolutePath: string;
  physicalPath: string;
  physicalIdentity: string;
  explicit: boolean;
}

export interface WorkflowResumeSourceBinding {
  result: WorkflowRunResultEnvelope;
  owner: boolean;
  workspace: WorkflowResumeWorkspaceIdentity;
  launchBinding?: WorkflowLaunchBinding;
}

export interface WorkflowHandoffWorkspaceReuseBinding extends WorkflowWorkspaceReuseBinding {
  sourceRunId: string;
}

export interface WorkflowSemanticInputIdentity {
  present: boolean;
  sha256: string;
}

export function workflowSemanticInputIdentity(input: string | undefined): WorkflowSemanticInputIdentity {
  const text = typeof input === "string" ? input : "";
  return { present: input !== undefined, sha256: sha256WorkflowBytes(Buffer.from(text, "utf8")) };
}

export function readWorkflowResumeSemanticInputIdentity(
  sourceResult: WorkflowRunResultEnvelope | null,
  runId: string,
): WorkflowSemanticInputIdentity {
  if (sourceResult?.runIdInvalid !== undefined || sourceResult?.runUnbound !== undefined) {
    throw new Error(`Cannot resume workflow: source run ${runId} is not bound to its persisted result envelope.`);
  }
  if (sourceResult?.scriptIdentityInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source run ${runId} has malformed script identity: ${sourceResult.scriptIdentityInvalid}.`,
    );
  }
  if (sourceResult?.semanticInputInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source run ${runId} has malformed semantic input identity: ${sourceResult.semanticInputInvalid}.`,
    );
  }
  if (
    typeof sourceResult?.semanticInputPresent !== "boolean" ||
    typeof sourceResult.semanticInputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceResult.semanticInputSha256)
  ) {
    throw new Error(`Cannot resume workflow: source run ${runId} has no persisted semantic input identity.`);
  }
  return { present: sourceResult.semanticInputPresent, sha256: sourceResult.semanticInputSha256 };
}

/** Require the source run to carry the workspace identity that resume must reuse. */
export function readWorkflowResumeWorkspaceIdentity(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowResumeWorkspaceIdentity {
  const sourceResult = readWorkflowRunResult(projectRoot, runId, resolvedRunDir);
  const invalidity = workflowPersistedResultInvalidity(sourceResult);
  if (invalidity !== undefined) {
    throw new Error(`Cannot resume workflow: source run ${runId} has malformed persisted metadata (${invalidity}).`);
  }
  const bindingPresent = workflowLaunchBindingExists(projectRoot, runId, resolvedRunDir);
  const binding = readWorkflowLaunchBinding(projectRoot, runId, resolvedRunDir);
  if (bindingPresent) {
    if (binding === null || sourceResult === null || !workflowLaunchBindingMatchesResult(binding, sourceResult)) {
      throw new Error(`Cannot resume post-code-review workflow: source run ${runId} has no valid host launch binding.`);
    }
    return {
      relativePath: binding.workspace.relativePath,
      absolutePath: binding.workspace.absolutePath,
      physicalPath: binding.workspace.physicalPath,
      physicalIdentity: binding.workspace.physicalIdentity,
      explicit: binding.workspace.explicit,
    };
  }
  if (
    sourceResult !== null &&
    sourceResult.target !== undefined &&
    isPostCodeReviewTargetProjection(sourceResult.target, {
      projectRoot,
      resolvedPath: sourceResult.scriptIdentity?.sourcePath,
    })
  ) {
    throw new Error(`Cannot resume post-code-review workflow: source run ${runId} has no valid host launch binding.`);
  }
  return readWorkflowResumeWorkspaceIdentityFromResult(projectRoot, sourceResult, runId);
}

export function readWorkflowResumeWorkspaceIdentityFromResult(
  projectRoot: string,
  sourceResult: WorkflowRunResultEnvelope | null,
  runId: string,
): WorkflowResumeWorkspaceIdentity {
  if (sourceResult?.runIdInvalid !== undefined || sourceResult?.runUnbound !== undefined) {
    throw new Error(`Cannot resume workflow: source run ${runId} is not bound to its persisted result envelope.`);
  }
  const relativePath = sourceResult?.workspaceDirRelative;
  const absolutePath = sourceResult?.workspaceDir;
  const physicalIdentity = sourceResult?.workspacePhysicalIdentity;
  const physicalIdentitySchemaVersion = sourceResult?.workspacePhysicalIdentitySchemaVersion;
  if (sourceResult?.workspaceDirExplicitInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source run ${runId} has malformed workspaceDirExplicit: ${sourceResult.workspaceDirExplicitInvalid}.`,
    );
  }
  const requiresPhysicalIdentity =
    sourceResult?.target !== undefined &&
    isPostCodeReviewTargetProjection(sourceResult.target, {
      projectRoot,
      resolvedPath: sourceResult.scriptIdentity?.sourcePath,
    });
  if (requiresPhysicalIdentity && sourceResult?.workspacePhysicalIdentityInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source workspace physical identity is malformed: ${sourceResult.workspacePhysicalIdentityInvalid}`,
    );
  }
  if (requiresPhysicalIdentity && physicalIdentitySchemaVersion !== 1) {
    throw new Error(
      `Cannot resume workflow: source workspace physical identity schema is missing or unsupported ` +
        `(recorded ${JSON.stringify(physicalIdentitySchemaVersion)}).`,
    );
  }
  if (typeof relativePath !== "string" || relativePath.trim() === "" || typeof absolutePath !== "string") {
    throw new Error(`Cannot resume workflow: source run ${runId} has no persisted workspace identity.`);
  }

  const lexicalRoot = path.resolve(projectRoot);
  const lexicalWorkspace = path.resolve(absolutePath);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalWorkspace)) {
    throw new Error(`Cannot resume workflow: source workspace escapes the project root: ${absolutePath}`);
  }

  let physicalRoot: string;
  let physicalWorkspace: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
    physicalWorkspace = realpathSync(lexicalWorkspace);
  } catch (error) {
    throw new Error(`Cannot resume workflow: source workspace identity is unavailable: ${String(error)}`);
  }
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalWorkspace)) {
    throw new Error(`Cannot resume workflow: source workspace escapes the project root: ${absolutePath}`);
  }

  const physicalRelativePath = path.relative(physicalRoot, physicalWorkspace).split(path.sep).join("/");
  if (physicalRelativePath === "" || physicalRelativePath !== relativePath) {
    throw new Error(
      `Cannot resume workflow: source workspace identity is inconsistent ` +
        `(recorded ${JSON.stringify(relativePath)}, physical ${JSON.stringify(physicalRelativePath)}).`,
    );
  }
  if (requiresPhysicalIdentity && (typeof physicalIdentity !== "string" || physicalIdentity !== physicalRelativePath)) {
    throw new Error(
      `Cannot resume workflow: source workspace physical identity is missing or changed ` +
        `(recorded ${JSON.stringify(physicalIdentity)}, current ${JSON.stringify(physicalRelativePath)}).`,
    );
  }
  return {
    relativePath,
    absolutePath: lexicalWorkspace,
    physicalPath: physicalWorkspace,
    physicalIdentity: physicalIdentity ?? physicalRelativePath,
    explicit: sourceResult?.workspaceDirExplicit === true,
  };
}

export function assertWorkflowHandoffWorkspaceReuse(
  projectRoot: string,
  binding: WorkflowHandoffWorkspaceReuseBinding,
  claim: WorkflowHandoffClaimLease,
  continuation: WorkflowContinuation,
  target: ResolvedWorkflowTarget,
): WorkflowOutputDirectory {
  if (binding.sourceRunId !== claim.sourceRunId || continuation.originRunId !== binding.sourceRunId) {
    throw new Error("Workflow handoff workspace reuse does not match the source run");
  }
  const source = readWorkflowRunResult(projectRoot, binding.sourceRunId);
  const sourceLaunchBindingPresent = workflowLaunchBindingExists(projectRoot, binding.sourceRunId);
  const sourceLaunchBinding = readWorkflowLaunchBinding(projectRoot, binding.sourceRunId);
  if (
    source === null ||
    source.runIdInvalid !== undefined ||
    source.runUnbound !== undefined ||
    source.targetInvalid !== undefined ||
    source.scriptIdentityInvalid !== undefined ||
    source.target === undefined
  ) {
    throw new Error("Workflow handoff source has no valid persisted target");
  }
  if (
    sourceLaunchBindingPresent &&
    (sourceLaunchBinding === null || !workflowLaunchBindingMatchesResult(sourceLaunchBinding, source))
  ) {
    throw new Error("Workflow handoff source has no valid host launch binding");
  }
  const sourceTarget = sourceLaunchBinding?.target ?? source.target;
  const sourceScriptPath = sourceLaunchBinding?.scriptIdentity.sourcePath ?? source.scriptIdentity?.sourcePath;
  if (
    persistedTargetIdentityKey(sourceTarget, projectRoot, sourceScriptPath) !== targetIdentityKey(target, projectRoot)
  ) {
    throw new Error("Workflow handoff source target does not match the continuation target");
  }
  const sourceWorkspace = readWorkflowResumeWorkspaceIdentity(projectRoot, binding.sourceRunId);
  if (
    sourceWorkspace.relativePath !== binding.relativePath ||
    sourceWorkspace.absolutePath !== binding.absolutePath ||
    sourceWorkspace.physicalPath !== binding.physicalPath ||
    sourceWorkspace.physicalIdentity !== binding.physicalIdentity ||
    sourceWorkspace.explicit !== binding.explicit
  ) {
    throw new Error("Workflow handoff source workspace identity changed");
  }
  return resolveWorkflowOutputDirectoryForReuse(projectRoot, binding, { create: false });
}

// ---------------------------------------------------------------------------
// Replay gating (T-109)
// ---------------------------------------------------------------------------

export interface WorkflowReplayPlan {
  /** Whether this run writes a record a later `--resume` can consume. */
  record: boolean;
  /** Recorded entries to replay from. Present only when replay is active. */
  recorded?: readonly WorkflowReplayEntry[];
  sourceRunId?: string;
  refusedReason?: WorkflowReplayRefusalReason;
  notRecordedReason?: WorkflowReplayNotRecordedReason;
  /**
   * The source run's script bytes differ from the ones executing now. Repairing
   * the stopped workflow in place is the expected reason, so this is reported to
   * the controller instead of ending the resume.
   */
  sourceScriptChanged?: boolean;
}

export interface PlanWorkflowReplayInput {
  projectRoot: string;
  scriptIdentity: WorkflowScriptIdentity;
  target: ResolvedWorkflowTarget;
  resumeFromRunId?: string;
  resumeSourceResult?: WorkflowRunResultEnvelope;
}

/**
 * Decide, once per run, whether recorded calls may be replayed and whether this
 * run may be recorded. Every path out of here is fail-closed: an unproven
 * script, an unreadable source run, or a moved script yields a NAMED refusal and
 * a completely fresh execution, never a partially trusted one.
 */
export function planWorkflowReplay(input: PlanWorkflowReplayInput): WorkflowReplayPlan {
  const { projectRoot, scriptIdentity, target, resumeFromRunId } = input;
  // `entry-only` binds only the entry file's bytes, so an imported module can
  // move the call sequence without changing `scriptSha256`. Unproven by
  // construction — the AST never saw those bytes.
  const coverageProven = scriptIdentity.identityCoverage === "self-contained-static";
  const replaySafety = coverageProven ? readWorkflowReplaySafety(scriptIdentity) : "unproven";
  const notRecordedReason: WorkflowReplayNotRecordedReason | undefined = !coverageProven
    ? "identity-coverage-unproven"
    : replaySafety === "unproven"
      ? "replay-unsafe-script"
      : undefined;
  const record = notRecordedReason === undefined;

  if (resumeFromRunId === undefined)
    return { record, ...(notRecordedReason !== undefined ? { notRecordedReason } : {}) };

  const refuse = (refusedReason: WorkflowReplayRefusalReason): WorkflowReplayPlan => ({
    record,
    sourceRunId: resumeFromRunId,
    refusedReason,
    ...(notRecordedReason !== undefined ? { notRecordedReason } : {}),
  });

  const sourceResult = input.resumeSourceResult ?? readWorkflowRunResult(projectRoot, resumeFromRunId);
  const sourceSha256 = sourceResult?.scriptIdentity?.scriptSha256;
  if (
    sourceResult === null ||
    sourceResult.runIdInvalid !== undefined ||
    sourceResult.runUnbound !== undefined ||
    sourceResult.targetInvalid !== undefined ||
    sourceResult.scriptIdentityInvalid !== undefined ||
    sourceResult.target === undefined
  ) {
    return refuse("source-run-unusable");
  }
  if (
    persistedTargetIdentityKey(sourceResult.target, projectRoot, sourceResult.scriptIdentity?.sourcePath) !==
    targetIdentityKey(target, projectRoot)
  ) {
    return refuse("target-changed");
  }
  if (sourceSha256 === undefined) return refuse("source-run-unusable");
  if (!coverageProven) return refuse("identity-coverage-unproven");
  if (replaySafety === "unproven") return refuse("replay-unsafe-script");

  // Edited bytes are the operator's repair, not a reason to erase the progress
  // that repair is meant to continue. The controller is told, and it makes the
  // recorded node name mandatory for the rest of the run.
  const sourceScriptChanged = sourceSha256 !== scriptIdentity.scriptSha256;
  const recorded = readWorkflowReplayLog(projectRoot, resumeFromRunId);
  if (recorded.length === 0) return refuse("no-recorded-calls");
  return { record, recorded, sourceRunId: resumeFromRunId, ...(sourceScriptChanged ? { sourceScriptChanged } : {}) };
}

/** Static replay-safety of the exact bytes this run executes; unreadable reads as unproven. */
export function readWorkflowReplaySafety(scriptIdentity: WorkflowScriptIdentity): WorkflowReplaySafety {
  try {
    return assessWorkflowReplaySafety(
      readWorkflowRunTextFile(path.dirname(scriptIdentity.snapshotPath), scriptIdentity.snapshotPath),
    ).replaySafety;
  } catch {
    return "unproven";
  }
}

export function workflowReplayEnvelope(
  plan: WorkflowReplayPlan,
  controller: WorkflowReplayController | undefined,
): WorkflowReplayEnvelope {
  const counts = controller?.counts() ?? { replayedCalls: 0, freshCalls: 0 };
  return {
    replayed: counts.replayedCalls > 0,
    recorded: plan.record,
    ...(plan.sourceRunId !== undefined ? { sourceRunId: plan.sourceRunId } : {}),
    ...(plan.refusedReason !== undefined ? { refusedReason: plan.refusedReason } : {}),
    ...(plan.notRecordedReason !== undefined ? { notRecordedReason: plan.notRecordedReason } : {}),
    replayedCalls: counts.replayedCalls,
    freshCalls: counts.freshCalls,
    ...(counts.divergedAtCall !== undefined ? { divergedAtCall: counts.divergedAtCall } : {}),
    ...(counts.divergedAtNode !== undefined ? { divergedAtNode: counts.divergedAtNode } : {}),
  };
}

/**
 * One journal line for the cases an operator must not have to infer, and
 * `undefined` for the silent default (no resume asked for, recording on).
 */
export function describeWorkflowReplayPlan(plan: WorkflowReplayPlan): string | undefined {
  if (plan.recorded !== undefined) {
    return `replay: active source=${plan.sourceRunId ?? "?"} recordedCalls=${plan.recorded.length}`;
  }
  if (plan.refusedReason !== undefined) {
    return `replay: refused source=${plan.sourceRunId ?? "?"} reason=${plan.refusedReason} — every call runs fresh`;
  }
  if (plan.notRecordedReason !== undefined) {
    return `replay: not recorded reason=${plan.notRecordedReason} — this run cannot be resumed`;
  }
  return undefined;
}
