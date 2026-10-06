import { describe, expect, it } from "vitest";
import {
  canonicalWorkflowJSON,
  compileWorkflowSchema,
  immutableJSON,
  normalizeWorkflowStructuredContract,
  runWorkflowValueValidator,
} from "../../../../../extensions/workflows/runtime/structured-results/schema.js";

describe("locus-json-subset-v1 conformance on installed TypeBox", () => {
  it.each([
    [{ type: "null" }, null, true],
    [{ type: "boolean" }, "true", false],
    [{ type: "boolean" }, false, true],
    [{ type: "string" }, "", true],
    [{ type: "number" }, 1.5, true],
    [{ type: "integer" }, 1.5, false],
    [{ type: "integer" }, 2, true],
    [{ type: "number", minimum: 1, maximum: 2 }, 0.9, false],
    [{ type: "number", minimum: 1, maximum: 2 }, 2, true],
    [{ type: "string", minLength: 1, maxLength: 1 }, "e\u0301", true],
    [{ type: "string", minLength: 1, maxLength: 1 }, "👨‍👩‍👧‍👦", true],
    [{ type: "string", minLength: 1, maxLength: 1 }, "🇫🇷", true],
    [{ type: "string", minLength: 2 }, "e\u0301", false],
    [{ type: "object", properties: { id: { type: "string" } } }, {}, true],
    [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, {}, false],
    [{ type: "object", additionalProperties: false }, { id: "extra" }, false],
    [{ type: "object", additionalProperties: true }, { id: "extra" }, true],
    [{ type: "object" }, { id: "extra" }, true],
    [{ type: "object" }, [], false],
    [{ type: "object" }, null, false],
    [{ type: "array" }, [null, true, { id: "extra" }], true],
    [{ type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 }, [], false],
    [{ type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 }, ["a", "b"], true],
    [{ type: "array", items: { type: "string" } }, [1], false],
    [
      {
        type: "null",
        enum: [null],
        title: "Null",
        description: "Only null",
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      null,
      true,
    ],
    [{ type: "string", enum: ["a", "b"] }, "c", false],
  ])("checks %j against %j without normalization", async (schema, data, valid) => {
    const original = JSON.stringify(data);
    const validator = await compileWorkflowSchema(normalizeWorkflowStructuredContract(schema));
    expect(validator.errors(immutableJSON(data)).length === 0).toBe(valid);
    expect(JSON.stringify(data)).toBe(original);
  });
  it("detaches the schema before Compile and keeps its declared optional/unknown-key behavior", async () => {
    const input = { type: "object", properties: { id: { type: "string" } }, additionalProperties: false };
    const contract = normalizeWorkflowStructuredContract(input);
    input.additionalProperties = true;
    input.properties.id.type = "number";
    const check = await compileWorkflowSchema(contract);
    expect(check.errors({ id: "x" })).toEqual([]);
    expect(check.errors({ other: true }).length).toBeGreaterThan(0);
  });
  it("preserves own __proto__ keys while canonicalizing object order and negative zero", () => {
    const data = JSON.parse('{"__proto__":{"x":1},"z":-0,"a":1}');
    const frozen = immutableJSON(data) as Record<string, unknown>;
    expect(Object.hasOwn(frozen, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(frozen)).toBe(Object.prototype);
    expect(canonicalWorkflowJSON(frozen)).toBe('{"__proto__":{"x":1},"a":1,"z":0}');
  });
  it("sorts integer-looking keys lexically in canonical bytes", () => {
    expect(canonicalWorkflowJSON({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
  });
  it("rejects a sparse array even when a side property disguises its length", () => {
    const data: unknown[] = [];
    data.length = 1;
    Object.assign(data, { extra: null });
    expect(() => immutableJSON(data)).toThrow();
  });
  it.each([Infinity, NaN, JSON.parse("1e400"), undefined, [undefined]])(
    "rejects non-JSON %j before canonical serialization",
    (data) => {
      expect(() => canonicalWorkflowJSON(data)).toThrow();
    },
  );
  it("permits normal nested reads on the monitored immutable input and preserves its original", () => {
    const input = { child: { id: "known" }, values: [1, 2] };
    expect(
      runWorkflowValueValidator(input, (value: any) => {
        expect(Object.isFrozen(value.child)).toBe(true);
        expect(value.values.map((n: number) => n + 1)).toEqual([2, 3]);
        return value.child.id === "known" ? [] : ["Unknown id"];
      }),
    ).toEqual([]);
    expect(input).toEqual({ child: { id: "known" }, values: [1, 2] });
  });
});
