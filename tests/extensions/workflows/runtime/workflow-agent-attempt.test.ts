import { describe, expect, it } from "vitest";
import {
  WorkflowRunDeadlineError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * The PHYSICAL half of an agent call, seen from the one thing only it owns: the leaf-agent
 * permit.
 *
 * A permit is invisible in a passing run — every case here is about an exit that is NOT a
 * returned answer. If the permit leaked on a throw, on a cancellation, or on the run
 * deadline that fires while the call is queued, the next call would wait on a slot nobody
 * holds and the run would hang rather than fail, which is the failure mode a test is
 * cheapest at catching and an operator is worst at diagnosing.
 *
 * So each case runs a width-1 run, drives one attempt into an abnormal exit, and proves
 * that a LATER call still enters. Entry is asserted through the second runner actually
 * being invoked inside a bounded wait, because a leaked permit does not fail — it waits.
 */

/** A width-1 runtime over a scripted sequence of runner behaviours. */
function attemptRuntime(
  runId: string,
  behaviours: Array<(req: WorkflowAgentRequest) => Promise<WorkflowAgentResult>>,
  options: { runtimeMs?: number; nowMs?: () => number } = {},
) {
  const requests: WorkflowAgentRequest[] = [];
  const journal: WorkflowJournalLine[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    maxConcurrentAgents: 1,
    ...(options.runtimeMs === undefined ? {} : { runtimeMs: options.runtimeMs }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    onEvent: (line) => journal.push(line),
    agentRunner: async (req) => {
      requests.push(req);
      const behaviour = behaviours[requests.length - 1];
      if (behaviour === undefined) throw new Error(`unscripted agent call ${requests.length}`);
      return behaviour(req);
    },
  });
  return { dsl: runtime.dsl, requests, journal, peak: () => runtime.peakAgentConcurrency() };
}

function completed(text: string): WorkflowAgentResult {
  return { ok: true, status: "completed", summary: "done", text, diagnostics: [] };
}

/** Resolves to `true` only if `promise` settles before the bounded wait elapses. */
async function settlesPromptly(promise: Promise<unknown>): Promise<boolean> {
  const guard = Symbol("still-waiting");
  const timer = new Promise<typeof guard>((resolve) => {
    setTimeout(() => resolve(guard), 2_000).unref?.();
  });
  const winner = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    timer,
  ]);
  return winner === "settled";
}

describe("the physical agent attempt releases its leaf permit on every exit", () => {
  it("releases it when the runner throws, so the next call still enters", async () => {
    const { dsl, requests, peak } = attemptRuntime("attempt-throw", [
      async () => {
        throw new Error("host blew up mid-turn");
      },
      async () => completed("second answer"),
    ]);

    await expect(dsl.agent("first")).rejects.toThrow(/host blew up mid-turn/u);
    // A leaked permit would make this await never resolve rather than fail.
    expect(await settlesPromptly(dsl.agent("second"))).toBe(true);
    expect(requests).toHaveLength(2);
    // One at a time throughout: the throw did not leave a phantom occupant behind.
    expect(peak()).toBe(1);
  });

  it("releases it when the child is cancelled, so the next call still enters", async () => {
    const { dsl, requests, peak } = attemptRuntime("attempt-cancel", [
      async () => ({
        ok: false,
        status: "cancelled",
        summary: "Operator cancelled the child.",
        failureCause: "cancelled",
        diagnostics: [],
      }),
      async () => completed("second answer"),
    ]);

    await expect(dsl.agent("first")).rejects.toThrow(/Operator cancelled the child/u);
    expect(await settlesPromptly(dsl.agent("second"))).toBe(true);
    expect(requests).toHaveLength(2);
    expect(peak()).toBe(1);
  });

  it("releases it when the run deadline fires while the call is queued", async () => {
    // The deadline check INSIDE the permit is the one that fires here: the first call is
    // still holding the slot when the clock passes the deadline, so the second call enters
    // the permit only to be refused — and must hand the slot back on that refusal too.
    let now = 1_000;
    let firstEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const { dsl, requests, peak } = attemptRuntime(
      "attempt-deadline",
      [
        async () => {
          firstEntered();
          await held;
          return completed("first answer");
        },
        async () => completed("never reached"),
      ],
      { runtimeMs: 50, nowMs: () => now },
    );

    const first = dsl.agent("first");
    await entered;
    const second = dsl.agent("second");
    // The second call is queued behind the width-1 gate; the clock passes while it waits.
    now += 500;
    releaseFirst();

    await expect(first).resolves.toBe("first answer");
    await expect(second).rejects.toBeInstanceOf(WorkflowRunDeadlineError);
    // The refused call never reached a child, and the slot it briefly held is back.
    expect(requests).toHaveLength(1);
    expect(peak()).toBe(1);
  });
});

describe("the physical agent attempt admits a call in one order", () => {
  it("emits agent_queued before agent_start, and agent_start only inside the permit", async () => {
    let startedBeforeRunner: boolean | undefined;
    const { dsl, journal } = attemptRuntime("attempt-admission", [
      async () => {
        // `agent_start` is emitted after the permit is taken and the deadline re-checked,
        // so by the time the runner is called both admission lines already exist.
        startedBeforeRunner = journal.filter((line) => line.kind === "agent_start").length === 1;
        return completed("answer");
      },
    ]);

    await expect(dsl.agent("only")).resolves.toBe("answer");
    expect(startedBeforeRunner).toBe(true);
    expect(
      journal
        .filter((line) => ["agent_queued", "agent_start", "agent_end"].includes(line.kind))
        .map((line) => line.kind),
    ).toEqual(["agent_queued", "agent_start", "agent_end"]);
    // One physical attempt, one identity across all three lines.
    const callIds = new Set(
      journal
        .filter((line) => ["agent_queued", "agent_start", "agent_end"].includes(line.kind))
        .map((line) => line.callId),
    );
    expect(callIds).toEqual(new Set(["call-0001"]));
  });
});
