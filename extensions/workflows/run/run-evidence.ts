/**
 * extensions/workflows/run/run-evidence.ts — Disk-backed run evidence blocks.
 *
 * Reads the persisted workflow run directory (journal, summary, result
 * envelope, retained script snapshot) and renders the bounded operator blocks
 * behind `/workflows status` and `/workflows dashboard`. Works across sessions
 * because every value it shows comes from disk, never from live state.
 */

import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import { formatWorkflowFailureDiagnosticLines } from "../runtime/workflow-failure.js";
import {
  listWorkflowRuns,
  readWorkflowRunJournalState,
  readWorkflowRunResult,
  readWorkflowRunScriptSnapshot,
  readWorkflowRunSummary,
  workflowPersistedResultInvalidity,
} from "../runtime/workflow-journal.js";
import { resolveWorkflowRunDir } from "../runtime/workflow-run-layout.js";
import type { WorkflowRunResultEnvelope } from "../runtime/workflow-journal.js";
import {
  formatWorkflowResultDetail,
  projectWorkflowDisposition,
  type WorkflowDispositionProjection,
} from "../runtime/workflow-outcome.js";
import { assertWorkflowRunId } from "../runtime/workflow-run-layout.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import {
  compactWorkflowLine,
  formatOperatorScriptIdentity,
  workflowStatusTone,
  workflowWarningBlock,
} from "../operator/operator-ui.js";
import { WORKFLOW_SOURCE_LEGEND, workflowSourceBadge } from "../catalog/workflow-catalog.js";
import { matchWorkflowPhaseGroups, staticWorkflowMetaPhases } from "../catalog/workflow-meta.js";

export const WORKFLOW_RPC_STATUS_ROWS = 4;
const WORKFLOW_RPC_DETAIL_EVENT_LIMIT = 1;

export const RUNS_IN_STATUS_LIST = 10;
const WORKFLOW_DETAIL_EVENT_LIMIT = 20;

export function buildRunsListBlock(projectRoot: string, limit: number, compact = false): OperatorBlock {
  const runs = listWorkflowRuns(projectRoot);
  if (runs.length === 0) {
    return {
      type: "VIEW",
      subject: "Workflow runs",
      primary: "No workflow runs yet.",
      metadata: ["status: ok; total=0 shown=0 older=0", WORKFLOW_SOURCE_LEGEND],
      controls: ['Draft one: /workflows run task/draft "<your request>"'],
    };
  }
  const shownRuns = runs.slice(0, Math.max(0, Math.min(limit, runs.length)));
  const older = runs.length - shownRuns.length;
  return {
    type: "VIEW",
    subject: "Workflow runs",
    primary: `Showing ${shownRuns.length} newest of ${runs.length} workflow run(s).`,
    body: shownRuns.map((run) => formatRunRow(projectRoot, run.runId, run.runDir, compact)),
    metadata: [
      WORKFLOW_SOURCE_LEGEND,
      `status: ok; total=${runs.length} shown=${shownRuns.length} older=${older}`,
      ...(older > 0 ? [`+${older} older run(s) hidden`] : []),
    ],
    controls: ["Detail: /workflows status <runId>"],
  };
}

function formatRunRow(projectRoot: string, runId: string, runDir: string, compact = false): string {
  const s = readWorkflowRunSummary(projectRoot, runId, runDir);
  const journalDiagnostics = readWorkflowRunJournalState(projectRoot, runId, runDir).diagnostics.length;
  const source = readWorkflowRunResult(projectRoot, runId, runDir)?.target?.source;
  if (compact) {
    // The replayed marker survives compaction: a reader must never see a green
    // row and assume every agent in it actually ran.
    const replayed = s.agentsReplayed > 0 ? ` replayed=${s.agentsReplayed}` : "";
    const corruption = journalDiagnostics > 0 ? ` journal-corrupt=${journalDiagnostics}` : "";
    return compactWorkflowLine(
      `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${s.status} ${runId} phase=${s.phase ?? "-"}${replayed}${corruption}`,
    );
  }
  const parts = [
    `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
    s.status.padEnd(9),
    runId,
    `phase=${s.phase ?? "-"}`,
    `agents=${s.agentsEnded}/${s.agentsStarted}`,
  ];
  if (s.agentsReplayed > 0) parts.push(`replayed=${s.agentsReplayed}`);
  if (s.usage !== null) parts.push(`tok=${s.usage.totalTokens}`);
  if (s.errors > 0) parts.push(`err=${s.errors}`);
  if (journalDiagnostics > 0) parts.push(`journal-corrupt=${journalDiagnostics}`);
  return parts.join("  ");
}

export function buildRunDetailBlock(projectRoot: string, runId: string, compact = false): OperatorBlock {
  let runDir: string;
  try {
    assertWorkflowRunId(runId);
    runDir = resolveWorkflowRunDir(projectRoot, runId);
  } catch {
    return workflowWarningBlock(`Workflow run not found: ${runId}`, "Recovery: /workflows status");
  }
  const journalState = readWorkflowRunJournalState(projectRoot, runId, runDir);
  const journal = journalState.lines;
  const summary = readWorkflowRunSummary(projectRoot, runId, runDir);
  const persisted = readWorkflowRunResult(projectRoot, runId, runDir);
  const persistedInvalidity = workflowPersistedResultInvalidity(persisted);
  if (journal.length === 0 && !summary.hasResult) {
    return workflowWarningBlock(`Workflow run not found: ${runId}`, "Recovery: /workflows status");
  }
  // What the run was ALLOWED to spend, beside what it spent. An undeclared axis
  // reads `unbounded`, which is the one fact a headless operator cannot infer from
  // anything else in this block: nothing on that axis will stop the run.
  const appliedBudgetLine =
    persisted?.budget === undefined
      ? null
      : `budget applied: ${Object.entries(persisted.budget)
          .map(([axis, value]) => `${axis}=${String(value)}`)
          .join(" ")}`;
  const budgetLine =
    summary.usage !== null
      ? `budget: tokens=${summary.usage.totalTokens} (in ${summary.usage.input} / out ${summary.usage.output}) ` +
        // The host reports no price. "unavailable" is the honest word; "$0.0000"
        // told every reader the run was free.
        `cost=${summary.usage.costTotal === undefined ? "unavailable" : `$${summary.usage.costTotal.toFixed(4)}`}`
      : null;
  // Stated as evidence provenance, not as a performance note: these agents did
  // not run in this run, so this run's green is partly inherited.
  const replayLine =
    summary.agentsReplayed > 0
      ? `replay: ${summary.agentsReplayed}/${summary.agentsEnded} agent call(s) reused a recorded run — not fresh evidence`
      : null;
  const phaseLine = declaredPhaseProgressLine(projectRoot, runId, runDir, journal);
  const allJournalLines = renderJournalLines(journal);
  const journalCorruptionLine = journalDiagnosticSummary(journalState.diagnostics);
  const eventLimit = compact ? WORKFLOW_RPC_DETAIL_EVENT_LIMIT : WORKFLOW_DETAIL_EVENT_LIMIT;
  const newestJournalLines = allJournalLines.slice(-eventLimit).reverse();
  const older = Math.max(0, allJournalLines.length - newestJournalLines.length);
  const resultDetail =
    persisted === null
      ? summary.hasResult
        ? "result detail: unavailable (result.json is unreadable)"
        : "result: unavailable (run is in flight or was interrupted)"
      : persistedInvalidity !== undefined
        ? `result detail: unavailable (${persistedInvalidity})`
        : persisted.error !== undefined
          ? `error: ${persisted.error}`
          : `result: ${formatWorkflowResultDetail(persisted.result)}`;
  const source = persisted?.target?.source;
  const scriptIdentity = persisted?.scriptIdentity;
  // Same actionable failure evidence a live run showed, recovered from the
  // persisted envelope so a later `/workflows status <runId>` reads identically.
  const failureLines =
    persisted?.failureDiagnostic === undefined
      ? []
      : formatWorkflowFailureDiagnosticLines(persisted.failureDiagnostic, { repairRequest: true });
  const compactResult =
    persisted === null
      ? resultDetail
      : persistedInvalidity !== undefined
        ? resultDetail
        : persisted.error !== undefined
          ? `error: ${persisted.error}`
          : `result: ${persistedWorkflowDisposition(persisted).summary}`;
  return {
    type: "VIEW",
    subject: "Workflow run",
    primary: compact
      ? compactWorkflowLine(
          `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
        )
      : `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
    badges: [
      { text: `status:${summary.status}`, tone: workflowStatusTone(summary.status) },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    body:
      newestJournalLines.length === 0
        ? ["No journal events recorded."]
        : compact
          ? newestJournalLines.map(compactWorkflowLine)
          : newestJournalLines,
    metadata: compact
      ? [
          WORKFLOW_SOURCE_LEGEND,
          ...(journalCorruptionLine === null ? [] : [compactWorkflowLine(journalCorruptionLine)]),
          compactWorkflowLine(`runDir: ${runDir}`),
          ...(persisted?.workspaceDir === undefined
            ? []
            : [compactWorkflowLine(`workspaceDir: ${persisted.workspaceDir}`)]),
          ...(scriptIdentity === undefined
            ? []
            : [compactWorkflowLine(formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref))]),
          ...(phaseLine === null ? [] : [compactWorkflowLine(phaseLine)]),
          ...(replayLine === null ? [] : [compactWorkflowLine(replayLine)]),
          ...(appliedBudgetLine === null ? [] : [compactWorkflowLine(appliedBudgetLine)]),
          ...(budgetLine === null ? [] : [compactWorkflowLine(budgetLine)]),
          compactWorkflowLine(compactResult),
          ...failureLines,
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ]
      : [
          WORKFLOW_SOURCE_LEGEND,
          `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
          ...(journalCorruptionLine === null ? [] : [journalCorruptionLine]),
          `runDir: ${runDir}`,
          ...(persisted?.workspaceDir === undefined ? [] : [`workspaceDir: ${persisted.workspaceDir}`]),
          ...(scriptIdentity === undefined
            ? []
            : [formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref)]),
          ...(phaseLine === null ? [] : [phaseLine]),
          ...(replayLine === null ? [] : [replayLine]),
          ...(appliedBudgetLine === null ? [] : [appliedBudgetLine]),
          ...(budgetLine === null ? [] : [budgetLine]),
          resultDetail,
          ...failureLines,
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ],
    controls: ["Refresh/list: /workflows status · Full artifact: result.json"],
  };
}

function journalDiagnosticSummary(
  diagnostics: ReturnType<typeof readWorkflowRunJournalState>["diagnostics"],
): string | null {
  const first = diagnostics[0];
  if (first === undefined) return null;
  const location = first.lineNumber === null ? "journal" : `line ${first.lineNumber}`;
  return `journal corruption: ${diagnostics.length} row(s); first=${location}: ${first.message}`;
}

/**
 * Declared pipeline versus what the run actually did. The declaration is read
 * from the run's retained script snapshot as inert text — the same bounded AST
 * scan the catalog uses, never an import. Absent when the script declared
 * nothing, so a workflow without `meta.phases` renders exactly as before.
 */
function declaredPhaseProgressLine(
  projectRoot: string,
  runId: string,
  runDir: string,
  journal: readonly WorkflowJournalLine[],
): string | null {
  const snapshot = readWorkflowRunScriptSnapshot(projectRoot, runId, runDir);
  if (snapshot.kind !== "ready") return null;
  const declared = staticWorkflowMetaPhases(snapshot.source);
  if (declared.length === 0) return null;
  const observed = journal
    .filter((line) => line.kind === "phase" && typeof line.phase === "string" && line.phase.trim() !== "")
    .map((line) => line.phase!);
  const groups = matchWorkflowPhaseGroups(declared, observed);
  const reached = groups.filter((group) => group.reached).length;
  const rendered = groups
    .map((group) => `${group.reached ? "[x]" : "[ ]"} ${group.title}${group.declared ? "" : " (undeclared)"}`)
    .join(" · ");
  return `phases: ${reached}/${groups.length} reached — ${rendered}`;
}

function persistedWorkflowDisposition(res: WorkflowRunResultEnvelope): WorkflowDispositionProjection {
  return projectWorkflowDisposition({
    ok: res.ok === true,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
  });
}

/** Shared journal-line renderer used by live progress, final result, and status detail. */
function renderJournalLines(journal: readonly WorkflowJournalLine[]): string[] {
  const out: string[] = [];
  for (const line of journal) {
    if (line.kind === "phase") {
      out.push(`  [phase] ${line.phase ?? ""}`);
    } else if (line.kind === "log") {
      const label = line.source === "script" ? "script" : line.source === "runtime" ? "runtime" : "journal";
      out.push(`  [${label}] ${line.message ?? ""}`);
    } else if (line.kind === "agent_start") {
      out.push(
        `  [agent] -> ${line.agent ?? ""}${line.label !== undefined ? ` (${line.label})` : ""}${line.replayed === true ? " [replayed]" : ""}`,
      );
    } else if (line.kind === "agent_end") {
      out.push(
        `  [agent] <- ${line.agent ?? ""} ${line.status ?? ""}${line.durationMs !== undefined ? ` ${line.durationMs}ms` : ""}${line.replayed === true ? " [replayed]" : ""}`,
      );
    } else if (line.kind === "error") {
      out.push(`  [error] ${line.message ?? ""}`);
    }
  }
  return out;
}
