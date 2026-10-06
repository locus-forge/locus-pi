import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  WorkflowAgentStructuredOptions,
  WorkflowDsl,
  WorkflowJSONSchema,
  WorkflowReadonlyJSONValue,
  WorkflowSchemaResult,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";

const reviewSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["accept", "revise"] },
    note: { type: "string" },
    details: {
      type: "object",
      properties: { confidence: { type: "number" }, safe: { type: "boolean" } },
      required: ["confidence", "safe"],
      additionalProperties: false,
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "details", "findings"],
  additionalProperties: false,
} as const;

// These functions are checked by tsc and deliberately never execute agent calls or writes.
async function assertPublicInference(dsl: WorkflowDsl): Promise<void> {
  const pending = dsl.agent("Review", { label: "review", schema: reviewSchema });
  // @ts-expect-error the promise has no resolved result fields
  pending.verdict;
  const result = await pending;
  expectTypeOf(result.verdict).toEqualTypeOf<"accept" | "revise">();
  expectTypeOf(result.note).toEqualTypeOf<string | undefined>();
  expectTypeOf(result.details.confidence).toEqualTypeOf<number>();
  expectTypeOf(result.details.safe).toEqualTypeOf<boolean>();
  expectTypeOf(result.findings.map((finding) => finding.message)).toEqualTypeOf<string[]>();
  const json: WorkflowReadonlyJSONValue = result;
  void json;

  // @ts-expect-error schema-derived fields are readonly
  result.verdict = "accept";
  // @ts-expect-error readonly extends to nested objects
  result.details.confidence = 1;
  // @ts-expect-error arrays are readonly
  result.findings.push({ message: "new" });
  for (const finding of result.findings) {
    // @ts-expect-error readonly extends through array items
    finding.message = "changed";
  }
  // @ts-expect-error optional properties are not known to be present
  const note: string = result.note;
  // @ts-expect-error a closed schema does not invent unknown properties
  result.unknown;
  // @ts-expect-error a structured readonly array cannot become a mutable array
  const mutable: { message: string }[] = result.findings;
  // @ts-expect-error enum values cannot be asserted to an undeclared route
  const route: "skip" = result.verdict;
  void [note, mutable, route];

  const inline = await dsl.agent("Inline schema", {
    schema: {
      type: "object",
      properties: { verdict: { type: "string", enum: ["accept", "revise"] } },
      required: ["verdict"],
      additionalProperties: false,
    },
  });
  expectTypeOf(inline.verdict).toEqualTypeOf<"accept" | "revise">();

  // @ts-expect-error generic arguments describe the supplied schema, never an arbitrary result
  await dsl.agent<{ verdict: "accept" }>("Claim a result", { schema: { type: "string" } });
  expectTypeOf(await dsl.agent("Plain text")).toEqualTypeOf<string>();
  expectTypeOf(await dsl.agent("Report", { result: "report" })).toEqualTypeOf<string>();
  expectTypeOf(await dsl.agent("Choice", { choice: ["accept", "revise"] })).toEqualTypeOf<"accept" | "revise">();
}

async function assertDynamicFallback(
  dsl: WorkflowDsl,
  schema: WorkflowJSONSchema,
  options: WorkflowAgentStructuredOptions,
): Promise<void> {
  const dynamic = await dsl.agent("Dynamic schema", { schema });
  expectTypeOf(dynamic).toEqualTypeOf<WorkflowReadonlyJSONValue>();
  expectTypeOf(await dsl.agent("Annotated options", options)).toEqualTypeOf<WorkflowReadonlyJSONValue>();
  // @ts-expect-error a dynamic schema does not invent result properties
  dynamic.verdict;
  const widened = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
  expectTypeOf(await dsl.agent("Widened schema", { schema: widened })).toEqualTypeOf<WorkflowReadonlyJSONValue>();

  const removedValidate: WorkflowAgentStructuredOptions = {
    schema,
    // @ts-expect-error custom validation callbacks were removed from the standard tool API
    validate: () => [],
  };
  const removedRepair: WorkflowAgentStructuredOptions = {
    schema,
    // @ts-expect-error the package owns the initial submission and one correction
    repair: { maxAttempts: 3 },
  };
  const removedTransport: WorkflowAgentStructuredOptions = {
    schema,
    // @ts-expect-error there is one standard tool path, not an author-selected native transport
    outputTransport: "native",
  };
  void [removedValidate, removedRepair, removedTransport];
}

async function assertCompoundEnumsStayReadonly(dsl: WorkflowDsl): Promise<void> {
  const arraySchema = { type: "array" as const, items: { type: "string" as const }, enum: [["known"]] };
  const array = await dsl.agent("Invalid compound array enum", { schema: arraySchema });
  expectTypeOf(array).toEqualTypeOf<readonly string[]>();
  // @ts-expect-error a mutable enum array must not restore mutable methods
  array.push("changed");
  // @ts-expect-error a mutable enum array must not restore index writes
  array[0] = "changed";

  const objectSchema = {
    type: "object" as const,
    properties: { name: { type: "string" as const } },
    required: ["name"] as const,
    additionalProperties: false as const,
    enum: [{ name: "known" }],
  };
  const object = await dsl.agent("Invalid compound object enum", { schema: objectSchema });
  expectTypeOf(object.name).toEqualTypeOf<string>();
  // @ts-expect-error a mutable enum object must not restore property writes
  object.name = "changed";

  const nested = await dsl.agent("Invalid nested compound enum", {
    schema: { type: "array", items: objectSchema, enum: [[{ name: "known" }]] },
  });
  for (const item of nested) {
    // @ts-expect-error compound enum graphs cannot restore nested property writes
    item.name = "changed";
  }
}

function assertObjectTypes(): void {
  type Optional = WorkflowSchemaResult<{
    type: "object";
    properties: { name: { type: "string" }; count: { type: "integer" } };
    required: readonly ["name"];
    additionalProperties: false;
  }>;
  const valid: Optional = { name: "Ada" };
  expectTypeOf(valid.count).toEqualTypeOf<number | undefined>();
  // @ts-expect-error required fields must be present
  const missing: Optional = {};
  // @ts-expect-error optional fields still retain their declared value type
  const wrong: Optional = { name: "Ada", count: "one" };
  // @ts-expect-error optional fields are readonly too
  valid.count = 1;
  void [missing, wrong];

  type Open = WorkflowSchemaResult<{
    type: "object";
    properties: { name: { type: "string" } };
    required: readonly ["name"];
  }>;
  const open: Open = { name: "Ada", extra: [true, { count: 1 }] };
  expectTypeOf(open.name).toEqualTypeOf<string>();
  expectTypeOf(open.extra).toEqualTypeOf<WorkflowReadonlyJSONValue | undefined>();
  // @ts-expect-error open properties are readonly
  open.extra = null;

  type DynamicRequired = WorkflowSchemaResult<{
    type: "object";
    properties: { name: { type: "string" } };
    required: readonly string[];
    additionalProperties: false;
  }>;
  const dynamicRequired: DynamicRequired = {};
  expectTypeOf(dynamicRequired.name).toEqualTypeOf<string | undefined>();
  type ConditionalRequired = WorkflowSchemaResult<{
    type: "object";
    properties: { name: { type: "string" } };
    required: readonly ["name"] | readonly [];
    additionalProperties: false;
  }>;
  const conditionalRequired: ConditionalRequired = {};
  expectTypeOf(conditionalRequired.name).toEqualTypeOf<string | undefined>();

  type UncertainRequired<Keys extends readonly (string | undefined)[]> = WorkflowSchemaResult<{
    type: "object";
    properties: { name: { type: "string" }; count: { type: "integer" } };
    required: Keys;
    additionalProperties: false;
  }>;
  const optionalRequired: UncertainRequired<readonly ["name"?]> = {};
  const unionElement: UncertainRequired<readonly ["name" | "count"]> = {};
  expectTypeOf(optionalRequired.name).toEqualTypeOf<string | undefined>();
  expectTypeOf(unionElement.name).toEqualTypeOf<string | undefined>();
  expectTypeOf(unionElement.count).toEqualTypeOf<number | undefined>();

  const empty: WorkflowSchemaResult<{ type: "object"; additionalProperties: false }> = {};
  // @ts-expect-error an empty closed object schema cannot return a primitive
  const emptyPrimitive: typeof empty = "text";
  // @ts-expect-error an empty closed object schema cannot contain a property
  const emptyProperty: typeof empty = { unexpected: true };
  void [emptyPrimitive, emptyProperty];
}

describe("readonly structured schema result types", () => {
  it("infers public agent results without executing compile-time assertions", () => {
    expect(typeof assertPublicInference).toBe("function");
    expect(typeof assertDynamicFallback).toBe("function");
    expect(typeof assertObjectTypes).toBe("function");
    expect(reviewSchema.properties.verdict.enum).toEqual(["accept", "revise"]);
  });

  it("does not import mutation capabilities from mutable compound enum graphs", () => {
    expect(typeof assertCompoundEnumsStayReadonly).toBe("function");
    type ArraySchema<Values> = { type: "array"; items: { type: "string" }; enum: Values };
    expectTypeOf<WorkflowSchemaResult<ArraySchema<unknown[]>>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<WorkflowSchemaResult<ArraySchema<any[]>>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<WorkflowSchemaResult<ArraySchema<unknown>>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<WorkflowSchemaResult<ArraySchema<any>>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<
      WorkflowSchemaResult<{ type: "string"; enum: (string & { writable: boolean })[] }>
    >().toEqualTypeOf<string>();
  });

  it("keeps native scalar types and intersects primitive enums with their declared type", () => {
    expectTypeOf<WorkflowSchemaResult<{ type: "null" }>>().toEqualTypeOf<null>();
    expectTypeOf<WorkflowSchemaResult<{ type: "boolean" }>>().toEqualTypeOf<boolean>();
    expectTypeOf<WorkflowSchemaResult<{ type: "number" }>>().toEqualTypeOf<number>();
    expectTypeOf<WorkflowSchemaResult<{ type: "integer" }>>().toEqualTypeOf<number>();
    expectTypeOf<WorkflowSchemaResult<{ type: "string" }>>().toEqualTypeOf<string>();
    expectTypeOf<WorkflowSchemaResult<{ type: "string"; enum: readonly ["yes", "no", 1] }>>().toEqualTypeOf<
      "yes" | "no"
    >();
    expectTypeOf<WorkflowSchemaResult<{ type: "boolean"; enum: readonly [true, "false"] }>>().toEqualTypeOf<true>();
    expectTypeOf<WorkflowSchemaResult<{ type: "integer"; enum: readonly [1, 2, "3"] }>>().toEqualTypeOf<1 | 2>();
    expectTypeOf<WorkflowSchemaResult<{ type: "string"; enum: readonly [1] }>>().toEqualTypeOf<never>();
  });

  it("retains readonly array items without promising a nonempty array", () => {
    expectTypeOf<WorkflowSchemaResult<{ type: "array" }>>().toEqualTypeOf<readonly WorkflowReadonlyJSONValue[]>();
    expectTypeOf<WorkflowSchemaResult<{ type: "array"; items: { type: "string" } }>>().toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf<
      WorkflowSchemaResult<{ type: "array"; items: { type: "array"; items: { type: "boolean" } } }>
    >().toEqualTypeOf<readonly (readonly boolean[])[]>();
  });

  it("keeps broad schemas and any-typed schema declarations behind the readonly JSON fallback", () => {
    expectTypeOf<WorkflowSchemaResult<WorkflowJSONSchema>>().toEqualTypeOf<WorkflowReadonlyJSONValue>();
    expectTypeOf<WorkflowSchemaResult<{ type: string }>>().toEqualTypeOf<WorkflowReadonlyJSONValue>();
    expectTypeOf<WorkflowSchemaResult<any>>().toEqualTypeOf<WorkflowReadonlyJSONValue>();
    expectTypeOf<WorkflowSchemaResult<{ type: any }>>().toEqualTypeOf<WorkflowReadonlyJSONValue>();
    expectTypeOf<WorkflowSchemaResult<{ type: "string"; enum: any }>>().toEqualTypeOf<string>();
  });
});
