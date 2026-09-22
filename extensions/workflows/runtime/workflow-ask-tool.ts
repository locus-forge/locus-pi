/**
 * extensions/workflows/runtime/workflow-ask-tool.ts — the live operator-question
 * tool a workflow child may call when its stage declared `ask: true`.
 *
 * Custom tools execute IN THE PARENT PROCESS: the closure below runs in the
 * session that spawned the child, so it can mount the shared operator-question
 * surface and hand the human's answer back as the tool result while the child
 * stays blocked on its pending call (owner decision, `.locus/soul.md` direction
 * log 2026-08-19). Three properties are load-bearing:
 *
 *  - FIFO, not supersede: the inline editor slot holds ONE interaction and a
 *    newer request evicts the current one, so concurrent asking children are
 *    serialized here, and a question evicted by the operator's own editor
 *    interaction is re-mounted instead of dropped.
 *  - Esc is an answer: "operator declined" travels back as ordinary text with
 *    any answers given before the refusal — the same contract the split-run
 *    handoff uses — never a hang, never a fabricated choice.
 *  - No UI is a CALL failure, not a string: when the parent cannot mount a
 *    question (`print`/`json`, no TUI), the tool fails the whole call through
 *    `failCall` with a named cause instead of returning an error sentence the
 *    model has been observed to talk past (the fabrication probe recorded in
 *    the 2026-07-22 direction entry). A timeout that auto-selects an option is
 *    equally out: this surface has no timeout at all.
 */

import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import type {
  ReadOnlyAgentCustomTool,
  ReadOnlyAgentToolResult,
} from "../../_shared/agent-runtime/agent-read-only-policy.js";
import { isStaleInlineOperatorInteractionError } from "../../_shared/operator/operator-interaction.js";
import {
  requestOperatorQuestion,
  type OperatorQuestionResult,
  type OperatorQuestionSpec,
} from "../../_shared/operator/operator-question.js";

export const WORKFLOW_ASK_TOOL_NAME = "workflow_ask";

const DEFAULT_REMOUNT_DELAY_MS = 250;

export const WORKFLOW_ASK_NO_UI_MESSAGE =
  "workflow_ask failed closed: the parent session cannot mount an operator question " +
  "(no interactive UI). Run the workflow interactively or remove `ask: true` from this stage.";

export const WORKFLOW_ASK_EVIDENCE_PERSISTENCE_PREFIX =
  "workflow_ask failed closed after the operator answered: durable answer evidence could not be persisted";

export type WorkflowAskFailureCause = "ask-unavailable" | "ask-evidence-persistence";

export interface WorkflowAskQuestion {
  id: string;
  question: string;
  options: Array<{ label: string }>;
  /** Index into `options` highlighted as recommended. Display only — never auto-chosen. */
  recommended?: number;
}

export interface WorkflowAskAnswerEntry {
  id: string;
  question: string;
  status: "answered" | "skipped" | "declined";
  answer?: string;
  kind?: "option" | "custom";
}

export interface WorkflowAskEvidenceRecord {
  tool: typeof WORKFLOW_ASK_TOOL_NAME;
  toolCallId: string;
  declined: boolean;
  entries: WorkflowAskAnswerEntry[];
}

export interface WorkflowAskToolDeps {
  ctx: ExtensionContext;
  /** Who is asking, in the operator's terms: workflow run, agent, stage. */
  contextText: string;
  /** The operator wait has begun. The call's deadline is wall clock and keeps
   *  running: one clock, and the bridge records how long the wait was. */
  onWaitStart: () => void;
  /** The wait is over (answered, declined, or failed). */
  onWaitEnd: () => void;
  /** Fail the whole child call before any answer can re-enter model context. */
  failCall: (message: string, cause: WorkflowAskFailureCause) => void;
  /** Durable record hook; the artifact store indexes the answer before readback. */
  recordEvidence: (record: WorkflowAskEvidenceRecord) => void;
  /** Test seams. Production callers leave these unset. */
  requestQuestion?: typeof requestOperatorQuestion;
  enqueue?: <T>(job: () => Promise<T>) => Promise<T>;
  remountDelayMs?: number;
}

/** JSON schema for the tool parameters. Mirrors the stock ask shape minus
 *  `timeoutMs` (a timeout that answers for the operator is a fabricated answer)
 *  and minus `multi` (the shared operator surface collects one choice or one
 *  custom string per question). */
const WORKFLOW_ASK_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      // No per-call maximum: the queue is served FIFO, one question at a time, and
      // the operator answers or declines each. A count is not a reason to refuse a
      // call the workflow already decided to make — the durable handoff contract
      // holds no such number either.
      description: "Questions for the human operator, asked one at a time.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "options"],
        properties: {
          id: { type: "string", description: "stable question id" },
          question: { type: "string", minLength: 1, description: "question text" },
          options: {
            type: "array",
            description: "selectable answers; empty means free-text only",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label"],
              properties: { label: { type: "string", minLength: 1, description: "display label" } },
            },
          },
          recommended: {
            type: "number",
            description: "index of the recommended option (display only, never auto-selected)",
          },
        },
      },
    },
  },
};

/** One FIFO for the whole host process: the inline editor slot holds a single
 *  interaction, so concurrent asking children wait here instead of evicting
 *  each other's questions. */
let liveAskQueueTail: Promise<unknown> = Promise.resolve();
function enqueueLiveAsk<T>(job: () => Promise<T>): Promise<T> {
  const next = liveAskQueueTail.then(job, job);
  liveAskQueueTail = next.catch(() => undefined);
  return next;
}

export function createWorkflowAskTool(deps: WorkflowAskToolDeps): ReadOnlyAgentCustomTool {
  return {
    name: WORKFLOW_ASK_TOOL_NAME,
    label: "Ask the operator",
    description:
      "Ask the human operator one or more clarifying questions and wait for the answers. " +
      "Each question offers options; the operator may pick one, type a custom answer, or " +
      "decline. Use only when the work genuinely cannot proceed without the operator's choice.",
    parameters: WORKFLOW_ASK_PARAMETERS,
    async execute(toolCallId, input, signal) {
      const parsed = parseWorkflowAskInput(input);
      if (!parsed.ok) return errorText(`Invalid ${WORKFLOW_ASK_TOOL_NAME} params: ${parsed.error}`);
      if (!parentCanMountQuestion(deps.ctx)) {
        deps.failCall(WORKFLOW_ASK_NO_UI_MESSAGE, "ask-unavailable");
        return errorText(WORKFLOW_ASK_NO_UI_MESSAGE);
      }
      deps.onWaitStart();
      try {
        return await (deps.enqueue ?? enqueueLiveAsk)(() => walkQuestions(deps, toolCallId, parsed.questions, signal));
      } finally {
        deps.onWaitEnd();
      }
    },
  };
}

function parentCanMountQuestion(ctx: ExtensionContext): boolean {
  return !(ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print");
}

type ParsedAskInput = { ok: true; questions: WorkflowAskQuestion[] } | { ok: false; error: string };

function parseWorkflowAskInput(input: unknown): ParsedAskInput {
  if (typeof input !== "object" || input === null) return { ok: false, error: "params must be an object" };
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { ok: false, error: "questions must be a non-empty array" };
  }
  const questions: WorkflowAskQuestion[] = [];
  for (const [index, raw] of rawQuestions.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `questions[${index}] must be an object` };
    const item = raw as { id?: unknown; question?: unknown; options?: unknown; recommended?: unknown };
    if (typeof item.question !== "string" || item.question.trim() === "") {
      return { ok: false, error: `questions[${index}].question must be a non-empty string` };
    }
    if (!Array.isArray(item.options)) return { ok: false, error: `questions[${index}].options must be an array` };
    const options: Array<{ label: string }> = [];
    for (const [optionIndex, rawOption] of item.options.entries()) {
      const label = (rawOption as { label?: unknown } | null)?.label;
      if (typeof label !== "string" || label.trim() === "") {
        return { ok: false, error: `questions[${index}].options[${optionIndex}].label must be a non-empty string` };
      }
      options.push({ label: label.trim() });
    }
    if (item.recommended !== undefined) {
      if (
        typeof item.recommended !== "number" ||
        !Number.isInteger(item.recommended) ||
        item.recommended < 0 ||
        item.recommended >= options.length
      ) {
        return { ok: false, error: `questions[${index}].recommended must index a declared option` };
      }
    }
    const id = typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : `q${index + 1}`;
    questions.push({
      id,
      question: item.question.trim(),
      options,
      ...(item.recommended !== undefined ? { recommended: item.recommended as number } : {}),
    });
  }
  return { ok: true, questions };
}

interface CollectedAnswer {
  kind: "option" | "custom";
  answer: string;
  label?: string;
}

async function walkQuestions(
  deps: WorkflowAskToolDeps,
  toolCallId: string,
  questions: WorkflowAskQuestion[],
  signal: AbortSignal,
): Promise<ReadOnlyAgentToolResult> {
  const requestQuestion = deps.requestQuestion ?? requestOperatorQuestion;
  const answers: Array<CollectedAnswer | undefined> = [];
  let declined = false;
  let index = 0;
  while (index < questions.length) {
    if (signal.aborted) return errorText(`${WORKFLOW_ASK_TOOL_NAME} aborted before the operator answered.`);
    const question = questions[index]!;
    const prior = answers[index];
    const spec: OperatorQuestionSpec = {
      question: question.question,
      subject: "Workflow question",
      contextText: deps.contextText,
      options: question.options.map((option, optionIndex) => ({
        label: option.label,
        ...(question.recommended === optionIndex ? { recommended: true } : {}),
      })),
      allowCustom: true,
      ...(questions.length > 1
        ? {
            progressText: `${index + 1}/${questions.length}`,
            navigation: { allowBack: index > 0, allowForward: index < questions.length - 1 },
          }
        : {}),
      ...(prior !== undefined ? { initialAnswer: { kind: prior.kind, answer: prior.answer } } : {}),
    };
    let result: OperatorQuestionResult;
    try {
      result = await requestQuestion(deps.ctx, spec, { signal });
    } catch (error) {
      if (isStaleInlineOperatorInteractionError(error)) {
        // Evicted by the operator's own editor interaction. The question is not
        // lost and not auto-answered: wait briefly and mount it again.
        await remountDelay(deps.remountDelayMs ?? DEFAULT_REMOUNT_DELAY_MS, signal);
        continue;
      }
      throw error;
    }
    if (result.status === "unavailable") {
      deps.failCall(WORKFLOW_ASK_NO_UI_MESSAGE, "ask-unavailable");
      return errorText(WORKFLOW_ASK_NO_UI_MESSAGE);
    }
    if (result.status === "cancelled") {
      declined = true;
      break;
    }
    if (result.status === "navigate") {
      index += result.direction === "back" ? -1 : 1;
      continue;
    }
    answers[index] = {
      kind: result.kind,
      answer: result.answer,
      ...(result.label !== undefined ? { label: result.label } : {}),
    };
    index += 1;
  }
  const entries = questions.map((question, questionIndex): WorkflowAskAnswerEntry => {
    const answer = answers[questionIndex];
    if (answer !== undefined) {
      return {
        id: question.id,
        question: question.question,
        status: "answered",
        answer: answer.answer,
        kind: answer.kind,
      };
    }
    return { id: question.id, question: question.question, status: declined ? "declined" : "skipped" };
  });
  const record: WorkflowAskEvidenceRecord = { tool: WORKFLOW_ASK_TOOL_NAME, toolCallId, declined, entries };
  try {
    deps.recordEvidence(record);
  } catch (error) {
    const message = `${WORKFLOW_ASK_EVIDENCE_PERSISTENCE_PREFIX}: ${errorMessage(error)}`;
    deps.failCall(message, "ask-evidence-persistence");
    return errorText(message);
  }
  return {
    content: [{ type: "text", text: renderReadback(entries, declined) }],
    details: { declined, entries },
  };
}

function renderReadback(entries: WorkflowAskAnswerEntry[], declined: boolean): string {
  const answered = entries.filter((entry) => entry.status === "answered").length;
  const lines = [
    `Operator answered ${answered} of ${entries.length} question(s).${declined ? " The operator DECLINED the rest." : ""}`,
  ];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.question}`);
    lines.push(
      entry.status === "answered"
        ? `   Answer: ${entry.answer ?? ""}`
        : `   (${entry.status === "declined" ? "declined by operator" : "skipped"})`,
    );
  });
  if (declined) {
    lines.push(
      "Treat declined questions as unanswered: proceed with explicit assumptions or narrow the work. " +
        "Do not invent the operator's answer.",
    );
  }
  return lines.join("\n");
}

function errorText(text: string): ReadOnlyAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function remountDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
