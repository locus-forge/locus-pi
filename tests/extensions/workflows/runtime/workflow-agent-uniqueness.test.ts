import { describe, expect, it } from "vitest";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { scriptedRuntime } from "../../../fixtures/scripted-agent-runtime.js";

/**
 * `uniqueItems`, `uniqueTrimmedItems`, `uniqueBy` and `nonBlank` — the four
 * keywords that moved repeated ids, repeated dependencies, colliding option
 * labels and whitespace-only strings out of hand-written script checks. Each of
 * those checks could only `throw` after validation returned, ending the run on
 * an answer the child could have corrected. Declared here they are enforced by the
 * acceptance tool inside the child's own session, so what matters is that the exact
 * message reaches the boundary verbatim — it is the text the child is shown and the
 * text an operator reads when the contract is finally not met.
 */

const DEPENDS_ON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dependsOn"],
  properties: {
    dependsOn: { type: "array", uniqueItems: true, items: { type: "string" } },
  },
} as const;

const OPTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["options"],
  properties: {
    options: { type: "array", uniqueTrimmedItems: true, items: { type: "string" } },
  },
} as const;

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      uniqueBy: "id",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  },
} as const;

const PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: { prompt: { type: "string", nonBlank: true } },
} as const;

describe("agent({ schema }) uniqueness and blankness keywords", () => {
  it.each([
    [
      "uniqueItems",
      DEPENDS_ON_SCHEMA,
      '{"dependsOn":["F1","F2","F1"]}',
      '{"dependsOn":["F1","F2"]}',
      'dependsOn[2]: value "F1" duplicates item 0',
      { dependsOn: ["F1", "F2"] },
    ],
    [
      "uniqueTrimmedItems",
      OPTIONS_SCHEMA,
      '{"options":["a"," a "]}',
      '{"options":["a","b"]}',
      'options[1]: trimmed value "a" duplicates item 0',
      { options: ["a", "b"] },
    ],
    [
      "uniqueBy",
      FINDINGS_SCHEMA,
      '{"findings":[{"id":"F1"},{"id":"F2"},{"id":"F3"},{"id":"F1"}]}',
      '{"findings":[{"id":"F1"}]}',
      'findings[3].id: value "F1" duplicates item 0',
      { findings: [{ id: "F1" }] },
    ],
    [
      "nonBlank",
      PROMPT_SCHEMA,
      '{"prompt":"   "}',
      '{"prompt":"Which base?"}',
      "prompt: expected a non-blank string, got 3 whitespace character(s)",
      { prompt: "Which base?" },
    ],
  ])(
    "names a %s violation verbatim, and accepts the value the contract declares",
    async (keyword, schema, broken, repaired, message, expected) => {
      const rejected = scriptedRuntime(`agent-schema-${keyword}-broken`, [broken]);
      await expect(rejected.dsl.agent("Plan the work.", { schema: { ...schema } })).rejects.toThrow(message);
      // ONE physical child. The correction happens inside its session, against the
      // evidence it already has, instead of in a fresh child that remembers nothing.
      expect(rejected.requests).toHaveLength(1);
      expect(
        rejected.getJournal().flatMap((line) => (line.kind === "agent_end" ? [line.schemaValidation] : [])),
      ).toEqual([{ status: "mismatch", attempts: 1, errors: [message] }]);

      const accepted = scriptedRuntime(`agent-schema-${keyword}-ok`, [repaired]);
      await expect(accepted.dsl.agent("Plan the work.", { schema: { ...schema } })).resolves.toEqual(expected);
      expect(accepted.requests).toHaveLength(1);
    },
  );

  it("accepts under uniqueItems what uniqueTrimmedItems rejects", async () => {
    // The reason the fourth keyword exists: a consumer that trims labels before
    // using them would collapse these two into one, so plain `uniqueItems` ships
    // a value the consumer's own normalizer turns into a duplicate.
    const plain = scriptedRuntime("agent-schema-unique-plain", ['{"dependsOn":["a"," a"]}']);
    await expect(plain.dsl.agent("List them.", { schema: { ...DEPENDS_ON_SCHEMA } })).resolves.toEqual({
      dependsOn: ["a", " a"],
    });
    expect(plain.requests).toHaveLength(1);

    const trimmed = scriptedRuntime("agent-schema-unique-trimmed", ['{"options":["a"," a"]}']);
    await expect(trimmed.dsl.agent("List them.", { schema: { ...OPTIONS_SCHEMA } })).rejects.toThrow(
      'options[1]: trimmed value "a" duplicates item 0',
    );
  });

  it("reports a wrong-typed element as a type error only, never also as a duplicate", async () => {
    // Uniqueness runs after the per-element pass and compares only elements whose
    // runtime type matches the declared one, so the error set stays a pure
    // function of the value.
    const { dsl, requests } = scriptedRuntime("agent-schema-unique-typed", ['{"dependsOn":[1,1]}']);

    const failure = await dsl
      .agent("List them.", { schema: { ...DEPENDS_ON_SCHEMA } })
      .then(() => undefined)
      .catch((error: unknown) => error);
    const reported = (failure as Error).message;
    expect(reported).toContain("dependsOn[0]: expected string, got number");
    expect(reported).toContain("dependsOn[1]: expected string, got number");
    expect(reported).not.toContain("duplicates item");
    expect(requests).toHaveLength(1);
  });

  it("reports every later duplicate against the first occurrence", async () => {
    const { dsl, requests } = scriptedRuntime("agent-schema-unique-first", ['{"dependsOn":["F1","F1","F1"]}']);

    const failure = await dsl
      .agent("List them.", { schema: { ...DEPENDS_ON_SCHEMA } })
      .then(() => undefined)
      .catch((error: unknown) => error);
    const reported = (failure as Error).message;
    expect(reported).toContain('dependsOn[1]: value "F1" duplicates item 0');
    expect(reported).toContain('dependsOn[2]: value "F1" duplicates item 0');
    // Never "duplicates item 1": naming the first occurrence is what tells the
    // child which of the two elements to edit.
    expect(reported).not.toContain("duplicates item 1");
    expect(requests).toHaveLength(1);
  });

  it.each([
    [{ type: "string", nonBlank: "yes" }, /nonBlank supports only true/u],
    [{ type: "array", items: { type: "string" }, uniqueItems: false }, /uniqueItems supports only true/u],
    [{ type: "array", items: { type: "string" }, uniqueTrimmedItems: 1 }, /uniqueTrimmedItems supports only true/u],
    [
      { type: "array", items: { type: "string" }, uniqueItems: true, uniqueTrimmedItems: true },
      /uniqueItems and uniqueTrimmedItems cannot both be declared/u,
    ],
    [
      { type: "array", items: { type: "object", properties: {} }, uniqueItems: true },
      /uniqueItems requires items to declare a string, number, integer, or boolean type; use uniqueBy for objects/u,
    ],
    [
      { type: "array", items: { type: "number" }, uniqueTrimmedItems: true },
      /uniqueTrimmedItems requires items to declare a string type/u,
    ],
    [{ type: "array", items: { type: "string" }, uniqueBy: "" }, /uniqueBy must be a non-empty string/u],
    [
      { type: "array", items: { type: "string" }, uniqueBy: "id" },
      /uniqueBy requires items to declare an object type/u,
    ],
    [
      { type: "array", items: { type: "object", properties: { name: { type: "string" } } }, uniqueBy: "id" },
      /uniqueBy property "id" is not declared in items\.properties/u,
    ],
    [
      { type: "array", items: { type: "object", properties: { id: { type: "string" } } }, uniqueBy: "id" },
      /uniqueBy property "id" is not listed in items\.required/u,
    ],
    [
      {
        type: "array",
        items: { type: "object", required: ["id"], properties: { id: { type: "object", properties: {} } } },
        uniqueBy: "id",
      },
      /uniqueBy property "id" must declare a string, number, integer, or boolean type/u,
    ],
    // Misplacement is caught by the existing string-only/array-only loops.
    [{ type: "object", properties: {}, uniqueBy: "id" }, /uniqueBy is only valid for an array schema/u],
    [{ type: "array", items: { type: "string" }, nonBlank: true }, /nonBlank is only valid for a string schema/u],
  ])("refuses a malformed uniqueness declaration before any child runs", async (schema, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-uniqueness-declaration-invalid",
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
});
