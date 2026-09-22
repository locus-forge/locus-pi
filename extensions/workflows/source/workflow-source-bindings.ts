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
  "outputDir",
  "parallel",
  "phase",
  "pipeline",
  "projectRoot",
  "promptFile",
  "publishArtifact",
  "publishPrimaryArtifact",
  "publishPrimaryFile",
  "random",
  "workflow",
  "workspace",
] as const;

export type StandardDslMethod = (typeof STANDARD_DSL_METHOD_NAMES)[number];

export const STANDARD_DSL_METHODS: ReadonlySet<string> = new Set(STANDARD_DSL_METHOD_NAMES);

export const STANDARD_PUBLISHED_ARTIFACT_METHODS: ReadonlySet<StandardDslMethod> = new Set([
  "publishArtifact",
  "publishPrimaryArtifact",
  "publishPrimaryFile",
]);

const STANDARD_COLLECTION_DSL_METHODS = new Set(["agent", "continuationArtifacts", "items", "parallel", "pipeline"]);

export interface StandardLexicalBinding {
  activationIndex: number;
  bindingId: number;
  name: string;
  shadowIndex: number;
  scopeId: number;
}

interface StandardPhaseDslBindings {
  dsl: readonly StandardLexicalBinding[];
  phase: readonly StandardLexicalBinding[];
}

export interface StandardCollectionBindings {
  names: Set<string>;
  ownerIds: Set<number>;
  owners: Map<string, number>;
}

export function standardLexicalBindings(root: SgNode): StandardLexicalBinding[] {
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
  return bindings;
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

export function standardDslBindings(runEntry: SgNode | undefined): Set<string> {
  const bindings = new Set<string>();
  if (runEntry === undefined) return bindings;
  const parameters = standardFunctionParameters(runEntry);
  const firstParameter = standardFunctionParameterNodes(parameters)[0];
  if (firstParameter?.kind() === "identifier" && firstParameter.text() === "dsl") {
    bindings.add("dsl");
  }
  if (firstParameter?.kind() === "object_pattern") addStandardDslBindings(bindings, firstParameter);
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

function addStandardDslBindings(bindings: Set<string>, pattern: SgNode): void {
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

export function standardPhaseDslBindings(
  runEntry: SgNode,
  lexicalBindings: readonly StandardLexicalBinding[],
): StandardPhaseDslBindings {
  const parameters = standardFunctionParameters(runEntry);
  const firstParameter = standardFunctionParameterNodes(parameters)[0];
  const parameterBindings = new Set<string>();
  if (firstParameter?.kind() === "object_pattern") addStandardDslBindings(parameterBindings, firstParameter);

  const trustedDeclaratorIds = new Set<number>();
  const runBody = runEntry.children().find((child) => child.kind() === "statement_block");
  for (const declaration of runEntry.findAll({ rule: { kind: "variable_declarator" } })) {
    const ownerBlock = declaration.ancestors().find((ancestor) => ancestor.kind() === "statement_block");
    const pattern = declaration.field("name");
    if (
      ownerBlock?.id() !== runBody?.id() ||
      declaration.field("value")?.text() !== "dsl" ||
      pattern?.kind() !== "object_pattern"
    ) {
      continue;
    }
    const bindings = new Set<string>();
    addStandardDslBindings(bindings, pattern);
    if (bindings.has("phase")) trustedDeclaratorIds.add(declaration.id());
  }

  return {
    dsl:
      firstParameter?.kind() === "identifier" && firstParameter.text() === "dsl"
        ? lexicalBindings.filter(
            (binding) => binding.name === "dsl" && binding.bindingId === (parameters?.id() ?? firstParameter.id()),
          )
        : [],
    phase: lexicalBindings.filter(
      (binding) =>
        binding.name === "phase" &&
        ((parameterBindings.has("phase") && binding.bindingId === parameters?.id()) ||
          trustedDeclaratorIds.has(binding.bindingId)),
    ),
  };
}

export function isTrustedStandardPhaseCall(
  call: SgNode,
  callee: SgNode,
  lexicalBindings: readonly StandardLexicalBinding[],
  bindings: StandardPhaseDslBindings,
): boolean {
  if (callee.kind() === "identifier" && callee.text() === "phase") {
    return hasOnlyActiveTrustedBinding(call, "phase", lexicalBindings, bindings.phase);
  }
  return (
    callee.kind() === "member_expression" &&
    callee.field("object")?.text() === "dsl" &&
    callee.field("property")?.text() === "phase" &&
    hasOnlyActiveTrustedBinding(call, "dsl", lexicalBindings, bindings.dsl)
  );
}

function hasOnlyActiveTrustedBinding(
  node: SgNode,
  name: string,
  lexicalBindings: readonly StandardLexicalBinding[],
  trustedBindings: readonly StandardLexicalBinding[],
): boolean {
  const ancestorIds = new Set(node.ancestors().map((ancestor) => ancestor.id()));
  const nodeIndex = node.range().start.index;
  const visible = lexicalBindings.filter(
    (binding) => binding.name === name && ancestorIds.has(binding.scopeId) && nodeIndex >= binding.shadowIndex,
  );
  const activeTrustedIds = new Set(
    trustedBindings
      .filter(
        (binding) =>
          ancestorIds.has(binding.scopeId) && nodeIndex >= binding.shadowIndex && nodeIndex >= binding.activationIndex,
      )
      .map((binding) => binding.bindingId),
  );
  return activeTrustedIds.size > 0 && visible.every((binding) => activeTrustedIds.has(binding.bindingId));
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
    if (isStandardCollectionExpression(declaration.field("value") ?? undefined, names, dslBindings)) {
      names.add(name.text());
      ownerIds.add(declaration.id());
      owners.set(name.text(), declaration.id());
    }
  }
  return { names, ownerIds, owners };
}

export function boundStandardNames(pattern: SgNode | undefined): string[] {
  if (pattern === undefined) return [];
  if (pattern.kind() === "identifier" || pattern.kind() === "shorthand_property_identifier_pattern") {
    return [pattern.text()];
  }
  if (pattern.kind() === "pair_pattern") {
    return boundStandardNames(pattern.field("value") ?? undefined);
  }
  const names: string[] = [];
  for (const child of pattern.children()) {
    if (
      child.kind() === "property_identifier" ||
      child.kind() === "shorthand_property_identifier" ||
      child.kind() === "comment"
    ) {
      continue;
    }
    names.push(...boundStandardNames(child));
  }
  return names;
}

/** Tree-sitter exposes a bare arrow parameter separately from parenthesized parameters. */
export function standardFunctionParameters(callable: SgNode): SgNode | undefined {
  return callable.field("parameters") ?? callable.field("parameter") ?? undefined;
}

export function standardFunctionParameterNodes(parameters: SgNode | undefined): SgNode[] {
  if (parameters === undefined) return [];
  if (parameters.kind() !== "formal_parameters") return [parameters];
  return parameters
    .children()
    .filter((child) =>
      ["array_pattern", "assignment_pattern", "identifier", "object_pattern", "rest_pattern"].includes(
        String(child.kind()),
      ),
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

export function isStandardBindingOccurrence(identifier: SgNode): boolean {
  for (const declaration of identifier.ancestors().filter((ancestor) => ancestor.kind() === "variable_declarator")) {
    if (nodeWithinStandardNode(identifier, declaration.field("name") ?? undefined)) return true;
  }
  for (const callable of identifier
    .ancestors()
    .filter((ancestor) =>
      ["arrow_function", "function_declaration", "function_expression"].includes(String(ancestor.kind())),
    )) {
    if (nodeWithinStandardNode(identifier, standardFunctionParameters(callable))) return true;
  }
  for (const loop of identifier.ancestors().filter((ancestor) => ancestor.kind() === "for_in_statement")) {
    if (nodeWithinStandardNode(identifier, loop.field("left") ?? undefined)) return true;
  }
  return false;
}

export function nodeWithinStandardNode(node: SgNode, container: SgNode | undefined): boolean {
  return (
    container !== undefined &&
    (node.id() === container.id() || node.ancestors().some((item) => item.id() === container.id()))
  );
}

function isStandardCollectionExpression(
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

export function isKnownCollectionReceiver(
  node: SgNode | undefined,
  bindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
): boolean {
  const value = unwrapStandardValue(node);
  if (value?.kind() === "identifier") return bindings.has(value.text());
  return value?.kind() === "array" || isStandardCollectionExpression(value, bindings, dslBindings);
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
