/**
 * One execution owner shared by agent and workflow adapters. Identities are allocated
 * before queueing; fresh work is charged once, immediately before its callback starts.
 * An executing parent can yield its permit only through a scope owned by this same
 * root. That scope drains every admitted descendant before the parent may resume.
 * This internal primitive does not itself enable a new tool or grant permissions.
 */
import { createExecutionBudget, type ExecutionBudgetOptions, type ExecutionReservation } from "./execution-budget.js";
import { createExecutionScheduler, executionAbortReason, type ExecutionPermit } from "./execution-scheduler.js";

export type { ExecutionReservation } from "./execution-budget.js";
export interface ExecutionIdentity {
  readonly sequence: number;
  readonly parentSequence?: number;
}
export interface ExecutionInvocation {
  readonly identity: ExecutionIdentity;
  /** A fresh invocation can run once. Replay projects evidence and cannot launch work. */
  run<T>(work: (lease: ExecutionLease) => Promise<T>): Promise<T>;
}
export interface ExecutionScope {
  createInvocation(kind: "fresh" | "replayed", reservation?: ExecutionReservation): ExecutionInvocation;
}
export interface ExecutionLease {
  readonly identity: ExecutionIdentity;
  readonly signal: AbortSignal;
  /** Only one scope at a time. A descendant throw is fatal to this launch, even if detached. */
  withChildren<T>(work: (scope: ExecutionScope) => Promise<T>): Promise<T>;
}
export interface ExecutionState extends ExecutionScope {
  readonly signal: AbortSignal;
  reserve(count: number): ExecutionReservation;
  releaseReservation(reservation: ExecutionReservation): void;
  remainingAgentInvocations(): number | undefined;
  invocationCounts(): { fresh: number; replayed: number };
  assertDeadline(): void;
  peakAgentConcurrency(): number;
  activeAgentConcurrency(): number;
  /** Abort and join every started callback. Cancellation never frees a running slot early. */
  close(reason?: unknown): Promise<void>;
}

export function createExecutionState(
  options: ExecutionBudgetOptions & { concurrency: number; signal?: AbortSignal },
): ExecutionState {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    throw new Error("concurrency must be a positive safe integer");
  const budget = createExecutionBudget(options);
  const scheduler = createExecutionScheduler(options.concurrency);
  const controller = new AbortController();
  const signal =
    options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  const rootJobs = new Set<Promise<unknown>>();
  let closed = false;

  interface ScopeState {
    signal: AbortSignal;
    parentSequence?: number;
    jobs: Set<Promise<unknown>>;
    closed: boolean;
    failure?: { error: unknown };
    stop?: AbortController;
  }
  const root: ScopeState = { signal, jobs: rootJobs, closed: false };
  function failScope(scope: ScopeState, error: unknown): void {
    if (scope.failure !== undefined) return;
    scope.failure = { error };
    scope.stop?.abort(error);
  }
  function assertLive(scope: ScopeState): void {
    if (scope.signal.aborted) throw executionAbortReason(scope.signal);
    if (closed) throw new Error("execution scope has already closed");
  }
  function assertOpen(scope: ScopeState): void {
    assertLive(scope);
    if (scope.closed) throw new Error("execution scope has already closed");
  }
  function createInvocation(
    scope: ScopeState,
    kind: "fresh" | "replayed",
    reservation?: ExecutionReservation,
  ): ExecutionInvocation {
    assertOpen(scope);
    const identity: ExecutionIdentity = Object.freeze({
      sequence: budget.allocate(kind, reservation),
      ...(scope.parentSequence === undefined ? {} : { parentSequence: scope.parentSequence }),
    });
    let used = false;
    return Object.freeze({
      identity,
      run<T>(work: (lease: ExecutionLease) => Promise<T>): Promise<T> {
        if (kind === "replayed") return Promise.reject(new Error("a replayed invocation cannot launch agent work"));
        if (used) return Promise.reject(new Error("an execution invocation can start only once"));
        used = true;
        const job = execute(scope, identity, reservation, work);
        scope.jobs.add(job);
        // Observe rejection immediately, including detached branches; the owning scope
        // still receives the original promise and joins it before returning.
        void job.then(
          () => {
            scope.jobs.delete(job);
          },
          (error: unknown) => {
            scope.jobs.delete(job);
            failScope(scope, error);
          },
        );
        return job;
      },
    });
  }
  async function execute<T>(
    scope: ScopeState,
    identity: ExecutionIdentity,
    reservation: ExecutionReservation | undefined,
    work: (lease: ExecutionLease) => Promise<T>,
  ): Promise<T> {
    assertOpen(scope);
    budget.assertDeadline();
    let permit: ExecutionPermit | undefined = await scheduler.acquire(scope.signal);
    const stop = new AbortController();
    const activeScope = { ...scope, signal: AbortSignal.any([scope.signal, stop.signal]) };
    const resumeStop = new AbortController();
    let accepting = true;
    let delegation: Promise<unknown> | undefined;
    let delegationFailure: { error: unknown } | undefined;
    try {
      assertLive(scope);
      budget.assertDeadline();
      budget.charge(reservation);
      permit.activate();
      const lease: ExecutionLease = Object.freeze({
        identity,
        signal: activeScope.signal,
        withChildren<U>(childWork: (children: ExecutionScope) => Promise<U>): Promise<U> {
          if (!accepting || delegation !== undefined)
            return Promise.reject(new Error("agent already finished or is awaiting descendants"));
          assertLive(activeScope);
          permit!.release();
          permit = undefined;
          const waiting = delegate(activeScope, identity, childWork).finally(async () => {
            // Re-entry is concurrency admission, not another physical launch charge.
            if (accepting) {
              assertLive(activeScope);
              try {
                permit = await scheduler.acquire(AbortSignal.any([activeScope.signal, resumeStop.signal]));
                if (accepting && !activeScope.signal.aborted && !resumeStop.signal.aborted) permit.activate();
                else {
                  permit.release();
                  permit = undefined;
                  if (activeScope.signal.aborted) throw executionAbortReason(activeScope.signal);
                }
              } catch (error) {
                // A completed callback needs no slot. Cancel only its obsolete
                // re-entry; descendants still own their independent cleanup signal.
                if (!resumeStop.signal.aborted || activeScope.signal.aborted) throw error;
              }
            }
          });
          delegation = waiting;
          void waiting.catch((error: unknown) => {
            delegationFailure ??= { error };
          });
          void waiting
            .finally(() => {
              if (delegation === waiting) delegation = undefined;
            })
            .catch(() => undefined);
          return waiting;
        },
      });
      const result = await work(lease);
      accepting = false;
      resumeStop.abort(new Error("agent callback already returned"));
      // A caller cannot escape ownership by forgetting to await withChildren().
      if (delegation !== undefined) await delegation;
      if (delegationFailure !== undefined) throw delegationFailure.error;
      return result;
    } catch (error) {
      accepting = false;
      // Stop queued siblings before this invocation releases its slot.
      failScope(scope, error);
      stop.abort(error);
      if (delegation !== undefined) await Promise.allSettled([delegation]);
      throw error;
    } finally {
      accepting = false;
      permit?.release();
    }
  }
  async function delegate<T>(
    parent: ScopeState,
    identity: ExecutionIdentity,
    work: (scope: ExecutionScope) => Promise<T>,
  ): Promise<T> {
    const stop = new AbortController();
    const child: ScopeState = {
      signal: AbortSignal.any([parent.signal, stop.signal]),
      parentSequence: identity.sequence,
      stop,
      jobs: new Set(),
      closed: false,
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        value: await work({ createInvocation: (kind, reservation) => createInvocation(child, kind, reservation) }),
      };
    } catch (error) {
      outcome = { ok: false, error };
      child.failure ??= { error };
      stop.abort(child.failure.error);
    }
    child.closed = true;
    await Promise.allSettled(child.jobs);
    if (child.failure !== undefined) throw child.failure.error;
    if (!outcome.ok) throw outcome.error;
    if (child.signal.aborted) throw executionAbortReason(child.signal);
    return outcome.value;
  }
  return {
    signal,
    createInvocation: (kind, reservation) => createInvocation(root, kind, reservation),
    reserve: budget.reserve,
    releaseReservation: budget.release,
    remainingAgentInvocations: budget.remaining,
    invocationCounts: budget.counts,
    assertDeadline: budget.assertDeadline,
    peakAgentConcurrency: scheduler.peak,
    activeAgentConcurrency: scheduler.active,
    async close(reason = new Error("root execution has closed")) {
      closed = true;
      controller.abort(reason);
      await Promise.allSettled(rootJobs);
    },
  };
}
