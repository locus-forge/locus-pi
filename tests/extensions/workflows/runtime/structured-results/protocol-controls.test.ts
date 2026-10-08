import { describe, expect, it } from "vitest";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";
const options = { schema: { type: "string" } };
const cause = (result: Awaited<ReturnType<typeof structuredSdk>>) => (result.error as any)?.result?.failureCause;

it("refuses terminal-only phantom research without a second generation", async () => {
  const events: any[] = rawTurn([]);
  events[events.length - 1].response.output.push({
    type: "function_call",
    id: "phantom_item",
    call_id: "phantom_call",
    name: "fixture_work",
    arguments: "{}",
  });
  const result = await structuredSdk(options, [events, rawTurn(['{"value":"known"}'])]);
  expect(result.value).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 1, effects: 0 });
});

it.each(["beforeToolCall", "finishTurn", "prepareRequest"])(
  "refuses lost required %s after a valid candidate",
  async (hook) => {
    const result = await structuredSdk(options, [rawTurn(['{"value":"known"}'])], (session) => {
      session.agent.finishTurn = () => {
        (session.agent as any)[hook] = undefined;
      };
    });
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.counters.generations).toBe(1);
  },
);

describe("structured research terminal membership", () => {
  it.each(["matching", "omitted", "duplicate"])("requires exact %s work set before effects", async (kind) => {
    const research: any[] = JSON.parse(JSON.stringify(rawTurn(["{}"], "completed", [], ["fixture_work"])));
    if (kind === "omitted") research.at(-1).response.output = [];
    if (kind === "duplicate") research.at(-1).response.output.push({ ...research.at(-1).response.output[0] });
    const result = await structuredSdk(options, [research, rawTurn(['{"value":"known"}'])]);
    if (kind === "matching") {
      expect(result.error).toBeUndefined();
      expect(result.value).toBe("known");
      expect(result.counters).toMatchObject({ generations: 2, tools: 2, effects: 1, raw: 10 });
    } else {
      expect(cause(result)).toBe("output-protocol-unknown");
      expect(result.value).toBeUndefined();
      expect(result.acceptance).toBeUndefined();
      expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
    }
  });
});

it("Codex stops at terminal: late wire bytes cannot add executable work", async () => {
  const research: any[] = JSON.parse(JSON.stringify(rawTurn(["{}"], "completed", [], ["fixture_work"])));
  const item = { type: "function_call", id: "late_item", call_id: "late_call", name: "fixture_work", arguments: "{}" };
  research.push(
    { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 1, item },
  );
  const result = await structuredSdk(options, [research, rawTurn(['{"value":"known"}'])]);
  expect(result.error).toBeUndefined();
  expect(result.value).toBe("known");
  expect(result.counters).toMatchObject({ generations: 2, tools: 2, effects: 1, raw: 10 });
});

it("rejects two structured work items sharing one call identity before either executes", async () => {
  const events: any[] = JSON.parse(
    JSON.stringify(rawTurn(["{}", "{}"], "completed", [], ["fixture_work", "fixture_work"])),
  );
  const firstId = events[1].item.call_id;
  const secondId = events[4].item.call_id;
  for (const event of events) {
    if (event.item?.call_id === secondId) event.item.call_id = firstId;
    for (const item of event.response?.output ?? []) if (item.call_id === secondId) item.call_id = firstId;
  }
  const result = await structuredSdk(options, [events, rawTurn(['{"value":"known"}'])]);
  expect(cause(result)).toBe("output-protocol-unknown");
  expect(result.acceptance).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
});

it.each([
  "added-before-terminal",
  "done-before-terminal",
  "added-after-terminal",
  "done-after-terminal",
  "arguments-after-terminal",
  "terminal-duplicate",
])("honors actual SDK dispatch causality for %s", async (kind) => {
  const research: any[] = JSON.parse(JSON.stringify(rawTurn(["{}"], "completed", [], ["fixture_work"])));
  const repeats = kind.startsWith("added")
    ? JSON.parse(JSON.stringify(research.slice(1, 4)))
    : kind.startsWith("done")
      ? [JSON.parse(JSON.stringify(research[3]))]
      : kind.startsWith("arguments")
        ? [JSON.parse(JSON.stringify(research[2]))]
        : [JSON.parse(JSON.stringify(research.at(-1)))];
  if (kind.endsWith("before-terminal")) research.splice(4, 0, ...repeats);
  else research.push(...repeats);
  const result = await structuredSdk(options, [research, rawTurn(['{"value":"known"}'])]);
  // The Codex adapter stops at terminal; bytes after it are never observed or executable.
  const harmless = kind.endsWith("after-terminal") || kind === "terminal-duplicate";
  if (harmless) {
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.counters).toMatchObject({ generations: 2, tools: 2, effects: 1, raw: 10 });
  } else {
    expect(cause(result)).toBe("output-protocol-unknown");
    expect(result.acceptance).toBeUndefined();
    expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
  }
});
