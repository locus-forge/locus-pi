/**
 * extensions/ask-user-question/interactive/question-runner.ts — The OMP ask flow.
 *
 * Walks a question list one prompt at a time, honouring back/forward
 * navigation, turns a lost prompt surface into its own retryable status,
 * records every answer as a durable decision, and formats the answers the model
 * reads back.
 */

import { emitDevEvent } from "../../_shared/runtime/event-bus.js";
import { recordDecision, stableDecisionId } from "./human-control.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
} from "../../_shared/operator/operator-interaction.js";
import type { ExtensionAPI, ExtensionContext, ToolResult } from "../../_shared/host/pi-api.js";
import { errorResult, textResult } from "../../_shared/host/pi-api.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import type { OmpAskParams } from "../tool/ask-tool.js";
import { askSingleQuestion, type AskNavigation, type AskSelection } from "../question/question-prompt.js";

export interface QuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

export async function askOmpCompatible(
  pi: ExtensionAPI,
  params: OmpAskParams,
  ctx: ExtensionContext,
  signal: AbortSignal,
  source: string,
): Promise<ToolResult> {
  if (params.questions.length === 0) return errorResult("Error: questions must not be empty");
  if (ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print") {
    return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
      status: "unavailable",
      reason: "no-ui",
      source,
    });
  }
  const timeoutSetting = Number(ctx.settings?.get("ask.timeout") ?? 0);
  const timeoutMs = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting * 1000 : undefined;
  const questionCount = params.questions.length;
  const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: questionCount });
  let questionIndex = 0;

  while (questionIndex < questionCount) {
    const question = params.questions[questionIndex]!;
    const labels = question.options.map((option) => option.label);
    const title =
      questionCount > 1 ? `${question.question} (${questionIndex + 1}/${questionCount})` : question.question;
    const navigation =
      questionCount > 1
        ? { allowBack: questionIndex > 0, allowForward: true, progressText: `${questionIndex + 1}/${questionCount}` }
        : undefined;
    const askOptions: { previous?: Pick<AskSelection, "selectedOptions" | "customInput">; navigation?: AskNavigation } =
      {};
    const previous = resultsByIndex[questionIndex];
    if (previous !== undefined) askOptions.previous = previous;
    if (navigation !== undefined) askOptions.navigation = navigation;
    let selection: AskSelection;
    try {
      selection = await askSingleQuestion(
        ctx,
        { ...question, question: title },
        labels,
        Boolean(question.multi),
        question.timeoutMs ?? timeoutMs,
        signal,
        askOptions,
      );
    } catch (error) {
      const reason = errorMessage(error);
      // Pi shows one inline surface at a time. Another prompt taking the screen
      // is normal traffic, not a broken tool: it is reported as its own
      // retryable status so the model re-asks instead of treating the question
      // as failed.
      if (isStaleInlineOperatorInteractionError(error)) {
        // Only a genuine takeover may claim one; a stale lease means this prompt
        // never reached the screen at all, and saying "ask again" to that would
        // promise a retry that fails the same way.
        const superseded = isSupersededInlineOperatorInteractionError(error);
        return errorResult(
          superseded
            ? "Ask was closed because another prompt took the screen; ask again."
            : "Ask did not reach the screen: this session's prompt surface is no longer the one that asked.",
          {
            status: superseded ? "superseded" : "stale",
            source,
            question: question.id,
          },
        );
      }
      return errorResult(`Ask UI failed: ${reason}`, {
        status: "error",
        source,
        question: question.id,
      });
    }
    if (selection.cancelled && !selection.timedOut) {
      const decision = await recordDecision(pi, ctx, {
        decisionId: stableDecisionId(source, question.id),
        question: question.question,
        status: "cancelled",
        source,
      });
      return errorResult("Ask tool was cancelled by the user", { question: question.id, decision });
    }
    resultsByIndex[questionIndex] = {
      id: question.id,
      question: question.question,
      options: labels,
      multi: Boolean(question.multi),
      selectedOptions: selection.selectedOptions,
      ...(selection.customInput !== undefined ? { customInput: selection.customInput } : {}),
    };

    if (selection.navigation === "back") {
      questionIndex = Math.max(0, questionIndex - 1);
      continue;
    }
    questionIndex += 1;
  }

  const results = resultsByIndex.map((result, index) => {
    if (result) return result;
    const question = params.questions[index]!;
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: Boolean(question.multi),
      selectedOptions: [],
    };
  });

  emitDevEvent("ask:answered", { questions: questionCount });
  const decisions: unknown[] = [];
  for (const result of results) {
    decisions.push(
      await recordDecision(pi, ctx, {
        decisionId: stableDecisionId(source, result.id),
        question: result.question,
        answer: {
          selectedOptions: result.selectedOptions,
          ...(result.customInput !== undefined ? { customInput: result.customInput } : {}),
        },
        status: "answered",
        source,
        metadata: { multi: result.multi },
      }),
    );
  }
  if (results.length === 1) {
    const result = results[0]!;
    return textResult(formatSingleAnswer(result), {
      question: result.question,
      options: result.options,
      multi: result.multi,
      selectedOptions: result.selectedOptions,
      ...(result.customInput !== undefined ? { customInput: result.customInput } : {}),
      decision: decisions[0],
    });
  }
  return textResult(`User answers:\n${results.map(formatQuestionLine).join("\n")}`, { results, decisions });
}

function formatSingleAnswer(result: QuestionResult): string {
  const lines: string[] = [];
  if (result.selectedOptions.length > 0) lines.push(`User selected: ${result.selectedOptions.join(", ")}`);
  if (result.customInput !== undefined) {
    lines.push(
      result.customInput.includes("\n")
        ? `User provided custom input:\n${indentMultiline(result.customInput)}`
        : `User provided custom input: ${result.customInput}`,
    );
  }
  return lines.join("\n") || "User answered with no selection.";
}

function formatQuestionLine(result: QuestionResult): string {
  if (result.customInput !== undefined) return `${result.id}: "${result.customInput}"`;
  if (result.selectedOptions.length > 0) {
    return result.multi
      ? `${result.id}: [${result.selectedOptions.join(", ")}]`
      : `${result.id}: ${result.selectedOptions[0]}`;
  }
  return `${result.id}: (cancelled)`;
}

function indentMultiline(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
