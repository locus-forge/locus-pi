import { agentOutputAcceptance } from "../../../../../extensions/_shared/agent-runtime/output-acceptance/agent-output-contract.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { temporary, tempRun } from "../../../../fixtures/scripted-agent-runtime.js";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  hashCanonicalRequest,
  readWorkflowReplayLog,
  workflowReplayFile,
} from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import {
  readWorkflowRunJournalState,
  workflowJournalFile,
} from "../../../../../extensions/workflows/runtime/workflow-journal.js";
import { verifyWorkflowStructuredReceipt } from "../../../../../extensions/workflows/runtime/structured-results/receipt.js";
import { normalizeWorkflowStructuredContract } from "../../../../../extensions/workflows/runtime/structured-results/schema.js";

const historical = JSON.parse(
  readFileSync(new URL("../../../../fixtures/agent-runtime/historical-native-v5.json", import.meta.url), "utf8"),
);
const identity = { sha256: "a".repeat(64), covered: true, inputSha256: "c".repeat(64) };

describe("historical native-v5 evidence after live adapter removal", () => {
  it.each(historical.cases as Array<{ phase: unknown; records: any[]; journal: any[] }>)(
    "reads $phase phase unchanged and refuses current replay without a fresh child",
    async (fixture: any) =>
      temporary(async (root) => {
        expect(historical.sourceHead).toBe("f73b3fd4e91971ca6f44b5d19ed10c1c68dfa4bd");
        const source = tempRun(root, "structured-sdk");
        mkdirSync(path.dirname(workflowReplayFile(source)), { recursive: true });
        writeFileSync(
          workflowReplayFile(source),
          fixture.records.map((entry: unknown) => JSON.stringify(entry)).join("\n") + "\n",
        );
        writeFileSync(
          workflowJournalFile(source),
          fixture.journal.map((entry: unknown) => JSON.stringify(entry)).join("\n") + "\n",
        );
        const records = readWorkflowReplayLog(root, "structured-sdk");
        expect(records).toEqual(fixture.records);
        const journal = readWorkflowRunJournalState(root, "structured-sdk");
        expect(journal.diagnostics).toEqual([]);
        expect(journal.lines.find((line) => line.kind === "agent_end")?.outputAcceptance).toMatchObject({
          source: "native",
          contractVersion: 5,
        });
        const output = (records[0] as any).structuredReceipt.rawTurns[0].output;
        expect(Object.hasOwn(output, "phase")).toBe(fixture.phase !== "absent");
        if (fixture.phase !== "absent") expect(output.phase).toBe(fixture.phase);
        let children = 0;
        const runtime = createWorkflowRuntime({
          runId: "resume",
          replaySourceRunId: "history",
          structuredSourceIdentity: identity,
          structuredReplayHostVersion: async () => "1.0.0",
          replay: createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded: records }),
          agentRunner: async () => {
            children++;
            throw new Error("Historical output must not trigger work");
          },
        });
        await expect(runtime.dsl.agent("Return authoritative data", { schema: { type: "string" } })).rejects.toThrow(
          "replay-contract-failure",
        );
        expect(children).toBe(0);
        expect(records).toEqual(fixture.records);
        expect(() =>
          verifyWorkflowStructuredReceipt((records[0] as any).structuredReceipt, '"known"', {
            contract: normalizeWorkflowStructuredContract({ type: "string" }),
            limits: {},
            sourceIdentity: identity.sha256,
            inputIdentity: identity.inputSha256,
          }),
        ).toThrow("Historical native v5");
      }),
  );

  it("cannot project historical native evidence as fresh tool acceptance", () => {
    const receipt = historical.cases[0].records[0].structuredReceipt;
    expect(() =>
      agentOutputAcceptance({
        status: "accepted",
        text: '"known"',
        attempts: 1,
        toolName: "workflow_return",
        structuredReceipt: receipt,
      }),
    ).toThrow("Historical native v5");
  });

  it.each([undefined, 3, 4, 5])("never reclassifies native evidence when row rcv is %s", async (rcv) =>
    temporary(async (root) => {
      const records = structuredClone(historical.cases[0].records);
      if (rcv === undefined) delete records[0].rcv;
      else records[0].rcv = rcv;
      let children = 0;
      const runtime = createWorkflowRuntime({
        runId: "resume",
        replaySourceRunId: "history",
        structuredSourceIdentity: identity,
        structuredReplayHostVersion: async () => "1.0.0",
        replay: createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded: records }),
        agentRunner: async () => {
          children++;
          throw new Error("No fresh work");
        },
      });
      await expect(runtime.dsl.agent("Return authoritative data", { schema: { type: "string" } })).rejects.toThrow(
        "replay-contract-failure",
      );
      expect(children).toBe(0);
    }),
  );
});

it.each(["plain", "choice", "schema"])(
  "refuses retired native input before %s-mode fallback or key matching",
  async (mode) =>
    temporary(async (root) => {
      for (const marker of ["both", "receipt-only", "row-only"] as const) {
        const records = structuredClone(historical.cases[0].records);
        if (marker === "receipt-only") delete records[0].rcv;
        if (marker === "row-only") delete records[0].structuredReceipt;
        let children = 0;
        const replay = createWorkflowReplayController({ runDir: tempRun(root, marker), recorded: records });
        const runtime = createWorkflowRuntime({
          runId: marker,
          replaySourceRunId: "history",
          structuredSourceIdentity: identity,
          structuredReplayHostVersion: async () => "1.0.0",
          replay,
          agentRunner: async () => {
            children++;
            throw new Error("No fresh native fallback");
          },
        });
        const options =
          mode === "schema"
            ? { schema: { type: "string" } }
            : mode === "choice"
              ? { choice: ["known", "unknown"] }
              : undefined;
        await expect(runtime.dsl.agent("Return authoritative data", options as any)).rejects.toThrow(
          "historical native v5",
        );
        expect(children).toBe(0);
        expect(replay.counts()).toMatchObject({ replayedCalls: 0, freshCalls: 0, divergedAtCall: 0 });
      }
    }),
);

it("latches caught native refusal before allowing a fresh ordinary suffix", async () =>
  temporary(async (root) => {
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "caught"),
      recorded: historical.cases[0].records,
    });
    let children = 0;
    const runtime = createWorkflowRuntime({
      runId: "caught",
      replaySourceRunId: "history",
      replay,
      agentRunner: async () => {
        children++;
        return { ok: true, status: "completed", summary: "FRESH", text: "FRESH", diagnostics: [] };
      },
    });
    await expect(runtime.dsl.agent("Return authoritative data")).rejects.toThrow("historical native v5");
    expect(children).toBe(0);
    expect(await runtime.dsl.agent("ordinary suffix")).toBe("FRESH");
    expect(children).toBe(1);
    expect(replay.counts()).toMatchObject({ replayedCalls: 0, freshCalls: 1, divergedAtCall: 0 });
    expect(readWorkflowReplayLog(root, "caught")).toMatchObject([{ seq: 1, ok: true, text: "FRESH" }]);
  }));

it("recognizes a retired native row even after an earlier ordinary divergence", async () =>
  temporary(async (root) => {
    const native = structuredClone(historical.cases[0].records[0]);
    native.seq = 1;
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "diverged"),
      recorded: [{ v: 4, kind: "agent", seq: 0, key: "0".repeat(64), ok: true, text: "old" }, native],
    });
    const call = { canonicalRequest: "ordinary-current", replayable: true };
    const first = replay.beginAgentAttempt(call);
    expect(first).toMatchObject({ replayed: false, reason: "key-mismatch" });
    replay.recordAgentAttempt(first, { ok: true, text: "new" });
    expect(() => replay.beginAgentAttempt(call)).toThrow("historical native v5");
    expect(replay.counts()).toMatchObject({ replayedCalls: 0, freshCalls: 1, divergedAtCall: 0 });
  }));

const nativeRow = (marker: "row" | "receipt", seq = 0) => {
  const row = structuredClone(historical.cases[0].records[0]);
  row.seq = seq;
  if (marker === "row") delete row.structuredReceipt;
  else delete row.rcv;
  return row;
};
const ordinaryRow = (seq: number, request: string, text = request) => ({
  v: 4 as const,
  seq,
  kind: "agent" as const,
  key: hashCanonicalRequest(request),
  ok: true as const,
  text,
});

it.each(["row", "receipt"] as const)(
  "preserves retired %s identity through duplicate poisoning in either order",
  async (marker) =>
    temporary(async (root) => {
      for (const order of ["native-first", "native-last", "native-twice"] as const) {
        const native = nativeRow(marker, 1);
        const duplicate = order === "native-twice" ? structuredClone(native) : ordinaryRow(1, "duplicate");
        const middle = order === "native-last" ? [duplicate, native] : [native, duplicate];
        const replay = createWorkflowReplayController({
          runDir: tempRun(root, order),
          recorded: [ordinaryRow(0, "prefix"), ...middle, ordinaryRow(2, "suffix")],
        });
        const prefix = replay.beginAgentAttempt({ canonicalRequest: "prefix", replayable: true });
        expect(prefix).toEqual({ replayed: true, text: "prefix" });
        replay.recordAgentAttempt(prefix, { ok: true, text: "prefix" });
        expect(() => replay.beginAgentAttempt({ canonicalRequest: "ordinary new call", replayable: true })).toThrow(
          "historical native v5",
        );
        expect(replay.counts()).toMatchObject({ replayedCalls: 1, freshCalls: 0, divergedAtCall: 1 });
        const suffix = replay.beginAgentAttempt({ canonicalRequest: "suffix", replayable: true });
        expect(suffix).toEqual({ replayed: false, reason: "diverged" });
        replay.recordAgentAttempt(suffix, { ok: true, text: "fresh suffix" });
        expect(() => replay.recordAgentAttempt(prefix, { ok: true, text: "twice" })).toThrow("already settled");
        expect(replay.counts()).toMatchObject({ replayedCalls: 1, freshCalls: 1 });
      }
    }),
);

it.each(["row", "receipt"] as const)(
  "retains %s retirement from malformed serialized rows before acceptance projection",
  async (marker) =>
    temporary(async (root) => {
      for (const damage of ["key", "overflow", "failed"] as const) {
        const row = nativeRow(marker, 1);
        if (damage === "key") row.key = "damaged";
        if (damage === "failed") {
          row.ok = false;
          delete row.text;
        }
        if (damage === "overflow") row.structuredReceipt ??= { version: 4 };
        const rawRow =
          damage === "overflow"
            ? JSON.stringify(row).replace('"structuredReceipt":{', '"structuredReceipt":{"extra":1e999,')
            : JSON.stringify(row);
        const runId = `${marker}-${damage}`;
        const file = workflowReplayFile(tempRun(root, runId));
        mkdirSync(path.dirname(file), { recursive: true });
        const raw = `${JSON.stringify(ordinaryRow(0, "prefix"))}\n${rawRow}\n${JSON.stringify(ordinaryRow(2, "suffix"))}\n`;
        writeFileSync(file, raw);
        const records = readWorkflowReplayLog(root, runId);
        expect(readFileSync(file, "utf8")).toBe(raw);
        expect(records[0]).toEqual(ordinaryRow(0, "prefix"));
        const replay = createWorkflowReplayController({ runDir: tempRun(root, `resume-${runId}`), recorded: records });
        const prefix = replay.beginAgentAttempt({ canonicalRequest: "prefix", replayable: true });
        expect(prefix).toEqual({ replayed: true, text: "prefix" });
        replay.recordAgentAttempt(prefix, { ok: true, text: "prefix" });
        expect(() => replay.beginAgentAttempt({ canonicalRequest: "ordinary new call", replayable: true })).toThrow(
          "historical native v5",
        );
        expect(replay.counts()).toMatchObject({ replayedCalls: 1, freshCalls: 0, divergedAtCall: 1 });
      }
    }),
);

it.each(["row", "receipt"] as const)(
  "refuses unproven %s retirement positions without fabricating an ordinal",
  async (marker) =>
    temporary(async (root) => {
      for (const change of [{ seq: -1 }, { seq: "0" }, { seq: null }, { kind: "random" }, { v: 2 }]) {
        const row = { ...nativeRow(marker), ...change };
        expect(() => createWorkflowReplayController({ runDir: tempRun(root, "direct"), recorded: [row] })).toThrow(
          "position is unproven",
        );
        const file = workflowReplayFile(tempRun(root, "serialized"));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(row) + "\n");
        expect(() => readWorkflowReplayLog(root, "serialized")).toThrow("position is unproven");
      }
    }),
);

it("keeps ordinary duplicate/corrupt fallback but retains retired evidence in the poisoned suffix", async () =>
  temporary(async (root) => {
    const ordinary = ordinaryRow(0, "ordinary");
    const duplicate = createWorkflowReplayController({
      runDir: tempRun(root, "duplicates"),
      recorded: [ordinary, ordinary],
    });
    expect(duplicate.beginAgentAttempt({ canonicalRequest: "ordinary", replayable: true })).toEqual({
      replayed: false,
      reason: "recorded-sequence-invalid",
    });
    expect(duplicate.counts()).toMatchObject({ freshCalls: 1, replayedCalls: 0 });
    for (const marker of [undefined, "row", "receipt"] as const) {
      const runId = marker ?? "ordinary";
      const file = workflowReplayFile(tempRun(root, runId));
      mkdirSync(path.dirname(file), { recursive: true });
      const suffix = marker === undefined ? ordinaryRow(1, "suffix") : nativeRow(marker, 1);
      writeFileSync(file, [JSON.stringify({ ...ordinary, key: "damaged" }), JSON.stringify(suffix)].join("\n") + "\n");
      const records = readWorkflowReplayLog(root, runId);
      if (marker === undefined) expect(records).toEqual([]);
      else expect(records).toHaveLength(1);
      const replay = createWorkflowReplayController({ runDir: tempRun(root, `resume-${runId}`), recorded: records });
      expect(replay.beginAgentAttempt({ canonicalRequest: "ordinary", replayable: true }).replayed).toBe(false);
      if (marker === undefined)
        expect(replay.beginAgentAttempt({ canonicalRequest: "suffix", replayable: true }).replayed).toBe(false);
      else
        expect(() => replay.beginAgentAttempt({ canonicalRequest: "suffix", replayable: true })).toThrow(
          "historical native v5",
        );
      expect(replay.counts().replayedCalls).toBe(0);
    }
  }));

it.each(["row", "receipt"] as const)(
  "reads legacy %s evidence unchanged but refuses execution before an earlier ordinary call",
  async (marker) =>
    temporary(async (root) => {
      const records = [
        { ...ordinaryRow(0, "ordinary prefix"), v: 3 as const },
        { ...nativeRow(marker, 1), v: 3 as const },
      ];
      const file = workflowReplayFile(tempRun(root, "legacy"));
      mkdirSync(path.dirname(file), { recursive: true });
      const raw = records.map((row) => JSON.stringify(row)).join("\n") + "\n";
      writeFileSync(file, raw);
      const readable = readWorkflowReplayLog(root, "legacy");
      expect(readable).toEqual(records);
      expect(readFileSync(file, "utf8")).toBe(raw);
      let children = 0,
        failure: unknown;
      try {
        const runtime = createWorkflowRuntime({
          runId: "resume-legacy",
          replaySourceRunId: "legacy",
          replay: createWorkflowReplayController({ runDir: tempRun(root, "resume-legacy"), recorded: readable }),
          agentRunner: async () => {
            children++;
            return { ok: true, status: "completed", summary: "FRESH", text: "FRESH", diagnostics: [] };
          },
        });
        await runtime.dsl.agent("ordinary prefix");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        message: expect.stringContaining("historical native v5 admission order is unproven"),
      });
      expect(children).toBe(0);
    }),
);
