import { completed, temporary, tempRun } from "../../../../fixtures/scripted-agent-runtime.js";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
  workflowReplayFile,
  type WorkflowReplayEntry,
} from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";
import type { WorkflowAgentStructuredOptions } from "../../../../../extensions/workflows/runtime/workflow-agent-contract.js";

async function resume(
  recorded: WorkflowReplayEntry[],
  options: WorkflowAgentStructuredOptions,
  identity: import("../../../../../extensions/workflows/runtime/structured-results/return.js").WorkflowStructuredSourceIdentity = {
    sha256: "a".repeat(64),
    covered: true,
    inputSha256: "c".repeat(64),
  },
) {
  const root = mkdtempSync(path.join(tmpdir(), "structured-replay-"));
  let calls = 0;
  let value: unknown;
  let error: unknown;
  const runtime = createWorkflowRuntime({
    runId: "resume",
    replaySourceRunId: "source",
    structuredReplayHostVersion: async () => VERSION,
    structuredSourceIdentity: identity,
    replay: createWorkflowReplayController({ runDir: root, recorded }),
    agentRunner: async () => {
      calls++;
      throw new Error("replay must never dispatch a child");
    },
  });
  try {
    value = await runtime.dsl.agent("Return authoritative data", options);
  } catch (caught) {
    error = caught;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { value, error, calls };
}

describe("immutable committed v4 replay on existing record owner", () => {
  it("reuses a persisted successful receipt, revalidates membership, and dispatches no model", async () => {
    const options = {
      schema: { type: "string" },
      validate: (value: unknown) => (value === "known" ? [] : ["Unknown id"]),
    };
    const first = await structuredSdk(options, [rawTurn(['{"value":"known"}'])]);
    expect(first.error).toBeUndefined();
    expect(first.replayRecord[0]).toMatchObject({
      ok: true,
      rcv: 4,
      structuredReceipt: { version: 4, validation: "accepted", observerRevision: "codex-responses-v3" },
    });
    const result = await resume(first.replayRecord, options);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.calls).toBe(0);
  });
  it.each(["codex-responses-v1", "codex-responses-v2"])(
    "refuses unproven old observer receipt %s",
    async (revision) => {
      const options = { schema: { type: "null" } };
      const first = await structuredSdk(options, [rawTurn(['{"value":null}'])]);
      const records = structuredClone(first.replayRecord);
      const entry = records[0]!;
      if (entry.kind !== "agent" || !entry.ok || entry.structuredReceipt === undefined)
        throw new Error("missing fixture receipt");
      entry.structuredReceipt.observerRevision = revision;
      const result = await resume(records, options);
      expect(result.value).toBeUndefined();
      expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
      expect(result.calls).toBe(0);
    },
  );
  it("refuses changed full source/validator closure and incomplete or missing ledgers", async () => {
    const options = { schema: { type: "null" } };
    const first = await structuredSdk(options, [rawTurn(['{"value":null}'])]);
    for (const [records, identity] of [
      [first.replayRecord, { sha256: "b".repeat(64), covered: true }],
      [first.replayRecord, { sha256: "a".repeat(64), covered: false }],
      [first.replayRecord, { sha256: "a".repeat(64), covered: true, inputSha256: "d".repeat(64) }],
      [first.replayRecord, { sha256: "a".repeat(64), covered: true }],
      [[], { sha256: "a".repeat(64), covered: true, inputSha256: "c".repeat(64) }],
      [
        [{ ...first.replayRecord[0], ok: false }],
        { sha256: "a".repeat(64), covered: true, inputSha256: "c".repeat(64) },
      ],
    ] as const) {
      const result = await resume(records as WorkflowReplayEntry[], options, identity);
      expect(result.value).toBeUndefined();
      expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
      expect(result.calls).toBe(0);
    }
  });
  it("revalidation failure is not a fresh correction or a physical child", async () => {
    const first = await structuredSdk({ schema: { type: "string" }, validate: () => [] }, [
      rawTurn(['{"value":"unknown"}']),
    ]);
    const result = await resume(first.replayRecord, {
      schema: { type: "string" },
      validate: () => ["Authoritative membership changed"],
    });
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
    expect(result.calls).toBe(0);
  });
  it("names author exceptions during replay as replay-contract failure without dispatch", async () => {
    const first = await structuredSdk({ schema: { type: "string" }, validate: () => [] }, [
      rawTurn(['{"value":"known"}']),
    ]);
    const result = await resume(first.replayRecord, {
      schema: { type: "string" },
      validate: () => {
        throw new Error("changed closure");
      },
    });
    expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
    expect(result.calls).toBe(0);
  });
  it("rejects missing/tampered receipt value, schema digest, terminal or spent ledger", async () => {
    const first = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])]);
    for (const edit of [
      (record: any) => {
        delete record.structuredReceipt;
      },
      (record: any) => {
        record.structuredReceipt.value = false;
      },
      (record: any) => {
        record.structuredReceipt.schemaSha256 = "b".repeat(64);
      },
      (record: any) => {
        delete record.structuredReceipt.spent;
      },
      (record: any) => {
        record.structuredReceipt.rawTurns[0].terminal = "incomplete";
      },
      (record: any) => {
        record.structuredReceipt.spent.outputAttempts = 0;
      },
    ]) {
      const records = structuredClone(first.replayRecord);
      edit(records[0]);
      const result = await resume(records, { schema: { type: "null" } });
      expect(result.value).toBeUndefined();
      expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
      expect(result.calls).toBe(0);
    }
  });
  it("does not record a logical success when downstream evidence storage fails", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], undefined, true);
    expect(result.replayRecord).toMatchObject([{ ok: false, rcv: 4 }]);
  });
});

it.each(["old-observer", "missing-receipt", "host-version", "validator"] as const)(
  "invalidates following replay when caught structured acceptance fails: %s",
  async (mode) =>
    temporary(async (root) => {
      const options: WorkflowAgentStructuredOptions = {
        schema: { type: "null" },
        ...(mode === "validator" ? { validate: () => [] } : {}),
      };
      const first = await structuredSdk(options, [rawTurn(['{"value":null}'])]);
      expect(first.error).toBeUndefined();
      const bad = structuredClone(first.replayRecord[0]!);
      if (bad.kind !== "agent" || !bad.ok || bad.structuredReceipt === undefined)
        throw new Error("missing fixture receipt");
      if (mode === "old-observer") bad.structuredReceipt.observerRevision = "codex-responses-v1";
      if (mode === "missing-receipt") delete bad.structuredReceipt;
      const tail = createWorkflowRuntime({
        runId: "tail",
        replay: createWorkflowReplayController({ runDir: tempRun(root, "tail") }),
        agentRunner: async (req) => completed(req, "STALE"),
      });
      await tail.dsl.agent("plain-second");
      const tailRecord = { ...readWorkflowReplayLog(root, "tail")[0]!, seq: 1 };
      let calls = 0;
      const replay = createWorkflowReplayController({ runDir: tempRun(root, "resume"), recorded: [bad, tailRecord] });
      const resumed = createWorkflowRuntime({
        runId: "resume",
        replaySourceRunId: "source",
        replay,
        structuredSourceIdentity: { covered: true, sha256: "a".repeat(64), inputSha256: "c".repeat(64) },
        structuredReplayHostVersion: async () => (mode === "host-version" ? "0.84.3" : "1.0.0"),
        agentRunner: async (req) => {
          calls++;
          return completed(req, "FRESH");
        },
      });
      await expect(
        resumed.dsl.agent("Return authoritative data", {
          ...options,
          ...(mode === "validator"
            ? {
                validate: () => {
                  throw new Error("changed authority");
                },
              }
            : {}),
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(replay.counts()).toMatchObject({ replayedCalls: 0, divergedAtCall: 0 });
      expect(await resumed.dsl.agent("plain-second")).toBe("FRESH");
      expect(calls).toBe(1);
    }),
);

it("latches a caught structured lookup refusal before returning control", async () =>
  temporary(async (root) => {
    const source = createWorkflowReplayController({ runDir: tempRun(root, "source") });
    const first = { canonicalRequest: "structured", replayable: true, returnContractVersion: 4 };
    const second = { canonicalRequest: "plain", replayable: true };
    source.recordAgentAttempt(source.beginAgentAttempt(first), { ok: false });
    source.recordAgentAttempt(source.beginAgentAttempt(second), { ok: true, text: "STALE" });
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "resume"),
      recorded: readWorkflowReplayLog(root, "source"),
    });
    expect(() => replay.beginAgentAttempt(first)).toThrow("replay-contract-failure");
    expect(replay.beginAgentAttempt(second)).toEqual({ replayed: false, reason: "diverged" });
    expect(replay.counts().replayedCalls).toBe(0);
  }));

it("reads a genuine historical unsafe v2 receipt as evidence but refuses reuse", async () =>
  temporary(async (root) => {
    const historical = JSON.parse(
      readFileSync(
        new URL("../../../../fixtures/agent-runtime/historical-unsafe-observer-v2.json", import.meta.url),
        "utf8",
      ),
    );
    expect(historical.sourceHead).toBe("e5551673674bef2bf732bb97f8b375a5274f3ad5");
    expect(historical.observedEffects).toBe(2);
    expect(historical.receipt.observerRevision).toBe("codex-responses-v2");
    const options = { schema: { type: "null" } };
    const fresh = await structuredSdk(options, [rawTurn(['{"value":null}'])]);
    expect(fresh.error).toBeUndefined();
    expect(await resume(fresh.replayRecord, options)).toMatchObject({ value: null, error: undefined, calls: 0 });
    const record = { ...fresh.replayRecord[0]!, structuredReceipt: historical.receipt };
    const file = workflowReplayFile(tempRun(root, "historical"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record) + "\n");
    const evidence = readWorkflowReplayLog(root, "historical");
    expect(evidence[0]).toMatchObject({ structuredReceipt: historical.receipt });
    const result = await resume(evidence, options);
    expect(result.value).toBeUndefined();
    expect(result.calls).toBe(0);
    expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
  }));
