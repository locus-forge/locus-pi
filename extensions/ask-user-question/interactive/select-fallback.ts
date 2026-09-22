/**
 * extensions/ask-user-question/interactive/select-fallback.ts — Pi's native dialogs as an
 * ask surface.
 *
 * Used when the inline panel is not available: a single-choice prompt, and a
 * multi-select loop that redraws Pi's select list with checkbox markers until
 * the operator picks Done. Both honour the ask timeout by racing the dialog.
 */

import { requestOperatorInput } from "../../_shared/operator/operator-input.js";
import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import {
  CHECKED_PREFIX,
  DONE_OPTION,
  OTHER_OPTION,
  UNCHECKED_PREFIX,
  addRecommendedSuffix,
  getAutoSelectionOnTimeout,
  stripCheckboxPrefix,
  stripRecommendedSuffix,
} from "../question/option-labels.js";
import { selectTitle } from "../question/prompt-text.js";
import type { AskSelection, OmpQuestion } from "../question/question-prompt.js";

export async function askSingleSelectQuestion(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<AskSelection> {
  const shownLabels = addRecommendedSuffix(optionLabels, question.recommended);
  const choices = [...shownLabels, OTHER_OPTION];
  const choice = await selectWithTimeout(ctx, selectTitle(question.question), choices, timeoutMs, signal);
  if (choice.timedOut) {
    return {
      selectedOptions: getAutoSelectionOnTimeout(optionLabels, question.recommended),
      cancelled: false,
      timedOut: true,
    };
  }
  if (choice.cancelled || choice.value === undefined) return { selectedOptions: [], cancelled: true, timedOut: false };
  if (choice.value === OTHER_OPTION) {
    const custom = await promptCustomInput(ctx, signal);
    return custom === undefined
      ? { selectedOptions: [], cancelled: true, timedOut: false }
      : { selectedOptions: [], customInput: custom, cancelled: false, timedOut: false };
  }
  return { selectedOptions: [stripRecommendedSuffix(choice.value)], cancelled: false, timedOut: false };
}

export async function askMultiQuestion(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<AskSelection> {
  const selected = new Set<string>();
  while (true) {
    if (signal.aborted) return { selectedOptions: [...selected], cancelled: true, timedOut: false };
    const choices = optionLabels.map((label) => `${selected.has(label) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${label}`);
    if (selected.size > 0) choices.push(DONE_OPTION);
    choices.push(OTHER_OPTION);

    const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
    const choice = await selectWithTimeout(
      ctx,
      selectTitle(`${prefix}${question.question}`),
      choices,
      timeoutMs,
      signal,
    );
    if (choice.timedOut) {
      return {
        selectedOptions: selected.size ? [...selected] : getAutoSelectionOnTimeout(optionLabels, question.recommended),
        cancelled: false,
        timedOut: true,
      };
    }
    if (choice.cancelled || choice.value === undefined)
      return { selectedOptions: [...selected], cancelled: true, timedOut: false };
    if (choice.value === DONE_OPTION) return { selectedOptions: [...selected], cancelled: false, timedOut: false };
    if (choice.value === OTHER_OPTION) {
      const custom = await promptCustomInput(ctx, signal);
      return custom === undefined
        ? { selectedOptions: [...selected], cancelled: true, timedOut: false }
        : { selectedOptions: [], customInput: custom, cancelled: false, timedOut: false };
    }

    const label = stripCheckboxPrefix(choice.value);
    if (label === undefined) continue;
    if (selected.has(label)) selected.delete(label);
    else selected.add(label);
  }
}

async function selectWithTimeout(
  ctx: ExtensionContext,
  title: string,
  labels: string[],
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<{ value?: string; cancelled: boolean; timedOut: boolean }> {
  const select = ctx.ui.select(title, labels);
  const result = await raceWithTimeout(select, timeoutMs, signal);
  if (result.timedOut) return { cancelled: false, timedOut: true };
  if (result.aborted) return { cancelled: true, timedOut: false };
  const normalized = normalizeSelectReturn(result.value);
  if (normalized.value === undefined) return { cancelled: true, timedOut: false };
  return { value: normalized.value, cancelled: normalized.cancelled, timedOut: false };
}

async function promptCustomInput(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  if (ctx.mode === "rpc") {
    const raw = await (
      ctx.ui.input as unknown as (
        title: string,
        placeholder?: string,
        opts?: { signal?: AbortSignal },
      ) => Promise<string | undefined | { value: string; cancelled?: boolean }>
    )("[INPUT] Ask custom response", "Type a custom response", { signal });
    if (raw === undefined || typeof raw === "string") return raw;
    return raw.cancelled === true ? undefined : raw.value;
  }
  const result = await requestOperatorInput(ctx, {
    kind: "editor",
    title: "[INPUT] Ask custom response",
    prefill: "",
  });
  return result.status === "submitted" ? result.value : undefined;
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<{ value?: T; timedOut: boolean; aborted: boolean }> {
  if (signal.aborted) return { timedOut: false, aborted: true };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false, aborted: false })),
      new Promise<{ timedOut: boolean; aborted: boolean }>((resolve) => {
        if (timeoutMs !== undefined) timeout = setTimeout(() => resolve({ timedOut: true, aborted: false }), timeoutMs);
        abort = () => resolve({ timedOut: false, aborted: true });
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function normalizeSelectReturn(result: Awaited<ReturnType<ExtensionContext["ui"]["select"]>>): {
  value?: string;
  cancelled: boolean;
} {
  if (result === undefined) return { cancelled: true };
  if (typeof result === "string") return { value: result, cancelled: false };
  const value = result.value || result.label;
  return value === undefined
    ? { cancelled: result.cancelled ?? true }
    : { value, cancelled: result.cancelled ?? false };
}
