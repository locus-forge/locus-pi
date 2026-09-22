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

/** Fusion's pre-paid slice of the `totalAgents` axis, held while one panel runs. */
export interface WorkflowInvocationReservation {
  remaining: number;
  active: boolean;
}

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

/** Shared by every real saved child. Workflow source receives only the DSL. */
export interface WorkflowSharedExecutionState {
  /** The run's ONE effective leaf-agent width; also the default `parallel()` width. */
  readonly concurrency: number;
  /** Explicit fresh-child cap, or `undefined` for an unbounded axis. */
  readonly maxTotalAgentInvocations: number | undefined;
  readonly runtimeMs: number | undefined;
  reserve(count: number): WorkflowInvocationReservation;
  consumeReservation(reservation: WorkflowInvocationReservation): void;
  releaseReservation(reservation: WorkflowInvocationReservation): void;
  /** `undefined` when the axis is unbounded: nothing remains to run out. */
  remainingAgentInvocations(): number | undefined;
  /**
   * Take the next physical attempt number, charging the `totalAgents` axis only
   * for attempts that actually start a child.
   *
   * `kind` is the whole point: a replayed call projects a recorded answer and calls
   * no model, so charging it would let a `--resume` of a finished run die on a cap
   * the original run satisfied. The returned sequence number still counts every
   * attempt, because it is this attempt's identity (`call-0007`), not its price.
   */
  spendInvocation(kind: "fresh" | "replayed"): number;
  /** Fresh attempts charged so far, and replayed ones observed but not charged. */
  invocationCounts(): { fresh: number; replayed: number };
  assertDeadline(): void;
  acquireAgent(): Promise<void>;
  releaseAgent(): void;
  peakAgentConcurrency(): number;
}

interface AgentConcurrencyGate {
  acquire(): Promise<void>;
  release(): void;
  /**
   * High-water mark of simultaneously EXECUTING leaf agents.
   *
   * Gate-owned rather than derived from the journal, and that is the whole point:
   * `agent_start` is emitted before `acquire()`, so counting overlapping
   * start/end intervals counts children that are still queued. That number is
   * demand, not concurrency, and printing it beside a concurrency limit would
   * read as a limit breach that never happened.
   */
  peak(): number;
}

class CountingAgentConcurrencyGate implements AgentConcurrencyGate {
  private inUse = 0;
  private peakInUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrentAgents: number) {}

  acquire(): Promise<void> {
    if (this.inUse < this.maxConcurrentAgents) {
      this.enter();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.enter();
        resolve();
      });
    });
  }

  release(): void {
    this.inUse -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  peak(): number {
    return this.peakInUse;
  }

  private enter(): void {
    this.inUse += 1;
    if (this.inUse > this.peakInUse) this.peakInUse = this.inUse;
  }
}

function createAgentConcurrencyGate(maxConcurrentAgents: number): AgentConcurrencyGate {
  if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1) {
    throw new Error("maxConcurrentAgents must be a positive integer when provided");
  }
  return new CountingAgentConcurrencyGate(maxConcurrentAgents);
}

/**
 * Create the one physical execution budget shared by a root and every saved child.
 *
 * Two of the three axes here are OPTIONAL and unbounded when absent: an undeclared
 * `maxTotalAgentInvocations` refuses nobody and an undeclared `runtimeMs` arms no
 * clock. The launch resolver supplies the headless cap; this host-agnostic owner
 * only defaults the queueing width.
 */
export function createWorkflowSharedExecutionState(input: {
  maxConcurrentAgents?: number;
  maxTotalAgentInvocations?: number;
  runtimeMs?: number;
  nowMs?: () => number;
}): WorkflowSharedExecutionState {
  const concurrency = input.maxConcurrentAgents ?? DEFAULT_WORKFLOW_CONCURRENCY;
  const gate = createAgentConcurrencyGate(concurrency);
  const maxTotalAgentInvocations = resolveMaxTotalAgentInvocations(input.maxTotalAgentInvocations);
  const nowMs = input.nowMs ?? (() => Date.now());
  /** Physical attempts, replayed included: this is attempt IDENTITY, not spend. */
  let sequence = 0;
  /** Attempts that actually started a child. The only number `totalAgents` bounds. */
  let charged = 0;
  let replayedCount = 0;
  let reserved = 0;
  let started: number | undefined;
  let deadline: number | undefined;
  if (input.runtimeMs !== undefined) {
    assertWorkflowBudgetValue("runtimeMs", input.runtimeMs);
    started = nowMs();
    deadline = started + input.runtimeMs;
  }
  const remaining = (): number | undefined =>
    maxTotalAgentInvocations === undefined ? undefined : maxTotalAgentInvocations - charged - reserved;

  return {
    concurrency,
    maxTotalAgentInvocations,
    runtimeMs: input.runtimeMs,
    reserve(count) {
      const left = remaining();
      if (left !== undefined && count > left) {
        // A `totalAgents` refusal, not a Fusion configuration error: the panel is
        // well-formed and the run simply has no room left for it. Typed so the journal
        // names the axis and says the answers already received are kept.
        throw new WorkflowInvocationCapError(
          maxTotalAgentInvocations ?? 0,
          `fusion needs up to ${count} agent invocation(s), but only ${left} remain in this run`,
        );
      }
      reserved += count;
      return { remaining: count, active: true };
    },
    consumeReservation(reservation) {
      if (!reservation.active || reservation.remaining < 1) {
        throw new WorkflowInvocationCapError(maxTotalAgentInvocations ?? 0);
      }
      reservation.remaining -= 1;
      reserved -= 1;
    },
    releaseReservation(reservation) {
      if (!reservation.active) return;
      reserved -= reservation.remaining;
      reservation.remaining = 0;
      reservation.active = false;
    },
    remainingAgentInvocations: () => remaining(),
    spendInvocation(kind) {
      if (kind === "replayed") {
        replayedCount += 1;
        sequence += 1;
        return sequence;
      }
      // Checked BEFORE the child starts, so the call that would breach the cap never
      // runs and everything already received stays exactly as it was.
      if (maxTotalAgentInvocations !== undefined && charged + reserved >= maxTotalAgentInvocations) {
        throw new WorkflowInvocationCapError(maxTotalAgentInvocations);
      }
      charged += 1;
      sequence += 1;
      return sequence;
    },
    invocationCounts: () => ({ fresh: charged, replayed: replayedCount }),
    assertDeadline() {
      if (deadline === undefined || started === undefined) return;
      const current = nowMs();
      if (current > deadline) throw new WorkflowRunDeadlineError(input.runtimeMs!, current - started);
    },
    acquireAgent: () => gate.acquire(),
    releaseAgent: () => gate.release(),
    peakAgentConcurrency: () => gate.peak(),
  };
}

function resolveMaxTotalAgentInvocations(maxTotalAgentInvocations: number | undefined): number | undefined {
  if (maxTotalAgentInvocations === undefined) return undefined;
  if (!Number.isInteger(maxTotalAgentInvocations) || maxTotalAgentInvocations < 1) {
    throw new Error("maxTotalAgentInvocations must be a positive integer when provided");
  }
  return maxTotalAgentInvocations;
}
