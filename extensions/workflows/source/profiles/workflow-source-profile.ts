/** Full-source profile facts and shared literal phase/agent-label diagnostics. */
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import {
  exportedMetaObject,
  staticObjectKey,
  staticStringValue,
  unwrapParentheses as unwrapStandardParentheses,
} from "../workflow-source-literals.js";
import {
  standardCallArguments,
  callCallee,
  standardLexicalBindings,
  standardBindingOf,
  standardFunctionParameters,
  standardFunctionParameterNodes,
  addStandardDslBindings,
  type StandardLexicalBinding,
} from "../workflow-source-bindings.js";
import {
  WorkflowSourceDiagnosticBag,
  WORKFLOW_SOURCE_DIAGNOSTIC_CODES,
  type WorkflowSourceDiagnosticSink,
} from "../workflow-source-diagnostics.js";

/** Full retained bytes: visible opted-in or unresolved profiles require strict admission; opaque metadata stays legacy. */
export function workflowSourceDeclaresDataflow(source: string): boolean {
  const root = parse(Lang.JavaScript, source).root();
  const bindings = standardLexicalBindings(root);
  const declarations = new Map(
    root.findAll({ rule: { kind: "variable_declarator" } }).map((node) => [node.id(), node]),
  );
  function resolve(node: SgNode | null | undefined, seen = new Set<number>()): SgNode | undefined {
    node = unwrapStandardParentheses(node ?? undefined);
    if (node == null || seen.has(node.id())) return undefined;
    if (!["identifier", "shorthand_property_identifier"].includes(String(node.kind()))) return node;
    const declaration = declarations.get(standardBindingOf(node, bindings)?.bindingId ?? -1);
    return declaration
      ?.parent()
      ?.children()
      .some((child) => child.kind() === "const")
      ? resolve(declaration.field("value"), new Set([...seen, node.id()]))
      : undefined;
  }
  function containsProfile(node: SgNode | null | undefined, seen = new Set<number>()): boolean {
    const value = resolve(node);
    if (value?.kind() !== "object" || seen.has(value.id())) return false;
    seen.add(value.id());
    return value.children().some((child) => {
      if (child.kind() === "spread_element")
        return containsProfile(
          child.children().find((node) => node.kind() !== "..."),
          seen,
        );
      const shorthand = child.kind() === "shorthand_property_identifier";
      if (!shorthand && !["pair", "method_definition"].includes(String(child.kind()))) return false;
      const key = shorthand ? child : (child.field("key") ?? child.field("name"));
      const computed =
        key?.kind() === "computed_property_name"
          ? key.children().find((node) => !["[", "]", "comment"].includes(String(node.kind())))
          : undefined;
      if ((staticObjectKey(key) ?? staticStringValue(resolve(computed))) !== "profile") return false;
      const profile = resolve(shorthand ? child : child.field("value"));
      const text = staticStringValue(profile);
      return (
        text === "dataflow-v1" ||
        (text === undefined && !["number", "true", "false", "null"].includes(String(profile?.kind())))
      );
    });
  }
  for (const statement of root.children().filter((node) => node.kind() === "export_statement")) {
    for (const declaration of statement
      .children()
      .filter((node) => ["lexical_declaration", "variable_declaration"].includes(String(node.kind())))
      .flatMap((node) => node.children().filter((child) => child.kind() === "variable_declarator")))
      if (declaration.field("name")?.text() === "meta" && containsProfile(declaration.field("value"))) return true;
    for (const specifier of statement.findAll({ rule: { kind: "export_specifier" } })) {
      const name = specifier.field("name");
      if ((specifier.field("alias")?.text() ?? name?.text()) === "meta" && containsProfile(name)) return true;
    }
  }
  return false;
}

/**
 * Every `agent()` declares a literal `label`, and no two declare the same one.
 *
 * This is the rule that makes a generated workflow repairable. The replay record
 * addresses a call by `(phase, label, occurrence)`, so a call with no label
 * cannot be located after the source is edited, and two call sites sharing one
 * label collapse into the same address: delete the first and the second slides
 * onto its position and is handed its recorded answer. Neither the request key
 * nor the recorded name can tell those two apart at run time, so the source
 * checker is where the case is closed.
 */
export function validateOrchestrationOnlyAgentLabel(
  call: SgNode,
  firstCallSiteByLabel: Map<string, SgNode>,
  diagnostics: WorkflowSourceDiagnosticBag,
): void {
  const options = unwrapStandardParentheses(standardCallArguments(call)[1]);
  const choices =
    options?.kind() === "object"
      ? options.children().find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === "choices")
      : undefined;
  if (choices !== undefined)
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.authoringSubset,
      "error",
      "agent() uses singular choice: [...]; choices is not a supported option",
      choices,
    );
  const labelNode =
    options?.kind() === "object"
      ? options
          .children()
          .find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === "label")
          ?.field("value")
      : undefined;
  const label = staticStringValue(unwrapStandardParentheses(labelNode ?? undefined));
  if (label === undefined || label === "") {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.agentLabelMissing,
      "error",
      "agent() must declare a literal label; a call without one cannot be resumed after the source is repaired",
      call,
    );
    return;
  }
  const first = firstCallSiteByLabel.get(label);
  if (first !== undefined) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.agentLabelDuplicate,
      "error",
      `agent() label "${label}" is already used in this file; two call sites sharing a label are one address on resume`,
      labelNode ?? call,
      [{ message: `first used here`, node: first }],
    );
    return;
  }
  firstCallSiteByLabel.set(label, labelNode ?? call);
}

interface StandardDeclaredPhase {
  title: string;
  node: SgNode;
}

interface StandardCalledPhase {
  title: string;
  node: SgNode;
}

export function validateStandardPhaseDeclarations(
  root: SgNode,
  runEntry: SgNode | undefined,
  diagnostics: WorkflowSourceDiagnosticBag,
): void {
  if (runEntry === undefined) return;
  const meta = root
    .children()
    .map((statement) => exportedMetaObject(statement))
    .find((value) => value !== undefined);
  const phasesPair = meta
    ?.children()
    .find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === "phases");
  const phasesNode = phasesPair?.field("value");
  if (phasesNode?.kind() !== "array") return;

  const declared = phasesNode.children().flatMap((child): StandardDeclaredPhase[] => {
    if (child.kind() !== "object") return [];
    const titlePair = child
      .children()
      .find((entry) => entry.kind() === "pair" && staticObjectKey(entry.field("key")) === "title");
    const titleNode = titlePair?.field("value");
    const title = staticStringValue(titleNode);
    return title === undefined || titleNode == null ? [] : [{ title, node: titleNode }];
  });
  if (declared.length === 0) return;

  const lexicalBindings = standardLexicalBindings(runEntry);
  const phaseBindings = standardPhaseDslBindings(runEntry, lexicalBindings);
  const calledByTitle = new Map<string, StandardCalledPhase>();
  for (const call of runEntry.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined || !isTrustedStandardPhaseCall(call, callee, lexicalBindings, phaseBindings)) continue;
    const argument = unwrapStandardParentheses(standardCallArguments(call)[0]);
    const title = staticStringValue(argument);
    if (title !== undefined && argument !== undefined && !calledByTitle.has(title))
      calledByTitle.set(title, { title, node: argument });
  }
  const called = [...calledByTitle.values()];
  const declaredByTitle = new Map<string, StandardDeclaredPhase>();
  const firstDeclaredByFoldedTitle = new Map<string, StandardDeclaredPhase>();
  for (const phase of declared) {
    const foldedTitle = phase.title.toLowerCase();
    const first = firstDeclaredByFoldedTitle.get(foldedTitle);
    if (first !== undefined) {
      const exact = first.title === phase.title;
      diagnostics.add(
        WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseDuplicateDeclaration,
        "error",
        exact
          ? `meta.phases repeats title "${phase.title}"`
          : `meta.phases title "${phase.title}" duplicates "${first.title}" by case`,
        phase.node,
        [{ message: `first declared as "${first.title}" here`, node: first.node }],
      );
    } else {
      firstDeclaredByFoldedTitle.set(foldedTitle, phase);
    }
    if (!declaredByTitle.has(phase.title)) declaredByTitle.set(phase.title, phase);
  }

  for (const phase of called) {
    if (declaredByTitle.has(phase.title)) continue;
    const caseMatch = declared.find((candidate) => candidate.title.toLowerCase() === phase.title.toLowerCase());
    if (caseMatch !== undefined) {
      diagnostics.add(
        WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseCaseMismatch,
        "error",
        `meta.phases title "${caseMatch.title}" differs from literal phase("${phase.title}") only by case`,
        phase.node,
        [{ message: `declared as "${caseMatch.title}" here`, node: caseMatch.node }],
      );
      continue;
    }
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseUndeclared,
      "error",
      `literal phase("${phase.title}") is absent from non-empty meta.phases`,
      phase.node,
      [{ message: "meta.phases is declared here", node: phasesNode }],
    );
  }

  for (const phase of declaredByTitle.values()) {
    const exactCall = calledByTitle.get(phase.title);
    const caseCall = called.find((candidate) => candidate.title.toLowerCase() === phase.title.toLowerCase());
    if (exactCall !== undefined || caseCall !== undefined) continue;
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseUnusedDeclaration,
      "warning",
      `meta.phases title "${phase.title}" has no literal phase("${phase.title}") call`,
      phase.node,
    );
  }

  const declaredTitles = [...declaredByTitle.keys()];
  const calledTitles = [...calledByTitle.keys()];
  const sameExactSet =
    declaredTitles.length === calledTitles.length && declaredTitles.every((title) => calledByTitle.has(title));
  if (sameExactSet && declaredTitles.some((title, index) => title !== calledTitles[index])) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseOrderDrift,
      "warning",
      "meta.phases order differs from first literal phase() occurrence",
      phasesNode,
      called[0] === undefined ? undefined : [{ message: "first literal phase() occurrence", node: called[0].node }],
    );
  }
}

/** Literal module contract; helper/edge policy stays with the dataflow rules owner. */
export function validateDataflowModule(
  root: SgNode,
  entries: readonly SgNode[],
  helperById: ReadonlyMap<number, SgNode>,
  literal: (node: SgNode | null | undefined) => unknown,
  errors: WorkflowSourceDiagnosticSink,
): void {
  const entry = entries[0];
  const helpers = [...helperById.values()];
  const metaStatements = root.children().filter((node) => exportedMetaObject(node) !== undefined);
  if (metaStatements.length !== 1 || entries.length !== 1)
    errors.add(
      "dataflow-v1 requires one literal meta and one visible default run export",
      root,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.runExport,
    );
  for (const statement of root.children()) {
    if (["comment", "hash_bang_line", ";"].includes(String(statement.kind()))) continue;
    const meta = exportedMetaObject(statement);
    if (meta !== undefined) {
      try {
        const value = literal(meta) as Record<string, unknown>;
        if (value.identityCoverage !== undefined && value.identityCoverage !== "self-contained-static")
          errors.add("dataflow-v1 requires self-contained-static retained snapshot execution", meta);
        if (
          value.profile !== "dataflow-v1" ||
          staticStringValue(
            meta
              .children()
              .find((node) => node.kind() === "pair" && staticObjectKey(node.field("key")) === "profile")
              ?.field("value"),
          ) !== "dataflow-v1" ||
          statement.findAll({ rule: { kind: "variable_declarator" } }).length !== 1 ||
          statement
            .children()
            .find((n) => n.kind() === "lexical_declaration")
            ?.children()
            .some((n) => n.kind() === "const") !== true
        )
          throw new Error("profile mismatch");
      } catch {
        errors.add(
          'dataflow-v1 mode requires literal meta.profile: "dataflow-v1"',
          meta,
          WORKFLOW_SOURCE_DIAGNOSTIC_CODES.metaProfile,
        );
      }
      continue;
    }
    if (statement.kind() === "function_declaration" && helpers.some((fn) => fn.id() === statement.id())) continue;
    if (
      statement.kind() === "export_statement" &&
      entry !== undefined &&
      entry.ancestors().some((node) => node.id() === statement.id())
    )
      continue;
    if (statement.kind() === "lexical_declaration") {
      for (const declaration of statement.children().filter((n) => n.kind() === "variable_declarator")) {
        if (helperById.has(declaration.id())) continue;
        try {
          literal(declaration.field("value"));
        } catch {
          errors.add("module constants must contain finite literal data", declaration);
        }
      }
      continue;
    }
    errors.add(
      "dataflow-v1 top level permits literal constants, checked helpers, meta and one run export",
      statement,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.topLevel,
    );
  }
  if (metaStatements.length === 0)
    errors.add(
      'dataflow-v1 mode requires literal meta.profile: "dataflow-v1"',
      root,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.metaProfile,
    );
}

interface StandardPhaseDslBindings {
  dsl: readonly StandardLexicalBinding[];
  phase: readonly StandardLexicalBinding[];
}

function standardPhaseDslBindings(
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

function isTrustedStandardPhaseCall(
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
