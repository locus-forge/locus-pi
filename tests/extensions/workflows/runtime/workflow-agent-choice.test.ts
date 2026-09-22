import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  createWorkflowRuntime,
  type WorkflowAgentChoiceOptions,
  type WorkflowAgentOptions,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * A host that carries a shaped result. `choice` no longer travels as parsed final text, so
 * a scripted answer is the canonical JSON the `workflow_return` tool accepted in-session.
 */
function scriptedRuntime(runId: string, answers: string[], attempts = 1) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      const text = answers[requests.length - 1] ?? answers.at(-1) ?? "";
      return {
        ok: true,
        status: "completed",
        summary: "done",
        text,
        diagnostics: [],
        agent: request.agent,
        ...(request.returnContract === undefined
          ? {}
          : { outputAcceptance: { source: "tool" as const, attempts, toolName: "workflow_return" as const } }),
      };
    },
  });
  return { ...runtime, requests };
}

/** A host whose acceptance tool exhausted its clarification turns without a valid value. */
function exhaustedRuntime(runId: string) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      return {
        ok: false,
        status: "failed",
        summary: "Output contract exhausted after 2 attempts",
        failureCause: "output-contract-exhausted",
        diagnostics: [],
      };
    },
  });
  return { ...runtime, requests };
}

describe("agent({ choice }) exact routing output", () => {
  it("returns one declared literal through the same-session acceptance path", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-choice-happy", ['"revise"']);

    const decision = await dsl.agent("Choose the next step.", {
      choice: ["accept", "revise", "blocked"] as const,
      tools: [],
      maxToolCalls: 0,
    });
    const typed: "accept" | "revise" | "blocked" = decision;

    expect(typed).toBe("revise");
    expect(requests[0]?.returnContract?.choices).toEqual(["accept", "revise", "blocked"]);
    expect(requests[0]?.prompt).toContain("workflow_return");
    expect(getJournal().find((line) => line.kind === "agent_end")?.schemaValidation).toEqual({
      status: "valid",
      attempts: 1,
      errors: [],
    });
  });

  it("refuses a value outside the declared set: membership is the consumer's real contract", async () => {
    const { dsl } = scriptedRuntime("agent-choice-off-set", ['"maybe"']);
    await expect(dsl.agent("Route.", { choice: ["accept", "revise"] })).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("accepts a set of forty options: a routing list has no size policy", async () => {
    const options = Array.from({ length: 40 }, (_, index) => `route-${String(index).padStart(2, "0")}`);
    const { dsl, requests } = scriptedRuntime("agent-choice-forty", [JSON.stringify(options[37])]);

    await expect(dsl.agent("Route.", { choice: options })).resolves.toBe("route-37");
    expect(requests[0]?.returnContract?.choices).toHaveLength(40);
  });

  it("accepts an option far longer than the deleted 200-character ceiling", async () => {
    const long = `escalate-because-${"reason ".repeat(60)}`.trim();
    expect(long.length).toBeGreaterThan(200);
    const { dsl } = scriptedRuntime("agent-choice-long-option", [JSON.stringify(long)]);
    await expect(dsl.agent("Route.", { choice: ["accept", long] })).resolves.toBe(long);
  });

  it("uses an explicit fallback only after the contract is exhausted in-session", async () => {
    const fallback = exhaustedRuntime("agent-choice-fallback");

    await expect(
      fallback.dsl.agent("Route.", {
        choice: ["compose", "ask_operator"] as const,
        choiceFallback: "compose",
      }),
    ).resolves.toBe("compose");
    expect(fallback.requests).toHaveLength(1);
    expect(fallback.getJournal().at(-1)).toMatchObject({
      kind: "log",
      source: "runtime",
      message: "[workflow:choice]",
      choiceDecision: {
        value: "compose",
        source: "fallback",
        returnVia: "tool",
        attempts: 2,
        reason: "output-contract-exhausted",
      },
    });
  });

  it("does not use the fallback for valid answers or child execution failures", async () => {
    const valid = scriptedRuntime("agent-choice-fallback-unused", ['"ask_operator"']);
    await expect(
      valid.dsl.agent("Route.", {
        choice: ["compose", "ask_operator"] as const,
        choiceFallback: "compose",
      }),
    ).resolves.toBe("ask_operator");
    expect(valid.getJournal().filter((line) => line.choiceDecision !== undefined)).toMatchObject([
      { choiceDecision: { value: "ask_operator", source: "validated", returnVia: "tool" } },
    ]);

    const failed = createWorkflowRuntime({
      runId: "agent-choice-fallback-execution-failure",
      agentRunner: async () => {
        throw new Error("transport unavailable");
      },
    });
    await expect(
      failed.dsl.agent("Route.", {
        choice: ["compose", "ask_operator"] as const,
        choiceFallback: "compose",
      }),
    ).rejects.toThrow("transport unavailable");
  });

  it("states membership as a contract, whether written as choice or as a string enum", async () => {
    // These are no longer byte-identical: `choice` states its members in the contract's own
    // `choices` field, a hand-written schema states them as an `enum`. Byte identity was a
    // property of the deleted text transport, where `choice` was literally desugared into a
    // schema before the prompt was built. What MUST stay identical is the decision: both
    // forms accept exactly a declared member and refuse anything else.
    const choice = scriptedRuntime("agent-choice-equivalence", ['"accept"']);
    const schema = scriptedRuntime("agent-schema-equivalence", ['"accept"']);

    await expect(choice.dsl.agent("Route.", { choice: ["accept", "revise"], label: "route" })).resolves.toBe("accept");
    await expect(
      schema.dsl.agent("Route.", { schema: { type: "string", enum: ["accept", "revise"] }, label: "route" }),
    ).resolves.toBe("accept");
    expect(choice.requests[0]?.returnContract?.choices).toEqual(["accept", "revise"]);
    expect(schema.requests[0]?.returnContract?.schema).toEqual({ type: "string", enum: ["accept", "revise"] });

    for (const runtime of [scriptedRuntime("choice-off", ['"maybe"']), scriptedRuntime("schema-off", ['"maybe"'])]) {
      const off = await runtime.dsl
        .agent("Route.", { choice: ["accept", "revise"] })
        .then(() => undefined)
        .catch((error: unknown) => error);
      expect(off).toBeInstanceOf(SchemaValidationError);
    }
  });

  it.each([
    [{ choice: "accept" }, /agent choice must be an array of strings/u],
    [{ choice: ["accept"] }, /agent choice must contain at least 2 values/u],
    [{ choice: ["accept", ""] }, /value at index 1 must be a non-empty string/u],
    [{ choice: ["accept", "accept"] }, /duplicate value "accept"/u],
    [{ choice: ["accept", "revise"], schema: { type: "string" } }, /cannot be combined with schema/u],
    [{ choiceFallback: "accept" }, /agent choiceFallback requires choice/u],
    [
      { choice: ["accept", "revise"], choiceFallback: "blocked" },
      /agent choiceFallback must be one of the declared choices/u,
    ],
    [{ choice: ["accept", "revise"], choiceFallback: 1 }, /agent choiceFallback must be a string/u],
    [{ choice: ["accept", "revise"], returnVia: "text" }, /returnVia: "text" was removed/u],
  ])("rejects malformed declaration %# before any child runs", async (opts, error) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-choice-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect((dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("Route.", opts)).rejects.toThrow(
      error,
    );
    expect(calls).toBe(0);
  });

  it('accepts returnVia: "tool" for one release and says it is redundant', async () => {
    const { dsl, getJournal } = scriptedRuntime("agent-choice-returnvia-tool", ['"accept"']);
    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("Route.", {
        choice: ["accept", "revise"],
        returnVia: "tool",
      }),
    ).resolves.toBe("accept");
    expect(getJournal().some((line) => line.message?.includes("[workflow:deprecated] agent returnVia"))).toBe(true);
  });

  it("keeps choice out of exact-text and shaped option types", () => {
    const choiceOptions: WorkflowAgentChoiceOptions<["accept", "revise"]> = {
      choice: ["accept", "revise"],
      choiceFallback: "revise",
    };
    expect(choiceOptions.choice).toEqual(["accept", "revise"]);

    const invalidChoiceFallback: WorkflowAgentChoiceOptions<["accept", "revise"]> = {
      choice: ["accept", "revise"],
      // @ts-expect-error choiceFallback must be one of the declared choices
      choiceFallback: "blocked",
    };
    expect(invalidChoiceFallback).toBeDefined();

    // @ts-expect-error choice selects WorkflowAgentChoiceOptions, never WorkflowAgentOptions
    const invalidTextOptions: WorkflowAgentOptions = { choice: ["accept", "revise"] };
    expect(invalidTextOptions).toBeDefined();
  });

  it("accepts runtime-sized and explicitly annotated choice lists", async () => {
    const runtime = scriptedRuntime("agent-choice-dynamic", ['"accept"', '"revise"']);
    const dynamicValues: string[] = ["accept", "revise"];
    const dynamicResult: string = await runtime.dsl.agent("Route dynamically.", { choice: dynamicValues });

    const annotated: WorkflowAgentChoiceOptions = { choice: ["accept", "revise"] };
    const annotatedResult: string = await runtime.dsl.agent("Route from options.", annotated);

    expect(dynamicResult).toBe("accept");
    expect(annotatedResult).toBe("revise");
  });
});

describe("the deleted text dialects of an exact-choice answer", () => {
  // The old text transport accepted a bare word, a backticked word and a schema-echo
  // wrapper, because a final MESSAGE has no way to say "this is the value". A tool call
  // does: the argument is the value. Those readings are gone with the transport, and a
  // host that submits anything but the declared member is a mismatch, not a dialect.
  it.each([["completed"], ["`completed`"], ['{"type":"string","value":"completed"}'], ["```\ncompleted\n```"]])(
    "refuses %s as a choice value",
    async (submitted) => {
      const { dsl } = scriptedRuntime("agent-choice-dialects", [submitted]);
      await expect(dsl.agent("Route.", { choice: ["completed", "failed"] })).rejects.toBeInstanceOf(
        SchemaValidationError,
      );
    },
  );

  it("accepts the member submitted as the value itself", async () => {
    const { dsl } = scriptedRuntime("agent-choice-exact", ['"completed"']);
    await expect(dsl.agent("Route.", { choice: ["completed", "failed"] })).resolves.toBe("completed");
  });
});

describe("the choice fallback as recorded provenance", () => {
  it("fallback has structured provenance and never masks provider failures", async () => {
    for (const failureCause of ["output-contract-exhausted", "provider-error", "output-contract-conflict"] as const) {
      const runtime = createWorkflowRuntime({
        runId: `fallback-${failureCause}`,
        agentRunner: async () => ({
          ok: false,
          status: "failed",
          summary: failureCause,
          diagnostics: [],
          failureCause,
        }),
      });
      const call = runtime.dsl.agent("Classify", {
        label: "route",
        choice: ["yes", "no", "unresolved"],
        choiceFallback: "unresolved",
      });
      if (failureCause !== "output-contract-exhausted") {
        await assert.rejects(call);
        assert.equal(runtime.getJournal().filter((line) => line.choiceDecision !== undefined).length, 0);
      } else {
        assert.equal(await call, "unresolved");
        assert.deepEqual(runtime.getJournal().find((line) => line.choiceDecision)?.choiceDecision, {
          value: "unresolved",
          source: "fallback",
          returnVia: "tool",
          attempts: 2,
          reason: "output-contract-exhausted",
        });
      }
    }
  });
});
