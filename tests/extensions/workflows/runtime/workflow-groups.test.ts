import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { runScheduled } from "../../../../extensions/workflows/runtime/workflow-groups.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  resetWorkflowLiveExecutions,
  workflowAgentLiveRowId,
} from "../../../../extensions/workflows/runtime/workflow-live.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { completed, tempRun, temporary } from "../../../fixtures/scripted-agent-runtime.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The group scheduler seen from its own owner. What `parallel()`/`pipeline()` DO with it —
 * barriers, ordered slots, partial values — is covered by `workflow-group-failure.test.ts`
 * through real scripts. What is asserted here is the one property that makes the two bounds
 * in this runtime safe to hold at once: this pool is PER CALL, so a nested call opens its own
 * and never competes for the outer one's slots.
 */
describe("the per-group scheduler", () => {
  it("bounds simultaneous thunks to the width of THIS call and keeps result order", async () => {
    let live = 0;
    let peak = 0;
    const finished: number[] = [];
    const thunks = Array.from({ length: 7 }, (_value, index) => async () => {
      live += 1;
      if (live > peak) peak = live;
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      finished.push(index);
      return index * 10;
    });

    const out = await runScheduled(thunks, 2);

    expect(peak).toBe(2);
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect([...finished].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("gives a nested call its own pool instead of queueing it behind the outer one", async () => {
    // A width of 1 outside and a width of 1 inside: a single shared pool would deadlock
    // here, which is exactly why the run's leaf gate is a separate object.
    const seen: string[] = [];
    const out = await runScheduled(
      [
        async () => {
          seen.push("outer");
          const [inner] = await runScheduled([async () => "inner"], 1);
          seen.push(inner!);
          return inner;
        },
      ],
      1,
    );

    expect(out).toEqual(["inner"]);
    expect(seen).toEqual(["outer", "inner"]);
  });

  it("never starts more workers than it has thunks", async () => {
    let started = 0;
    const out = await runScheduled(
      [
        async () => {
          started += 1;
          return "only";
        },
      ],
      8,
    );
    expect(started).toBe(1);
    expect(out).toEqual(["only"]);
    expect(await runScheduled<number>([], 4)).toEqual([]);
  });
});

/**
 * The same scheduler reached through `dsl.parallel()`, with a scripted child behind it:
 * input order, the run-wide leaf gate that the per-call width sits under, branch-local
 * phase, and the business-key path a group writes onto every member event. Fake child
 * sessions, not live Pi/model proof.
 */
describe("groups through the DSL", () => {
  it("parallel keeps input order, while completion order remains independent", async () => {
    const finish: number[] = [];
    const runtime = createWorkflowRuntime({
      runId: "ordering",
      agentRunner: async (req) => {
        const n = Number(req.prompt);
        await delay((3 - n) * 8);
        finish.push(n);
        return completed(req, `${n}`);
      },
    });
    const values = await runtime.dsl.parallel(
      [0, 1, 2, 3].map((n) => () => runtime.dsl.agent(`${n}`, { label: `unit-${n}` })),
    );
    assert.deepEqual(values, ["0", "1", "2", "3"]);
    assert.deepEqual(finish, [3, 2, 1, 0]);
  });
  it("parallel local concurrency actually narrows execution and malformed options fail before calls", async () => {
    let active = 0,
      peak = 0,
      calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "local-width",
      maxConcurrentAgents: 8,
      agentRunner: async (req) => {
        calls += 1;
        peak = Math.max(peak, ++active);
        await delay(2);
        active -= 1;
        return completed(req, "done");
      },
    });
    await runtime.dsl.parallel(
      [0, 1, 2, 3].map((n) => () => runtime.dsl.agent(`${n}`)),
      { concurrency: 1, title: "Business units", keys: ["a", "b", "c", "d"] },
    );
    assert.equal(peak, 1);
    assert.equal(calls, 4);
    assert.equal(runtime.getJournal().find((line) => line.kind === "group_start")?.groupLabel, "Business units");
    for (const opts of [
      { concurrency: 0 },
      { concurrency: 1.5 },
      { keys: ["a", "a"] },
      { keys: ["a"] },
      { bogus: true },
    ]) {
      await assert.rejects(
        runtime.dsl.parallel([() => runtime.dsl.agent("x"), () => runtime.dsl.agent("y")], opts as never),
      );
    }
    assert.equal(calls, 4);
  });
  it("nested groups retain one global leaf gate and full business-key paths", async () => {
    let active = 0,
      peak = 0;
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId: "nested",
      maxConcurrentAgents: 2,
      agentRunner: async (req) => {
        requests.push(req);
        peak = Math.max(peak, ++active);
        await delay(2);
        active -= 1;
        return completed(req, "done");
      },
    });
    await runtime.dsl.parallel(
      ["a", "b"].map(
        (candidate) => () =>
          runtime.dsl.parallel(
            ["id", "schedule"].map(
              (field) => () =>
                runtime.dsl.agent(`${candidate}:${field}`, {
                  label: "extract",
                  title: `${candidate} · ${field}`,
                }),
            ),
            { keys: ["id", "schedule"], concurrency: 4 },
          ),
      ),
      { keys: ["a", "b"], concurrency: 4 },
    );
    assert.equal(peak, 2);
    assert.deepEqual(
      requests.map((req) => req.itemPath),
      [
        ["a", "id"],
        ["a", "schedule"],
        ["b", "id"],
        ["b", "schedule"],
      ],
    );
    assert.deepEqual(
      requests.map((req) => req.title),
      ["a · id", "a · schedule", "b · id", "b · schedule"],
    );
  });
  it("phase is branch-local rather than the last sibling to mutate a global", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId: "phases",
      agentRunner: async (req) => {
        requests.push(req);
        return completed(req, "done");
      },
    });
    runtime.dsl.phase("root");
    await runtime.dsl.parallel([
      async () => {
        runtime.dsl.phase("A");
        await delay(5);
        return runtime.dsl.agent("A");
      },
      async () => {
        runtime.dsl.phase("B");
        return runtime.dsl.agent("B");
      },
    ]);
    await runtime.dsl.agent("root");
    assert.deepEqual(
      requests.map((req) => [req.prompt, req.phase]),
      [
        ["B", "B"],
        ["A", "A"],
        ["root", "root"],
      ],
    );
  });
  it("queued is not started: actual starts respect the leaf gate and live projection", async () => {
    agentLiveStore.reset();
    resetWorkflowLiveExecutions();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createWorkflowRuntime({
      runId: "admission",
      maxConcurrentAgents: 1,
      agentRunner: async (req) => {
        if (req.prompt === "first") await held;
        return completed(req, "done");
      },
    });
    // Explicit group width of 2 against a leaf gate of 1, so both calls enter the
    // runtime and the second waits at the GATE — the state this test is about. The
    // group pool otherwise inherits the run's single effective concurrency and would
    // admit them one at a time, leaving nothing queued.
    const running = runtime.dsl.parallel(
      [() => runtime.dsl.agent("first", { title: "First" }), () => runtime.dsl.agent("second", { title: "Second" })],
      { concurrency: 2 },
    );
    await delay(5);
    const lines = runtime.getJournal();
    assert.equal(lines.filter((line) => line.kind === "agent_queued").length, 2);
    assert.equal(lines.filter((line) => line.kind === "agent_start").length, 1);
    const queued = lines.filter((line) => line.kind === "agent_queued")[1]!;
    applyWorkflowJournalLineToAgentLiveStore(queued);
    const row = agentLiveStore.rows.get(workflowAgentLiveRowId(queued));
    assert.equal(row?.status, "queued");
    assert.equal(row?.title, "Second");
    release();
    await running;
    for (const line of runtime
      .getJournal()
      .filter((entry) => entry.callId === queued.callId && entry.kind === "agent_start"))
      applyWorkflowJournalLineToAgentLiveStore(line);
    assert.equal(agentLiveStore.rows.get(workflowAgentLiveRowId(queued))?.status, "working");
    agentLiveStore.reset();
    resetWorkflowLiveExecutions();
  });
  it("new queue, title, item and decision events round-trip through the strict persisted journal", async () =>
    temporary(async (root) => {
      const id = "journal";
      tempRun(root, id);
      const sink = createWorkflowJournalSink(root, id);
      const runtime = createWorkflowRuntime({
        runId: id,
        journal: sink,
        agentRunner: async (req) => ({
          ...completed(req, '"complete"'),
          ...(req.returnContract === undefined
            ? {}
            : { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }),
        }),
      });
      await runtime.dsl.parallel(
        [() => runtime.dsl.agent("route", { label: "route", title: "Decision", choice: ["complete", "continue"] })],
        { keys: ["unit"], title: "Units" },
      );
      const state = readWorkflowRunJournalState(root, id);
      assert.deepEqual(state.diagnostics, []);
      assert.equal(state.lines.length, runtime.getJournal().length);
      assert.equal(state.lines.find((line) => line.choiceDecision)?.choiceDecision?.source, "validated");
      assert.deepEqual(state.lines.find((line) => line.kind === "agent_start")?.itemPath, ["unit"]);
    }));
});
