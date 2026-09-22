/**
 * workflow-live.ts — the process-global live-executions registry and the
 * journal-line → AgentLiveStore projection for workflow runs.
 *
 * Durable truth stays in workflow-journal.ts; this file owns only what lives for
 * the length of the process: live row identity, replay hydration, terminal
 * finalization and the live-row retention bound. Code outside `extensions/workflows/`
 * reaches live row ids only through run/run-read.ts. One journal event is handled
 * atomically here — projection, then replay hydration, then release of exactly the
 * matching execution handle.
 */

import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveRow,
  type AgentLiveStatus,
} from "../../_shared/agent-runtime/agent-live-store.js";
import { readWorkflowArtifactRecord } from "./workflow-artifacts.js";
import type { WorkflowJournalLine } from "./workflow-runtime.js";

const RETAINED_COMPLETED_WORKFLOW_RUNS = 5;
const WORKFLOW_LIVE_EXECUTIONS_KEY = Symbol.for("locus-pi.workflow-live-executions.v1");

function workflowLiveExecutions(): Map<string, AgentLiveExecutionHandle> {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[WORKFLOW_LIVE_EXECUTIONS_KEY];
  if (existing instanceof Map) return existing as Map<string, AgentLiveExecutionHandle>;
  const executions = new Map<string, AgentLiveExecutionHandle>();
  Object.defineProperty(runtimeGlobal, WORKFLOW_LIVE_EXECUTIONS_KEY, {
    value: executions,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return executions;
}

/** Active journal writers only; independent from retained live rows. */
export function workflowLiveExecutionCount(): number {
  return workflowLiveExecutions().size;
}

/** Drop process-shared writer authority at a workflow session boundary. */
export function resetWorkflowLiveExecutions(): void {
  workflowLiveExecutions().clear();
}

/**
 * One synchronous journal-to-live adapter call owns projection, optional replay
 * hydration, and exact writer finalization. Production callers pass projectRoot;
 * callers that omit it cannot verify replay evidence and receive an explicit row diagnostic.
 */
export function applyWorkflowJournalLineToAgentLiveStore(line: WorkflowJournalLine, projectRoot?: string): void {
  if (line.kind === "group_start" || line.kind === "group_end") {
    applyGroupLineToAgentLiveStore(line);
    return;
  }
  if (line.executionMode === undefined && line.agent === undefined) return;
  if (line.kind === "error" && !hasTerminalCallId(line.callId)) return;
  const id = workflowAgentLiveRowId(line);
  const executionKey = workflowJournalExecutionKey(line);
  if (line.kind === "agent_queued" || line.kind === "agent_start") {
    const previous = workflowLiveExecutions().get(executionKey);
    // Admission promotes the row this call was queued on. A start over an already
    // started row stays a replacement, which is what a retried call must look like.
    if (
      line.kind === "agent_start" &&
      previous !== undefined &&
      agentLiveStore.rowForExecution(previous)?.status === "queued"
    ) {
      agentLiveStore.patchExecution(previous, { status: "working", startedAt: Date.now() });
      return;
    }
    const displayName = line.agent ?? "sub-agent";
    const execution = agentLiveStore.beginExecution({
      id,
      ...(line.groupId !== undefined ? { parentRowId: workflowGroupLiveRowId(line) } : {}),
      workflowRunId: line.runId,
      ...(line.agent === undefined ? {} : { agentName: line.agent }),
      label: line.label !== undefined ? `${displayName} (${line.label})` : displayName,
      ...(line.title === undefined ? {} : { title: line.title }),
      ...(line.model !== undefined ? { model: line.model } : {}),
      ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
      ...(line.slotKey !== undefined ? { slotKey: line.slotKey } : {}),
      isolated: false,
      noMcp: false,
    });
    workflowLiveExecutions().set(executionKey, execution);
    agentLiveStore.patchExecution(
      execution,
      line.kind === "agent_queued" ? { status: "queued" } : { status: "working", startedAt: Date.now() },
    );
    return;
  }
  const execution = workflowLiveExecutions().get(executionKey);
  const agentEndStatus =
    line.kind === "agent_end" && line.status !== undefined ? workflowStatusToAgentLiveStatus(line.status) : undefined;
  const terminal = line.kind === "error" || (agentEndStatus !== undefined && isTerminalStatus(agentEndStatus));
  try {
    if (execution === undefined) return;
    const current = agentLiveStore.rowForExecution(execution);
    if (current === undefined) return;
    if (line.kind === "error") {
      const message = line.message?.trim() || "Workflow agent failed without an error message.";
      const patch = {
        status: "error" as const,
        finalAnswer: message,
        errors: [
          ...current.errors,
          ...(current.errors.includes(message) ? [] : [message]),
          ...(line.errorLogPath === undefined ? [] : [`errors: ${line.errorLogPath}`]),
          ...(line.errorLogWarning === undefined ? [] : [line.errorLogWarning]),
          ...(line.journalWarning === undefined ? [] : [line.journalWarning]),
        ],
        ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
        currentTools: [],
      };
      // The mirror of W7 is why this line carries readback at all: a validator or
      // artifact writer that throws AFTER the child returned is a failure of a call that
      // really executed, and the runtime forwards the readback onto the `error` line for
      // exactly that reason. Clearing there would erase the one piece of evidence the run
      // does own, so the executed value replaces the request instead.
      patchTerminalExecutionEvidence(execution, line, patch);
      return;
    }
    if (line.kind !== "agent_end") return;
    const status = agentEndStatus;
    if (status === undefined) return;
    const replayContextError =
      terminal && line.replayed === true && projectRoot === undefined
        ? "Replayed answer verification context is unavailable."
        : undefined;
    const patch = {
      status,
      ...(status === "error" || status === "cancelled" || replayContextError !== undefined
        ? {
            errors: [
              ...current.errors,
              ...(line.message === undefined ? [] : [line.message]),
              ...(line.errorLogPath === undefined ? [] : [`errors: ${line.errorLogPath}`]),
              ...(line.errorLogWarning === undefined ? [] : [line.errorLogWarning]),
              ...(line.journalWarning === undefined ? [] : [line.journalWarning]),
              ...(replayContextError === undefined || current.errors.includes(replayContextError)
                ? []
                : [replayContextError]),
            ],
          }
        : {}),
      // Slot round on the anchor row (REQ-009): cosmetic while the executor row carries it, but
      // load-bearing in the degraded fallback where no executor row exists (host unavailable).
      ...(line.slotKey !== undefined ? { slotKey: line.slotKey } : {}),
      ...(line.round !== undefined ? { round: line.round } : {}),
      ...(line.worktreePath !== undefined ? { currentPath: line.worktreePath } : {}),
      ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
      ...(status !== "working" ? { currentTools: [] } : {}),
    };
    if (terminal) patchTerminalExecutionEvidence(execution, line, patch);
    else
      agentLiveStore.patchExecution(execution, {
        ...patch,
        ...(line.model !== undefined ? { model: line.model } : {}),
        ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
      });
    if (terminal && line.replayed === true && projectRoot !== undefined) {
      hydrateWorkflowAgentAnswerArtifact(projectRoot, line, execution);
    }
  } finally {
    if (terminal && execution !== undefined && workflowLiveExecutions().get(executionKey) === execution) {
      workflowLiveExecutions().delete(executionKey);
    }
  }
}

function hasTerminalCallId(callId: string | undefined): callId is string {
  return callId !== undefined && callId.trim() !== "";
}

/**
 * Terminal anchor write for one `agent_end`/`error` line. The row was opened from
 * `agent_start`, which carries the REQUESTED selector and effort by documented design —
 * the bridge has resolved nothing at that point — so only host readback on the terminal
 * line may replace them; a label it does not prove leaves the row instead of reading as
 * what ran.
 *
 * No `executedModel` means no child ran: a refused tier, a malformed role, a run that
 * died in setup, or a REPLAYED answer. Both request labels go (W7). The gate is
 * `executedModel` alone and NOT the status, because a replayed `completed` call is just
 * as modelless and `done` is the status an operator is least likely to question.
 *
 * `executedModel` without `thinking` means the child ran but the host named no effort.
 * The model stays — the readback, or the display value when the peer reported
 * `unavailable` — and the requested effort goes (F-02). Missing readback is an allowed
 * mode, not a failure: status and errors are exactly what `patch` says.
 */
function patchTerminalExecutionEvidence(
  execution: AgentLiveExecutionHandle,
  line: WorkflowJournalLine,
  patch: Partial<Omit<AgentLiveRow, "id" | "model" | "thinking">>,
): void {
  const model = line.model !== undefined ? { model: line.model } : {};
  if (line.executedModel === undefined) agentLiveStore.patchExecutionWithoutReadback(execution, "model", patch);
  else if (line.thinking === undefined)
    agentLiveStore.patchExecutionWithoutReadback(execution, "thinking", { ...patch, ...model });
  else agentLiveStore.patchExecution(execution, { ...patch, ...model, thinking: line.thinking });
}

/** Hydrate one replay while its exact writer is still active. */
function hydrateWorkflowAgentAnswerArtifact(
  projectRoot: string,
  line: WorkflowJournalLine,
  execution: AgentLiveExecutionHandle,
): void {
  const row = agentLiveStore.rowForExecution(execution);
  if (row === undefined) return;
  const ref = line.answerArtifact;
  if (ref === undefined) {
    patchWorkflowArtifactError(execution, row.errors, "Replayed answer artifact is missing from the workflow journal.");
    return;
  }
  if (ref.runId !== line.runId) {
    patchWorkflowArtifactError(execution, row.errors, "Replayed answer artifact belongs to a different workflow run.");
    return;
  }
  const read = readWorkflowArtifactRecord(projectRoot, ref.runId, ref.artifactId);
  if (read.status !== "ready") {
    patchWorkflowArtifactError(execution, row.errors, `Replayed answer artifact is ${read.status}: ${read.message}`);
    return;
  }
  const record = read.record;
  if (
    record.kind !== "answer" ||
    record.provenance !== "replay" ||
    record.name !== ref.name ||
    record.sha256 !== ref.sha256 ||
    (line.callId !== undefined && record.callId !== line.callId)
  ) {
    patchWorkflowArtifactError(
      execution,
      row.errors,
      "Replayed answer artifact metadata does not match the workflow journal.",
    );
    return;
  }
  const finalAnswer = read.bytes.toString("utf8");
  if (finalAnswer.trim() === "") {
    patchWorkflowArtifactError(execution, row.errors, "Replayed answer artifact is empty.");
    return;
  }
  agentLiveStore.patchExecution(execution, {
    finalAnswer,
    resultArtifact: `workflow-artifact:${ref.runId}/${ref.artifactId}#sha256=${ref.sha256}`,
  });
}

function patchWorkflowArtifactError(
  execution: AgentLiveExecutionHandle,
  existingErrors: string[],
  message: string,
): void {
  if (existingErrors.includes(message)) return;
  agentLiveStore.patchExecution(execution, { errors: [...existingErrors, message] });
}

function workflowJournalExecutionKey(
  line: Pick<WorkflowJournalLine, "runId" | "callId" | "executionMode" | "agent" | "label" | "phase">,
): string {
  return `${line.runId}\u0000agent:${line.callId ?? workflowAgentLiveRowId(line)}`;
}

function workflowGroupExecutionKey(line: Pick<WorkflowJournalLine, "runId" | "groupId">): string {
  return `${line.runId}\u0000group:${line.groupId ?? ""}`;
}

export function workflowAgentLiveRowId(
  line: Pick<WorkflowJournalLine, "runId" | "executionMode" | "agent" | "label" | "phase">,
): string {
  return `workflow:${line.runId}:${line.executionMode ?? "legacy"}:${line.agent ?? ""}:${line.label ?? ""}:${line.phase ?? ""}`;
}

/**
 * Stable live-row id for the executor row of a slotted workflow agent (REQ-009). Distinct
 * from the `workflow:` slot/anchor row so the bridge can reuse THE SAME executor row across
 * loop rounds (round++) while the anchor still collapses via `compactWorkflowParentRows`. The
 * `workflow-agent:` prefix keeps it a leaf (not a `workflow:` parent) so it renders directly.
 */
export function workflowAgentLiveChildRowId(
  line: Pick<WorkflowJournalLine, "runId" | "executionMode" | "agent" | "label" | "phase">,
): string {
  return `workflow-agent:${line.runId}:${line.executionMode ?? "legacy"}:${line.agent ?? ""}:${line.label ?? ""}:${line.phase ?? ""}`;
}

/** Extract the runId from a `workflow:` / `workflow-agent:` live-row id (drill journal lookup); undefined otherwise. */
export function workflowRunIdFromRowId(rowId: string): string | undefined {
  const match = /^workflow(?:-agent)?:([^:]+):/.exec(rowId);
  return match?.[1];
}

/**
 * Keep the just-completed run drillable and retire only older terminal runs.
 * Active runs are never counted toward or removed by this retention bound.
 */
export function pruneCompletedWorkflowRunLiveRows(latestCompletedRunId: string): number {
  const terminalRunIds = workflowLiveRunIds().filter((runId) => {
    const rows = workflowRunLiveRows(runId);
    return rows.length > 0 && rows.every((row) => isTerminalStatus(row.status));
  });
  const newestFirst = terminalRunIds.sort((left, right) => right.localeCompare(left));
  const retained = new Set(
    (newestFirst.includes(latestCompletedRunId)
      ? [latestCompletedRunId, ...newestFirst.filter((runId) => runId !== latestCompletedRunId)]
      : newestFirst
    ).slice(0, RETAINED_COMPLETED_WORKFLOW_RUNS),
  );
  let removed = 0;
  for (const runId of terminalRunIds) {
    if (!retained.has(runId)) removed += clearWorkflowRunLiveRows(runId);
  }
  return removed;
}

/** Remove every parent/child/group row owned by one retired workflow run. */
export function clearWorkflowRunLiveRows(runId: string): number {
  const prefix = `${runId}\u0000`;
  for (const key of workflowLiveExecutions().keys()) {
    if (key.startsWith(prefix)) workflowLiveExecutions().delete(key);
  }
  return agentLiveStore.removeRows(workflowRunLiveRowIds(runId));
}

function workflowRunLiveRowIds(runId: string): Set<string> {
  const parentPrefix = `workflow:${runId}:`;
  const childPrefix = `workflow-agent:${runId}:`;
  const owned = new Set<string>();
  for (const id of agentLiveStore.rows.keys()) {
    if (id.startsWith(parentPrefix) || id.startsWith(childPrefix)) owned.add(id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of agentLiveStore.rows.values()) {
      if (owned.has(row.id) || row.parentRowId === undefined || !owned.has(row.parentRowId)) continue;
      owned.add(row.id);
      changed = true;
    }
  }
  return owned;
}

function workflowRunLiveRows(runId: string) {
  return [...workflowRunLiveRowIds(runId)].map((id) => agentLiveStore.rows.get(id)).filter((row) => row !== undefined);
}

function workflowLiveRunIds(): string[] {
  const runIds = new Set<string>();
  for (const id of agentLiveStore.rows.keys()) {
    const runId = workflowRunIdFromRowId(id);
    if (runId !== undefined) runIds.add(runId);
  }
  return [...runIds];
}

function isTerminalStatus(status: AgentLiveStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}

export function workflowGroupLiveRowId(line: Pick<WorkflowJournalLine, "runId" | "groupId">): string {
  return `workflow:${line.runId}:group:${line.groupId ?? ""}`;
}

function applyGroupLineToAgentLiveStore(line: WorkflowJournalLine): void {
  if (line.groupId === undefined || line.groupKind === undefined) return;
  const id = workflowGroupLiveRowId(line);
  const executionKey = workflowGroupExecutionKey(line);
  if (line.kind === "group_start") {
    const execution = agentLiveStore.beginExecution({
      id,
      workflowRunId: line.runId,
      agentName: "workflow-group",
      ...(line.parentGroupId === undefined
        ? {}
        : { parentRowId: workflowGroupLiveRowId({ runId: line.runId, groupId: line.parentGroupId }) }),
      label: line.groupLabel ?? `${line.groupKind} (${line.groupTotal ?? 0})`,
      groupKind: line.groupKind,
      ...(line.groupTotal !== undefined ? { groupTotal: line.groupTotal } : {}),
      isolated: false,
      noMcp: false,
    });
    workflowLiveExecutions().set(executionKey, execution);
    agentLiveStore.patchExecution(execution, { status: "working", startedAt: Date.now() });
    return;
  }
  const status = workflowStatusToAgentLiveStatus(line.status ?? "");
  if (status === undefined) return;
  const execution = workflowLiveExecutions().get(executionKey);
  try {
    if (execution === undefined || agentLiveStore.rowForExecution(execution) === undefined) return;
    agentLiveStore.patchExecution(execution, {
      status,
      ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
      ...(line.groupTotal !== undefined ? { groupTotal: line.groupTotal } : {}),
      ...(line.groupCompleted !== undefined ? { groupCompleted: line.groupCompleted } : {}),
      ...(line.groupFailed !== undefined ? { groupFailed: line.groupFailed } : {}),
    });
  } finally {
    if (
      execution !== undefined &&
      isTerminalStatus(status) &&
      workflowLiveExecutions().get(executionKey) === execution
    ) {
      workflowLiveExecutions().delete(executionKey);
    }
  }
}

function workflowStatusToAgentLiveStatus(status: string): AgentLiveStatus | undefined {
  switch (status) {
    case "running":
      return "working";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "blocked":
      return "error";
    case "pending":
      return "queued";
    default:
      return undefined;
  }
}
