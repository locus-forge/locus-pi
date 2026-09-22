import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  createWorkflowRuntime,
  type WorkflowAgentOptions,
  type WorkflowAgentSchemaOptions,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { scriptedRuntime } from "../../../fixtures/scripted-agent-runtime.js";

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
} as const;

describe("agent({ schema }) structured output", () => {
  it("returns the validated value and records a valid shape check on agent_end", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-happy", ['{"answer":"yes"}']);

    const value = await dsl.agent("Is the diff reviewable?", {
      schema: { ...VERDICT_SCHEMA },
      label: "gate",
    });

    expect(value).toEqual({ answer: "yes" });
    expect(requests).toHaveLength(1);
    // The child is told the contract; the acceptance tool in its own session enforces it.
    expect(requests[0]?.prompt).toContain("Is the diff reviewable?");
    expect(requests[0]?.prompt).toContain("workflow_return");
    expect(requests[0]?.returnContract?.schema).toEqual(VERDICT_SCHEMA);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.schemaValidation).toEqual({ status: "valid", attempts: 1, errors: [] });
  });

  it("states the clarification allowance in the contract and in the journal", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-clarifications", ['{"answer":"yes"}']);
    await dsl.agent("Decide.", { label: "gate", schema: { ...VERDICT_SCHEMA } });

    // Visible to the child…
    expect(requests[0]?.returnContract?.maxAttempts).toBe(2);
    expect(requests[0]?.prompt).toContain("1 same-session correction turn(s)");
    // …and visible to the operator, naming it as the package default rather than hiding it.
    expect(
      getJournal().some(
        (line) => line.message?.includes("[workflow:return] gate") && line.message.includes("package default 1"),
      ),
    ).toBe(true);
  });

  it("carries an author-declared clarification budget with no upper bound", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-repair-declared", ['{"answer":"yes"}']);
    await dsl.agent("Decide.", {
      label: "gate",
      schema: { ...VERDICT_SCHEMA },
      repair: { maxAttempts: 9, clarification: "Name the branch you chose." },
    });
    expect(requests[0]?.returnContract?.maxAttempts).toBe(9);
    expect(getJournal().some((line) => line.message?.includes("8 same-session clarification turn(s) (declared)"))).toBe(
      true,
    );
  });

  it("fails closed with SchemaValidationError on an off-shape accepted value, in ONE child", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-fail-closed", ['{"answer":"maybe"}']);

    let caught: unknown;
    try {
      await dsl.agent("Is the diff reviewable?", { schema: { ...VERDICT_SCHEMA } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SchemaValidationError);
    const failure = caught as SchemaValidationError;
    expect(failure.name).toBe("SchemaValidationError");
    expect(failure.errors.join(" ")).toContain("not in enum");
    // No fresh child is spawned to fix the form of an answer this one already produced.
    expect(requests).toHaveLength(1);
    expect(
      getJournal().every((line) => line.kind !== "agent_end" || line.schemaValidation?.status === "mismatch"),
    ).toBe(true);
  });

  it("propagates a child run failure without spending a schema retry", async () => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-child-failure",
      agentRunner: async (request) => {
        calls += 1;
        return {
          ok: false,
          status: "failed" as const,
          summary: "child exploded",
          diagnostics: ["child exploded"],
          agent: request.agent,
        };
      },
    });

    await expect(dsl.agent("Is the diff reviewable?", { schema: { ...VERDICT_SCHEMA } })).rejects.toThrow(
      /child exploded/u,
    );
    expect(calls).toBe(1);
  });

  it("leaves a call without a schema completely unchanged", async () => {
    const exactText = 'The reviewer says: {"answer":"maybe"} — but this is prose.';
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-absent", [exactText]);

    const text = await dsl.agent("Summarize the review.", { label: "summary" });

    expect(text).toBe(exactText);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("Summarize the review.");
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.schemaValidation).toBeUndefined();
  });

  it("rejects a non-object schema before any child runs", async () => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(
      // Workflow scripts are untyped JavaScript; the guard is the runtime's, not the compiler's.
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("shape me", { schema: "not-a-schema" }),
    ).rejects.toThrow(/agent schema must be a JSON-schema object/u);
    expect(calls).toBe(0);
  });

  it("accepts an integer answer and rejects a fractional one with a value-bearing error", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["count"],
      properties: { count: { type: "integer" } },
    } as const;

    const good = scriptedRuntime("agent-schema-integer-ok", ['{"count":3}']);
    await expect(good.dsl.agent("How many blocking findings?", { schema: { ...schema } })).resolves.toEqual({
      count: 3,
    });

    const bad = scriptedRuntime("agent-schema-integer-bad", ['{"count":2.5}']);
    await expect(bad.dsl.agent("How many blocking findings?", { schema: { ...schema } })).rejects.toThrow(
      "count: expected integer, got 2.5",
    );
    expect(bad.requests).toHaveLength(1);
  });

  it("names every AUTHOR-declared bound it breaks: these are consumer contracts, not budgets", async () => {
    // `maxItems`, `maxLength`, `pattern` inside a schema stay: an author who declares one
    // owns it as a real requirement of the next consumer. What is gone is the runtime
    // adding bounds nobody declared.
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["id", "tags", "summary"],
      properties: {
        id: { type: "string", pattern: "^W[1-9][0-9]*$" },
        tags: { type: "array", items: { type: "string" }, maxItems: 2 },
        summary: { type: "string", minLength: 1 },
      },
    } as const;

    const bad = scriptedRuntime("agent-schema-bounds", ['{"id":"w1","tags":["a","b","c"],"summary":""}']);
    const failure = await bad.dsl
      .agent("Name the unit.", { schema: { ...schema } })
      .then(() => undefined)
      .catch((error: unknown) => error);
    const reported = (failure as Error).message;
    expect(reported).toContain('id: value "w1" does not match pattern ^W[1-9][0-9]*$');
    expect(reported).toContain("tags: expected at most 2 item(s), got 3");
    expect(reported).toContain("summary: expected at least 1 character(s), got 0");

    const good = scriptedRuntime("agent-schema-bounds-ok", ['{"id":"W1","tags":["a","b"],"summary":"ok"}']);
    await expect(good.dsl.agent("Name the unit.", { schema: { ...schema } })).resolves.toEqual({
      id: "W1",
      tags: ["a", "b"],
      summary: "ok",
    });
  });

  it.each([
    [{ type: "string", maxLength: 12.5 }, /maxLength must be a non-negative safe integer/u],
    [{ type: "string", maxLength: -1 }, /maxLength must be a non-negative safe integer/u],
    [{ type: "string", minLength: 9, maxLength: 4 }, /minLength 9 exceeds maxLength 4/u],
    [{ type: "array", items: { type: "string" }, minItems: 3, maxItems: 2 }, /minItems 3 exceeds maxItems 2/u],
    [{ type: "object", properties: {}, maxLength: 4 }, /maxLength is only valid for a string schema/u],
    [{ type: "string", maxItems: 4 }, /maxItems is only valid for an array schema/u],
    [{ type: "string", pattern: "(" }, /pattern is not a valid regular expression/u],
    [{ type: "string", pattern: 7 }, /pattern must be a string/u],
    [{ type: "integer", enum: [1, 1.5] }, /enum value at index 1 does not match declared type integer/u],
    [{ type: "object", required: "answer", properties: {} }, /required must be an array/u],
    [{ type: "object", required: ["answer", "answer"], properties: {} }, /required contains duplicate/u],
    [{ type: "object", required: ["missing"], properties: {} }, /not declared in properties/u],
    [{ type: "object", properties: { answer: "string" } }, /properties\.answer must be a schema object/u],
    [{ type: "array" }, /array schema must declare items/u],
    [{ type: "array", items: { type: "string", minItems: 1 } }, /schema\.items: minItems is only valid for an array/u],
    [{ type: "string", additionalProperties: false }, /additionalProperties is only valid/u],
    [{ type: "string", enum: "yes" }, /enum must be a non-empty array/u],
    [{ enum: [{ answer: "yes" }] }, /enum value at index 0 must be a JSON primitive/u],
    [{ enum: [Number.NaN] }, /enum value at index 0 must be a JSON primitive/u],
    [{ type: "string", enum: ["yes", 1] }, /enum value at index 1 does not match declared type string/u],
    [{ type: "object", enum: [null] }, /enum value at index 0 does not match declared type object/u],
  ])("rejects an unsupported or malformed declaration before any child runs", async (schema, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-declaration-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("shape me", { schema }),
    ).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("keeps the text options type unable to carry a schema", () => {
    const textOptions: WorkflowAgentOptions = { label: "text" };
    expect(textOptions).toEqual({ label: "text" });

    // Compile-time contract: adding schema to text options must remain an error.
    // @ts-expect-error schema selects WorkflowAgentSchemaOptions, never WorkflowAgentOptions
    const invalidTextOptions: WorkflowAgentOptions = { schema: { type: "string" } };
    expect(invalidTextOptions).toBeDefined();

    // Same contract for validate: it needs a parsed value, which only the shaped
    // overload has, so a typo cannot silently run unvalidated on the text path.
    // @ts-expect-error validate selects WorkflowAgentSchemaOptions, never WorkflowAgentOptions
    const invalidValidateOptions: WorkflowAgentOptions = { validate: () => [] };
    expect(invalidValidateOptions).toBeDefined();

    // A shaped tool return carries its shape in schema, so the string `output` contract
    // stays unavailable there, and the call stays typed as unknown rather than string.
    const shapedTool: WorkflowAgentSchemaOptions = {
      schema: { ...VERDICT_SCHEMA },
      // @ts-expect-error output is a string-only contract
      output: { type: "string" },
    };
    expect(shapedTool.schema).toEqual(VERDICT_SCHEMA);
  });

  it("keeps a shaped return out of Promise<string>, and runs validate in the same session", async () => {
    const { dsl, requests } = scriptedRuntime("agent-schema-tool-typing", ['{"answer":"yes"}']);
    const never = async (): Promise<void> => {
      // @ts-expect-error a shaped return is never Promise<string>
      const asText: Promise<string> = dsl.agent("x", { schema: VERDICT_SCHEMA });
      expect(asText).toBeDefined();
    };
    expect(never).toBeTypeOf("function");

    // `validate` is no longer refused: its rule is checked beside the schema, inside the
    // child's own session, so a cross-field violation is correctable rather than fatal.
    await expect(
      dsl.agent("Decide.", {
        label: "decide",
        schema: VERDICT_SCHEMA,
        validate: (value) => ((value as { answer: string }).answer === "yes" ? [] : ["must be yes"]),
      }),
    ).resolves.toEqual({ answer: "yes" });
    expect(requests).toHaveLength(1);
  });
});
