/**
 * extensions/ask-user-question/tool/ask-tool.ts — The canonical ask tool declaration.
 *
 * What each tool accepts (the TypeBox schema and its TypeScript mirror, kept
 * side by side so a schema edit cannot drift from the type the flow reads) and
 * how each is registered. The answering itself lives in `question-runner.ts`
 * and `rich-ask.ts`; redrawing an answered question lives in
 * `result-card.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../../_shared/host/pi-api.js";
import { validateParams } from "../../_shared/host/validation.js";
import { askRichQuestion } from "../interactive/rich-ask.js";
import type { OmpQuestion } from "../question/question-prompt.js";
import { askOmpCompatible } from "../interactive/question-runner.js";
import { renderAskResult } from "../question/result-card.js";

const OmpAskOption = Type.Object({
  label: Type.String({ description: "display label" }),
});

const OmpAskQuestion = Type.Object({
  id: Type.String({ description: "question id" }),
  question: Type.String({ description: "question text" }),
  options: Type.Array(OmpAskOption, { description: "available options" }),
  multi: Type.Optional(Type.Boolean({ description: "allow multiple selections" })),
  recommended: Type.Optional(Type.Number({ description: "recommended option index" })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 300000 })),
});

const OmpAskParams = Type.Object({
  questions: Type.Array(OmpAskQuestion, { minItems: 1, description: "questions to ask" }),
});

const RichAskParamsSchema = Type.Object({
  question: Type.String({ description: "The question to ask the user", maxLength: 500 }),
  kind: Type.Union(
    [Type.Literal("select"), Type.Literal("multi-select"), Type.Literal("text"), Type.Literal("editor")],
    { description: "UI control type" },
  ),
  options: Type.Optional(
    Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20, description: "Choices for select/multi-select" }),
  ),
  allowCustom: Type.Optional(Type.Boolean({ default: false, description: "Allow a custom answer" })),
  default: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  timeoutMs: Type.Optional(
    Type.Number({ default: 30000, minimum: 1000, maximum: 300000, description: "Auto-cancel after this many ms" }),
  ),
  sensitivity: Type.Optional(
    Type.Union([Type.Literal("public"), Type.Literal("internal"), Type.Literal("secret")], { default: "internal" }),
  ),
  reason: Type.Optional(Type.String({ description: "Why this question is being asked", maxLength: 500 })),
});

export type RichAskKind = "select" | "multi-select" | "text" | "editor";
export interface RichAskParams {
  question: string;
  kind: RichAskKind;
  options?: string[];
  allowCustom?: boolean;
  default?: string | string[];
  timeoutMs?: number;
  sensitivity?: "public" | "internal" | "secret";
  reason?: string;
}

export interface OmpAskParams {
  questions: OmpQuestion[];
}

const AskParams = Type.Union([OmpAskParams, RichAskParamsSchema]);

export function registerAskTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    description: "Ask the interactive user one or more option questions, or one rich select, text, or editor question.",
    parameters: AskParams,
    approval: "read",
    async execute(_toolCallId, params, signal, _update, ctx) {
      const valid = validateParams(AskParams, params);
      if (!valid.ok) return valid.result;
      return "questions" in valid.value
        ? askOmpCompatible(pi, valid.value as OmpAskParams, ctx, signal, "ask")
        : askRichQuestion(pi, valid.value as RichAskParams, ctx, signal);
    },
    renderResult: renderAskResult,
  });
}
