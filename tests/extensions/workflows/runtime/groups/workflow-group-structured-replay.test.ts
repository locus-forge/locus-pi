import { VERSION } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  WorkflowInvocationCapError,
  type WorkflowAgentResult,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
} from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { completed, temporary, tempRun } from "../../../../fixtures/scripted-agent-runtime.js";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";

const identity = { sha256: "a".repeat(64), covered: true, inputSha256: "c".repeat(64) };
const values = ["FIRST", "SECOND", "THIRD"];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

describe("structured tool admission and group settlement", () => {
  const options = {
    schema: { type: "string" },
  };
  const seeds: Array<Awaited<ReturnType<typeof structuredSdk>>> = [];
  beforeAll(async () => {
    for (const value of values) {
      const raw = JSON.stringify({ value });
      const seed = await structuredSdk(options, [rawTurn([raw])]);
      expect(seed.error).toBeUndefined();
      seeds.push(seed);
    }
  });
  const replayDependencies = {
    structuredSourceIdentity: identity,
    structuredReplayHostVersion: async () => VERSION,
  };
  const answer = (index: number): WorkflowAgentResult => ({
    ok: true,
    status: "completed",
    summary: "Synthetic accepted SDK receipt",
    diagnostics: [],
    text: JSON.stringify(values[index]),
    outputAcceptance: seeds[index]!.acceptance!,
  });

  it("refuses an empty executable tool name before correction or effects", async () => {
    const result = await structuredSdk(options, [
      rawTurn(["{}"], "completed", [], [""]),
      rawTurn(['{"value":"FIRST"}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
    expect(result.counters).toMatchObject({ generations: 1, effects: 0, tools: 0 });
  });

  it.each(
    permutations.flatMap((order) =>
      [false, true].flatMap((keyed) => [false, true].map((labelled) => ({ order, keyed, labelled }))),
    ),
  )(
    "retains three admissions and receipts for $order keyed=$keyed labelled=$labelled",
    async ({ order, keyed, labelled }) =>
      temporary(async (root) => {
        const gates = values.map(deferred),
          finished = values.map(deferred),
          started = deferred();
        let physical = 0;
        const source = createWorkflowRuntime({
          runId: "source",
          ...replayDependencies,
          replay: createWorkflowReplayController({ runDir: tempRun(root, "source") }),
          agentRunner: async () => {
            const index = physical++;
            if (physical === 3) started.resolve();
            await gates[index]!.promise;
            return answer(index);
          },
        });
        const callOptions = { ...options, ...(labelled ? { label: "same" } : {}) };
        const groupOptions = keyed ? { keys: ["first", "second", "third"] } : {};
        const run = source.dsl.parallel(
          values.map((_, index) => async () => {
            const value = await source.dsl.agent("identical", callOptions);
            finished[index]!.resolve();
            return value;
          }),
          groupOptions,
        );
        try {
          await started.promise;
          for (const index of order) {
            gates[index]!.resolve();
            await finished[index]!.promise;
          }
          expect(await run).toEqual(values);
        } finally {
          gates.forEach((gate) => gate.resolve());
          await run;
        }
        let records = readWorkflowReplayLog(root, "source");
        expect(records.map((entry) => entry.seq)).toEqual(order);
        for (const runId of ["repeat", "resume", "resume-of-resume"]) {
          const replay = createWorkflowReplayController({ runDir: tempRun(root, runId), recorded: records });
          const runtime = createWorkflowRuntime({
            runId,
            ...replayDependencies,
            replaySourceRunId: "source",
            replay,
            agentRunner: async () => {
              throw new Error("Replay cannot dispatch a child");
            },
          });
          expect(
            await runtime.dsl.parallel(
              values.map(() => () => runtime.dsl.agent("identical", callOptions)),
              groupOptions,
            ),
          ).toEqual(values);
          expect(replay.counts()).toMatchObject({ replayedCalls: 3, freshCalls: 0 });
          const next = readWorkflowReplayLog(root, runId);
          expect(
            next
              .filter((entry) => entry.kind === "agent" && entry.ok)
              .sort((left, right) => left.seq - right.seq)
              .map((entry) => entry.structuredReceipt?.value),
          ).toEqual(values);
          records = next;
        }
        expect(physical).toBe(3);
      }),
  );

  it.each(["intact", "missing", "mismatched"])(
    "protects structured intake with %s contract metadata",
    async (metadata) =>
      temporary(async (root) => {
        const records = structuredClone(seeds[0]!.replayRecord);
        const entry = records[0]!;
        if (entry.kind !== "agent" || !entry.ok || entry.structuredReceipt === undefined)
          throw new Error("Missing seed");
        if (metadata === "missing") delete entry.rcv;
        if (metadata === "mismatched") entry.rcv = 3;
        const replay = createWorkflowReplayController({ runDir: tempRun(root, "snapshot"), recorded: records });
        entry.text = '"TAMPERED"';
        entry.structuredReceipt.value = "TAMPERED";
        if (entry.structuredReceipt.version === 5)
          entry.structuredReceipt.rawTurns[0]!.output!.text = '{"value":"TAMPERED"}';
        else entry.structuredReceipt.rawTurns[0]!.calls[0]!.arguments = '{"value":"TAMPERED"}';
        const runtime = createWorkflowRuntime({
          runId: "snapshot",
          ...replayDependencies,
          replaySourceRunId: "source",
          replay,
          agentRunner: async () => {
            throw new Error("Replay cannot dispatch a child");
          },
        });
        const call = runtime.dsl.agent("Return authoritative data", options);
        if (metadata === "intact") {
          expect(await call).toBe("FIRST");
          expect(readWorkflowReplayLog(root, "snapshot")[0]).toMatchObject({
            ok: true,
            structuredReceipt: { value: "FIRST" },
          });
        } else {
          await expect(call).rejects.toThrow("replay-contract-failure");
          expect(replay.counts()).toMatchObject({ replayedCalls: 0, freshCalls: 0, divergedAtCall: 0 });
        }
      }),
  );

  it.each(["missing", "domain", "legacy-log"] as const)(
    "closes later reuse after a caught %s refusal",
    async (reason) =>
      temporary(async (root) => {
        const records = structuredClone(seeds[0]!.replayRecord);
        const first = records[0]!;
        if (first.kind !== "agent" || !first.ok) throw new Error("Missing seed");
        if (reason === "missing") delete first.structuredReceipt;
        if (reason === "legacy-log") first.v = 3;
        if (reason === "domain") {
          const invalid = first as any;
          invalid.text = "7";
          invalid.structuredReceipt.value = 7;
          invalid.structuredReceipt.rawTurns[0].calls[0].arguments = '{"value":7}';
        }
        let fresh = 0;
        const replay = createWorkflowReplayController({ runDir: tempRun(root, "caught"), recorded: records });
        const runtime = createWorkflowRuntime({
          runId: "caught",
          ...replayDependencies,
          replaySourceRunId: "source",
          replay,
          agentRunner: async (request) => {
            fresh++;
            return completed(request, "FRESH");
          },
        });
        await expect(
          runtime.dsl.agent("Return authoritative data", {
            ...options,
          }),
        ).rejects.toThrow("replay-contract-failure");
        expect(fresh).toBe(0);
        expect(replay.counts()).toMatchObject({ replayedCalls: 0, divergedAtCall: 0 });
        expect(await runtime.dsl.agent("ordinary suffix")).toBe("FRESH");
        expect(fresh).toBe(1);
        if (reason !== "legacy-log")
          expect(readWorkflowReplayLog(root, "caught")[0]).toMatchObject({ seq: 0, ok: false });
      }),
  );

  it("keeps one admission across a transport retry while a sibling settles first", async () =>
    temporary(async (root) => {
      const held = deferred();
      let physical = 0;
      const source = createWorkflowRuntime({
        runId: "retry",
        ...replayDependencies,
        replay: createWorkflowReplayController({ runDir: tempRun(root, "retry") }),
        agentRunner: async () => {
          const index = physical++;
          if (index === 0)
            return {
              ok: false,
              status: "failed",
              summary: "Retry before generation",
              diagnostics: [],
              failureCause: "host-turn-timeout",
            };
          if (index > 1) await held.promise;
          return answer(index === 1 ? 1 : 0);
        },
      });
      const calls = [
        () => source.dsl.agent("same", { ...options, attempts: 2 }),
        async () => {
          const value = await source.dsl.agent("same", options);
          held.resolve();
          return value;
        },
      ];
      expect(await source.dsl.parallel(calls)).toEqual(values.slice(0, 2));
      expect(physical).toBe(3);
      const records = readWorkflowReplayLog(root, "retry");
      expect(records.map((entry) => entry.seq)).toEqual([1, 0]);
      const replay = createWorkflowRuntime({
        runId: "retry-resume",
        ...replayDependencies,
        replaySourceRunId: "retry",
        replay: createWorkflowReplayController({ runDir: tempRun(root, "retry-resume"), recorded: records }),
        agentRunner: async () => {
          throw new Error("Replay cannot dispatch");
        },
      });
      expect(
        await replay.dsl.parallel([
          () => replay.dsl.agent("same", { ...options, attempts: 2 }),
          () => replay.dsl.agent("same", options),
        ]),
      ).toEqual(values.slice(0, 2));
    }));

  it("settles an already offered sibling after caught refusal closes subsequent lookups", async () =>
    temporary(async (root) => {
      const held = deferred();
      const records = seeds.slice(0, 2).map((seed, seq) => ({ ...structuredClone(seed.replayRecord[0]!), seq }));
      const invalid = records[0] as any;
      invalid.text = "7";
      invalid.structuredReceipt.value = 7;
      invalid.structuredReceipt.rawTurns[0].calls[0].arguments = '{"value":7}';
      const replay = createWorkflowReplayController({ runDir: tempRun(root, "offered"), recorded: records });
      let hostReads = 0,
        fresh = 0;
      const runtime = createWorkflowRuntime({
        runId: "offered",
        ...replayDependencies,
        replaySourceRunId: "source",
        replay,
        structuredReplayHostVersion: async () => {
          if (++hostReads === 2) await held.promise;
          return VERSION;
        },
        agentRunner: async (request) => {
          fresh++;
          return completed(request, "FRESH");
        },
      });
      const rejected = runtime.dsl.agent("Return authoritative data", options).catch((error: unknown) => error);
      const offered = runtime.dsl.agent("Return authoritative data", options);
      try {
        expect(await rejected).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
        expect(hostReads).toBe(2);
        expect(await runtime.dsl.agent("ordinary suffix")).toBe("FRESH");
        expect(fresh).toBe(1);
      } finally {
        held.resolve();
      }
      expect(await offered).toBe("SECOND");
      expect(replay.counts()).toMatchObject({ replayedCalls: 1, freshCalls: 1, divergedAtCall: 0 });
      const next = readWorkflowReplayLog(root, "offered");
      expect(next.find((entry) => entry.seq === 0)).toMatchObject({ ok: false });
      expect(next.find((entry) => entry.seq === 1)).toMatchObject({ ok: true, structuredReceipt: { value: "SECOND" } });
    }));

  it.each(["cap", "cancel"] as const)("drains an accepted receipt before group settlement on %s", async (stop) =>
    temporary(async (root) => {
      const held = deferred(),
        started = deferred(),
        stopped = deferred();
      const controller = new AbortController();
      const cancellation = new Error("Operator stop");
      let late = false,
        settled = false,
        failure: unknown;
      const runtime = createWorkflowRuntime({
        runId: "drain",
        ...replayDependencies,
        signal: controller.signal,
        maxConcurrentAgents: 2,
        ...(stop === "cap" ? { maxTotalAgentInvocations: 1 } : {}),
        replay: createWorkflowReplayController({ runDir: tempRun(root, "drain") }),
        agentRunner: async () => {
          started.resolve();
          await held.promise;
          return answer(0);
        },
      });
      const run = runtime.dsl
        .parallel([
          () => runtime.dsl.agent("held", options),
          async () => {
            await started.promise;
            try {
              if (stop === "cancel") {
                controller.abort(cancellation);
                throw cancellation;
              }
              return await runtime.dsl.agent("refused", options);
            } finally {
              stopped.resolve();
            }
          },
          async () => {
            late = true;
            return "late";
          },
        ])
        .then(
          () => {
            settled = true;
          },
          (error) => {
            settled = true;
            failure = error;
          },
        );
      try {
        await stopped.promise;
        await tick();
        expect(settled).toBe(false);
        expect(late).toBe(false);
        expect(runtime.getJournal().some((line) => line.kind === "group_end")).toBe(false);
      } finally {
        held.resolve();
        await run;
      }
      if (stop === "cap") expect(failure).toBeInstanceOf(WorkflowInvocationCapError);
      else expect(failure).toBe(cancellation);
      expect(late).toBe(false);
      expect(readWorkflowReplayLog(root, "drain").find((entry) => entry.seq === 0)).toMatchObject({
        ok: true,
        structuredReceipt: { value: "FIRST" },
      });
      const kinds = runtime.getJournal().map((line) => line.kind);
      expect(kinds.lastIndexOf("group_end")).toBeGreaterThan(kinds.lastIndexOf("agent_end"));
    }),
  );
});
