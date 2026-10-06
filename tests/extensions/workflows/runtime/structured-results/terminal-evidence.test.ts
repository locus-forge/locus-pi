import { describe, expect, it } from "vitest";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";

describe("raw terminal reconciliation before any submission-batch dispatch", () => {
  it.each([
    [
      "omitted finalized call",
      (events: any[]) => {
        events.at(-1).response.output = [];
      },
    ],
    [
      "missing response-created identity",
      (events: any[]) => {
        events.shift();
        events.at(-1).response.id = "";
      },
    ],
    [
      "changed response identity",
      (events: any[]) => {
        events.at(-1).response.id += "-other";
      },
    ],
    [
      "changed terminal item id",
      (events: any[]) => {
        events.at(-1).response.output[0].id += "-other";
      },
    ],
    [
      "changed terminal call id",
      (events: any[]) => {
        events.at(-1).response.output[0].call_id += "-other";
      },
    ],
    [
      "changed terminal name",
      (events: any[]) => {
        events.at(-1).response.output[0].name = "fixture_work";
      },
    ],
    [
      "changed terminal arguments",
      (events: any[]) => {
        events.at(-1).response.output[0].arguments = '{"value":false}';
      },
    ],
    [
      "duplicate terminal item",
      (events: any[]) => {
        events.at(-1).response.output.push({ ...events.at(-1).response.output[0] });
      },
    ],
    [
      "missing finalized arguments",
      (events: any[]) => {
        events.splice(2, 2);
      },
    ],
  ] as const)("refuses %s without executing tools or committing evidence", async (_name, mutate) => {
    // Detach each event: the helper shares item objects between done and terminal frames.
    const events = structuredClone(rawTurn(['{"value":null}']));
    // JSON roundtrip intentionally also detaches shared object references.
    const detached: any[] = JSON.parse(JSON.stringify(events));
    mutate(detached);
    const result = await structuredSdk({ schema: { type: "null" } }, [detached, rawTurn(['{"value":null}'])]);
    expect(result.error).toBeDefined();
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.counters).toMatchObject({ generations: 1, effects: 0, tools: 0 });
  });
  it.each([
    ["fixture_work", "workflow_return"],
    ["workflow_return", "fixture_work"],
  ])("rejects mixed %j batch and corrects once without sibling effects", async (...names) => {
    const values = names.map((name) => (name === "workflow_return" ? '{"value":null}' : "{}"));
    const result = await structuredSdk({ schema: { type: "null" } }, [
      rawTurn(values, "completed", [], names),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.value).toBeNull();
    expect(result.counters).toMatchObject({ generations: 2, sessions: 1, effects: 0, tools: 1 });
    expect(result.acceptance?.structuredReceipt?.spent.outputAttempts).toBe(2);
    expect(result.acceptance?.structuredReceipt?.rawTurns[0]?.calls).toMatchObject([{ validation: "rejected" }]);
  });
  it("exhausts repeated mixed batches without dispatching a third generation", async () => {
    const mixed = () => rawTurn(['{"value":null}', "{}"], "completed", [], ["workflow_return", "fixture_work"]);
    const result = await structuredSdk({ schema: { type: "null" } }, [mixed(), mixed(), rawTurn(['{"value":null}'])]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-contract-exhausted" } });
    expect(result.value).toBeUndefined();
    expect(result.counters).toMatchObject({ generations: 2, effects: 0, tools: 0 });
  });
  it("rejects response identity reused across correction turns", async () => {
    const first: any[] = rawTurn(['{"value":"wrong"}']);
    const second: any[] = rawTurn(['{"value":null}']);
    second[0].response.id = first[0].response.id;
    second.at(-1).response.id = first[0].response.id;
    const result = await structuredSdk({ schema: { type: "null" } }, [first, second]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
    expect(result.value).toBeUndefined();
    expect(result.counters.generations).toBe(2);
  });
});
