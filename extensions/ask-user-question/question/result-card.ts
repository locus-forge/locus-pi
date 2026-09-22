/**
 * extensions/ask-user-question/question/result-card.ts — The answered-question card.
 *
 * Redraws a finished ask in the transcript: one `Q:` line per question, every
 * option carrying a chosen/unchosen marker, and the custom answer collapsed
 * onto one line. Pure projection of a `ToolResult` — registering the tool that
 * produces it stays in `ask-tool.ts`.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ToolResult } from "../../_shared/host/pi-api.js";
import { singleLine } from "./prompt-text.js";
import type { QuestionResult } from "../interactive/question-runner.js";

const MARK_CHOSEN = "(o)";
const MARK_UNCHOSEN = "( )";

export function renderAskResult(result: ToolResult): Text {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const lines: string[] = [result.isError === true ? "[ERROR] Ask" : "[RESULT] Ask"];
  if (Array.isArray(details.results)) {
    for (const entry of details.results as QuestionResult[])
      lines.push(...renderAnsweredQuestion(entry, result.isError));
  } else if (
    typeof details.question === "string" &&
    (Array.isArray(details.options) || typeof details.customInput === "string")
  ) {
    lines.push(
      ...renderAnsweredQuestion(
        {
          id: typeof details.questionId === "string" ? details.questionId : "",
          question: details.question,
          options: Array.isArray(details.options) ? (details.options as string[]) : [],
          multi: Boolean(details.multi),
          selectedOptions: Array.isArray(details.selectedOptions) ? (details.selectedOptions as string[]) : [],
          ...(typeof details.customInput === "string" ? { customInput: details.customInput } : {}),
        },
        result.isError,
      ),
    );
  } else {
    return new Text([...lines, ...firstResultText(result).split(/\r?\n/)].join("\n"), 0, 0);
  }
  const renderedLines = lines.length > 1 ? lines : [...lines, ...firstResultText(result).split(/\r?\n/)];
  return new Text(renderedLines.join("\n"), 0, 0);
}

function renderAnsweredQuestion(result: QuestionResult, isError?: boolean): string[] {
  const chosen = new Set(result.selectedOptions);
  const lines = [`Q: ${result.question}`];
  for (const option of result.options) {
    lines.push(`  ${chosen.has(option) ? MARK_CHOSEN : MARK_UNCHOSEN} ${option}`);
  }
  if (result.customInput !== undefined) lines.push(`  ${MARK_CHOSEN} (custom) ${singleLine(result.customInput)}`);
  lines.push(isError ? "  -> cancelled" : "  -> answered");
  return lines;
}

function firstResultText(result: ToolResult): string {
  for (const part of result.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}
