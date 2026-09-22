/**
 * workflow-runner.ts — Constrained script loader + executor (trusted-script loader).
 *
 * Loads a workflow script and runs it with ONLY the DSL in scope.
 * This is the trust boundary (worktree isolation, not a security boundary): the script receives `runtime.dsl` as its only argument.
 * No fs / process / require / globals injected from the runtime side.
 *
 * PoC trust-model honesty (documented limitation):
 *   Node ESM has no first-class module isolation here. A trusted script can use
 *   Node built-ins, and an explicit entry-only script can import other modules.
 *   Mitigation: (a) bare names resolve only through the documented saved-workflow
 *   directories (project and personal), then the curated Package registry;
 *   (b) lexical + physical path-escape checks; (c) docs plainly state author scripts are trusted input.
 *   Hard VM/worker isolation is a pending seam — see TODO(trust-model) marker below.
 */
import {
  readInterruptedWorkflowResumeBinding,
  workflowRecoveryInputHash,
  confirmedRecoveryAgentCount,
} from "./workflow-interrupted-recovery.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { constants as vmConstants, Script } from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory, isOneShotHostMode } from "../../_shared/host/pi-api.js";
import type {
  WorkflowAwaitOperatorDeclaration,
  WorkflowDsl,
  WorkflowJournalLine,
  WorkflowRuntime,
} from "./workflow-runtime.js";
import {
  formatWorkflowBudgetPrelude,
  formatWorkflowBudgetRaise,
  resolveWorkflowBudget,
  type WorkflowBudget,
} from "./workflow-budget.js";
import {
  assertWorkflowInput,
  createWorkflowRuntime,
  createWorkflowSharedExecutionState,
  snapshotWorkflowItems,
  WorkflowAgentExecutionError,
  workflowGroupFailureEnvelope,
  WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE,
  WORKFLOW_NO_OPERATOR_PRELUDE,
  type WorkflowAgentResult,
} from "./workflow-runtime.js";
import type { AgentExecutor } from "../../_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowAgentPreflight,
  createWorkflowAgentRunner,
  type WorkflowAgentBridgeOptions,
} from "./workflow-agent-bridge.js";
import {
  claimNewWorkflowRun,
  readWorkflowRunResult,
  readWorkflowRunSummary,
  workflowPersistedResultInvalidity,
} from "./workflow-journal.js";
import type { WorkflowRunResultEnvelope, WorkflowRunSummary } from "./workflow-journal.js";
import type { ResolvedWorkflowTarget } from "./workflow-discovery.js";
import { createWorkflowReplayController, type WorkflowReplayController } from "./workflow-replay.js";
import { admitWorkflowRun } from "./workflow-run-admission.js";
import {
  describeWorkflowReplayPlan,
  planWorkflowReplay,
  workflowReplayEnvelope,
  workflowSemanticInputIdentity,
  type WorkflowHandoffWorkspaceReuseBinding,
  type WorkflowReplayPlan,
  type WorkflowResumeSourceBinding,
  type WorkflowResumeWorkspaceIdentity,
} from "./workflow-run-resume.js";
import { prepareWorkflowResult, isWorkflowResultExplicitFailure } from "./workflow-result.js";
import {
  sha256WorkflowBytes,
  verifyWorkflowScriptSnapshot,
  workflowScriptExecutionPath,
  type WorkflowScriptIdentity,
} from "./workflow-script-identity.js";
import {
  acquireWorkflowRootLease,
  referenceWorkflowPrimaryFile,
  type WorkflowOutputDirectory,
  type WorkflowPrimaryFileReference,
  type WorkflowRootLease,
} from "./workflow-output.js";
import { readWorkflowPrimaryFile } from "./workflow-workspace.js";
import { checkWorkflowSourceText } from "../tool/workflow-source-check-tool.js";
import { createWorkflowResourceLoader, type WorkflowResourceLoader } from "./workflow-resources.js";
import { createWorkflowWorkspaceManager, type WorkflowWorkspaceManager } from "./workflow-worktree.js";
import {
  assertWorkflowContinuation,
  consumeWorkflowContinuation,
  continuationJournalProjection,
  createWorkflowArtifactStore,
  type WorkflowArtifactStore,
  type WorkflowBoundContinuation,
  type WorkflowContinuation,
  type WorkflowContinuationJournal,
} from "./workflow-artifacts.js";
import {
  assertWorkflowRunId,
  workflowLegacyRunMigrationMessage,
  workflowRunRuntimeDir,
  workflowStorageRootRunId,
  type WorkflowRunLocation,
} from "./workflow-run-layout.js";
import { writeWorkflowRunGroupReport } from "./workflow-run-report.js";
import {
  assertWorkflowHandoffClaimEligibility,
  assertWorkflowHandoffClaimForContinuation,
  bindWorkflowHandoffClaim,
  type WorkflowHandoffClaimLease,
} from "./workflow-handoff.js";

import {
  SavedChildExecutionOwner,
  type SavedChildLaunchRequest,
  type WorkflowChildRunEvidence,
  type WorkflowRunLineage,
  type WorkflowRunnerCoordination,
} from "./workflow-saved-child.js";
import { createWorkflowRunFinalizer, type RunWorkflowScriptResult } from "./workflow-run-finalization.js";

export type { WorkflowScriptIdentity } from "./workflow-script-identity.js";
// The terminal sequence moved out whole (T-218 W14). The shape a run returns keeps
// its public identity HERE: every caller asks the runner for a run and gets this
// back, so the name stays exported from the module they already import.
export type { RunWorkflowScriptResult } from "./workflow-run-finalization.js";
// The saved-child owner moved out whole. Its public names stay importable here
// so existing callers keep one import for a run and its child evidence.
export type { WorkflowChildRunEvidence, WorkflowRunLineage } from "./workflow-saved-child.js";
// The resume authority and the ordered admission moved out whole (T-218 W13).
// Their public names stay importable here so a caller that wants a run AND the
// question "may this run continue that one?" still has one import. New callers
// of the resume verdicts should import them from their owner by name instead.
export { isPostCodeReviewTarget, readWorkflowResumeWorkspaceIdentity } from "./workflow-run-resume.js";
export type { WorkflowHandoffWorkspaceReuseBinding } from "./workflow-run-resume.js";
export { assertWorkflowTargetBinding } from "./workflow-run-admission.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowScriptModule {
  default?: (dsl: WorkflowDsl, input?: string) => Promise<unknown> | unknown;
  runWorkflow?: (dsl: WorkflowDsl, input?: string) => Promise<unknown> | unknown;
  meta?: {
    name?: string;
    description?: string;
    identityCoverage?: "self-contained-static" | "entry-only";
  };
}

const RUN_COORDINATION = Symbol("workflow-run-coordination");

export interface RunWorkflowScriptOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  name?: string;
  scriptPath?: string;
  script?: string;
  /** Host-owned resolved target; prevents launch-time raw-reference re-resolution. */
  targetBinding?: ResolvedWorkflowTarget;
  /** Optional bounded human semantic request. */
  input?: string;
  /** Optional exact text work units, separate from semantic input. */
  items?: readonly string[];
  /** Optional project-relative workflow workspace. */
  outputDir?: string;
  /** Short workflow workspace name expanded under `.locus-pi/workspaces/` with legacy reuse. */
  runName?: string;
  /** Closed host-owned cross-run artifact binding. */
  continuation?: WorkflowContinuation;
  /** Atomic source-handoff claim. The runner binds it to this run before
   * trusted workflow code starts; presentation callbacks are not authoritative. */
  operatorHandoffClaim?: WorkflowHandoffClaimLease;
  /** Host-owned exact source workspace proof for a validated handoff continuation. */
  operatorHandoffWorkspaceReuse?: WorkflowHandoffWorkspaceReuseBinding;
  resumeFromRunId?: string;
  /** Explicit conservative hard-crash admission; absent terminal result, identical serial source, no in-flight effects. */
  recoverInterrupted?: boolean;
  /**
   * Approved defaults: concurrency=4, plus totalAgents=10_000 for print/json roots.
   * Other undeclared axes are unbounded. Applied values and raises are journaled.
   * Saved children inherit the root budget without resolving defaults again.
   * The workflow tool and command launcher pass explicit operator-approved overrides.
   * Workflow source cannot raise this shared execution-tree budget itself; three
   * per-call axes additionally have an author surface in `agent(prompt, opts)`.
   */
  budget?: Partial<WorkflowBudget>;
  /**
   * Run-level guarantee for unattended launches: while on, ANY request for
   * operator input — `dsl.awaitOperator()` or a stage's `agent({ ask: true })`
   * — fails closed with a named reason instead of parking the run or mounting
   * a question. No auto-answer exists; a fabricated operator input would be
   * worse than the refusal. Saved children inherit the mode through run
   * coordination and cannot unset it. The launch surfaces turn it on by
   * default for headless (`print`/`json`) hosts, where no operator can be
   * reached; embedders that call the runner directly opt in themselves.
   */
  noOperator?: true;
  createExecutor?: (o: {
    model?: unknown;
    live?: import("../../_shared/agent-runtime/agent-sdk-host.js").AgentSdkSessionExecutorOptions["live"];
    maxToolCalls?: number;
    childTimeoutMs?: number;
    reportsDir?: string;
  }) => AgentExecutor; // pass-through to the bridge (tests)
  resolveModel?: import("../../_shared/model/workflow-model-resolve.js").WorkflowModelResolver; // pass-through to the bridge (tests)
  /** Called once after the run directory and first journal line exist. Presentation-only. */
  onRunStart?: (run: { runId: string; runDir: string }) => void;
  onEvent?: (line: WorkflowJournalLine) => void;
  [RUN_COORDINATION]?: WorkflowRunnerCoordination;
}

// ---------------------------------------------------------------------------
// Script loader
// ---------------------------------------------------------------------------

// TODO(trust-model): load workflow scripts in a node:vm/worker isolate with an import
// allow-list before executing untrusted author scripts. Currently scripts run in
// the host Node process with full module access — author scripts are trusted input.
export async function loadWorkflowScript(
  scriptPath: string,
  expectedSha256?: string,
  executionSource: "snapshot" | "source" = "source",
  cacheScope?: string,
): Promise<WorkflowScriptModule> {
  const scriptBytes = readFileSync(scriptPath);
  const actualSha256 = sha256WorkflowBytes(scriptBytes);
  if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
    const subject = executionSource === "snapshot" ? "snapshot" : "source";
    throw new Error(`Workflow script ${subject} hash mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  const scriptUrl = pathToFileURL(scriptPath);
  scriptUrl.searchParams.set("sha256", actualSha256);
  if (cacheScope !== undefined) scriptUrl.searchParams.set("run", cacheScope);
  // Pi loads extension TypeScript through Jiti, which can rewrite a lexical
  // import() and reuse the original path despite a different URL query. Creating
  // the native importer at runtime keeps Node's full content-addressed URL as the
  // module cache key.
  const mod = await importWorkflowModule(scriptUrl.href);
  if (expectedSha256 !== undefined) {
    const afterImportSha256 = sha256WorkflowBytes(readFileSync(scriptPath));
    if (afterImportSha256 !== expectedSha256) {
      const reason =
        executionSource === "snapshot"
          ? "Workflow script snapshot hash mismatch during module import"
          : "Workflow script changed during module import";
      throw new Error(`${reason}: expected ${expectedSha256}, got ${afterImportSha256}`);
    }
  }
  return mod;
}

async function importWorkflowModule(specifier: string): Promise<WorkflowScriptModule> {
  const importer = new Script("(value) => import(value)", {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext() as (value: string) => Promise<unknown>;
  return (await importer(specifier)) as WorkflowScriptModule;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runWorkflowScript(opts: RunWorkflowScriptOptions): Promise<RunWorkflowScriptResult> {
  const projectRoot = getProjectRoot(opts.ctx);
  const workingDirectory = getWorkingDirectory(opts.ctx);
  const inheritedCoordination = opts[RUN_COORDINATION];
  let items: readonly string[];
  const resolvedBudget =
    inheritedCoordination?.budget === undefined
      ? resolveWorkflowBudget(opts.budget, isOneShotHostMode(opts.ctx))
      : undefined;
  const budget = inheritedCoordination?.budget ?? resolvedBudget!.budget;
  const budgetRaises = resolvedBudget?.raises ?? [];
  let storageLocation: WorkflowRunLocation | undefined;
  let storageResolutionError: unknown;
  if (inheritedCoordination !== undefined) {
    storageLocation = { storageRootRunId: inheritedCoordination.storageRootRunId, kind: "child" };
  } else if (opts.resumeFromRunId !== undefined) {
    try {
      storageLocation = {
        storageRootRunId: workflowStorageRootRunId(projectRoot, opts.resumeFromRunId),
        kind: "attempt",
      };
    } catch (error) {
      // No safe group is known yet. Retain the rejected request in its own receipt.
      storageResolutionError = error;
    }
  }
  const requestedWorkflow = opts.targetBinding?.ref ?? opts.name ?? opts.scriptPath;
  const {
    runId,
    runDir,
    journal,
    firstLine: budgetPrelude,
  } = claimNewWorkflowRun(
    projectRoot,
    (mintedRunId) => ({
      ts: new Date().toISOString(),
      runId: mintedRunId,
      kind: "log",
      source: "runtime",
      message: formatWorkflowBudgetPrelude(budget),
    }),
    undefined,
    storageLocation,
    requestedWorkflow,
  );
  const storageRootRunId = storageLocation?.storageRootRunId ?? runId;
  const runtimeDir = workflowRunRuntimeDir(runDir);
  // Inherited coordination is the only authority for children: a saved child
  // can neither drop nor introduce the mode, exactly like `budget`.
  const noOperator =
    inheritedCoordination !== undefined
      ? inheritedCoordination.noOperator
      : opts.noOperator === true
        ? true
        : undefined;
  const noOperatorPrelude: WorkflowJournalLine | undefined =
    noOperator === undefined
      ? undefined
      : {
          ts: new Date().toISOString(),
          runId,
          kind: "log",
          source: "runtime",
          // A headless launch turns the mode on by default, so its journal has
          // to say why input was refused to a reader who typed no flag.
          message: isOneShotHostMode(opts.ctx) ? WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE : WORKFLOW_NO_OPERATOR_PRELUDE,
        };
  if (noOperatorPrelude !== undefined) journal.write(noOperatorPrelude);

  const requestedResumeFromRunId = opts.resumeFromRunId;
  let selectedOutputDir = opts.outputDir;
  const requestedSemanticInput = workflowSemanticInputIdentity(opts.input);
  let resumeFromRunId: string | undefined;
  let resumeSourceRunSummary: WorkflowRunSummary | null | undefined;
  let resumeSourceWorkspace: WorkflowResumeWorkspaceIdentity | undefined;
  let resumeSourceBinding: WorkflowResumeSourceBinding | undefined;
  let interruptedRecovery = false;
  let replayPlan: WorkflowReplayPlan | undefined;
  let replayController: WorkflowReplayController | undefined;
  let resourceLoader: WorkflowResourceLoader | undefined;
  let workspaceManager: WorkflowWorkspaceManager | undefined;
  let runtime: WorkflowRuntime | undefined;
  let artifactStore: WorkflowArtifactStore | undefined;
  let boundContinuation: WorkflowBoundContinuation | undefined;
  let continuationProjection: WorkflowContinuationJournal | undefined;
  let awaitOperatorDeclaration: WorkflowAwaitOperatorDeclaration | undefined;
  let handoffClaimBound = false;
  let stableOutput: WorkflowOutputDirectory | undefined = inheritedCoordination?.output;
  let handoffReuseOutput: WorkflowOutputDirectory | undefined;
  let rootLease: WorkflowRootLease | undefined = inheritedCoordination?.lease;
  let coordination: WorkflowRunnerCoordination | undefined = inheritedCoordination;
  let primaryFile: WorkflowPrimaryFileReference | undefined;
  const childRuns: WorkflowChildRunEvidence[] = [];
  let leaseReleased = false;
  const hasResume = requestedResumeFromRunId !== undefined;
  const preludeLines: WorkflowJournalLine[] = [
    budgetPrelude,
    ...(noOperatorPrelude === undefined ? [] : [noOperatorPrelude]),
  ];
  const emitPrelude = (line: WorkflowJournalLine): void => {
    preludeLines.push(line);
    journal.write(line);
    opts.onEvent?.(line);
  };
  /**
   * Evidence without a live announcement: the durable journal and run report
   * get the line; the progress surface does not. `result.json` keeps terminal
   * state, not a second copy of the event stream.
   *
   * Used for facts that are true of EVERY run. Pushing those through `onEvent`
   * would turn a run that emitted nothing into an eventful one and make the no-UI
   * surface claim delivery for a workflow that never spoke — the same reason the
   * default replay plan is silent below.
   */
  const recordPrelude = (line: WorkflowJournalLine): void => {
    preludeLines.push(line);
    journal.write(line);
  };
  // The applied budget is initialized as the FIRST durable line before the live
  // start callback. A start announcement therefore always names an existing run
  // directory and journal, or initialization throws before any child can run.
  // A narrowing applies silently; a raise never does. The line names the axis, the
  // package default and what was asked for, so a raise is auditable from the run
  // evidence alone instead of living in whoever's memory chose it.
  for (const raise of budgetRaises) {
    emitPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message: formatWorkflowBudgetRaise(raise, "run"),
    });
  }
  const resultMetadata = (): Pick<
    RunWorkflowScriptResult,
    | "resumeFromRunId"
    | "resumeSourceRunSummary"
    | "continuation"
    | "target"
    | "workspaceDir"
    | "workspaceDirRelative"
    | "workspacePhysicalIdentity"
    | "workspacePhysicalIdentitySchemaVersion"
    | "workspaceDirExplicit"
    | "semanticInputPresent"
    | "semanticInputSha256"
    | "stableOutputDir"
    | "stableOutputDirRelative"
    | "primaryFile"
    | "lineage"
    | "childRuns"
    | "storageRootRunId"
  > => {
    const lineage: WorkflowRunLineage =
      inheritedCoordination === undefined
        ? { rootRunId: runId, depth: 0 }
        : {
            rootRunId: inheritedCoordination.rootRunId,
            depth: inheritedCoordination.depth,
            ...(inheritedCoordination.parentRunId === undefined
              ? {}
              : { parentRunId: inheritedCoordination.parentRunId }),
            ...(inheritedCoordination.parentItemKey === undefined
              ? {}
              : { parentItemKey: inheritedCoordination.parentItemKey }),
          };
    return {
      ...(resumeFromRunId !== undefined
        ? { resumeFromRunId, resumeSourceRunSummary: resumeSourceRunSummary ?? null }
        : {}),
      ...(continuationProjection !== undefined ? { continuation: continuationProjection } : {}),
      ...(stableOutput === undefined
        ? {}
        : {
            workspaceDir: stableOutput.absolutePath,
            workspaceDirRelative: stableOutput.relativePath,
            workspacePhysicalIdentity: stableOutput.identity,
            workspacePhysicalIdentitySchemaVersion: 1,
            // A handoff continuation carries a host-validated workspace binding.
            // Its explicit bit is authoritative even though the launcher does not
            // repeat the source outputDir as an ordinary option.
            workspaceDirExplicit:
              handoffReuseOutput === undefined
                ? resumeSourceWorkspace?.explicit === true || opts.outputDir !== undefined
                : opts.operatorHandoffWorkspaceReuse?.explicit === true,
            // Every new root launch has a binding; its result must project the same input identity.
            semanticInputPresent: requestedSemanticInput.present,
            semanticInputSha256: requestedSemanticInput.sha256,
            stableOutputDir: stableOutput.absolutePath,
            stableOutputDirRelative: stableOutput.relativePath,
          }),
      ...(primaryFile === undefined ? {} : { primaryFile }),
      lineage,
      storageRootRunId,
      ...(childRuns.length === 0 ? {} : { childRuns: [...childRuns] }),
    };
  };
  const currentJournal = (runtime?: { getJournal(): WorkflowJournalLine[] }): WorkflowJournalLine[] => [
    ...preludeLines,
    ...(runtime?.getJournal() ?? []),
  ];
  let failedChildResult: Pick<WorkflowAgentResult, "childTrace" | "resultArtifact"> | undefined;
  let unhandledGroupFailure = false;
  // The terminal sequence has one owner. Every `finishRun(...)` route below hands
  // it the same field shape; the ORDER, the exactly-once lease release and the
  // mandatory/best-effort split live in `workflow-run-finalization.ts`.
  const finishRun = createWorkflowRunFinalizer({
    projectRoot,
    runId,
    runDir,
    requestedWorkflow,
    budget,
    signal: opts.signal,
    journal,
    ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
    // A saved child inherits its root's lease: it owns none, so it neither
    // fence-checks nor releases one.
    ownedRootLease: () => (inheritedCoordination === undefined ? rootLease : undefined),
    ...(opts.operatorHandoffClaim === undefined ? {} : { operatorHandoffClaim: opts.operatorHandoffClaim }),
    handoffClaimBound: () => handoffClaimBound,
    awaitOperator: () => awaitOperatorDeclaration,
    artifacts: () => artifactStore,
    workspaceEvidence: () => workspaceManager?.evidence(),
    resourceEvidence: () => resourceLoader?.evidence(),
    replay: () => (replayPlan === undefined ? undefined : workflowReplayEnvelope(replayPlan, replayController)),
    peakAgentConcurrency: () => runtime?.peakAgentConcurrency() ?? 0,
    failedChild: () => failedChildResult,
    unhandledGroupFailure: () => unhandledGroupFailure,
  });

  try {
    items = snapshotWorkflowItems(opts.items);
    try {
      opts.onRunStart?.({ runId, runDir });
    } catch {
      // Presentation callback failure must not turn successful workflow execution into a crash.
    }
    assertWorkflowInput(opts.input);
    if (opts.continuation !== undefined) assertWorkflowContinuation(opts.continuation);
    if (hasResume) resumeFromRunId = assertWorkflowRunId(requestedResumeFromRunId);
    if (
      storageResolutionError !== undefined &&
      !(
        typeof storageResolutionError === "object" &&
        storageResolutionError !== null &&
        "code" in storageResolutionError &&
        storageResolutionError.code === "ENOENT"
      )
    )
      throw storageResolutionError;
    if (hasResume && opts.continuation !== undefined) {
      throw new Error("Workflow continuation and resumeFromRunId are mutually exclusive.");
    }
    if (opts.operatorHandoffClaim !== undefined) {
      if (opts.continuation === undefined) {
        throw new Error("Workflow operator handoff claim requires a continuation.");
      }
      assertWorkflowHandoffClaimForContinuation(opts.operatorHandoffClaim, opts.continuation, projectRoot);
    }
    if (resumeFromRunId !== undefined) {
      const source = readWorkflowRunSummary(projectRoot, resumeFromRunId);
      if (source.status === "unknown") {
        resumeSourceRunSummary = null;
        const persistedSource = readWorkflowRunResult(projectRoot, resumeFromRunId);
        const invalidity = workflowPersistedResultInvalidity(persistedSource);
        const error =
          (invalidity === undefined
            ? undefined
            : `Cannot resume workflow: source run ${resumeFromRunId} has malformed persisted metadata (${invalidity}).`) ??
          workflowLegacyRunMigrationMessage(projectRoot, resumeFromRunId) ??
          `Cannot resume workflow: source run not found or unusable: ${resumeFromRunId}`;
        emitPrelude({
          ts: new Date().toISOString(),
          runId,
          kind: "error",
          message: error,
          resumeFromRunId,
          resumeSourceRunSummary: null,
        });
        const journalLines = currentJournal();
        return finishRun({ ok: false, result: undefined, journal: journalLines, error, ...resultMetadata() });
      }
      resumeSourceRunSummary = source;
      emitPrelude({
        ts: new Date().toISOString(),
        runId,
        kind: "log",
        source: "runtime",
        message: `resumeFromRunId=${resumeFromRunId} sourceStatus=${source.status}`,
        resumeFromRunId,
        resumeSourceRunSummary: source,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
    return finishRun({ ok: false, result: undefined, journal: currentJournal(), error, ...resultMetadata() });
  }

  const admission = admitWorkflowRun({
    projectRoot,
    workingDirectory,
    runId,
    runDir,
    runtimeDir,
    items,
    budget,
    ...(noOperator === undefined ? {} : { noOperator }),
    hasResume,
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    requestedSemanticInput,
    ...(inheritedCoordination === undefined ? {} : { inheritedCoordination }),
    launch: opts,
  });
  // Everything admission established stands whether it admitted or refused: a
  // refusal's terminal result projects the same workspace and handoff facts the
  // refusal itself already committed to.
  interruptedRecovery = admission.interruptedRecovery;
  resumeSourceWorkspace = admission.resumeSourceWorkspace;
  resumeSourceBinding = admission.resumeSourceBinding;
  handoffReuseOutput = admission.handoffReuseOutput;
  stableOutput = admission.stableOutput;
  if (!admission.admitted) {
    return finishRun({
      ok: false,
      result: undefined,
      journal: currentJournal(runtime),
      error: admission.error,
      ...(admission.target === undefined ? {} : { target: admission.target }),
      ...(admission.scriptIdentity === undefined ? {} : { scriptIdentity: admission.scriptIdentity }),
      ...resultMetadata(),
    });
  }
  const target = admission.target;
  const scriptIdentity = admission.scriptIdentity;
  // The admitted workspace, proven present by the verdict above. `stableOutput`
  // stays the mutable projection the terminal-result closures read.
  const admittedOutput = admission.stableOutput;
  // The root lease is acquired only AFTER a successful admission and BEFORE the
  // shared execution state exists, so no agent can start inside an unadmitted run.
  try {
    if (inheritedCoordination === undefined) {
      rootLease = acquireWorkflowRootLease({ projectRoot, output: admittedOutput, rootRunId: runId });
      if (interruptedRecovery && resumeFromRunId !== undefined) {
        readInterruptedWorkflowResumeBinding(projectRoot, resumeFromRunId, {
          target: { kind: target.kind, ref: target.ref, source: target.source },
          scriptSha256: scriptIdentity.scriptSha256,
          recoveryInputSha256: workflowRecoveryInputHash({
            ...(opts.input === undefined ? {} : { input: opts.input }),
            items,
            budget,
            ...(noOperator === undefined ? {} : { noOperator }),
          }),
        });
      }
      writeWorkflowRunGroupReport(
        { projectRoot, runId, storageRootRunId, workspaceDir: admittedOutput.absolutePath, workflow: target.ref },
        rootLease,
      );
      coordination = {
        rootRunId: runId,
        storageRootRunId,
        depth: 0,
        // Only the axes this run actually declared are passed on. An axis omitted
        // here is unbounded in the shared state — no counter, no clock — which is
        // the same thing the run header prints as `unbounded`.
        sharedExecution: createWorkflowSharedExecutionState({
          maxConcurrentAgents: budget.concurrency,
          ...(budget.totalAgents === undefined ? {} : { maxTotalAgentInvocations: budget.totalAgents }),
          ...(budget.runtimeMs === undefined ? {} : { runtimeMs: budget.runtimeMs }),
        }),
        lease: rootLease,
        output: admittedOutput,
        ancestry: [{ sourcePath: realpathSync(target.path), scriptSha256: scriptIdentity.scriptSha256 }],
        budget,
        ...(noOperator === undefined ? {} : { noOperator }),
      };
    }
    if (coordination === undefined) {
      throw new Error("workflow runner coordination was not initialized before runtime construction");
    }
    recordPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        `[workflow:project-source] policy=live projectRoot=${JSON.stringify(projectRoot)} ` +
        `runBoundaryStartedAt=${JSON.stringify(budgetPrelude.ts)} outputDir=${JSON.stringify(admittedOutput.relativePath)}`,
    });
    recordPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        `[workflow:lineage] rootRunId=${coordination.rootRunId} depth=${coordination.depth}` +
        (coordination.parentRunId === undefined ? "" : ` parentRunId=${coordination.parentRunId}`) +
        (coordination.parentItemKey === undefined
          ? ""
          : ` parentItemKey=${JSON.stringify(coordination.parentItemKey)}`),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  const executionCoordination = coordination;
  if (opts.operatorHandoffClaim !== undefined) {
    try {
      assertWorkflowHandoffClaimEligibility(opts.operatorHandoffClaim, { target, scriptIdentity });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const journalLines = currentJournal(runtime);
      return finishRun({
        ok: false,
        result: undefined,
        journal: journalLines,
        error,
        target,
        scriptIdentity,
        ...resultMetadata(),
      });
    }
  }

  try {
    replayPlan = planWorkflowReplay({
      projectRoot,
      scriptIdentity,
      target,
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
      ...(resumeSourceBinding === undefined ? {} : { resumeSourceResult: resumeSourceBinding.result }),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
    return finishRun({
      ok: false,
      result: undefined,
      journal: currentJournal(runtime),
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  if (
    interruptedRecovery &&
    (!replayPlan.record || replayPlan.recorded === undefined || replayPlan.refusedReason !== undefined)
  ) {
    return finishRun({
      ok: false,
      result: undefined,
      journal: currentJournal(runtime),
      error: "Interrupted recovery could not activate exact prefix replay",
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  if (replayPlan.record) {
    replayController = createWorkflowReplayController({
      runDir,
      ...(interruptedRecovery ? { requireRecordedPrefix: true } : {}),
      ...(replayPlan.recorded === undefined ? {} : { recorded: replayPlan.recorded }),
      ...(replayPlan.sourceScriptChanged === true ? { sourceScriptChanged: true } : {}),
    });
  }
  // Silent on the default path. A plain run that records normally is the norm,
  // and announcing it would turn every zero-event run into an eventful one; the
  // record itself and the `replay` envelope in result.json carry that fact.
  if (interruptedRecovery)
    emitPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:interrupted-recovery] exact confirmed serial prefix; no terminal success inferred",
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    });
  const replayPlanNote = describeWorkflowReplayPlan(replayPlan);
  if (replayPlanNote !== undefined) {
    emitPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message: replayPlanNote,
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    });
  }

  resourceLoader = createWorkflowResourceLoader({
    workflowSourcePath: target.path,
    runDir: runtimeDir,
  });
  workspaceManager = createWorkflowWorkspaceManager({
    projectRoot,
    runId,
    runDir,
  });
  try {
    artifactStore = createWorkflowArtifactStore({ projectRoot, runId, runDir });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  if (opts.continuation !== undefined) {
    try {
      boundContinuation = consumeWorkflowContinuation(artifactStore, opts.continuation);
      continuationProjection = continuationJournalProjection(boundContinuation);
      emitPrelude({
        ts: new Date().toISOString(),
        runId,
        kind: "log",
        source: "runtime",
        message: "[workflow:continuation]",
        continuation: continuationProjection,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
      return finishRun({
        ok: false,
        result: undefined,
        journal: currentJournal(runtime),
        error,
        target,
        scriptIdentity,
        ...resultMetadata(),
      });
    }
  }
  if (opts.operatorHandoffClaim !== undefined) {
    try {
      bindWorkflowHandoffClaim(opts.operatorHandoffClaim, runId);
      handoffClaimBound = true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
      return finishRun({
        ok: false,
        result: undefined,
        journal: currentJournal(runtime),
        error,
        target,
        scriptIdentity,
        ...resultMetadata(),
      });
    }
  }
  const agentBridgeOptions: WorkflowAgentBridgeOptions = {
    pi: opts.pi,
    ctx: opts.ctx,
    signal: opts.signal,
    workflowRunId: runId,
    workflowRunDir: runDir,
    workspaceManager,
    evidenceDestinations: (callId) => artifactStore!.childEvidenceDestinations(callId),
    workflowWorkspaceDir: stableOutput!.absolutePath,
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    ...(opts.createExecutor !== undefined ? { createExecutor: opts.createExecutor } : {}),
    ...(opts.resolveModel !== undefined ? { resolveModel: opts.resolveModel } : {}),
    ...(noOperator === undefined ? {} : { noOperator }),
  };
  const agentRunner = createWorkflowAgentRunner(agentBridgeOptions);
  const preflightAgentRequests = createWorkflowAgentPreflight(agentBridgeOptions);
  const savedChildren = new SavedChildExecutionOwner({
    projectRoot,
    workingDirectory,
    parentRunId: runId,
    parentTarget: target,
    parentScriptSha256: scriptIdentity.scriptSha256,
    coordination: executionCoordination,
    childRuns,
    // Recursion is injected, so the child owner never imports this module and
    // never names the coordination symbol: only this closure attaches it.
    launchChild: (request: SavedChildLaunchRequest) =>
      runWorkflowScript({
        pi: opts.pi,
        ctx: opts.ctx,
        signal: opts.signal,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
        ...(request.targetBinding === undefined ? {} : { targetBinding: request.targetBinding }),
        ...(request.input === undefined ? {} : { input: request.input }),
        items: request.items,
        outputDir: request.outputDir,
        ...(opts.createExecutor === undefined ? {} : { createExecutor: opts.createExecutor }),
        ...(opts.resolveModel === undefined ? {} : { resolveModel: opts.resolveModel }),
        ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
        onRunStart: request.onRunStart,
        [RUN_COORDINATION]: request.coordination,
      }),
    record: (message) => runtime!.recordRuntimeLog(message),
  });
  runtime = createWorkflowRuntime({
    runId,
    agentRunner,
    preflightAgentRequests,
    journal,
    projectRoot,
    outputDir: stableOutput!.relativePath,
    readCheckedWorkflowSource: (relativePath) => {
      const { content } = readWorkflowPrimaryFile(stableOutput!, relativePath);
      const text = content.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(content)) throw new Error("workflow source must be valid UTF-8");
      const errors = checkWorkflowSourceText(text, "orchestration-only").filter((item) => item.severity === "error");
      if (errors.length > 0)
        throw new Error(
          `${relativePath}: source publication failed:\n${errors
            .map((item) => `${item.line}:${item.column} [${item.code}] ${item.message}`)
            .join("\n")}`,
        );
      return text;
    },
    publishPrimaryFile: (relativePath) => {
      primaryFile = referenceWorkflowPrimaryFile(stableOutput!, relativePath);
      return primaryFile;
    },
    invokeWorkflow: savedChildren.invoke,
    sharedExecution: executionCoordination.sharedExecution,
    resourceLoader,
    workspaceManager,
    artifactPorts: artifactStore,
    ...(boundContinuation !== undefined ? { continuation: boundContinuation } : {}),
    ...(resumeFromRunId === undefined ? {} : { replaySourceRunId: resumeFromRunId }),
    ...(replayController !== undefined ? { replay: replayController } : {}),
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    items,
    // The execution-tree axes live in sharedExecution above. Only per-call
    // defaults belong on each runtime instance.
    ...(budget.timeoutMs === undefined ? {} : { defaultTimeoutMs: budget.timeoutMs }),
    ...(budget.toolCalls === undefined ? {} : { defaultMaxToolCalls: budget.toolCalls }),
    ...(budget.turns === undefined ? {} : { defaultMaxTurns: budget.turns }),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
    ...(noOperator === undefined ? {} : { operatorInputForbidden: true }),
    onAwaitOperator: (declaration) => {
      if (awaitOperatorDeclaration !== undefined) {
        throw new Error("awaitOperator may be declared only once per workflow run");
      }
      awaitOperatorDeclaration = declaration;
    },
  });

  let mod: WorkflowScriptModule;
  try {
    // Strict sources execute the retained snapshot. Explicit entry-only sources
    // execute the hash-qualified source URL so relative imports/import.meta keep
    // their author-directory semantics while the weaker coverage stays visible.
    mod = await loadWorkflowScript(
      workflowScriptExecutionPath(scriptIdentity),
      scriptIdentity.scriptSha256,
      scriptIdentity.executionSource,
      runId,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }

  const entry =
    typeof mod.default === "function"
      ? mod.default
      : typeof mod.runWorkflow === "function"
        ? mod.runWorkflow
        : undefined;

  if (entry === undefined) {
    const error = "Workflow script has no default or runWorkflow export";
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      failureOrigin: "script",
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }

  let result: unknown;
  try {
    // runGuarded contains BOTH awaited throws (already covered) AND out-of-band
    // failures: a detached promise rejection or an uncaught exception thrown from
    // SDK/host machinery we never get a handle to (e.g. a dead-model auth error
    // firing on a detached emit path). Without this run-scoped net those would hit
    // Node's default handler and KILL the whole pi process — the Iskhod-1 defect.
    result = await runGuardedAgainstHostCrash(() => Promise.resolve(entry(runtime!.dsl, opts.input)));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof WorkflowAgentExecutionError) {
      failedChildResult = err.result;
    }
    const journalLines = currentJournal(runtime);
    const groupFailure = workflowGroupFailureEnvelope(err);
    unhandledGroupFailure = groupFailure !== undefined;
    return finishRun({
      ok: false,
      result: groupFailure,
      journal: journalLines,
      error,
      // The trusted script itself rejected the run: the repair belongs in the
      // script or its prompts, not in the host.
      failureOrigin: "script",
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }

  const journalLines = currentJournal(runtime);
  const prepared = prepareWorkflowResult(result);
  if (
    interruptedRecovery &&
    replayPlan?.recorded !== undefined &&
    (replayController?.counts().replayedCalls ?? 0) < confirmedRecoveryAgentCount(replayPlan.recorded)
  ) {
    return finishRun({
      ok: false,
      result: undefined,
      journal: currentJournal(runtime),
      error: "Interrupted recovery ended before consuming the confirmed prefix",
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  const semanticOk = prepared.diagnostic === undefined && !isWorkflowResultExplicitFailure(prepared.value);
  try {
    // Result normalization can invoke script-defined toJSON(). Verify only after
    // that last script-owned callback, then enter the synchronous persistence
    // path without yielding. Read-only mode alone is not immutable to the owner.
    verifyWorkflowScriptSnapshot(scriptIdentity);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  return finishRun({
    ok: semanticOk,
    result: prepared.value,
    ...(prepared.diagnostic !== undefined
      ? {
          resultDiagnostic: prepared.diagnostic,
          error: prepared.diagnostic.message,
          failureOrigin: "script" as const,
        }
      : {}),
    journal: journalLines,
    target,
    scriptIdentity,
    ...resultMetadata(),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run-scoped net for host-fatal async failures — REFCOUNTED across active runs.
 *
 * THE CRASH-FIX (Iskhod-1): the awaited try/catch at the call site already contains
 * synchronous throws and awaited rejections. What it CANNOT see is an error that
 * escapes on a detached path — an `unhandledRejection` from a promise we never
 * receive, or an `uncaughtException` thrown from SDK/host event machinery. Those
 * reach Node's default handler and terminate the whole `pi` process. Catching them
 * here and routing them to the active run's `ok:false` is the actual fix.
 *
 * THE REFCOUNT (robustness/simplification, NOT the crash-fix): one SHARED listener
 * pair is installed when the first run becomes active and removed when the last
 * active run finishes (via `activeRuns`). This replaces a per-run install/remove.
 * Note the per-run scheme was already crash-safe under overlap — it used a fresh
 * CLOSURE pair per run, so one run's `removeListener` only removed its own distinct
 * handler and never stripped another run's still-armed guard. The refcount's win is
 * one shared pair instead of N: simpler, no listener accumulation while runs overlap.
 *
 * DOCUMENTED LIMIT (accepted trade-off for the serial surface):
 *   While ANY run's window is open, an out-of-band failure that is genuinely
 *   unrelated to the workflow (some other host machinery's stray rejection) is
 *   still attributed to the active run(s) and surfaced as that run's `ok:false`.
 *   We cannot honestly attribute a detached failure to a specific run, so under
 *   overlap we fan it out to every active run. This can mask an unrelated bug as
 *   a workflow failure — chosen deliberately: keeping `pi` alive (fail-safe)
 *   outweighs not-masking on a surface that runs workflows serially.
 */
const activeRuns = new Set<(error: unknown) => void>();

const onHostUnhandledRejection = (reason: unknown): void => routeOutOfBandFailure(reason);
const onHostUncaughtException = (error: unknown): void => routeOutOfBandFailure(error);

function routeOutOfBandFailure(error: unknown): void {
  // No active run to attribute this to; let Node's default handler take it.
  // Serial case: exactly one sink → exact attribution. Overlap: fan out to all
  // (see DOCUMENTED LIMIT above). Snapshot first; sinks deregister on settle.
  for (const reject of [...activeRuns]) reject(error);
}

async function runGuardedAgainstHostCrash<T>(run: () => Promise<T>): Promise<T> {
  let sink!: (error: unknown) => void;
  const fatal = new Promise<never>((_resolve, reject) => {
    sink = (error: unknown) =>
      reject(error instanceof Error ? error : new Error(`workflow run failed out-of-band: ${String(error)}`));
  });

  activeRuns.add(sink);
  if (activeRuns.size === 1) {
    // First active run installs the one shared listener pair.
    process.on("unhandledRejection", onHostUnhandledRejection);
    process.on("uncaughtException", onHostUncaughtException);
  }
  try {
    // Whichever settles first wins: the real result, or an out-of-band failure
    // routed through `fatal`. Either way the host process survives.
    return await Promise.race([run(), fatal]);
  } finally {
    activeRuns.delete(sink);
    if (activeRuns.size === 0) {
      // Last active run removes the shared pair — no listener leak.
      process.removeListener("unhandledRejection", onHostUnhandledRejection);
      process.removeListener("uncaughtException", onHostUncaughtException);
    }
  }
}
