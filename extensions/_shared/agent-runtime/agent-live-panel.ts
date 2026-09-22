import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentLiveRow, AgentLiveStatus } from "./agent-live-store.js";

const SPINNER_FRAMES = ["⠿", "⠻", "⠽", "⠾"];
export const AGENT_LIVE_SPINNER_FRAME_COUNT = SPINNER_FRAMES.length;

/** `<icon> <name>  <title>  ·  <model> <effort>  ·  <elapsed>  ·  ↑<in> ↓<out>` (REQ-001). */
const ROW_SEP = "  ·  ";
/** Petname column budget (REQ-001 width rule: name ≤ 12 cols). */
const AGENT_NAME_MAX_COLS = 12;
const TREE_BRANCH_HOOK = "├─";
const TREE_LAST_HOOK = "└─";
const TREE_RAIL = "│  ";
const TREE_BLANK = "   ";

interface AgentLiveTreeLayout {
  prefix: string;
  childPrefix: string;
  hasChildren: boolean;
}

/** Presentation-only tree geometry attached to projected row copies, never runtime state. */
const AGENT_LIVE_TREE_LAYOUT = new WeakMap<AgentLiveRow, AgentLiveTreeLayout>();

export interface AgentLiveThemeLike {
  fg?: (color: string, text: string) => string;
  bold?: (s: string) => string;
}

export interface AgentLivePanelOptions {
  spinnerIndex?: number;
  theme?: AgentLiveThemeLike;
  /**
   * Calm rendering (render-profile.ts): live elapsed text is coarsened to
   * 10-second/minute buckets and the per-second tool timer is dropped, so a row
   * whose state is not changing renders byte-identical frames. The caller is
   * expected to also stop advancing `spinnerIndex`. Terminal rows keep their
   * exact recorded duration — it no longer changes, so it costs nothing.
   */
  calm?: boolean;
}

export class AgentLivePanel {
  constructor(private readonly options: AgentLivePanelOptions = {}) {}

  renderRows(rows: AgentLiveRow[], width: number): string[] {
    // Set-level callers project once, then the workflow and `/ps` surfaces render
    // rows one at a time. Projected copies retain their tree geometry so those
    // singleton calls do not collapse a recursive tree back into `↳`.
    const talliedRows = withWorkflowGroupTotals(rows);
    const orderedRows =
      talliedRows.length > 0 && talliedRows.every((row) => AGENT_LIVE_TREE_LAYOUT.has(row))
        ? talliedRows
        : orderAgentLiveRows(talliedRows);
    return orderedRows.flatMap((row) => {
      const rowLine = this.renderRow(row, width);
      const latest = latestMessagePreview(row);
      const assistant = row.transcript?.blocks.filter((block) => block.kind === "assistant").at(-1);
      const activity = formatToolActivity(row, Date.now(), { showElapsed: this.options.calm !== true });
      const layout = AGENT_LIVE_TREE_LAYOUT.get(row);
      const detailLines: string[] = [];
      if (latest !== undefined) {
        detailLines.push(
          this.#renderDetailLine(
            latest,
            width,
            "muted",
            layout,
            treeDetailHook(layout, activity !== undefined || layout?.hasChildren === true),
            assistant?.kind === "assistant" && !assistant.complete,
          ),
        );
      }
      if (activity !== undefined) {
        detailLines.push(
          this.#renderDetailLine(activity, width, "dim", layout, treeDetailHook(layout, layout?.hasChildren === true)),
        );
      }
      return [rowLine, ...detailLines];
    });
  }

  renderRow(row: AgentLiveRow, width: number): string {
    const meta = statusMeta(row.status, this.options.spinnerIndex ?? 0);
    const line = formatAgentLiveRowLine(row, meta, width, { calm: this.options.calm === true });
    const layout = AGENT_LIVE_TREE_LAYOUT.get(row);
    // One tone per status everywhere (`statusMeta`): a working row reads the same
    // in the fleet and in the workflow roster, so a tone means a state and not a
    // surface. Tree rails stay dim so status color remains the strongest signal.
    if (layout === undefined || !line.startsWith(layout.prefix) || this.options.theme?.fg === undefined) {
      return this.#fg(meta.color, line);
    }
    return `${this.options.theme.fg("dim", layout.prefix)}${this.options.theme.fg(meta.color, line.slice(layout.prefix.length))}`;
  }

  #renderDetailLine(
    text: string,
    width: number,
    color: string,
    layout: AgentLiveTreeLayout | undefined,
    hook: string,
    keepTail = false,
  ): string {
    const prefix = `${layout?.childPrefix ?? TOOL_ACTIVITY_INDENT}${hook} `;
    const available = Math.max(0, width - visibleWidth(prefix));
    if (keepTail && available > 0 && visibleWidth(text) > available) {
      text = `…${sliceByColumn(text, visibleWidth(text) - available + 1, available - 1)}`;
    }
    return this.#fg(color, clampLine(`${prefix}${text}`, width));
  }

  #fg(color: string, text: string): string {
    return this.options.theme?.fg ? this.options.theme.fg(color, text) : text;
  }
}

/** The latest substantive assistant text, stripped only for this one-line projection. */
function latestMessagePreview(row: AgentLiveRow): string | undefined {
  const latest = stripInlineMarkdown(row.latestMessage ?? (row.status === "done" ? firstLineOf(row.finalAnswer) : ""));
  return latest === "" ? undefined : latest;
}

/**
 * A detail line is a child of its agent. It branches while another detail or a
 * real child follows, and closes the branch otherwise. Singleton legacy rows
 * retain the established `   └ …` grammar.
 */
function treeDetailHook(layout: AgentLiveTreeLayout | undefined, hasFollowing: boolean): string {
  return layout === undefined ? TOOL_ACTIVITY_HOOK : hasFollowing ? TREE_BRANCH_HOOK : TREE_LAST_HOOK;
}

/**
 * THE shared row-set projection. Both surfaces that show live agents run their
 * whole row set through this before any line is composed: the workflow progress
 * panel (`progress-widget.ts:renderRoster`) and `/ps`
 * (`fleet-menu.ts:projectFleetMenuRows` / `projectFleetMenuSnapshotRows`). The
 * rules below therefore cannot live in `renderRow` — the panel renders one row
 * per call, and "is this group worth a heading" and "which leaf comes first" are
 * facts about the SET, not about a row.
 *
 * Three rules, in order:
 *
 * 1. Tree order: a child follows its parent, roots keep insertion order.
 * 2. Group heading threshold: a group summary row earns its line only when it
 *    aggregates two or more agents (`groupTotal >= 2`). A one-item group is a
 *    heading over a single row, so it is dropped and its children are lifted to
 *    the group's own parent — the leaf is never hidden, only its redundant
 *    heading.
 * 3. Group membership order: the children of a group row are ranked
 *    working → failed → queued → done, stable inside each rank. Fan-out over
 *    items has no chronology worth preserving, so the operator reads the live
 *    work first and the failures next. This is deliberately scoped to group
 *    children: a linear run's rows keep the order the run produced them, which
 *    is the no-jump invariant of T-188 W4 (a row must not move when it finishes).
 *
 * Collapsing and the line budget are NOT here — they belong to the passive
 * progress panel alone (`clampRosterLines`), because in `/ps` every leaf has to
 * stay reachable by the cursor.
 */
export function orderAgentLiveRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const kept = dropSubThresholdGroupRows(rows);
  const byParent = new Map<string, AgentLiveRow[]>();
  for (const row of kept) {
    if (row.parentRowId === undefined) continue;
    const siblings = byParent.get(row.parentRowId) ?? [];
    siblings.push(row);
    byParent.set(row.parentRowId, siblings);
  }
  const byId = new Map(kept.map((row) => [row.id, row]));
  const ordered: AgentLiveRow[] = [];
  const seen = new Set<string>();

  function childrenOf(row: AgentLiveRow): AgentLiveRow[] {
    const children = byParent.get(row.id) ?? [];
    return row.groupKind === undefined ? children : orderGroupMembers(children);
  }

  function appendTree(row: AgentLiveRow): void {
    if (seen.has(row.id)) return;
    ordered.push(row);
    seen.add(row.id);
    for (const child of childrenOf(row)) appendTree(child);
  }

  for (const row of kept) {
    if (row.parentRowId !== undefined && byId.has(row.parentRowId)) continue;
    appendTree(row);
  }
  for (const row of kept) appendTree(row);
  return ordered.length > 1 ? decorateAgentLiveTreeRows(ordered) : ordered;
}

/**
 * Turn a parent-first row set into terminal tree geometry. Copies keep the
 * layout presentation-only: store rows stay clean, while a surface may safely
 * slice the projection and render each surviving row in a singleton panel call.
 */
function decorateAgentLiveTreeRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const projected = rows.map((row) => ({ ...row }));
  const byId = new Map(projected.map((row) => [row.id, row]));
  const byParent = new Map<string, AgentLiveRow[]>();
  const roots: AgentLiveRow[] = [];
  for (const row of projected) {
    if (row.parentRowId === undefined || !byId.has(row.parentRowId)) {
      roots.push(row);
      continue;
    }
    const siblings = byParent.get(row.parentRowId) ?? [];
    siblings.push(row);
    byParent.set(row.parentRowId, siblings);
  }

  const siblingsOf = (row: AgentLiveRow): AgentLiveRow[] => {
    if (row.parentRowId !== undefined && byId.has(row.parentRowId)) return byParent.get(row.parentRowId) ?? [];
    return roots;
  };
  const isLastSibling = (row: AgentLiveRow): boolean => siblingsOf(row).at(-1)?.id === row.id;

  for (const row of projected) {
    const ancestors: AgentLiveRow[] = [];
    const seen = new Set<string>([row.id]);
    let parentRowId = row.parentRowId;
    while (parentRowId !== undefined && !seen.has(parentRowId)) {
      const parent = byId.get(parentRowId);
      if (parent === undefined) break;
      ancestors.push(parent);
      seen.add(parent.id);
      parentRowId = parent.parentRowId;
    }
    ancestors.reverse();
    const ancestorPrefix = ancestors.map((ancestor) => (isLastSibling(ancestor) ? TREE_BLANK : TREE_RAIL)).join("");
    const last = isLastSibling(row);
    AGENT_LIVE_TREE_LAYOUT.set(row, {
      prefix: `${ancestorPrefix}${last ? TREE_LAST_HOOK : TREE_BRANCH_HOOK} `,
      childPrefix: `${ancestorPrefix}${last ? TREE_BLANK : TREE_RAIL}`,
      hasChildren: (byParent.get(row.id)?.length ?? 0) > 0,
    });
  }
  return projected;
}

/** Rank a group member by what the operator needs to see first (rule 3 above). */
const GROUP_MEMBER_RANK: Record<AgentLiveStatus, number> = {
  working: 0,
  error: 1,
  queued: 2,
  done: 3,
  cancelled: 3,
};

/**
 * The display rank of a group member: 0 is what the operator sees first.
 *
 * Exported because a surface that has to GIVE UP rows (the passive progress
 * roster) must give them up in the reverse of this order — a panel that puts
 * live work on top and then collapses live work first would defeat its own
 * ordering rule. Reading the rank instead of re-listing the statuses keeps the
 * two from drifting apart.
 */
export function agentGroupMemberDisplayRank(status: AgentLiveStatus): number {
  return GROUP_MEMBER_RANK[status] ?? 3;
}

/**
 * Tally live rows by status. Both the workflow progress header and the `/agent
 * observe` text read it, and those two surfaces sit in different features, so
 * the tally lives beside the row projections rather than inside either surface.
 */
export function countAgentLiveStatuses(rows: AgentLiveRow[]): Record<AgentLiveStatus, number> {
  const counts: Record<AgentLiveStatus, number> = { queued: 0, working: 0, done: 0, cancelled: 0, error: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function orderGroupMembers(members: AgentLiveRow[]): AgentLiveRow[] {
  return members
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const rank = agentGroupMemberDisplayRank(a.row.status) - agentGroupMemberDisplayRank(b.row.status);
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Drop group summary rows that aggregate fewer than two agents and re-parent
 * their children onto the nearest ancestor that SURVIVED, so the tree stays
 * intact and no leaf disappears with the heading. The walk is a loop, not one
 * hop: a sub-threshold group nested inside another sub-threshold group would
 * otherwise leave its child pointing at a row nobody holds any more, and the
 * child would silently detach from its real ancestor and render as a root.
 */
function dropSubThresholdGroupRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const droppedIds = new Set(
    rows.filter((row) => row.groupKind !== undefined && (row.groupTotal ?? 0) < 2).map((row) => row.id),
  );
  if (droppedIds.size === 0) return rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const survivingAncestorId = (parentRowId: string): string | undefined => {
    let candidate: string | undefined = parentRowId;
    const seen = new Set<string>();
    while (candidate !== undefined && droppedIds.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      candidate = byId.get(candidate)?.parentRowId;
    }
    return candidate;
  };
  return rows
    .filter((row) => !droppedIds.has(row.id))
    .map((row) => {
      if (row.parentRowId === undefined || !droppedIds.has(row.parentRowId)) return row;
      const nextParentRowId = survivingAncestorId(row.parentRowId);
      const { parentRowId: _droppedParent, ...rest } = row;
      return nextParentRowId === undefined ? rest : { ...rest, parentRowId: nextParentRowId };
    });
}

/**
 * A workflow journal anchor and the SDK child it launches describe one logical
 * agent. Once the child exists, keep the child and splice it into the anchor's
 * place in the tree so every fleet/status surface shows that actor once.
 * Keep failed anchors: host validation can reject an otherwise completed SDK child.
 */
export function compactWorkflowParentRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const parentIdsWithChildren = new Set(
    rows.map((row) => row.parentRowId).filter((id): id is string => id !== undefined),
  );
  const collapsedParentIds = new Set(
    rows
      .filter(
        (row) =>
          parentIdsWithChildren.has(row.id) &&
          isWorkflowAgentParentRow(row) &&
          row.status !== "error" &&
          row.status !== "cancelled",
      )
      .map((row) => row.id),
  );
  if (collapsedParentIds.size === 0) return rows;

  return rows
    .filter((row) => !collapsedParentIds.has(row.id))
    .map((row) => {
      if (row.parentRowId === undefined || !collapsedParentIds.has(row.parentRowId)) return row;
      const collapsedParent = rowById.get(row.parentRowId);
      const nextParentRowId = collapsedParent?.parentRowId;
      const { parentRowId: _oldParentRowId, ...rest } = row;
      return nextParentRowId === undefined ? rest : { ...rest, parentRowId: nextParentRowId };
    });
}

function isWorkflowAgentParentRow(row: AgentLiveRow): boolean {
  return row.id.startsWith("workflow:") && !row.id.includes(":group:");
}

export function selectAgentLiveRowsForParents(rows: AgentLiveRow[], parentIds: Iterable<string>): AgentLiveRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byParent = new Map<string, AgentLiveRow[]>();
  for (const row of rows) {
    if (row.parentRowId === undefined) continue;
    const children = byParent.get(row.parentRowId) ?? [];
    children.push(row);
    byParent.set(row.parentRowId, children);
  }
  const selected: AgentLiveRow[] = [];
  const seen = new Set<string>();
  function append(id: string): void {
    const row = byId.get(id);
    if (row === undefined || seen.has(row.id)) return;
    selected.push(row);
    seen.add(row.id);
    for (const child of byParent.get(row.id) ?? []) append(child.id);
  }
  for (const id of parentIds) append(id);
  return selected;
}

/**
 * Short, durable per-instance suffix for a row (last 6 alphanumerics of the
 * child-session id, else the row id). No longer shown in the fleet row — the
 * petname carries identity there (REQ-002) — but still used by the drill header
 * and `/agent drill <suffix>` resolution (T-188 W5).
 */
export function agentLiveShortId(row: AgentLiveRow): string {
  return agentShortIdFromSource(row.childSessionId ?? row.id);
}

/** Last-6-alphanumerics of any id source (child-session id or row id). */
export function agentShortIdFromSource(source: string): string {
  const compact = source.replace(/[^a-zA-Z0-9]/g, "");
  const base = compact.length > 0 ? compact : source;
  return base.length <= 6 ? base : base.slice(-6);
}

/** Actor identity for the drill header / observer report: `agentName#<shortId>` (T-188 W3). */
export function formatAgentIdentity(row: AgentLiveRow): string {
  return `${row.agentName ?? "agent"}#${agentLiveShortId(row)}`;
}

/**
 * The fleet row grammar (REQ-001), normative per spec "### Agent row anatomy":
 *
 *   `<icon> <name>  <title>  ·  <model> <effort>  ·  <elapsed>  ·  ↑<in> ↓<out>`
 *
 * The status icon+color carries the state, so the row deliberately omits
 * `[Working]`, `on task`, `activity=`, `args=`, `steps=…`, `tokens=…`,
 * `childSession=` and raw JSON. The `└ <tool-action>` sub-line is rendered by the
 * panel (T-196); the `· r<N>` round badge (T-193) is added by `agentRowRightSegments`
 * from r2 up (see `formatRoundBadge`).
 */
export function formatAgentLiveRowLine(
  row: AgentLiveRow,
  meta = statusMeta(row.status, 0),
  width = Number.POSITIVE_INFINITY,
  options: { calm?: boolean } = {},
): string {
  const calm = options.calm === true;
  if (row.groupKind !== undefined) return formatAgentGroupRowLine(row, meta, width, calm);
  const prefix = AGENT_LIVE_TREE_LAYOUT.get(row)?.prefix ?? (row.parentRowId !== undefined ? "↳ " : "");
  const name = truncate(agentRowName(row), AGENT_NAME_MAX_COLS);
  const title = agentRowTitle(row);
  return assembleRowLine(prefix, meta.icon, name, title, agentRowRightSegments(row, calm), width);
}

/** Petname is the row's name; falls back to the agent name, then a generic label. */
function agentRowName(row: AgentLiveRow): string {
  return row.displayName ?? row.agentName ?? "agent";
}

/** Public display-name projection shared by fleet, drill, and transcript events. */
export function agentLiveDisplayName(row: AgentLiveRow): string {
  return agentRowName(row);
}

/** Explicit title wins; otherwise the label, unwrapped from any `agentName (…)` form. */
function agentRowTitle(row: AgentLiveRow): string {
  if (row.title !== undefined && row.title.trim() !== "") return row.title.trim();
  return cleanRowLabel(row);
}

/** Public title projection with the same label-unwrapping fallback as the fleet row. */
export function agentLiveTitle(row: AgentLiveRow): string {
  return agentRowTitle(row);
}

/** `<Name> — <title>` drill heading from REQ-008. */
export function formatAgentDrillTitle(row: AgentLiveRow): string {
  const title = agentRowTitle(row);
  return title === "" ? agentRowName(row) : `${agentRowName(row)} — ${title}`;
}

function cleanRowLabel(row: AgentLiveRow): string {
  if (row.agentName !== undefined) {
    const prefix = `${row.agentName} (`;
    if (row.label.startsWith(prefix) && row.label.endsWith(")")) return row.label.slice(prefix.length, -1);
  }
  return row.label;
}

/** Right-hand meta segments: model+effort, round badge, elapsed, token counter (each optional). */
function agentRowRightSegments(row: AgentLiveRow, calm = false): string[] {
  const segments: string[] = [];
  const badge = formatModelBadge(row);
  if (badge !== "") segments.push(badge);
  // `[· r<N>]` slot from "### Agent row anatomy" (REQ-009): after model+effort, before
  // elapsed. Rendered only from r2 up — r1 is implicit, so a linear run shows no badge.
  const round = formatRoundBadge(row);
  if (round !== undefined) segments.push(round);
  const elapsed = formatRowElapsed(row, calm);
  if (elapsed !== "") segments.push(elapsed);
  const tokens = formatRowTokens(row);
  if (tokens !== undefined) segments.push(tokens);
  return segments;
}

/**
 * Elapsed column text. A recorded `elapsedMs` (terminal rows) is fixed and stays
 * exact even in calm mode; only the live wall-clock reading is coarsened, since
 * that is the value whose text otherwise changes every second.
 */
function formatRowElapsed(row: AgentLiveRow, calm: boolean): string {
  if (row.elapsedMs !== undefined) return formatDuration(row.elapsedMs);
  const live = elapsedSinceStart(row);
  return calm ? formatDurationCoarse(live) : formatDuration(live);
}

/**
 * Loop-round badge `r<N>` (REQ-009), shown only when a slot has been re-invoked
 * (`round ≥ 2`). r1 is implicit, so the badge is absent for a linear (non-loop) run.
 */
export function formatRoundBadge(row: { round?: number }): string | undefined {
  return row.round !== undefined && row.round >= 2 ? `r${row.round}` : undefined;
}

/**
 * Model badge (REQ-005): short model name (provider prefix stripped) + effort as
 * a bare word, e.g. `{model:"anthropic/claude-fable-5", thinking:"medium"}` →
 * `claude-fable-5 medium`. No `/effort=` label.
 */
export function formatModelBadge(model: { model?: string; thinking?: string }): string {
  const parts: string[] = [];
  if (model.model !== undefined && model.model !== "") parts.push(shortModelName(model.model));
  if (model.thinking !== undefined && model.thinking !== "") parts.push(model.thinking);
  return parts.join(" ");
}

function shortModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function formatRowTokens(row: AgentLiveRow): string | undefined {
  if (row.tokenCount === undefined) return undefined;
  return `↑${formatTokenCount(row.tokenCount.input)} ↓${formatTokenCount(row.tokenCount.output)}`;
}

/**
 * Humanized token counter (REQ-006): `999`→`999`, `12_400`→`12.4k`,
 * `1_260_000`→`1.3M`. One decimal for k/M, trailing `.0` trimmed.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 1000) return String(Math.max(0, Math.trunc(tokens)));
  if (tokens < 1_000_000) return `${trimTrailingZero((tokens / 1000).toFixed(1))}k`;
  return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Compose the row, sacrificing the title first when the line overflows a finite
 * width (REQ-001: the title truncates first; the right-hand meta never truncates). At infinite
 * width (unit tests / unbounded panels) the full line is returned untouched.
 */
function assembleRowLine(
  prefix: string,
  icon: string,
  name: string,
  title: string,
  segments: string[],
  width: number,
): string {
  const left = `${prefix}${icon} ${name}`;
  const right = segments.length > 0 ? `${ROW_SEP}${segments.join(ROW_SEP)}` : "";
  if (title === "") return clampLine(`${left}${right}`, width);
  const full = `${left}  ${title}${right}`;
  if (!Number.isFinite(width) || visibleWidth(full) <= width) return full;
  const room = Math.floor(width) - visibleWidth(left) - 2 - visibleWidth(right);
  if (room >= 2) return `${left}  ${truncate(title, room)}${right}`;
  return clampLine(`${left}${right}`, width);
}

function clampLine(line: string, width: number): string {
  return Number.isFinite(width) ? truncate(line, Math.floor(width)) : line;
}

/** Workflow group summary row (parallel/pipeline): label + elapsed + k/n done. */
function formatAgentGroupRowLine(row: AgentLiveRow, meta: StatusMeta, width: number, calm = false): string {
  const prefix = AGENT_LIVE_TREE_LAYOUT.get(row)?.prefix ?? (row.parentRowId !== undefined ? "↳ " : "");
  const segments: string[] = [];
  const elapsed = formatRowElapsed(row, calm);
  if (elapsed !== "") segments.push(elapsed);
  if (row.groupTotal !== undefined) segments.push(`${row.groupCompleted ?? 0}/${row.groupTotal} done`);
  if ((row.groupFailed ?? 0) > 0) segments.push(`${row.groupFailed} failed`);
  const tokens = formatRowTokens(row);
  if (tokens !== undefined) segments.push(tokens);
  const right = segments.length > 0 ? `${ROW_SEP}${segments.join(ROW_SEP)}` : "";
  return clampLine(`${prefix}${meta.icon} ${row.label}${right}`, width);
}

/**
 * Fold what a workflow group's members already show into its summary row:
 * token totals, and — while the group is still running — its `k/n done ·
 * f failed` counters.
 *
 * The counters need folding because the journal only carries them on
 * `group_end` (`workflow-runtime.ts:runGrouped`): until the whole fan-out
 * settles, the group row holds no `groupCompleted` at all, so the heading read
 * `0/9 done` next to eight member rows that already carried `✓` or `✗`. The
 * heading is the summary of the rows under it, so it is computed from those
 * rows whenever the run has not yet stated the answer itself.
 *
 * The group row's OWN counters win whenever it has them: `group_end` is
 * authoritative about branches that never produced a live row (its
 * `completed = total - failed`), and a surface that patches the group row
 * directly is stating a fact about the group, not about the members on screen.
 */
export function withWorkflowGroupTotals(rows: AgentLiveRow[]): AgentLiveRow[] {
  const byParent = new Map<string, AgentLiveRow[]>();
  for (const row of rows) {
    if (row.parentRowId === undefined) continue;
    const children = byParent.get(row.parentRowId) ?? [];
    children.push(row);
    byParent.set(row.parentRowId, children);
  }
  return rows.map((row) => {
    if (row.groupKind === undefined) return row;
    const tokens = sumDescendantTokens(row.id, byParent, new Set());
    const counts = liveGroupMemberCounts(row, byParent);
    if (tokens === undefined && counts === undefined) return row;
    return {
      ...row,
      ...(tokens === undefined ? {} : { tokenCount: tokens }),
      ...(counts === undefined ? {} : counts),
    };
  });
}

/**
 * `{ groupCompleted, groupFailed }` counted off the group's own member rows, or
 * `undefined` when the group row already answers for itself or has no members
 * yet. Rendering a single row through the panel re-runs this projection on a
 * one-row set, so "no members" has to leave the row untouched.
 *
 * A member is a leaf: a non-group descendant with no descendants of its own.
 * The workflow journal anchor and the SDK child it launches are two rows for one
 * agent (`compactWorkflowParentRows`), and only the deeper one is counted.
 */
function liveGroupMemberCounts(
  row: AgentLiveRow,
  byParent: Map<string, AgentLiveRow[]>,
): { groupCompleted: number; groupFailed: number } | undefined {
  if (row.groupCompleted !== undefined || row.groupFailed !== undefined) return undefined;
  const members = groupMemberRows(row.id, byParent, new Set());
  if (members.length === 0) return undefined;
  return {
    groupCompleted: members.filter((member) => member.status === "done").length,
    groupFailed: members.filter((member) => member.status === "error").length,
  };
}

function groupMemberRows(parentId: string, byParent: Map<string, AgentLiveRow[]>, seen: Set<string>): AgentLiveRow[] {
  const members: AgentLiveRow[] = [];
  for (const child of byParent.get(parentId) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const nested = groupMemberRows(child.id, byParent, seen);
    if (nested.length > 0) members.push(...nested);
    else if (child.groupKind === undefined) members.push(child);
  }
  return members;
}

function sumDescendantTokens(
  parentId: string,
  byParent: Map<string, AgentLiveRow[]>,
  seen: Set<string>,
): { input: number; output: number } | undefined {
  let input = 0;
  let output = 0;
  let found = false;
  for (const child of byParent.get(parentId) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    if (child.groupKind === undefined && child.tokenCount !== undefined) {
      input += child.tokenCount.input;
      output += child.tokenCount.output;
      found = true;
    }
    const nested = sumDescendantTokens(child.id, byParent, seen);
    if (nested !== undefined) {
      input += nested.input;
      output += nested.output;
      found = true;
    }
  }
  return found ? { input, output } : undefined;
}

/** `● agent <Name> started — <title> (<model> <effort>)` (REQ-011). */
export function formatAgentStartedEventLine(row: AgentLiveRow): string {
  const title = agentRowTitle(row);
  const badge = formatModelBadge(row);
  return `● agent ${agentRowName(row)} started${title !== "" ? ` — ${title}` : ""}${badge !== "" ? ` (${badge})` : ""}`;
}

/**
 * Terminal lifecycle line with status-specific marker and verb (REQ-011).
 */
export function formatAgentFinishedEventLine(row: AgentLiveRow): string {
  const lifecycle =
    row.status === "done"
      ? { marker: "✓", verb: "finished" }
      : row.status === "cancelled"
        ? { marker: "⊘", verb: "cancelled" }
        : { marker: "✗", verb: "failed" };
  const parts = [`${lifecycle.marker} agent ${agentRowName(row)} ${lifecycle.verb}`];
  const elapsed = formatDuration(row.elapsedMs ?? elapsedSinceStart(row));
  if (elapsed !== "") parts.push(elapsed);
  const tokens = formatRowTokens(row);
  if (tokens !== undefined) parts.push(tokens);
  const tail = row.status === "done" ? firstLineOf(row.finalAnswer) : firstLineOf(row.errors[0] ?? row.finalAnswer);
  return `${parts.join(" · ")}${tail !== "" ? ` — ${tail}` : ""}`;
}

function firstLineOf(value: string | undefined): string {
  if (value === undefined) return "";
  return (value.split(/\r?\n/, 1)[0] ?? "").trim();
}

/**
 * Render-time strip of the inline markdown an agent writes for a document.
 * The transcript store keeps the message verbatim — this only changes what the
 * one-line preview shows, where a collapsed `# Title ## Section **bold**` is
 * punctuation with nothing left to mark up. Every character of prose survives;
 * only the markers go. A trailing `**` left by the store's 300-char bound is
 * dropped too, since its partner was cut off.
 */
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/(^|\s)#{1,6}\s+/gu, "$1")
    .replace(/\*\*([\s\S]+?)\*\*/gu, "$1")
    .replace(/__([\s\S]+?)__/gu, "$1")
    .replace(/\*\*/gu, "")
    .replace(/`/gu, "")
    .trim();
}

// ── Tool-activity action sub-line (REQ-004, T-196) ───────────────────────────
//
// The sub-line is a short activity signal, not a raw command echo. Drill retains
// the raw command and output tail.

/** Tree hook + indent for the sub-line, per "### Agent row anatomy". */
const TOOL_ACTIVITY_HOOK = "└";
const TOOL_ACTIVITY_INDENT = "   ";
/** Field separator inside the sub-line (` · `, single-spaced — see the mockups). */
const TOOL_ACTIVITY_SEP = " · ";
/** Max columns for the extracted gist (REQ-004: the final gist is at most 24 columns). */
const TOOL_GIST_MAX_COLS = 24;
/** Tool elapsed appears only after this threshold, to avoid fast-call noise. */
const TOOL_ELAPSED_THRESHOLD_MS = 5000;
/** Priority order for extracting a concise tool-argument gist. */
const TOOL_ARG_PRIORITY_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"] as const;

/**
 * The action content (REQ-004): `<verb> · <gist>[ · <t-elapsed>]`, e.g.
 * `bash · npm test`, `read · app.ts`, `bash · npm test · 8s`. Returns `undefined`
 * when no tool is active — the «thinking» kind (a) carries state through the row's
 * own spinner/elapsed/↓tok and gets NO sub-line. The `· <t-elapsed>` timer appears
 * only once the tool has run `> 5s` (kind (c)); ≤5s stays `<verb> · <gist>` (kind (b)).
 *
 * The caller prepends the `└ ` hook + indent (see `#renderToolActivitySubLine`).
 */
export function formatToolActivity(
  row: AgentLiveRow,
  now: number = Date.now(),
  options: { showElapsed?: boolean } = {},
): string | undefined {
  const verb = activeToolVerb(row);
  if (verb === undefined) return undefined; // kind (a): no active tool → no sub-line
  // Resolution seam (REQ-004): `gist = intent ?? heuristic(args)`. model-intent
  // (`_i`/lastIntent) is a named future (Q-006/D-009) and is NOT sourced here — only
  // the heuristic runs today; an intent would slot in front without changing this format.
  const gist = toolActivityGist(row.currentToolArgs);
  const parts = [verb];
  if (gist !== "") parts.push(gist);
  // Calm rendering drops the running timer: it is the one part of the sub-line
  // whose text changes every second with no state transition behind it.
  const elapsed = options.showElapsed === false ? undefined : toolElapsedLabel(row.currentToolStartMs, now);
  if (elapsed !== undefined) parts.push(elapsed);
  return parts.join(TOOL_ACTIVITY_SEP);
}

/** The active tool = the most recently started tool still in flight, else undefined. */
function activeToolVerb(row: AgentLiveRow): string | undefined {
  return row.currentTools.at(-1);
}

/** `formatDuration` of the running tool, but only past the `>5s` threshold (kind (c)). */
function toolElapsedLabel(startMs: number | undefined, now: number): string | undefined {
  if (startMs === undefined) return undefined;
  const elapsed = now - startMs;
  return elapsed > TOOL_ELAPSED_THRESHOLD_MS ? formatDuration(elapsed) : undefined;
}

/**
 * gist heuristic: pick the first present priority-key from the parsed tool args,
 * then normalize BY KEY — shell command → command-head, path → basename, url → host,
 * everything else (pattern/query/task/prompt) → truncate. Capped at ≤24 columns.
 *
 * Never echoes raw JSON / arg-soup (forbidden by REQ-004): an object with no known
 * key — or an unparseable brace-string — yields `""`, so the composer degrades to a
 * verb-only sub-line (V1) rather than dumping `{…}`.
 */
export function toolActivityGist(argsRaw: string | undefined): string {
  const args = parseToolArgs(argsRaw);
  if (args !== undefined) {
    for (const key of TOOL_ARG_PRIORITY_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return capGist(normalizeToolArg(key, value.trim()));
    }
    return "";
  }
  // Non-object args: a plain descriptive string is usable, but never brace-soup.
  const trimmed = (argsRaw ?? "").trim();
  if (trimmed === "" || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return capGist(trimmed);
}

function normalizeToolArg(key: string, value: string): string {
  if (key === "command") return commandHead(value);
  if (key === "file_path" || key === "path") return basename(value);
  if (key === "url") return urlHost(value);
  return value; // pattern/query/task/prompt → plain truncate (applied by capGist)
}

function capGist(gist: string): string {
  return truncate(gist.trim(), TOOL_GIST_MAX_COLS);
}

/** Parse the args string only when it is a JSON object; otherwise `undefined`. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * command-head: a shell command → `binary [subcommand]`. Strips a `/bin/zsh -lc "…"`
 * / `/bin/sh -c '…'` wrapper and surrounding quotes, then keeps the binary plus its
 * next token IFF that token is not a flag: `npm test`, `git commit`; `python3 -c "…"`
 * → `python3` (the `-c` flag is dropped, not a subcommand).
 */
function commandHead(command: string): string {
  const inner = stripSurroundingQuotes(stripShellWrapper(command));
  const tokens = inner.split(/\s+/).filter((token) => token !== "");
  const binary = tokens[0];
  if (binary === undefined) return "";
  const sub = tokens[1];
  return sub !== undefined && !sub.startsWith("-") ? `${binary} ${sub}` : binary;
}

/** Strip a leading `sh -c` / `zsh -lc` / `bash -c` wrapper, returning the inner command. */
function stripShellWrapper(command: string): string {
  const match = command.trim().match(/^(?:\S*\/)?(?:zsh|bash|sh|dash)\s+-[a-z]*c\s+([\s\S]+)$/i);
  return match?.[1] !== undefined ? stripSurroundingQuotes(match[1].trim()) : command.trim();
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Last path segment (POSIX or Windows separators), trailing slashes ignored. */
function basename(pathValue: string): string {
  const cleaned = pathValue.trim().replace(/[/\\]+$/, "");
  const last = cleaned.split(/[/\\]/).at(-1);
  return last !== undefined && last !== "" ? last : cleaned;
}

/** Host of a URL; best-effort strip of scheme+path when it is not absolute. */
function urlHost(url: string): string {
  const value = url.trim();
  try {
    const host = new URL(value).host;
    if (host !== "") return host;
  } catch {
    /* not an absolute URL — fall through to a manual strip */
  }
  const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  return host !== "" ? host : value;
}

interface StatusMeta {
  icon: string;
  word: string;
  color: string;
}

export function statusMeta(status: AgentLiveStatus, spinnerIndex: number): StatusMeta {
  switch (status) {
    case "queued":
      return { icon: "○", word: "Queued", color: "dim" };
    case "working":
      return { icon: SPINNER_FRAMES[spinnerIndex] ?? "⠿", word: "Working", color: "accent" };
    case "done":
      return { icon: "✓", word: "Done", color: "success" };
    case "cancelled":
      return { icon: "⊘", word: "Cancelled", color: "dim" };
    case "error":
      return { icon: "✗", word: "Error", color: "warning" };
  }
}

export function elapsedSinceStart(row: AgentLiveRow): number | undefined {
  if (row.startedAt === undefined) return undefined;
  return Math.max(0, Date.now() - row.startedAt);
}

/**
 * Human-readable elapsed with s → m → h tiers; sub-second is hidden as `<1s`
 * instead of noisy millisecond counts (T-188 W7, fix-candidate #7).
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

/**
 * Coarse elapsed for calm rendering: the text holds still for whole buckets so
 * an otherwise-idle row renders byte-identical frames. Under a minute the value
 * moves in 10-second steps (`<10s`, `10s`, `20s`…); above it, whole minutes
 * (`1m`, `2m`, `1h5m`). Exactness returns on the terminal row, which records
 * its final duration.
 */
export function formatDurationCoarse(ms: number | undefined): string {
  if (ms === undefined) return "";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 10) return "<10s";
  if (totalSeconds < 60) return `${Math.floor(totalSeconds / 10) * 10}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

export function truncate(value: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(value) <= safeWidth) return value;
  const ellipsis = safeWidth > 3 ? "..." : "";
  if (value.includes("\u001b")) return truncateToWidth(value, safeWidth, ellipsis);
  return `${sliceByColumn(value, 0, Math.max(0, safeWidth - visibleWidth(ellipsis)))}${ellipsis}`;
}
