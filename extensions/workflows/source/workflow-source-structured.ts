/** Static schema declarations and JSON shape facts. Never imports or evaluates workflow source. */
import type { SgNode } from "@ast-grep/napi";
import { normalizeWorkflowStructuredContract, type WorkflowJSONSchema } from "../runtime/structured-results/schema.js";
import {
  callCallee,
  directStandardDslCall,
  standardCallArguments,
  standardDslBindings,
  standardLexicalBindings,
} from "./workflow-source-bindings.js";
import { staticObjectKey, staticStringValue, unwrapParentheses } from "./workflow-source-literals.js";
import type { WorkflowSourceDiagnosticSink } from "./workflow-source-diagnostics.js";

export interface StandardStructuredDeclarations {
  calls: ReadonlyMap<number, WorkflowJSONSchema>;
  schemaNodes: ReadonlySet<number>;
}

export function standardStructuredDeclarations(
  root: SgNode,
  runEntry: SgNode | undefined,
  errors: WorkflowSourceDiagnosticSink,
): StandardStructuredDeclarations {
  const calls = new Map<number, WorkflowJSONSchema>();
  const schemaNodes = new Set<number>();
  const bindings = standardLexicalBindings(root);
  const dsl = standardDslBindings(runEntry);
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapParentheses(callCallee(call));
    if (callee === undefined || directStandardDslCall(callee, dsl) !== "agent") continue;
    const options = unwrapParentheses(standardCallArguments(call)[1]);
    if (options?.kind() !== "object") continue;
    const members = options.children().filter((node) => !["{", "}", ",", "comment"].includes(String(node.kind())));
    const schemaPairs = members.filter(
      (node) => node.kind() === "pair" && staticObjectKey(node.field("key")) === "schema",
    );
    if (schemaPairs.length === 0) {
      if (members.some((node) => node.kind() === "shorthand_property_identifier" && node.text() === "schema"))
        errors.add(
          "agent schema requires an explicit schema property with literal data or one top-level const",
          options,
        );
      continue;
    }
    try {
      const keys = members.map((node) => (node.kind() === "pair" ? staticObjectKey(node.field("key")) : undefined));
      if (keys.some((key) => key === undefined || key === "__proto__") || new Set(keys).size !== keys.length)
        throw new Error(
          "structured agent options require distinct explicit static properties; no spreads or shorthand",
        );
      for (const key of ["choice", "choiceFallback", "result"])
        if (keys.includes(key)) throw new Error(`agent schema cannot be combined with ${key}`);
      let schema = unwrapParentheses(schemaPairs[0]!.field("value") ?? undefined);
      if (schema?.kind() === "identifier") {
        const name = schema.text();
        const scopes = new Set(schema.ancestors().map((node) => node.id()));
        const visible = bindings.filter((binding) => binding.name === name && scopes.has(binding.scopeId));
        const binding = visible.length === 1 ? visible[0] : undefined;
        const declaration = root
          .findAll({ rule: { kind: "variable_declarator" } })
          .find((node) => node.id() === binding?.bindingId);
        if (
          binding?.scopeId !== root.id() ||
          declaration?.field("name")?.kind() !== "identifier" ||
          declaration?.parent()?.parent()?.id() !== root.id() ||
          declaration.parent()?.children()[0]?.text() !== "const"
        )
          throw new Error("agent schema must be literal data or one unshadowed top-level literal const");
        schema = unwrapParentheses(declaration.field("value") ?? undefined);
      }
      const contract = normalizeWorkflowStructuredContract(readStructuredLiteral(schema));
      calls.set(call.id(), contract.schema);
      schemaNodes.add(schemaPairs[0]!.id());
      if (schema !== undefined) {
        schemaNodes.add(schema.id());
        for (const pair of schema.findAll({ rule: { kind: "pair" } })) schemaNodes.add(pair.id());
      }
    } catch (error) {
      errors.add(error instanceof Error ? error.message : String(error), schemaPairs[0]);
    }
  }
  return { calls, schemaNodes };
}

/** A decoder for literal JavaScript data, deliberately not a constant evaluator. */
function readStructuredLiteral(input: SgNode | undefined): unknown {
  const node = unwrapParentheses(input);
  if (node === undefined) throw new Error("agent schema requires literal JSON data");
  const string = staticStringValue(node);
  if (string !== undefined) return string;
  if (node.kind() === "true") return true;
  if (node.kind() === "false") return false;
  if (node.kind() === "null") return null;
  if (node.kind() === "unary_expression") {
    const operator = node.field("operator")?.text();
    const argument = unwrapParentheses(node.field("argument") ?? undefined);
    if (!["+", "-"].includes(operator ?? "") || argument?.kind() !== "number")
      throw new Error("agent schema requires literal finite JSON numbers");
    const value = readStructuredLiteral(argument);
    if (typeof value !== "number") throw new Error("agent schema requires literal finite JSON numbers");
    return operator === "-" ? -value : value;
  }
  if (node.kind() === "number") {
    const value = Number(node.text().replaceAll("_", ""));
    if (!Number.isFinite(value)) throw new Error("agent schema requires literal finite JSON numbers");
    return value;
  }
  if (node.kind() === "array") {
    const result: unknown[] = [];
    let awaiting = true;
    for (const child of node.children()) {
      if (["[", "]", "comment"].includes(String(child.kind()))) continue;
      if (child.kind() === ",") {
        if (awaiting) throw new Error("agent schema requires dense literal arrays");
        awaiting = true;
      } else {
        result.push(readStructuredLiteral(child));
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
        throw new Error(
          "agent schema requires distinct literal data properties; no __proto__, spreads, methods or computed keys",
        );
      keys.add(key);
      entries.push([key, readStructuredLiteral(child.field("value") ?? undefined)]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error("agent schema requires literal JSON data; dynamic expressions are runtime-only");
}

export function structuredRequiredField(schema: WorkflowJSONSchema, name: string): WorkflowJSONSchema | undefined {
  if (schema.type !== "object" || ["__proto__", "constructor", "prototype"].includes(name)) return undefined;
  const properties = schema.properties as Record<string, WorkflowJSONSchema> | undefined;
  return Array.isArray(schema.required) &&
    schema.required.includes(name) &&
    properties !== undefined &&
    Object.hasOwn(properties, name)
    ? properties[name]
    : undefined;
}

export function structuredArrayItem(schema: WorkflowJSONSchema): WorkflowJSONSchema | undefined {
  return schema.type === "array" ? (schema.items as WorkflowJSONSchema | undefined) : undefined;
}

export function structuredRouteValues(schema: WorkflowJSONSchema): readonly unknown[] | undefined {
  return Array.isArray(schema.enum) ? schema.enum : schema.type === "boolean" ? [true, false] : undefined;
}

export function structuredLiteralValue(node: SgNode | undefined): { value: unknown } | undefined {
  try {
    return { value: readStructuredLiteral(node) };
  } catch {
    return undefined;
  }
}
