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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("the run's one execution state", () => {
  it("queues past the width, releases in order, and reports the executing peak", async () => {
    const state = createWorkflowSharedExecutionState({ maxConcurrentAgents: 2 });
    const gates = Array.from({ length: 4 }, deferred);
    const entered: number[] = [];
    const jobs = gates.map((gate, index) =>
      state.createInvocation("fresh").run(async () => {
        entered.push(index);
        await gate.promise;
      }),
    );
    await Promise.resolve();
    expect(entered).toEqual([0, 1]);
    expect(state.invocationCounts()).toEqual({ fresh: 2, replayed: 0 });
    expect(state.peakAgentConcurrency()).toBe(2);
    gates[0]!.resolve();
    await jobs[0];
    gates[1]!.resolve();
    await jobs[1];
    expect(entered).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve();
    gates[3]!.resolve();
    await Promise.all(jobs);
    expect(state.activeAgentConcurrency()).toBe(0);
    expect(state.peakAgentConcurrency()).toBe(2);
  });

  it("defaults the width and refuses a width below one", () => {
    expect(createWorkflowSharedExecutionState({}).concurrency).toBe(DEFAULT_WORKFLOW_CONCURRENCY);
    expect(() => createWorkflowSharedExecutionState({ maxConcurrentAgents: 0 })).toThrow(
      "maxConcurrentAgents must be a positive integer when provided",
    );
  });

  it("does not charge or start an invocation whose deadline passed in the queue", async () => {
    let now = 1_000;
    const state = createWorkflowSharedExecutionState({ maxConcurrentAgents: 1, runtimeMs: 50, nowMs: () => now });
    const gate = deferred();
    const first = state.createInvocation("fresh").run(async () => gate.promise);
    let started = false;
    const second = state.createInvocation("fresh").run(async () => {
      started = true;
    });
    const refusal = expect(second).rejects.toBeInstanceOf(WorkflowRunDeadlineError);
    await Promise.resolve();
    now += 500;
    gate.resolve();
    await first;
    await refusal;
    expect(started).toBe(false);
    expect(state.invocationCounts()).toEqual({ fresh: 1, replayed: 0 });
    expect(state.activeAgentConcurrency()).toBe(0);
  });

  it("charges fresh launches while replay allocates evidence identity without work", async () => {
    const state = createWorkflowSharedExecutionState({ maxTotalAgentInvocations: 2 });
    expect(state.createInvocation("replayed").identity.sequence).toBe(1);
    const first = state.createInvocation("fresh");
    expect(first.identity.sequence).toBe(2);
    await first.run(async () => undefined);
    await state.createInvocation("fresh").run(async () => undefined);
    expect(state.invocationCounts()).toEqual({ fresh: 2, replayed: 1 });
    expect(state.remainingAgentInvocations()).toBe(0);
    await expect(state.createInvocation("fresh").run(async () => undefined)).rejects.toBeInstanceOf(
      WorkflowInvocationCapError,
    );
    expect(state.createInvocation("replayed").identity.sequence).toBe(5);
  });

  it("allows 10,000 fresh headless launches and refuses launch 10,001", async () => {
    const budget = resolveWorkflowBudget(undefined, true).budget;
    const state = createWorkflowSharedExecutionState({ maxTotalAgentInvocations: budget.totalAgents! });
    for (let i = 0; i < 10_000; i++) {
      state.createInvocation("replayed");
      await state.createInvocation("fresh").run(async () => undefined);
    }
    await expect(state.createInvocation("fresh").run(async () => undefined)).rejects.toBeInstanceOf(
      WorkflowInvocationCapError,
    );
    expect(state.invocationCounts()).toEqual({ fresh: 10_000, replayed: 10_000 });
    expect(state.createInvocation("replayed").identity.sequence).toBe(20_002);
  });

  it("leaves both stop axes unbounded when nobody declared them", () => {
    const state = createWorkflowSharedExecutionState({});
    expect(state.maxTotalAgentInvocations).toBeUndefined();
    expect(state.runtimeMs).toBeUndefined();
    expect(state.remainingAgentInvocations()).toBeUndefined();
    expect(() => state.assertDeadline()).not.toThrow();
  });
});
