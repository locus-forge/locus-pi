/** Uses of schema-proven values. Shape proof is never proof of semantic truth or authority. */
import type { SgNode } from "@ast-grep/napi";
import {
  callCallee,
  directStandardDslCall,
  isStandardBindingOccurrence,
  standardCallArguments,
} from "./workflow-source-bindings.js";
import { unwrapParentheses } from "./workflow-source-literals.js";
import {
  standardExpressionProvenance,
  type StandardBindingModel,
  type StandardValueProvenance,
} from "./workflow-source-provenance.js";
import {
  structuredLiteralValue,
  structuredRequiredField,
  structuredRouteValues,
} from "./workflow-source-structured.js";
import type { WorkflowSourceDiagnosticSink } from "./workflow-source-diagnostics.js";

export function isStructuredProvenance(value: StandardValueProvenance | undefined): boolean {
  return value?.kind === "structured-value" || value?.kind === "structured-promise";
}

export function isStructuredArrayMap(call: SgNode, dsl: ReadonlySet<string>, model: StandardBindingModel): boolean {
  const callee = unwrapParentheses(callCallee(call));
  if (callee?.kind() !== "member_expression" || callee.field("property")?.text() !== "map") return false;
  const owner = standardExpressionProvenance(
    callee.field("object") ?? undefined,
    model.provenance,
    dsl,
    model.literalShadows,
  );
  return (
    owner?.kind === "structured-value" &&
    owner.schema?.type === "array" &&
    standardCallArguments(call)[0]?.kind() === "arrow_function"
  );
}

export function validateStructuredValueUses(
  root: SgNode,
  dsl: ReadonlySet<string>,
  model: StandardBindingModel,
  errors: WorkflowSourceDiagnosticSink,
): void {
  validateStructuredMapResults(root, dsl, model, errors);
  const valueOf = (node: SgNode | undefined) =>
    standardExpressionProvenance(node, model.provenance, dsl, model.literalShadows);
  for (const access of [
    ...root.findAll({ rule: { kind: "member_expression" } }),
    ...root.findAll({ rule: { kind: "subscript_expression" } }),
  ]) {
    const owner = valueOf(access.field("object") ?? undefined);
    if (owner?.kind === "structured-promise") {
      errors.add("standard profile awaits a structured agent result before reading fields or arrays", access);
      continue;
    }
    if (owner?.kind !== "structured-value" || owner.schema === undefined) continue;
    const name = access.kind() === "member_expression" ? access.field("property")?.text() : undefined;
    if (name !== undefined && structuredRequiredField(owner.schema, name) !== undefined) continue;
    if (owner.schema.type === "array" && name === "length") continue;
    if (
      owner.schema.type === "array" &&
      name === "map" &&
      access.parent()?.kind() === "call_expression" &&
      callCallee(access.parent()!)?.id() === access.id()
    )
      continue;
    errors.add(
      "standard profile reads only required declared JSON fields and array length/map; optional or unknown fields and unchecked indexes are not proven",
      access,
    );
  }

  for (const kind of [
    "identifier",
    "shorthand_property_identifier",
    "call_expression",
    "member_expression",
    "subscript_expression",
    "await_expression",
    "parenthesized_expression",
  ]) {
    for (const node of root.findAll({ rule: { kind } })) {
      if (isStandardBindingOccurrence(node)) continue;
      const value = valueOf(node);
      if (!isStructuredProvenance(value)) continue;
      const parent = node.parent();
      if (parent === null) continue;
      if (parent.kind() === "parenthesized_expression" || parent.kind() === "await_expression") continue;
      if (
        ["member_expression", "subscript_expression"].includes(String(parent.kind())) &&
        parent.field("object")?.id() === node.id()
      )
        continue;
      if (parent.kind() === "variable_declarator" && parent.field("value")?.id() === node.id()) continue;
      if (
        parent.kind() === "return_statement" ||
        (parent.kind() === "arrow_function" && parent.field("body")?.id() === node.id())
      )
        continue;
      if (value?.kind === "structured-promise") {
        errors.add(
          "standard profile awaits a structured agent result before using it; pending results may only be bound or returned whole",
          node,
        );
        continue;
      }
      const schema = value!.schema!;
      if (parent.kind() === "expression_statement") continue;
      if (
        parent.kind() === "for_in_statement" &&
        parent.field("right")?.id() === node.id() &&
        schema.type === "array" &&
        parent.children().some((child) => child.text() === "of")
      )
        continue;
      if (parent.kind() === "binary_expression" && ["===", "!=="].includes(parent.field("operator")?.text() ?? "")) {
        const other = parent.field("left")?.id() === node.id() ? parent.field("right") : parent.field("left");
        const literal = structuredLiteralValue(other ?? undefined);
        if (literal !== undefined && structuredRouteValues(schema)?.some((value) => value === literal.value)) continue;
      }
      if (isStructuredCompositeCarry(node)) continue;
      if (schema.type === "string" && isExactTextSink(node, dsl)) continue;
      if (!["array", "object"].includes(String(schema.type)) && parent.kind() === "template_substitution") {
        const template = parent.parent();
        if (template?.kind() === "template_string" && isExactTextSink(template, dsl)) continue;
      }
      errors.add(
        "standard profile forwards structured JSON unchanged, reads proven fields/arrays, and routes only by exact declared enum or boolean identity",
        node,
      );
    }
  }
}

/** Shared source/replay boundary: projections cannot persist Promise or function graphs as JSON. */
export function validateStructuredMapResults(
  root: SgNode,
  dsl: ReadonlySet<string>,
  model: StandardBindingModel,
  errors: WorkflowSourceDiagnosticSink,
): void {
  for (const kind of [
    "identifier",
    "shorthand_property_identifier",
    "call_expression",
    "await_expression",
    "parenthesized_expression",
    "array",
    "object",
  ]) {
    for (const node of root.findAll({ rule: { kind } })) {
      if (isStandardBindingOccurrence(node)) continue;
      const value = standardExpressionProvenance(node, model.provenance, dsl, model.literalShadows);
      if (!value?.structuredMap) continue;
      if (value.pendingContents) {
        errors.add(
          "structured array map callbacks return synchronous values or deferred branch functions, never pending Promises",
          node,
        );
        continue;
      }
      if (!value.callableContents) continue;
      const parent = node.parent();
      if (parent?.kind() === "variable_declarator" && parent.field("value")?.id() === node.id()) continue;
      if (["parenthesized_expression", "await_expression", "array", "object"].includes(String(parent?.kind())))
        continue;
      if (parent?.kind() === "pair" && parent.field("value")?.id() === node.id()) continue;
      const call = parent?.kind() === "arguments" ? parent.parent() : undefined;
      const callee = call?.kind() === "call_expression" ? unwrapParentheses(callCallee(call)) : undefined;
      if (
        value.branchList &&
        callee !== undefined &&
        directStandardDslCall(callee, dsl) === "parallel" &&
        standardCallArguments(call!)[0]?.id() === node.id()
      )
        continue;
      errors.add(
        "structured array map function projections are consumed only as direct parallel branches, never emitted as JSON",
        node,
      );
    }
  }
}

function isStructuredCompositeCarry(node: SgNode): boolean {
  let current = node;
  for (const parent of node.ancestors()) {
    if (parent.kind() === "return_statement") return true;
    if (parent.kind() === "variable_declarator") return parent.field("value")?.id() === current.id();
    if (!["array", "object", "pair", "parenthesized_expression"].includes(String(parent.kind()))) return false;
    if (parent.kind() === "pair" && parent.field("value")?.id() !== current.id()) return false;
    current = parent;
  }
  return false;
}

function isExactTextSink(node: SgNode, dsl: ReadonlySet<string>): boolean {
  const argumentsNode = node.parent();
  const call = argumentsNode?.parent();
  if (argumentsNode?.kind() !== "arguments" || call?.kind() !== "call_expression") return false;
  const callee = unwrapParentheses(callCallee(call));
  const method = callee === undefined ? undefined : directStandardDslCall(callee, dsl);
  const index = standardCallArguments(call).findIndex((argument) => argument.id() === node.id());
  return (
    ((method === "agent" || method === "log") && index === 0) ||
    ((method === "publishArtifact" || method === "publishPrimaryArtifact") && index === 1)
  );
}
