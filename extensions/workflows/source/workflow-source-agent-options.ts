/** Static agent declarations reuse the pure runtime option contract without executing source. */
import { normalizeWorkflowStructuredContract } from "../runtime/structured-results/schema.js";
import type { SgNode } from "@ast-grep/napi";
import {
  normalizeAgentChoices,
  normalizeAgentChoiceFallback,
  REMOVED_AGENT_OPTION_NAMES,
} from "../runtime/workflow-agent-output.js";
import {
  callCallee,
  directStandardDslCall,
  standardCallArguments,
  standardDslBindings,
} from "./workflow-source-bindings.js";
import { staticObjectKey, staticStringValue, unwrapParentheses } from "./workflow-source-literals.js";
import type { WorkflowSourceDiagnosticSink } from "./workflow-source-diagnostics.js";

export function validateStandardAgentOptions(
  root: SgNode,
  runEntry: SgNode | undefined,
  errors: WorkflowSourceDiagnosticSink,
): void {
  const dslBindings = standardDslBindings(runEntry);
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapParentheses(callCallee(call));
    if (callee === undefined || directStandardDslCall(callee, dslBindings) !== "agent") continue;
    const options = unwrapParentheses(standardCallArguments(call)[1]);
    const pairs = options?.children().filter((child) => child.kind() === "pair") ?? [];
    const report = pairs.find((pair) => staticObjectKey(pair.field("key")) === "result");
    const reportValue = report && staticStringValue(unwrapParentheses(report.field("value") ?? undefined));
    if (report && reportValue !== "report") errors.add('agent result must be the static literal "report"', report);
    for (const pair of pairs) {
      const key = staticObjectKey(pair.field("key")) ?? "";
      if (key !== "schema" && REMOVED_AGENT_OPTION_NAMES.includes(key))
        errors.add(
          `agent ${key} was removed: use exact text, choice or a supported schema declaration; the runtime owns correction`,
          pair,
        );
      else if (report && (key === "choice" || key === "choiceFallback"))
        errors.add(`agent result: report cannot be combined with ${key}`, pair);
    }
    if (
      options
        ?.children()
        .some(
          (node) =>
            node.kind() === "spread_element" ||
            (node.kind() === "shorthand_property_identifier" && ["choice", "choiceFallback"].includes(node.text())),
        )
    )
      continue;
    const choice = pairs.filter((pair) => staticObjectKey(pair.field("key")) === "choice").at(-1);
    const fallback = pairs.filter((pair) => staticObjectKey(pair.field("key")) === "choiceFallback").at(-1);
    const choices = staticChoiceStrings(unwrapParentheses(choice?.field("value") ?? undefined));
    const value = staticStringValue(unwrapParentheses(fallback?.field("value") ?? undefined));
    if (choices === undefined || value === undefined) continue;
    try {
      normalizeAgentChoiceFallback(value, normalizeAgentChoices(choices));
    } catch (error) {
      errors.add(error instanceof Error ? error.message : String(error), fallback);
    }
  }
}

/** Unknown members, spreads and holes stay with runtime validation; no constant evaluation. */
function staticChoiceStrings(node: SgNode | undefined): string[] | undefined {
  if (node?.kind() !== "array") return undefined;
  const values: string[] = [];
  let awaitingValue = true;
  for (const child of node.children()) {
    if (["[", "]", "comment"].includes(String(child.kind()))) continue;
    if (child.kind() === ",") {
      if (awaitingValue) return undefined;
      awaitingValue = true;
      continue;
    }
    const value = staticStringValue(unwrapParentheses(child));
    if (value === undefined) return undefined;
    values.push(value);
    awaitingValue = false;
  }
  return values;
}

/** Static profile declarations use the existing value/wire contracts; never invoke a validator. */
export function validateDataflowAgentOptions(
  call: SgNode,
  literal: (node: SgNode | null | undefined) => unknown,
  errors: WorkflowSourceDiagnosticSink,
): void {
  const options = unwrapParentheses(standardCallArguments(call)[1]);
  if (options?.kind() !== "object") {
    errors.add("dataflow-v1 agent requires a direct static options object", call);
    return;
  }
  const fields = new Map<string, SgNode>();
  for (const child of options.children()) {
    if (["{", "}", ",", "comment"].includes(String(child.kind()))) continue;
    const key = child.kind() === "pair" ? staticObjectKey(child.field("key")) : undefined;
    if (key === undefined || fields.has(key)) {
      errors.add("agent options require unique static keys without spread or shorthand", child);
      continue;
    }
    fields.set(key, child);
    if (key !== "schema" && REMOVED_AGENT_OPTION_NAMES.includes(key)) errors.add(`agent ${key} was removed`, child);
  }
  const value = (name: string) => literal(fields.get(name)?.field("value"));
  const has = (name: string) => fields.has(name);
  try {
    if (has("schema")) {
      if (["choice", "choiceFallback", "result"].some(has))
        throw new Error("agent schema cannot combine with choice, choiceFallback or result");
      normalizeWorkflowStructuredContract(value("schema"));
    }
    if (has("result") && (value("result") !== "report" || has("choice") || has("choiceFallback")))
      throw new Error('agent result must be "report" and cannot combine with choice');
    if (has("choice")) {
      const choices = normalizeAgentChoices(value("choice"));
      if (has("choiceFallback")) normalizeAgentChoiceFallback(value("choiceFallback"), choices);
    } else if (has("choiceFallback")) throw new Error("agent choiceFallback requires choice");
  } catch (error) {
    errors.add(error instanceof Error ? error.message : String(error), options);
  }
}
