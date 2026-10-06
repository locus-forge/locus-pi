import { describe, expect, it } from "vitest";
import { rawTurn, structuredSdk, nativeTurn } from "../../../../../fixtures/agent-runtime/structured-sdk.js";
import { projectNativeWorkflowSchema } from "../../../../../../extensions/workflows/runtime/structured-results/native-response.js";

const options = { schema: { type: "string" }, outputTransport: "native" as const };
const cause = (result: Awaited<ReturnType<typeof structuredSdk>>) => (result.error as any)?.result?.failureCause;
const signatures = (messages: any[]) =>
  messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((part) => part.textSignature)
    .map((part) => JSON.parse(part.textSignature));

it("sends truthful native final-answer instructions in the actual SDK request", async () => {
  const result = await structuredSdk(options, [nativeTurn()]);
  const input = JSON.stringify((result.payloads[0] as any).input);
  expect(input).toContain("native JSON schema supplied by the runtime");
  expect(input).not.toContain("return tool specified");
  expect(input).not.toContain("Your final message is not the result");
  expect(input).not.toContain("Do not wrap the result in JSON");
});

it.each(["getActiveToolNames", "setActiveToolsByName"])(
  "reports truthful native missing %s capability",
  async (method) => {
    const result = await structuredSdk(options, [nativeTurn()], (session) => {
      (session as any)[method] = undefined;
    });
    expect(cause(result)).toBe("output-contract-unavailable");
    expect((result.error as Error).message).toContain("native v5");
    expect((result.error as Error).message).not.toContain("registered return tool");
    expect(result.counters.generations).toBe(0);
  },
);

it.each(["message-phase", "message-text", "context", "newMessages"])(
  "refuses inherited finish mutations of native history: %s",
  async (kind) => {
    const result = await structuredSdk(options, [nativeTurn()], (session) => {
      session.agent.finishTurn = (turn) => {
        const part = turn.message.content.find((part: any) => part.type === "text") as any;
        if (kind === "message-phase")
          part.textSignature = JSON.stringify({ ...JSON.parse(part.textSignature), phase: "commentary" });
        if (kind === "message-text") part.text = "changed outside raw evidence";
        if (kind === "context")
          turn.context.messages = turn.context.messages.filter((m: any) => m.role !== "assistant");
        if (kind === "newMessages") turn.newMessages = turn.newMessages.filter((m: any) => m.role !== "assistant");
      };
    });
    expect(cause(result)).toBe("output-protocol-unknown");
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.counters.generations).toBe(1);
  },
);

it.each(["toJSON", "getter"])("refuses dynamic inherited payload serialization: %s", async (kind) => {
  const result = await structuredSdk(options, [nativeTurn()], (session) => {
    session.agent.onPayload = (payload: any) => {
      if (kind === "toJSON")
        return {
          ...payload,
          toJSON() {
            return { model: "different-model", stream: true, input: payload.input, tools: payload.tools };
          },
        };
      let reads = 0;
      return {
        ...payload,
        get model() {
          return ++reads === 1 ? payload.model : "different-model";
        },
      };
    };
  });
  expect(cause(result)).toBe("output-contract-unavailable");
  expect((result.error as Error).message).toContain("structured v5");
  expect(result.value).toBeUndefined();
  expect(result.acceptance).toBeUndefined();
  expect(result.counters.generations).toBe(0);
});

describe("native output through actual Pi public Responses SDK", () => {
  it.each(["final_answer", "absent", null])("accepts truthful %s phase without a return tool", async (phase) => {
    const result = await structuredSdk({ ...options, repair: { maxAttempts: 1 } }, [nativeTurn(undefined, phase)]);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.counters).toMatchObject({ generations: 1, sessions: 1, prompts: 1, tools: 0 });
    expect(result.acceptance).toMatchObject({
      source: "native",
      contractVersion: 5,
      attempts: 1,
      structuredReceipt: { version: 5, spent: { outputAttempts: 1, toolCalls: 0 } },
    });
    expect(result.acceptance).not.toHaveProperty("toolName");
    const receipt = result.acceptance!.structuredReceipt!;
    expect(receipt.rawTurns[0]).not.toHaveProperty("calls");
    const evidence = (receipt.rawTurns[0] as any).output;
    const memory = signatures(result.messages)[0];
    const disk = signatures(
      result.persisted.filter((entry: any) => entry.type === "message").map((entry: any) => entry.message),
    )[0];
    for (const recorded of [evidence, memory, disk]) {
      expect(Object.hasOwn(recorded, "phase")).toBe(phase !== "absent");
      if (phase !== "absent") expect(recorded.phase).toBe(phase);
    }
    expect(result.urls).toEqual(["https://api.openai.com/v1/responses"]);
  });

  it("chains inherited payload first and preserves tools, input and verbosity", async () => {
    let inherited = 0;
    const result = await structuredSdk(options, [nativeTurn()], (session) => {
      session.agent.onPayload = (payload) => {
        inherited++;
        return { ...(payload as object), text: { verbosity: "low" } };
      };
    });
    expect(result.error).toBeUndefined();
    expect(inherited).toBe(1);
    const payload = result.payloads[0] as any;
    expect(payload.model).toBe("gpt-6.1-sol");
    expect(payload.stream).toBe(true);
    expect(payload.input.length).toBeGreaterThan(0);
    expect(payload.tools.map((tool: any) => tool.name)).toEqual(["fixture_work"]);
    expect(payload.text).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "locus_workflow_result",
        strict: true,
        schema: projectNativeWorkflowSchema(options.schema),
      },
    });
  });

  it.each(["commentary", "unknown-phase"])("refuses %s without a correction generation", async (phase) => {
    const result = await structuredSdk(options, [nativeTurn(undefined, phase), nativeTurn()]);
    expect(cause(result)).toBe("output-protocol-unknown");
    expect(result.counters.generations).toBe(1);
    expect(result.value).toBeUndefined();
  });

  it("corrects domain rejection in the same session, preserving raw null in the next payload", async () => {
    const result = await structuredSdk(
      { ...options, validate: (value: unknown) => (value === "known" ? [] : ["Use an authoritative ID"]) },
      [nativeTurn('{"value":"invented"}', null), nativeTurn()],
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.counters).toMatchObject({ sessions: 1, generations: 2, prompts: 2, effects: 0, tools: 0 });
    const correction = result.payloads[1] as any;
    expect(correction.tool_choice).toBe("none");
    expect(correction.tools ?? []).toEqual([]);
    expect(correction.input.find((item: any) => item.type === "message" && item.role === "assistant").phase).toBeNull();
    expect(result.acceptance?.structuredReceipt?.spent.outputAttempts).toBe(2);
  });

  it("research turns execute effects once without spending output slots", async () => {
    const result = await structuredSdk({ ...options, repair: { maxAttempts: 1 }, maxTurns: 3, maxToolCalls: 2 }, [
      rawTurn(["{}"], "completed", [], ["fixture_work"]),
      rawTurn(["{}"], "completed", [], ["fixture_work"]),
      nativeTurn(),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.counters).toMatchObject({ sessions: 1, generations: 3, effects: 2 });
    expect(result.acceptance?.structuredReceipt?.spent).toMatchObject({
      assistantTurns: 3,
      toolCalls: 2,
      outputAttempts: 1,
    });
  });

  it("charges unexpected correction tools and missing output, and stops before a third generation", async () => {
    for (const second of [
      rawTurn(["{}"], "completed", [], ["fixture_work"]),
      rawTurn([]),
      nativeTurn('{"value":false}'),
    ]) {
      const result = await structuredSdk(options, [nativeTurn('{"value":false}'), second, nativeTurn()]);
      expect(cause(result)).toBe("output-contract-exhausted");
      expect(result.counters).toMatchObject({ generations: 2, effects: 0, tools: 0 });
      expect(result.value).toBeUndefined();
    }
  });

  it.each(["incomplete", "failed", "disconnect"])("never accepts a candidate from %s", async (terminal) => {
    const result = await structuredSdk(options, [nativeTurn(undefined, "final_answer", terminal)]);
    expect(result.error).toBeDefined();
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.counters.generations).toBe(1);
  });

  it.each(["onPayload", "onProviderStreamEvent", "prepareRequest", "finishTurn", "beforeToolCall"])(
    "requires actual writable %s before prompting",
    async (hook) => {
      const result = await structuredSdk(options, [nativeTurn()], (session) => {
        Object.defineProperty(session.agent, hook, { get: () => undefined, set: () => {}, configurable: true });
      });
      expect(cause(result)).toBe("output-contract-unavailable");
      expect((result.error as Error).message).toContain("structured v5");
      expect((result.error as Error).message).not.toContain("openai-codex");
      expect(result.counters).toMatchObject({ generations: 0, prompts: 0 });
    },
  );

  it.each(["format", "model", "stream", "route", "replace"])(
    "fails incompatible prior payload %s without dispatch",
    async (kind) => {
      const result = await structuredSdk(options, [nativeTurn()], (session) => {
        session.agent.onPayload = (payload, model) => {
          const value = payload as any;
          if (kind === "format") value.text = { format: { type: "json_schema", name: "foreign" } };
          if (kind === "model") value.model = "different";
          if (kind === "stream") value.stream = false;
          if (kind === "route") (model as any).baseUrl = "https://opaque.invalid/v1";
          if (kind === "replace") session.agent.onPayload = undefined;
          return value;
        };
      });
      expect(result.error).toBeDefined();
      expect(result.counters.generations).toBe(0);
      expect(result.acceptance).toBeUndefined();
    },
  );

  it("denies lost observers and persistence failure after a valid candidate", async () => {
    const lost = await structuredSdk(options, [nativeTurn()], (session) => {
      session.agent.finishTurn = () => {
        session.agent.onPayload = undefined;
      };
    });
    expect(lost.value).toBeUndefined();
    expect(lost.acceptance).toBeUndefined();
    const failedStore = await structuredSdk(options, [nativeTurn()], undefined, true);
    expect(failedStore.error).toMatchObject({ message: "fixture storage failed" });
    expect(failedStore.value).toBeUndefined();
  });
});

describe("native canonical acceptance and raw identity failures", () => {
  it.each([
    [{ type: "boolean" }, true],
    [{ type: "number", minimum: 0, maximum: 2 }, 1],
    [{ type: "integer", enum: [9007199254740992] }, 9007199254740992],
    [{ type: "array", items: { type: "boolean" }, minItems: 1 }, [true]],
    [
      { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      { id: "known" },
    ],
  ])("returns exact supported canonical root %j", async (schema, value) => {
    const result = await structuredSdk({ schema: schema as any, outputTransport: "native" }, [
      nativeTurn(JSON.stringify({ value })),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(value);
    if (typeof value === "object") expect(Object.isFrozen(result.value)).toBe(true);
  });
  it.each(["throw", "promise", "sparse", "mutation"])("author %s failure is terminal", async (kind) => {
    const result = await structuredSdk(
      {
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        outputTransport: "native",
        validate: (value: any) => {
          if (kind === "throw") throw new Error("Author bug");
          if (kind === "promise") return Promise.resolve([]) as any;
          if (kind === "sparse") return new Array(1);
          try {
            value.id = "mutated";
          } catch {}
          return [];
        },
      },
      [nativeTurn('{"value":{"id":"known"}}'), nativeTurn()],
    );
    expect(cause(result)).toBe("author-validation-error");
    expect(result.counters.generations).toBe(1);
  });
  it.each(["terminal-id", "terminal-text", "multiple-messages", "multiple-parts", "partial", "refusal"])(
    "refuses raw %s ambiguity without accepting normalized text",
    async (kind) => {
      const events: any[] = nativeTurn();
      const terminal = events[events.length - 1].response;
      if (kind === "terminal-id") terminal.id = "different";
      if (kind === "terminal-text")
        terminal.output = structuredClone(terminal.output).map((item: any) => ({
          ...item,
          content: [{ type: "output_text", text: '{"value":"other"}' }],
        }));
      if (kind === "multiple-messages") terminal.output.push({ ...terminal.output[0], id: "second" });
      if (kind === "multiple-parts") terminal.output[0].content.push({ type: "output_text", text: "extra" });
      if (kind === "partial") events.splice(3, 1);
      if (kind === "refusal") events.splice(3, 0, { type: "response.refusal.done" });
      const result = await structuredSdk(options, [events, nativeTurn()]);
      expect(result.error).toBeDefined();
      expect(result.value).toBeUndefined();
      expect(result.counters.generations).toBe(1);
    },
  );
  it("keeps the declared turn budget across native correction", async () => {
    const result = await structuredSdk({ ...options, maxTurns: 1 }, [nativeTurn('{"value":false}'), nativeTurn()]);
    expect(cause(result)).toBe("assistant-turn-budget");
    expect(result.counters.generations).toBe(1);
  });
});

it.each(["added-phase", "done-text", "duplicate-conflict", "history-text"])(
  "refuses native %s disagreement",
  async (kind) => {
    const events: any[] = nativeTurn();
    if (kind === "added-phase") events[1].item.phase = "commentary";
    if (kind === "done-text")
      events.splice(3, 0, { type: "response.output_text.done", item_id: events[1].item.id, text: "different" });
    if (kind === "duplicate-conflict") {
      const terminal = structuredClone(events[events.length - 1]);
      terminal.response.output[0].content[0].text = "different";
      events.push(terminal);
    }
    const result = await structuredSdk(
      options,
      kind === "history-text" ? [nativeTurn('{"value":false}', null), nativeTurn()] : [events],
      (session) => {
        if (kind === "history-text")
          session.agent.onPayload = (payload: any) => {
            for (const item of payload.input) if (item.role === "assistant") item.content[0].text = "different";
            return payload;
          };
      },
    );
    expect(result.error).toBeDefined();
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.counters.generations).toBe(1);
  },
);

it("refuses added work evidence on a duplicate terminal, rather than commit an invalid receipt", async () => {
  const events: any[] = nativeTurn();
  const changed = structuredClone(events[events.length - 1]);
  changed.response.output.push({
    type: "function_call",
    id: "phantom_item",
    call_id: "phantom_call",
    name: "fixture_work",
    arguments: "{}",
  });
  events.push(changed);
  const result = await structuredSdk(options, [events]);
  expect(result.value).toBeUndefined();
  expect(result.acceptance).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 1, effects: 0 });
});

it("refuses terminal-only phantom research without a second generation", async () => {
  const events: any[] = rawTurn([]);
  events[events.length - 1].response.output.push({
    type: "function_call",
    id: "phantom_item",
    call_id: "phantom_call",
    name: "fixture_work",
    arguments: "{}",
  });
  const result = await structuredSdk(options, [events, nativeTurn()]);
  expect(result.value).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 1, effects: 0 });
});

it.each(["beforeToolCall", "finishTurn", "prepareRequest"])(
  "refuses lost required %s after a valid candidate",
  async (hook) => {
    const result = await structuredSdk(options, [nativeTurn()], (session) => {
      session.agent.finishTurn = () => {
        (session.agent as any)[hook] = undefined;
      };
    });
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.counters.generations).toBe(1);
  },
);

describe("native research terminal membership", () => {
  it.each(["matching", "omitted", "duplicate"])("requires exact %s work set before effects", async (kind) => {
    const research: any[] = JSON.parse(JSON.stringify(rawTurn(["{}"], "completed", [], ["fixture_work"])));
    if (kind === "omitted") research.at(-1).response.output = [];
    if (kind === "duplicate") research.at(-1).response.output.push({ ...research.at(-1).response.output[0] });
    const result = await structuredSdk(options, [research, nativeTurn()]);
    if (kind === "matching") {
      expect(result.error).toBeUndefined();
      expect(result.value).toBe("known");
      expect(result.counters).toMatchObject({ generations: 2, tools: 1, effects: 1 });
    } else {
      expect(cause(result)).toBe("output-protocol-unknown");
      expect(result.value).toBeUndefined();
      expect(result.acceptance).toBeUndefined();
      expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
    }
  });
});

it("rejects new native work evidence after the terminal set before any sibling executes", async () => {
  const research: any[] = JSON.parse(JSON.stringify(rawTurn(["{}"], "completed", [], ["fixture_work"])));
  const item = { type: "function_call", id: "late_item", call_id: "late_call", name: "fixture_work", arguments: "{}" };
  research.push(
    { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 1, item },
  );
  const result = await structuredSdk(options, [research, nativeTurn()]);
  expect(cause(result)).toBe("output-protocol-unknown");
  expect(result.value).toBeUndefined();
  expect(result.acceptance).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
});

it("rejects two native work items sharing one call identity before either executes", async () => {
  const events: any[] = JSON.parse(
    JSON.stringify(rawTurn(["{}", "{}"], "completed", [], ["fixture_work", "fixture_work"])),
  );
  const firstId = events[1].item.call_id;
  const secondId = events[4].item.call_id;
  for (const event of events) {
    if (event.item?.call_id === secondId) event.item.call_id = firstId;
    for (const item of event.response?.output ?? []) if (item.call_id === secondId) item.call_id = firstId;
  }
  const result = await structuredSdk(options, [events, nativeTurn()]);
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
  const result = await structuredSdk(options, [research, nativeTurn()]);
  const harmless = kind === "arguments-after-terminal" || kind === "terminal-duplicate";
  if (harmless) {
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.counters).toMatchObject({ generations: 2, tools: 1, effects: 1 });
  } else {
    expect(cause(result)).toBe("output-protocol-unknown");
    expect(result.acceptance).toBeUndefined();
    expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
  }
});
