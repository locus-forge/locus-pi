import { describe, expect, it } from "vitest";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";

describe("v4 through real Pi SDK / Codex SSE / Agent loop / workflow storage", () => {
  it("commits a null root in the last allowed initial slot and chains existing hooks", async () => {
    const result = await structuredSdk({ schema: { type: "null" }, repair: { maxAttempts: 1 } }, [
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.value).toBeNull();
    expect(result.counters).toMatchObject({ sessions: 1, generations: 1, priorPrepare: 1, priorFinish: 1, tools: 1 });
    expect(result.acceptance?.structuredReceipt?.spent.outputAttempts).toBe(1);
    expect(Object.isFrozen(result.acceptance?.structuredReceipt)).toBe(true);
    expect(result.journal.find((line) => line.kind === "agent_end")?.outputAcceptance).toEqual({
      source: "tool",
      attempts: 1,
      toolName: "workflow_return",
      contractVersion: 4,
    });
  });
  it("corrects authoritative membership in the same child and succeeds on slot two", async () => {
    const result = await structuredSdk(
      { schema: { type: "string" }, validate: (value) => (value === "known" ? [] : ["Unknown id"]) },
      [rawTurn(['{"value":"unknown"}']), rawTurn(['{"value":"known"}'])],
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("known");
    expect(result.counters).toMatchObject({ sessions: 1, generations: 2, tools: 2, prompts: 2 });
    expect(result.acceptance?.structuredReceipt?.spent.outputAttempts).toBe(2);
    expect(result.acceptance?.structuredReceipt?.spent.toolCalls).toBe(2);
  });
  it("counts a host-rejected missing argument before execute and denies the next generation", async () => {
    const result = await structuredSdk({ schema: { type: "null" }, repair: { maxAttempts: 1 } }, [
      rawTurn(["{}"]),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-contract-exhausted" } });
    expect(result.counters).toMatchObject({ generations: 1, tools: 0 });
    expect(result.acceptance).toBeUndefined();
  });
  it("permits ordinary research before the first return without spending output slots", async () => {
    const result = await structuredSdk(
      { schema: { type: "null" }, repair: { maxAttempts: 1 }, maxTurns: 3, maxToolCalls: 3 },
      [
        rawTurn(["{}"], "completed", [], ["fixture_work"]),
        rawTurn(["{}"], "completed", [], ["fixture_work"]),
        rawTurn(['{"value":null}']),
      ],
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBeNull();
    expect(result.counters).toMatchObject({ generations: 3, sessions: 1, effects: 2 });
    expect(result.acceptance?.structuredReceipt?.spent).toMatchObject({
      assistantTurns: 3,
      outputAttempts: 1,
      toolCalls: 3,
    });
  });
  it("keeps declared assistant-turn allowance across correction", async () => {
    const result = await structuredSdk({ schema: { type: "null" }, maxTurns: 1 }, [
      rawTurn(['{"value":"bad"}']),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "assistant-turn-budget" } });
    expect(result.counters.generations).toBe(1);
  });
  it("keeps the tool allowance across correction and never commits a blocked last return", async () => {
    const result = await structuredSdk({ schema: { type: "null" }, maxToolCalls: 1 }, [
      rawTurn(['{"value":"bad"}']),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "tool-call-budget" } });
    expect(result.counters).toMatchObject({ generations: 2, sessions: 1, tools: 1 });
    expect(result.value).toBeUndefined();
  });
  it("charges disallowed research in a correction turn instead of resetting output allowance", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [
      rawTurn(['{"value":"bad"}']),
      rawTurn(["{}"], "completed", [], ["fixture_work"]),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-contract-exhausted" } });
    expect(result.counters).toMatchObject({ generations: 2, sessions: 1, effects: 0 });
  });
  it.each(["tools", "hook", "route"])(
    "refuses unenforceable actual %s capabilities before prompting",
    async (capability) => {
      const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], (session) => {
        if (capability === "tools") session.setActiveToolsByName = () => {};
        else if (capability === "hook")
          Object.defineProperty(session.agent, "prepareRequest", {
            get: () => undefined,
            set: () => {},
            configurable: true,
          });
        else session.agent.state.model = { ...session.model!, provider: "unsupported-fixture" };
      });
      expect(result.error).toMatchObject({ result: { failureCause: "output-contract-unavailable" } });
      expect(result.counters).toMatchObject({ generations: 0, prompts: 0, effects: 0 });
      expect((result.error as Error).message).toContain("structured v4");
    },
  );
  it("never resolves a structured value after evidence persistence fails", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], undefined, true);
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ message: "fixture storage failed" });
  });
  it("refuses a missing raw hook before prompt", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], (session) => {
      delete (session.agent as any).onProviderStreamEvent;
    });
    expect(result.error).toMatchObject({ result: { failureCause: "output-contract-unavailable" } });
    expect(result.counters).toMatchObject({ generations: 0, prompts: 0, tools: 0 });
  });
  it("fails if a chained callback removes the raw observer after dispatch", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], (session) => {
      session.agent.finishTurn = () => {
        session.agent.onProviderStreamEvent = undefined;
      };
    });
    expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
    expect(result.value).toBeUndefined();
  });
  it("refuses a writable hook that stops observing actual provider events after preflight", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], (session) => {
      session.agent.prepareRequest = () => {
        session.agent.onProviderStreamEvent = () => {};
      };
    });
    expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
    expect(result.counters.generations).toBe(1);
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
  });
  it("does not commit a proposal when a prior host hook blocks its return tool", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])], (session) => {
      session.agent.beforeToolCall = async () => ({ block: true, reason: "fixture policy block" });
    });
    expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
    expect(result.counters.tools).toBe(0);
    expect(result.value).toBeUndefined();
  });
  it.each([
    ["incomplete", rawTurn(['{"value":null}'], "incomplete"), "output-incomplete"],
    ["disconnect", rawTurn(['{"value":null}'], "disconnect"), "output-protocol-unknown"],
    ["provider failure after proposal", rawTurn(['{"value":null}'], "failed"), "provider-error"],
    [
      "refusal after proposal",
      rawTurn(['{"value":null}'], "completed", [
        { type: "response.refusal.done", refusal: "fixture protocol refusal" },
      ]),
      "output-refused",
    ],
    ["refusal before proposal", rawTurn([], "completed", [{ type: "response.refusal.done" }]), "output-refused"],
    ["raw malformed repaired by host", rawTurn(['{"value":"first\nsecond"}']), "output-contract-exhausted"],
    ["fenced JSON", rawTurn(['```json\n{"value":null}\n```']), "output-contract-exhausted"],
  ])("never commits %s or retries its terminal failure", async (_name, events, cause) => {
    const result = await structuredSdk({ schema: { type: "null" }, repair: { maxAttempts: 1 } }, [events as object[]]);
    expect(result.value).toBeUndefined();
    expect(result.acceptance).toBeUndefined();
    expect(result.error).toMatchObject({ result: { failureCause: cause } });
    expect(result.counters.generations).toBe(1);
  });
  it("treats canonical object-order duplicates as one proposal", async () => {
    const result = await structuredSdk({ schema: { type: "object" }, repair: { maxAttempts: 1 } }, [
      rawTurn(['{"value":{"b":2,"a":1}}', '{"value":{"a":1,"b":2}}']),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ a: 1, b: 2 });
    expect(result.acceptance?.structuredReceipt?.spent.outputAttempts).toBe(1);
  });
  it("refuses contradictory array order in an otherwise completed batch", async () => {
    const result = await structuredSdk({ schema: { type: "array", items: { type: "integer" } } }, [
      rawTurn(['{"value":[1,2]}', '{"value":[2,1]}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-contract-conflict" } });
    expect(result.acceptance).toBeUndefined();
  });
  it("charges completed missing-return turns and stays bounded", async () => {
    const result = await structuredSdk({ schema: { type: "null" } }, [
      rawTurn([]),
      rawTurn([]),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "output-contract-exhausted" } });
    expect(result.counters.generations).toBe(2);
  });
  it("checks schema before the author callback and preserves data without coercion", async () => {
    let validations = 0;
    const result = await structuredSdk(
      {
        schema: { type: "number" },
        validate: () => {
          validations++;
          return [];
        },
      },
      [rawTurn(['{"value":"2"}']), rawTurn(['{"value":2}'])],
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(2);
    expect(validations).toBe(1);
  });
  it.each([
    () => {
      throw new Error("author error");
    },
    () => Promise.resolve([]),
    () => Promise.reject(new Error("async author error")),
    () => [""],
    () => new Array(1),
    (value: any) => {
      try {
        value.n = 2;
      } catch {}
      return [];
    },
    (value: any) => {
      try {
        value.child.n = 2;
      } catch {}
      return [];
    },
  ])("never repairs an author validator failure", async (validate) => {
    const result = await structuredSdk({ schema: { type: "object" }, validate: validate as never }, [
      rawTurn(['{"value":{"n":1,"child":{"n":1}}}']),
      rawTurn(['{"value":{}}']),
    ]);
    expect(result.error).toMatchObject({ result: { failureCause: "author-validation-error" } });
    expect(result.counters.generations).toBe(1);
  });
});

describe("raw terminal reconciliation before submission-batch dispatch", () => {
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
    const receipt = result.acceptance?.structuredReceipt;
    expect(receipt?.version).toBe(4);
    if (receipt?.version !== 4) throw new Error("missing v4 receipt");
    expect(receipt.rawTurns[0]?.calls).toMatchObject([{ validation: "rejected" }]);
  });
  it.each([
    ["{}", '{"value":"wrong"}'],
    ['{"value":null}', '{"value":false}'],
  ])("classifies multiple returns in one mixed batch before individual validation: %j", async (...values) => {
    const result = await structuredSdk({ schema: { type: "null" } }, [
      rawTurn(["{}", ...values], "completed", [], ["fixture_work", "workflow_return", "workflow_return"]),
      rawTurn(['{"value":null}']),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.value).toBeNull();
    expect(result.counters).toMatchObject({ generations: 2, sessions: 1, effects: 0, tools: 1 });
    expect(result.acceptance?.structuredReceipt?.spent.outputAttempts).toBe(2);
    const receipt = result.acceptance?.structuredReceipt;
    expect(receipt?.version).toBe(4);
    if (receipt?.version !== 4) throw new Error("missing v4 receipt");
    expect(receipt.rawTurns[0]?.calls).toMatchObject([{ validation: "rejected" }, { validation: "rejected" }]);
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

it("rejects a prior return call identity reused in a later mixed batch before correction/effects", async () => {
  const first: any[] = JSON.parse(JSON.stringify(rawTurn(['{"value":"bad"}'])));
  const mixed: any[] = JSON.parse(
    JSON.stringify(rawTurn(["{}", '{"value":null}'], "completed", [], ["fixture_work", "workflow_return"])),
  );
  const priorId = first[1].item.call_id;
  const repeatedId = mixed[4].item.call_id;
  for (const event of mixed) {
    if (event.item?.call_id === repeatedId) event.item.call_id = priorId;
    for (const item of event.response?.output ?? []) if (item.call_id === repeatedId) item.call_id = priorId;
  }
  const result = await structuredSdk({ schema: { type: "null" }, repair: { maxAttempts: 3 } }, [
    first,
    mixed,
    rawTurn(['{"value":null}']),
  ]);
  expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
  expect(result.value).toBeUndefined();
  expect(result.acceptance).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 2, tools: 1, effects: 0 });
});

it.each(["workflow_return", "fixture_work"])("rejects distinct %s items sharing one call identity", async (name) => {
  const raw = name === "workflow_return" ? '{"value":null}' : "{}";
  const events: any[] = JSON.parse(JSON.stringify(rawTurn([raw, raw], "completed", [], [name, name])));
  const firstId = events[1].item.call_id;
  const secondId = events[4].item.call_id;
  for (const event of events) {
    if (event.item?.call_id === secondId) event.item.call_id = firstId;
    for (const item of event.response?.output ?? []) if (item.call_id === secondId) item.call_id = firstId;
  }
  const result = await structuredSdk({ schema: { type: "null" } }, [events, rawTurn(['{"value":null}'])]);
  expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
  expect(result.acceptance).toBeUndefined();
  expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
});

it.each(["added", "done", "arguments", "terminal"])(
  "honors real v4 SDK dispatch for repeated %s evidence",
  async (kind) => {
    const research: any[] = JSON.parse(JSON.stringify(rawTurn(["{}"], "completed", [], ["fixture_work"])));
    const repeats =
      kind === "added"
        ? JSON.parse(JSON.stringify(research.slice(1, 4)))
        : [JSON.parse(JSON.stringify(research[kind === "done" ? 3 : kind === "arguments" ? 2 : 4]))];
    if (kind === "terminal") research.push(...repeats);
    else research.splice(4, 0, ...repeats);
    const result = await structuredSdk({ schema: { type: "null" } }, [research, rawTurn(['{"value":null}'])]);
    if (kind === "arguments" || kind === "terminal") {
      expect(result.error).toBeUndefined();
      expect(result.value).toBeNull();
      expect(result.counters).toMatchObject({ generations: 2, tools: 2, effects: 1 });
    } else {
      expect(result.error).toMatchObject({ result: { failureCause: "output-protocol-unknown" } });
      expect(result.acceptance).toBeUndefined();
      expect(result.counters).toMatchObject({ generations: 1, tools: 0, effects: 0 });
    }
  },
);
