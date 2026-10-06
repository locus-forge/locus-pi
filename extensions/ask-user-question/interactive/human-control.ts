/**
 * The only ask outcome writer. Collection has no persistence side effects;
 * this boundary applies sensitivity and provenance before either journal or
 * any public result/event receives an answer.
 */
import type { ExtensionAPI, ExtensionContext, ToolResult } from "../../_shared/host/pi-api.js";
import { errorResult, textResult } from "../../_shared/host/pi-api.js";
import { redactForSensitivity } from "../../_shared/host/redaction.js";
import { emitDevEvent } from "../../_shared/runtime/event-bus.js";
import type { RichAskParams } from "../tool/ask-tool.js";

import { getProjectRoot, getSessionId, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import {
  createSessionStore,
  selectSessionStoreBackend,
  type SessionStoreBackend,
} from "../../_shared/runtime/runtime-capabilities.js";

export interface QuestionOutcome {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
  status: "answered" | "timed-out" | "cancelled";
}

export interface QuestionResult extends QuestionOutcome {
  timedOut: boolean;
  answerSource: "human" | "automatic" | "none";
}

export async function finalizeQuestionOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  outcomes: QuestionOutcome[],
  source: string,
  rich?: RichAskParams,
): Promise<ToolResult> {
  const results: QuestionResult[] = [];
  const decisions = [];
  for (const outcome of outcomes) {
    const timedOut = outcome.status === "timed-out";
    // Rich timeout promises auto-cancel. Legacy OMP keeps its automatic choice,
    // but neither its text nor its durable status can claim a human answer.
    const answerSource = outcome.status === "answered" ? "human" : timedOut && !rich ? "automatic" : "none";
    const value = richValue(outcome, rich);
    const optionQuestion = !rich || rich.kind === "select" || rich.kind === "multi-select";
    const collectedAnswer = optionQuestion
      ? {
          selectedOptions: outcome.selectedOptions,
          ...(outcome.customInput !== undefined ? { customInput: outcome.customInput } : {}),
        }
      : value;
    const answer =
      answerSource === "none"
        ? undefined
        : rich?.sensitivity === "secret"
          ? "[REDACTED:secret-answer]"
          : collectedAnswer;
    const metadata = {
      ...(optionQuestion ? { multi: outcome.multi } : {}),
      ...(rich ? { kind: rich.kind, sensitivity: rich.sensitivity ?? "internal" } : {}),
      timedOut,
      answerSource,
    };
    const decision = await recordDecision(pi, ctx, {
      decisionId: stableDecisionId(source, outcome.id),
      question: outcome.question,
      ...(answer === undefined ? {} : { answer }),
      status: outcome.status,
      source,
      metadata,
    });
    emitDevEvent(`ask:${outcome.status}`, { ...metadata, cancelled: answerSource === "none" });
    if (rich) {
      const visibleValue = Array.isArray(value)
        ? value.map((item) => redactForSensitivity(item, rich.sensitivity).text)
        : redactForSensitivity(value, rich.sensitivity).text;
      const details = {
        questionId: outcome.id,
        kind: rich.kind,
        value: rich.sensitivity === "secret" || answerSource === "none" ? undefined : value,
        visibleValue: answerSource === "none" ? undefined : visibleValue,
        status: outcome.status,
        answerSource,
        cancelled: answerSource === "none",
        timedOut,
        decision,
        sensitivity: rich.sensitivity ?? "internal",
      };
      if (outcome.status === "cancelled" && (rich.kind === "select" || rich.kind === "multi-select")) {
        return errorResult("Ask tool was cancelled by the user", { ...details, question: outcome.id });
      }
      return textResult(
        timedOut
          ? "Question timed out; no answer was submitted."
          : outcome.status === "cancelled"
            ? "Question cancelled"
            : `Answer: ${Array.isArray(visibleValue) ? visibleValue.join(", ") : visibleValue}`,
        details,
      );
    }
    if (outcome.status === "cancelled") {
      return errorResult("Ask tool was cancelled by the user", {
        question: outcome.id,
        status: outcome.status,
        timedOut,
        answerSource,
        decision,
      });
    }
    results.push({ ...outcome, timedOut, answerSource });
    decisions.push(decision);
  }
  if (results.length === 1) {
    const { id: _id, ...result } = results[0]!;
    return textResult(formatSingleAnswer(results[0]!), { ...result, decision: decisions[0] });
  }
  const title = results.some((result) => result.timedOut) ? "Question outcomes:" : "User answers:";
  return textResult(`${title}\n${results.map(formatQuestionLine).join("\n")}`, { results, decisions });
}

function richValue(outcome: QuestionOutcome, rich: RichAskParams | undefined): string | string[] {
  if (rich?.kind === "multi-select") {
    return outcome.customInput === undefined ? outcome.selectedOptions : [outcome.customInput];
  }
  return outcome.customInput ?? outcome.selectedOptions[0] ?? "";
}

function formatSingleAnswer(result: QuestionResult): string {
  const lines: string[] = [];
  if (result.timedOut)
    lines.push("Question timed out; the following answer was completed automatically, not submitted by the user.");
  if (result.selectedOptions.length > 0) {
    lines.push(`${result.timedOut ? "Automatic selection" : "User selected"}: ${result.selectedOptions.join(", ")}`);
  }
  if (result.customInput !== undefined) {
    const label = result.timedOut ? "Automatic custom input" : "User provided custom input";
    lines.push(
      result.customInput.includes("\n")
        ? `${label}:\n${result.customInput
            .split(/\r?\n/)
            .map((line) => `  ${line}`)
            .join("\n")}`
        : `${label}: ${result.customInput}`,
    );
  }
  return lines.join("\n") || "User answered with no selection.";
}

function formatQuestionLine(result: QuestionResult): string {
  const answer =
    result.customInput !== undefined
      ? `"${result.customInput}"`
      : result.selectedOptions.length > 0
        ? result.multi
          ? `[${result.selectedOptions.join(", ")}]`
          : result.selectedOptions[0]
        : "(cancelled)";
  return `${result.id}: ${result.timedOut ? "(timed out; automatic) " : ""}${answer}`;
}

interface HumanDecisionInput {
  decisionId?: string;
  question?: string;
  answer?: unknown;
  status: "answered" | "timed-out" | "cancelled" | "deferred";
  source: string;
  metadata?: Record<string, unknown>;
}

interface HumanDecisionRecord {
  decisionId: string;
  backend: SessionStoreBackend;
  diagnostics: string[];
}

async function recordDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: HumanDecisionInput,
): Promise<HumanDecisionRecord> {
  const decisionId = input.decisionId ?? stableDecisionId(input.source, input.question ?? input.status);
  const metadata = {
    source: input.source,
    ...(input.metadata ?? {}),
  };
  const payload: {
    decisionId: string;
    question?: string;
    answer?: unknown;
    status: "answered" | "timed-out" | "cancelled" | "deferred";
    metadata: Record<string, unknown>;
  } = {
    decisionId,
    status: input.status,
    metadata,
  };
  if (input.question !== undefined) payload.question = input.question;
  if (input.answer !== undefined) payload.answer = input.answer;
  const backend = selectSessionStoreBackend();
  const diagnostics: string[] = [];
  if (backend === "jsonl") {
    const store = createSessionStore({ projectRoot: getProjectRoot(ctx), backend: "jsonl" });
    const sessionId = ensureRuntimeSession(store, ctx);
    store.appendEntry(sessionId, { type: "decision", payload });
    if ("diagnostics" in store) diagnostics.push(...store.diagnostics);
  }
  await pi.appendEntry("decision", payload);
  return { decisionId, backend, diagnostics };
}

function stableDecisionId(source: string, seed: string): string {
  return (
    `${source}-${seed}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "decision"
  );
}

function ensureRuntimeSession(store: ReturnType<typeof createSessionStore>, ctx: ExtensionContext): string {
  const sessionId = getSessionId(ctx);
  if (store.getSession(sessionId) === undefined) {
    store.createSession({
      id: sessionId,
      projectRoot: getProjectRoot(ctx),
      workingDirectory: getWorkingDirectory(ctx),
    });
  }
  return sessionId;
}
