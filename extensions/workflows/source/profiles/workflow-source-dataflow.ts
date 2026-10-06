/** Checked synchronous data computations and visible, owned DSL edges over the existing AST. */
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import {
  standardLexicalBindings,
  standardBindingOf,
  standardFunctionParameters,
  standardFunctionParameterNodes,
  standardEntryDslBindings,
  addStandardDslBindings,
  directStandardDslCall,
  standardCallArguments,
  callCallee,
  isStandardBindingOccurrence,
  nodeWithinStandardNode,
  unwrapStandardValue,
} from "../workflow-source-bindings.js";
import {
  staticObjectKey,
  escapedWorkflowIdentifiers,
  staticStringValue,
  unwrapParentheses,
  readWorkflowLiteralData,
  staticWorkflowDataKind,
  parentOutsideParentheses,
  isWorkflowNativeMethod,
} from "../workflow-source-literals.js";
import {
  WorkflowSourceDiagnosticBag,
  WORKFLOW_SOURCE_DIAGNOSTIC_CODES,
  type WorkflowSourceDiagnostic,
} from "../workflow-source-diagnostics.js";
import {
  validateDataflowModule,
  validateStandardPhaseDeclarations,
  validateOrchestrationOnlyAgentLabel,
  workflowSourceDeclaresDataflow,
} from "./workflow-source-profile.js";
import { validateDataflowAgentOptions } from "../workflow-source-agent-options.js";

const DATA_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "flatMap",
  "slice",
  "concat",
  "join",
  "at",
  "includes",
  "indexOf",
  "find",
  "findIndex",
  "some",
  "every",
  "trim",
  "split",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
]);
const CALLBACK_METHODS = new Set(["map", "filter", "reduce", "flatMap", "find", "findIndex", "some", "every"]);
const INTRINSICS = new Map([
  ["JSON", ["parse", "stringify"]],
  ["Array", ["isArray"]],
  ["Object", ["keys", "values", "entries", "hasOwn"]],
  ["Number", ["isFinite", "isInteger", "isSafeInteger"]],
  ["String", []],
  ["Boolean", []],
  ["Error", []],
]);
const FORBIDDEN_DSL = new Set([
  "consumeTextArtifact",
  "continuationArtifacts",
  "now",
  "projectRoot",
  "promptFile",
  "random",
  "workspace",
  "workspaceDir",
]);
const ASYNC_DSL = new Set(["agent", "invokeWorkflow", "parallel", "pipeline", "workflow"]);
const FUNCTIONS = new Set(["arrow_function", "function_declaration", "function_expression"]);

/** This profile is an inspectable source contract for trusted Node code, not a security sandbox. */
export function dataflowWorkflowSourceDiagnostics(source: string): WorkflowSourceDiagnostic[] {
  const diagnostics = new WorkflowSourceDiagnosticBag();
  const errors = diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.dataFlow);
  const root = parse(Lang.JavaScript, source).root();
  const parseError = root.findAll({ rule: { kind: "ERROR" } })[0];
  if (parseError !== undefined) {
    errors.add("dataflow-v1 source parse failed", parseError, WORKFLOW_SOURCE_DIAGNOSTIC_CODES.sourceParse);
    return diagnostics.values();
  }
  for (const identifier of escapedWorkflowIdentifiers(root))
    errors.add("dataflow-v1 spells lexical identifiers without Unicode escapes", identifier);
  const declarations = root.findAll({ rule: { kind: "variable_declarator" } });
  const functions = root.findAll({ rule: { any: [...FUNCTIONS].map((kind) => ({ kind })) } });
  const entries = functions.filter(
    (fn) =>
      fn.parent()?.kind() === "export_statement" &&
      fn
        .parent()!
        .children()
        .some((n) => n.kind() === "default"),
  );
  const entry = entries[0];
  const bindings = standardLexicalBindings(root, true);
  const bindingOf = (node: SgNode) => standardBindingOf(node, bindings);
  const byId = new Map(declarations.map((node) => [node.id(), node]));
  const helpers = functions.filter(
    (fn) =>
      (fn.kind() === "function_declaration" && fn.parent()?.id() === root.id()) ||
      (fn.kind() === "arrow_function" &&
        fn.parent()?.kind() === "variable_declarator" &&
        fn.parent()?.parent()?.parent()?.id() === root.id()),
  );
  const helperById = new Map(helpers.map((fn) => [fn.kind() === "arrow_function" ? fn.parent()!.id() : fn.id(), fn]));
  const helperEdges = new Map(helpers.map((fn) => [fn.id(), new Set<number>()]));
  const dslVocabulary = new Map<number, ReadonlySet<string>>();
  function registerDsl(fn: SgNode): void {
    const parameters = standardFunctionParameters(fn);
    const first = standardFunctionParameterNodes(parameters)[0];
    if (fn.id() !== entry?.id() && first === undefined) return;
    const names = standardEntryDslBindings(fn);
    const patterns = [first];
    if (parameters !== undefined)
      dslVocabulary.set(parameters.id(), first?.text() === "dsl" ? new Set(["dsl"]) : names);
    for (const declaration of declarations) {
      const value = declaration.field("value");
      if (
        first?.text() === "dsl" &&
        value?.text() === "dsl" &&
        declaration.field("name")?.kind() === "object_pattern" &&
        ownerFunction(declaration)?.id() === fn.id() &&
        bindingOf(value)?.bindingId === parameters?.id()
      ) {
        const methods = new Set<string>();
        addStandardDslBindings(methods, declaration.field("name")!);
        dslVocabulary.set(declaration.id(), methods);
        patterns.push(declaration.field("name")!);
      }
    }
    for (const pattern of patterns) {
      if (pattern?.kind() !== "object_pattern") {
        if (pattern?.text() !== "dsl")
          errors.add("workflow receives a visible dsl parameter or method destructuring", fn);
        continue;
      }
      const methods = pattern.id() === first?.id() ? names : dslVocabulary.get(pattern.parent()!.id())!;
      for (const member of pattern
        .children()
        .filter((node) => !["{", "}", ",", "comment"].includes(String(node.kind()))))
        if (
          !methods.has(member.text()) &&
          !(
            member.kind() === "pair_pattern" &&
            member.field("key")?.text() === member.field("value")?.text() &&
            methods.has(member.field("key")!.text())
          )
        )
          errors.add("DSL destructuring uses visible method names without aliasing or defaults", member);
    }
  }
  function dslMethod(call: SgNode): string | undefined {
    const callee = unwrapParentheses(callCallee(call));
    if (callee === undefined) return undefined;
    const owner = callee.kind() === "member_expression" ? callee.field("object") : callee;
    const binding = owner == null ? undefined : bindingOf(owner);
    const names = binding && dslVocabulary.get(binding.bindingId);
    return names === undefined ? undefined : directStandardDslCall(callee, names);
  }
  function languageCall(call: SgNode): boolean {
    if (!["call_expression", "new_expression"].includes(String(call.kind()))) return false;
    const callee = unwrapParentheses(
      call.kind() === "new_expression" ? (call.field("constructor") ?? undefined) : callCallee(call),
    );
    const receiver = callee?.kind() === "member_expression" ? callee.field("object") : callee;
    if (receiver?.kind() !== "identifier" || bindingOf(receiver) !== undefined) return false;
    if (call.kind() === "new_expression") return callee?.id() === receiver.id() && receiver.text() === "Error";
    return callee?.kind() === "member_expression"
      ? INTRINSICS.get(receiver.text())?.includes(callee.field("property")?.text() ?? "") === true
      : ["String", "Number", "Boolean"].includes(receiver.text());
  }
  if (entry !== undefined) registerDsl(entry);
  // Outer calls precede their nested bodies: only direct workflow() callbacks receive another DSL.
  for (const call of root
    .findAll({ rule: { kind: "call_expression" } })
    .sort((a, b) => a.range().start.index - b.range().start.index)) {
    const callback = standardCallArguments(call)[0];
    if (dslMethod(call) === "workflow" && callback !== undefined && FUNCTIONS.has(String(callback.kind())))
      registerDsl(callback);
  }
  function immutableValue(reference: SgNode): SgNode | undefined {
    const declaration = byId.get(bindingOf(reference)?.bindingId ?? -1);
    return declaration?.field("name")?.kind() === "identifier" &&
      declaration
        .parent()
        ?.children()
        .some((node) => node.kind() === "const")
      ? (declaration.field("value") ?? undefined)
      : undefined;
  }
  const literal = (node: SgNode | null | undefined) => readWorkflowLiteralData(node, immutableValue);
  validateDataflowModule(root, entries, helperById, literal, errors);

  function mappedFactory(fn: SgNode): boolean {
    const map = fn.parent()?.parent();
    if (
      map?.kind() !== "call_expression" ||
      unwrapParentheses(callCallee(map))?.field("property")?.text() !== "map" ||
      standardCallArguments(map)[0]?.id() !== fn.id()
    )
      return false;
    const group = map.parent()?.parent();
    return (
      group?.kind() === "call_expression" &&
      dslMethod(group) === "parallel" &&
      standardCallArguments(group)[0]?.id() === map.id() &&
      unwrapParentheses(fn.field("body") ?? undefined)?.kind() === "arrow_function"
    );
  }
  function ownedCallback(fn: SgNode): boolean {
    const outer = fn.parent();
    if (outer?.kind() === "arrow_function" && outer.field("body")?.id() === fn.id() && mappedFactory(outer))
      return true;
    const list = outer?.kind() === "array" ? outer : undefined;
    const args = list?.parent() ?? outer;
    const owner = args?.parent();
    if (args?.kind() !== "arguments" || owner?.kind() !== "call_expression") return false;
    const method = dslMethod(owner);
    const values = standardCallArguments(owner);
    return (
      (method === "parallel" && values[0]?.id() === list?.id()) ||
      (method === "workflow" && values[0]?.id() === fn.id()) ||
      (method === "pipeline" && values.slice(1).some((n) => n.id() === fn.id()))
    );
  }
  function pureCallback(fn: SgNode): boolean {
    const parent = fn.parent();
    const call = parent?.parent();
    const callee = call?.kind() === "call_expression" ? unwrapParentheses(callCallee(call)) : undefined;
    return (
      parent?.kind() === "arguments" &&
      callee?.kind() === "member_expression" &&
      CALLBACK_METHODS.has(callee.field("property")?.text() ?? "") &&
      standardCallArguments(call!)[0]?.id() === fn.id()
    );
  }
  function ownerFunction(node: SgNode): SgNode | undefined {
    return node.ancestors().find((n) => FUNCTIONS.has(String(n.kind())));
  }
  const ownedIds = new Set(functions.filter((fn) => fn.id() === entry?.id() || ownedCallback(fn)).map((fn) => fn.id()));
  for (const fn of functions) {
    const owned = ownedIds.has(fn.id());
    if (!owned && !helperEdges.has(fn.id()) && !pureCallback(fn) && !mappedFactory(fn))
      errors.add("functions are checked named helpers, pure inline callbacks or directly owned DSL callbacks", fn);
    if (!owned && fn.findAll({ rule: { kind: "for_in_statement" } }).length > 0)
      errors.add("data helpers and callbacks use local data expressions and conditionals, not loops", fn);
    if (!owned && fn.children().some((n) => n.kind() === "async" || n.kind() === "*"))
      errors.add("data helpers and callbacks must be synchronous", fn);
    if (fn.field("name") !== null && fn.id() !== entry?.id() && !helperEdges.has(fn.id()))
      errors.add("nested named functions are outside dataflow-v1", fn);
  }
  for (const kind of [
    "import_statement",
    "assignment_expression",
    "augmented_assignment_expression",
    "update_expression",
    "method_definition",
    "class_declaration",
    "class",
    "yield_expression",
    "this",
    "meta_property",
    "spread_element",
    "variable_declaration",
    "with_statement",
    "for_statement",
    "while_statement",
    "do_statement",
  ])
    for (const node of root.findAll({ rule: { kind } })) errors.add(`dataflow-v1 does not admit ${kind}`, node);
  for (const node of root.findAll({ rule: { kind: "unary_expression" } }))
    if (node.children().some((child) => child.kind() === "delete"))
      errors.add("dataflow-v1 cannot mutate data with delete", node);
  for (const declaration of root.findAll({ rule: { kind: "lexical_declaration" } }))
    if (!declaration.children().some((n) => n.kind() === "const"))
      errors.add("dataflow-v1 data bindings must be const", declaration);
  for (const declaration of declarations) {
    const value = declaration.field("value");
    if (value !== null && FUNCTIONS.has(String(value.kind())) && !helperById.has(declaration.id()))
      errors.add("function values cannot be stored as data", value);
  }
  for (const pair of root.findAll({ rule: { kind: "pair" } }))
    if (["constructor", "prototype", "__proto__"].includes(staticObjectKey(pair.field("key")) ?? ""))
      errors.add("reflection and prototype keys are outside dataflow-v1", pair);

  for (const kind of ["member_expression", "subscript_expression"])
    for (const member of root.findAll({ rule: { kind } })) {
      const name = staticObjectKey(member.field("property")) ?? staticStringValue(member.field("index"));
      if (["constructor", "prototype", "__proto__"].includes(name ?? ""))
        errors.add("reflection and prototype access are outside dataflow-v1", member);
      const parent = parentOutsideParentheses(member);
      if (parent?.kind() === "call_expression" && unwrapParentheses(callCallee(parent))?.id() === member.id()) continue;
      const type = staticWorkflowDataKind(member.field("object"), (reference) => {
        const scope = functions.find((fn) => fn.id() === bindingOf(reference)?.scopeId);
        const parameters = scope && standardFunctionParameters(scope);
        if (
          parameters &&
          dslVocabulary.has(parameters.id()) &&
          standardFunctionParameterNodes(parameters)[1]?.text() === reference.text()
        )
          return "string";
        return immutableValue(reference);
      });
      if (type && name && isWorkflowNativeMethod(name, type))
        errors.add("ordinary native methods must be called directly, never stored as data", member);
    }

  const labels = new Map<string, SgNode>();
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapParentheses(callCallee(call));
    const method = dslMethod(call);
    const owner = ownerFunction(call);
    if (method !== undefined) {
      if (!ownedIds.has(owner?.id() ?? -1) || FORBIDDEN_DSL.has(method))
        errors.add(`dataflow-v1 does not admit hidden or host DSL ${method}()`, call);
      if (call.ancestors().some((n) => n.kind() === "try_statement"))
        errors.add("DSL failures must propagate; try/catch/finally cannot cover DSL work", call);
      if (ASYNC_DSL.has(method)) {
        const parent = call.parent();
        const directReturn =
          parent?.kind() === "return_statement" ||
          (owner?.kind() === "arrow_function" && owner.field("body")?.id() === call.id());
        if (parent?.kind() !== "await_expression" && !(directReturn && ownedIds.has(owner?.id() ?? -1)))
          errors.add("promise-producing DSL work must be directly awaited or returned by its owned root/stage", call);
      }
      if (method === "agent") {
        validateOrchestrationOnlyAgentLabel(call, labels, diagnostics);
        validateDataflowAgentOptions(call, literal, errors);
      }
      if (
        (method === "publishArtifact" || method === "publishPrimaryArtifact") &&
        ["object", "array"].includes(String(unwrapStandardValue(standardCallArguments(call)[1])?.kind()))
      )
        errors.add("publication takes in-memory text; the workflowSource/file overload is removed", call);
      if (method === "parallel") {
        const first = unwrapParentheses(standardCallArguments(call)[0]);
        const inline =
          first?.kind() === "array" &&
          first
            .children()
            .filter((n) => !["[", "]", ",", "comment"].includes(String(n.kind())))
            .every((n) => FUNCTIONS.has(String(n.kind())) && ownedCallback(n));
        const mapped =
          first?.kind() === "call_expression" &&
          standardCallArguments(first)[0]?.kind() === "arrow_function" &&
          mappedFactory(standardCallArguments(first)[0]!);
        if (!inline && !mapped) errors.add("parallel takes an inline thunk array or direct mapped-thunk factory", call);
        if (mapped) {
          const options = standardCallArguments(call)[1];
          if (
            options?.kind() !== "object" ||
            !options.children().some((n) => n.kind() === "pair" && staticObjectKey(n.field("key")) === "keys")
          )
            errors.add("mapped parallel requires explicit complete keys", call);
        }
      }
      continue;
    }
    const target = callee?.kind() === "identifier" ? bindingOf(callee) : undefined;
    const helper = target && helperById.get(target.bindingId);
    if (helper !== undefined) continue;
    const receiver = callee?.kind() === "member_expression" ? callee.field("object") : undefined;
    const name = callee?.field("property")?.text();
    if (callee?.kind() === "member_expression" && CALLBACK_METHODS.has(name ?? "")) {
      const callback = unwrapParentheses(standardCallArguments(call)[0]);
      const named = callback?.kind() === "identifier" && helperById.has(bindingOf(callback)?.bindingId ?? -1);
      if (
        !named &&
        !(
          callback !== undefined &&
          FUNCTIONS.has(String(callback.kind())) &&
          (pureCallback(callback) || mappedFactory(callback))
        )
      )
        errors.add("data callbacks are checked helpers or synchronous inline callbacks, never callable data", call);
    }
    if (
      !languageCall(call) &&
      !(callee?.kind() === "member_expression" && DATA_METHODS.has(name ?? "") && receiver != null)
    )
      errors.add(
        "dataflow-v1 calls only checked helpers, ordinary data methods, listed intrinsics and direct DSL primitives",
        call,
        WORKFLOW_SOURCE_DIAGNOSTIC_CODES.call,
      );
  }
  for (const call of root.findAll({ rule: { kind: "new_expression" } }))
    if (!languageCall(call)) errors.add("dataflow-v1 permits only an ordinary Error construction", call);
  for (const awaitNode of root.findAll({ rule: { kind: "await_expression" } })) {
    const value = unwrapStandardValue(awaitNode);
    if (
      value?.kind() !== "call_expression" ||
      !ASYNC_DSL.has(dslMethod(value) ?? "") ||
      !ownedIds.has(ownerFunction(awaitNode)?.id() ?? -1)
    )
      errors.add("await belongs only to directly owned promise-producing DSL work", awaitNode);
  }
  function helperUse(node: SgNode): boolean {
    const parent = parentOutsideParentheses(node);
    if (parent?.kind() === "call_expression" && unwrapParentheses(callCallee(parent))?.id() === node.id()) return true;
    const call = parent?.parent();
    return (
      parent?.kind() === "arguments" &&
      call?.kind() === "call_expression" &&
      CALLBACK_METHODS.has(unwrapParentheses(callCallee(call))?.field("property")?.text() ?? "") &&
      unwrapParentheses(standardCallArguments(call)[0])?.id() === node.id()
    );
  }
  for (const kind of ["identifier", "shorthand_property_identifier"])
    for (const node of root.findAll({ rule: { kind } })) {
      if (isStandardBindingOccurrence(node, true) || node.parent()?.field("name")?.id() === node.id()) continue;
      const binding = bindingOf(node);
      const helper = binding && helperById.get(binding.bindingId);
      const parent = parentOutsideParentheses(node);
      if (helper !== undefined) {
        if (!helperUse(node)) errors.add("checked helpers cannot be passed as data, aliased or returned", node);
        else {
          const enclosing = node.ancestors().find((fn) => helperEdges.has(fn.id()));
          if (enclosing !== undefined) helperEdges.get(enclosing.id())!.add(helper.id());
        }
      } else if (binding !== undefined && dslVocabulary.get(binding.bindingId)?.has(node.text())) {
        const call = parent?.kind() === "member_expression" ? parentOutsideParentheses(parent) : parent;
        const destructure =
          parent?.kind() === "variable_declarator" &&
          parent.field("name")?.kind() === "object_pattern" &&
          dslVocabulary.has(parent.id());
        if (!destructure && (call?.kind() !== "call_expression" || dslMethod(call) === undefined))
          errors.add("DSL functions cannot be aliased, computed, captured as data or passed to helpers", node);
      } else if (binding === undefined && node.text() !== "undefined") {
        const use = parent?.kind() === "member_expression" ? parentOutsideParentheses(parent) : parent;
        const allowed = use != null && languageCall(use);
        if (!allowed)
          errors.add(
            `dataflow-v1 has no proven data binding for ${node.text()}`,
            node,
            WORKFLOW_SOURCE_DIAGNOSTIC_CODES.identifier,
          );
      }
      const enclosingHelper = node.ancestors().find((fn) => helperEdges.has(fn.id()));
      if (binding !== undefined && enclosingHelper !== undefined) {
        const scopeInside =
          binding.scopeId === enclosingHelper.id() ||
          enclosingHelper.findAll({ rule: { kind: "statement_block" } }).some((n) => n.id() === binding.scopeId) ||
          functions.some((fn) => fn.id() === binding.scopeId && nodeWithinStandardNode(fn, enclosingHelper)) ||
          enclosingHelper.findAll({ rule: { kind: "catch_clause" } }).some((n) => n.id() === binding.scopeId);
        if (!scopeInside && helper === undefined) {
          const declaration = byId.get(binding.bindingId);
          try {
            if (declaration?.parent()?.parent()?.id() !== root.id()) throw new Error("not a module literal");
            literal(declaration.field("value"));
          } catch {
            errors.add("top-level helpers capture only module literal constants and checked helpers", node);
          }
        }
      }
    }
  const verifiedHelpers = new Set<number>();
  function visitHelper(id: number, ancestors: Set<number>): void {
    if (verifiedHelpers.has(id)) return;
    if (ancestors.has(id)) {
      errors.add(
        "checked helper calls must form an acyclic direct DAG",
        functions.find((fn) => fn.id() === id),
      );
      return;
    }
    for (const next of helperEdges.get(id) ?? []) visitHelper(next, new Set([...ancestors, id]));
    verifiedHelpers.add(id);
  }
  for (const id of helperEdges.keys()) visitHelper(id, new Set());
  validateStandardPhaseDeclarations(root, entry, diagnostics);
  return diagnostics.values();
}

/** Fresh runtime admission reads exactly the bytes that will be imported. */
export function assertDataflowWorkflowSource(source: string): boolean {
  if (!workflowSourceDeclaresDataflow(source)) return false;
  const errors = dataflowWorkflowSourceDiagnostics(source).filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0)
    throw new Error(
      `dataflow-v1 source refused: ${errors.map((error) => `${error.line}:${error.column} [${error.code}] ${error.message}`).join("; ")}`,
    );
  return true;
}
