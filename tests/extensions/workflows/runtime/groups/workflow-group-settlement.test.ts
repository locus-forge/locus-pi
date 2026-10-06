import { describe, expect, it } from "vitest";
import { runScheduled } from "../../../../../extensions/workflows/runtime/workflow-groups.js";
import {
  createWorkflowRuntime,
  WorkflowGroupFailureError,
  WorkflowInvocationCapError,
  WorkflowRunDeadlineError,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import { completed } from "../../../../fixtures/scripted-agent-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function observe(promise: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  const done = promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return { state, done };
}

describe("group stop-dispatch and settlement", () => {
  it.each([new Error("first failure"), undefined])(
    "drains started workers and preserves the first rejection (%s)",
    async (error) => {
      const held = deferred();
      let late = false;
      const run = observe(
        runScheduled(
          [
            async () => {
              await held.promise;
              throw new Error("later sibling failure");
            },
            async () => {
              throw error;
            },
            async () => {
              late = true;
              return "late";
            },
          ],
          2,
        ),
      );
      try {
        await tick();
        expect(run.state.settled).toBe(false);
        expect(late).toBe(false);
      } finally {
        held.resolve();
        await run.done;
      }
      expect(run.state.error).toBe(error);
      expect(late).toBe(false);
    },
  );

  it.each(["parallel", "pipeline"] as const)(
    "drains %s on a hard cap or deadline before ending the group",
    async (kind) => {
      for (const axis of ["cap", "deadline"] as const) {
        const held = deferred(),
          started = deferred();
        let clock = 0,
          late = false;
        const runtime = createWorkflowRuntime({
          runId: `${kind}-${axis}`,
          maxConcurrentAgents: 2,
          ...(axis === "cap" ? { maxTotalAgentInvocations: 1 } : { runtimeMs: 10, nowMs: () => clock }),
          agentRunner: async (request) => {
            started.resolve();
            await held.promise;
            return completed(request, "done");
          },
        });
        const branches = [
          () => runtime.dsl.agent("held"),
          async () => {
            await started.promise;
            clock = 11;
            return runtime.dsl.agent("refused");
          },
          async () => {
            late = true;
            return "late";
          },
        ];
        const run = observe(
          kind === "parallel"
            ? runtime.dsl.parallel(branches)
            : runtime.dsl.pipeline(
                [0, 1, 2],
                async (index) => branches[Number(index)]!(),
                async () => {
                  late = true;
                  return "late stage";
                },
              ),
        );
        try {
          await started.promise;
          await tick();
          expect(run.state.settled).toBe(false);
          expect(runtime.getJournal().some((line) => line.kind === "group_end")).toBe(false);
          expect(late).toBe(false);
        } finally {
          held.resolve();
          await run.done;
        }
        expect(run.state.error).toBeInstanceOf(axis === "cap" ? WorkflowInvocationCapError : WorkflowRunDeadlineError);
        expect(late).toBe(false);
        const journal = runtime.getJournal();
        expect(journal.filter((line) => line.kind === "agent_start")).toHaveLength(1);
        expect(journal.at(-1)).toMatchObject({ kind: "group_end", status: "failed" });
        expect(journal.findIndex((line) => line.kind === "agent_end")).toBeLessThan(
          journal.findIndex((line) => line.kind === "group_end"),
        );
      }
    },
  );

  it("propagates nested hard stops before the inner drain ends", async () => {
    const held = deferred(),
      outerSibling = deferred(),
      started = deferred();
    let late = false;
    const runtime = createWorkflowRuntime({
      runId: "nested-stop",
      maxConcurrentAgents: 2,
      maxTotalAgentInvocations: 1,
      agentRunner: async (request) => {
        started.resolve();
        await held.promise;
        return completed(request, "done");
      },
    });
    const run = observe(
      runtime.dsl.parallel([
        () =>
          runtime.dsl.parallel([
            () => runtime.dsl.agent("held"),
            async () => {
              await started.promise;
              return runtime.dsl.agent("refused");
            },
            async () => {
              late = true;
              return "late";
            },
          ]),
        async () => {
          await outerSibling.promise;
          throw new WorkflowRunDeadlineError(10, 11);
        },
        async () => {
          late = true;
          return [];
        },
      ]),
    );
    try {
      await started.promise;
      await tick();
      outerSibling.resolve();
      await tick();
      expect(late).toBe(false);
      expect(run.state.settled).toBe(false);
      expect(runtime.getJournal().some((line) => line.kind === "group_end")).toBe(false);
    } finally {
      outerSibling.resolve();
      held.resolve();
      await run.done;
    }
    expect(run.state.error).toBeInstanceOf(WorkflowInvocationCapError);
    expect(late).toBe(false);
    const events = runtime.getJournal();
    const agentEnd = events.findIndex((line) => line.kind === "agent_end");
    expect(events.filter((line, index) => line.kind === "group_end" && index > agentEnd)).toHaveLength(2);
  });

  it("stops queued branches on cancellation while delayed active siblings settle", async () => {
    const first = deferred(),
      second = deferred();
    const controller = new AbortController();
    const reason = new Error("operator stopped");
    let late = false;
    const runtime = createWorkflowRuntime({
      runId: "cancel",
      signal: controller.signal,
      maxConcurrentAgents: 2,
      agentRunner: async (request) => completed(request, "done"),
    });
    const run = observe(
      runtime.dsl.parallel([
        async () => {
          await first.promise;
          return "first";
        },
        async () => {
          await second.promise;
          return "second";
        },
        async () => {
          late = true;
          return "late";
        },
      ]),
    );
    try {
      controller.abort(reason);
      first.resolve();
      await tick();
      expect(run.state.settled).toBe(false);
      expect(late).toBe(false);
      expect(runtime.getJournal().some((line) => line.kind === "group_end")).toBe(false);
    } finally {
      first.resolve();
      second.resolve();
      await run.done;
    }
    expect(run.state.error).toBe(reason);
    expect(late).toBe(false);
    expect(runtime.getJournal().at(-1)).toMatchObject({ kind: "group_end", status: "failed" });
  });

  it("refuses pre-cancelled dispatch and stages after an in-flight cancellation", async () => {
    const controller = new AbortController();
    let stages = 0;
    const runtime = createWorkflowRuntime({
      runId: "cancel-stages",
      signal: controller.signal,
      agentRunner: async (request) => completed(request, "done"),
    });
    const reason = new Error("cancelled between stages");
    await expect(
      runtime.dsl.pipeline(
        [0],
        async () => {
          controller.abort(reason);
          await Promise.resolve();
          return 1;
        },
        async () => {
          stages++;
          return 2;
        },
      ),
    ).rejects.toBe(reason);
    await expect(
      runtime.dsl.parallel([
        async () => {
          stages++;
        },
      ]),
    ).rejects.toBe(reason);
    expect(stages).toBe(0);
  });

  it("continues queued ordinary failures and records the explicit phase of each branch", async () => {
    const runtime = createWorkflowRuntime({
      runId: "failure-phases",
      maxConcurrentAgents: 2,
      agentRunner: async (request) => completed(request, "done"),
    });
    runtime.dsl.phase("root");
    let queued = false;
    await expect(
      runtime.dsl.parallel<unknown>([
        async () => {
          runtime.dsl.phase("thrown");
          await tick();
          throw new Error("thrown problem");
        },
        async () => {
          runtime.dsl.phase("returned");
          await Promise.resolve();
          return { ok: false, summary: "returned problem" };
        },
        async () => {
          queued = true;
          return "done";
        },
      ]),
    ).rejects.toBeInstanceOf(WorkflowGroupFailureError);
    expect(queued).toBe(true);
    await expect(
      runtime.dsl.pipeline([0], async () => {
        runtime.dsl.phase("pipeline phase");
        await Promise.resolve();
        throw new Error("pipeline problem");
      }),
    ).rejects.toBeInstanceOf(WorkflowGroupFailureError);
    await expect(
      runtime.dsl.parallel([
        async () => {
          runtime.dsl.phase("outer phase");
          return runtime.dsl.parallel([
            async () => {
              runtime.dsl.phase("inner phase");
              await Promise.resolve();
              return { ok: false, summary: "inner problem" };
            },
          ]);
        },
      ]),
    ).rejects.toBeInstanceOf(WorkflowGroupFailureError);
    const failures = runtime.getJournal().filter((line) => line.kind === "error");
    expect(failures.map((line) => [line.message, line.phase])).toEqual([
      ["returned problem", "returned"],
      ["thrown problem", "thrown"],
      ["pipeline problem", "pipeline phase"],
      ["inner problem", "inner phase"],
      [expect.stringContaining("inner problem"), "outer phase"],
    ]);
    expect(runtime.currentPhase()).toBe("root");
  });
});
