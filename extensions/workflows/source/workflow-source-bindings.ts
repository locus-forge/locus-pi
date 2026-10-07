/**
 * source/workflow-source-bindings.ts — the lexical facts of one workflow
 * source: the grammar inventories it is read against, the names it declares,
 * the scopes those names are visible in, and the shapes a call or collection
 * expression spells.
 *
 * Every strict check needs the same answers — which DSL methods this source
 * destructured, which identifier a call actually names, where a binding
 * activates, which bindings a pattern introduces — and those answers depend on
 * nothing but the parsed node. Stating them once keeps the phase checker, the
 * provenance analysis and the permitted-use rules reading the same facts.
 *
 * This module reaches no verdict. It emits no diagnostic and holds no opinion
 * about whether a source is acceptable; a caller that dislikes a fact reported
 * here owns that decision.
 */
import type { SgNode } from "@ast-grep/napi";
import {
  staticObjectKey,
  /** Named for the standard grammar this checker validates; the unwrapping itself is lexical. */
  unwrapParentheses as unwrapStandardParentheses,
} from "./workflow-source-literals.js";

const STANDARD_EDGE_METHODS = new Set(["agent", "invokeWorkflow"]);

const STANDARD_INLINE_EDGE_OWNERS = new Set(["parallel", "pipeline", "workflow"]);

const STANDARD_DSL_METHOD_NAMES = [
  "agent",
  "awaitOperator",
  "consumeTextArtifact",
  "continuationArtifacts",
  "invokeWorkflow",
  "items",
  "log",
  "now",
  "parallel",
  "phase",
  "pipeline",
  "projectRoot",
  "promptFile",
  "publishArtifact",
  "publishPrimaryArtifact",
  "random",
  "workflow",
  "workspace",
  "workspaceDir",
] as const;

export type StandardDslMethod = (typeof STANDARD_DSL_METHOD_NAMES)[number];

export const STANDARD_DSL_METHODS: ReadonlySet<string> = new Set(STANDARD_DSL_METHOD_NAMES);

export const STANDARD_PUBLISHED_ARTIFACT_METHODS: ReadonlySet<StandardDslMethod> = new Set([
  "publishArtifact",
  "publishPrimaryArtifact",
]);

const STANDARD_COLLECTION_DSL_METHODS = new Set(["agent", "continuationArtifacts", "items", "parallel", "pipeline"]);

export interface StandardLexicalBinding {
  activationIndex: number;
  bindingId: number;
  name: string;
  shadowIndex: number;
  scopeId: number;
}

export interface StandardCollectionBindings {
  names: Set<string>;
  ownerIds: Set<number>;
  owners: Map<string, number>;
}

/** Catch parameters are opt-in facts; legacy consumers retain their original vocabulary. */
export function standardLexicalBindings(root: SgNode, includeCatchParameters = false): StandardLexicalBinding[] {
  const bindings: StandardLexicalBinding[] = [];
  const add = (
    names: readonly string[],
    scope: SgNode,
    bindingId: number,
    activationIndex = scope.range().start.index,
    shadowIndex = scope.range().start.index,
  ): void => {
    for (const name of names) bindings.push({ activationIndex, bindingId, name, shadowIndex, scopeId: scope.id() });
  };

  for (const callable of [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_declaration" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ]) {
    const parameters = standardFunctionParameters(callable);
    add(boundStandardNames(parameters), callable, parameters?.id() ?? callable.id());
    const name = callable.field("name")?.text();
    if (name === undefined) continue;
    add(
      [name],
      callable.kind() === "function_expression" ? callable : standardLexicalOwner(callable, root),
      callable.id(),
    );
  }

  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const scope = standardLexicalOwner(declaration, root);
    const functionScoped =
      declaration
        .ancestors()
        .find((ancestor) => ["lexical_declaration", "variable_declaration"].includes(String(ancestor.kind())))
        ?.kind() === "variable_declaration";
    const activationIndex = functionScoped
      ? scope.range().start.index
      : (declaration.field("value")?.range().end.index ?? declaration.range().end.index);
    add(boundStandardNames(declaration.field("name") ?? undefined), scope, declaration.id(), activationIndex);
  }
  for (const loop of root.findAll({ rule: { kind: "for_in_statement" } })) {
    add(
      standardLoopBindingNames(loop.field("left") ?? undefined),
      loop,
      loop.id(),
      loop.field("left")?.range().end.index ?? loop.range().start.index,
    );
  }
  for (const clause of includeCatchParameters ? root.findAll({ rule: { kind: "catch_clause" } }) : []) {
    const parameter = clause.field("parameter") ?? undefined;
    add(boundStandardNames(parameter), clause, parameter?.id() ?? clause.id());
  }
  return bindings;
}

/** Nearest lexical declaration, including TDZ shadowing; ambiguity never falls through outward. */
export function standardBindingOf(
  node: SgNode,
  bindings: readonly StandardLexicalBinding[],
): StandardLexicalBinding | undefined {
  const scopes = node.ancestors().map((ancestor) => ancestor.id());
  for (const scopeId of scopes) {
    const local = bindings.filter((binding) => binding.name === node.text() && binding.scopeId === scopeId);
    if (local.length > 0) return local.length === 1 ? local[0] : undefined;
  }
  return undefined;
}

function standardLexicalOwner(node: SgNode, root: SgNode): SgNode {
  if (node.ancestors().some((ancestor) => ancestor.kind() === "variable_declaration")) {
    return (
      node
        .ancestors()
        .find((ancestor) =>
          ["arrow_function", "function_declaration", "function_expression"].includes(String(ancestor.kind())),
        ) ?? root
    );
  }
  const loop = node.ancestors().find((ancestor) => {
    if (ancestor.kind() === "for_statement") {
      return nodeWithinStandardNode(node, ancestor.field("initializer") ?? undefined);
    }
    if (ancestor.kind() === "for_in_statement") {
      return nodeWithinStandardNode(node, ancestor.field("left") ?? undefined);
    }
    return false;
  });
  if (loop !== undefined) return loop;
  return (
    node.ancestors().find((ancestor) => ancestor.kind() === "statement_block" || ancestor.kind() === "switch_body") ??
    root
  );
}

export function standardEntryDslBindings(runEntry: SgNode | undefined): Set<string> {
  const bindings = new Set<string>();
  if (runEntry === undefined) return bindings;
  const parameters = standardFunctionParameters(runEntry);
  const firstParameter = standardFunctionParameterNodes(parameters)[0];
  if (firstParameter?.kind() === "identifier" && firstParameter.text() === "dsl") {
    bindings.add("dsl");
  }
  if (firstParameter?.kind() === "object_pattern") addStandardDslBindings(bindings, firstParameter);
  return bindings;
}

export function standardDslBindings(runEntry: SgNode | undefined): Set<string> {
  const bindings = standardEntryDslBindings(runEntry);
  if (runEntry === undefined) return bindings;
  for (const declaration of runEntry.findAll({ rule: { kind: "variable_declarator" } })) {
    if (
      !bindings.has("dsl") ||
      declaration.field("value")?.text() !== "dsl" ||
      declaration.field("name")?.kind() !== "object_pattern"
    )
      continue;
    addStandardDslBindings(bindings, declaration.field("name")!);
  }
  return bindings;
}

export function addStandardDslBindings(bindings: Set<string>, pattern: SgNode): void {
  for (const child of pattern.children()) {
    if (child.kind() === "shorthand_property_identifier_pattern" && STANDARD_DSL_METHODS.has(child.text())) {
      bindings.add(child.text());
    } else if (child.kind() === "pair_pattern") {
      const key = staticObjectKey(child.field("key"));
      const value = child.field("value")?.text();
      if (key !== undefined && key === value && STANDARD_DSL_METHODS.has(key)) bindings.add(key);
    }
  }
}

export function directStandardDslCall(callee: SgNode, bindings: ReadonlySet<string>): StandardDslMethod | undefined {
  if (callee.kind() === "identifier") {
    return bindings.has(callee.text()) && STANDARD_DSL_METHODS.has(callee.text())
      ? (callee.text() as StandardDslMethod)
      : undefined;
  }
  if (!bindings.has("dsl") || callee.kind() !== "member_expression" || callee.field("object")?.text() !== "dsl") {
    return undefined;
  }
  const property = callee.field("property")?.text();
  return property !== undefined && STANDARD_DSL_METHODS.has(property) ? (property as StandardDslMethod) : undefined;
}

/** Resolve a DSL call through the actual lexical parameter or direct destructure owner. */
export function ownedStandardDslCall(root: SgNode, call: SgNode): StandardDslMethod | undefined {
  const bindings = standardLexicalBindings(root);
  const functions = root.findAll({
    rule: { any: [{ kind: "function_declaration" }, { kind: "function_expression" }, { kind: "arrow_function" }] },
  });
  function vocabulary(reference: SgNode): Set<string> | undefined {
    const binding = standardBindingOf(reference, bindings);
    if (binding === undefined || binding.activationIndex > reference.range().start.index) return undefined;
    const fn = functions.find((node) => standardFunctionParameters(node)?.id() === binding?.bindingId);
    if (fn !== undefined) {
      if (fn.parent()?.kind() !== "export_statement" || !/^export\s+default\b/u.test(fn.parent()!.text())) {
        const owner = fn.parent()?.kind() === "arguments" ? fn.parent()?.parent() : undefined;
        if (
          owner?.kind() !== "call_expression" ||
          method(owner) !== "workflow" ||
          standardCallArguments(owner)[0]?.id() !== fn.id()
        )
          return undefined;
      }
      return standardEntryDslBindings(fn);
    }
    const declaration = root
      .findAll({ rule: { kind: "variable_declarator" } })
      .find((node) => node.id() === binding?.bindingId);
    const value = declaration?.field("value");
    if (
      declaration?.field("name")?.kind() !== "object_pattern" ||
      value?.kind() !== "identifier" ||
      !vocabulary(value)?.has("dsl")
    )
      return undefined;
    const names = new Set<string>();
    addStandardDslBindings(names, declaration.field("name")!);
    return names;
  }
  function method(node: SgNode): StandardDslMethod | undefined {
    const callee = unwrapStandardParentheses(callCallee(node));
    const receiver = callee?.kind() === "member_expression" ? callee.field("object") : callee;
    const names = receiver == null ? undefined : vocabulary(receiver);
    return callee === undefined || names === undefined ? undefined : directStandardDslCall(callee, names);
  }
  return method(call);
}

export function standardCollectionBindings(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
): StandardCollectionBindings {
  const names = new Set<string>();
  const ownerIds = new Set<number>();
  const owners = new Map<string, number>();
  const body = runEntry?.children().find((child) => child.kind() === "statement_block");
  const bodyDeclarations =
    body
      ?.children()
      .flatMap((statement) =>
        statement.kind() === "lexical_declaration"
          ? statement.children().filter((child) => child.kind() === "variable_declarator")
          : [],
      ) ?? [];
  const moduleDeclarations = root
    .children()
    .flatMap((statement) =>
      statement.kind() === "lexical_declaration"
        ? statement.children().filter((child) => child.kind() === "variable_declarator")
        : [],
    );
  const declarations = [...moduleDeclarations, ...bodyDeclarations];
  for (const declaration of declarations) {
    const name = declaration.field("name");
    if (name?.kind() !== "identifier" || names.has(name.text())) continue;
    if (isKnownCollectionReceiver(declaration.field("value") ?? undefined, names, dslBindings)) {
      names.add(name.text());
      ownerIds.add(declaration.id());
      owners.set(name.text(), declaration.id());
    }
  }
  return { names, ownerIds, owners };
}

export function boundStandardNames(pattern: SgNode | undefined): string[] {
  return standardPatternBindings(pattern).map((node) => node.text());
}

/** Only pattern-side nodes bind names; default expressions and computed keys are reads. */
function standardPatternBindings(pattern: SgNode | undefined): SgNode[] {
  if (pattern === undefined) return [];
  const kind = String(pattern.kind());
  if (["identifier", "undefined", "shorthand_property_identifier_pattern"].includes(kind)) return [pattern];
  if (["assignment_pattern", "object_assignment_pattern"].includes(kind))
    return standardPatternBindings(pattern.field("left") ?? undefined);
  if (kind === "pair_pattern") return standardPatternBindings(pattern.field("value") ?? undefined);
  if (!["formal_parameters", "array_pattern", "object_pattern", "rest_pattern"].includes(kind)) return [];
  return pattern.children().flatMap(standardPatternBindings);
}

/** Tree-sitter exposes a bare arrow parameter separately from parenthesized parameters. */
export function standardFunctionParameters(callable: SgNode): SgNode | undefined {
  return callable.field("parameters") ?? callable.field("parameter") ?? undefined;
}

export function standardFunctionParameterNodes(parameters: SgNode | undefined, includeUndefined = false): SgNode[] {
  if (parameters === undefined) return [];
  if (parameters.kind() !== "formal_parameters") return [parameters];
  return parameters
    .children()
    .filter((child) =>
      [
        "array_pattern",
        "assignment_pattern",
        "identifier",
        "object_pattern",
        "rest_pattern",
        ...(includeUndefined ? ["undefined"] : []),
      ].includes(String(child.kind())),
    );
}

export function standardLoopBindingNames(left: SgNode | undefined): string[] {
  if (left?.kind() !== "lexical_declaration") return boundStandardNames(left);
  return left
    .children()
    .filter((child) => child.kind() === "variable_declarator")
    .flatMap((declaration) => boundStandardNames(declaration.field("name") ?? undefined));
}

export function standardCallArguments(call: SgNode): SgNode[] {
  return (
    call
      .children()
      .find((child) => child.kind() === "arguments")
      ?.children()
      .filter((child) => !["(", ")", ",", "comment"].includes(String(child.kind()))) ?? []
  );
}

export function isStandardBindingOccurrence(identifier: SgNode, includeCatchParameters = false): boolean {
  return identifier.ancestors().some((owner) => {
    const kind = String(owner.kind());
    const pattern =
      kind === "variable_declarator"
        ? owner.field("name")
        : kind === "for_in_statement"
          ? owner.field("left")
          : kind === "catch_clause"
            ? includeCatchParameters
              ? owner.field("parameter")
              : undefined
            : ["arrow_function", "function_declaration", "function_expression"].includes(kind)
              ? standardFunctionParameters(owner)
              : undefined;
    return standardPatternBindings(pattern ?? undefined).some((node) => node.id() === identifier.id());
  });
}

export function nodeWithinStandardNode(node: SgNode, container: SgNode | undefined): boolean {
  return (
    container !== undefined &&
    (node.id() === container.id() || node.ancestors().some((item) => item.id() === container.id()))
  );
}

export function isKnownCollectionReceiver(
  node: SgNode | undefined,
  bindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
): boolean {
  const value = unwrapStandardValue(node);
  if (value?.kind() === "array") return true;
  if (value?.kind() === "identifier") return bindings.has(value.text());
  if (value?.kind() !== "call_expression") return false;
  const callee = unwrapStandardParentheses(callCallee(value));
  if (callee === undefined) return false;
  const dslMethod = directStandardDslCall(callee, dslBindings);
  if (dslMethod !== undefined) return STANDARD_COLLECTION_DSL_METHODS.has(dslMethod);
  return (
    callee.kind() === "member_expression" &&
    callee.field("property")?.text() === "map" &&
    isKnownCollectionReceiver(callee.field("object") ?? undefined, bindings, dslBindings)
  );
}

export function unwrapStandardValue(node: SgNode | undefined): SgNode | undefined {
  let current = unwrapStandardParentheses(node);
  while (current?.kind() === "await_expression") {
    current = unwrapStandardParentheses(
      current.children().find((child) => child.kind() !== "await" && child.kind() !== "comment"),
    );
  }
  return current;
}

export function isInsideBoundaryInputDefault(node: SgNode): boolean {
  const expression =
    node.kind() === "ternary_expression"
      ? node
      : node.ancestors().find((ancestor) => ancestor.kind() === "ternary_expression");
  return expression !== undefined && isBoundaryInputDefaultExpression(expression);
}

export function isBoundaryInputDefaultExpression(value: SgNode): boolean {
  return /^typeof\s+input\s*===\s*["']string["']\s*&&\s*input\.trim\(\)\s*\?\s*input\.trim\(\)\s*:\s*["'][^"']+["']$/u.test(
    value.text(),
  );
}

export function containsStandardEdgeCall(node: SgNode): boolean {
  return node
    .findAll({ rule: { kind: "call_expression" } })
    .some((call) => [...STANDARD_EDGE_METHODS].some((edge) => isDirectStandardEdgeCall(call, edge)));
}

export function isVisibleInlineEdgeCallback(callback: SgNode): boolean {
  for (const ancestor of callback.ancestors()) {
    if (ancestor.kind() !== "call_expression") continue;
    const callee = unwrapStandardParentheses(callCallee(ancestor));
    const name =
      callee?.kind() === "identifier"
        ? callee.text()
        : callee?.kind() === "member_expression"
          ? callee.field("property")?.text()
          : undefined;
    if (name === "map") continue;
    return name !== undefined && STANDARD_INLINE_EDGE_OWNERS.has(name);
  }
  return false;
}

function isDirectStandardEdgeCall(call: SgNode, edge: string): boolean {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee?.kind() === "identifier") return callee.text() === edge;
  return callee?.kind() === "member_expression" && callee.field("property")?.text() === edge;
}

export function callCallee(call: SgNode): SgNode | undefined {
  return call.children().find((child) => child.kind() !== "arguments" && child.kind() !== "comment");
}

/** Only flat static record bindings are readable author data, never an output parser. */
export function simpleAuthorRecordBindings(pattern: SgNode): string[] | undefined {
  if (pattern.kind() !== "object_pattern") return undefined;
  const names: string[] = [];
  for (const child of pattern.children()) {
    if (["{", "}", ",", "comment"].includes(String(child.kind()))) continue;
    if (child.kind() === "shorthand_property_identifier_pattern") {
      names.push(child.text());
      continue;
    }
    if (
      child.kind() === "pair_pattern" &&
      staticObjectKey(child.field("key")) !== undefined &&
      child.field("value")?.kind() === "identifier"
    ) {
      names.push(child.field("value")!.text());
      continue;
    }
    return undefined;
  }
  return names.length > 0 ? names : undefined;
}
