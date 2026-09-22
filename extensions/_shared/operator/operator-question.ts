import { Input } from "@earendil-works/pi-tui";
import type { CustomUiComponent, CustomUiTui, ExtensionContext } from "../host/pi-api.js";
import { requestInlineOperatorInteraction, type InlineOperatorInteractionRequest } from "./operator-interaction.js";
import { renderOperatorBlock, type OperatorThemeLike } from "./operator-ui.js";
import { isCtrlC, isDown, isEnd, isEnter, isEscape, isHome, isLeft, isRight, isSpace, isUp } from "./operator-keys.js";

const DEFAULT_CUSTOM_LABEL = "Other (type your own)";
const RECOMMENDED_SUFFIX = " (Recommended)";

export interface OperatorQuestionOption {
  label: string;
  value?: string;
  recommended?: boolean;
}

export interface OperatorQuestionInitialAnswer {
  kind: "option" | "custom";
  answer: string;
}

export interface OperatorQuestionNavigation {
  allowBack: boolean;
  allowForward: boolean;
}

export interface OperatorQuestionSpec {
  question: string;
  options: readonly OperatorQuestionOption[];
  subject?: string;
  allowCustom?: boolean;
  customLabel?: string;
  customPlaceholder?: string;
  progressText?: string;
  /**
   * Who is asking, in the operator's terms: the workflow, its run, and the tool
   * that opened the gate. Without it a question block states what is being asked
   * and never which of several running things stopped for an answer.
   */
  contextText?: string;
  /** Verified caller-owned detail rendered above the answer choices. */
  detailText?: string;
  navigation?: OperatorQuestionNavigation;
  initialAnswer?: OperatorQuestionInitialAnswer;
}

export type OperatorQuestionResult =
  | { status: "answered"; kind: "option" | "custom"; answer: string; label?: string }
  | { status: "navigate"; direction: "back" | "forward"; answer?: OperatorQuestionInitialAnswer }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: "no-ui" };

export interface OperatorQuestionRequest extends InlineOperatorInteractionRequest {
  signal?: AbortSignal;
}

/**
 * Collect one option or one custom string without owning workflow/ask policy.
 *
 * TUI keeps selection and custom entry inside one non-overlay component. RPC
 * projects the same contract through Pi's native select/input requests.
 */
export async function requestOperatorQuestion(
  ctx: ExtensionContext,
  rawSpec: OperatorQuestionSpec,
  request: OperatorQuestionRequest = {},
): Promise<OperatorQuestionResult> {
  const spec = normalizeSpec(rawSpec);
  if (request.signal?.aborted === true) return { status: "cancelled" };
  if (ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print") {
    return { status: "unavailable", reason: "no-ui" };
  }
  if (ctx.mode === "rpc") return requestRpcOperatorQuestion(ctx, spec, request.signal);
  if (ctx.mode !== "tui" || ctx.ui.custom === undefined) {
    return { status: "unavailable", reason: "no-ui" };
  }

  return requestInlineOperatorInteraction(
    ctx,
    (tui, theme, _keybindings, done) =>
      new OperatorQuestionComponent(tui, spec, done, request.signal, operatorTheme(theme)),
    request,
  );
}

/** Stable answer projection used by workflow and ask callers. */
export function renderOperatorQuestionAnswer(result: OperatorQuestionResult): string | undefined {
  return result.status === "answered" ? result.answer : undefined;
}

interface NormalizedOperatorQuestionSpec extends Omit<
  OperatorQuestionSpec,
  "options" | "subject" | "allowCustom" | "customLabel"
> {
  options: Array<
    Required<Pick<OperatorQuestionOption, "label" | "value">> & Pick<OperatorQuestionOption, "recommended">
  >;
  subject: string;
  allowCustom: boolean;
  customLabel: string;
}

interface RenderedChoice {
  kind: "option" | "custom";
  displayLabel: string;
  option?: NormalizedOperatorQuestionSpec["options"][number];
}

class OperatorQuestionComponent implements CustomUiComponent {
  readonly #tui: CustomUiTui;
  readonly #spec: NormalizedOperatorQuestionSpec;
  readonly #done: (result: OperatorQuestionResult) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #theme: OperatorThemeLike | undefined;
  readonly #input = new Input();
  #cursorIndex: number;
  #mode: "select" | "custom" = "select";
  #finished = false;
  #validationMessage: string | undefined;
  #abortHandler: (() => void) | undefined;

  constructor(
    tui: CustomUiTui,
    spec: NormalizedOperatorQuestionSpec,
    done: (result: OperatorQuestionResult) => void,
    signal: AbortSignal | undefined,
    theme: OperatorThemeLike | undefined,
  ) {
    this.#tui = tui;
    this.#spec = spec;
    this.#done = done;
    this.#signal = signal;
    this.#theme = theme;
    this.#cursorIndex = initialCursorIndex(spec);
    if (spec.options.length === 0) this.#mode = "custom";
    this.#input.focused = true;
    if (spec.initialAnswer?.kind === "custom") this.#input.setValue(spec.initialAnswer.answer);
    this.#input.onSubmit = (value) => this.#submitCustom(value);
    this.#input.onEscape = () => this.#finish({ status: "cancelled" });
    if (signal?.aborted === true) {
      queueMicrotask(() => this.#finish({ status: "cancelled" }));
      return;
    }
    if (signal !== undefined) {
      this.#abortHandler = () => this.#finish({ status: "cancelled" });
      signal.addEventListener("abort", this.#abortHandler, { once: true });
    }
  }

  render(width: number): string[] {
    const [primary = "Choose an answer", ...rest] = splitLines(this.#spec.question);
    // Provenance goes in the body, not a badge: a narrow terminal drops all but
    // the first badge, and dropping either "who is asking" or "which question of
    // how many" is worse than one extra line.
    const questionBody = [
      ...(this.#spec.contextText ? [this.#spec.contextText] : []),
      ...(this.#spec.detailText ? splitLines(this.#spec.detailText) : []),
      ...rest,
    ];
    const body =
      this.#mode === "custom"
        ? [
            ...questionBody,
            this.#spec.customPlaceholder ?? "Type a response, then press Enter.",
            ...this.#input.render(Math.max(1, width - 6)).map((line) => `> ${line}`),
            ...(this.#validationMessage === undefined ? [] : [this.#validationMessage]),
          ]
        : [...questionBody, ...this.#choices().map((choice, index) => this.#renderChoice(choice, index))];
    return renderOperatorBlock(
      {
        type: this.#mode === "custom" ? "INPUT" : "SELECT",
        subject: this.#spec.subject,
        primary,
        ...(this.#spec.progressText ? { badges: [{ text: this.#spec.progressText, tone: "muted" as const }] } : {}),
        body,
        controls: [this.#controls()],
      },
      width,
      this.#theme,
    );
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    if (this.#mode === "custom") {
      this.#validationMessage = undefined;
      this.#input.handleInput(data);
      this.#requestRender();
      return;
    }
    if (isEscape(data) || isCtrlC(data)) {
      this.#finish({ status: "cancelled" });
      return;
    }
    if (this.#spec.navigation?.allowBack === true && isLeft(data)) {
      this.#finishNavigation("back");
      return;
    }
    if (this.#spec.navigation?.allowForward === true && isRight(data)) {
      this.#finishNavigation("forward");
      return;
    }
    if (isHome(data)) this.#cursorIndex = 0;
    else if (isEnd(data)) this.#cursorIndex = this.#choices().length - 1;
    else if (isUp(data)) this.#moveCursor(-1);
    else if (isDown(data)) this.#moveCursor(1);
    else if (isEnter(data) || isSpace(data)) this.#activateChoice();
    else return;
    this.#requestRender();
  }

  invalidate(): void {
    this.#input.invalidate();
  }

  dispose(): void {
    this.#detachAbortHandler();
  }

  #choices(): RenderedChoice[] {
    return [
      ...this.#spec.options.map((option) => ({
        kind: "option" as const,
        displayLabel: displayOptionLabel(option),
        option,
      })),
      ...(this.#spec.allowCustom ? [{ kind: "custom" as const, displayLabel: this.#spec.customLabel }] : []),
    ];
  }

  #renderChoice(choice: RenderedChoice, index: number): string {
    return `${index === this.#cursorIndex ? "> " : "  "}${choice.displayLabel}`;
  }

  #controls(): string {
    if (this.#mode === "custom") return "enter submit | esc cancel";
    const navigation = this.#spec.navigation === undefined ? "" : " | left/right prev-next";
    return `up/down move | enter select${navigation} | esc cancel`;
  }

  #moveCursor(delta: number): void {
    const length = this.#choices().length;
    this.#cursorIndex = (this.#cursorIndex + delta + length) % length;
  }

  #activateChoice(): void {
    const choice = this.#choices()[this.#cursorIndex];
    if (choice === undefined) return;
    if (choice.kind === "custom") {
      this.#mode = "custom";
      this.#validationMessage = undefined;
      return;
    }
    if (choice.option === undefined) return;
    this.#finish({
      status: "answered",
      kind: "option",
      answer: choice.option.value,
      label: choice.option.label,
    });
  }

  #submitCustom(value: string): void {
    const answer = value.trim();
    if (answer === "") {
      this.#validationMessage = "Response must not be empty.";
      this.#requestRender();
      return;
    }
    this.#finish({ status: "answered", kind: "custom", answer });
  }

  #finishNavigation(direction: "back" | "forward"): void {
    const initial = this.#spec.initialAnswer;
    this.#finish({
      status: "navigate",
      direction,
      ...(initial === undefined ? {} : { answer: initial }),
    });
  }

  #finish(result: OperatorQuestionResult): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#detachAbortHandler();
    this.#done(result);
  }

  #detachAbortHandler(): void {
    if (this.#abortHandler === undefined || this.#signal === undefined) return;
    this.#signal.removeEventListener("abort", this.#abortHandler);
    this.#abortHandler = undefined;
  }

  #requestRender(): void {
    this.#tui.requestRender();
  }
}

async function requestRpcOperatorQuestion(
  ctx: ExtensionContext,
  spec: NormalizedOperatorQuestionSpec,
  signal: AbortSignal | undefined,
): Promise<OperatorQuestionResult> {
  if (spec.options.length === 0) {
    const custom = normalizeDialogString(
      await (ctx.ui.input as unknown as RpcInput)(
        `[INPUT] ${spec.subject} — ${singleLine(spec.question)}`,
        spec.customPlaceholder ?? "Type a response",
        signal === undefined ? undefined : { signal },
      ),
    );
    if (custom === undefined) return { status: "cancelled" };
    const answer = custom.trim();
    return answer === "" ? { status: "cancelled" } : { status: "answered", kind: "custom", answer };
  }
  const renderedOptions = spec.options.map((option) => ({
    displayLabel: displayOptionLabel(option),
    option,
  }));
  const labels = renderedOptions.map((choice) => choice.displayLabel);
  if (spec.allowCustom) labels.push(spec.customLabel);
  const selected = normalizeDialogString(
    await (ctx.ui.select as unknown as RpcSelect)(
      selectTitle(spec),
      labels,
      signal === undefined ? undefined : { signal },
    ),
  );
  if (selected === undefined) return { status: "cancelled" };
  if (selected === spec.customLabel) {
    const custom = normalizeDialogString(
      await (ctx.ui.input as unknown as RpcInput)(
        `[INPUT] ${spec.subject} custom response`,
        spec.customPlaceholder ?? "Type a response",
        signal === undefined ? undefined : { signal },
      ),
    );
    if (custom === undefined) return { status: "cancelled" };
    const answer = custom.trim();
    return answer === "" ? { status: "cancelled" } : { status: "answered", kind: "custom", answer };
  }
  const rendered = renderedOptions.find((candidate) => candidate.displayLabel === selected);
  return rendered === undefined
    ? { status: "cancelled" }
    : {
        status: "answered",
        kind: "option",
        answer: rendered.option.value,
        label: rendered.option.label,
      };
}

type DialogStringResult = string | undefined | { value: string; cancelled?: boolean };
type RpcSelect = (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<DialogStringResult>;
type RpcInput = (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<DialogStringResult>;

function normalizeDialogString(result: DialogStringResult): string | undefined {
  if (result === undefined || typeof result === "string") return result;
  return result.cancelled === true ? undefined : result.value;
}

function normalizeSpec(spec: OperatorQuestionSpec): NormalizedOperatorQuestionSpec {
  const question = spec.question.trim();
  if (question === "") throw new TypeError("Operator question must not be empty.");
  const allowCustom = spec.allowCustom !== false;
  const customLabel = spec.customLabel?.trim() || DEFAULT_CUSTOM_LABEL;
  const detailText = spec.detailText?.trim();
  if (spec.options.length === 0 && !allowCustom) {
    throw new TypeError("Operator question must declare an option or allow custom input.");
  }
  const labels = new Set<string>();
  const values = new Set<string>();
  let recommendedCount = 0;
  const options = spec.options.map((option) => {
    const label = option.label.trim();
    const value = (option.value ?? option.label).trim();
    if (label === "" || value === "") throw new TypeError("Operator question options must not be empty.");
    if (labels.has(label) || values.has(value)) {
      throw new TypeError("Operator question option labels and values must be unique.");
    }
    labels.add(label);
    values.add(value);
    if (option.recommended === true) recommendedCount += 1;
    return { label, value, ...(option.recommended === undefined ? {} : { recommended: option.recommended }) };
  });
  if (recommendedCount > 1) throw new TypeError("Operator question may recommend at most one option.");
  const renderedLabels = options.map(displayOptionLabel);
  if (new Set(renderedLabels).size !== renderedLabels.length) {
    throw new TypeError("Operator question rendered option labels must be unique.");
  }
  if (allowCustom && renderedLabels.includes(customLabel)) {
    throw new TypeError("Operator question custom label must not duplicate a declared option label.");
  }
  return {
    ...spec,
    question,
    options,
    subject: spec.subject?.trim() || "Question",
    allowCustom,
    customLabel,
    ...(detailText === undefined || detailText === "" ? {} : { detailText }),
  };
}

function initialCursorIndex(spec: NormalizedOperatorQuestionSpec): number {
  if (spec.initialAnswer?.kind === "custom" && spec.allowCustom) return spec.options.length;
  if (spec.initialAnswer?.kind === "option") {
    const selectedIndex = spec.options.findIndex((option) => option.value === spec.initialAnswer?.answer);
    if (selectedIndex >= 0) return selectedIndex;
  }
  const recommendedIndex = spec.options.findIndex((option) => option.recommended === true);
  return recommendedIndex >= 0 ? recommendedIndex : 0;
}

function selectTitle(spec: NormalizedOperatorQuestionSpec): string {
  return `[SELECT] ${spec.subject} — ${singleLine(spec.question)}`;
}

function singleLine(value: string): string {
  return value.split(/\r?\n/).join(" ").trim();
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function displayOptionLabel(option: Pick<OperatorQuestionOption, "label" | "recommended">): string {
  return option.recommended === true && !option.label.endsWith(RECOMMENDED_SUFFIX)
    ? `${option.label}${RECOMMENDED_SUFFIX}`
    : option.label;
}

function operatorTheme(value: unknown): OperatorThemeLike | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as OperatorThemeLike;
}
