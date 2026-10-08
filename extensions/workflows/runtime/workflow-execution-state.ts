/**
 * workflow-execution-state.ts — the ROOT execution budget of one workflow run: the
 * fresh-invocation counter, the leaf-agent concurrency gate, the run deadline, and the
 * two typed RUN-level refusals those axes raise.
 *
 * Exactly ONE of these objects exists per root run. `workflow-runner.ts` creates it and
 * passes the same object to the root runtime and to every saved-child runtime, so no
 * child can open a second counter or a second gate beside its parent's.
 *
 * Not to be confused with the per-group scheduler in `workflow-groups.ts`: that one
 * bounds the width of ONE `parallel()`/`pipeline()` call, while the gate here bounds
 * simultaneously EXECUTING leaf agents across the whole run. Both exist; neither
 * replaces the other.
 *
 * Pure host-agnostic state, like `workflow-budget.ts` below it: no fs / process /
 * network, so it stays inside the DSL core's `node:fs`-free value closure that rule 7
 * of `scripts/check-extension-layers.ts` proves.
 */

import { DEFAULT_WORKFLOW_CONCURRENCY, assertWorkflowBudgetValue } from "./workflow-budget.js";

import {
  createExecutionState,
  type ExecutionState,
  type ExecutionReservation,
} from "../../_shared/runtime/execution-state.js";

export type WorkflowInvocationReservation = ExecutionReservation;

/** Thrown by agentDsl() when a run exceeds maxTotalAgentInvocations. Bubbles past
 *  grouped contexts (parallel/pipeline) so a cyclic/runaway workflow exits the run
 *  with a clear error instead of looping unbounded. */
export class WorkflowInvocationCapError extends Error {
  readonly cap: number;
  /**
   * `detail` replaces the generic sentence when the refusal has a more precise one
   * — a Fusion panel that cannot fit its worst case, for instance. The CLASS is what
   * `journalBudgetStop` reads to name the axis, so every refusal on `totalAgents`
   * prints as `stopped by budget totalAgents` whatever its sentence says.
   */
  constructor(cap: number, detail?: string) {
    super(detail ?? `workflow exceeded maxTotalAgentInvocations cap of ${cap}`);
    this.name = "WorkflowInvocationCapError";
    this.cap = cap;
  }
}

/**
 * Thrown when a child would START after the run's wall clock expired. Mirrors
 * WorkflowInvocationCapError deliberately: same check site, same bubbling past
 * grouped contexts, same "refuse the next one rather than abort the current one"
 * discipline. Aborting a child mid-flight would need a second abort path racing
 * the per-child fuse, which is the defect the single-deadline rule removes.
 *
 * What it bounds, stated so a reader does not have to infer it: the AGENT CHAIN.
 * A run is bounded by `runtimeMs` plus at most one child's own `timeoutMs`. Script
 * code that calls no further agent is not bounded by this at all.
 */
export class WorkflowRunDeadlineError extends Error {
  readonly runtimeMs: number;
  readonly elapsedMs: number;
  constructor(runtimeMs: number, elapsedMs: number) {
    super(
      `workflow exceeded its runtimeMs budget of ${runtimeMs} ms (${elapsedMs} ms elapsed) before this agent call started`,
    );
    this.name = "WorkflowRunDeadlineError";
    this.runtimeMs = runtimeMs;
    this.elapsedMs = elapsedMs;
  }
}

/** The two failures that bound the RUN, not one branch. Both are thrown before any
 *  child work and must exit grouped contexts unchanged. */
export function isRunLevelWorkflowFailure(err: unknown): boolean {
  return err instanceof WorkflowInvocationCapError || err instanceof WorkflowRunDeadlineError;
}

/** The workflow facade preserves budget policy and typed failures; the shared owner
 * holds every counter, reservation, permit, and physical launch identity. */
export interface WorkflowSharedExecutionState extends ExecutionState {
  readonly concurrency: number;
  readonly maxTotalAgentInvocations: number | undefined;
  readonly runtimeMs: number | undefined;
}

export function createWorkflowSharedExecutionState(input: {
  maxConcurrentAgents?: number;
  maxTotalAgentInvocations?: number;
  runtimeMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
}): WorkflowSharedExecutionState {
  const concurrency = input.maxConcurrentAgents ?? DEFAULT_WORKFLOW_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("maxConcurrentAgents must be a positive integer when provided");
  }
  if (
    input.maxTotalAgentInvocations !== undefined &&
    (!Number.isSafeInteger(input.maxTotalAgentInvocations) || input.maxTotalAgentInvocations < 1)
  ) {
    throw new Error("maxTotalAgentInvocations must be a positive integer when provided");
  }
  if (input.runtimeMs !== undefined) assertWorkflowBudgetValue("runtimeMs", input.runtimeMs);
  const owner = createExecutionState({
    concurrency,
    ...(input.maxTotalAgentInvocations === undefined ? {} : { totalAgents: input.maxTotalAgentInvocations }),
    ...(input.runtimeMs === undefined ? {} : { runtimeMs: input.runtimeMs }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    capError: (cap, requested, remaining) =>
      new WorkflowInvocationCapError(
        cap,
        requested === undefined
          ? undefined
          : `fusion needs up to ${requested} agent invocation(s), but only ${remaining} remain in this run`,
      ),
    deadlineError: (runtimeMs, elapsed) => new WorkflowRunDeadlineError(runtimeMs, elapsed),
  });
  return {
    ...owner,
    concurrency,
    maxTotalAgentInvocations: input.maxTotalAgentInvocations,
    runtimeMs: input.runtimeMs,
  };
}
