import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowAgentRequest } from "../../../../../extensions/workflows/runtime/workflow-agent-contract.js";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";

afterEach(() => vi.useRealTimers());
describe("one v4 logical ledger across explicitly eligible pre-dispatch transport retries", () => {
  it("retains remaining time, the same ledger and root physical charges", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const requests: WorkflowAgentRequest[] = [];
    const result = await structuredSdk(
      { schema: { type: "null" }, attempts: 2, timeoutMs: 1000 },
      [rawTurn(['{"value":"wrong"}']), rawTurn(['{"value":null}'])],
      undefined,
      false,
      (request) => {
        requests.push(request);
        if (requests.length > 1) return undefined;
        vi.setSystemTime(400);
        return {
          ok: false,
          status: "failed",
          summary: "Qualified pre-dispatch transport fixture",
          diagnostics: [],
          failureCause: "host-turn-timeout",
          executionMode: "bare",
        };
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBeNull();
    expect(result.counters).toMatchObject({ physical: 2, sessions: 1, generations: 2 });
    expect(requests.map((request) => request.timeoutMs)).toEqual([1000, 600]);
    expect(requests[1]?.structuredCall).toBe(requests[0]?.structuredCall);
    expect(result.acceptance?.structuredReceipt).toMatchObject({
      allowances: { timeoutMs: 1000, outputAttempts: 2 },
      spent: { elapsedMs: 400, outputAttempts: 2 },
    });
  });
  it("cannot spend a fresh child after exhausted elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const result = await structuredSdk(
      { schema: { type: "null" }, attempts: 2, timeoutMs: 1000 },
      [rawTurn(['{"value":null}'])],
      undefined,
      false,
      () => {
        vi.setSystemTime(1001);
        return {
          ok: false,
          status: "failed",
          summary: "Exhausted logical deadline",
          diagnostics: [],
          failureCause: "call-timeout",
          executionMode: "bare",
        };
      },
    );
    expect(result.error).toMatchObject({ result: { failureCause: "call-timeout" } });
    expect(result.counters).toMatchObject({ physical: 1, sessions: 0, generations: 0 });
  });
  it("never gives refusal or uncertain dispatched work a new physical child", async () => {
    for (const terminal of ["disconnect", "incomplete", "failed"] as const) {
      const result = await structuredSdk({ schema: { type: "null" }, attempts: 2 }, [
        rawTurn(['{"value":null}'], terminal),
        rawTurn(['{"value":null}']),
      ]);
      expect(result.value).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.counters).toMatchObject({ physical: 1, sessions: 1, generations: 1 });
    }
  });
});
