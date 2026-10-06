import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowSharedExecutionState } from "../../../../extensions/workflows/runtime/workflow-execution-state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const completed = (): WorkflowAgentResult => ({
  ok: true,
  status: "completed",
  summary: "done",
  text: "answer",
  diagnostics: [],
});

describe("workflow physical admission through the shared owner", () => {
  it("does not charge queued work before its runner starts", async () => {
    const sharedExecution = createWorkflowSharedExecutionState({ maxConcurrentAgents: 1 });
    const entered = deferred();
    const finish = deferred();
    let launches = 0;
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "queued-charge",
      sharedExecution,
      agentRunner: async () => {
        launches++;
        entered.resolve();
        await finish.promise;
        return completed();
      },
    });
    const first = dsl.agent("first");
    const second = dsl.agent("second");
    await entered.promise;
    const countsWhileQueued = sharedExecution.invocationCounts();
    finish.resolve();
    await Promise.all([first, second]);
    expect(countsWhileQueued).toEqual({ fresh: 1, replayed: 0 });
    expect(launches).toBe(2);
    expect(sharedExecution.invocationCounts().fresh).toBe(2);
    expect(
      getJournal()
        .filter((line) => line.kind === "agent_start")
        .map((line) => line.callId),
    ).toEqual(["call-0001", "call-0002"]);
  });

  it("keeps a deadline-refused queued attempt's identity without charging it", async () => {
    let now = 0;
    const sharedExecution = createWorkflowSharedExecutionState({
      maxConcurrentAgents: 1,
      runtimeMs: 10,
      nowMs: () => now,
    });
    const entered = deferred();
    const finish = deferred();
    let launches = 0;
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "queued-deadline",
      sharedExecution,
      agentRunner: async () => {
        launches++;
        entered.resolve();
        await finish.promise;
        return completed();
      },
    });
    const first = dsl.agent("first");
    const second = dsl.agent("second");
    const results = Promise.allSettled([first, second]);
    await entered.promise;
    now = 11;
    finish.resolve();
    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(launches).toBe(1);
    expect(sharedExecution.invocationCounts()).toEqual({ fresh: 1, replayed: 0 });
    expect(getJournal()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent_queued", callId: "call-0002" }),
        expect.objectContaining({ kind: "error", callId: "call-0002" }),
        expect.objectContaining({ kind: "log", message: expect.stringContaining("stopped by budget runtimeMs") }),
      ]),
    );
  });

  it("cancels queued work without starting a child or losing terminal evidence", async () => {
    const controller = new AbortController();
    const sharedExecution = createWorkflowSharedExecutionState({
      maxConcurrentAgents: 1,
      ...{ signal: controller.signal },
    });
    const entered = deferred();
    const finish = deferred();
    let launches = 0;
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "queued-cancel",
      sharedExecution,
      agentRunner: async () => {
        launches++;
        entered.resolve();
        await finish.promise;
        return completed();
      },
    });
    const results = Promise.allSettled([dsl.agent("first"), dsl.agent("second")]);
    await entered.promise;
    controller.abort(new Error("root cancelled"));
    finish.resolve();
    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(launches).toBe(1);
    expect(sharedExecution.invocationCounts().fresh).toBe(1);
    expect(getJournal()).toContainEqual(
      expect.objectContaining({ kind: "error", callId: "call-0002", message: "root cancelled" }),
    );
  });
});
