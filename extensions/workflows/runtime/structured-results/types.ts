import type { WorkflowJSONSchema } from "./schema.js";

/** Public view of the detached, deeply frozen JSON graph returned by a structured call. */
export type WorkflowReadonlyJSONValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkflowReadonlyJSONValue[]
  | { readonly [key: string]: WorkflowReadonlyJSONValue };

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type ReadonlyJSONObject = { readonly [key: string]: WorkflowReadonlyJSONValue };

/** Narrow only proven primitives; intersecting compound enums would restore mutable members. */
type WithEnum<Schema, Value> = Schema extends { readonly enum: infer Values extends readonly unknown[] }
  ? IsAny<Values[number]> extends true
    ? Value
    : [Values[number]] extends [null | boolean | number | string]
      ? [Extract<Values[number], object>] extends [never]
        ? Value & Values[number]
        : Value
      : Value
  : Value;

type PropertyName<Key extends PropertyKey> = Key extends number ? `${Key}` : Key;

/** A dynamic list, or a union of lists that sometimes omits the key, proves no presence. */
type IsRequired<Keys, Key extends PropertyKey> =
  IsAny<Keys> extends true
    ? false
    : Keys extends readonly [infer Head, ...infer Tail]
      ? IsAny<Head> extends true
        ? IsRequired<Tail, Key>
        : [Head] extends [PropertyName<Key>]
          ? true
          : IsRequired<Tail, Key>
      : false;

type RequiredKeys<Schema, Properties> = Schema extends { readonly required: infer Keys }
  ? {
      [Key in keyof Properties]-?: [IsRequired<Keys, Key>] extends [true] ? Key : never;
    }[keyof Properties]
  : never;

type PropertyResult<Property> = Property extends WorkflowJSONSchema
  ? WorkflowSchemaResult<Property>
  : WorkflowReadonlyJSONValue;

type ObjectFields<Schema, Properties> = {
  readonly [Key in keyof Properties as Key extends RequiredKeys<Schema, Properties> ? Key : never]-?: PropertyResult<
    Properties[Key]
  >;
} & {
  readonly [Key in keyof Properties as Key extends RequiredKeys<Schema, Properties> ? never : Key]?: PropertyResult<
    Properties[Key]
  >;
};

type ObjectResult<Schema, Properties> =
  IsAny<Properties> extends true
    ? ReadonlyJSONObject
    : Properties extends Readonly<Record<string, unknown>>
      ? string extends keyof Properties
        ? ReadonlyJSONObject
        : Schema extends { readonly additionalProperties: false }
          ? keyof Properties extends never
            ? { readonly [key: string]: never }
            : ObjectFields<Schema, Properties>
          : ObjectFields<Schema, Properties> & ReadonlyJSONObject
      : ReadonlyJSONObject;

type TypedResult<Schema, Type> = Type extends "null"
  ? WithEnum<Schema, null>
  : Type extends "boolean"
    ? WithEnum<Schema, boolean>
    : Type extends "string"
      ? WithEnum<Schema, string>
      : Type extends "number" | "integer"
        ? WithEnum<Schema, number>
        : Type extends "array"
          ? readonly (Schema extends { readonly items: infer Item }
              ? PropertyResult<Item>
              : WorkflowReadonlyJSONValue)[]
          : Type extends "object"
            ? ObjectResult<Schema, Schema extends { readonly properties: infer Properties } ? Properties : {}>
            : WorkflowReadonlyJSONValue;

/**
 * Infer only information carried by the schema type. Broad/dynamic declarations retain
 * the readonly JSON fallback; this is not a caller-selected result assertion or a schema
 * validator. Runtime locus-json-subset-v1 normalization and validation remain authoritative.
 */
export type WorkflowSchemaResult<Schema extends WorkflowJSONSchema> =
  IsAny<Schema> extends true
    ? WorkflowReadonlyJSONValue
    : Schema extends { readonly type: infer Type }
      ? IsAny<Type> extends true
        ? WorkflowReadonlyJSONValue
        : TypedResult<Schema, Type>
      : WorkflowReadonlyJSONValue;
