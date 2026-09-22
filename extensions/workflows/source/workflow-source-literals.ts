/**
 * source/workflow-source-literals.ts — the lexical reading of a workflow source
 * node, shared by every static reader of `.workflow.mjs`.
 *
 * Three readers ask the same purely syntactic questions of an ast-grep node:
 * what string does this literal spell, what name does this object key spell,
 * what expression hides inside these parentheses, and which `export const meta`
 * object does this statement declare. The answers depend on nothing but the
 * node, so they are stated once here instead of being restated by each reader.
 *
 * This module decides no policy. It does not read files, know a profile,
 * classify authoring strictness, or judge whether a value is acceptable — a
 * non-static literal comes back as `undefined` and the caller decides what that
 * means. Those decisions stay with their owners: the tolerant bounded scanner
 * in `catalog/workflow-meta.ts`, the identity assessment in
 * `runtime/workflow-script-identity.ts`, and the strict published-source
 * validator in `tool/workflow-source-shape.ts`. Their failure semantics differ
 * on purpose; only this lexical layer is common.
 */
import type { SgNode } from "@ast-grep/napi";

/** The `meta` object of an `export const meta = { … }` statement, when it declares one. */
export function exportedMetaObject(statement: SgNode): SgNode | undefined {
  const declaration = statement.children().find((child) => child.kind() === "lexical_declaration");
  const variable = declaration
    ?.children()
    .find((child) => child.kind() === "variable_declarator" && child.field("name")?.text() === "meta");
  const value = variable?.field("value");
  return value?.kind() === "object" ? value : undefined;
}

/**
 * The string a literal spells, or `undefined` when the node is not a string
 * literal or its value is not knowable without running it — a template literal
 * with any interpolation is not static.
 */
export function staticStringValue(node: SgNode | null | undefined): string | undefined {
  if (node == null || (node.kind() !== "string" && node.kind() !== "template_string")) return undefined;
  let value = "";
  for (const child of node.children()) {
    if (child.kind() === "string_fragment") value += child.text();
    else if (child.kind() === "escape_sequence") value += decodeEscapeSequence(child.text());
    else if (child.kind() === "template_substitution") return undefined;
  }
  return value;
}

/** The property name a key spells. A computed key has no static name. */
export function staticObjectKey(node: SgNode | null | undefined): string | undefined {
  if (node == null || node.kind() === "computed_property_name") return undefined;
  if (node.kind() === "string") return staticStringValue(node);
  return node.text();
}

/** The expression inside any depth of redundant parentheses. */
export function unwrapParentheses(node: SgNode | undefined): SgNode | undefined {
  let current = node;
  while (current?.kind() === "parenthesized_expression") {
    current = current
      .children()
      .find((child) => child.kind() !== "(" && child.kind() !== ")" && child.kind() !== "comment");
  }
  return current;
}

function decodeEscapeSequence(value: string): string {
  const body = value.slice(1);
  const fixed: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
  if (fixed[body] !== undefined) return fixed[body];
  const unicodeCodePoint = /^u\{([0-9a-f]+)\}$/iu.exec(body)?.[1];
  if (unicodeCodePoint !== undefined) return String.fromCodePoint(Number.parseInt(unicodeCodePoint, 16));
  const unicode = /^u([0-9a-f]{4})$/iu.exec(body)?.[1];
  if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
  const hex = /^x([0-9a-f]{2})$/iu.exec(body)?.[1];
  if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
  if (body === "\n" || body === "\r\n") return "";
  return body;
}
