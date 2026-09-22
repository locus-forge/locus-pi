/**
 * source/workflow-source-provenance.ts — where each value in a workflow source
 * came from.
 *
 * A standard workflow may hold a literal the author wrote, an answer a model
 * produced, a list the runtime owns, or a path the host resolved, and almost
 * every permitted-use rule turns on which of those a name holds. This module
 * answers that one question: it walks declarations, callback parameters, loop
 * items and bounded carries until the classification stops changing, and
 * returns the resulting binding model.
 *
 * It decides nothing about what a classified value may then be used for. The
 * diagnostics it does raise are the ones that make a classification impossible
 * — an unclassifiable callback parameter, a destructured opaque value, two
 * bindings claiming one name — never a judgement about a use.
 */
import type { SgNode } from "@ast-grep/napi";
import {
  staticObjectKey,
  staticStringValue,
  /** Named for the standard grammar this checker validates; the unwrapping itself is lexical. */
  unwrapParentheses as unwrapStandardParentheses,
} from "./workflow-source-literals.js";
import type { WorkflowSourceDiagnosticSink } from "./workflow-source-diagnostics.js";
import {
  boundStandardNames,
  callCallee,
  containsStandardEdgeCall,
  directStandardDslCall,
  isBoundaryInputDefaultExpression,
  standardCallArguments,
  standardCollectionBindings,
  standardFunctionParameterNodes,
  standardFunctionParameters,
  standardLoopBindingNames,
  unwrapStandardValue,
  type StandardCollectionBindings,
  type StandardDslMethod,
} from "./workflow-source-bindings.js";

type StandardValueKind =
  | "known-collection"
  | "known-value"
  | "map-item"
  | "opaque-list"
  | "opaque-value"
  | "runtime-control"
  | "runtime-status"
  | "runtime-value"
  | "unclassified-dsl-value"
  | "void-value";

export interface StandardValueProvenance {
  kind: StandardValueKind;
  sourceMethod?: StandardDslMethod;
}

type StandardDslReturnCategory =
  "agent-dependent" | "opaque-list" | "opaque-value" | "runtime-status" | "runtime-value" | "void-value";

const STANDARD_DSL_RETURN_CATEGORIES = {
  agent: "agent-dependent",
  awaitOperator: "void-value",
  consumeTextArtifact: "opaque-value",
  continuationArtifacts: "opaque-list",
  invokeWorkflow: "runtime-status",
  items: "opaque-list",
  log: "void-value",
  now: "runtime-value",
  outputDir: "runtime-value",
  parallel: "opaque-list",
  phase: "void-value",
  pipeline: "opaque-list",
  projectRoot: "runtime-value",
  promptFile: "opaque-value",
  publishArtifact: "runtime-value",
  publishPrimaryArtifact: "runtime-value",
  publishPrimaryFile: "runtime-value",
  random: "runtime-value",
  workflow: "opaque-value",
  workspace: "opaque-value",
} as const satisfies Record<StandardDslMethod, StandardDslReturnCategory>;

export interface StandardLiteralShadow {
  name: string;
  scopeId: number;
}

export interface StandardBindingModel {
  collections: StandardCollectionBindings;
  literalShadows: StandardLiteralShadow[];
  provenance: Map<string, StandardValueProvenance>;
  carryAssignments: ReadonlySet<number>;
}

export function standardBindingModel(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  errors: WorkflowSourceDiagnosticSink,
): StandardBindingModel {
  const collections = standardCollectionBindings(root, runEntry, dslBindings);
  if (runEntry === undefined)
    return { collections, literalShadows: [], provenance: new Map(), carryAssignments: new Set() };
  const values = standardValueProvenance(root, runEntry, dslBindings, collections, errors);
  return { collections, ...values };
}

function standardValueProvenance(
  root: SgNode,
  runEntry: SgNode,
  dslBindings: ReadonlySet<string>,
  collections: StandardCollectionBindings,
  errors: WorkflowSourceDiagnosticSink,
): Pick<StandardBindingModel, "literalShadows" | "provenance" | "carryAssignments"> {
  const provenance = new Map<string, StandardValueProvenance>();
  const owners = new Map<string, number>();
  const duplicateNames = new Set<string>();
  const reserve = (name: string, value: StandardValueProvenance, ownerId: number): void => {
    const priorOwner = owners.get(name);
    if (priorOwner !== undefined && priorOwner !== ownerId) {
      duplicateNames.add(name);
      return;
    }
    // An empty array seed cannot erase a carried model list on the alias fixed-point pass.
    if (priorOwner === ownerId && provenance.get(name)?.kind === "opaque-list" && value.kind === "known-collection")
      return;
    owners.set(name, ownerId);
    provenance.set(name, value);
  };
  const parameters = standardFunctionParameterNodes(standardFunctionParameters(runEntry));
  for (const name of boundStandardNames(parameters[1])) {
    reserve(name, { kind: "opaque-value" }, parameters[1]?.id() ?? runEntry.id());
  }
  for (const [name, ownerId] of collections.owners) {
    reserve(name, { kind: "known-collection" }, ownerId);
  }

  collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);

  for (const loop of runEntry.findAll({ rule: { kind: "for_statement" } })) {
    const initializer = loop.field("initializer");
    for (const declaration of initializer?.children().filter((child) => child.kind() === "variable_declarator") ?? []) {
      const name = declaration.field("name");
      if (name?.kind() === "identifier") {
        reserve(name.text(), { kind: "runtime-control" }, declaration.id());
      }
    }
  }

  classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors);

  collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);
  const carryAssignments = collectStandardBoundedCarry(root, runEntry, provenance, dslBindings, errors, reserve);
  // A literal initializer must never wash away the provenance of a later carried answer.
  // Revisit aliases after tainting carry bindings; no model text becomes author-known.
  const declarationCount = root.findAll({ rule: { kind: "variable_declarator" } }).length;
  for (let pass = 0; pass < declarationCount; pass += 1) {
    const before = JSON.stringify([...provenance]);
    for (const loop of runEntry.findAll({ rule: { kind: "for_in_statement" } })) {
      const list = standardExpressionProvenance(loop.field("right") ?? undefined, provenance, dslBindings);
      if (list?.kind !== "opaque-list" && list?.kind !== "known-collection") continue;
      const left = loop.field("left") ?? undefined;
      if (left?.kind() !== "identifier" || !["const", "let"].includes(loop.field("kind")?.text() ?? "")) {
        errors.add("standard profile binds each opaque loop item to one unchanged identifier", left ?? loop);
      }
      for (const name of standardLoopBindingNames(left)) {
        reserve(name, { kind: list.kind === "opaque-list" ? "opaque-value" : "known-value" }, left?.id() ?? loop.id());
      }
    }
    collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);
    classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors);
    if (JSON.stringify([...provenance]) === before) break;
  }
  if (duplicateNames.size > 0) {
    errors.add("standard profile gives every semantic or runtime-owned value binding one unique name", runEntry);
  }
  const literalShadows: StandardLiteralShadow[] = [];
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const name = declaration.field("name");
    if (name?.kind() !== "identifier" || !provenance.has(name.text()) || owners.get(name.text()) === declaration.id()) {
      continue;
    }
    const value = standardExpressionProvenance(declaration.field("value") ?? undefined, provenance, dslBindings);
    const scope = declaration
      .ancestors()
      .find((ancestor) => ancestor.kind() === "statement_block" || ancestor.kind() === "switch_body");
    if (value === undefined && scope !== undefined) literalShadows.push({ name: name.text(), scopeId: scope.id() });
  }
  return { literalShadows, provenance, carryAssignments };
}

function collectStandardDeclarationProvenance(
  root: SgNode,
  provenance: Map<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  errors: WorkflowSourceDiagnosticSink,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
): void {
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const value = standardExpressionProvenance(declaration.field("value") ?? undefined, provenance, dslBindings);
    if (value === undefined) continue;
    const name = declaration.field("name");
    if (name?.kind() !== "identifier") {
      const names =
        value.kind === "known-value" && name !== null && name !== undefined
          ? simpleAuthorRecordBindings(name)
          : undefined;
      if (names !== undefined) {
        for (const binding of names) reserve(binding, { kind: "known-value" }, declaration.id());
        continue;
      }
      errors.add("standard profile does not destructure opaque or runtime-owned values", name ?? declaration);
      continue;
    }
    reserve(name.text(), value, declaration.id());
  }
}

function classifyStandardCallbackParameters(
  root: SgNode,
  runEntry: SgNode,
  provenance: Map<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: WorkflowSourceDiagnosticSink,
): void {
  const callbacks = [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ];
  for (const callback of callbacks) {
    if (callback.id() === runEntry.id()) continue;
    const parameters = standardFunctionParameterNodes(standardFunctionParameters(callback));
    if (parameters.length === 0) continue;
    const ownerCall = callback.ancestors().find((ancestor) => {
      if (ancestor.kind() !== "call_expression") return false;
      return standardCallArguments(ancestor).some(
        (argument) => unwrapStandardParentheses(argument)?.id() === callback.id(),
      );
    });
    const callee = ownerCall === undefined ? undefined : unwrapStandardParentheses(callCallee(ownerCall));
    const method = callee === undefined ? undefined : directStandardDslCall(callee, dslBindings);

    if (callee?.kind() === "member_expression" && callee.field("property")?.text() === "map") {
      const receiver = standardExpressionProvenance(callee.field("object") ?? undefined, provenance, dslBindings);
      if (receiver?.kind !== "opaque-list" && receiver?.kind !== "known-collection") {
        errors.add("standard profile classifies every value-bearing callback parameter", callback);
        continue;
      }
      const parameterKinds: StandardValueKind[] = [
        receiver.kind === "opaque-list" ? "map-item" : "known-value",
        "runtime-control",
        receiver.kind,
      ];
      classifyKnownStandardCallbackParameters(parameters, parameterKinds, reserve, errors, "map");
      continue;
    }

    const ownerArguments = ownerCall === undefined ? [] : standardCallArguments(ownerCall);
    const callbackArgumentIndex = ownerArguments.findIndex(
      (argument) => unwrapStandardParentheses(argument)?.id() === callback.id(),
    );
    if (method === "pipeline" && callbackArgumentIndex > 0) {
      classifyKnownStandardCallbackParameters(
        parameters,
        ["opaque-value", "runtime-control"],
        reserve,
        errors,
        "pipeline stage",
      );
      continue;
    }

    errors.add("standard profile classifies every value-bearing callback parameter", callback);
  }
}

function classifyKnownStandardCallbackParameters(
  parameters: readonly SgNode[],
  kinds: readonly StandardValueKind[],
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: WorkflowSourceDiagnosticSink,
  owner: string,
): void {
  if (parameters.length > kinds.length) {
    errors.add(
      `standard profile permits only documented ${owner} callback parameters`,
      parameters[kinds.length] ?? parameters.at(-1),
    );
  }
  parameters.forEach((parameter, index) => {
    const kind = kinds[index];
    if (kind === undefined) return;
    if (parameter.kind() !== "identifier") {
      const names = kind === "known-value" ? simpleAuthorRecordBindings(parameter) : undefined;
      if (names !== undefined) {
        for (const name of names) reserve(name, { kind: "known-value" }, parameter.id());
        return;
      }
      errors.add(`standard profile keeps each ${owner} callback parameter as one visible identifier`, parameter);
      return;
    }
    reserve(parameter.text(), { kind }, parameter.id());
  });
}

/** Only flat static record bindings are readable author data, never an output parser. */
function simpleAuthorRecordBindings(pattern: SgNode): string[] | undefined {
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

function collectStandardBoundedCarry(
  root: SgNode,
  runEntry: SgNode,
  provenance: Map<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  errors: WorkflowSourceDiagnosticSink,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
): Set<number> {
  const accepted = new Set<number>();
  const declarations = root.findAll({ rule: { kind: "variable_declarator" } });
  const writes = root.findAll({ rule: { kind: "assignment_expression" } });
  const carriedKinds = new Map<string, StandardValueKind>();
  for (const assignment of writes) {
    const target = assignment.field("left");
    const right = unwrapStandardValue(assignment.field("right") ?? undefined);
    const loop = assignment.ancestors().find((ancestor) => ancestor.kind() === "for_statement");
    if (
      target?.kind() !== "identifier" ||
      dslBindings.has(target.text()) ||
      right === undefined ||
      loop === undefined ||
      !isCanonicalBoundedCarryLoop(loop)
    )
      continue;
    const surroundingCallable = assignment
      .ancestors()
      .find((ancestor) =>
        ["arrow_function", "function_expression", "function_declaration"].includes(String(ancestor.kind())),
      );
    if (surroundingCallable?.id() !== runEntry.id()) continue;
    const matches = declarations.filter((declaration) =>
      boundStandardNames(declaration.field("name") ?? undefined).includes(target.text()),
    );
    if (matches.length !== 1) continue;
    const declaration = matches[0]!;
    const declarationStatement = declaration.parent();
    if (declarationStatement?.kind() !== "lexical_declaration" || declarationStatement.children()[0]?.text() !== "let")
      continue;
    if (
      declarationStatement.parent()?.id() !== loop.parent()?.id() ||
      declaration.range().start.index >= loop.range().start.index
    )
      continue;
    const seed = declaration.field("value") ?? undefined;
    const listSeed =
      seed?.kind() === "array" &&
      seed.children().every((child) => ["[", "]", "comment"].includes(String(child.kind())));
    if (!listSeed && staticStringValue(seed) === undefined) continue;
    const callee = right.kind() === "call_expression" ? unwrapStandardParentheses(callCallee(right)) : undefined;
    if (
      right.kind() !== "identifier" &&
      !(callee !== undefined && directStandardDslCall(callee, dslBindings) === "agent")
    )
      continue;
    const value = standardExpressionProvenance(right, provenance, dslBindings);
    if (value === undefined) continue;
    if (listSeed ? value?.kind !== "opaque-list" : value?.kind !== "opaque-value" && value?.kind !== "runtime-control")
      continue;
    const priorKind = carriedKinds.get(target.text());
    if (priorKind !== undefined && priorKind !== value.kind) {
      errors.add("standard bounded carry does not mix opaque text with runtime control", assignment);
      reserve(target.text(), { kind: "opaque-value" }, declaration.id());
      continue;
    }
    // Only the original lexical binding may own this name; callbacks/shadowing cannot launder it.
    const shadowed = root
      .findAll({ rule: { kind: "arrow_function" } })
      .some((callback) => boundStandardNames(standardFunctionParameters(callback)).includes(target.text()));
    if (shadowed) continue;
    carriedKinds.set(target.text(), value.kind);
    reserve(target.text(), value, declaration.id());
    accepted.add(assignment.id());
  }
  return accepted;
}

/** A deliberately small proof, not a general JavaScript termination analysis. */
function isCanonicalBoundedCarryLoop(loop: SgNode): boolean {
  const initializer = loop.field("initializer");
  const declarations = initializer?.children().filter((child) => child.kind() === "variable_declarator") ?? [];
  if (initializer?.kind() !== "lexical_declaration" || declarations.length !== 1) return false;
  const name = declarations[0]!.field("name");
  const start = declarations[0]!.field("value");
  const condition = unwrapStandardParentheses(loop.field("condition") ?? undefined);
  const increment = loop.field("increment");
  if (
    name?.kind() !== "identifier" ||
    start?.kind() !== "number" ||
    condition?.kind() !== "binary_expression" ||
    increment === null ||
    increment === undefined
  )
    return false;
  const end = condition.field("right");
  if (
    condition.field("left")?.text() !== name.text() ||
    end?.kind() !== "number" ||
    !["<", "<="].includes(condition.field("operator")?.text() ?? "")
  )
    return false;
  const first = Number(start.text()),
    last = Number(end.text());
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 0 ||
    first > last ||
    last >= Number.MAX_SAFE_INTEGER
  )
    return false;
  const target = increment.field("left") ?? increment.field("argument");
  if (target?.text() !== name.text()) return false;
  const step =
    increment.kind() === "update_expression" && increment.text().includes("++")
      ? 1
      : increment.kind() === "augmented_assignment_expression" &&
          increment.field("operator")?.text() === "+=" &&
          increment.field("right")?.kind() === "number"
        ? Number(increment.field("right")!.text())
        : NaN;
  if (!Number.isSafeInteger(step) || step <= 0 || !Number.isSafeInteger(last + step)) return false;
  // A second write to the counter would invalidate the proof, including a nested callback.
  return !["assignment_expression", "augmented_assignment_expression", "update_expression"].some((kind) =>
    loop
      .findAll({ rule: { kind } })
      .some(
        (write) =>
          write.id() !== increment.id() && (write.field("left") ?? write.field("argument"))?.text() === name.text(),
      ),
  );
}

export function standardExpressionProvenance(
  node: SgNode | undefined,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[] = [],
): StandardValueProvenance | undefined {
  const value = unwrapStandardValue(node);
  if (value === undefined) return undefined;
  if (value.kind() === "identifier" || value.kind() === "shorthand_property_identifier") {
    if (isInsideLiteralShadow(value, literalShadows)) return undefined;
    return provenance.get(value.text());
  }
  if (value.kind() === "ternary_expression" && isBoundaryInputDefaultExpression(value)) {
    return { kind: "opaque-value" };
  }
  if (value.kind() === "array") {
    return standardCompositeContainsRuntimeValue(value, provenance, dslBindings, literalShadows)
      ? { kind: "opaque-list" }
      : { kind: "known-collection" };
  }
  if (value.kind() === "object") {
    return standardCompositeContainsRuntimeValue(value, provenance, dslBindings, literalShadows)
      ? { kind: "opaque-value" }
      : { kind: "known-value" };
  }
  if (value.kind() === "member_expression" || value.kind() === "subscript_expression") {
    const owner = standardExpressionProvenance(
      value.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (
      owner?.kind === "runtime-status" &&
      value.kind() === "member_expression" &&
      value.field("property")?.text() === "status"
    ) {
      return { kind: "runtime-control" };
    }
    if (owner?.kind === "known-value") return { kind: "known-value" };
    if (owner?.kind === "known-collection" && value.kind() === "subscript_expression") return { kind: "known-value" };
    if (owner?.kind !== "opaque-list") return undefined;
    if (value.kind() === "member_expression" && value.field("property")?.text() === "length") {
      return { kind: "runtime-control" };
    }
    return { kind: "opaque-value" };
  }
  if (value.kind() !== "call_expression") return undefined;
  const callee = unwrapStandardParentheses(callCallee(value));
  if (callee === undefined) return undefined;
  const method = directStandardDslCall(callee, dslBindings);
  if (method !== undefined) return standardDslCallProvenance(method, value);
  if (callee.kind() === "member_expression" && callee.field("property")?.text() === "map") {
    const receiver = standardExpressionProvenance(
      callee.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (receiver?.kind === "known-collection") {
      const callback = standardCallArguments(value)[0];
      // A literal inventory cannot launder answers captured or produced by a mapping callback.
      if (
        callback !== undefined &&
        (containsNonAuthorKnownValue(callback, provenance, dslBindings, literalShadows) ||
          containsStandardEdgeCall(callback))
      )
        return { kind: "opaque-list" };
      return { kind: "known-collection" };
    }
    if (receiver?.kind === "opaque-list") return { kind: "opaque-list" };
  }
  return undefined;
}

export function standardDslCallProvenance(method: StandardDslMethod, call: SgNode): StandardValueProvenance {
  const category: StandardDslReturnCategory | undefined = STANDARD_DSL_RETURN_CATEGORIES[method];
  if (category === undefined) return { kind: "unclassified-dsl-value", sourceMethod: method };
  if (category !== "agent-dependent") return { kind: category, sourceMethod: method };
  const optionKeys = new Set(
    standardCallArguments(call)[1]
      ?.children()
      .filter((child) => child.kind() === "pair")
      .map((pair) => staticObjectKey(pair.field("key"))) ?? [],
  );
  if (optionKeys.has("choice")) return { kind: "runtime-control", sourceMethod: method };
  if (optionKeys.has("handoffs")) return { kind: "opaque-list", sourceMethod: method };
  return { kind: "opaque-value", sourceMethod: method };
}

function standardCompositeContainsRuntimeValue(
  composite: SgNode,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): boolean {
  return standardCompositeValueExpressions(composite).some((expression) => {
    const value = standardExpressionProvenance(expression, provenance, dslBindings, literalShadows);
    return value !== undefined && value.kind !== "known-collection" && value.kind !== "known-value";
  });
}

function standardCompositeValueExpressions(composite: SgNode): SgNode[] {
  const values: SgNode[] = [];
  for (const child of composite.children()) {
    if (child.kind() === "pair") {
      const value = child.field("value");
      if (value !== null) values.push(value);
      continue;
    }
    if (child.kind() === "shorthand_property_identifier") {
      values.push(child);
      continue;
    }
    if (child.kind() === "spread_element") {
      const value = child.children().find((item) => !["...", "comment"].includes(String(item.kind())));
      if (value !== undefined) values.push(value);
      continue;
    }
    if (composite.kind() === "array" && !["[", "]", ",", "comment"].includes(String(child.kind()))) {
      values.push(child);
    }
  }
  return values;
}

export function containsOpaqueValue(
  node: SgNode,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[] = [],
): boolean {
  const candidates = [
    node,
    ...[
      "call_expression",
      "identifier",
      "member_expression",
      "shorthand_property_identifier",
      "subscript_expression",
    ].flatMap((kind) => node.findAll({ rule: { kind } })),
  ];
  return candidates.some((candidate) => {
    const value = standardExpressionProvenance(candidate, provenance, dslBindings, literalShadows);
    return (
      value?.kind === "opaque-value" ||
      value?.kind === "map-item" ||
      value?.kind === "runtime-value" ||
      value?.kind === "void-value" ||
      value?.kind === "unclassified-dsl-value"
    );
  });
}

export function containsNonAuthorKnownValue(
  node: SgNode | undefined,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): boolean {
  if (node === undefined) return false;
  const candidates = [
    node,
    ...[
      "array",
      "call_expression",
      "identifier",
      "member_expression",
      "object",
      "shorthand_property_identifier",
      "subscript_expression",
    ].flatMap((kind) => node.findAll({ rule: { kind } })),
  ];
  return candidates.some((candidate) => {
    const value = standardExpressionProvenance(candidate, provenance, dslBindings, literalShadows);
    return value !== undefined && value.kind !== "known-collection" && value.kind !== "known-value";
  });
}

export function containsOpaqueIndexValue(
  node: SgNode | undefined,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): boolean {
  if (node === undefined) return false;
  const candidates = [
    node,
    ...[
      "call_expression",
      "identifier",
      "member_expression",
      "shorthand_property_identifier",
      "subscript_expression",
    ].flatMap((kind) => node.findAll({ rule: { kind } })),
  ];
  return candidates.some((candidate) => {
    const value = standardExpressionProvenance(candidate, provenance, dslBindings, literalShadows);
    return (
      value !== undefined &&
      value.kind !== "known-collection" &&
      value.kind !== "known-value" &&
      value.kind !== "runtime-control"
    );
  });
}

export function isInsideLiteralShadow(identifier: SgNode, shadows: readonly StandardLiteralShadow[]): boolean {
  const ancestorIds = new Set(identifier.ancestors().map((ancestor) => ancestor.id()));
  return shadows.some((shadow) => shadow.name === identifier.text() && ancestorIds.has(shadow.scopeId));
}
