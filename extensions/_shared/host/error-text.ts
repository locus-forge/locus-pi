/**
 * extensions/_shared/host/error-text.ts — Coercion of an unknown thrown value to
 * operator-readable text.
 *
 * `catch` binds `unknown`, so every surface that reports a failure to an
 * operator has to answer the same question: is this an `Error` with a message,
 * or something else that has to be stringified? Six modules had each grown their
 * own private copy of the answer (`errorMessage`, `dialogErrorMessage`), and the
 * same ternary was repeated inline at sixteen more call sites across eight
 * extensions. This module is that one answer.
 *
 * Formatting of the resulting text — prefixes, labels, block layout — belongs to
 * the `-ui` module that renders it, not here.
 */

/**
 * The message of a thrown value: `error.message` for an `Error`, `String(value)`
 * for anything else. Behavior is identical to the private copies it replaces.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
