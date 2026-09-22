/**
 * extensions/agents/operator/agent-observer.ts — the `/agent observe` (and
 * `/agent summary`) text projection over the shared agent live store.
 *
 * This is a read-only projection: it subscribes to nothing, owns no timers and
 * no registry, and is rendered on demand by the agents command router. It holds
 * no workflow semantics, so it may not import from `extensions/workflows/`; the
 * row tally it shares with the workflow progress header lives in the shared
 * panel module instead, which both features may reach.
 */
import {
  agentLiveStore,
  type AgentLiveRow,
  type AgentLiveStatus,
} from "../../_shared/agent-runtime/agent-live-store.js";
import {
  countAgentLiveStatuses,
  elapsedSinceStart,
  formatAgentIdentity,
  formatDuration,
} from "../../_shared/agent-runtime/agent-live-panel.js";

const OBSERVER_ROW_LIMIT = 2;
const OBSERVER_EVENT_DIGEST_LIMIT = 5;
const OBSERVER_EVENT_DIGEST_CHAR_LIMIT = 120;
const OBSERVER_STATUS_ORDER: Record<AgentLiveStatus, number> = {
  working: 0,
  queued: 1,
  done: 2,
  cancelled: 3,
  error: 4,
};

export function renderAgentObserverText(): string {
  const rows = [...agentLiveStore.rows.values()];
  if (rows.length === 0) return "Agent observer: no live rows";
  const counts = countAgentLiveStatuses(rows);
  const selectedRows = selectAgentObserverRows(rows, OBSERVER_ROW_LIMIT);
  const lines = [
    `Agent observer: ${rows.length} rows total; showing ${selectedRows.length} current/recent rows`,
    `counts: queued=${counts.queued} waiting; working=${counts.working} running; done=${counts.done} completed; cancelled=${counts.cancelled} terminal/not-running; error=${counts.error} terminal/not-running`,
    ...selectedRows.flatMap((row) => formatAgentObserverRow(row)),
  ];
  if (selectedRows.length < rows.length) lines.push(`more: ${rows.length - selectedRows.length} row(s) not shown`);
  return lines.join("\n");
}

function selectAgentObserverRows(rows: AgentLiveRow[], limit: number): AgentLiveRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const statusDelta = OBSERVER_STATUS_ORDER[a.row.status] - OBSERVER_STATUS_ORDER[b.row.status];
      if (statusDelta !== 0) return statusDelta;
      const aStartedAt = a.row.startedAt;
      const bStartedAt = b.row.startedAt;
      if (aStartedAt !== undefined && bStartedAt !== undefined && aStartedAt !== bStartedAt)
        return bStartedAt - aStartedAt;
      if (aStartedAt !== undefined) return -1;
      if (bStartedAt !== undefined) return 1;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map(({ row }) => row);
}

function formatAgentObserverRow(row: AgentLiveRow): string[] {
  const activeTools = row.status === "working" ? row.currentTools : [];
  const agent = row.agentName === undefined ? "" : ` agent=${formatAgentIdentity(row)}`;
  const tools = activeTools.length === 0 ? "" : ` tools=${activeTools.join(",")}`;
  const model = row.model === undefined ? "" : ` model=${row.model}`;
  const effort = row.thinking === undefined ? "" : ` /effort=${row.thinking}`;
  return [
    `- ${row.id}${agent}${model}${effort} status=${formatAgentObserverStatus(row.status)} label=${JSON.stringify(row.label)}`,
    `  elapsed=${formatAgentObserverElapsed(row)} steps=${row.stepCount}(events)${tools}`,
    `  events: ${formatAgentObserverDigest(row.eventLines)}`,
  ];
}

function formatAgentObserverStatus(status: AgentLiveStatus): string {
  switch (status) {
    case "queued":
      return "queued (waiting)";
    case "working":
      return "working (running)";
    case "done":
      return "done (terminal, not running)";
    case "cancelled":
      return "cancelled (terminal, not running)";
    case "error":
      return "error (terminal, not running)";
  }
}

function formatAgentObserverElapsed(row: AgentLiveRow): string {
  return formatDuration(row.elapsedMs ?? elapsedSinceStart(row)) || "n/a";
}

function formatAgentObserverDigest(eventLines: string[]): string {
  if (eventLines.length === 0) return "(no events)";
  const recent = eventLines.slice(-OBSERVER_EVENT_DIGEST_LIMIT);
  const omitted = eventLines.length - recent.length;
  const collapsed = collapseConsecutiveDuplicateLines(recent);
  let text = collapsed.join(" | ");
  if (text.length > OBSERVER_EVENT_DIGEST_CHAR_LIMIT) text = `${text.slice(0, OBSERVER_EVENT_DIGEST_CHAR_LIMIT - 1)}…`;
  if (omitted > 0) text = `${text} (+${omitted} earlier events omitted)`;
  return text;
}

function collapseConsecutiveDuplicateLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  let lastLine: string | undefined;
  let count = 0;
  const flush = () => {
    if (lastLine === undefined) return;
    collapsed.push(count > 1 ? `${lastLine} x${count}` : lastLine);
  };
  for (const line of lines) {
    if (lastLine === line) {
      count += 1;
      continue;
    }
    flush();
    lastLine = line;
    count = 1;
  }
  flush();
  return collapsed;
}
