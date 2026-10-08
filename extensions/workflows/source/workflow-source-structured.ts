/** Static schema declarations and JSON shape facts. Never imports or evaluates workflow source. */
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { normalizeWorkflowStructuredContract, type WorkflowJSONSchema } from "../runtime/structured-results/schema.js";
import {
  callCallee,
  directStandardDslCall,
  ownedStandardDslCall,
  standardCallArguments,
  standardDslBindings,
  standardLexicalBindings,
  standardBindingOf,
  standardFunctionParameters,
  standardFunctionParameterNodes,
  boundStandardNames,
  isStandardBindingOccurrence,
  nodeWithinStandardNode,
} from "./workflow-source-bindings.js";
import {
  readWorkflowLiteralData,
  staticObjectKey,
  unwrapParentheses,
  exportedMetaObject,
} from "./workflow-source-literals.js";
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
      const schema = resolveStructuredSchema(schemaPairs[0]!.field("value") ?? undefined, root, bindings);
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

/** Only one unshadowed top-level literal const may supply a schema. */
function resolveStructuredSchema(
  input: SgNode | undefined,
  root: SgNode,
  bindings = standardLexicalBindings(root),
): SgNode | undefined {
  let schema = unwrapParentheses(input);
  if (schema?.kind() !== "identifier") return schema;
  const binding = standardBindingOf(schema, bindings);
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
  return schema;
}

/** Full retained source only: catalog prefixes never admit inputs. Opaque late opt-in is checked after import. */
export function workflowSourceInputSchema(source: string | SgNode): WorkflowJSONSchema | undefined {
  const root = typeof source === "string" ? parse(Lang.JavaScript, source).root() : source;
  const schemas: WorkflowJSONSchema[] = [];
  for (const statement of root.children()) {
    const meta = exportedMetaObject(statement);
    if (meta === undefined) continue;
    const pairs = meta
      .children()
      .filter((node) => node.kind() === "pair" && staticObjectKey(node.field("key")) === "inputSchema");
    if (pairs.length === 0) {
      if (
        meta
          .children()
          .some((node) => node.text() === "inputSchema" || staticObjectKey(node.field("name")) === "inputSchema")
      )
        throw new Error("meta.inputSchema requires one explicit static schema declaration");
      continue;
    }
    if (
      pairs.length !== 1 ||
      meta
        .children()
        .some((node) =>
          ["spread_element", "method_definition", "shorthand_property_identifier"].includes(String(node.kind())),
        )
    )
      throw new Error("meta.inputSchema requires one explicit static schema declaration");
    schemas.push(
      normalizeWorkflowStructuredContract(
        readWorkflowLiteralData(resolveStructuredSchema(pairs[0]!.field("value") ?? undefined, root)),
      ).schema,
    );
  }
  if (schemas.length > 1) throw new Error("meta.inputSchema requires one declaration");
  return schemas[0];
}

/** Schema facts for the real root or directly owned inline workflow input. */
export function workflowFunctionInputSchema(root: SgNode, fn: SgNode): WorkflowJSONSchema | undefined {
  if (fn.parent()?.kind() === "export_statement" && /^export\s+default\b/u.test(fn.parent()!.text()))
    return workflowSourceInputSchema(root);
  const call = fn.parent()?.kind() === "arguments" ? fn.parent()?.parent() : undefined;
  if (call?.kind() !== "call_expression" || standardCallArguments(call)[0]?.id() !== fn.id()) return undefined;
  if (ownedStandardDslCall(root, call) !== "workflow") return undefined;
  const descriptor = unwrapParentheses(standardCallArguments(call)[1]);
  if (descriptor?.kind() !== "object") return undefined;
  const pairs = descriptor.children().filter((node) => !["{", "}", ",", "comment"].includes(String(node.kind())));
  if (
    pairs.length !== 2 ||
    pairs.some((node) => node.kind() !== "pair") ||
    new Set(pairs.map((node) => staticObjectKey(node.field("key")))).size !== 2 ||
    !pairs.every((node) => ["inputValue", "inputSchema"].includes(staticObjectKey(node.field("key")) ?? ""))
  )
    throw new Error("workflow typed input requires the closed {inputValue,inputSchema} descriptor");
  const schema = pairs.find((node) => staticObjectKey(node.field("key")) === "inputSchema")!;
  return normalizeWorkflowStructuredContract(
    readWorkflowLiteralData(resolveStructuredSchema(schema.field("value") ?? undefined, root)),
  ).schema;
}

/** Only native kinds actually proved by the schema; legacy entry text keeps its prior kind. */
export function workflowInputNativeKind(root: SgNode, fn: SgNode): "array" | "string" | undefined {
  const schema = workflowFunctionInputSchema(root, fn);
  return schema === undefined
    ? "string"
    : schema.type === "array" || schema.type === "string"
      ? schema.type
      : undefined;
}

/** Input binding facts serve grammar, provenance and replay without another classification engine. */
export function workflowInputBindings(
  root: SgNode,
  runEntry: SgNode | undefined,
): Array<{ name: string; ownerId: number; schema?: WorkflowJSONSchema; operatorContext?: true }> {
  if (runEntry === undefined) return [];
  const bindings: Array<{ name: string; ownerId: number; schema?: WorkflowJSONSchema; operatorContext?: true }> = [];
  for (const fn of [
    runEntry,
    ...runEntry.findAll({ rule: { any: [{ kind: "arrow_function" }, { kind: "function_expression" }] } }),
  ]) {
    let schema: WorkflowJSONSchema | undefined;
    try {
      schema = workflowFunctionInputSchema(root, fn);
    } catch {
      continue;
    }
    if (fn.id() !== runEntry.id() && schema === undefined) continue;
    const params = standardFunctionParameterNodes(standardFunctionParameters(fn));
    for (const name of boundStandardNames(params[1]))
      bindings.push({
        name,
        ownerId: standardFunctionParameters(fn)!.id(),
        ...(schema === undefined ? {} : { schema }),
      });
    if (
      fn.id() === runEntry.id() &&
      schema !== undefined &&
      params[2]?.kind() === "identifier" &&
      workflowTypedEntryIssues(root, fn).length === 0
    )
      bindings.push({ name: params[2].text(), ownerId: standardFunctionParameters(fn)!.id(), operatorContext: true });
  }
  return bindings;
}

/** Checked grammar and replay consume this proof; fresh trusted-JS schema admission does not. */
export function workflowTypedInputIssues(root: SgNode, entry: SgNode | undefined): SgNode[] {
  return entry === undefined
    ? []
    : [
        entry,
        ...entry.findAll({ rule: { any: [{ kind: "arrow_function" }, { kind: "function_expression" }] } }),
      ].flatMap((fn) => workflowTypedEntryIssues(root, fn));
}

/** Optional host context facts never imply an answer exists on an ordinary launch. */
function workflowTypedEntryIssues(root: SgNode, fn: SgNode): SgNode[] {
  try {
    if (workflowFunctionInputSchema(root, fn) === undefined) return [];
  } catch {
    return [fn];
  }
  const parameters = standardFunctionParameterNodes(standardFunctionParameters(fn), true);
  if (parameters[1] !== undefined && parameters[1].kind() !== "identifier") return [parameters[1]];
  const rootEntry = fn.parent()?.kind() === "export_statement" && /^export\s+default\b/u.test(fn.parent()!.text());
  if (parameters.length > (rootEntry ? 3 : 2)) return [parameters.at(-1)!];
  const context = rootEntry ? parameters[2] : undefined;
  if (context === undefined) return [];
  if (context.kind() !== "identifier") return [context];
  const bindings = standardLexicalBindings(root, true);
  const owner = standardFunctionParameters(fn)!.id();
  const contextReference = (node: SgNode | undefined) =>
    node !== undefined &&
    ["identifier", "shorthand_property_identifier"].includes(String(node.kind())) &&
    node.text() === context.text() &&
    standardBindingOf(node, bindings)?.bindingId === owner;
  const presence = (input: SgNode | undefined) => workflowOperatorContextPresence(input, contextReference, bindings);
  function guarded(node: SgNode): boolean {
    for (const ancestor of node.ancestors()) {
      if (!["if_statement", "ternary_expression"].includes(String(ancestor.kind()))) continue;
      const positive = presence(ancestor.field("condition") ?? undefined);
      const branch =
        positive === true
          ? ancestor.field("consequence")
          : positive === false
            ? ancestor.field("alternative")
            : undefined;
      if (branch != null && nodeWithinStandardNode(node, branch)) return true;
    }
    const block = node.ancestors().find((ancestor) => ancestor.kind() === "statement_block");
    const statement = node.ancestors().find((ancestor) => ancestor.parent()?.id() === block?.id());
    if (block === undefined || statement === undefined) return false;
    return block
      .children()
      .slice(
        0,
        block.children().findIndex((child) => child.id() === statement.id()),
      )
      .some((prior) => {
        if (prior.kind() !== "if_statement" || presence(prior.field("condition") ?? undefined) !== false) return false;
        const branch = prior.field("consequence");
        const last =
          branch?.kind() === "statement_block"
            ? branch
                .children()
                .filter((child) => !["{", "}", "comment"].includes(String(child.kind())))
                .at(-1)
            : branch;
        return last != null && ["return_statement", "throw_statement"].includes(String(last.kind()));
      });
  }
  return root
    .findAll({ rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier" }] } })
    .filter((node) => {
      if (isStandardBindingOccurrence(node, true)) return false;
      const binding = node.text() === context.text() ? standardBindingOf(node, bindings) : undefined;
      if (binding !== undefined && node.range().start.index < binding.activationIndex) return true;
      if (!contextReference(node)) return false;
      const parent = node.parent();
      if (parent?.kind() === "binary_expression" && presence(parent) !== undefined) return false;
      return (
        parent?.kind() !== "member_expression" ||
        parent.field("object")?.id() !== node.id() ||
        parent.field("property")?.text() !== "operatorAnswer" ||
        !guarded(parent)
      );
    });
}

/** Exact optional-context presence fact shared by guarded reads and value classification. */
export function workflowOperatorContextPresence(
  input: SgNode | undefined,
  contextReference: (node: SgNode | undefined) => boolean,
  bindings: ReturnType<typeof standardLexicalBindings>,
): boolean | undefined {
  const condition = unwrapParentheses(input);
  if (condition?.kind() !== "binary_expression") return undefined;
  const left = condition.field("left") ?? undefined,
    right = condition.field("right") ?? undefined;
  const absent = contextReference(left) ? right : contextReference(right) ? left : undefined;
  if (
    (absent?.kind() !== "undefined" && absent?.kind() !== "identifier") ||
    absent.text() !== "undefined" ||
    bindings.some(
      (binding) => binding.name === "undefined" && absent.ancestors().some((scope) => scope.id() === binding.scopeId),
    )
  )
    return undefined;
  const operator = condition.field("operator")?.text();
  return operator === "!==" ? true : operator === "===" ? false : undefined;
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
