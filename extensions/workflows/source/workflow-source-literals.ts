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
    if (child.kind() === "string_fragment")
      value += node.kind() === "template_string" ? child.text().replace(/\r\n?/gu, "\n") : child.text();
    else if (child.kind() === "escape_sequence") value += decodeEscapeSequence(child.text());
    else if (child.kind() === "template_substitution") return undefined;
  }
  return value;
}

/** The property name a key spells. A computed key has no static name. */
export function staticObjectKey(node: SgNode | null | undefined): string | undefined {
  if (node == null || node.kind() === "computed_property_name") return undefined;
  if (node.kind() === "string") return staticStringValue(node);
  if (node.kind() === "number") {
    const value = Number(node.text().replaceAll("_", ""));
    return Number.isFinite(value) ? String(value) : undefined;
  }
  return node.text().replace(/\\u(?:\{[0-9a-f]+\}|[0-9a-f]{4})/giu, decodeEscapeSequence);
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
  if (["\n", "\r", "\r\n", "\u2028", "\u2029"].includes(body)) return "";
  return body;
}

/** Binding identity is intentionally lexical; escaped spellings need a separate normalization proof. */
export function escapedWorkflowIdentifiers(root: SgNode): SgNode[] {
  return ["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]
    .flatMap((kind) => root.findAll({ rule: { kind } }))
    .filter((node) => node.text().includes("\\"));
}

/** The containing use outside redundant parentheses; arguments and receiver roles stay distinct. */
export function parentOutsideParentheses(node: SgNode): SgNode | undefined {
  let parent = node.parent();
  while (parent?.kind() === "parenthesized_expression") parent = parent.parent();
  return parent ?? undefined;
}

/** Ordinary array/string callable property fact; use-role and uncertainty policy belong to callers. */
export function isWorkflowNativeMethod(name: string, kind?: "array" | "string"): boolean {
  return (
    (kind !== "string" && typeof Object([])[name] === "function") ||
    (kind !== "array" && typeof Object("")[name] === "function")
  );
}

/** A decoder for literal JavaScript data, deliberately not a constant evaluator. */
export function readWorkflowLiteralData(
  input: SgNode | null | undefined,
  resolve?: (node: SgNode) => SgNode | undefined,
  seen = new Set<number>(),
): unknown {
  const node = unwrapParentheses(input ?? undefined);
  if (node === undefined) throw new Error("requires literal JSON data");
  if (node.kind() === "identifier" && resolve !== undefined) {
    if (seen.has(node.id())) throw new Error("cyclic literal reference");
    return readWorkflowLiteralData(resolve(node), resolve, new Set([...seen, node.id()]));
  }
  const string = staticStringValue(node);
  if (string !== undefined) return string;
  if (node.kind() === "true") return true;
  if (node.kind() === "false") return false;
  if (node.kind() === "null") return null;
  if (node.kind() === "unary_expression") {
    const operator = node.field("operator")?.text();
    const argument = unwrapParentheses(node.field("argument") ?? undefined);
    if (!["+", "-"].includes(operator ?? "") || argument?.kind() !== "number")
      throw new Error("requires literal finite JSON numbers");
    const value = readWorkflowLiteralData(argument, resolve, seen);
    if (typeof value !== "number") throw new Error("requires literal finite JSON numbers");
    return operator === "-" ? -value : value;
  }
  if (node.kind() === "number") {
    const value = Number(node.text().replaceAll("_", ""));
    if (!Number.isFinite(value)) throw new Error("requires literal finite JSON numbers");
    return value;
  }
  if (node.kind() === "array") {
    const result: unknown[] = [];
    let awaiting = true;
    for (const child of node.children()) {
      if (["[", "]", "comment"].includes(String(child.kind()))) continue;
      if (child.kind() === ",") {
        if (awaiting) throw new Error("requires dense literal arrays");
        awaiting = true;
      } else {
        result.push(readWorkflowLiteralData(child, resolve, seen));
        awaiting = false;
      }
    }
    return result;
  }
  if (node.kind() === "object") {
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();
    for (const child of node.children()) {
      if (["{", "}", ",", "comment"].includes(String(child.kind()))) continue;
      const key = child.kind() === "pair" ? staticObjectKey(child.field("key")) : undefined;
      if (key === undefined || key === "__proto__" || keys.has(key))
        throw new Error("requires distinct literal data properties; no __proto__, spreads, methods or computed keys");
      keys.add(key);
      entries.push([key, readWorkflowLiteralData(child.field("value"), resolve, seen)]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error("requires literal JSON data; dynamic expressions are runtime-only");
}

/** Ordinary receiver kind from syntax and caller-proven immutable references; never evaluates data. */
export function staticWorkflowDataKind(
  node: SgNode | null | undefined,
  resolve: (reference: SgNode) => SgNode | "string" | undefined,
): "array" | "string" | undefined {
  let value = unwrapParentheses(node ?? undefined);
  const seen = new Set<number>();
  while (value !== undefined && !seen.has(value.id())) {
    seen.add(value.id());
    if (value.kind() === "array") return "array";
    if (["string", "template_string"].includes(String(value.kind()))) return "string";
    if (value.kind() !== "identifier") return undefined;
    const reference = resolve(value);
    if (reference === "string") return reference;
    value = unwrapParentheses(reference);
  }
  return undefined;
}
