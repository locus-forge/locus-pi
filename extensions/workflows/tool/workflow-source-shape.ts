/**
 * tool/workflow-source-shape.ts — the strict authoring checker for a published
 * `.workflow.mjs` source, and the order its checks run in.
 *
 * This is the runtime boundary, not only an authoring aid: the workflow tool,
 * the `check:workflow-source` gate and interrupted-run recovery all decide what
 * to do with a source by what this module returns. It parses once, reads the
 * lexical facts, classifies provenance, applies the permitted-use rules, and
 * publishes one deduplicated, ordered diagnostic list.
 *
 * The module surface checks stay here because they are the profile itself —
 * what the top level may hold, which statements the run body permits, that the
 * source imports nothing, that policy is not hidden in a helper, that every
 * identifier has a declared root, and that literal `phase()` calls agree with
 * `meta.phases`. The facts they read live in `source/workflow-source-*.ts`; no
 * module under `source/` imports this one back.
 */
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import {
  exportedMetaObject,
  staticObjectKey,
  staticStringValue,
  /** Named for the standard grammar this checker validates; the unwrapping itself is lexical. */
  unwrapParentheses as unwrapStandardParentheses,
} from "../source/workflow-source-literals.js";
import {
  sortMergedWorkflowSourceDiagnostics,
  WorkflowSourceDiagnosticBag,
  WORKFLOW_SOURCE_DIAGNOSTIC_CODES,
  type WorkflowSourceDiagnostic,
  type WorkflowSourceDiagnosticSink,
} from "../source/workflow-source-diagnostics.js";
import {
  callCallee,
  containsStandardEdgeCall,
  directStandardDslCall,
  isStandardBindingOccurrence,
  isTrustedStandardPhaseCall,
  isVisibleInlineEdgeCallback,
  standardCallArguments,
  standardDslBindings,
  standardLexicalBindings,
  standardPhaseDslBindings,
} from "../source/workflow-source-bindings.js";
import { standardBindingModel } from "../source/workflow-source-provenance.js";
import {
  validateStandardCalls,
  validateStandardExpressions,
  validateStandardValueUses,
} from "../source/workflow-source-value-rules.js";

export type {
  WorkflowSourceDiagnostic,
  WorkflowSourceDiagnosticCode,
  WorkflowSourceDiagnosticRelated,
  WorkflowSourceDiagnosticSeverity,
  WorkflowSourceSpan,
} from "../source/workflow-source-diagnostics.js";

/** The two names the one visible default run export may carry. */
const STANDARD_RUN_NAMES = new Set(["run", "runWorkflow"]);

/** The statement kinds the run body may spell directly inside a block. */
const STANDARD_STATEMENTS = new Set([
  "break_statement",
  "continue_statement",
  "empty_statement",
  "expression_statement",
  "for_in_statement",
  "for_statement",
  "if_statement",
  "lexical_declaration",
  "return_statement",
  "switch_statement",
  "throw_statement",
  "while_statement",
]);

/**
 * Static authoring-profile gate. This protects the readable standard grammar;
 * it is not a runtime domain linter and does not inspect model output.
 */
export function standardWorkflowSourceShapeDiagnostics(source: string): WorkflowSourceDiagnostic[] {
  const diagnostics = new WorkflowSourceDiagnosticBag();
  let root: SgNode;
  try {
    root = parse(Lang.JavaScript, source).root();
  } catch (error) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.sourceParse,
      "error",
      `source parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return diagnostics.values();
  }
  const parseError = root.findAll({ rule: { kind: "ERROR" } })[0];
  if (parseError !== undefined) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.sourceParse,
      "error",
      `source parse failed: ${oneLineSourceShape(parseError.text())}`,
      parseError,
    );
    return diagnostics.values();
  }

  const runEntry = validateStandardTopLevel(root, diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.topLevel, root));
  validateStandardStatements(runEntry, diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.statement, runEntry ?? root));
  validateStandardDependencies(root, diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.import, root));
  validateStandardOwnedPolicy(
    root,
    runEntry,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.policy, runEntry ?? root),
  );
  validateStandardIdentifierRoots(
    root,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.identifier, runEntry ?? root),
  );
  const dslBindings = standardDslBindings(runEntry);
  validateStandardPhaseDeclarations(root, runEntry, diagnostics);
  const bindingModel = standardBindingModel(
    root,
    runEntry,
    dslBindings,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.binding, runEntry ?? root),
  );
  const protectedBindings = new Set([...dslBindings, ...bindingModel.collections.names, "Error"]);
  validateStandardExpressions(
    root,
    protectedBindings,
    dslBindings,
    bindingModel,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.expression, runEntry ?? root),
  );
  validateStandardCalls(
    root,
    runEntry,
    dslBindings,
    bindingModel,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.call, runEntry ?? root),
  );
  validateStandardValueUses(
    root,
    runEntry,
    dslBindings,
    bindingModel,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.dataFlow, runEntry ?? root),
  );
  return diagnostics.values();
}

const ORCHESTRATION_ONLY_FORBIDDEN_DSL_METHODS = new Set([
  "consumeTextArtifact",
  "continuationArtifacts",
  "now",
  "outputDir",
  "projectRoot",
  "promptFile",
  "publishPrimaryFile",
  "random",
  "workspace",
]);

/** The workflow-create subset: prompts and orchestration edges, never workflow-side file or host reads. */
export function orchestrationOnlyWorkflowSourceShapeDiagnostics(source: string): WorkflowSourceDiagnostic[] {
  const standardDiagnostics = standardWorkflowSourceShapeDiagnostics(source);
  if (standardDiagnostics.some((diagnostic) => diagnostic.code === WORKFLOW_SOURCE_DIAGNOSTIC_CODES.sourceParse)) {
    return standardDiagnostics;
  }

  const diagnostics = new WorkflowSourceDiagnosticBag();
  const root = parse(Lang.JavaScript, source).root();
  const firstCallSiteByLabel = new Map<string, SgNode>();
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const method = orchestrationOnlyDslMethod(call);
    if (method === undefined) continue;
    if (method === "agent") {
      validateOrchestrationOnlyAgentLabel(call, firstCallSiteByLabel, diagnostics);
      continue;
    }
    if (!ORCHESTRATION_ONLY_FORBIDDEN_DSL_METHODS.has(method)) continue;
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.authoringSubset,
      "error",
      `orchestration-only authoring does not call ${method}(); put source or file work in an agent prompt`,
      call,
    );
  }
  return sortMergedWorkflowSourceDiagnostics([...standardDiagnostics, ...diagnostics.values()]);
}

/** The DSL method one call names, whether the source destructured `dsl` or not. */
function orchestrationOnlyDslMethod(call: SgNode): string | undefined {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee?.kind() === "identifier") return callee.text();
  if (callee?.kind() === "member_expression" && callee.field("object")?.text() === "dsl") {
    return callee.field("property")?.text();
  }
  return undefined;
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
function validateOrchestrationOnlyAgentLabel(
  call: SgNode,
  firstCallSiteByLabel: Map<string, SgNode>,
  diagnostics: WorkflowSourceDiagnosticBag,
): void {
  const options = unwrapStandardParentheses(standardCallArguments(call)[1]);
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

/** Legacy message-only projection retained for existing tests and automation. */
export function standardWorkflowSourceShapeErrors(source: string): string[] {
  return [
    ...new Set(
      standardWorkflowSourceShapeDiagnostics(source)
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message),
    ),
  ].sort();
}

/** Validate the closed standard module surface and return its one visible run function. */
function validateStandardTopLevel(root: SgNode, errors: WorkflowSourceDiagnosticSink): SgNode | undefined {
  let metaCount = 0;
  const runEntries: SgNode[] = [];
  for (const statement of root.children()) {
    if (statement.kind() === "comment" || statement.kind() === "hash_bang_line" || statement.kind() === ";") continue;
    if (statement.kind() === "lexical_declaration") {
      if (!isLiteralConstDeclaration(statement)) {
        errors.add("standard profile top-level constants must contain only literal data", statement);
      }
      continue;
    }
    if (statement.kind() !== "export_statement") {
      errors.add(
        "standard profile top level permits only literal constants, literal meta, and one default run export",
        statement,
      );
      continue;
    }

    const meta = exportedMetaObject(statement);
    if (meta !== undefined) {
      metaCount += 1;
      if (!isExactLiteralMetaExport(statement, meta) || staticMetaProfile(meta) !== "standard") {
        errors.add(
          'standard profile requires one literal `export const meta` with `profile: "standard"`',
          statement,
          WORKFLOW_SOURCE_DIAGNOSTIC_CODES.metaProfile,
        );
      }
      continue;
    }

    const entry = statement
      .children()
      .find(
        (child) =>
          child.kind() === "function_declaration" ||
          child.kind() === "function_expression" ||
          child.kind() === "arrow_function",
      );
    if (statement.children().some((child) => child.kind() === "default") && entry !== undefined) {
      const name = entry.field("name")?.text();
      if (name !== undefined && !STANDARD_RUN_NAMES.has(name)) {
        errors.add(
          "standard profile run export is named run or runWorkflow",
          entry.field("name") ?? entry,
          WORKFLOW_SOURCE_DIAGNOSTIC_CODES.runExport,
        );
      }
      runEntries.push(entry);
      continue;
    }

    errors.add("standard profile exports only literal meta and one visible default run function", statement);
  }
  if (metaCount !== 1) {
    errors.add(
      'standard profile requires one literal `export const meta` with `profile: "standard"`',
      root,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.metaProfile,
    );
  }
  if (runEntries.length !== 1) {
    errors.add(
      "standard profile requires exactly one visible default run function",
      root,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.runExport,
    );
  }
  return runEntries.length === 1 ? runEntries[0] : undefined;
}

/** Standard orchestration uses ordinary declarations/control flow, never hidden statement machinery. */
function validateStandardStatements(runEntry: SgNode | undefined, errors: WorkflowSourceDiagnosticSink): void {
  if (runEntry === undefined) return;
  for (const block of runEntry.findAll({ rule: { kind: "statement_block" } })) {
    for (const statement of block.children()) {
      if (isStructuralStatementNode(statement)) continue;
      if (!STANDARD_STATEMENTS.has(String(statement.kind()))) {
        errors.add(`standard profile does not permit ${statement.kind()} in the run body`, statement);
      }
    }
  }
}

function validateStandardDependencies(root: SgNode, errors: WorkflowSourceDiagnosticSink): void {
  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    errors.add(
      specifier?.startsWith("node:") === true
        ? "standard profile imports no node: modules"
        : "standard profile imports no modules",
      statement,
    );
  }
  for (const statement of root.findAll({ rule: { kind: "export_statement" } })) {
    if (!statement.children().some((child) => child.kind() === "from")) continue;
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    errors.add(
      specifier?.startsWith("node:") === true
        ? "standard profile re-exports no node: modules"
        : "standard profile re-exports no modules",
      statement,
    );
  }
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee?.kind() === "import") {
      errors.add("standard profile uses no dynamic imports", call);
    } else if (callee?.kind() === "identifier" && callee.text() === "require") {
      errors.add("standard profile uses no require() imports", call);
    }
  }
}

function validateStandardOwnedPolicy(
  root: SgNode,
  runEntry: SgNode | undefined,
  errors: WorkflowSourceDiagnosticSink,
): void {
  const dslBindings = standardDslBindings(runEntry);
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined || directStandardDslCall(callee, dslBindings) !== "agent") continue;
    const pairs =
      standardCallArguments(call)[1]
        ?.children()
        .filter((child) => child.kind() === "pair") ?? [];
    const report = pairs.find((pair) => staticObjectKey(pair.field("key")) === "result");
    if (report === undefined) continue;
    if (staticStringValue(unwrapStandardParentheses(report.field("value") ?? undefined)) !== "report")
      errors.add('agent result must be the static literal "report"', report);
    for (const pair of pairs) {
      const key = staticObjectKey(pair.field("key"));
      if (
        key !== undefined &&
        ["choice", "choiceFallback", "handoffs", "schema", "validate", "returnVia", "output", "repair"].includes(key)
      )
        errors.add(`agent result: report cannot be combined with ${key}`, pair);
    }
  }
  for (const statement of root.findAll({ rule: { kind: "try_statement" } })) {
    errors.add("standard profile owns no try/catch recovery", statement);
  }
  for (const declaration of root.findAll({ rule: { kind: "class_declaration" } })) {
    errors.add("standard profile owns no class helpers", declaration);
  }
  for (const pair of root.findAll({ rule: { kind: "pair" } })) {
    const key = staticObjectKey(pair.field("key"));
    if (key === "schema" || key === "validate") errors.add(`standard profile owns no raw ${key}`, pair);
  }
  for (const property of root.findAll({ rule: { kind: "computed_property_name" } })) {
    errors.add("standard profile uses no computed object keys that hide policy", property);
  }
  for (const regex of root.findAll({ rule: { kind: "regex" } })) {
    errors.add("standard profile owns no regex gates", regex);
  }
  for (const declaration of root.findAll({ rule: { kind: "function_declaration" } })) {
    if (declaration.id() === runEntry?.id()) continue;
    const name = declaration.field("name")?.text() ?? "anonymous";
    errors.add(`standard profile keeps no nested or top-level helper function ${name}`, declaration);
  }
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const name = declaration.field("name")?.text() ?? "";
    const value = declaration.field("value");
    if (value?.kind() === "arrow_function" || value?.kind() === "function_expression") {
      errors.add(`standard profile keeps no function-valued helper ${name || "binding"}`, declaration);
    }
  }
  for (const callback of [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ]) {
    if (callback.id() === runEntry?.id()) continue;
    if (callback.kind() === "function_expression") {
      errors.add("standard profile uses arrow functions for inline callbacks", callback);
    }
    const owner = callback.parent();
    if (owner?.kind() === "pair" || owner?.kind() === "variable_declarator") {
      errors.add("standard profile keeps no object or variable function wrapper", callback);
    } else if (containsStandardEdgeCall(callback) && !isVisibleInlineEdgeCallback(callback)) {
      errors.add(
        "standard profile keeps inline agent edges only inside visible parallel, pipeline, or workflow calls",
        callback,
      );
    }
  }
  for (const method of root.findAll({ rule: { kind: "method_definition" } })) {
    errors.add(
      `standard profile keeps no object/class method helper ${method.field("name")?.text() ?? "method"}`,
      method,
    );
  }
}

function validateStandardIdentifierRoots(root: SgNode, errors: WorkflowSourceDiagnosticSink): void {
  const bindings = standardLexicalBindings(root);
  const approvedGlobals = new Set(["Error"]);
  for (const rootValue of [
    ...root.findAll({ rule: { kind: "this" } }),
    ...root.findAll({ rule: { kind: "meta_property" } }),
  ]) {
    errors.add(
      "standard profile reads values only from declared lexical bindings and approved language roots",
      rootValue,
    );
  }
  for (const identifier of [
    ...root.findAll({ rule: { kind: "identifier" } }),
    ...root.findAll({ rule: { kind: "shorthand_property_identifier" } }),
  ]) {
    if (identifier.text() === "arguments") {
      errors.add("standard profile does not use the implicit arguments object", identifier);
      continue;
    }
    if (approvedGlobals.has(identifier.text())) continue;
    if (isStandardBindingOccurrence(identifier)) continue;
    const ancestorIds = new Set(identifier.ancestors().map((ancestor) => ancestor.id()));
    const identifierIndex = identifier.range().start.index;
    if (
      bindings.some(
        (binding) =>
          binding.name === identifier.text() &&
          identifierIndex >= binding.activationIndex &&
          (binding.scopeId === root.id() || ancestorIds.has(binding.scopeId)),
      )
    ) {
      continue;
    }
    errors.add(
      "standard profile reads values only from declared lexical bindings and approved language roots",
      identifier,
    );
  }
}

interface StandardDeclaredPhase {
  title: string;
  node: SgNode;
}

interface StandardCalledPhase {
  title: string;
  node: SgNode;
}

function validateStandardPhaseDeclarations(
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

function isLiteralConstDeclaration(statement: SgNode): boolean {
  if (!statement.children().some((child) => child.kind() === "const")) return false;
  const declarations = statement.children().filter((child) => child.kind() === "variable_declarator");
  return (
    declarations.length > 0 && declarations.every((declaration) => isStaticAuthoringLiteral(declaration.field("value")))
  );
}

function isExactLiteralMetaExport(statement: SgNode, meta: SgNode): boolean {
  const declaration = statement.children().find((child) => child.kind() === "lexical_declaration");
  if (declaration === undefined || !declaration.children().some((child) => child.kind() === "const")) return false;
  const variables = declaration.children().filter((child) => child.kind() === "variable_declarator");
  return variables.length === 1 && variables[0]?.field("name")?.text() === "meta" && isStaticAuthoringLiteral(meta);
}

function staticMetaProfile(meta: SgNode): string | undefined {
  const profile = meta
    .children()
    .find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === "profile");
  return staticStringValue(profile?.field("value"));
}

function isStaticAuthoringLiteral(node: SgNode | null | undefined): boolean {
  if (node == null) return false;
  if (["false", "null", "number", "regex", "string", "true", "undefined"].includes(String(node.kind()))) return true;
  if (node.kind() === "template_string") return staticStringValue(node) !== undefined;
  if (node.kind() !== "array" && node.kind() !== "object") return false;
  return node.children().every((child) => {
    if (isStructuralLiteralNode(child)) return true;
    if (child.kind() === "pair")
      return staticObjectKey(child.field("key")) !== undefined && isStaticAuthoringLiteral(child.field("value"));
    return isStaticAuthoringLiteral(child);
  });
}

function isStructuralStatementNode(node: SgNode): boolean {
  return node.kind() === "{" || node.kind() === "}" || node.kind() === "comment" || node.kind() === ";";
}

function isStructuralLiteralNode(node: SgNode): boolean {
  const kind = node.kind();
  return kind === "{" || kind === "}" || kind === "[" || kind === "]" || kind === "," || kind === "comment";
}

function oneLineSourceShape(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
