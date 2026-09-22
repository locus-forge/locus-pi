/**
 * workflow-failure.ts — Operator-actionable diagnostics for one failed run.
 *
 * A failed run used to surface only the raw thrown sentence (`review inventory
 * has no C<n> coverage headings`), which reads as "the workflow is broken"
 * without saying which stage rejected what, which script owns that contract, or
 * where the evidence sits on disk. This module owns the single projection every
 * failure surface renders — live widget, tool result, operator block, and the
 * persisted `result.json` — plus one copyable repair request an operator can
 * paste into a coding agent verbatim.
 *
 * It states only what the run proved: an absent stage, script, or answer
 * artifact is omitted instead of guessed.
 */

import path from "node:path";
import { workflowRunArtifactsDir } from "./workflow-run-layout.js";
import type { WorkflowJournalLine } from "./workflow-runtime.js";

/** Who failed: trusted script contract vs. the runtime/host around it. */
export type WorkflowFailureOrigin = "script" | "runtime";

export interface WorkflowFailureDiagnostic {
  errorLogPath?: string;
  errorLogWarning?: string;
  origin: WorkflowFailureOrigin;
  /** Compacted failure sentence — the thrown message, never a guess. */
  message: string;
  /** Last `phase()` the run reached before failing, when it declared one. */
  stage?: string;
  /** Workflow the operator asked for (`review`, `./x.workflow.mjs`). */
  workflow?: string;
  /** Author-owned script path; project-relative when it lives inside the root. */
  scriptPath?: string;
  /** Evidence for this failure, when the run persisted an answer, result, or transcript. */
  evidencePath?: string;
  /** Always present: the run's own journal is written before anything can fail. */
  journalPath: string;
  /** One-line request an operator can copy into a coding agent unchanged. */
  repairRequest: string;
}

export interface BuildWorkflowFailureDiagnosticInput {
  errorLogPath?: string;
  errorLogWarning?: string;
  projectRoot: string;
  runDir: string;
  /** The run's journal file, owned by the runtime layout (never guessed here). */
  journalPath: string;
  journal: readonly WorkflowJournalLine[];
  origin?: WorkflowFailureOrigin;
  error?: string;
  target?: { ref?: string };
  scriptIdentity?: { sourcePath?: string };
  /** Typed child result from WorkflowAgentExecutionError, when one caused the throw. */
  failedChild?: {
    childTrace?: { path: string };
    resultArtifact?: string;
  };
  /** A group error has no exact typed link to the child that caused its branch failure. */
  unhandledGroupFailure?: true;
  artifacts?: readonly { kind: string; stage?: string; relativePath: string; callId?: string }[];
}

const MAX_DIAGNOSTIC_MESSAGE_CHARS = 240;
const MAX_REPAIR_REQUEST_CHARS = 1000;

/**
 * Project one failed run into its actionable diagnostic. Called from the
 * runner's single terminal path, so every failure route gets the same shape.
 */
export function buildWorkflowFailureDiagnostic(input: BuildWorkflowFailureDiagnosticInput): WorkflowFailureDiagnostic {
  const origin = input.origin ?? "runtime";
  const message = compactMessage(input.error) ?? "Workflow execution failed without a reported error.";
  const stage = lastReachedStage(input.journal);
  const workflow = compactMessage(input.target?.ref);
  const scriptPath = relativizePath(input.projectRoot, input.scriptIdentity?.sourcePath);
  const evidencePath = failingEvidencePath(
    input.projectRoot,
    input.runDir,
    input.artifacts ?? [],
    input.journal,
    stage,
    input.failedChild,
    input.unhandledGroupFailure,
    origin,
  );
  const journalPath = relativizePath(input.projectRoot, input.journalPath) ?? input.journalPath;
  return {
    ...(input.errorLogPath === undefined ? {} : { errorLogPath: input.errorLogPath }),
    ...(input.errorLogWarning === undefined ? {} : { errorLogWarning: input.errorLogWarning }),
    origin,
    message,
    ...(stage === undefined ? {} : { stage }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(evidencePath === undefined ? {} : { evidencePath }),
    journalPath,
    repairRequest: buildRepairRequest({ origin, message, stage, workflow, scriptPath, evidencePath, journalPath }),
  };
}

/**
 * Reader-facing lines under the failure verdict.
 *
 * `repairRequest: true` appends the whole request as ONE line, for surfaces that
 * wrap text and can be selected (chat message, tool result, operator block). The
 * width-clamped live widget omits it: a truncated repair request is not copyable,
 * so the widget shows pointers only and the message surfaces carry the text.
 */
export function formatWorkflowFailureDiagnosticLines(
  diagnostic: WorkflowFailureDiagnostic,
  options: { repairRequest?: boolean } = {},
): string[] {
  const head = [
    diagnostic.stage === undefined ? undefined : `stage: ${diagnostic.stage}`,
    diagnostic.scriptPath === undefined ? undefined : `script: ${diagnostic.scriptPath}`,
  ].filter((part): part is string => part !== undefined);
  return [
    ...(head.length === 0 ? [] : [head.join(" · ")]),
    ...(diagnostic.evidencePath === undefined ? [] : [`evidence: ${diagnostic.evidencePath}`]),
    `journal: ${diagnostic.journalPath}`,
    ...(diagnostic.errorLogPath === undefined ? [] : [`errors: ${diagnostic.errorLogPath}`]),
    ...(diagnostic.errorLogWarning === undefined ? [] : [diagnostic.errorLogWarning]),
    ...(options.repairRequest === true ? [`copy: ${diagnostic.repairRequest}`] : []),
  ];
}

/** Validated read of a persisted diagnostic; unknown shapes fail closed. */
export function parseWorkflowFailureDiagnostic(value: unknown): WorkflowFailureDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const origin = record.origin === "script" || record.origin === "runtime" ? record.origin : undefined;
  const message = nonEmptyString(record.message);
  const journalPath = nonEmptyString(record.journalPath);
  const repairRequest = nonEmptyString(record.repairRequest);
  if (origin === undefined || message === undefined || journalPath === undefined || repairRequest === undefined) {
    return undefined;
  }
  const stage = nonEmptyString(record.stage);
  const workflow = nonEmptyString(record.workflow);
  const scriptPath = nonEmptyString(record.scriptPath);
  const evidencePath = nonEmptyString(record.evidencePath);
  return {
    origin,
    message,
    ...(stage === undefined ? {} : { stage }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(evidencePath === undefined ? {} : { evidencePath }),
    journalPath,
    ...(nonEmptyString(record.errorLogPath) === undefined
      ? {}
      : { errorLogPath: nonEmptyString(record.errorLogPath)! }),
    ...(nonEmptyString(record.errorLogWarning) === undefined
      ? {}
      : { errorLogWarning: nonEmptyString(record.errorLogWarning)! }),
    repairRequest,
  };
}

function buildRepairRequest(parts: {
  origin: WorkflowFailureOrigin;
  message: string;
  stage: string | undefined;
  workflow: string | undefined;
  scriptPath: string | undefined;
  evidencePath: string | undefined;
  journalPath: string;
}): string {
  const subject = parts.workflow === undefined ? "this workflow" : `the "${parts.workflow}" workflow`;
  const where = parts.stage === undefined ? "" : ` at stage "${parts.stage}"`;
  const lead =
    parts.origin === "script"
      ? `Fix ${subject}: its script rejected the run${where} — ${parts.message}`
      : `Diagnose ${subject}: the workflow runtime failed${where} — ${parts.message}`;
  const sentences = [
    `${stripTrailingPeriod(lead)}.`,
    parts.scriptPath === undefined ? undefined : `Script: ${parts.scriptPath}.`,
    parts.evidencePath === undefined ? undefined : `Failure evidence: ${parts.evidencePath}.`,
    `Run journal: ${parts.journalPath}.`,
  ].filter((sentence): sentence is string => sentence !== undefined);
  return truncateText(sentences.join(" "), MAX_REPAIR_REQUEST_CHARS);
}

function lastReachedStage(journal: readonly WorkflowJournalLine[]): string | undefined {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const line = journal[index];
    if (line?.kind !== "phase") continue;
    const stage = nonEmptyString(line.phase);
    if (stage !== undefined) return stage;
  }
  return undefined;
}

/** Select current failure evidence without borrowing unrelated answers. */
function failingEvidencePath(
  projectRoot: string,
  runDir: string,
  artifacts: readonly { kind: string; stage?: string; relativePath: string; callId?: string }[],
  journal: readonly WorkflowJournalLine[],
  stage: string | undefined,
  failedChild: BuildWorkflowFailureDiagnosticInput["failedChild"],
  unhandledGroupFailure: true | undefined,
  origin: WorkflowFailureOrigin,
): string | undefined {
  let record: (typeof artifacts)[number] | undefined;
  if (failedChild !== undefined) {
    const terminalCallId = failedChildCallId(journal, failedChild);
    if (terminalCallId === undefined) return undefined;
    record = artifacts
      .filter(
        (record) =>
          record.callId === terminalCallId &&
          (record.kind === "result" || record.kind === "transcript" || record.kind === "answer"),
      )
      .sort((left, right) => evidenceRank(left.kind) - evidenceRank(right.kind))[0];
  } else {
    if (unhandledGroupFailure || origin !== "script") return undefined;
    const last = journal.at(-1);
    // Only immediate validation of this completed call has a single answer
    // owner. A new phase, group barrier, log, or error ends that evidence link.
    if (last?.kind !== "agent_end" || last.status !== "completed" || last.callId === undefined) return undefined;
    if (stage !== undefined && last.phase !== stage) return undefined;
    record = artifacts.filter((item) => item.kind === "answer" && item.callId === last.callId).at(-1);
  }
  if (record === undefined) return undefined;
  // `relativePath` is written relative to the artifacts directory, not to the
  // run directory. Joining it onto `runDir` printed a pointer that resolves to
  // nothing, so the operator's first move after a failure hit a missing file.
  return relativizePath(projectRoot, path.join(workflowRunArtifactsDir(runDir), record.relativePath));
}

function evidenceRank(kind: string): number {
  if (kind === "result") return 0;
  if (kind === "transcript") return 1;
  if (kind === "answer") return 2;
  return 3;
}

/** Resolve one terminal failed child from typed evidence; ambiguity stays pointer-less. */
function failedChildCallId(
  journal: readonly WorkflowJournalLine[],
  failedChild: NonNullable<BuildWorkflowFailureDiagnosticInput["failedChild"]>,
): string | undefined {
  const terminal = journal.filter(
    (line) =>
      line.callId !== undefined &&
      ((line.kind === "agent_end" && line.status !== undefined && line.status !== "completed") ||
        line.kind === "error"),
  );
  const matches = terminal.filter(
    (line) =>
      (failedChild.resultArtifact !== undefined && line.resultArtifact === failedChild.resultArtifact) ||
      (failedChild.childTrace?.path !== undefined && line.childTrace?.path === failedChild.childTrace.path),
  );
  const ids = [...new Set(matches.map((line) => line.callId))];
  return ids.length === 1 ? ids[0] : undefined;
}

/** Project-relative when the path is inside the root; the absolute path otherwise. */
function relativizePath(projectRoot: string, target: string | undefined): string | undefined {
  const absolute = nonEmptyString(target);
  if (absolute === undefined) return undefined;
  const relative = path.relative(projectRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
  return relative;
}

function compactMessage(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text === undefined ? undefined : truncateText(text, MAX_DIAGNOSTIC_MESSAGE_CHARS);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}
