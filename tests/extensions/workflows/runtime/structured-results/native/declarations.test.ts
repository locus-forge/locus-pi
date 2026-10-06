import { describe, expect, it } from "vitest";
import { createWorkflowRuntime } from "../../../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { WorkflowAgentStructuredOptions } from "../../../../../../extensions/workflows/runtime/workflow-agent-contract.js";
import { nativeWorkflowRoute } from "../../../../../../extensions/workflows/runtime/structured-results/native-response.js";

it.each(["object", "boxed"])("refuses non-string native model identity without coercion: %s", (kind) => {
  let coercions = 0;
  const id =
    kind === "boxed"
      ? new String("gpt-6.1-sol")
      : {
          toString() {
            coercions++;
            return "gpt-6.1-sol";
          },
        };
  expect(() =>
    nativeWorkflowRoute({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", id }),
  ).toThrow(/output-contract-unavailable/);
  expect(coercions).toBe(0);
});
it("qualifies and records one native route field snapshot", () => {
  let reads = 0;
  const route = nativeWorkflowRoute({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    get id() {
      return ++reads === 1 ? "gpt-6.1-sol" : "unknown";
    },
  });
  expect(route.model).toBe("gpt-6.1-sol");
  expect(reads).toBe(1);
});

function declaration(options: unknown) {
  let calls = 0;
  const runtime = createWorkflowRuntime({
    runId: "native-declaration",
    agentRunner: async () => {
      calls++;
      throw new Error("child must not start");
    },
  });
  return {
    run: () => runtime.dsl.agent("Return data", options as WorkflowAgentStructuredOptions),
    calls: () => calls,
    journal: runtime.getJournal,
  };
}

describe("explicit native declaration before child admission", () => {
  it.each([
    { outputTransport: "native" },
    { outputTransport: undefined },
    { outputTransport: "auto", schema: { type: "string" } },
    { outputTransport: "tool", schema: { type: "string" } },
  ])("refuses invalid selector without child work: %j", async (options) => {
    const test = declaration(options);
    await expect(test.run()).rejects.toThrow(/outputTransport/);
    expect(test.calls()).toBe(0);
    expect(test.journal()).toEqual([]);
  });

  it.each([
    { type: "null" },
    { type: "string", enum: ["yes", null] },
    { type: "integer", enum: [1, 1.5] },
    { type: "string", minLength: 1 },
    { type: "string", maxLength: 4 },
    { type: "array" },
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    { type: "object", properties: {}, required: [], additionalProperties: true },
    { type: "array", items: { type: "null" } },
  ])("refuses unsupported canonical native subset before work: %j", async (schema) => {
    const test = declaration({ schema, outputTransport: "native" });
    await expect(test.run()).rejects.toThrow(/native.*unsupported-schema/);
    expect(test.calls()).toBe(0);
    expect(test.journal()).toEqual([]);
  });
});

import { projectNativeWorkflowSchema } from "../../../../../../extensions/workflows/runtime/structured-results/native-response.js";

describe("native provider limits include the reversible wrapper", () => {
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  it("retains canonical annotations, scalar enums, array and numeric bounds", () => {
    const schema = {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "number",
        minimum: -1,
        maximum: 2,
        enum: [0, 1],
        title: "Score",
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
    };
    const before = JSON.stringify(schema);
    const wire = projectNativeWorkflowSchema(schema) as any;
    expect(JSON.stringify(schema)).toBe(before);
    expect(wire).toEqual({
      type: "object",
      properties: {
        value: { ...schema, items: { type: "number", minimum: -1, maximum: 2, enum: [0, 1], title: "Score" } },
      },
      required: ["value"],
      additionalProperties: false,
    });
  });
  it("allows 4999 canonical properties and rejects 5000 because value is one more", () => {
    const fields = Object.fromEntries(Array.from({ length: 4999 }, (_, i) => [String(i), { type: "boolean" }]));
    expect(() => projectNativeWorkflowSchema(object(fields))).not.toThrow();
    expect(() => projectNativeWorkflowSchema(object({ ...fields, extra: { type: "boolean" } }))).toThrow(/limit/);
  });
  it("counts object nesting including the wrapper, without counting primitive leaves", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 9; i++) schema = object({ child: schema });
    expect(() => projectNativeWorkflowSchema(schema)).not.toThrow();
    expect(() => projectNativeWorkflowSchema(object({ child: schema }))).toThrow(/nesting/);
  });
  it("refuses total and single string enum limits without truncating the source", () => {
    const enumeration = { type: "string", enum: Array.from({ length: 1001 }, (_, i) => String(i)) };
    expect(() => projectNativeWorkflowSchema(enumeration)).toThrow(/limit/);
    expect(enumeration.enum).toHaveLength(1001);
    const strings = { type: "string", enum: Array.from({ length: 251 }, (_, i) => `${i}-${"x".repeat(60)}`) };
    expect(() => projectNativeWorkflowSchema(strings)).toThrow(/enum limit/);
    expect(() => projectNativeWorkflowSchema(object({ ["x".repeat(120000)]: { type: "boolean" } }))).toThrow(/limit/);
  });
});
