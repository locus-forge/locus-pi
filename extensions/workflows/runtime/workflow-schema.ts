/**
 * Home of the JSON-schema subset validator shared by the two shape authorities:
 * the text schema loop in `workflow-runtime.ts` and same-session `workflow_return`
 * acceptance in `workflow-return.ts`. It lives beside them, rather than inside the
 * runtime, only so the contract owner can validate a proposal without importing the
 * runtime back. The rules themselves are unchanged and have exactly one copy.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal dependency-free JSON-schema subset validator.
 *
 * Supported keywords:
 *   - `type`: "object" | "array" | "string" | "number" | "integer" | "boolean"
 *   - `required`: string[]  (for objects — lists required property names)
 *   - `properties`: Record<string, schema>  (recursive)
 *   - `additionalProperties`: false  (for objects — reject keys not in `properties`)
 *   - `items`: schema  (for arrays — validates every element, recursive)
 *   - `enum`: JSON primitive[]  (value must be strictly equal to one listed member)
 *   - `minLength` / `maxLength` / `pattern`  (for strings)
 *   - `minItems` / `maxItems`  (for arrays)
 *   - `nonBlank: true`  (for strings — reject a value that is empty after trimming)
 *   - `uniqueItems: true`  (for arrays of string/number/integer/boolean items)
 *   - `uniqueTrimmedItems: true`  (for arrays of string items — unique after trimming)
 *   - `uniqueBy: "<property>"`  (for arrays of objects — that property is unique)
 *
 * Trimming is `String.prototype.trim`, the same canonicalization a consumer's
 * normalizer applies, so a value this validator accepts cannot collapse later.
 *
 * `schema === undefined` is a no-op — callers must guard before calling.
 * No ajv, no fs, no network. Host-agnostic.
 */
const SUPPORTED_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  // Size and shape bounds. Without these a script must re-check every string and
  // array by hand after validation succeeds, and a violation then throws and
  // kills the run — whereas a bound expressed here is fed back to the child by
  // the existing retry, which is the difference between a fatal answer and a
  // correctable one.
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  // Uniqueness and blankness, for the same reason. A repeated id or a
  // whitespace-only label is something the child can correct once told, but a
  // hand-written check after validation can only throw and end the run.
  // `uniqueItems` covers arrays of primitives, `uniqueBy` arrays of objects
  // keyed on one named property, `uniqueTrimmedItems` string arrays a consumer
  // trims anyway, and `nonBlank` a string that satisfies minLength 1 while
  // being nothing but whitespace.
  "nonBlank",
  "uniqueItems",
  "uniqueTrimmedItems",
  "uniqueBy",
]);

const STRING_ONLY_KEYWORDS = ["minLength", "maxLength", "pattern", "nonBlank"] as const;
const ARRAY_ONLY_KEYWORDS = ["minItems", "maxItems", "uniqueItems", "uniqueTrimmedItems", "uniqueBy"] as const;

/** Item types `uniqueItems` and `uniqueBy` can compare without inventing an equality. */
const PRIMITIVE_SCHEMA_TYPES = ["string", "number", "integer", "boolean"] as const;

/** Validate the declaration before the first child call. Runtime value validation
 *  is useful only when authors cannot accidentally declare an ignored contract. */
export function assertSupportedAgentSchema(schema: Record<string, unknown>, path = "schema"): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`${path}: unsupported keyword "${keyword}"`);
    }
  }

  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !SUPPORTED_SCHEMA_TYPES.has(type))) {
    throw new Error(`${path}: unsupported type ${JSON.stringify(type)}`);
  }
  if (type === undefined && schema.enum === undefined) {
    throw new Error(`${path}: schema must declare type or enum`);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new Error(`${path}: enum must be a non-empty array`);
    }
    for (const [index, member] of schema.enum.entries()) {
      const supportedPrimitive =
        member === null ||
        typeof member === "string" ||
        typeof member === "boolean" ||
        (typeof member === "number" && Number.isFinite(member));
      if (!supportedPrimitive) {
        throw new Error(`${path}: enum value at index ${index} must be a JSON primitive`);
      }
      const matchesDeclaredType =
        type === undefined ||
        (type === "string" && typeof member === "string") ||
        (type === "number" && typeof member === "number") ||
        (type === "integer" && typeof member === "number" && Number.isInteger(member)) ||
        (type === "boolean" && typeof member === "boolean");
      if (!matchesDeclaredType) {
        throw new Error(`${path}: enum value at index ${index} does not match declared type ${String(type)}`);
      }
    }
  }

  const objectKeywords = ["required", "properties", "additionalProperties"].filter(
    (keyword) => schema[keyword] !== undefined,
  );
  if (objectKeywords.length > 0 && type !== "object") {
    throw new Error(`${path}: ${objectKeywords[0]} is only valid for an object schema`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`${path}: additionalProperties supports only false`);
  }

  let properties: Record<string, unknown> | undefined;
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${path}: properties must be an object`);
    properties = schema.properties;
    for (const [name, child] of Object.entries(properties)) {
      if (!isRecord(child)) throw new Error(`${path}.properties.${name} must be a schema object`);
      assertSupportedAgentSchema(child, `${path}.properties.${name}`);
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string")) {
      throw new Error(`${path}: required must be an array of strings`);
    }
    const required = schema.required as string[];
    if (new Set(required).size !== required.length) {
      throw new Error(`${path}: required contains duplicate property names`);
    }
    for (const key of required) {
      if (properties === undefined || !(key in properties)) {
        throw new Error(`${path}: required property "${key}" is not declared in properties`);
      }
    }
  }

  if (type === "array") {
    if (!isRecord(schema.items)) throw new Error(`${path}: array schema must declare items as a schema object`);
    assertSupportedAgentSchema(schema.items, `${path}.items`);
  } else if (schema.items !== undefined) {
    throw new Error(`${path}: items is only valid for an array schema`);
  }

  assertBoundKeywords(schema, path, type);
}

/**
 * A bound that can never be satisfied would burn every schema retry before
 * failing, so an impossible or misplaced declaration is refused here — before
 * the first child call — rather than discovered as an unexplained exhaustion.
 */
function assertBoundKeywords(schema: Record<string, unknown>, path: string, type: unknown): void {
  for (const keyword of STRING_ONLY_KEYWORDS) {
    if (schema[keyword] !== undefined && type !== "string") {
      throw new Error(`${path}: ${keyword} is only valid for a string schema`);
    }
  }
  for (const keyword of ARRAY_ONLY_KEYWORDS) {
    if (schema[keyword] !== undefined && type !== "array") {
      throw new Error(`${path}: ${keyword} is only valid for an array schema`);
    }
  }

  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const bound = schema[keyword];
    if (bound === undefined) continue;
    if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 0) {
      throw new Error(`${path}: ${keyword} must be a non-negative safe integer`);
    }
  }

  const impossible = (min: unknown, max: unknown): boolean =>
    typeof min === "number" && typeof max === "number" && min > max;
  if (impossible(schema.minLength, schema.maxLength)) {
    throw new Error(`${path}: minLength ${String(schema.minLength)} exceeds maxLength ${String(schema.maxLength)}`);
  }
  if (impossible(schema.minItems, schema.maxItems)) {
    throw new Error(`${path}: minItems ${String(schema.minItems)} exceeds maxItems ${String(schema.maxItems)}`);
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error(`${path}: pattern must be a string`);
    try {
      compilePattern(schema.pattern);
    } catch (error) {
      throw new Error(
        `${path}: pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  assertUniquenessKeywords(schema, path);
}

/**
 * The uniqueness and blankness keywords carry no numeric domain, so the ways to
 * get them wrong are all declarative: a value other than `true`, an item type
 * whose equality the runtime refuses to invent, or a `uniqueBy` property the
 * items do not actually promise. Each is refused before the first child call —
 * an ignored contract is worse than an absent one.
 */
function assertUniquenessKeywords(schema: Record<string, unknown>, path: string): void {
  for (const keyword of ["nonBlank", "uniqueItems", "uniqueTrimmedItems"] as const) {
    if (schema[keyword] !== undefined && schema[keyword] !== true) {
      throw new Error(`${path}: ${keyword} supports only true`);
    }
  }

  if (schema.uniqueItems === true && schema.uniqueTrimmedItems === true) {
    throw new Error(
      `${path}: uniqueItems and uniqueTrimmedItems cannot both be declared; uniqueTrimmedItems already rejects raw duplicates`,
    );
  }

  // Reached only for an array schema (ARRAY_ONLY_KEYWORDS above), whose `items`
  // is already proven to be a schema object by the caller.
  const items = isRecord(schema.items) ? schema.items : undefined;
  const itemType = items?.type;

  if (schema.uniqueItems === true && !isPrimitiveSchemaType(itemType)) {
    throw new Error(
      `${path}: uniqueItems requires items to declare a string, number, integer, or boolean type; use uniqueBy for objects`,
    );
  }
  if (schema.uniqueTrimmedItems === true && itemType !== "string") {
    throw new Error(`${path}: uniqueTrimmedItems requires items to declare a string type`);
  }

  if (schema.uniqueBy === undefined) return;
  if (typeof schema.uniqueBy !== "string" || schema.uniqueBy === "") {
    throw new Error(`${path}: uniqueBy must be a non-empty string`);
  }
  const property = schema.uniqueBy;
  if (itemType !== "object") {
    throw new Error(`${path}: uniqueBy requires items to declare an object type`);
  }
  const properties = isRecord(items?.properties) ? items.properties : undefined;
  if (properties === undefined || !(property in properties)) {
    throw new Error(`${path}: uniqueBy property ${JSON.stringify(property)} is not declared in items.properties`);
  }
  // Without `required`, an element missing the property is neither unique nor a
  // duplicate, and the runtime would have to invent that semantic. Requiring it
  // instead means the child gets `missing required property` — a better error.
  const required = Array.isArray(items?.required) ? items.required : [];
  if (!required.includes(property)) {
    throw new Error(`${path}: uniqueBy property ${JSON.stringify(property)} is not listed in items.required`);
  }
  const propertySchema = properties[property];
  if (!isRecord(propertySchema) || !isPrimitiveSchemaType(propertySchema.type)) {
    throw new Error(
      `${path}: uniqueBy property ${JSON.stringify(property)} must declare a string, number, integer, or boolean type`,
    );
  }
}

function isPrimitiveSchemaType(type: unknown): type is (typeof PRIMITIVE_SCHEMA_TYPES)[number] {
  return typeof type === "string" && (PRIMITIVE_SCHEMA_TYPES as readonly string[]).includes(type);
}

/**
 * JSON Schema `pattern` is an unanchored ECMA-262 search with no flags, so an
 * author who means "the whole value" writes the anchors themselves. Compiled
 * results are cached because validation re-runs on every retry.
 */
const patternCache = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(pattern);
  patternCache.set(pattern, compiled);
  return compiled;
}

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "",
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const type = schema["type"];
  if (type !== undefined) {
    const loc = path || "root";
    if (type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(
          `${loc}: expected object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
        );
      } else {
        const obj = value as Record<string, unknown>;
        const required = schema["required"];
        if (Array.isArray(required)) {
          for (const key of required) {
            if (!(key in obj)) {
              errors.push(`${loc}: missing required property "${String(key)}"`);
            }
          }
        }
        const properties = schema["properties"];
        const propsObj =
          properties !== null && typeof properties === "object" && !Array.isArray(properties)
            ? (properties as Record<string, unknown>)
            : undefined;
        if (propsObj) {
          for (const [key, propSchema] of Object.entries(propsObj)) {
            if (key in obj && propSchema !== null && typeof propSchema === "object") {
              const sub = validateAgainstSchema(
                obj[key],
                propSchema as Record<string, unknown>,
                path ? `${path}.${key}` : key,
              );
              if (!sub.ok) errors.push(...sub.errors);
            }
          }
        }
        if (schema["additionalProperties"] === false) {
          for (const key of Object.keys(obj)) {
            if (propsObj === undefined || !(key in propsObj)) {
              errors.push(`${loc}: unexpected additional property "${key}"`);
            }
          }
        }
      }
    } else if (type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${path || "root"}: expected array, got ${typeof value}`);
      } else {
        const loc2 = path || "root";
        const minItems = schema["minItems"];
        const maxItems = schema["maxItems"];
        // Counts are reported by value: "at most 6" alone does not tell the child
        // how far over it went, and it has to decide what to drop.
        if (typeof minItems === "number" && value.length < minItems) {
          errors.push(`${loc2}: expected at least ${minItems} item(s), got ${value.length}`);
        }
        if (typeof maxItems === "number" && value.length > maxItems) {
          errors.push(`${loc2}: expected at most ${maxItems} item(s), got ${value.length}`);
        }
        const items = schema["items"];
        if (items !== null && typeof items === "object" && !Array.isArray(items)) {
          value.forEach((el, i) => {
            const sub = validateAgainstSchema(el, items as Record<string, unknown>, `${loc2}[${i}]`);
            if (!sub.ok) errors.push(...sub.errors);
          });
          errors.push(...arrayUniquenessErrors(value, schema, items as Record<string, unknown>, loc2));
        }
      }
    } else if (type === "string") {
      if (typeof value !== "string") {
        errors.push(`${path || "root"}: expected string, got ${typeof value}`);
      } else {
        errors.push(...stringBoundErrors(value, schema, path || "root"));
      }
    } else if (type === "number") {
      if (typeof value !== "number") {
        errors.push(`${path || "root"}: expected number, got ${typeof value}`);
      }
    } else if (type === "integer") {
      // A fractional number is the failure the child must be told about by value:
      // "got number" would read as a type mismatch it cannot act on.
      if (typeof value !== "number") {
        errors.push(`${path || "root"}: expected integer, got ${typeof value}`);
      } else if (!Number.isInteger(value)) {
        errors.push(`${path || "root"}: expected integer, got ${JSON.stringify(value)}`);
      }
    } else if (type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`${path || "root"}: expected boolean, got ${typeof value}`);
      }
    }
  }

  // `enum` is independent of `type`: the value must strictly equal one listed member.
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((member) => member === value)) {
    errors.push(`${path || "root"}: value ${JSON.stringify(value)} not in enum`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function stringBoundErrors(value: string, schema: Record<string, unknown>, loc: string): string[] {
  const errors: string[] = [];
  const minLength = schema["minLength"];
  const maxLength = schema["maxLength"];
  // Lengths are reported by value so the child knows how much to cut, and the
  // pattern is echoed because "invalid id" gives it nothing to correct toward.
  if (typeof minLength === "number" && value.length < minLength) {
    errors.push(`${loc}: expected at least ${minLength} character(s), got ${value.length}`);
  }
  if (typeof maxLength === "number" && value.length > maxLength) {
    errors.push(`${loc}: expected at most ${maxLength} character(s), got ${value.length}`);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && !compilePattern(pattern).test(value)) {
    errors.push(`${loc}: value ${JSON.stringify(value)} does not match pattern ${pattern}`);
  }
  // The count, not the value: a blank string can be hundreds of whitespace
  // characters, and echoing them would splice junk into the retry prompt — and
  // therefore into the replay key.
  if (schema["nonBlank"] === true && value.trim() === "") {
    errors.push(`${loc}: expected a non-blank string, got ${value.length} whitespace character(s)`);
  }
  return errors;
}

/**
 * Uniqueness runs after the per-element `items` pass and only over elements
 * whose runtime type matches the declared one, so a wrong-typed element reports
 * its type error and nothing else — the error set stays a pure function of the
 * value, which matters because these strings enter the retry prompt and the
 * replay key. Every later duplicate is reported at its own index and names the
 * first occurrence, which is the only form that says which one to edit.
 */
function arrayUniquenessErrors(
  value: readonly unknown[],
  schema: Record<string, unknown>,
  items: Record<string, unknown>,
  loc: string,
): string[] {
  const errors: string[] = [];
  const itemType = items["type"];

  const trimmed = schema["uniqueTrimmedItems"] === true;
  if (schema["uniqueItems"] === true || trimmed) {
    const firstIndex = new Map<unknown, number>();
    value.forEach((element, index) => {
      if (!matchesPrimitiveType(element, itemType)) return;
      const key = trimmed ? (element as string).trim() : element;
      const seen = firstIndex.get(key);
      if (seen === undefined) {
        firstIndex.set(key, index);
        return;
      }
      errors.push(
        trimmed
          ? `${loc}[${index}]: trimmed value ${JSON.stringify(key)} duplicates item ${seen}`
          : `${loc}[${index}]: value ${JSON.stringify(element)} duplicates item ${seen}`,
      );
    });
  }

  const uniqueBy = schema["uniqueBy"];
  if (typeof uniqueBy === "string" && uniqueBy !== "") {
    const firstIndex = new Map<unknown, number>();
    value.forEach((element, index) => {
      if (!isRecord(element) || !(uniqueBy in element)) return;
      const key = element[uniqueBy];
      const seen = firstIndex.get(key);
      if (seen === undefined) {
        firstIndex.set(key, index);
        return;
      }
      errors.push(`${loc}[${index}].${uniqueBy}: value ${JSON.stringify(key)} duplicates item ${seen}`);
    });
  }

  return errors;
}

function matchesPrimitiveType(value: unknown, type: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return false;
}
