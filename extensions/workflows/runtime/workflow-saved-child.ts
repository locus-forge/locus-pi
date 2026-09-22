/**
 * workflow-saved-child.ts — Saved-child owner for one root workflow run.
 *
 * One parent run may invoke saved workflows as children. This module owns that
 * whole lifecycle: what a child invocation is allowed to say, which source it
 * binds to, whether a completed child may be skipped from the root checkpoint
 * ledger, and the evidence and navigation lines the parent records for it.
 *
 * It does NOT own how a run is started. Recursion into the runner arrives as an
 * injected `LaunchSavedChildWorkflow` port, so the run-coordination handshake —
 * including the runner's private coordination symbol — stays with the runner and
 * the dependency keeps one direction: runner -> saved child.
 *
 * Invariants this module is the single place for:
 *   - exactly one saved-child level; a grandchild is refused, never queued;
 *   - the complete unique key list is validated before the first child starts;
 *   - the child inherits the root gate, budget, lease and deadline as the SAME
 *     shared execution state object — a child never opens a second one;
 *   - a checkpoint is committed only after a confirmed terminal success;
 *   - the child source is proven before and after execution.
 */
import { readFileSync, realpathSync } from "node:fs";

import type { WorkflowBudget } from "./workflow-budget.js";
import {
  packagedWorkflowPath,
  resolveOwnedWorkflowChild,
  resolveWorkflowTarget,
  type ResolvedWorkflowTarget,
} from "./workflow-discovery.js";
import type { WorkflowSharedExecutionState } from "./workflow-execution-state.js";
import type { WorkflowDisposition } from "./workflow-outcome.js";
import {
  assertWorkflowInput,
  snapshotWorkflowItems,
  type WorkflowSavedChildInvocation,
  type WorkflowSavedChildResult,
} from "./workflow-runtime.js";
import { sha256WorkflowBytes, type WorkflowScriptIdentity } from "./workflow-script-identity.js";
import {
  revalidateWorkflowPrimaryFile,
  type WorkflowOutputDirectory,
  type WorkflowPrimaryFileReference,
} from "./workflow-workspace.js";
import {
  assertUniqueWorkflowItemKeys,
  assertWorkflowItemKey,
  assertWorkflowRootLease,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  type WorkflowCheckpointIdentity,
  type WorkflowRootLease,
} from "./workflow-workspace-state.js";

// ---------------------------------------------------------------------------
// Lineage and coordination
// ---------------------------------------------------------------------------

export interface WorkflowRunLineage {
  rootRunId: string;
  depth: 0 | 1;
  parentRunId?: string;
  parentItemKey?: string;
}

export interface WorkflowChildRunEvidence extends Omit<WorkflowSavedChildResult, "status"> {
  status: "running" | "completed" | "skipped" | "awaiting_operator" | "cancelled" | "failed";
  runDir?: string;
  childScriptSha256: string;
}

interface ExpectedWorkflowChildSource {
  canonicalPath: string;
  scriptSha256: string;
}

export interface WorkflowRunnerCoordination {
  rootRunId: string;
  storageRootRunId: string;
  depth: 0 | 1;
  parentRunId?: string;
  parentItemKey?: string;
  sharedExecution: WorkflowSharedExecutionState;
  lease: WorkflowRootLease;
  output: WorkflowOutputDirectory;
  ancestry: readonly { sourcePath: string; scriptSha256: string }[];
  budget: WorkflowBudget;
  /** Run-level no-operator mode. Lives on coordination so a saved child can
   *  neither drop nor weaken it: one run, one guarantee. */
  noOperator?: true;
  expectedChildSource?: ExpectedWorkflowChildSource;
}

// ---------------------------------------------------------------------------
// Injected recursive launcher
// ---------------------------------------------------------------------------

/**
 * What this owner needs back from a finished child run. The runner's
 * `RunWorkflowScriptResult` satisfies it structurally, so the injected closure
 * needs no adapter and this module needs no import of the runner.
 */
export interface SavedChildRunOutcome {
  runId: string;
  runDir: string;
  ok: boolean;
  disposition?: WorkflowDisposition;
  error?: string;
  primaryFile?: WorkflowPrimaryFileReference;
  scriptIdentity?: WorkflowScriptIdentity;
}

/** The validated, source-bound launch this owner asks the runner to perform. */
export interface SavedChildLaunchRequest {
  /** Exactly one selector, taken from the already-resolved child target. */
  name?: string;
  scriptPath?: string;
  /** Absent only for the legacy exact-Package selector, which re-resolves. */
  targetBinding?: ResolvedWorkflowTarget;
  input?: string;
  items: readonly string[];
  outputDir: string;
  onRunStart: (run: { runId: string; runDir: string }) => void;
  /** Inherited root coordination for the child. The runner attaches it under
   *  its own private symbol; this module never names that symbol. */
  coordination: WorkflowRunnerCoordination;
}

/** Recursion port: run one saved child and report its terminal evidence. */
export type LaunchSavedChildWorkflow = (request: SavedChildLaunchRequest) => Promise<SavedChildRunOutcome>;

// ---------------------------------------------------------------------------
// Lifecycle evidence
// ---------------------------------------------------------------------------

interface SavedChildLifecycleOwner {
  recordSkipped(checkpoint: {
    childRunId: string;
    primaryFile?: WorkflowPrimaryFileReference;
  }): WorkflowSavedChildResult;
  recordStarted(run: { runId: string; runDir: string }): void;
  recordTerminal(
    child: SavedChildRunOutcome,
    overrideStatus?: WorkflowChildRunEvidence["status"],
  ): WorkflowChildRunEvidence;
  recordThrownFailure(): void;
}

function savedChildResult(evidence: WorkflowChildRunEvidence): WorkflowSavedChildResult {
  if (evidence.status !== "completed" && evidence.status !== "skipped") {
    throw new Error(`saved child result cannot expose non-success status ${evidence.status}`);
  }
  return {
    status: evidence.status,
    key: evidence.key,
    outputDir: evidence.outputDir,
    ...(evidence.runId === undefined ? {} : { runId: evidence.runId }),
    ...(evidence.sourceRunId === undefined ? {} : { sourceRunId: evidence.sourceRunId }),
    ...(evidence.primaryFile === undefined ? {} : { primaryFile: evidence.primaryFile }),
  };
}

/** One parent-owned source of truth for saved-child evidence and navigation lines. */
function createSavedChildLifecycleOwner(input: {
  key: string;
  outputDir: string;
  childScriptSha256: string;
  childRuns: WorkflowChildRunEvidence[];
  record: (message: string) => void;
}): SavedChildLifecycleOwner {
  let evidenceIndex: number | undefined;
  let startedEvidence: WorkflowChildRunEvidence | undefined;

  return {
    recordSkipped(checkpoint) {
      const evidence: WorkflowChildRunEvidence = {
        status: "skipped",
        key: input.key,
        outputDir: input.outputDir,
        sourceRunId: checkpoint.childRunId,
        childScriptSha256: input.childScriptSha256,
        ...(checkpoint.primaryFile === undefined ? {} : { primaryFile: checkpoint.primaryFile }),
      };
      input.childRuns.push(evidence);
      input.record(
        `[workflow:child-skip] key=${JSON.stringify(input.key)} sourceRunId=${checkpoint.childRunId} ` +
          `childScriptSha256=${input.childScriptSha256}`,
      );
      return savedChildResult(evidence);
    },

    recordStarted(run) {
      const evidence: WorkflowChildRunEvidence = {
        status: "running",
        key: input.key,
        outputDir: input.outputDir,
        runId: run.runId,
        runDir: run.runDir,
        childScriptSha256: input.childScriptSha256,
      };
      startedEvidence = evidence;
      evidenceIndex = input.childRuns.push(evidence) - 1;
      input.record(
        `[workflow:child-start] key=${JSON.stringify(input.key)} runId=${run.runId} ` +
          `childScriptSha256=${input.childScriptSha256}`,
      );
    },

    recordTerminal(child, overrideStatus) {
      const status = overrideStatus ?? child.disposition?.status ?? (child.ok ? "completed" : "failed");
      const evidence: WorkflowChildRunEvidence = {
        status,
        key: input.key,
        outputDir: input.outputDir,
        runId: child.runId,
        runDir: child.runDir,
        childScriptSha256: input.childScriptSha256,
        ...(child.primaryFile === undefined ? {} : { primaryFile: child.primaryFile }),
      };
      if (evidenceIndex === undefined) evidenceIndex = input.childRuns.push(evidence) - 1;
      else input.childRuns[evidenceIndex] = evidence;
      input.record(`[workflow:child-end] key=${JSON.stringify(input.key)} runId=${child.runId} status=${status}`);
      return evidence;
    },

    recordThrownFailure() {
      if (evidenceIndex === undefined || startedEvidence === undefined) return;
      const evidence: WorkflowChildRunEvidence = { ...startedEvidence, status: "failed" };
      input.childRuns[evidenceIndex] = evidence;
      input.record(`[workflow:child-end] key=${JSON.stringify(input.key)} runId=${evidence.runId} status=failed`);
    },
  };
}

// ---------------------------------------------------------------------------
// Execution owner
// ---------------------------------------------------------------------------

export interface SavedChildExecutionOwnerOptions {
  projectRoot: string;
  workingDirectory: string;
  parentRunId: string;
  parentTarget: ResolvedWorkflowTarget;
  parentScriptSha256: string;
  coordination: WorkflowRunnerCoordination;
  childRuns: WorkflowChildRunEvidence[];
  /** Recursion stays injected so this module never imports the runner. */
  launchChild: LaunchSavedChildWorkflow;
  record: (message: string) => void;
}

interface ValidatedSavedChildInvocation {
  key: string;
  items: readonly string[];
}

interface ResolvedSavedChildSource {
  target: ResolvedWorkflowTarget;
  path: string;
  scriptSha256: string;
}

/** Owns validation, checkpoint reuse, and recursive execution for one root run. */
export class SavedChildExecutionOwner {
  readonly invoke = async (input: WorkflowSavedChildInvocation): Promise<WorkflowSavedChildResult> => {
    const validated = this.validateInvocation(input);
    const source = this.resolveSource(input);
    const checkpointIdentity = {
      parentScriptSha256: this.options.parentScriptSha256,
      childScriptSha256: source.scriptSha256,
      outputDir: this.options.coordination.output.identity,
      itemKey: validated.key,
    };
    const lifecycle = createSavedChildLifecycleOwner({
      key: validated.key,
      outputDir: this.options.coordination.output.relativePath,
      childScriptSha256: source.scriptSha256,
      childRuns: this.options.childRuns,
      record: this.options.record,
    });
    const skipped = this.reuseCheckpoint(checkpointIdentity, lifecycle, validated.key);
    if (skipped !== undefined) return skipped;
    const child = await this.runChild(input, validated, source, lifecycle);
    if ((child.disposition?.status ?? (child.ok ? "completed" : "failed")) === "completed") {
      try {
        this.verifySourceAfterRun(source, child);
      } catch (error) {
        lifecycle.recordTerminal(child, "failed");
        throw error;
      }
    }
    const evidence = lifecycle.recordTerminal(child);
    if (evidence.status !== "completed") {
      throw new Error(
        `saved child workflow ${JSON.stringify(source.target.ref)} ${evidence.status}: ${child.error ?? "no terminal detail"}`,
      );
    }
    commitWorkflowCompletedCheckpoint(this.options.coordination.lease, {
      ...checkpointIdentity,
      childRunId: child.runId,
      ...(child.primaryFile === undefined ? {} : { primaryFile: child.primaryFile }),
    });
    return savedChildResult(evidence);
  };

  private declaredKeys: readonly string[] | undefined;
  private readonly invokedKeys = new Set<string>();

  constructor(private readonly options: SavedChildExecutionOwnerOptions) {}

  private resolveSource(input: WorkflowSavedChildInvocation): ResolvedSavedChildSource {
    const target: ResolvedWorkflowTarget =
      input.child !== undefined
        ? resolveOwnedWorkflowChild(
            this.options.parentTarget,
            input.child,
            this.options.projectRoot,
            this.options.workingDirectory,
          )
        : input.packageName === undefined
          ? resolveWorkflowTarget(
              {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
              },
              this.options.projectRoot,
              this.options.workingDirectory,
            )
          : {
              kind: "name",
              ref: input.packageName,
              path: packagedWorkflowPath(input.packageName),
              source: "package",
            };
    const sourcePath = realpathSync(target.path);
    const scriptSha256 = sha256WorkflowBytes(readFileSync(sourcePath));
    if (
      this.options.coordination.ancestry.some(
        (ancestor) => ancestor.sourcePath === sourcePath || ancestor.scriptSha256 === scriptSha256,
      )
    ) {
      throw new Error(`saved workflow cycle detected for ${JSON.stringify(target.ref)}`);
    }
    return { target, path: sourcePath, scriptSha256 };
  }

  private reuseCheckpoint(
    identity: WorkflowCheckpointIdentity,
    lifecycle: SavedChildLifecycleOwner,
    key: string,
  ): WorkflowSavedChildResult | undefined {
    const checkpoint = readWorkflowCompletedCheckpoint(this.options.coordination.lease, identity);
    if (checkpoint === undefined) return undefined;
    let primaryFile = checkpoint.primaryFile;
    if (primaryFile !== undefined) {
      try {
        primaryFile = revalidateWorkflowPrimaryFile(this.options.coordination.output, primaryFile);
      } catch (error) {
        this.options.record(
          `[workflow:checkpoint-stale] key=${JSON.stringify(key)} reason=${JSON.stringify(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
        return undefined;
      }
    }
    assertWorkflowRootLease(this.options.coordination.lease);
    return lifecycle.recordSkipped({
      ...checkpoint,
      ...(primaryFile === undefined ? {} : { primaryFile }),
    });
  }

  private async runChild(
    input: WorkflowSavedChildInvocation,
    validated: ValidatedSavedChildInvocation,
    source: ResolvedSavedChildSource,
    lifecycle: SavedChildLifecycleOwner,
  ): Promise<SavedChildRunOutcome> {
    const childCoordination: WorkflowRunnerCoordination = {
      rootRunId: this.options.coordination.rootRunId,
      storageRootRunId: this.options.coordination.storageRootRunId,
      depth: 1,
      parentRunId: this.options.parentRunId,
      parentItemKey: validated.key,
      sharedExecution: this.options.coordination.sharedExecution,
      lease: this.options.coordination.lease,
      output: this.options.coordination.output,
      ancestry: [...this.options.coordination.ancestry, { sourcePath: source.path, scriptSha256: source.scriptSha256 }],
      budget: this.options.coordination.budget,
      ...(this.options.coordination.noOperator === undefined
        ? {}
        : { noOperator: this.options.coordination.noOperator }),
      expectedChildSource: { canonicalPath: source.path, scriptSha256: source.scriptSha256 },
    };
    try {
      return await this.options.launchChild({
        ...(source.target.kind === "name" ? { name: source.target.ref } : { scriptPath: source.target.ref }),
        // packageName is the legacy exact-Package selector. Let the child
        // source snapshot reject a newly introduced project shadow with the
        // established source-change error instead of rebinding it.
        ...(input.packageName === undefined ? { targetBinding: source.target } : {}),
        ...(input.input === undefined ? {} : { input: input.input }),
        items: validated.items,
        outputDir: this.options.coordination.output.relativePath,
        onRunStart: lifecycle.recordStarted,
        coordination: childCoordination,
      });
    } catch (error) {
      lifecycle.recordThrownFailure();
      throw error;
    }
  }

  private verifySourceAfterRun(source: ResolvedSavedChildSource, child: SavedChildRunOutcome): void {
    const sourcePath = realpathSync(source.target.path);
    const scriptSha256 = sha256WorkflowBytes(readFileSync(sourcePath));
    if (
      child.scriptIdentity?.scriptSha256 !== source.scriptSha256 ||
      sourcePath !== source.path ||
      scriptSha256 !== source.scriptSha256
    ) {
      throw new Error(`saved child workflow source changed during execution: ${JSON.stringify(source.target.ref)}`);
    }
  }

  private validateInvocation(input: WorkflowSavedChildInvocation): ValidatedSavedChildInvocation {
    if (this.options.coordination.depth >= 1) {
      // Not a size or budget policy, and not a claim that deeper nesting is wrong:
      // one shared scheduler, journal and budget ledger for nested saved runs is an
      // open decision, and until it exists a second level would run outside the
      // accounting this level is held to. The guard stays until that ledger lands.
      throw new Error(
        "saved child workflows may not invoke another saved workflow yet: nested saved runs stay closed " +
          "until one shared scheduler, journal and explicit budget ledger covers them (pending decision)",
      );
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("invokeWorkflow requires one closed invocation object");
    }
    const allowed = new Set([
      "child",
      "name",
      "scriptPath",
      "packageName",
      "input",
      "items",
      "key",
      "keys",
      "outputDir",
    ]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown !== undefined) throw new Error(`invokeWorkflow has no field ${JSON.stringify(unknown)}`);
    const targetCount = [input.child, input.name, input.scriptPath, input.packageName].filter(
      (value) => value !== undefined,
    ).length;
    if (targetCount !== 1) {
      throw new Error("invokeWorkflow requires exactly one of child, name, scriptPath, or packageName");
    }
    assertWorkflowInput(input.input, "saved child input");
    const items = snapshotWorkflowItems(input.items);
    if (!Array.isArray(input.keys)) throw new Error("invokeWorkflow keys must be an array");
    const keys = assertUniqueWorkflowItemKeys(input.keys);
    if (this.declaredKeys === undefined) this.declaredKeys = keys;
    else if (JSON.stringify(keys) !== JSON.stringify(this.declaredKeys)) {
      throw new Error("invokeWorkflow keys must remain the same complete list for one parent run");
    }
    const key = assertWorkflowItemKey(input.key);
    if (!keys.includes(key)) throw new Error(`invokeWorkflow key is not present in keys: ${JSON.stringify(key)}`);
    if (this.invokedKeys.has(key)) {
      throw new Error(`invokeWorkflow key was already used in this parent run: ${JSON.stringify(key)}`);
    }
    if (input.outputDir !== this.options.coordination.output.relativePath) {
      throw new Error(
        `invokeWorkflow outputDir must equal ${JSON.stringify(this.options.coordination.output.relativePath)}`,
      );
    }
    this.invokedKeys.add(key);
    return { key, items };
  }
}
