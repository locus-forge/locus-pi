/** Static agent declarations reuse the pure runtime option contract without executing source. */
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
      if (["schema", "validate", "repair"].includes(key))
        errors.add(`agent ${key} is runtime-only and outside this authoring grammar`, pair);
      else if (REMOVED_AGENT_OPTION_NAMES.includes(key))
        errors.add(
          `agent ${key} was removed: return exact text or one choice; write files at exact caller-assigned destinations in prompts`,
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
