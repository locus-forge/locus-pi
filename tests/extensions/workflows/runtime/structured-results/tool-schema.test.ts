import { describe, expect, it } from "vitest";
import { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { createWorkflowStructuredCall } from "../../../../../extensions/workflows/runtime/structured-results/return.js";
import { normalizeWorkflowStructuredContract } from "../../../../../extensions/workflows/runtime/structured-results/schema.js";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";

const toolFor = (schema: unknown) =>
  createWorkflowStructuredCall(normalizeWorkflowStructuredContract(schema)).controller().tool!;

describe("standard Pi constrained sampling with the caller's actual schema", () => {
  it.each([
    [{ type: "null" }, null],
    [{ type: "boolean" }, true],
    [{ type: "string", enum: ["known"] }, "known"],
    [{ type: "number", minimum: 0, maximum: 2 }, 1],
    [{ type: "integer", enum: [9007199254740992] }, 9007199254740992],
    [{ type: "array", items: { type: "boolean" }, minItems: 1 }, [true]],
    [
      { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      { id: "known" },
    ],
  ])("sends exact schema %j with prefer and preserves canonical roots", async (schema, value) => {
    const result = await structuredSdk({ schema: schema as any }, [rawTurn([JSON.stringify({ value })])]);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(value);
    const wire = (result.payloads[0] as any).tools.find((tool: any) => tool.name === "workflow_return");
    expect(wire.parameters).toEqual({
      type: "object",
      properties: { value: schema },
      required: ["value"],
      additionalProperties: false,
    });
    expect(wire.strict).toBe(true);
    expect((result.payloads[0] as any).text?.format).toBeUndefined();
    expect(wire.description).not.toContain(JSON.stringify(schema));
    if (typeof value === "object" && value !== null) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    [{ type: "object", properties: { id: { type: "string" } }, additionalProperties: false }, {}],
    [{ type: "object", properties: { id: { type: "string" } } }, { extra: true }],
    [{ type: "object", additionalProperties: true }, { extra: true }],
    [{ type: "array" }, [null, { extra: true }]],
    [{ type: "array", items: { type: "object" } }, [{ extra: true }]],
    [{ type: "string", minLength: 1, maxLength: 1 }, "👨‍👩‍👧‍👦"],
    [{ type: "string", minLength: 1, maxLength: 1 }, "e\u0301"],
  ])("keeps non-projectable schema %j on the same validated tool path", async (schema, value) => {
    const tool = toolFor(schema);
    expect(tool.constrainedSampling).toBeUndefined();
    expect(tool.parameters.properties).toEqual({ value: schema });
    const result = await structuredSdk({ schema: schema as any }, [rawTurn([JSON.stringify({ value })])]);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(value);
    const wire = (result.payloads[0] as any).tools.find((tool: any) => tool.name === "workflow_return");
    expect(wire.parameters).toEqual(tool.parameters);
    expect(wire.strict).not.toBe(true);
    expect(result.counters).toMatchObject({ sessions: 1, generations: 1, tools: 1 });
  });

  it("guards the actual Pi conversion's optional-property/null and unknown-key changes", () => {
    const tool = toolFor({ type: "object", properties: { id: { type: "string" } } });
    const projected = makeStrictJsonSchema(tool.parameters as any) as any;
    expect(projected.properties.value).toMatchObject({ required: ["id"], additionalProperties: false });
    expect(projected.properties.value.properties.id).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(tool.parameters.properties).toEqual({ value: { type: "object", properties: { id: { type: "string" } } } });
    expect(tool.constrainedSampling).toBeUndefined();
  });

  it("leaves provider/model capability and unsupported-keyword fallback to Pi", () => {
    const tool = toolFor({ type: "string" }) as any;
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(resolveJsonSchemaStrictSampling(tool, true)).toBe(true);
    expect(resolveJsonSchemaStrictSampling(tool, false)).toBeUndefined();
    expect(resolveJsonSchemaStrictSampling(tool, true, (key) => key === "type")).toBeUndefined();
  });

  it("advertises the caller schema on correction while keeping prior evidence in the same session", async () => {
    const schema = { type: "string", enum: ["known"] };
    const result = await structuredSdk({ schema }, [rawTurn(['{"value":"invented"}']), rawTurn(['{"value":"known"}'])]);
    expect(result.error).toBeUndefined();
    expect(result.counters).toMatchObject({ sessions: 1, generations: 2, effects: 0, tools: 1 });
    const correction = result.payloads[1] as any;
    expect(correction.tools.map((tool: any) => tool.name)).toEqual(["workflow_return"]);
    expect(correction.tools[0].parameters.properties.value).toEqual(schema);
    expect(JSON.stringify(correction.input)).toContain("invented");
    expect(result.acceptance?.structuredReceipt?.spent).toMatchObject({ outputAttempts: 2, toolCalls: 1 });
  });
});
