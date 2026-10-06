import { VERSION } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
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
      structuredReceipt: { version: 4, validation: "accepted", observerRevision: "codex-responses-v1" },
    });
    const result = await resume(first.replayRecord, options);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.calls).toBe(0);
  });
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
