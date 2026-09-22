/**
 * source/workflow-source-value-rules.ts — what a classified value may be used
 * for.
 *
 * Once provenance says a name holds a model answer, a runtime list or a host
 * path, these rules decide where it may go: which expressions may mention it,
 * which properties may be read from it, which calls may receive it, and which
 * prompt, handoff or publication sinks accept it whole. Mutation, shadowing and
 * the visible call surface are judged here for the same reason — each is a
 * question about a use, not about a fact.
 *
 * The rules consume the binding model and never rebuild it, and they never call
 * back into the checker facade: diagnostics go to the sink they are handed.
 */
import type { SgNode } from "@ast-grep/napi";
import {
  staticObjectKey,
  /** Named for the standard grammar this checker validates; the unwrapping itself is lexical. */
  unwrapParentheses as unwrapStandardParentheses,
} from "./workflow-source-literals.js";
import type { WorkflowSourceDiagnosticSink } from "./workflow-source-diagnostics.js";
import {
  boundStandardNames,
  callCallee,
  directStandardDslCall,
  isBoundaryInputDefaultExpression,
  isInsideBoundaryInputDefault,
  isKnownCollectionReceiver,
  isStandardBindingOccurrence,
  nodeWithinStandardNode,
  standardCallArguments,
  standardFunctionParameters,
  unwrapStandardValue,
  STANDARD_DSL_METHODS,
  STANDARD_PUBLISHED_ARTIFACT_METHODS,
  type StandardCollectionBindings,
} from "./workflow-source-bindings.js";
import {
  containsNonAuthorKnownValue,
  containsOpaqueIndexValue,
  containsOpaqueValue,
  isInsideLiteralShadow,
  standardDslCallProvenance,
  standardExpressionProvenance,
  type StandardBindingModel,
  type StandardValueProvenance,
} from "./workflow-source-provenance.js";

export function validateStandardExpressions(
  root: SgNode,
  protectedBindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
  bindingModel: StandardBindingModel,
  errors: WorkflowSourceDiagnosticSink,
): void {
  for (const expression of root.findAll({ rule: { kind: "sequence_expression" } })) {
    errors.add("standard profile uses no sequence expressions", expression);
  }
  for (const expression of [
    ...root.findAll({ rule: { kind: "assignment_expression" } }),
    ...root.findAll({ rule: { kind: "augmented_assignment_expression" } }),
    ...root.findAll({ rule: { kind: "update_expression" } }),
  ]) {
    if (
      !isOwnedForLoopCounterMutation(expression, protectedBindings) &&
      !bindingModel.carryAssignments.has(expression.id())
    ) {
      errors.add("standard profile does not mutate semantic values or build parser/renderer accumulators", expression);
    }
  }
  for (const expression of root.findAll({ rule: { kind: "new_expression" } })) {
    if (unwrapStandardParentheses(expression.field("constructor") ?? undefined)?.text() !== "Error") {
      errors.add("standard profile constructs no helper, parser, renderer, or ledger objects", expression);
      continue;
    }
    if (
      containsNonAuthorKnownValue(
        expression.field("arguments") ?? undefined,
        bindingModel.provenance,
        dslBindings,
        bindingModel.literalShadows,
      )
    ) {
      errors.add("standard profile constructs Error only from author-known or literal values", expression);
    }
  }
}

function isOwnedForLoopCounterMutation(expression: SgNode, protectedBindings: ReadonlySet<string>): boolean {
  if (expression.kind() === "assignment_expression") return false;
  const loop = expression.ancestors().find((ancestor) => ancestor.kind() === "for_statement");
  if (loop?.field("increment")?.id() !== expression.id()) return false;
  const target = expression.field("left") ?? expression.field("argument");
  if (target?.kind() !== "identifier" || protectedBindings.has(target.text())) return false;
  const initializer = loop.field("initializer");
  if (initializer?.kind() !== "lexical_declaration") return false;
  const counterDeclaration = initializer
    .children()
    .filter((child) => child.kind() === "variable_declarator")
    .find(
      (declaration) =>
        declaration.field("name")?.kind() === "identifier" && declaration.field("name")?.text() === target.text(),
    );
  if (counterDeclaration?.field("value")?.kind() !== "number") return false;
  if (expression.kind() === "update_expression") return true;
  return (
    expression.kind() === "augmented_assignment_expression" &&
    ["+=", "-="].includes(expression.field("operator")?.text() ?? "") &&
    expression.field("right")?.kind() === "number"
  );
}

export function validateStandardCalls(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  bindingModel: StandardBindingModel,
  errors: WorkflowSourceDiagnosticSink,
): void {
  const collectionBindings = bindingModel.collections;
  const visibleCollections = new Set([
    ...collectionBindings.names,
    ...[...bindingModel.provenance].filter(([, value]) => value.kind === "opaque-list").map(([name]) => name),
  ]);
  validateStandardBindingShadows(root, runEntry, dslBindings, collectionBindings, errors);
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee == null || callee.kind() === "import") continue;
    if (callee.kind() === "subscript_expression") {
      errors.add("standard profile uses no computed calls that can hide orchestration or semantic transforms", call);
      continue;
    }
    const directDsl = directStandardDslCall(callee, dslBindings);
    if (
      directDsl === undefined &&
      !isVisibleCollectionCall(call, visibleCollections, dslBindings) &&
      !isBoundaryInputNormalization(call)
    ) {
      errors.add("standard profile calls only direct DSL primitives and visible map/prompt-join operations", call);
    }
  }
}

function validateStandardBindingShadows(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  collectionBindings: StandardCollectionBindings,
  errors: WorkflowSourceDiagnosticSink,
): void {
  if (runEntry === undefined) return;
  const protectedNames = new Set([...dslBindings, ...collectionBindings.names, "Error"]);
  const runParameters = standardFunctionParameters(runEntry);
  for (const name of boundStandardNames(runParameters)) {
    if (name === "Error") errors.add("standard profile does not shadow the global Error constructor", runParameters);
  }

  for (const callback of [
    ...runEntry.findAll({ rule: { kind: "arrow_function" } }),
    ...runEntry.findAll({ rule: { kind: "function_expression" } }),
    ...runEntry.findAll({ rule: { kind: "function_declaration" } }),
  ]) {
    if (callback.id() === runEntry.id()) continue;
    const parameters = standardFunctionParameters(callback);
    if (boundStandardNames(parameters).some((name) => protectedNames.has(name))) {
      errors.add("standard profile nested callbacks do not shadow trusted DSL or collection bindings", callback);
    }
  }

  const runBody = runEntry.children().find((child) => child.kind() === "statement_block");
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const names = boundStandardNames(declaration.field("name") ?? undefined);
    if (!names.some((name) => protectedNames.has(name))) continue;
    const ownerBlock = declaration.ancestors().find((ancestor) => ancestor.kind() === "statement_block");
    const trustedDslDestructure =
      ownerBlock?.id() === runBody?.id() &&
      dslBindings.has("dsl") &&
      declaration.field("value")?.text() === "dsl" &&
      declaration.field("name")?.kind() === "object_pattern" &&
      names.length > 0 &&
      names.every((name) => name !== "dsl" && dslBindings.has(name) && STANDARD_DSL_METHODS.has(name));
    const trustedCollection =
      collectionBindings.ownerIds.has(declaration.id()) &&
      names.every((name) => name !== "Error" && !dslBindings.has(name));
    if (!trustedDslDestructure && !trustedCollection) {
      errors.add("standard profile loop, switch, and nested bindings do not shadow trusted names", declaration);
    }
  }
  for (const loop of runEntry.findAll({ rule: { kind: "for_in_statement" } })) {
    if (boundStandardNames(loop.field("left") ?? undefined).some((name) => protectedNames.has(name))) {
      errors.add("standard profile loop bindings do not shadow trusted DSL, collection, or Error names", loop);
    }
  }
}

function isVisibleCollectionCall(
  call: SgNode,
  bindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
): boolean {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee?.kind() !== "member_expression") return false;
  const method = callee.field("property")?.text();
  if (!isKnownCollectionReceiver(callee.field("object") ?? undefined, bindings, dslBindings)) return false;
  if (method === "map") {
    const args = call.children().find((child) => child.kind() === "arguments");
    return (
      args?.children().some((child) => child.kind() === "arrow_function" || child.kind() === "function_expression") ===
      true
    );
  }
  if (method !== "join") return false;
  const template = call.ancestors().find((ancestor) => ancestor.kind() === "template_string");
  if (template === undefined) return false;
  return template.ancestors().some((ancestor) => {
    if (ancestor.kind() !== "call_expression") return false;
    const outer = unwrapStandardParentheses(callCallee(ancestor));
    return outer?.kind() === "identifier"
      ? outer.text() === "agent"
      : outer?.kind() === "member_expression" && outer.field("property")?.text() === "agent";
  });
}

/** Allow only the documented missing/blank string default at the workflow input boundary. */
function isBoundaryInputNormalization(call: SgNode): boolean {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (
    callee?.kind() !== "member_expression" ||
    callee.field("object")?.text() !== "input" ||
    callee.field("property")?.text() !== "trim"
  ) {
    return false;
  }
  const declaration = call.ancestors().find((ancestor) => ancestor.kind() === "variable_declarator");
  const value = declaration?.field("value");
  return value?.kind() === "ternary_expression" && isBoundaryInputDefaultExpression(value);
}

export function validateStandardValueUses(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  bindingModel: StandardBindingModel,
  errors: WorkflowSourceDiagnosticSink,
): void {
  if (runEntry === undefined) return;
  const { literalShadows, provenance } = bindingModel;

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined) continue;
    const method = directStandardDslCall(callee, dslBindings);
    if (method === undefined) continue;
    const value = standardDslCallProvenance(method, call);
    if (value.kind === "unclassified-dsl-value") {
      errors.add("standard profile rejects DSL calls without an explicit return classification", call);
    } else if (value.kind === "void-value" && !isDiscardedStandardCall(call)) {
      errors.add("standard profile does not use void DSL calls as values", call);
    }
  }

  for (const access of [
    ...root.findAll({ rule: { kind: "member_expression" } }),
    ...root.findAll({ rule: { kind: "subscript_expression" } }),
  ]) {
    if (
      access.kind() === "subscript_expression" &&
      containsOpaqueIndexValue(access.field("index") ?? undefined, provenance, dslBindings, literalShadows)
    ) {
      errors.add("standard profile does not select a subscript with opaque semantic or model-produced values", access);
    }
    const owner = standardExpressionProvenance(
      access.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (owner === undefined || owner.kind === "known-value") continue;
    if (
      owner.kind === "opaque-value" ||
      owner.kind === "map-item" ||
      owner.kind === "runtime-value" ||
      owner.kind === "void-value" ||
      owner.kind === "unclassified-dsl-value"
    ) {
      if (!isInsideBoundaryInputDefault(access)) {
        errors.add(
          "standard profile does not inspect properties of opaque semantic, model, file, host, or runtime values",
          access,
        );
      }
      continue;
    }
    if (owner.kind === "runtime-status") {
      if (access.kind() === "member_expression" && access.field("property")?.text() === "status") continue;
      errors.add("standard profile reads only the exact status identity from a runtime-owned result", access);
      continue;
    }
    if (owner.kind === "runtime-control") {
      errors.add("standard profile uses runtime-owned control values only by exact identity", access);
      continue;
    }
    if (access.kind() === "subscript_expression") continue;
    const property = access.field("property")?.text();
    if (property === "length" || property === "map") continue;
    if (property === "join" && isInsideApprovedOpaqueSink(access, dslBindings)) continue;
    errors.add(
      "standard profile inspects opaque lists only through length, indexing, visible map, or prompt join",
      access,
    );
  }

  for (const expression of [
    ...root.findAll({ rule: { kind: "binary_expression" } }),
    ...root.findAll({ rule: { kind: "unary_expression" } }),
    ...root.findAll({ rule: { kind: "ternary_expression" } }),
  ]) {
    if (isInsideBoundaryInputDefault(expression)) continue;
    if (
      expression.kind() === "binary_expression" &&
      expression.field("operator")?.text() === "+" &&
      isInsideApprovedOpaqueSink(expression, dslBindings)
    ) {
      continue;
    }
    if (containsOpaqueValue(expression, provenance, dslBindings, literalShadows)) {
      errors.add("standard profile does not compare, transform, or branch on opaque semantic values", expression);
    }
  }

  for (const statement of [
    ...root.findAll({ rule: { kind: "if_statement" } }),
    ...root.findAll({ rule: { kind: "switch_statement" } }),
    ...root.findAll({ rule: { kind: "while_statement" } }),
    ...root.findAll({ rule: { kind: "for_statement" } }),
  ]) {
    const condition = statement.field("condition") ?? statement.field("value");
    if (condition !== null && containsOpaqueValue(condition, provenance, dslBindings, literalShadows)) {
      errors.add(
        "standard profile control flow uses runtime-owned choices, list identity, status, or counters",
        condition ?? statement,
      );
    }
  }

  for (const template of root.findAll({ rule: { kind: "template_string" } })) {
    if (
      containsOpaqueValue(template, provenance, dslBindings, literalShadows) &&
      !isInsideApprovedOpaqueSink(template, dslBindings)
    ) {
      errors.add(
        "standard profile renders opaque values only inside an agent prompt or exact text publication",
        template,
      );
    }
  }

  for (const identifier of [
    ...root.findAll({ rule: { kind: "identifier" } }),
    ...root.findAll({ rule: { kind: "shorthand_property_identifier" } }),
  ]) {
    if (isInsideLiteralShadow(identifier, literalShadows)) continue;
    const value = provenance.get(identifier.text());
    if (value === undefined || ["known-collection", "known-value", "runtime-control"].includes(value.kind)) continue;
    if (isStandardBindingOccurrence(identifier) || isDirectProvenanceAlias(identifier)) continue;
    const carry = identifier.ancestors().find((ancestor) => bindingModel.carryAssignments.has(ancestor.id()));
    if (
      carry !== undefined &&
      (carry.field("left")?.id() === identifier.id() ||
        unwrapStandardValue(carry.field("right") ?? undefined)?.id() === identifier.id())
    )
      continue;
    if (value.kind === "void-value") {
      errors.add("standard profile does not use void DSL calls as values", identifier);
      continue;
    }
    if (value.kind === "unclassified-dsl-value") {
      errors.add("standard profile rejects DSL calls without an explicit return classification", identifier);
      continue;
    }
    if (isInsideBoundaryInputDefault(identifier) || isInsideApprovedOpaqueSink(identifier, dslBindings)) continue;
    if (value.kind === "opaque-list" && isOpaqueListStructuralUse(identifier)) continue;
    if (value.kind === "runtime-status" && isRuntimeStatusIdentityUse(identifier)) continue;
    if (isWholeValueReturnUse(identifier)) continue;
    if (isPublishedArtifactContinuationUse(identifier, value, dslBindings)) continue;
    if (isPublishedArtifactHandoffDetailUse(identifier, value, dslBindings)) continue;
    if (isUnchangedScheduledValueUse(identifier, value, dslBindings)) continue;
    errors.add(
      "standard profile forwards opaque semantic, model, file, host, and runtime values only as whole values",
      identifier,
    );
  }
}

function isInsideApprovedOpaqueSink(node: SgNode, dslBindings: ReadonlySet<string>): boolean {
  for (const call of node.ancestors().filter((ancestor) => ancestor.kind() === "call_expression")) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined) continue;
    const method = directStandardDslCall(callee, dslBindings);
    const argumentsList = standardCallArguments(call);
    const argumentIndex = argumentsList.findIndex((argument) => nodeWithinStandardNode(node, argument));
    if (argumentIndex < 0) continue;
    const approved =
      ((method === "agent" || method === "log") && argumentIndex === 0) ||
      ((method === "publishArtifact" || method === "publishPrimaryArtifact") && argumentIndex === 1);
    if (!approved) continue;
    if (node.kind() !== "identifier" && node.kind() !== "shorthand_property_identifier") return true;
    return isWholeValueOpaqueSinkPath(node, argumentsList[argumentIndex]);
  }
  return false;
}

function isWholeValueOpaqueSinkPath(node: SgNode, argument: SgNode | undefined): boolean {
  if (argument === undefined) return false;
  let current = node;
  while (current.id() !== argument.id()) {
    const parent = current.parent();
    if (parent === null || !nodeWithinStandardNode(parent, argument)) return false;
    if (parent.kind() === "binary_expression") {
      if (parent.field("operator")?.text() !== "+") return false;
    } else if (
      !["parenthesized_expression", "template_string", "template_substitution"].includes(String(parent.kind()))
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

function isDirectProvenanceAlias(identifier: SgNode): boolean {
  const declaration = identifier.ancestors().find((ancestor) => ancestor.kind() === "variable_declarator");
  const value = unwrapStandardValue(declaration?.field("value") ?? undefined);
  return value?.id() === identifier.id();
}

function isOpaqueListStructuralUse(identifier: SgNode): boolean {
  const parent = identifier.parent();
  if (
    (parent?.kind() === "member_expression" || parent?.kind() === "subscript_expression") &&
    parent.field("object")?.id() === identifier.id()
  ) {
    return true;
  }
  const loop = identifier.ancestors().find((ancestor) => ancestor.kind() === "for_in_statement");
  if (
    loop !== undefined &&
    nodeWithinStandardNode(identifier, unwrapStandardParentheses(loop.field("right") ?? undefined))
  ) {
    return true;
  }
  return isWholeValueCallArgument(identifier, new Set(["parallel", "pipeline"]), 0);
}

function isRuntimeStatusIdentityUse(identifier: SgNode): boolean {
  const parent = identifier.parent();
  return (
    parent?.kind() === "member_expression" &&
    parent.field("object")?.id() === identifier.id() &&
    parent.field("property")?.text() === "status"
  );
}

function isWholeValueReturnUse(identifier: SgNode): boolean {
  for (const ancestor of identifier.ancestors()) {
    if (ancestor.kind() === "return_statement") return true;
    if (
      ![
        "array",
        "await_expression",
        "object",
        "pair",
        "parenthesized_expression",
        "shorthand_property_identifier",
      ].includes(String(ancestor.kind()))
    ) {
      return false;
    }
  }
  return false;
}

function isPublishedArtifactContinuationUse(
  identifier: SgNode,
  provenance: StandardValueProvenance,
  dslBindings: ReadonlySet<string>,
): boolean {
  if (
    provenance.kind !== "runtime-value" ||
    provenance.sourceMethod === undefined ||
    !STANDARD_PUBLISHED_ARTIFACT_METHODS.has(provenance.sourceMethod)
  ) {
    return false;
  }

  let element = identifier;
  while (element.parent()?.kind() === "parenthesized_expression") element = element.parent()!;
  const refs = element.parent();
  if (refs?.kind() !== "array") return false;

  const refsPair = refs.parent();
  if (
    refsPair?.kind() !== "pair" ||
    staticObjectKey(refsPair.field("key")) !== "continuationArtifactRefs" ||
    refsPair.field("value")?.id() !== refs.id()
  ) {
    return false;
  }

  const handoff = refsPair.parent();
  const handoffPair = handoff?.parent();
  if (
    handoff?.kind() !== "object" ||
    handoffPair?.kind() !== "pair" ||
    staticObjectKey(handoffPair.field("key")) !== "operatorHandoff" ||
    handoffPair.field("value")?.id() !== handoff.id()
  ) {
    return false;
  }

  const declaration = handoffPair.parent();
  if (declaration?.kind() !== "object") return false;
  const call = declaration.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined || standardCallArguments(call)[0]?.id() !== declaration.id()) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  return callee !== undefined && directStandardDslCall(callee, dslBindings) === "awaitOperator";
}

function isPublishedArtifactHandoffDetailUse(
  identifier: SgNode,
  provenance: StandardValueProvenance,
  dslBindings: ReadonlySet<string>,
): boolean {
  if (
    provenance.kind !== "runtime-value" ||
    provenance.sourceMethod === undefined ||
    !STANDARD_PUBLISHED_ARTIFACT_METHODS.has(provenance.sourceMethod)
  ) {
    return false;
  }
  const detailPair = identifier.ancestors().find((ancestor) => ancestor.kind() === "pair");
  if (
    detailPair === undefined ||
    staticObjectKey(detailPair.field("key")) !== "detailArtifactRef" ||
    !nodeWithinStandardNode(identifier, detailPair.field("value") ?? undefined)
  ) {
    return false;
  }
  const question = detailPair.parent();
  const questions = question?.parent();
  const questionsPair = questions?.parent();
  if (
    question?.kind() !== "object" ||
    questions?.kind() !== "array" ||
    questionsPair?.kind() !== "pair" ||
    staticObjectKey(questionsPair.field("key")) !== "questions"
  ) {
    return false;
  }
  const handoff = questionsPair.parent();
  const handoffPair = handoff?.parent();
  if (
    handoff?.kind() !== "object" ||
    handoffPair?.kind() !== "pair" ||
    staticObjectKey(handoffPair.field("key")) !== "operatorHandoff"
  ) {
    return false;
  }
  const declaration = handoffPair.parent();
  if (declaration?.kind() !== "object") return false;
  const call = declaration.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined || standardCallArguments(call)[0]?.id() !== declaration.id()) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  return callee !== undefined && directStandardDslCall(callee, dslBindings) === "awaitOperator";
}

function isUnchangedScheduledValueUse(
  identifier: SgNode,
  provenance: StandardValueProvenance,
  dslBindings: ReadonlySet<string>,
): boolean {
  const pair = identifier.ancestors().find((ancestor) => ancestor.kind() === "pair");
  const shorthand = identifier.kind() === "shorthand_property_identifier" ? identifier : undefined;
  const propertyName = pair === undefined ? shorthand?.text() : staticObjectKey(pair.field("key"));
  if (propertyName === "outputDir") {
    if (provenance.kind !== "runtime-value" || provenance.sourceMethod !== "outputDir") return false;
  } else if (!["input", "item", "items", "key", "keys"].includes(propertyName ?? "")) {
    return false;
  }
  const container = pair ?? shorthand;
  const value = pair?.field("value") ?? shorthand;
  if (container === undefined || !nodeWithinStandardNode(identifier, value ?? undefined)) return false;
  if (pair !== undefined) {
    for (const ancestor of identifier.ancestors()) {
      if (ancestor.id() === container.id()) break;
      if (!["array", "parenthesized_expression"].includes(String(ancestor.kind()))) return false;
    }
  }
  const call = container.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee === undefined) return false;
  const method = directStandardDslCall(callee, dslBindings);
  return method === "invokeWorkflow" || method === "workflow";
}

function isDiscardedStandardCall(call: SgNode): boolean {
  let current = call;
  let parent = current.parent();
  while (parent !== null && ["await_expression", "parenthesized_expression"].includes(String(parent.kind()))) {
    current = parent;
    parent = current.parent();
  }
  return parent?.kind() === "expression_statement";
}

function isWholeValueCallArgument(identifier: SgNode, methods: ReadonlySet<string>, index: number): boolean {
  const call = identifier.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  const name =
    callee?.kind() === "identifier"
      ? callee.text()
      : callee?.kind() === "member_expression"
        ? callee.field("property")?.text()
        : undefined;
  const argument = standardCallArguments(call)[index];
  return name !== undefined && methods.has(name) && nodeWithinStandardNode(identifier, argument);
}
