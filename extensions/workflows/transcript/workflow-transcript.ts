import path from "node:path";
import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { formatDuration } from "../../_shared/agent-runtime/agent-live-panel.js";
import type { RunWorkflowScriptResult } from "../runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import { formatWorkflowFailureDiagnosticLines } from "../runtime/workflow-failure.js";
import {
  projectWorkflowDisposition,
  workflowResultFile,
  type WorkflowDispositionProjection,
} from "../runtime/workflow-result.js";
import { workflowJournalFile } from "../runtime/workflow-run-layout.js";
import { notifyOperator } from "../../_shared/operator/operator-notify.js";
import { type WorkflowTranscriptAnnouncement, type WorkflowTranscriptCompletion } from "../command/receipts.js";
import { workflowCompletionPresentation } from "../command/completion-presentation.js";

export { registerWorkflowTranscriptRenderers } from "../command/completion-presentation.js";

/**
 * One custom message type carries both bounded run-boundary records. The name
 * says what the block is (one workflow run) instead of when it was emitted;
 * `details.eventKind` separates the opening banner from the closing digest.
 * Exact terminal prose uses a second type so it is visibly separate and may be
 * unbounded without weakening the digest contract.
 */
const TRANSCRIPT_AGENT_ROW_LIMIT = 20;
const TRANSCRIPT_LINE_MAX_CHARS = 160;
const TRANSCRIPT_ANSWER_MAX_CHARS = 96;

export type WorkflowTranscriptSurfaceMode = "command" | "tool";

export interface WorkflowTranscriptOptions {
  /** Semantic run input. On a continuation run this is the operator's answer. */
  input?: string;
}

export interface WorkflowTranscript {
  /** Returns the run-boundary banner for surfaces that can publish one. */
  start(runId: string, runDir: string): WorkflowTranscriptAnnouncement | undefined;
  event(line: WorkflowJournalLine): void;
  finish(res: RunWorkflowScriptResult): WorkflowTranscriptCompletion;
  /** Terminal fallback when the runner rejects after publishing a run identity. */
  fail(error: unknown, runId: string, runDir: string): WorkflowTranscriptCompletion;
}

interface PendingAgentRow {
  index: number;
  agent: string;
  label: string;
  replayed: boolean;
}

/**
 * Buffer lifecycle safely for the current Pi surface. Neither command nor tool
 * mode sends messages from inside the run loop. Tool mode returns the digest in
 * its native result; command mode publishes an idle-checked start banner and,
 * after the run settles, one post-idle digest.
 *
 * Each agent occupies one row for the whole run: the row is written when the
 * agent starts and rewritten in place when it ends. An agent whose end never
 * arrives keeps an explicit evidence-missing row and is never silently folded
 * into a success.
 */
export function createWorkflowTranscript(
  ctx: ExtensionContext,
  targetLabel: string,
  surface: WorkflowTranscriptSurfaceMode,
  options: WorkflowTranscriptOptions = {},
): WorkflowTranscript {
  const safeTarget = safeTranscriptTarget(targetLabel);
  let startedAt: number | undefined;
  let announced = false;
  let agentRowCount = 0;
  let currentPhase: string | undefined;
  let replaySourceRunId: string | undefined;
  let lastJournalError: string | undefined;
  let completion: WorkflowTranscriptCompletion | undefined;
  const bodyLines: string[] = [];
  const pendingAgents = new Map<string, PendingAgentRow>();
  const pushLine = (content: string): number => {
    bodyLines.push(compactTranscriptText(content));
    return bodyLines.length - 1;
  };
  return {
    start(id, runDir) {
      if (announced) return undefined;
      announced = true;
      startedAt = Date.now();
      return {
        eventKind: "workflow_start",
        runId: id,
        runDir,
        journalPath: workflowJournalFile(runDir),
        resultPath: workflowResultFile(runDir),
        text: [
          workflowRunHeader(safeTarget, id, "started", startedAt),
          "● workflow started · live progress in the panel below · /ps opens the agent fleet",
          `runDir: ${runDir}`,
        ].join("\n"),
      };
    },
    event(line) {
      // The runtime states the replay source once, on its own resume log line.
      // Capturing it here is what lets every replayed row name its source run
      // instead of the anonymous "a recorded run" the digest used to print.
      if (line.resumeFromRunId !== undefined && line.resumeFromRunId !== "") replaySourceRunId = line.resumeFromRunId;
      if (line.kind === "phase" && line.groupId === undefined) {
        const phase = (line.phase ?? "").trim();
        if (phase !== "") currentPhase = compactTranscriptText(phase);
        return;
      }
      if (line.kind === "agent_start" || line.kind === "agent_end") {
        recordAgentRow(line);
        if (surface === "command") {
          for (const warning of line.evidenceWarnings ?? []) {
            if (warning.trim() !== "")
              notifyOperator(ctx, `⚠ agent evidence · ${compactTranscriptText(warning)}`, "warning");
          }
        }
      } else if (line.kind === "error") {
        // Journal errors may be intermediate or duplicated by the final result.
        // Retain only the latest bounded text as fallback for one final
        // workflow_end record.
        lastJournalError = compactTranscriptText(line.message ?? "unknown error");
      }
    },
    finish(res) {
      if (completion !== undefined) return completion;
      if (!announced) this.start(res.runId, res.runDir);
      const elapsed = startedAt === undefined ? "" : formatDuration(Math.max(0, Date.now() - startedAt));
      const agentCount = res.journal.filter((line) => line.kind === "agent_end").length;
      // This digest is the one workflow surface that enters LLM context, so a
      // replayed run has to declare itself here too — otherwise the model reads
      // recorded evidence as if the work had just been done.
      const replayedCount = res.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
      // An agent that started and never ended must not disappear into a green
      // run: its row states outright that the evidence is missing.
      for (const [, pending] of pendingAgents) {
        bodyLines[pending.index] = compactTranscriptText(
          `■ agent ${pending.agent} started${
            pending.label !== "" ? ` — ${pending.label}` : ""
          } — no end recorded (evidence missing)`,
        );
      }
      pendingAgents.clear();
      const disposition = projectWorkflowDisposition(
        {
          ok: res.ok,
          result: res.result,
          ...(res.error !== undefined ? { error: res.error } : {}),
          ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
        },
        lastJournalError,
      );
      // A failed run reused recorded evidence just as much as a successful one,
      // and a model reading only the last line must not have to infer it from
      // the per-agent markers above — which the row cap can drop.
      const replayedPart =
        replayedCount > 0 ? [`${replayedCount} replayed from ${replaySourceLabel(res.resumeFromRunId)}`] : [];
      // The terminal marker already says "awaiting operator"; the shared summary
      // repeats it for surfaces that have no marker. Saying it twice in one line
      // is exactly the duplication this digest exists to remove.
      const summary = disposition.summary.startsWith("awaiting operator · ")
        ? disposition.summary.slice("awaiting operator · ".length)
        : disposition.summary;
      const hasExactResultText = typeof res.result === "string" && res.result.trim() !== "";
      const parts = [
        formatWorkflowTerminalLifecycle(safeTarget, disposition),
        ...(!hasExactResultText || disposition.status !== "completed" ? [compactTranscriptText(summary)] : []),
        ...((disposition.status === "completed" || disposition.status === "awaiting_operator") && agentCount > 0
          ? [`${agentCount} agent${agentCount === 1 ? "" : "s"}`]
          : []),
        ...replayedPart,
      ];
      if (disposition.status === "awaiting_operator") {
        bodyLines.push(...formatOperatorWaitBlock(res, currentPhase));
      }
      pushLine([...parts, ...(elapsed !== "" ? [elapsed] : [])].join(" · "));
      // A failed run leaves the transcript with the actionable diagnostic: where
      // it broke, which evidence proves it, and one copyable repair request. These
      // lines skip the 160-char compaction — a truncated path or repair request
      // would be unusable, and the diagnostic is already bounded at its source.
      // The summary above is capped at 160 characters because this digest enters
      // model context. A run whose result is prose therefore has to say where the
      // unabridged text is, and which command shows it — otherwise the operator
      // is left with a sentence fragment and no way forward. A failed run that
      // still produced text needs it just as much as a clean one.
      // Failures remain visible even when the script captured them and returned success.
      // Keep paths exact; the index carries the complete inventory beyond this display bound.
      const failures = res.journal.filter(
        (line) =>
          (line.kind === "error" && (line.callId !== undefined || line.message !== res.error)) ||
          (line.kind === "agent_end" && ["failed", "blocked", "cancelled"].includes(line.status ?? "")),
      );
      if (failures.length > 0) {
        bodyLines.push(`Execution failures (${failures.length}; workflow outcome is shown separately)`);
        for (const failure of failures.slice(-5)) {
          bodyLines.push(...formatWorkflowExecutionFailure(failure, workflowJournalFile(res.runDir)));
        }
        if (failures.length > 5) bodyLines.push("Earlier failures: open the project error index or run journal.");
      }
      const fileLines: string[] = [];
      const commandLines: string[] = [];
      if (res.primaryFile?.absolutePath !== undefined && res.primaryFile.absolutePath !== "") {
        fileLines.push(firstTranscriptLine(`primary file: ${res.primaryFile.absolutePath}`));
      }
      if (res.workspaceDir !== undefined && res.workspaceDir !== "") {
        fileLines.push(firstTranscriptLine(`workspace: ${res.workspaceDir}`));
      }
      if (res.resultTextPath !== undefined && res.resultTextPath !== "") {
        fileLines.push(firstTranscriptLine(`full result: ${res.resultTextPath}`));
        commandLines.push(firstTranscriptLine(`read full result: /workflows result ${shortWorkflowRunId(res.runId)}`));
      } else if (disposition.status !== "completed") {
        // A run that ended badly and produced NO prose result — a script that
        // returned a structured `{ok:false}` is the common case — used to leave
        // the operator with a 160-character sentence fragment and a journal path.
        // The reason it failed is in the structured result, so this names the one
        // command that prints it. `/workflows result` deliberately refuses a
        // non-prose result, so pointing there would send them to a dead end.
        commandLines.push(firstTranscriptLine(`read full reason: /workflows status ${shortWorkflowRunId(res.runId)}`));
      }
      const transcriptDirectory = workflowAgentTranscriptDirectory(res.journal);
      if (transcriptDirectory !== undefined) {
        fileLines.push(firstTranscriptLine(`agent transcripts: ${transcriptDirectory}`));
      }
      const presentation = workflowCompletionPresentation(res, safeTarget);
      if (presentation.generatedRunCommand !== undefined) {
        commandLines.push(`run generated script: ${presentation.generatedRunCommand}`);
      }
      if (res.runDir !== undefined && res.runDir !== "") {
        fileLines.push(firstTranscriptLine(`journal: ${workflowJournalFile(res.runDir)}`));
      }
      appendTranscriptGroup(bodyLines, "Files", fileLines);
      appendTranscriptGroup(bodyLines, "Commands", commandLines);
      if (res.failureDiagnostic !== undefined) {
        bodyLines.push("Failure");
        for (const line of formatWorkflowFailureDiagnosticLines(res.failureDiagnostic, { repairRequest: true })) {
          bodyLines.push(firstTranscriptLine(line));
        }
      }
      const headerLines = [
        workflowRunHeader(safeTarget, res.runId, terminalStamp(disposition.status), Date.now()),
        ...formatContinuationLine(res, options.input),
      ];
      completion = {
        eventKind: "workflow_end",
        runId: res.runId,
        workflowStatus: disposition.status,
        runDir: res.runDir,
        journalPath: workflowJournalFile(res.runDir),
        resultPath: workflowResultFile(res.runDir),
        resultPersisted: res.resultPersistence.ok,
        digest: [...headerLines, ...bodyLines].join("\n"),
        lineCount: bodyLines.length,
        ...(typeof res.result === "string" && res.result.trim() !== "" ? { resultText: res.result } : {}),
        ...(res.resultTextPath !== undefined ? { resultTextPath: res.resultTextPath } : {}),
        ...(res.primaryFile?.absolutePath !== undefined ? { primaryFilePath: res.primaryFile.absolutePath } : {}),
        ...(presentation.nextAction === undefined ? {} : { nextAction: presentation.nextAction }),
      };
      return completion;
    },
    fail(error, runId, runDir) {
      if (completion !== undefined) return completion;
      if (!announced) this.start(runId, runDir);
      const message = compactTranscriptText(error instanceof Error ? error.message : String(error));
      const lines = [
        workflowRunHeader(safeTarget, runId, "failed", Date.now()),
        `✗ workflow ${safeTarget} failed · ${message}`,
        `journal: ${workflowJournalFile(runDir)}`,
      ];
      completion = {
        eventKind: "workflow_end",
        runId,
        workflowStatus: "failed",
        runDir,
        journalPath: workflowJournalFile(runDir),
        resultPath: workflowResultFile(runDir),
        resultPersisted: false,
        digest: lines.join("\n"),
        lineCount: lines.length - 1,
      };
      return completion;
    },
  };

  function recordAgentRow(line: WorkflowJournalLine): void {
    const key = agentRowKey(line);
    const agent = compactTranscriptText(line.agent ?? "sub-agent");
    const label = line.label === undefined ? "" : compactTranscriptText(line.label);
    const replayed = line.replayed === true;
    if (line.kind === "agent_start") {
      if (agentRowCount >= TRANSCRIPT_AGENT_ROW_LIMIT) return;
      agentRowCount += 1;
      const index = pushLine(formatWorkflowAgentLifecycle(line, replaySourceRunId));
      pendingAgents.set(key, { index, agent, label, replayed });
      return;
    }
    const pending = pendingAgents.get(key);
    if (pending !== undefined) {
      // One row per agent: the started row becomes the finished row in place, so
      // the reader never meets the same agent twice.
      bodyLines[pending.index] = compactTranscriptText(formatWorkflowAgentLifecycle(line, replaySourceRunId));
      pendingAgents.delete(key);
      return;
    }
    if (agentRowCount >= TRANSCRIPT_AGENT_ROW_LIMIT) return;
    agentRowCount += 1;
    pushLine(formatWorkflowAgentLifecycle(line, replaySourceRunId));
  }
}

function appendTranscriptGroup(lines: string[], title: string, entries: readonly string[]): void {
  if (entries.length === 0) return;
  lines.push(title, ...entries);
}

/**
 * Stable identity for one concrete agent attempt. `callId` is runtime-owned and
 * unique per attempt; the fallback keeps a loop's rounds in separate rows rather
 * than collapsing a retry onto its predecessor.
 */
function agentRowKey(line: WorkflowJournalLine): string {
  if (line.callId !== undefined && line.callId !== "") return `call:${line.callId}`;
  return `slot:${line.agent ?? ""}|${line.label ?? ""}|${line.slotKey ?? ""}|${line.round ?? ""}`;
}

function replaySourceLabel(resumeFromRunId: string | undefined): string {
  if (resumeFromRunId === undefined || resumeFromRunId === "") return "a recorded run";
  return `run #${shortWorkflowRunId(resumeFromRunId)}`;
}

/**
 * Semantic run identity persisted in session/model context. The custom renderer
 * turns this line into a width-aware rule; non-TUI readers retain complete plain
 * text without presentation bytes tied to one terminal width.
 */
function workflowRunHeader(target: string, runId: string, stamp: string, at: number): string {
  return `workflow ${target} · run #${shortWorkflowRunId(runId)} · ${stamp} ${clockStamp(at)}`;
}

function terminalStamp(status: WorkflowDispositionProjection["status"]): string {
  switch (status) {
    case "completed":
      return "finished";
    case "awaiting_operator":
      return "paused";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "ended";
  }
}

function clockStamp(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function shortWorkflowRunId(runId: string): string {
  const compact = runId.replace(/[^a-zA-Z0-9]/gu, "");
  if (compact === "") return runId;
  return compact.slice(-4);
}

/**
 * A continuation run is legible on its own: it names the run it continues and
 * the answer that unblocked it. The questions stay in the source run's block,
 * which is directly above this one in the same scrollback.
 */
function formatContinuationLine(res: RunWorkflowScriptResult, input: string | undefined): string[] {
  const originRunId = res.continuation?.originRunId;
  if (originRunId === undefined || originRunId === "") return [];
  const answer = (input ?? "").trim();
  const answerPart = answer === "" ? "" : ` · operator answered: "${compactTranscriptText(truncateAnswer(answer))}"`;
  return [firstTranscriptLine(`↳ continues run #${shortWorkflowRunId(originRunId)}${answerPart}`)];
}

function truncateAnswer(value: string): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length <= TRANSCRIPT_ANSWER_MAX_CHARS ? line : `${line.slice(0, TRANSCRIPT_ANSWER_MAX_CHARS - 3)}...`;
}

/**
 * The moment a human is blocking the run gets its own block: blank lines, an
 * indent, and the vocabulary's only upper-case phrase. This surface has no
 * colour, so weight has to come from structure.
 *
 * Attribution is what the envelope actually records. It carries no asking-agent
 * field, so the block names the stage that was current at the gate and the tool
 * that opened it, and never guesses an agent from adjacency.
 */
function formatOperatorWaitBlock(res: RunWorkflowScriptResult, currentPhase: string | undefined): string[] {
  const handoff = res.operatorHandoff;
  if (handoff === undefined) return [];
  const lines = ["", `◐ WAITING FOR OPERATOR — ${compactTranscriptText(handoff.title)}`];
  const context = [
    ...(currentPhase !== undefined ? [`asked during stage "${currentPhase}"`] : []),
    "via awaitOperator",
  ];
  lines.push(`   ${context.join(" · ")}`);
  for (const [index, question] of handoff.questions.entries()) {
    lines.push(`   Q${index + 1}: ${compactTranscriptText(question.prompt)}`);
  }
  lines.push(`   answer: pending — reply in Pi to continue (handoff #${shortWorkflowRunId(handoff.originRunId)})`);
  lines.push("");
  return lines;
}

function formatWorkflowTerminalLifecycle(target: string, disposition: WorkflowDispositionProjection): string {
  switch (disposition.status) {
    case "completed":
      return `✓ workflow ${target} finished`;
    case "awaiting_operator":
      return `◐ workflow ${target} awaiting operator`;
    case "cancelled":
      return `⊘ workflow ${target} cancelled`;
    case "failed":
      return `✗ workflow ${target} failed`;
    case "unknown":
      return `■ workflow ${target} ended (unknown disposition)`;
    default:
      return assertNever(disposition.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow disposition status: ${String(value)}`);
}

/**
 * Workflow journal identity stays stable when the visible fleet collapses a
 * parent row in favour of its SDK child. Petnames belong to that live row only;
 * the durable digest uses catalog agent + label and cannot invent a second name.
 *
 * Replayed work carries its own marker rather than a success glyph plus a
 * suffix: a reader scanning the left column must not read recorded evidence as
 * work this run performed.
 */
function formatWorkflowAgentLifecycle(line: WorkflowJournalLine, replaySourceRunId?: string): string {
  const agent = compactTranscriptText(line.agent ?? "sub-agent");
  const displayName = line.displayName === undefined ? "" : compactTranscriptText(line.displayName);
  const identity =
    displayName !== "" && displayName.toLocaleLowerCase() !== agent.toLocaleLowerCase()
      ? `${agent} (${displayName})`
      : agent;
  const label = line.label === undefined ? "" : compactTranscriptText(line.label);
  const labelPart = label !== "" ? ` — ${label}` : "";
  const replayed = line.replayed === true;
  const replayedFrom = replayed ? ` from ${replaySourceLabel(line.resumeFromRunId ?? replaySourceRunId)}` : "";
  if (line.kind === "agent_start") {
    return `● agent ${identity} started${replayed ? " (replay)" : ""}${labelPart}`;
  }
  const elapsed = formatDuration(line.durationMs);
  const elapsedPart = elapsed !== "" ? ` · ${elapsed}` : "";
  if (replayed) {
    return `↻ agent ${identity} replayed${replayedFrom}${elapsedPart}${labelPart}`;
  }
  const status = line.status ?? "unknown";
  const lifecycle =
    status === "completed"
      ? { marker: "✓", verb: "finished" }
      : status === "cancelled"
        ? { marker: "⊘", verb: "cancelled" }
        : status === "failed" || status === "blocked"
          ? { marker: "✗", verb: status === "blocked" ? "blocked" : "failed" }
          : { marker: "■", verb: `ended (${compactTranscriptText(status)})` };
  return `${lifecycle.marker} agent ${identity} ${lifecycle.verb}${elapsedPart}${labelPart}`;
}

function workflowAgentTranscriptDirectory(journal: readonly WorkflowJournalLine[]): string | undefined {
  const roots = journal
    .map((line) => line.childTrace?.path)
    .filter((tracePath): tracePath is string => tracePath !== undefined && tracePath !== "")
    .map((tracePath) => path.dirname(path.dirname(tracePath)));
  if (roots.length === 0) return undefined;
  return roots.every((root) => root === roots[0]) ? roots[0] : undefined;
}

/** Main status omits agent transport markers already represented by the fleet. */
export function renderMainWorkflowStatus(line: WorkflowJournalLine): string | undefined {
  if (line.kind === "phase") return line.groupId === undefined ? `[phase] ${line.phase ?? ""}` : undefined;
  if (line.kind === "agent_start" || line.kind === "agent_queued") return undefined;
  if (line.kind === "agent_end") {
    const warnings = line.evidenceWarnings?.filter((warning) => warning.trim() !== "") ?? [];
    if (warnings.length > 0) return `warning: ${warnings.join("; ")}`;
    if (line.status !== undefined && line.status !== "completed") return formatWorkflowExecutionFailure(line)[0];
    return undefined;
  }
  if (line.kind === "log") {
    if (line.choiceDecision !== undefined) {
      const decision = line.choiceDecision;
      return `[decision ${line.label ?? "agent"}] ${decision.value} (${decision.source}, ${decision.returnVia}${decision.attempts === undefined ? "" : `, ${decision.attempts} attempt(s)`})`;
    }
    const label = line.source === "script" ? "script" : line.source === "runtime" ? "runtime" : "journal";
    return `[${label}] ${line.message ?? ""}`;
  }
  if (line.kind === "error") return `[error] ${line.message ?? ""}`;
  return `[${line.kind}]`;
}

function safeTranscriptTarget(value: string): string {
  if (path.isAbsolute(value)) return path.basename(value);
  if (path.win32.isAbsolute(value)) return path.win32.basename(value);
  return compactTranscriptText(value);
}

function compactTranscriptText(value: string): string {
  const line = firstTranscriptLine(value);
  return line.length <= TRANSCRIPT_LINE_MAX_CHARS ? line : `${line.slice(0, TRANSCRIPT_LINE_MAX_CHARS - 3)}...`;
}

function firstTranscriptLine(value: string): string {
  return (value.split(/\r?\n/u, 1)[0] ?? "").trim();
}

/** Identity comes from this attempt, never the most recent sibling or an inferred stage. */
function formatWorkflowExecutionFailure(line: WorkflowJournalLine, journalPath?: string): string[] {
  const identity = [
    line.displayName ?? line.agent ?? "(agent unknown)",
    line.label,
    line.phase,
    line.callId,
    line.attempt === undefined ? undefined : `attempt ${line.attempt}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `✗ ${identity}: ${line.failureCause ?? line.status ?? "error"} — ${compactTranscriptText(line.message ?? "No failure message recorded")}`,
    ...(line.journalWarning !== undefined
      ? [line.journalWarning]
      : journalPath === undefined
        ? []
        : [`details: ${journalPath}`]),
    ...(line.resultArtifact === undefined ? [] : [`child result: ${line.resultArtifact}`]),
    ...(line.errorLogPath === undefined
      ? []
      : [`errors: ${line.errorLogPath}${line.errorId === undefined ? "" : ` (id ${line.errorId})`}`]),
    ...(line.errorLogWarning === undefined ? [] : [line.errorLogWarning]),
  ];
}
