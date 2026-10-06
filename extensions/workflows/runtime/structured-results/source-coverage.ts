import type { SgNode } from "@ast-grep/napi";
import {
  standardLexicalBindings,
  isStandardBindingOccurrence,
  standardDslBindings,
  STANDARD_DSL_METHODS,
  standardFunctionParameters,
  standardCallArguments,
  callCallee,
} from "../../source/workflow-source-bindings.js";
import { staticObjectKey, staticStringValue, unwrapParentheses } from "../../source/workflow-source-literals.js";

/** V4-only callable subset over the existing AST; unknown dependencies refuse replay, not fresh execution. */
export function assessStructuredReplayClosure(root: SgNode): boolean {
  // Mutation/spread can replace a proven declaration with an unowned callable.
  if (
    [
      "assignment_expression",
      "augmented_assignment_expression",
      "update_expression",
      "spread_element",
      "method_definition",
    ].some((kind) => root.findAll({ rule: { kind } }).length > 0)
  )
    return false;
  const bindings = standardLexicalBindings(root);
  const intrinsics = new Map([
    ["Array", ["from", "isArray"]],
    ["Boolean", []],
    ["JSON", ["parse", "stringify"]],
    ["Map", []],
    ["Set", []],
    ["Number", ["isFinite", "isInteger", "isSafeInteger", "isNaN"]],
    ["Object", ["keys", "values", "entries", "fromEntries", "hasOwn", "is", "freeze"]],
    ["String", []],
    ["Error", []],
    ["TypeError", []],
    ["RangeError", []],
  ]);
  const declarations = [
    ...root.findAll({ rule: { kind: "variable_declarator" } }),
    ...root.findAll({ rule: { kind: "function_declaration" } }),
  ];
  const declarationById = new Map(declarations.map((node) => [node.id(), node]));
  const bindingOf = (node: SgNode) => {
    const ancestors = node.ancestors().map((ancestor) => ancestor.id());
    const visible = bindings
      .filter((binding) => binding.name === node.text() && ancestors.includes(binding.scopeId))
      .sort((left, right) => ancestors.indexOf(left.scopeId) - ancestors.indexOf(right.scopeId));
    return visible.length > 0 && visible.filter((binding) => binding.scopeId === visible[0]!.scopeId).length === 1
      ? visible[0]
      : undefined;
  };
  const entries = root
    .findAll({ rule: { kind: "function_declaration" } })
    .filter((fn) => fn.parent()?.kind() === "export_statement" && /^export\s+default\b/u.test(fn.parent()!.text()));
  const entryVocabulary = new Map(entries.map((fn) => [standardFunctionParameters(fn)?.id(), standardDslBindings(fn)]));
  const isDsl = (node: SgNode): boolean => {
    const binding = bindingOf(node);
    return binding !== undefined && entryVocabulary.get(binding.bindingId)?.has(node.text()) === true;
  };
  const instanceMethods = new Set([
    "includes",
    "indexOf",
    "lastIndexOf",
    "every",
    "some",
    "find",
    "findIndex",
    "map",
    "flatMap",
    "filter",
    "reduce",
    "reduceRight",
    "forEach",
    "sort",
    "slice",
    "concat",
    "join",
    "at",
    "has",
    "get",
    "trim",
    "startsWith",
    "endsWith",
    "split",
    "toLowerCase",
    "toUpperCase",
  ]);
  const callbacks = new Set([
    "every",
    "some",
    "find",
    "findIndex",
    "map",
    "flatMap",
    "filter",
    "reduce",
    "reduceRight",
    "forEach",
    "sort",
  ]);
  function localValue(node: SgNode, seen: Set<number>): SgNode | undefined {
    const expression = unwrapParentheses(node);
    if (
      expression === undefined ||
      !["identifier", "shorthand_property_identifier"].includes(String(expression.kind()))
    )
      return expression;
    const binding = bindingOf(expression);
    if (binding === undefined || seen.has(binding.bindingId)) return undefined;
    seen.add(binding.bindingId);
    const declaration = declarationById.get(binding.bindingId);
    if (declaration?.kind() === "function_declaration") return declaration;
    const value = declaration?.field("value");
    return value === null || value === undefined ? undefined : localValue(value, seen);
  }
  const calls = [
    ...root.findAll({ rule: { kind: "call_expression" } }),
    ...root.findAll({ rule: { kind: "new_expression" } }),
  ];
  const optionObjects = new Set<number>();
  for (const call of calls) {
    const callee = unwrapParentheses(callCallee(call));
    const name = callee?.kind() === "member_expression" ? callee.field("property")?.text() : callee?.text();
    const argument = standardCallArguments(call)[1];
    if (name !== "agent" || argument === undefined) continue;
    const options = localValue(argument, new Set());
    if (options?.kind() !== "object") return false;
    optionObjects.add(options.id());
  }
  function inputData(node: SgNode | undefined, seen = new Set<number>()): boolean {
    if (node === undefined || seen.has(node.id())) return false;
    seen.add(node.id());
    const value = localValue(node, new Set());
    if (value?.kind() === "member_expression" || value?.kind() === "subscript_expression")
      return inputData(value.field("object") ?? undefined, seen);
    if (value?.kind() === "call_expression") {
      const callee = unwrapParentheses(callCallee(value));
      const object = callee?.field("object");
      const property = callee?.field("property")?.text();
      if (object?.text() === "JSON" && property === "parse" && !bindings.some((binding) => binding.name === "JSON"))
        return true;
      if (callee?.kind() === "identifier" && callee.text() === "items" && isDsl(callee)) return true;
      if (object?.text() === "dsl" && property === "items" && isDsl(object)) return true;
    }
    const binding = bindingOf(node);
    return binding !== undefined && node.text() === "input" && entryVocabulary.has(binding.bindingId);
  }
  function callable(node: SgNode | undefined, seen = new Set<number>()): boolean {
    const expression = unwrapParentheses(node);
    if (expression === undefined) return false;
    if (["arrow_function", "function_expression", "function_declaration"].includes(String(expression.kind())))
      return true;
    if (["identifier", "shorthand_property_identifier"].includes(String(expression.kind()))) {
      if (isDsl(expression)) return true;
      if (!bindings.some((binding) => binding.name === expression.text()) && intrinsics.has(expression.text()))
        return true;
      const value = localValue(expression, seen);
      return (
        value !== undefined &&
        ["arrow_function", "function_expression", "function_declaration"].includes(String(value.kind()))
      );
    }
    if (expression.kind() !== "member_expression") return false;
    const receiver = unwrapParentheses(expression.field("object") ?? undefined);
    const name = expression.field("property")?.text();
    if (receiver === undefined || name === undefined) return false;
    if (receiver.kind() === "identifier" && !bindings.some((binding) => binding.name === receiver.text()))
      return intrinsics.get(receiver.text())?.includes(name) === true;
    if (receiver.kind() === "identifier" && receiver.text() === "dsl" && isDsl(receiver)) {
      return STANDARD_DSL_METHODS.has(name);
    }
    const value = localValue(receiver, new Set(seen));
    if (value?.kind() === "object") {
      const own = value
        .children()
        .find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === name);
      if (own !== undefined) return callable(own.field("value") ?? undefined, new Set(seen));
    }
    if (value?.kind() === "object") return false;
    if (name === "has" || name === "get") {
      const constructor = value?.kind() === "new_expression" ? value.field("constructor")?.text() : undefined;
      return (
        constructor !== undefined &&
        !bindings.some((binding) => binding.name === constructor) &&
        (constructor === "Map" || (name === "has" && constructor === "Set"))
      );
    }
    if (value?.kind() === "call_expression") {
      const producer = unwrapParentheses(callCallee(value));
      const member = producer?.kind() === "member_expression" ? producer.field("property")?.text() : undefined;
      const rootName = producer?.field("object")?.text();
      const native =
        rootName !== undefined &&
        !bindings.some((binding) => binding.name === rootName) &&
        ((rootName === "JSON" && member === "parse") || (rootName === "Array" && member === "from"));
      const dsl =
        (producer?.kind() === "identifier" && producer.text() === "items" && isDsl(producer)) ||
        (rootName === "dsl" &&
          member === "items" &&
          producer?.field("object") != null &&
          isDsl(producer.field("object")!));
      if (!native && !dsl) return false;
    }
    if (value?.kind() === "new_expression") return false;
    if (value === undefined || value.kind() === "member_expression" || value.kind() === "subscript_expression") {
      if (!inputData(receiver)) return false;
    }
    return instanceMethods.has(name);
  }
  for (const call of calls) {
    const callee = unwrapParentheses(
      call.kind() === "new_expression" ? (call.field("constructor") ?? undefined) : callCallee(call),
    );
    if (!callable(callee)) return false;
    const method = callee?.kind() === "member_expression" ? callee.field("property")?.text() : callee?.text();
    const args = standardCallArguments(call);

    if (method !== undefined && callbacks.has(method) && args[0] !== undefined && !callable(args[0])) return false;
    if (method === "from" && callee?.field("object")?.text() === "Array" && args[1] !== undefined && !callable(args[1]))
      return false;
    if (method === "workflow" && !callable(args[0])) return false;
    if (method === "pipeline" && args.slice(1).some((arg) => !callable(arg))) return false;
    if (method === "parallel") {
      const list = args[0] === undefined ? undefined : localValue(args[0], new Set());
      if (
        list?.kind() === "array" &&
        list
          .children()
          .filter((child) => !["[", "]", ",", "comment"].includes(String(child.kind())))
          .some((child) => !callable(child))
      )
        return false;
      if (list?.kind() !== "array" && list?.kind() !== "call_expression") return false;
    }
  }
  for (const pair of root.findAll({ rule: { kind: "pair" } }))
    if (
      optionObjects.has(pair.parent()?.id() ?? -1) &&
      ["validate", "repair", "outputTransport"].includes(staticObjectKey(pair.field("key")) ?? "")
    )
      return false;
  for (const node of root.findAll({ rule: { kind: "shorthand_property_identifier" } }))
    if (optionObjects.has(node.parent()?.id() ?? -1) && ["validate", "repair", "outputTransport"].includes(node.text()))
      return false;
  for (const kind of ["this", "meta_property", "subscript_expression"])
    for (const node of root.findAll({ rule: { kind } })) {
      if (kind !== "subscript_expression") return false;
      const key = node.field("index");
      if (
        key?.kind() !== "number" &&
        (key?.kind() !== "string" || ["constructor", "prototype", "__proto__"].includes(staticStringValue(key) ?? ""))
      )
        return false;
    }
  if (root.findAll({ rule: { kind: "property_identifier", regex: "^(constructor|prototype|__proto__)$" } }).length > 0)
    return false;
  for (const kind of ["identifier", "shorthand_property_identifier"])
    for (const node of root.findAll({ rule: { kind } })) {
      if (isStandardBindingOccurrence(node)) continue;
      const name = node.text();
      const scopes = new Set(node.ancestors().map((ancestor) => ancestor.id()));
      if (bindings.some((binding) => binding.name === name && scopes.has(binding.scopeId))) continue;
      if (name === "undefined") continue;
      const methods = intrinsics.get(name);
      if (methods === undefined) return false;
      const parent = node.parent();
      if (parent?.kind() === "member_expression") {
        if (parent.field("object")?.id() !== node.id() || !methods.includes(parent.field("property")?.text() ?? ""))
          return false;
      } else if (
        parent?.kind() === "new_expression"
          ? parent.field("constructor")?.id() !== node.id()
          : parent?.kind() !== "call_expression" || parent.children()[0]?.id() !== node.id()
      )
        return false;
    }
  return true;
}
