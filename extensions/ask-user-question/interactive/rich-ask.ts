/**
 * extensions/ask-user-question/interactive/rich-ask.ts — The rich single-question ask flow.
 *
 * Serves the free-text kinds itself through Pi's input/editor dialogs, and
 * uses the same side-effect-free collector for select/multi-select. Every kind
 * reaches the same finalizer with its original sensitivity and outcome status.
 */

import { finalizeQuestionOutcomes } from "./human-control.js";
import { requestOperatorInput } from "../../_shared/operator/operator-input.js";
import type { ExtensionAPI, ExtensionContext, ToolResult } from "../../_shared/host/pi-api.js";
import { errorResult } from "../../_shared/host/pi-api.js";
import { redactForSensitivity } from "../../_shared/host/redaction.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import type { RichAskParams, OmpAskParams } from "../tool/ask-tool.js";
import { inputTitle } from "../question/prompt-text.js";
import type { OmpQuestion } from "../question/question-prompt.js";
import { collectQuestions } from "./question-runner.js";

export async function askRichQuestion(
  pi: ExtensionAPI,
  params: RichAskParams,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print") {
    return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
      status: "unavailable",
      reason: "no-ui",
      source: "ask",
    });
  }
  try {
    if ((params.kind === "text" || params.kind === "editor") && params.timeoutMs !== undefined) {
      return errorResult("timeoutMs is unsupported for text/editor host dialogs; omit it or use a select question.", {
        status: "unsupported",
        source: "ask",
      });
    }
    if (params.kind === "text") {
      const defaultValue = asString(params.default);
      const input = await requestOperatorInput(
        ctx,
        defaultValue === ""
          ? { kind: "input", title: inputTitle(promptWithReason(params)), placeholder: "Type a response" }
          : { kind: "editor", title: inputTitle(promptWithReason(params)), prefill: defaultValue },
      );
      if (input.status === "unavailable") {
        return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
          status: "unavailable",
          reason: "no-ui",
        });
      }
      return finalizeInput(pi, ctx, params, input);
    }
    if (params.kind === "editor") {
      const input = await requestOperatorInput(ctx, {
        kind: "editor",
        title: inputTitle(promptWithReason(params)),
        prefill: asString(params.default),
      });
      if (input.status === "unavailable") {
        return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
          status: "unavailable",
          reason: "no-ui",
        });
      }
      return finalizeInput(pi, ctx, params, input);
    }
  } catch (error) {
    const reason = redactForSensitivity(errorMessage(error), params.sensitivity).text;
    return errorResult(`Ask UI failed: ${reason}`, {
      status: "error",
      source: "ask",
      question: stableQuestionId(params.question),
    });
  }

  const recommended = recommendedIndex(params);
  const question: OmpQuestion = {
    id: stableQuestionId(params.question),
    question: promptWithReason(params),
    options: (params.options ?? []).map((label) => ({ label })),
    multi: params.kind === "multi-select",
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  };
  if (recommended !== undefined) question.recommended = recommended;
  const converted: OmpAskParams = { questions: [question] };
  const collected = await collectQuestions(converted, ctx, signal, "ask", params.sensitivity);
  return "error" in collected ? collected.error : finalizeQuestionOutcomes(pi, ctx, collected.outcomes, "ask", params);
}

function promptWithReason(params: RichAskParams): string {
  return params.reason ? `${params.question}\n\nReason: ${params.reason}` : params.question;
}

function finalizeInput(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: RichAskParams,
  input: { status: "submitted"; value: string } | { status: "cancelled" },
): Promise<ToolResult> {
  return finalizeQuestionOutcomes(
    pi,
    ctx,
    [
      {
        id: stableQuestionId(params.question),
        question: params.question,
        options: [],
        multi: false,
        selectedOptions: [],
        ...(input.status === "submitted" ? { customInput: input.value } : {}),
        status: input.status === "submitted" ? "answered" : "cancelled",
      },
    ],
    "ask",
    params,
  );
}

function recommendedIndex(params: RichAskParams): number | undefined {
  const defaultValue = Array.isArray(params.default) ? params.default[0] : params.default;
  if (!defaultValue) return undefined;
  const index = (params.options ?? []).indexOf(defaultValue);
  return index >= 0 ? index : undefined;
}

function asString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function stableQuestionId(question: string): string {
  let hash = 2166136261;
  for (let index = 0; index < question.length; index += 1) {
    hash ^= question.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `q_${(hash >>> 0).toString(16)}`;
}
