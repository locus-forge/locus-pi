import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
  hashCanonicalRequest,
  workflowReplayFile,
  WORKFLOW_REPLAY_SCHEMA_VERSION,
  type WorkflowReplayAgentEntry,
} from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { completed, tempRun, temporary } from "../../../fixtures/scripted-agent-runtime.js";

it.each([false, true].flatMap((keyed) => [false, true].map((labelled) => ({ keyed, labelled }))))(
  "preserves admission identity across reverse completion (keyed=$keyed labelled=$labelled)",
  async ({ keyed, labelled }) =>
    temporary(async (root) => {
      let releaseFirst!: () => void;
      const firstWaiting = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let secondFinished!: () => void;
      const secondWaiting = new Promise<void>((resolve) => {
        secondFinished = resolve;
      });
      let executions = 0;
      const first = createWorkflowRuntime({
        runId: "source",
        replay: createWorkflowReplayController({ runDir: tempRun(root, "source") }),
        agentRunner: async (request) => {
          const ordinal = executions++;
          if (ordinal === 0) await firstWaiting;
          return completed(request, ordinal === 0 ? "FIRST" : "SECOND");
        },
      });
      const agentOptions = labelled ? { label: "same" } : {};
      const options = keyed ? { keys: ["first", "second"] } : {};
      const run = first.dsl.parallel(
        [
          () => first.dsl.agent("identical", agentOptions),
          async () => {
            const answer = await first.dsl.agent("identical", agentOptions);
            secondFinished();
            return answer;
          },
        ],
        options,
      );
      await secondWaiting;
      releaseFirst();
      expect(await run).toEqual(["FIRST", "SECOND"]);
      const recorded = readWorkflowReplayLog(root, "source");
      expect(recorded.map((entry) => entry.seq)).toEqual([1, 0]);
      const replay = createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded });
      const resumed = createWorkflowRuntime({
        runId: "resume",
        replay,
        agentRunner: async (request) => {
          executions++;
          return completed(request, "FRESH");
        },
      });
      expect(
        await resumed.dsl.parallel(
          [() => resumed.dsl.agent("identical", agentOptions), () => resumed.dsl.agent("identical", agentOptions)],
          options,
        ),
      ).toEqual(["FIRST", "SECOND"]);
      expect(executions).toBe(2);
    }),
);

function record(seq: number, text = `answer-${seq}`): WorkflowReplayAgentEntry {
  return { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind: "agent", key: hashCanonicalRequest("same"), ok: true, text };
}
function log(root: string, rows: unknown[]) {
  const file = workflowReplayFile(tempRun(root, "source"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n");
  return { entries: readWorkflowReplayLog(root, "source"), file };
}
const call = { canonicalRequest: "same", replayable: true };

it.each([
  { name: "missing first", rows: [record(1), record(2)], prefix: 0 },
  { name: "missing middle", rows: [record(0), record(2)], prefix: 1 },
  { name: "malformed first", rows: [{ ...record(0), text: null }, record(1)], prefix: 0 },
  { name: "malformed middle", rows: [record(0), { ...record(1), node: 1 }, record(2)], prefix: 1 },
  { name: "partial middle", rows: [record(0), '{"v":4,"seq":1', record(2)], prefix: 1 },
  { name: "duplicate first", rows: [record(0), record(0, "other"), record(1)], prefix: 0 },
  { name: "duplicate middle", rows: [record(0), record(1), record(1, "other")], prefix: 1 },
  { name: "malformed duplicate", rows: [record(0), { ...record(0), ok: null }, record(1)], prefix: 0 },
  { name: "unsafe seq", rows: [{ ...record(0), seq: Number.MAX_SAFE_INTEGER + 1 }, record(0)], prefix: 0 },
])("keeps only the proven prefix for $name", async ({ rows, prefix }) =>
  temporary(async (root) => {
    const { entries } = log(root, rows);
    const replay = createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded: entries });
    for (let i = 0; i < prefix; i++)
      expect(replay.beginAgentAttempt(call)).toEqual({ replayed: true, text: `answer-${i}` });
    expect(replay.beginAgentAttempt(call).replayed).toBe(false);
    expect(replay.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "diverged" });
    expect(replay.counts()).toMatchObject({ replayedCalls: prefix, freshCalls: 2, divergedAtCall: prefix });
  }),
);

it.each(["clock", "random"] as const)(
  "does not compact missing or duplicate %s values, and stops agent reuse too",
  async (kind) =>
    temporary(async (root) => {
      for (const duplicate of [false, true]) {
        const rows = [
          { v: WORKFLOW_REPLAY_SCHEMA_VERSION, kind, seq: 0, value: 0.1 },
          ...(duplicate
            ? [
                { v: WORKFLOW_REPLAY_SCHEMA_VERSION, kind, seq: 1, value: 0.2 },
                { v: WORKFLOW_REPLAY_SCHEMA_VERSION, kind, seq: 1, value: 0.3 },
              ]
            : [{ v: WORKFLOW_REPLAY_SCHEMA_VERSION, kind, seq: 1, value: null }]),
          { v: WORKFLOW_REPLAY_SCHEMA_VERSION, kind, seq: 2, value: 0.4 },
          record(0),
        ];
        const replay = createWorkflowReplayController({
          runDir: tempRun(root, `resume-${duplicate}`),
          recorded: log(root, rows).entries,
        });
        expect(replay.resolveValue(kind, () => 0.9)).toBe(0.1);
        expect(replay.resolveValue(kind, () => 0.9)).toBe(0.9);
        expect(replay.resolveValue(kind, () => 0.8)).toBe(0.8);
        expect(replay.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "diverged" });
      }
    }),
);

it("keeps legacy completion-order evidence readable without interpreting it as admission order", async () =>
  temporary(async (root) => {
    const rows = [
      { ...record(0, "SECOND"), v: 3 },
      { ...record(1, "FIRST"), v: 3 },
    ];
    const { entries, file } = log(root, rows);
    const before = readFileSync(file, "utf8");
    expect(entries).toEqual(rows);
    const replay = createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded: entries });
    expect(replay.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "invocation-identity-unproven" });
    expect(replay.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "diverged" });
    expect(readFileSync(file, "utf8")).toBe(before);
  }));

it("binds each immutable receipt to its original request and rejects foreign or repeated settlement", async () =>
  temporary(async (root) => {
    const replay = createWorkflowReplayController({ runDir: tempRun(root, "source") });
    const request = { ...call, node: "original", returnContractVersion: 5 };
    const receipt = replay.beginAgentAttempt(request);
    request.canonicalRequest = "changed";
    request.node = "changed";
    request.returnContractVersion = 6;
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => replay.recordAgentAttempt({ ...receipt }, { ok: true, text: "forged" })).toThrow(/foreign/u);
    replay.recordAgentAttempt(receipt, { ok: true, text: "original answer" });
    expect(() => replay.recordAgentAttempt(receipt, { ok: false })).toThrow(/already settled/u);
    expect(readWorkflowReplayLog(root, "source")).toEqual([
      { ...record(0, "original answer"), node: "original", rcv: 5 },
    ]);
  }));

it("preserves a failed admission beside a reverse-completed success", async () =>
  temporary(async (root) => {
    const source = createWorkflowReplayController({ runDir: tempRun(root, "source") });
    const first = source.beginAgentAttempt(call);
    const second = source.beginAgentAttempt(call);
    source.recordAgentAttempt(second, { ok: true, text: "SECOND" });
    source.recordAgentAttempt(first, { ok: false });
    const recorded = readWorkflowReplayLog(root, "source");
    expect(recorded.map((entry) => entry.seq)).toEqual([1, 0]);
    const replay = createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded });
    expect(replay.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "recorded-failure" });
    expect(replay.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "diverged" });
  }));

it("a failed append leaves an identity gap instead of moving a later answer into its place", async () =>
  temporary(async (root) => {
    const runDir = tempRun(root, "source");
    const replay = createWorkflowReplayController({ runDir });
    const file = workflowReplayFile(runDir);
    mkdirSync(file, { recursive: true }); // deterministic append-open failure, without mocking the writer
    const first = replay.beginAgentAttempt(call);
    expect(() => replay.recordAgentAttempt(first, { ok: true, text: "FIRST" })).not.toThrow();
    rmSync(file, { recursive: true });
    const second = replay.beginAgentAttempt(call);
    replay.recordAgentAttempt(second, { ok: true, text: "SECOND" });
    const recorded = readWorkflowReplayLog(root, "source");
    expect(recorded).toEqual([record(1, "SECOND")]);
    const resumed = createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded });
    expect(resumed.beginAgentAttempt(call)).toEqual({ replayed: false, reason: "recorded-sequence-invalid" });
  }));

it("strict recovery refuses gaps before dispatch instead of truncating its required prefix", async () =>
  temporary(async (root) => {
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "resume"),
      recorded: [record(0), record(2)],
      requireRecordedPrefix: true,
    });
    expect(replay.beginAgentAttempt(call)).toEqual({ replayed: true, text: "answer-0" });
    expect(() => replay.beginAgentAttempt(call)).toThrow(/prefix divergence at call 1: recorded-sequence-invalid/u);
  }));

it("one transport retry settles the same admission while a sibling finishes first", async () =>
  temporary(async (root) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const source = createWorkflowRuntime({
      runId: "source",
      replay: createWorkflowReplayController({ runDir: tempRun(root, "source") }),
      agentRunner: async (request) => {
        const ordinal = attempts++;
        if (ordinal === 0)
          return { ok: false, status: "failed", failureCause: "host-turn-timeout", summary: "retry", diagnostics: [] };
        if (ordinal > 1) await gate;
        return completed(request, ordinal === 1 ? "SECOND" : "FIRST");
      },
    });
    expect(
      await source.dsl.parallel([
        () => source.dsl.agent("same", { attempts: 2 }),
        async () => {
          const value = await source.dsl.agent("same");
          release();
          return value;
        },
      ]),
    ).toEqual(["FIRST", "SECOND"]);
    expect(attempts).toBe(3);
    const recorded = readWorkflowReplayLog(root, "source");
    expect(recorded.map((entry) => entry.seq)).toEqual([1, 0]);
    const replay = createWorkflowRuntime({
      runId: "resume",
      replay: createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded }),
      agentRunner: async () => {
        throw new Error("must not execute");
      },
    });
    expect(
      await replay.dsl.parallel([() => replay.dsl.agent("same", { attempts: 2 }), () => replay.dsl.agent("same")]),
    ).toEqual(["FIRST", "SECOND"]);
  }));

it("emits the legacy identity diagnostic before executing a fresh child", async () =>
  temporary(async (root) => {
    const source = createWorkflowRuntime({
      runId: "source",
      replay: createWorkflowReplayController({ runDir: tempRun(root, "source") }),
      agentRunner: async (request) => completed(request, "old"),
    });
    await source.dsl.agent("same");
    const recorded = readWorkflowReplayLog(root, "source").map((entry) => ({ ...entry, v: 3 as const }));
    const resumed = createWorkflowRuntime({
      runId: "resume",
      replay: createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded }),
      agentRunner: async (request) => completed(request, "fresh"),
    });
    expect(await resumed.dsl.agent("same")).toBe("fresh");
    expect(resumed.getJournal().find((line) => line.message?.includes("invocation-identity-unproven"))).toBeDefined();
  }));
