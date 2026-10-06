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
import { readWorkflowLiteralData, staticObjectKey, unwrapParentheses } from "./workflow-source-literals.js";
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

/** Preserve schema-specific diagnostics; standard callers pass no reference resolver. */
function readStructuredLiteral(input: SgNode | undefined): unknown {
  try {
    return readWorkflowLiteralData(input);
  } catch (error) {
    throw new Error(`agent schema ${error instanceof Error ? error.message : String(error)}`);
  }
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
