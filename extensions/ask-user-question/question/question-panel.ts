/**
 * extensions/ask-user-question/question/question-panel.ts — The inline ask panel.
 *
 * One non-overlay component that owns the whole answer for a question: cursor
 * movement, multi-select toggling, the custom-response editor, the ask timeout,
 * and back/forward navigation across a multi-question prompt. It decodes its
 * own keys and never reaches for Pi: handing the component to the host, and
 * choosing it over Pi's native dialogs, stays in `question-prompt.ts`.
 */

import { Input } from "@earendil-works/pi-tui";
import { renderOperatorBlock, type OperatorThemeLike } from "../../_shared/operator/operator-ui.js";
import type { CustomUiComponent, CustomUiTui } from "../../_shared/host/pi-api.js";
import {
  CHECKED_PREFIX,
  DONE_OPTION,
  OTHER_OPTION,
  UNCHECKED_PREFIX,
  addRecommendedSuffix,
  getAutoSelectionOnTimeout,
} from "./option-labels.js";
import { splitLines } from "./prompt-text.js";
import type { AskNavigation, AskSelection, OmpQuestion } from "./question-prompt.js";
import {
  isCtrlC,
  isDown,
  isEnd,
  isEnter,
  isEscape,
  isHome,
  isLeft,
  isRight,
  isSpace,
  isUp,
} from "../../_shared/operator/operator-keys.js";

export interface AskQuestionComponentArgs {
  tui: CustomUiTui;
  question: OmpQuestion;
  optionLabels: string[];
  multi: boolean;
  timeoutMs: number | undefined;
  signal: AbortSignal;
  done: (result: AskSelection) => void;
  previous?: Pick<AskSelection, "selectedOptions" | "customInput">;
  navigation?: AskNavigation;
  theme?: OperatorThemeLike;
}

interface AskRenderedChoice {
  kind: "option" | "done" | "other";
  label: string;
  value?: string;
}

export class AskQuestionComponent implements CustomUiComponent {
  #tui: CustomUiTui;
  #question: OmpQuestion;
  #optionLabels: string[];
  #multi: boolean;
  #timeoutMs: number | undefined;
  #signal: AbortSignal;
  #done: (result: AskSelection) => void;
  #navigation: AskNavigation | undefined;
  #theme: OperatorThemeLike | undefined;
  #selected = new Set<string>();
  #selectedValue: string | undefined;
  #customInput: string | undefined;
  #customEditor = new Input();
  #mode: "select" | "custom" = "select";
  #validationMessage: string | undefined;
  #cursorIndex = 0;
  #finished = false;
  #timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  #abortHandler: (() => void) | undefined;

  constructor(args: AskQuestionComponentArgs) {
    this.#tui = args.tui;
    this.#question = args.question;
    this.#optionLabels = args.optionLabels;
    this.#multi = args.multi;
    this.#timeoutMs = args.timeoutMs;
    this.#signal = args.signal;
    this.#done = args.done;
    this.#navigation = args.navigation;
    this.#theme = args.theme;
    this.#customInput = args.previous?.customInput;
    this.#customEditor.focused = true;
    if (this.#customInput !== undefined) this.#customEditor.setValue(this.#customInput);
    this.#customEditor.onSubmit = (value) => this.#submitCustomInput(value);
    this.#customEditor.onEscape = () => this.#cancel();

    if (this.#multi) {
      this.#selected = new Set(
        (args.previous?.selectedOptions ?? []).filter((label) => this.#optionLabels.includes(label)),
      );
    } else {
      this.#selectedValue = (args.previous?.selectedOptions ?? []).find((label) => this.#optionLabels.includes(label));
    }

    this.#cursorIndex = this.#initialCursorIndex(args.previous);
    if (this.#signal.aborted) {
      queueMicrotask(() => this.#cancel());
      return;
    }
    this.#abortHandler = () => this.#cancel();
    this.#signal.addEventListener("abort", this.#abortHandler, { once: true });
    this.#startTimeout();
  }

  render(width: number): string[] {
    const choices = this.#choices();
    this.#clampCursor(choices.length);
    const [primary = "Choose an answer", ...questionBody] = splitLines(this.#question.question);
    const body =
      this.#mode === "custom"
        ? [
            ...questionBody,
            "Type a custom response, then press Enter.",
            ...this.#customEditor.render(Math.max(1, width - 6)).map((line) => `> ${line}`),
            ...(this.#validationMessage === undefined ? [] : [this.#validationMessage]),
          ]
        : [...questionBody, ...choices.map((choice, index) => this.#renderChoice(choice, index))];
    return renderOperatorBlock(
      {
        type: this.#mode === "custom" ? "INPUT" : "SELECT",
        subject: "Ask",
        primary,
        badges: [
          ...(this.#multi ? [{ text: "MULTI", tone: "accent" as const }] : []),
          ...(this.#navigation?.progressText ? [{ text: this.#navigation.progressText, tone: "muted" as const }] : []),
        ],
        body,
        controls: [this.#renderHelp()],
      },
      width,
      this.#theme,
    );
  }

  async handleInput(data: string): Promise<void> {
    if (this.#finished) return;
    if (this.#mode === "custom") {
      this.#validationMessage = undefined;
      this.#customEditor.handleInput(data);
      this.#requestRender();
      return;
    }
    if (isEscape(data) || isCtrlC(data)) {
      this.#cancel();
      return;
    }
    if (this.#navigation?.allowBack && isLeft(data)) {
      this.#finishCurrentState("back");
      return;
    }
    if (this.#navigation?.allowForward && isRight(data)) {
      this.#finishCurrentState("forward");
      return;
    }
    if (isHome(data)) {
      this.#cursorIndex = 0;
      this.#requestRender();
      return;
    }
    if (isEnd(data)) {
      this.#cursorIndex = Math.max(0, this.#choices().length - 1);
      this.#requestRender();
      return;
    }
    if (isUp(data)) {
      this.#moveCursor(-1);
      return;
    }
    if (isDown(data)) {
      this.#moveCursor(1);
      return;
    }
    if (isEnter(data) || isSpace(data)) {
      await this.#activateCurrentChoice();
    }
  }

  invalidate(): void {
    this.#customEditor.invalidate();
  }

  #choices(): AskRenderedChoice[] {
    if (this.#multi) {
      const choices: AskRenderedChoice[] = this.#optionLabels.map((label) => ({
        kind: "option" as const,
        label,
        value: label,
      }));
      if (this.#selected.size > 0) choices.push({ kind: "done" as const, label: DONE_OPTION });
      choices.push({ kind: "other" as const, label: OTHER_OPTION });
      return choices;
    }
    const shownLabels = addRecommendedSuffix(this.#optionLabels, this.#question.recommended);
    return [
      ...shownLabels.map((label, index) => ({ kind: "option" as const, label, value: this.#optionLabels[index]! })),
      { kind: "other" as const, label: OTHER_OPTION },
    ];
  }

  #renderChoice(choice: AskRenderedChoice, index: number): string {
    const prefix = index === this.#cursorIndex ? "> " : "  ";
    if (choice.kind === "option") {
      if (this.#multi) {
        return `${prefix}${this.#selected.has(choice.value!) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${choice.label}`;
      }
      return `${prefix}${choice.label}`;
    }
    if (choice.kind === "done") return `${prefix}${DONE_OPTION}`;
    return `${prefix}${OTHER_OPTION}`;
  }

  #renderHelp(): string {
    if (this.#mode === "custom") return "enter submit | esc cancel";
    if (this.#navigation !== undefined) {
      return this.#multi
        ? "up/down move | space toggle | enter Done | left/right prev-next | esc cancel"
        : "up/down move | enter select | left/right prev-next | esc cancel";
    }
    return this.#multi
      ? "up/down move | enter/space toggle | enter Done | esc cancel"
      : "up/down move | enter select | esc cancel";
  }

  #initialCursorIndex(previous: Pick<AskSelection, "selectedOptions" | "customInput"> | undefined): number {
    if (previous?.customInput !== undefined) {
      return Math.max(
        0,
        this.#choices().findIndex((choice) => choice.kind === "other"),
      );
    }
    const selectedValue = previous?.selectedOptions.find((label) => this.#optionLabels.includes(label));
    if (selectedValue !== undefined) {
      const index = this.#optionLabels.indexOf(selectedValue);
      if (index >= 0) return index;
    }
    if (
      typeof this.#question.recommended === "number" &&
      this.#question.recommended >= 0 &&
      this.#question.recommended < this.#optionLabels.length
    ) {
      return this.#question.recommended;
    }
    return 0;
  }

  #currentResultBase(): Pick<AskSelection, "selectedOptions" | "customInput"> {
    if (this.#multi) {
      const result: Pick<AskSelection, "selectedOptions" | "customInput"> = { selectedOptions: [...this.#selected] };
      if (this.#customInput !== undefined) result.customInput = this.#customInput;
      return result;
    }
    const result: Pick<AskSelection, "selectedOptions" | "customInput"> = {
      selectedOptions: this.#selectedValue !== undefined ? [this.#selectedValue] : [],
    };
    if (this.#customInput !== undefined) result.customInput = this.#customInput;
    return result;
  }

  #moveCursor(delta: number): void {
    const choices = this.#choices();
    if (choices.length === 0) return;
    this.#cursorIndex = (this.#cursorIndex + delta + choices.length) % choices.length;
    this.#requestRender();
  }

  #clampCursor(length: number): void {
    if (length <= 0) {
      this.#cursorIndex = 0;
      return;
    }
    this.#cursorIndex = Math.max(0, Math.min(this.#cursorIndex, length - 1));
  }

  #currentChoice(): AskRenderedChoice | undefined {
    const choices = this.#choices();
    this.#clampCursor(choices.length);
    return choices[this.#cursorIndex];
  }

  async #activateCurrentChoice(): Promise<void> {
    const choice = this.#currentChoice();
    if (!choice) return;
    if (choice.kind === "done") {
      this.#finishCurrentState();
      return;
    }
    if (choice.kind === "other") {
      this.#openCustomInput();
      return;
    }
    if (this.#multi) {
      if (this.#customInput !== undefined) this.#customInput = undefined;
      if (this.#selected.has(choice.value!)) this.#selected.delete(choice.value!);
      else this.#selected.add(choice.value!);
      this.#clampCursor(this.#choices().length);
      this.#requestRender();
      return;
    }
    this.#selectedValue = choice.value!;
    this.#customInput = undefined;
    this.#finishCurrentState();
  }

  #openCustomInput(): void {
    this.#clearTimeout();
    this.#mode = "custom";
    this.#validationMessage = undefined;
    if (this.#customInput !== undefined) {
      this.#customEditor.setValue(this.#customInput);
    }
  }

  #submitCustomInput(value: string): void {
    const custom = value.trim();
    if (custom === "") {
      this.#validationMessage = "Response must not be empty.";
      this.#requestRender();
      return;
    }
    if (this.#multi) this.#selected.clear();
    else this.#selectedValue = undefined;
    this.#customInput = custom;
    this.#finishCurrentState();
  }

  #finishCurrentState(navigation?: "back" | "forward", timedOut = false): void {
    const base = this.#currentResultBase();
    this.#finish({
      ...base,
      cancelled: false,
      timedOut,
      ...(navigation !== undefined ? { navigation } : {}),
    });
  }

  #handleTimeout(): void {
    if (this.#finished) return;
    const base = this.#currentResultBase();
    if (base.selectedOptions.length === 0 && base.customInput === undefined) {
      this.#finish({
        selectedOptions: getAutoSelectionOnTimeout(this.#optionLabels, this.#question.recommended),
        cancelled: false,
        timedOut: true,
      });
      return;
    }
    this.#finish({ ...base, cancelled: false, timedOut: true });
  }

  #cancel(): void {
    if (this.#finished) return;
    this.#finish({ ...this.#currentResultBase(), cancelled: true, timedOut: false });
  }

  #finish(result: AskSelection): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#clearTimeout();
    if (this.#abortHandler !== undefined) {
      this.#signal.removeEventListener("abort", this.#abortHandler);
      this.#abortHandler = undefined;
    }
    this.#done(result);
  }

  #startTimeout(): void {
    if (this.#timeoutMs === undefined || !Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) return;
    this.#timeoutHandle = setTimeout(() => this.#handleTimeout(), this.#timeoutMs);
  }

  #clearTimeout(): void {
    if (this.#timeoutHandle !== undefined) {
      clearTimeout(this.#timeoutHandle);
      this.#timeoutHandle = undefined;
    }
  }

  #requestRender(): void {
    this.#tui.requestRender();
  }
}
