import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolResult } from "./pi-api.js";
import { errorResult } from "./pi-api.js";

interface ParameterValidationError {
  path: string;
  message: string;
}

function parameterValidationErrors<T extends TSchema>(schema: T, params: unknown): ParameterValidationError[] {
  return [...Value.Errors(schema, params)].map((error) => ({
    path: error.path || "/",
    message: error.message,
  }));
}

function parameterValidationMessage(errors: readonly ParameterValidationError[]): string {
  return `Validation failed:\n${errors.map((error) => `- ${error.path}: ${error.message}`).join("\n")}`;
}

/**
 * Strictly validates raw tool arguments without TypeBox conversion or cloning.
 * Use from Pi's `prepareArguments` hook when coercion would change semantics.
 */
export function prepareValidatedParams<T extends TSchema>(schema: T, params: unknown): Static<T> {
  const errors = parameterValidationErrors(schema, params);
  if (errors.length !== 0) throw new Error(parameterValidationMessage(errors));
  return params as Static<T>;
}

export function validateParams<T extends TSchema>(
  schema: T,
  params: unknown,
): { ok: true; value: Static<T> } | { ok: false; result: ToolResult } {
  const errors = parameterValidationErrors(schema, params);
  if (errors.length !== 0) {
    return {
      ok: false,
      result: errorResult(parameterValidationMessage(errors), { errors }),
    };
  }
  return { ok: true, value: params as Static<T> };
}
