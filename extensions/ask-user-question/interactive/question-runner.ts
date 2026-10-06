/**
 * extensions/ask-user-question/interactive/question-runner.ts — The OMP ask flow.
 *
 * Walks a question list one prompt at a time, honouring back/forward
 * navigation, turns a lost prompt surface into its own retryable status,
 * collects outcomes without side effects, then hands the terminal batch to the
 * single decision/result finalizer.
 */

import { finalizeQuestionOutcomes, type QuestionOutcome } from "./human-control.js";
import { redactForSensitivity } from "../../_shared/host/redaction.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
} from "../../_shared/operator/operator-interaction.js";
import type { ExtensionAPI, ExtensionContext, ToolResult } from "../../_shared/host/pi-api.js";
import { errorResult } from "../../_shared/host/pi-api.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import type { OmpAskParams } from "../tool/ask-tool.js";
import { askSingleQuestion, type AskNavigation, type AskSelection } from "../question/question-prompt.js";

export type CollectedQuestions = { outcomes: QuestionOutcome[] } | { error: ToolResult };

export async function askOmpCompatible(
  pi: ExtensionAPI,
  params: OmpAskParams,
  ctx: ExtensionContext,
  signal: AbortSignal,
  source: string,
): Promise<ToolResult> {
  const collected = await collectQuestions(params, ctx, signal, source);
  return "error" in collected ? collected.error : finalizeQuestionOutcomes(pi, ctx, collected.outcomes, source);
}

/** No journal writes, events or public answer projection before finalization. */
export async function collectQuestions(
  params: OmpAskParams,
  ctx: ExtensionContext,
  signal: AbortSignal,
  source: string,
  sensitivity?: "public" | "internal" | "secret",
): Promise<CollectedQuestions> {
  if (params.questions.length === 0) return { error: errorResult("Error: questions must not be empty") };
  if (ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print") {
    return {
      error: errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
        status: "unavailable",
        reason: "no-ui",
        source,
      }),
    };
  }
  const timeoutSetting = Number(ctx.settings?.get("ask.timeout") ?? 0);
  const timeoutMs = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting * 1000 : undefined;
  const questionCount = params.questions.length;
  const resultsByIndex: Array<QuestionOutcome | undefined> = Array.from({ length: questionCount });
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
      const reason = redactForSensitivity(errorMessage(error), sensitivity).text;
      // Pi shows one inline surface at a time. Another prompt taking the screen
      // is normal traffic, not a broken tool: it is reported as its own
      // retryable status so the model re-asks instead of treating the question
      // as failed.
      if (isStaleInlineOperatorInteractionError(error)) {
        // Only a genuine takeover may claim one; a stale lease means this prompt
        // never reached the screen at all, and saying "ask again" to that would
        // promise a retry that fails the same way.
        const superseded = isSupersededInlineOperatorInteractionError(error);
        return {
          error: errorResult(
            superseded
              ? "Ask was closed because another prompt took the screen; ask again."
              : "Ask did not reach the screen: this session's prompt surface is no longer the one that asked.",
            {
              status: superseded ? "superseded" : "stale",
              source,
              question: question.id,
            },
          ),
        };
      }
      return {
        error: errorResult(`Ask UI failed: ${reason}`, {
          status: "error",
          source,
          question: question.id,
        }),
      };
    }
    resultsByIndex[questionIndex] = {
      id: question.id,
      question: question.question,
      options: labels,
      multi: Boolean(question.multi),
      status: selection.timedOut ? "timed-out" : selection.cancelled ? "cancelled" : "answered",
      selectedOptions: selection.selectedOptions,
      ...(selection.customInput !== undefined ? { customInput: selection.customInput } : {}),
    };

    if (selection.cancelled && !selection.timedOut) {
      // Preserve batch cancellation: only the cancelled question is recorded;
      // answers that could still be changed by navigation are not committed.
      return { outcomes: [resultsByIndex[questionIndex]!] };
    }

    if (selection.navigation === "back") {
      questionIndex = Math.max(0, questionIndex - 1);
      continue;
    }
    questionIndex += 1;
  }

  return { outcomes: resultsByIndex.map((result) => result!) };
}
