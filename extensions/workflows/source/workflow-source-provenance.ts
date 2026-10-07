/**
 * Source value ownership: classify declarations, callback parameters, loop items and
 * bounded carries until facts converge. Use rules live in the diagnostic owners;
 * this owner reports only unclassifiable/destructured values and ambiguous bindings.
 */
import type { SgNode } from "@ast-grep/napi";
import { standardExpressionProvenance, standardProjectionFacts } from "./workflow-source-provenance-query.js";
export {
  standardExpressionProvenance,
  standardDslCallProvenance,
  containsOpaqueValue,
  containsNonAuthorKnownValue,
  containsOpaqueIndexValue,
  isInsideLiteralShadow,
} from "./workflow-source-provenance-query.js";
import type { WorkflowJSONSchema } from "../runtime/structured-results/schema.js";
import {
  structuredArrayItem,
  workflowInputBindings,
  workflowFunctionInputSchema,
  structuredLiteralValue,
} from "./workflow-source-structured.js";
import {
  staticObjectKey,
  staticStringValue,
  /** Named for the standard grammar this checker validates; the unwrapping itself is lexical. */
  unwrapParentheses as unwrapStandardParentheses,
} from "./workflow-source-literals.js";
import type { WorkflowSourceDiagnosticSink } from "./workflow-source-diagnostics.js";
import {
  boundStandardNames,
  simpleAuthorRecordBindings,
  callCallee,
  directStandardDslCall,
  standardCallArguments,
  standardCollectionBindings,
  standardFunctionParameterNodes,
  standardFunctionParameters,
  standardLoopBindingNames,
  unwrapStandardValue,
  standardLexicalBindings,
  standardBindingOf,
  nodeWithinStandardNode,
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
  | "structured-value"
  | "structured-promise"
  | "unclassified-dsl-value"
  | "void-value";

export interface StandardValueProvenance {
  kind: StandardValueKind;
  operatorContext?: true;
  /** A ternary selects by proven context presence, never answer content. */
  contextSelection?: true;
  sourceMethod?: StandardDslMethod;
  schema?: WorkflowJSONSchema;
  /** Await settles only the root Promise, never pending/callable graph contents. */
  pending?: true;
  pendingContents?: true;
  callable?: true;
  callableContents?: true;
  /** A map of direct, safe branch functions may be consumed by owned parallel(). */
  branchList?: true;
  structuredMap?: true;
}

export type StandardProvenanceMap = ReadonlyMap<string, StandardValueProvenance> & {
  readonly structuredCalls?: ReadonlyMap<number, WorkflowJSONSchema>;
};

export interface StandardLiteralShadow {
  name: string;
  scopeId: number;
  bindingId: number;
}

export interface StandardBindingModel {
  collections: StandardCollectionBindings;
  literalShadows: StandardLiteralShadow[];
  provenance: StandardProvenanceMap;
  carryAssignments: ReadonlySet<number>;
}

export function standardBindingModel(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  errors: WorkflowSourceDiagnosticSink,
  structuredCalls: ReadonlyMap<number, WorkflowJSONSchema> = new Map(),
): StandardBindingModel {
  const collections = standardCollectionBindings(root, runEntry, dslBindings);
  if (runEntry === undefined)
    return { collections, literalShadows: [], provenance: new Map(), carryAssignments: new Set() };
  const values = standardValueProvenance(root, runEntry, dslBindings, collections, errors, structuredCalls);
  return { collections, ...values };
}

function standardValueProvenance(
  root: SgNode,
  runEntry: SgNode,
  dslBindings: ReadonlySet<string>,
  collections: StandardCollectionBindings,
  errors: WorkflowSourceDiagnosticSink,
  structuredCalls: ReadonlyMap<number, WorkflowJSONSchema>,
): Pick<StandardBindingModel, "literalShadows" | "provenance" | "carryAssignments"> {
  const provenance = Object.assign(new Map<string, StandardValueProvenance>(), { structuredCalls });
  const owners = new Map<string, number>();
  const duplicateOwners = new Set<number>();
  const reserve = (name: string, value: StandardValueProvenance, ownerId: number): void => {
    const priorOwner = owners.get(name);
    if (priorOwner !== undefined && priorOwner !== ownerId) {
      duplicateOwners.add(ownerId);
      return;
    }
    // An empty array seed cannot erase a carried model list on the alias fixed-point pass.
    if (priorOwner === ownerId && provenance.get(name)?.kind === "opaque-list" && value.kind === "known-collection")
      return;
    owners.set(name, ownerId);
    provenance.set(name, value);
  };
  for (const { name, schema, ownerId, operatorContext } of workflowInputBindings(root, runEntry)) {
    reserve(
      name,
      operatorContext
        ? { kind: "known-value", operatorContext: true }
        : schema === undefined
          ? { kind: "opaque-value" }
          : { kind: "structured-value", schema },
      ownerId,
    );
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

  classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors, true);

  collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);
  const carryAssignments = collectStandardBoundedCarry(root, runEntry, provenance, dslBindings, errors, reserve);
  // A literal initializer must never wash away the provenance of a later carried answer.
  // Revisit aliases after tainting carry bindings; no model text becomes author-known.
  const declarationCount = root.findAll({ rule: { kind: "variable_declarator" } }).length;
  const bindingPasses = Math.max(
    1,
    declarationCount +
      ["for_in_statement", "arrow_function", "function_expression"].reduce(
        (count, kind) => count + root.findAll({ rule: { kind } }).length,
        0,
      ),
  );
  for (let pass = 0; pass < bindingPasses; pass += 1) {
    const before = JSON.stringify([...provenance]);
    for (const loop of runEntry.findAll({ rule: { kind: "for_in_statement" } })) {
      const list = standardExpressionProvenance(loop.field("right") ?? undefined, provenance, dslBindings);
      const itemSchema =
        list?.kind === "structured-value" && list.schema?.type === "array"
          ? structuredArrayItem(list.schema)
          : undefined;
      const structuredList = list?.kind === "structured-value" && list.schema?.type === "array";
      if (!structuredList && list?.kind !== "opaque-list" && list?.kind !== "known-collection") continue;
      const left = loop.field("left") ?? undefined;
      if (left?.kind() !== "identifier" || !["const", "let"].includes(loop.field("kind")?.text() ?? "")) {
        errors.add("standard profile binds each opaque loop item to one unchanged identifier", left ?? loop);
      }
      for (const name of standardLoopBindingNames(left)) {
        reserve(
          name,
          itemSchema !== undefined
            ? { kind: "structured-value", schema: itemSchema }
            : {
                kind: list?.kind === "opaque-list" || structuredList ? "opaque-value" : "known-value",
                ...standardProjectionFacts([list], true),
              },
          left?.id() ?? loop.id(),
        );
      }
    }
    collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);
    classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors, true);
    if (JSON.stringify([...provenance]) === before) break;
  }
  // Diagnose unresolved map receivers only after loop and callback facts converge.
  classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors);
  const literalShadows: StandardLiteralShadow[] = [];
  const lexicalBindings = standardLexicalBindings(root, true);
  const runBody = runEntry.field("body") ?? undefined;
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const name = declaration.field("name");
    if (name?.kind() !== "identifier" || !provenance.has(name.text()) || owners.get(name.text()) === declaration.id()) {
      continue;
    }
    const value = standardExpressionProvenance(declaration.field("value") ?? undefined, provenance, dslBindings);
    const scope = declaration
      .ancestors()
      .find((ancestor) => ancestor.kind() === "statement_block" || ancestor.kind() === "switch_body");
    const context = provenance.get(name.text())?.operatorContext === true;
    if (context) duplicateOwners.add(declaration.id());
    const literalContext =
      context &&
      scope !== undefined &&
      scope.id() !== runBody?.id() &&
      nodeWithinStandardNode(scope, runBody) &&
      standardBindingOf(name, lexicalBindings)?.bindingId === declaration.id() &&
      structuredLiteralValue(declaration.field("value") ?? undefined) !== undefined;
    if (scope !== undefined && ((!context && value === undefined) || literalContext))
      literalShadows.push({ name: name.text(), scopeId: scope.id(), bindingId: declaration.id() });
  }
  if ([...duplicateOwners].some((id) => !literalShadows.some((shadow) => shadow.bindingId === id)))
    errors.add("standard profile gives every semantic or runtime-owned value binding one unique name", runEntry);
  return { literalShadows, provenance, carryAssignments };
}

function collectStandardDeclarationProvenance(
  root: SgNode,
  provenance: StandardProvenanceMap,
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
  provenance: StandardProvenanceMap,
  dslBindings: ReadonlySet<string>,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: WorkflowSourceDiagnosticSink,
  deferUnresolved = false,
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
      if (receiver?.kind === "structured-value" && receiver.schema?.type === "array") {
        const item = structuredArrayItem(receiver.schema);
        const values: StandardValueProvenance[] = [
          item === undefined ? { kind: "opaque-value" } : { kind: "structured-value", schema: item },
          { kind: "runtime-control" },
          receiver,
        ];
        parameters.forEach((parameter, index) => {
          if (parameter.kind() !== "identifier" || values[index] === undefined)
            errors.add("standard profile keeps each structured map parameter as one visible identifier", parameter);
          else reserve(parameter.text(), values[index]!, parameter.id());
        });
        continue;
      }
      if (receiver?.kind !== "opaque-list" && receiver?.kind !== "known-collection") {
        if (receiver === undefined && deferUnresolved) continue;
        errors.add("standard profile classifies every value-bearing callback parameter", callback);
        continue;
      }
      const parameterValues: StandardValueProvenance[] = [
        {
          kind: receiver.kind === "opaque-list" ? "map-item" : "known-value",
          ...standardProjectionFacts([receiver], true),
        },
        { kind: "runtime-control" },
        receiver,
      ];
      classifyKnownStandardCallbackParameters(parameters, parameterValues, reserve, errors, "map");
      continue;
    }

    const ownerArguments = ownerCall === undefined ? [] : standardCallArguments(ownerCall);
    const callbackArgumentIndex = ownerArguments.findIndex(
      (argument) => unwrapStandardParentheses(argument)?.id() === callback.id(),
    );
    if (method === "workflow" && parameters.length <= 2 && workflowFunctionInputSchema(root, callback) !== undefined)
      continue;
    if (method === "pipeline" && callbackArgumentIndex > 0) {
      classifyKnownStandardCallbackParameters(
        parameters,
        [{ kind: "opaque-value" }, { kind: "runtime-control" }],
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
  values: readonly StandardValueProvenance[],
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: WorkflowSourceDiagnosticSink,
  owner: string,
): void {
  if (parameters.length > values.length) {
    errors.add(
      `standard profile permits only documented ${owner} callback parameters`,
      parameters[values.length] ?? parameters.at(-1),
    );
  }
  parameters.forEach((parameter, index) => {
    const value = values[index];
    if (value === undefined) return;
    if (parameter.kind() !== "identifier") {
      const names = value.kind === "known-value" ? simpleAuthorRecordBindings(parameter) : undefined;
      if (names !== undefined) {
        for (const name of names) reserve(name, { kind: "known-value" }, parameter.id());
        return;
      }
      errors.add(`standard profile keeps each ${owner} callback parameter as one visible identifier`, parameter);
      return;
    }
    reserve(parameter.text(), value, parameter.id());
  });
}

function collectStandardBoundedCarry(
  root: SgNode,
  runEntry: SgNode,
  provenance: StandardProvenanceMap,
  dslBindings: ReadonlySet<string>,
  errors: WorkflowSourceDiagnosticSink,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
): Set<number> {
  const accepted = new Set<number>();
  const declarations = root.findAll({ rule: { kind: "variable_declarator" } });
  const writes = root.findAll({ rule: { kind: "assignment_expression" } });
  const carriedValues = new Map<string, StandardValueProvenance>();
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
    const value = standardExpressionProvenance(assignment.field("right") ?? undefined, provenance, dslBindings);
    if (value === undefined) continue;
    if (listSeed ? value?.kind !== "opaque-list" : value?.kind !== "opaque-value" && value?.kind !== "runtime-control")
      continue;
    const prior = carriedValues.get(target.text());
    if (prior !== undefined && prior.kind !== value.kind) {
      errors.add("standard bounded carry does not mix opaque text with runtime control", assignment);
      reserve(target.text(), { kind: "opaque-value", ...standardProjectionFacts([prior, value]) }, declaration.id());
      continue;
    }
    // Only the original lexical binding may own this name; callbacks/shadowing cannot launder it.
    const shadowed = root
      .findAll({ rule: { kind: "arrow_function" } })
      .some((callback) => boundStandardNames(standardFunctionParameters(callback)).includes(target.text()));
    if (shadowed) continue;
    const { branchList: _branchList, ...carried } = value;
    const joined = { ...carried, ...standardProjectionFacts([prior, value]) };
    carriedValues.set(target.text(), joined);
    reserve(target.text(), joined, declaration.id());
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
