/** Queries over the binding model; never creates bindings or changes permitted-use policy. */
import type { SgNode } from "@ast-grep/napi";
import type { WorkflowJSONSchema } from "../runtime/structured-results/schema.js";
import type {
  StandardProvenanceMap,
  StandardValueProvenance,
  StandardLiteralShadow,
} from "./workflow-source-provenance.js";
import { structuredRequiredField } from "./workflow-source-structured.js";
import { staticObjectKey, unwrapParentheses as unwrapStandardParentheses } from "./workflow-source-literals.js";
import {
  callCallee,
  containsStandardEdgeCall,
  directStandardDslCall,
  isBoundaryInputDefaultExpression,
  standardCallArguments,
  type StandardDslMethod,
} from "./workflow-source-bindings.js";

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
  parallel: "opaque-list",
  phase: "void-value",
  pipeline: "opaque-list",
  projectRoot: "runtime-value",
  promptFile: "opaque-value",
  publishArtifact: "runtime-value",
  publishPrimaryArtifact: "runtime-value",
  random: "runtime-value",
  workflow: "opaque-value",
  workspace: "opaque-value",
  workspaceDir: "runtime-value",
} as const satisfies Record<StandardDslMethod, StandardDslReturnCategory>;

export function standardExpressionProvenance(
  node: SgNode | undefined,
  provenance: StandardProvenanceMap,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[] = [],
): StandardValueProvenance | undefined {
  const expression = unwrapStandardParentheses(node);
  if (expression?.kind() === "await_expression") {
    const inner = expression.children().find((child) => !["await", "comment"].includes(String(child.kind())));
    const resolved = standardExpressionProvenance(inner, provenance, dslBindings, literalShadows);
    if (resolved === undefined) return undefined;
    const { pending: _pending, ...settled } = resolved;
    return settled.kind === "structured-promise" ? { ...settled, kind: "structured-value" } : settled;
  }
  const value = expression;
  if (value === undefined) return undefined;
  if (value.kind() === "identifier" || value.kind() === "shorthand_property_identifier") {
    if (isInsideLiteralShadow(value, literalShadows)) return undefined;
    return provenance.get(value.text());
  }
  if (value.kind() === "arrow_function" || value.kind() === "function_expression") {
    const returns = standardCallbackReturnValues(value, provenance, dslBindings, literalShadows);
    return {
      kind: "runtime-value",
      callable: true,
      ...deferredResultFacts(standardProjectionFacts(returns)),
    };
  }
  if (value.kind() === "ternary_expression" && isBoundaryInputDefaultExpression(value)) {
    return { kind: "opaque-value" };
  }
  const alternatives =
    value.kind() === "ternary_expression"
      ? [value.field("consequence"), value.field("alternative")]
      : value.kind() === "binary_expression" && ["&&", "||", "??"].includes(value.field("operator")?.text() ?? "")
        ? [value.field("left"), value.field("right")]
        : undefined;
  if (alternatives !== undefined) {
    const facts = standardProjectionFacts(
      alternatives.map((node) =>
        standardExpressionProvenance(node ?? undefined, provenance, dslBindings, literalShadows),
      ),
    );
    return Object.keys(facts).length === 0 ? undefined : { kind: "opaque-value", ...facts };
  }
  if (value.kind() === "array" || value.kind() === "object") {
    const contents = standardCompositeValueExpressions(value).map((expression) =>
      standardExpressionProvenance(expression, provenance, dslBindings, literalShadows),
    );
    const opaque = contents.some(
      (item) => item !== undefined && !["known-collection", "known-value"].includes(item.kind),
    );
    return {
      kind:
        value.kind() === "array"
          ? opaque
            ? "opaque-list"
            : "known-collection"
          : opaque
            ? "opaque-value"
            : "known-value",
      ...standardProjectionFacts(contents, true),
      ...(value.kind() === "array" && safeBranchList(contents) && denseArray(value) ? { branchList: true } : {}),
    };
  }
  if (value.kind() === "member_expression" || value.kind() === "subscript_expression") {
    const owner = standardExpressionProvenance(
      value.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (
      owner?.kind === "opaque-list" &&
      !owner.pending &&
      value.kind() === "member_expression" &&
      value.field("property")?.text() === "length"
    )
      return { kind: "runtime-control" };
    const projected = standardProjectionFacts([owner], true);
    if (Object.keys(projected).length > 0) return { kind: "opaque-value", ...projected };
    if (
      owner?.kind === "runtime-status" &&
      value.kind() === "member_expression" &&
      value.field("property")?.text() === "status"
    ) {
      return { kind: "runtime-control" };
    }
    if (owner?.kind === "structured-value" && owner.schema !== undefined) {
      const name = value.kind() === "member_expression" ? value.field("property")?.text() : undefined;
      if (owner.schema.type === "array" && name === "length") return { kind: "runtime-control" };
      const schema = name === undefined ? undefined : structuredRequiredField(owner.schema, name);
      return schema === undefined ? undefined : { kind: "structured-value", schema };
    }
    if (owner?.kind === "known-value") return { kind: "known-value" };
    if (owner?.kind === "known-collection" && value.kind() === "subscript_expression") return { kind: "known-value" };
    if (owner?.kind !== "opaque-list") return undefined;
    return { kind: "opaque-value" };
  }
  if (value.kind() !== "call_expression") return undefined;
  const callee = unwrapStandardParentheses(callCallee(value));
  if (callee === undefined) return undefined;
  const method = directStandardDslCall(callee, dslBindings);
  if (method !== undefined) {
    const result = standardDslCallProvenance(method, value, provenance.structuredCalls);
    if (!["parallel", "pipeline", "workflow"].includes(method)) return result;
    const args = standardCallArguments(value);
    const inputs = args.map((node) => standardExpressionProvenance(node, provenance, dslBindings, literalShadows));
    if (method === "parallel")
      return { ...result, ...(inputs[0]?.branchList ? {} : standardProjectionFacts([inputs[0]], true)) };
    if (method === "pipeline")
      return {
        ...result,
        ...standardProjectionFacts([inputs[0]], true),
        ...deferredResultFacts(standardProjectionFacts(inputs.slice(1).map(deferredResultFacts))),
      };
    if (method === "workflow") return { ...result, ...deferredResultFacts(inputs[0]) };
    return result;
  }
  if (callee.kind() === "member_expression" && callee.field("property")?.text() === "map") {
    const receiver = standardExpressionProvenance(
      callee.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    const callback = standardCallArguments(value)[0];
    const fn = unwrapStandardParentheses(callback);
    const returns = standardCallbackReturnValues(fn, provenance, dslBindings, literalShadows);
    const projection = {
      ...standardProjectionFacts(returns, true),
      ...(fn?.children().some((child) => child.kind() === "async") || receiver?.pending
        ? { pendingContents: true as const }
        : {}),
      ...(safeBranchList(returns) ? { branchList: true as const } : {}),
      ...((receiver?.kind === "structured-value" && receiver.schema?.type === "array") || receiver?.structuredMap
        ? { structuredMap: true as const }
        : {}),
    };
    if (receiver?.kind === "known-collection") {
      // A literal inventory cannot launder answers captured or produced by a mapping callback.
      if (
        projection.pendingContents ||
        projection.callableContents ||
        (callback !== undefined &&
          (containsNonAuthorKnownValue(fn?.field("body") ?? callback, provenance, dslBindings, literalShadows) ||
            containsStandardEdgeCall(callback)))
      )
        return { kind: "opaque-list", ...projection };
      return { kind: "known-collection", ...projection };
    }
    if (
      receiver?.kind === "opaque-list" ||
      (receiver?.kind === "structured-value" && receiver.schema?.type === "array")
    )
      return { kind: "opaque-list", ...projection };
  }
  return undefined;
}

type ProjectionFacts = Pick<
  StandardValueProvenance,
  "pending" | "pendingContents" | "callableContents" | "structuredMap"
>;

/** Negative facts survive joins; alternatives never prove a direct callable or a safe branch list. */
export function standardProjectionFacts(
  values: readonly ((ProjectionFacts & { callable?: true }) | undefined)[],
  contained = false,
): ProjectionFacts {
  return {
    ...(!contained && values.some((item) => item?.pending) ? { pending: true } : {}),
    ...(values.some((item) => item?.pendingContents || (contained && item?.pending)) ? { pendingContents: true } : {}),
    ...(values.some((item) => item?.callable || item?.callableContents) ? { callableContents: true } : {}),
    ...(values.some((item) => item?.structuredMap) ? { structuredMap: true } : {}),
  };
}

/** Calling an owned branch settles its root Promise; graph contents still need their own refusal. */
function deferredResultFacts(value: ProjectionFacts | undefined): ProjectionFacts {
  return {
    ...(value?.pendingContents ? { pendingContents: true } : {}),
    ...(value?.callableContents ? { callableContents: true } : {}),
    ...(value?.structuredMap ? { structuredMap: true } : {}),
  };
}

function safeBranchList(values: readonly (StandardValueProvenance | undefined)[]): boolean {
  return values.length > 0 && values.every((item) => item?.callable && !item.pendingContents && !item.callableContents);
}

function denseArray(node: SgNode): boolean {
  const children = node.children().filter((child) => child.kind() !== "comment");
  return !children.some(
    (child, index) => child.kind() === "," && ["[", ","].includes(String(children[index - 1]?.kind())),
  );
}

export function standardDslCallProvenance(
  method: StandardDslMethod,
  call: SgNode,
  structuredCalls?: ReadonlyMap<number, WorkflowJSONSchema>,
): StandardValueProvenance {
  const pending = ["agent", "invokeWorkflow", "parallel", "pipeline", "promptFile", "workflow", "workspace"].includes(
    method,
  )
    ? { pending: true as const }
    : {};
  const schema = structuredCalls?.get(call.id());
  if (method === "agent" && schema !== undefined)
    return { kind: "structured-promise", schema, sourceMethod: method, ...pending };
  const category: StandardDslReturnCategory | undefined = STANDARD_DSL_RETURN_CATEGORIES[method];
  if (category === undefined) return { kind: "unclassified-dsl-value", sourceMethod: method };
  if (category !== "agent-dependent") return { kind: category, sourceMethod: method, ...pending };
  const optionKeys = new Set(
    standardCallArguments(call)[1]
      ?.children()
      .filter((child) => child.kind() === "pair")
      .map((pair) => staticObjectKey(pair.field("key"))) ?? [],
  );
  if (optionKeys.has("choice")) return { kind: "runtime-control", sourceMethod: method, ...pending };
  return { kind: "opaque-value", sourceMethod: method, ...pending };
}

/** A map returns callback values immediately; await on the resulting array cannot settle its elements. */
function standardCallbackReturnValues(
  callback: SgNode | undefined,
  provenance: StandardProvenanceMap,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): (StandardValueProvenance | undefined)[] {
  const fn = unwrapStandardParentheses(callback);
  if (fn?.kind() !== "arrow_function" && fn?.kind() !== "function_expression") return [];
  const body = fn.field("body");
  const returns =
    body?.kind() === "statement_block"
      ? body
          .findAll({ rule: { kind: "return_statement" } })
          .filter(
            (node) =>
              node
                .ancestors()
                .find((parent) =>
                  ["arrow_function", "function_expression", "function_declaration"].includes(String(parent.kind())),
                )
                ?.id() === fn.id(),
          )
          .map((node) => node.children().find((child) => !["return", ";", "comment"].includes(String(child.kind()))))
      : [body ?? undefined];
  return returns.map((node) => standardExpressionProvenance(node, provenance, dslBindings, literalShadows));
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
  provenance: StandardProvenanceMap,
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
  provenance: StandardProvenanceMap,
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
  provenance: StandardProvenanceMap,
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
