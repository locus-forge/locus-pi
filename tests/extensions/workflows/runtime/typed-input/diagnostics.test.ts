import { describe, expect, it } from "vitest";
import { prepareWorkflowTypedInput as admit } from "../../../../../extensions/workflows/runtime/workflow-input.js";

const objectSchema = {
  type: "object",
  properties: { reviewMode: { type: "string", enum: ["adaptive", "full"] } },
  required: ["reviewMode"],
  additionalProperties: false,
};

describe("typed input launch diagnostics", () => {
  it.each([
    { schema: objectSchema, value: '{"reviewMode":"adaptive"}', kind: "object" },
    { schema: objectSchema, value: '  { "reviewMode": "adaptive" }  ', kind: "object" },
    { schema: { type: "array", items: { type: "string" } }, value: '["private request"]', kind: "array" },
  ])("explains string input for $kind without echoing the value", async ({ schema, value, kind }) => {
    const failure = await admit({ inputValue: value }, schema).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(`typed input does not satisfy inputSchema: : must be ${kind}`);
    expect(failure.message).toContain(`Pass a native JSON ${kind} directly, without JSON.stringify or extra quoting.`);
    expect(failure.message).not.toContain(value);
  });

  it.each(['{"reviewMode":"adaptive"}', '["value"]', "null", "  exact text\n"])(
    "preserves JSON-looking and ordinary strings under a string schema: %j",
    async (value) => {
      const admitted = await admit({ inputValue: value }, { type: "string" });
      expect(admitted?.value).toBe(value);
    },
  );

  it.each([{}, { input: '{"reviewMode":"adaptive"}' }])("explains missing explicit typed input: %j", async (fields) => {
    const failure = await admit(fields, objectSchema).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("typed input requires explicit inputValue and meta.inputSchema");
    expect(failure.message).toContain("use inputValue matching meta.inputSchema");
    expect(failure.message).toContain("legacy input cannot launch a typed workflow");
  });

  it("retains schema-specific diagnostics for an object with an invalid property", async () => {
    const failure = await admit({ inputValue: { reviewMode: "unknown" } }, objectSchema).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    const reason = "/reviewMode: must be equal to one of the allowed values";
    expect(failure.message).toBe(`typed input does not satisfy inputSchema: ${reason}`);
  });

  it("retains the missing schema error for a typed value targeting an untyped workflow", async () => {
    const failure = await admit({ inputValue: { reviewMode: "adaptive" } }, undefined).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("typed input requires explicit inputValue and meta.inputSchema");
  });
});
