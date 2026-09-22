/**
 * extensions/ask-user-question/question/question-prompt.ts — One question in, one
 * selection out.
 *
 * Declares the prompt contract every ask surface fulfils (`OmpQuestion` in,
 * `AskSelection` out) and picks the surface: the shared operator question for a
 * single untimed choice, the inline panel for anything it cannot express, and
 * Pi's native dialogs when there is no custom UI at all. This is the only
 * module that hands the panel to the host; the panel itself is Pi-free and
 * lives in `question-panel.ts`.
 */

import { requestInlineOperatorInteraction } from "../../_shared/operator/operator-interaction.js";
import { requestOperatorQuestion } from "../../_shared/operator/operator-question.js";
import type { OperatorThemeLike } from "../../_shared/operator/operator-ui.js";
import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { OTHER_OPTION } from "./option-labels.js";
import { AskQuestionComponent } from "./question-panel.js";
import { askMultiQuestion, askSingleSelectQuestion } from "../interactive/select-fallback.js";

export interface OmpQuestion {
  id: string;
  question: string;
  options: Array<{ label: string }>;
  multi?: boolean;
  recommended?: number;
  timeoutMs?: number;
}

export interface AskSelection {
  selectedOptions: string[];
  customInput?: string;
  cancelled: boolean;
  timedOut: boolean;
  navigation?: "back" | "forward";
}

export interface AskNavigation {
  allowBack: boolean;
  allowForward: boolean;
  progressText?: string;
}

export async function askSingleQuestion(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  multi: boolean,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  options: { previous?: Pick<AskSelection, "selectedOptions" | "customInput">; navigation?: AskNavigation } = {},
): Promise<AskSelection> {
  const sharedSingleQuestionAvailable =
    ctx.mode === "rpc" || (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined);
  if (!multi && timeoutMs === undefined && sharedSingleQuestionAvailable) {
    const shared = await requestOperatorQuestion(
      ctx,
      {
        question: question.question,
        subject: "Ask",
        options: optionLabels.map((label, index) => ({
          label,
          value: label,
          ...(question.recommended === index ? { recommended: true } : {}),
        })),
        allowCustom: true,
        customLabel: OTHER_OPTION,
        customPlaceholder: "Type a custom response",
        ...(options.navigation?.progressText ? { progressText: options.navigation.progressText } : {}),
        ...(options.navigation === undefined
          ? {}
          : {
              navigation: {
                allowBack: options.navigation.allowBack,
                allowForward: options.navigation.allowForward,
              },
            }),
        ...(options.previous?.customInput !== undefined
          ? { initialAnswer: { kind: "custom" as const, answer: options.previous.customInput } }
          : options.previous?.selectedOptions[0] !== undefined
            ? { initialAnswer: { kind: "option" as const, answer: options.previous.selectedOptions[0] } }
            : {}),
      },
      { signal },
    );
    if (shared.status === "answered") {
      return shared.kind === "custom"
        ? { selectedOptions: [], customInput: shared.answer, cancelled: false, timedOut: false }
        : { selectedOptions: [shared.answer], cancelled: false, timedOut: false };
    }
    if (shared.status === "navigate") {
      return {
        selectedOptions: shared.answer?.kind === "option" ? [shared.answer.answer] : [],
        ...(shared.answer?.kind === "custom" ? { customInput: shared.answer.answer } : {}),
        cancelled: false,
        timedOut: false,
        navigation: shared.direction,
      };
    }
    return { selectedOptions: [], cancelled: true, timedOut: false };
  }
  if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
    return askQuestionWithCustomUi(ctx, question, optionLabels, multi, timeoutMs, signal, options);
  }
  if (multi) return askMultiQuestion(ctx, question, optionLabels, timeoutMs, signal);
  return askSingleSelectQuestion(ctx, question, optionLabels, timeoutMs, signal);
}

async function askQuestionWithCustomUi(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  multi: boolean,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  options: { previous?: Pick<AskSelection, "selectedOptions" | "customInput">; navigation?: AskNavigation } = {},
): Promise<AskSelection> {
  if (signal.aborted) {
    return {
      ...(options.previous?.selectedOptions !== undefined
        ? { selectedOptions: [...options.previous.selectedOptions] }
        : { selectedOptions: [] }),
      ...(options.previous?.customInput !== undefined ? { customInput: options.previous.customInput } : {}),
      cancelled: true,
      timedOut: false,
    };
  }
  if (ctx.ui.custom === undefined) {
    return multi
      ? askMultiQuestion(ctx, question, optionLabels, timeoutMs, signal)
      : askSingleSelectQuestion(ctx, question, optionLabels, timeoutMs, signal);
  }
  return await requestInlineOperatorInteraction<AskSelection>(ctx, (tui, theme, _keybindings, done) => {
    const resolvedTheme = operatorTheme(theme);
    return new AskQuestionComponent({
      tui,
      question,
      optionLabels,
      multi,
      timeoutMs,
      signal,
      done,
      ...(resolvedTheme === undefined ? {} : { theme: resolvedTheme }),
      ...(options.previous !== undefined ? { previous: options.previous } : {}),
      ...(options.navigation !== undefined ? { navigation: options.navigation } : {}),
    });
  });
}

function operatorTheme(value: unknown): OperatorThemeLike | undefined {
  return typeof value === "object" && value !== null ? (value as OperatorThemeLike) : undefined;
}
