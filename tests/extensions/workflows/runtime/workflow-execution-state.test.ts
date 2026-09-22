import { describe, expect, it } from "vitest";
import {
  WorkflowInvocationCapError,
  WorkflowRunDeadlineError,
  createWorkflowSharedExecutionState,
} from "../../../../extensions/workflows/runtime/workflow-execution-state.js";
import {
  DEFAULT_WORKFLOW_CONCURRENCY,
  resolveWorkflowBudget,
} from "../../../../extensions/workflows/runtime/workflow-budget.js";

/**
 * The run-level budget seen from its own owner. The DSL-level behaviour of these axes is
 * covered by `workflow-budget.test.ts` through real scripts; what is asserted here is what
 * only this object can answer — that the gate queues rather than refuses, that its peak is
 * measured on EXECUTION rather than demand, and that a deadline that passes while a permit
 * is held is still the queued caller's refusal.
 */
describe("the run's one execution state", () => {
  it("queues past the width, releases in order, and reports the executing peak", async () => {
    const state = createWorkflowSharedExecutionState({ maxConcurrentAgents: 2 });
    const entered: number[] = [];

    await state.acquireAgent();
    await state.acquireAgent();
    expect(state.peakAgentConcurrency()).toBe(2);

    const third = state.acquireAgent().then(() => entered.push(3));
    const fourth = state.acquireAgent().then(() => entered.push(4));
    // Both are queued: the width is full, so neither has entered and the peak is unmoved.
    await Promise.resolve();
    expect(entered).toEqual([]);
    expect(state.peakAgentConcurrency()).toBe(2);

    state.releaseAgent();
    await third;
    state.releaseAgent();
    await fourth;
    expect(entered).toEqual([3, 4]);
    expect(state.peakAgentConcurrency()).toBe(2);

    state.releaseAgent();
    state.releaseAgent();
  });

  it("defaults the width to the package concurrency and refuses a width below one", () => {
    expect(createWorkflowSharedExecutionState({}).concurrency).toBe(DEFAULT_WORKFLOW_CONCURRENCY);
    expect(() => createWorkflowSharedExecutionState({ maxConcurrentAgents: 0 })).toThrow(
      "maxConcurrentAgents must be a positive integer when provided",
    );
  });

  it("refuses a caller that acquired its permit before the deadline passed", async () => {
    let now = 1_000;
    const state = createWorkflowSharedExecutionState({
      maxConcurrentAgents: 1,
      runtimeMs: 50,
      nowMs: () => now,
    });

    await state.acquireAgent();
    const queued = state.acquireAgent();
    now += 500;
    state.releaseAgent();
    await queued;
    // The permit is held, and the wall clock is still what decides: a call that waited out
    // the deadline is refused with the run-level error rather than started.
    expect(() => state.assertDeadline()).toThrow(WorkflowRunDeadlineError);
    state.releaseAgent();
  });

  it("charges fresh attempts against the cap and numbers replayed ones without charging them", () => {
    const state = createWorkflowSharedExecutionState({ maxTotalAgentInvocations: 2 });
    expect(state.spendInvocation("replayed")).toBe(1);
    expect(state.spendInvocation("fresh")).toBe(2);
    expect(state.spendInvocation("fresh")).toBe(3);
    expect(state.invocationCounts()).toEqual({ fresh: 2, replayed: 1 });
    expect(state.remainingAgentInvocations()).toBe(0);
    expect(() => state.spendInvocation("fresh")).toThrow(WorkflowInvocationCapError);
    // A replayed attempt projects a recorded answer, so an exhausted cap never refuses one.
    expect(state.spendInvocation("replayed")).toBe(4);
  });

  it("allows 10,000 fresh headless attempts, excludes replay and refuses attempt 10,001", () => {
    const budget = resolveWorkflowBudget(undefined, true).budget;
    const state = createWorkflowSharedExecutionState({ maxTotalAgentInvocations: budget.totalAgents! });
    for (let i = 0; i < 10_000; i++) {
      state.spendInvocation("replayed");
      state.spendInvocation("fresh");
    }
    expect(state.invocationCounts()).toEqual({ fresh: 10_000, replayed: 10_000 });
    expect(() => state.spendInvocation("fresh")).toThrow(WorkflowInvocationCapError);
    expect(state.spendInvocation("replayed")).toBe(20_001);
    expect(state.invocationCounts()).toEqual({ fresh: 10_000, replayed: 10_001 });
  });

  it("leaves both stop axes unbounded when nobody declared them", () => {
    const state = createWorkflowSharedExecutionState({});
    expect(state.maxTotalAgentInvocations).toBeUndefined();
    expect(state.runtimeMs).toBeUndefined();
    expect(state.remainingAgentInvocations()).toBeUndefined();
    expect(() => state.assertDeadline()).not.toThrow();
  });
});
