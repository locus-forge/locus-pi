/**
 * extensions/workflows/operator/progress-render.ts — the pure layout half of the
 * workflow progress surface.
 *
 * Everything here is a function of read-only inputs: a journal slice, a declared
 * stage list, already-rendered lines, a width or a line budget. No subscription,
 * no timer, no registry, no component state — so a projection can be exercised
 * at any width without constructing a widget or touching the live store.
 *
 * `progress-widget.ts` keeps what is stateful: the component classes, the store
 * and fleet subscriptions, the live tick, the frame-identity cache, the viewport
 * reservation and the host installation.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentGroupMemberDisplayRank, truncate } from "../../_shared/agent-runtime/agent-live-panel.js";
import type { AgentLiveStatus } from "../../_shared/agent-runtime/agent-live-store.js";
import type { WorkflowProjectedStatus } from "../runtime/workflow-outcome.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";

/** One stage a workflow declared before the run started. */
export interface WorkflowDeclaredStage {
  title: string;
  detail?: string;
}

export function formatCompactTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.trunc(tokens)));
  if (tokens < 1_000_000) return `${trimCompactTokenCount((tokens / 1000).toFixed(1))}k`;
  return `${trimCompactTokenCount((tokens / 1_000_000).toFixed(1))}M`;
}

export function alignWorkflowRail(left: string, right: string, width: number): string | undefined {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return undefined;
  return `${left}${" ".repeat(gap)}${right}`;
}

/**
 * Rail identity budget for a path-like `scriptRef`, in columns. A ref wider than
 * this is a filesystem location, not a name, and the rail's job is identity.
 */
const WORKFLOW_RAIL_REF_MAX_COLS = 32;

/**
 * A workflow run started by absolute path carries that whole path as its
 * `scriptRef`. Interpolated raw into either header, it spends the line on a
 * directory prefix and the run's actual state falls off the end: on the rail every
 * projection overflows, `alignWorkflowRail` returns undefined at `gap < 2`, and
 * the ladder falls through to a bare `truncate(compact, width)` that drops the
 * right-hand commands; on the fleet header the counters are simply truncated away.
 * So the ref is cut to its identifying tail before either line is composed.
 *
 * A ref with no separator is a name and is never touched — including a long one.
 * A package ref (`task/plan`) is already inside the budget and passes through, so
 * only a real path is abbreviated: `…/<parent>/<file>`, then `…/<file>`.
 */
export function workflowRailRef(scriptRef: string): string {
  if (!/[/\\]/u.test(scriptRef)) return scriptRef;
  if (visibleWidth(scriptRef) <= WORKFLOW_RAIL_REF_MAX_COLS) return scriptRef;
  const segments = scriptRef.split(/[/\\]/u).filter((segment) => segment !== "");
  const basename = segments.at(-1);
  if (basename === undefined) return truncate(scriptRef, WORKFLOW_RAIL_REF_MAX_COLS);
  const parent = segments.at(-2);
  const candidates = [
    ...(parent === undefined ? [] : [`…/${parent}/${basename}`]),
    `…/${basename}`,
    truncate(basename, WORKFLOW_RAIL_REF_MAX_COLS),
  ];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= WORKFLOW_RAIL_REF_MAX_COLS) ?? candidates.at(-1) ?? ""
  );
}

function trimCompactTokenCount(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function workflowProgressStatusMark(status: WorkflowProjectedStatus | "running"): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
      return "✓";
    case "awaiting_operator":
      return "◐";
    case "cancelled":
      return "⊘";
    case "failed":
      return "✗";
    case "unknown":
      return "■";
    default:
      return assertNever(status);
  }
}

export function workflowProgressStatusLabel(status: WorkflowProjectedStatus | "running"): string {
  switch (status) {
    case "running":
      return "RUNNING";
    case "completed":
      return "OK";
    case "awaiting_operator":
      return "AWAITING OPERATOR";
    case "cancelled":
      return "CANCELLED";
    case "failed":
      return "FAILED";
    case "unknown":
      return "UNKNOWN";
    default:
      return assertNever(status);
  }
}

export function workflowProgressDonePresentation(status: WorkflowProjectedStatus): {
  marker: string;
  color: "success" | "warning" | "error";
} {
  switch (status) {
    case "completed":
      return { marker: "✓", color: "success" };
    case "awaiting_operator":
      return { marker: "◐", color: "warning" };
    case "cancelled":
      return { marker: "⊘", color: "warning" };
    case "failed":
      return { marker: "✗", color: "error" };
    case "unknown":
      return { marker: "■", color: "warning" };
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow progress status: ${String(value)}`);
}

export function formatProgressTailLine(line: WorkflowJournalLine): string {
  if (line.kind === "agent_end") {
    const warnings = line.evidenceWarnings?.filter((warning) => warning.trim() !== "") ?? [];
    const suffix = warnings.length > 0 ? ` evidenceWarnings=${warnings.join("; ")}` : "";
    return `  agent_end: ${line.agent ?? ""} ${line.status ?? ""}${suffix}`;
  }
  if (line.kind === "log") {
    if (line.source === "script") return `│ script · ${line.message ?? ""}`;
    if (line.source === "runtime") return `│ runtime · ${line.message ?? ""}`;
    return `│ journal · ${line.message ?? ""}`;
  }
  return `  ${line.kind}: ${line.message ?? ""}`;
}

export function currentWorkflowPhase(journal: readonly WorkflowJournalLine[]): string | undefined {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const line = journal[i];
    if (line === undefined) continue;
    if (line.kind !== "phase") continue;
    const phase = normalizeWorkflowPhase(line.phase);
    if (phase !== undefined) return phase;
  }
  return undefined;
}

export function normalizeWorkflowPhase(phase: string | undefined): string | undefined {
  const normalized = phase?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

type WorkflowStageState = "declared" | "reached" | "current";

export interface WorkflowStageFrontierItem {
  title: string;
  state: WorkflowStageState;
}

export function workflowStageFrontier(
  declaredStages: readonly WorkflowDeclaredStage[],
  journal: readonly WorkflowJournalLine[],
): WorkflowStageFrontierItem[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  const append = (title: string | undefined): void => {
    const normalized = normalizeWorkflowPhase(title);
    if (normalized === undefined || seen.has(normalized)) return;
    seen.add(normalized);
    titles.push(normalized);
  };
  for (const stage of declaredStages) append(stage.title);
  const reached = new Set<string>();
  for (const line of journal) {
    if (line.kind !== "phase") continue;
    const phase = normalizeWorkflowPhase(line.phase);
    if (phase === undefined) continue;
    append(phase);
    reached.add(phase);
  }
  const current = currentWorkflowPhase(journal);
  return titles.map((title) => ({
    title,
    state: title === current ? "current" : reached.has(title) ? "reached" : "declared",
  }));
}

export function shortWorkflowRunId(runId: string): string {
  const compact = runId.replace(/[^a-zA-Z0-9]/gu, "");
  if (compact === "") return runId;
  return compact.slice(-4);
}

/** Finished work — a done member, a closed previous run: given up first, oldest first. */
export const ROSTER_COLLAPSE_RANK_FINISHED = 4;
/** A finished group heading: given up only after every settled leaf. */
export const ROSTER_COLLAPSE_RANK_TERMINAL_GROUP_HEADING = 1;
/** Live work and rows nobody may collapse ahead of it. */
export const ROSTER_COLLAPSE_RANK_LIVE = 0;

export function isTerminalRosterStatus(status: AgentLiveStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}

/**
 * How readily an agent row is given up: the REVERSE of the order
 * `orderAgentLiveRows` displays a group member in (working → failed → queued →
 * done), so the row shown first is collapsed last. A working row drops to the
 * live rank, beneath even a finished group's heading, because it is the running
 * work the whole roster exists to show. A linear run has one rank across all its
 * finished rows, so there it still collapses oldest-first.
 */
export function agentCollapseRank(status: AgentLiveStatus): number {
  const displayRank = agentGroupMemberDisplayRank(status);
  return displayRank === 0 ? ROSTER_COLLAPSE_RANK_LIVE : ROSTER_COLLAPSE_RANK_TERMINAL_GROUP_HEADING + displayRank;
}

/**
 * Keep the roster inside its budget by collapsing the most expendable settled
 * entry first, and the oldest one when several are equally expendable: finished
 * agents, then queued and failed group members, then the headings of groups that
 * have already finished, and only then anything live. The current agent, the
 * live group and its working members, and the pending stages are what an
 * operator steers on, so they are what survives. The collapse is announced,
 * never silent.
 *
 * Rank, not position, drives the choice: a roster whose oldest entries are
 * finished-group headings would otherwise run out of "settled" entries at the
 * top and fall through to a plain tail cut, taking the live group, its working
 * agents and the pending line off the screen.
 */
export function clampRosterLines(
  entries: readonly {
    settled: boolean;
    collapseRank?: number;
    hiddenAgents?: number;
    hiddenGroups?: number;
    lines: string[];
  }[],
  budget: number,
  width: number,
): string[] {
  const all = entries.flatMap((entry) => entry.lines);
  if (all.length <= budget) return all;
  let hiddenAgents = 0;
  let hiddenGroups = 0;
  const kept = [...entries];
  while (kept.flatMap((entry) => entry.lines).length + 1 > budget) {
    const index = nextRosterCollapseIndex(kept);
    if (index < 0) break;
    const [removed] = kept.splice(index, 1);
    hiddenAgents += removed?.hiddenAgents ?? 1;
    hiddenGroups += removed?.hiddenGroups ?? 0;
  }
  const lines = kept.flatMap((entry) => entry.lines);
  const hidden = [
    ...(hiddenAgents > 0 ? [`+${hiddenAgents} earlier agents`] : []),
    ...(hiddenGroups > 0 ? [`+${hiddenGroups} earlier groups`] : []),
  ];
  if (hidden.length === 0) return lines.slice(0, budget);
  return [truncate(`  (${hidden.join(" · ")})`, width), ...lines].slice(0, budget);
}

/** The settled entry the roster gives up next, or -1 when nothing may be given up. */
function nextRosterCollapseIndex(entries: readonly { settled: boolean; collapseRank?: number }[]): number {
  let chosen = -1;
  let chosenRank = -1;
  entries.forEach((entry, index) => {
    if (!entry.settled) return;
    const rank = entry.collapseRank ?? ROSTER_COLLAPSE_RANK_FINISHED;
    if (rank > chosenRank) {
      chosen = index;
      chosenRank = rank;
    }
  });
  return chosen;
}

export function fitLines(
  fixedLines: string[],
  tailLines: string[],
  budget: number,
  width: number,
  protectedDone = 0,
): string[] {
  if (fixedLines.length + tailLines.length <= budget) return [...fixedLines, ...tailLines];
  let dropped = 0;
  let visibleTail = [...tailLines];
  while (fixedLines.length + visibleTail.length + 1 > budget && visibleTail.length > 0) {
    visibleTail = visibleTail.slice(1);
    dropped += 1;
  }
  if (fixedLines.length + visibleTail.length + 1 <= budget) {
    return [...fixedLines, truncate(`  (+${dropped} more)`, width), ...visibleTail];
  }
  const doneCount = Math.min(protectedDone, Math.max(0, budget - 1), fixedLines.length);
  const doneBlock = doneCount > 0 ? fixedLines.slice(fixedLines.length - doneCount) : [];
  const middle = fixedLines.slice(0, fixedLines.length - doneCount);
  const middleSlots = Math.max(1, budget - 1 - doneBlock.length);
  const visibleMiddle = middle.slice(0, middleSlots);
  const hiddenCount = fixedLines.length + visibleTail.length - visibleMiddle.length - doneBlock.length;
  return [...visibleMiddle, truncate(`  (+${hiddenCount} more)`, width), ...doneBlock].slice(0, budget);
}

/**
 * A settled focused row can use two lines (identity + final-answer preview),
 * while a working row can add one tool-activity line. Reserve the rail,
 * viewport count and controls before choosing how many logical rows to show.
 */
export function focusedFleetRowBudget(panelLines: number): number {
  return Math.max(1, Math.min(8, Math.floor((panelLines - 3) / 2)));
}
