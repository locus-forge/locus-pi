/** The deliberately narrow, non-coercing runtime JSON dialect. No Pi argument normalization. */
export type WorkflowJSONValue =
  null | boolean | number | string | WorkflowJSONValue[] | { [key: string]: WorkflowJSONValue };
export type WorkflowJSONSchema = Readonly<Record<string, unknown>>;
export const WORKFLOW_SCHEMA_DIALECT = "locus-json-subset-v1" as const;
export const WORKFLOW_RAW_OBSERVER_REVISION = "codex-responses-v3" as const;

export interface WorkflowStructuredContract {
  version: 4;
  choices?: never;
  dialect: typeof WORKFLOW_SCHEMA_DIALECT;
  schema: WorkflowJSONSchema;
  maxAttempts: number;
}
/** JSON data cloning. Only transport payloads may omit undefined object fields, as JSON serialization does. */
export function immutableJSON(value: unknown, options?: { omitUndefinedObjectFields: true }): WorkflowJSONValue {
  const ancestors = new Set<object>();
  function copy(input: unknown): WorkflowJSONValue {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return Object.is(input, -0) ? 0 : input;
    if (typeof input !== "object" || input === null || ancestors.has(input))
      throw new Error("Expected finite JSON data");
    if (Object.getOwnPropertySymbols(input).length !== 0) throw new Error("Expected JSON string keys");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) throw new Error("Expected a dense JSON array");
        const array: WorkflowJSONValue[] = [];
        for (let index = 0; index < input.length; index++) {
          const item = Object.getOwnPropertyDescriptor(input, String(index));
          if (item === undefined || !("value" in item)) throw new Error("Expected dense JSON data properties");
          array.push(copy(item.value));
        }
        return Object.freeze(array) as WorkflowJSONValue[];
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
        throw new Error("Expected a JSON object");
      const entries = Object.keys(input)
        .sort()
        .flatMap((key) => {
          const property = Object.getOwnPropertyDescriptor(input, key)!;
          if (!("value" in property)) throw new Error("Expected JSON data properties");
          return options?.omitUndefinedObjectFields && property.value === undefined
            ? []
            : [[key, copy(property.value)] as const];
        });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(input);
    }
  }
  return copy(value);
}

export function canonicalWorkflowJSON(value: unknown): string {
  function encode(value: WorkflowJSONValue): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(value[key]!)}`)
      .join(",")}}`;
  }
  return encode(immutableJSON(value));
}

/** Checks author declarations synchronously, before the logical call spends any work. */
export function normalizeWorkflowStructuredContract(schema: unknown): WorkflowStructuredContract {
  let detached: WorkflowJSONValue;
  try {
    detached = immutableJSON(schema);
  } catch (error) {
    throw unsupported("$", String(error));
  }
  const types = new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);
  function check(input: WorkflowJSONValue, at: string): void {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw unsupported(at, "schema must be an object");
    const type = input.type;
    if (typeof type !== "string" || !types.has(type)) throw unsupported(at, "type must be one supported string");
    const allowed = new Set(["type", "enum", "title", "description", "$schema"]);
    const bounds =
      type === "string"
        ? ["minLength", "maxLength"]
        : type === "array"
          ? ["minItems", "maxItems"]
          : type === "number" || type === "integer"
            ? ["minimum", "maximum"]
            : [];
    for (const key of bounds) allowed.add(key);
    if (type === "object") for (const key of ["properties", "required", "additionalProperties"]) allowed.add(key);
    if (type === "array") allowed.add("items");
    for (const key of Object.keys(input))
      if (!allowed.has(key)) throw unsupported(`${at}.${key}`, "keyword not supported here");
    for (const key of ["title", "description"])
      if (Object.hasOwn(input, key) && typeof input[key] !== "string")
        throw unsupported(`${at}.${key}`, "annotation must be a string");
    if (Object.hasOwn(input, "$schema") && input.$schema !== "https://json-schema.org/draft/2020-12/schema")
      throw unsupported(`${at}.$schema`, "unsupported schema URI");
    for (const key of bounds)
      if (Object.hasOwn(input, key)) {
        const value = input[key];
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (key !== "minimum" && key !== "maximum" && (!Number.isSafeInteger(value) || value < 0))
        )
          throw unsupported(`${at}.${key}`, "invalid bound");
      }
    if (
      bounds.length === 2 &&
      typeof input[bounds[0]!] === "number" &&
      typeof input[bounds[1]!] === "number" &&
      input[bounds[0]!]! > input[bounds[1]!]!
    )
      throw unsupported(at, "minimum exceeds maximum");
    if (Object.hasOwn(input, "enum")) {
      const values = input.enum;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((v) => v !== null && typeof v === "object") ||
        new Set(values.map(canonicalWorkflowJSON)).size !== values.length
      )
        throw unsupported(`${at}.enum`, "enum must contain distinct JSON primitives");
    }
    if (type === "array" && Object.hasOwn(input, "items")) check(input.items!, `${at}.items`);
    if (type === "object") {
      const properties = input.properties === undefined ? {} : input.properties;
      if (properties === null || typeof properties !== "object" || Array.isArray(properties))
        throw unsupported(`${at}.properties`, "expected an object");
      for (const [key, child] of Object.entries(properties)) check(child, `${at}.properties[${JSON.stringify(key)}]`);
      if (Object.hasOwn(input, "required")) {
        const required = input.required;
        if (
          !Array.isArray(required) ||
          required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
          new Set(required).size !== required.length
        )
          throw unsupported(`${at}.required`, "required must name distinct declared properties");
      }
      if (Object.hasOwn(input, "additionalProperties") && typeof input.additionalProperties !== "boolean")
        throw unsupported(`${at}.additionalProperties`, "expected a boolean");
    }
  }
  check(detached, "$");
  return Object.freeze({
    version: 4,
    dialect: WORKFLOW_SCHEMA_DIALECT,
    schema: detached as WorkflowJSONSchema,
    maxAttempts: 2,
  });
}
function unsupported(path: string, message: string): Error {
  return new Error(`unsupported-schema at ${path}: ${message}`);
}

export interface WorkflowSchemaValidator {
  errors(value: WorkflowJSONValue): string[];
}
/** Called only after the v4 host/capability gate; old peers never load this new export. */
export async function compileWorkflowSchema(contract: WorkflowStructuredContract): Promise<WorkflowSchemaValidator> {
  const { Compile } = await import("typebox/compile");
  const validator = Compile(contract.schema as Parameters<typeof Compile>[0]);
  return {
    errors: (value) =>
      validator.Check(value)
        ? []
        : [...validator.Errors(value)].map((error) => `${error.instancePath}: ${error.message}`),
  };
}

/** Raw tool envelope and immutable canonical candidate. */
export function decodeWorkflowProposal(raw: string): { value: WorkflowJSONValue; canonical: string } {
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, "value")
  )
    throw new Error("Provide exactly {value: JSONValue}");
  const value = immutableJSON((parsed as { value: unknown }).value);
  return { value, canonical: canonicalWorkflowJSON(value) };
}
export function validateWorkflowProposal(
  value: WorkflowJSONValue,
  schema: WorkflowSchemaValidator,
): string | undefined {
  const errors = schema.errors(value);
  return errors.length === 0
    ? undefined
    : errors
        .slice(0, 20)
        .map((error) => error.slice(0, 500))
        .join("; ");
}

/** Pi strict conversion must preserve the caller's accepted values, including object optionality.
 * Provider/model support belongs to Pi; this only guards our dialect's semantics. */
export function workflowSchemaSupportsStrictPreference(schema: WorkflowJSONSchema): boolean {
  if (schema.type === "string" && (schema.minLength !== undefined || schema.maxLength !== undefined)) return false;
  if (schema.type === "array")
    return schema.items !== undefined && workflowSchemaSupportsStrictPreference(schema.items as WorkflowJSONSchema);
  if (schema.type !== "object") return true;
  if (schema.additionalProperties !== false) return false;
  const properties = (schema.properties ?? {}) as Record<string, WorkflowJSONSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).every(
    ([key, child]) => required.has(key) && workflowSchemaSupportsStrictPreference(child),
  );
}

/** Persisted protocol content identity, never an in-memory freshness check. */
export async function workflowStructuredSchemaDigest(schema: WorkflowJSONSchema): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalWorkflowJSON(schema)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
