import { EventEmitter } from "node:events";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import {
  AgentLivePanel,
  compactWorkflowParentRows,
  orderAgentLiveRows,
  withWorkflowGroupTotals,
  type AgentLiveThemeLike,
} from "./agent-live-panel.js";
import { agentLiveStore, type AgentLiveRow } from "./agent-live-store.js";
import { framesEqual, RenderScheduler } from "../host/render-scheduler.js";
import { defaultRenderProfile } from "../host/render-profile.js";
import type { CustomUiComponent, CustomUiTui } from "../host/pi-api.js";

export const FLEET_MENU_MAX_ROWS = 8;
export const FLEET_FOCUS_FALLBACK_SHORTCUT = "shift+down";
/** Every selector in this TUI marks its cursor with `>`; the fleet is not a dialect of its own. */
export const FLEET_CURSOR_MARKER = ">";

export type FleetMenuAction = { kind: "close" } | { kind: "drill"; rowId: string } | { kind: "stop"; rowId: string };

interface KeybindingsLike {
  matches(
    data: string,
    keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  ): boolean;
}

/**
 * UI-only selection state. Runtime facts remain in AgentLiveStore; focus and a
 * cursor are ephemeral projections and must never mutate a row.
 */
class FleetMenuState {
  readonly emitter = new EventEmitter();
  #focused = false;
  #selectedRowId: string | undefined;
  /**
   * The frozen membership of the focused list, held as SOURCE row ids — the raw
   * store rows the projection consumes, workflow journal anchors included.
   *
   * Holding the projected ids instead is what broke `/ps` on a real fan-out: the
   * projection had already collapsed each anchor into its SDK child, so the
   * anchors were missing from the frozen set while the children resolved back
   * out of the store still carrying `parentRowId = <anchor id>`. Re-projecting
   * that set found no anchor to collapse, so no child was re-parented onto its
   * group, and every rule that reads the group's members — the heading's
   * `k/n done · f failed`, the working→failed→queued→done member ranking, and
   * the heading pinned above a window shorter than the fan-out — read a tree
   * that was not there.
   */
  #sourceRowIds: string[] = [];
  #emptyEditorFocusAvailable = false;
  #fallbackFocusAvailable = false;
  #projectionOwners = new Map<symbol, { priority: number; order: number }>();
  #projectionOwnerOrder = 0;

  get focused(): boolean {
    return this.#focused;
  }

  get selectedRowId(): string | undefined {
    return this.#selectedRowId;
  }

  get focusShortcutsAvailable(): boolean {
    return this.#fallbackFocusAvailable;
  }

  get emptyEditorFocusAvailable(): boolean {
    return this.#emptyEditorFocusAvailable;
  }

  get fallbackFocusAvailable(): boolean {
    return this.#fallbackFocusAvailable;
  }

  /** Compatibility setter for older tests/consumers; new code sets each path honestly. */
  setFocusShortcutsAvailable(available: boolean): void {
    const changed = this.#emptyEditorFocusAvailable !== available || this.#fallbackFocusAvailable !== available;
    if (!changed) return;
    this.#emptyEditorFocusAvailable = available;
    this.#fallbackFocusAvailable = available;
    this.emitter.emit("change");
  }

  setEmptyEditorFocusAvailable(available: boolean): void {
    if (this.#emptyEditorFocusAvailable === available) return;
    this.#emptyEditorFocusAvailable = available;
    this.emitter.emit("change");
  }

  setFallbackFocusAvailable(available: boolean): void {
    if (this.#fallbackFocusAvailable === available) return;
    this.#fallbackFocusAvailable = available;
    this.emitter.emit("change");
  }

  setFocused(focused: boolean): void {
    if (this.#focused === focused) return;
    this.#focused = focused;
    this.emitter.emit("change");
  }

  /**
   * `initialRowId` is the seed a reopened menu asks for — the row the operator
   * drilled into. It is honoured only while that row is still a selectable leaf;
   * a row retired during the drill falls back to the usual preferred row.
   */
  beginFocus(rows: AgentLiveRow[], initialRowId?: string): void {
    this.#sourceRowIds = rows.map((row) => row.id);
    const visibleRows = this.visibleRows();
    if (initialRowId !== undefined && selectFleetMenuLeafRows(visibleRows).some((row) => row.id === initialRowId)) {
      this.#selectedRowId = initialRowId;
    }
    this.#normalizeSelection(visibleRows);
  }

  setVisibleRows(rows: AgentLiveRow[]): void {
    this.#sourceRowIds = rows.map((row) => row.id);
    this.#normalizeSelection(this.visibleRows());
  }

  /**
   * The rows the focused list shows: the frozen membership, read live out of the
   * store and put through the shared projection. Focus freezes WHICH rows the
   * list owns, never the shape they project into, so every consumer — the cursor,
   * the renderer, the heading — sees one tree.
   */
  visibleRows(): AgentLiveRow[] {
    return projectFleetMenuSnapshotRows(this.#sourceRows());
  }

  #sourceRows(): AgentLiveRow[] {
    return this.#sourceRowIds
      .map((id) => agentLiveStore.rows.get(id))
      .filter((row): row is AgentLiveRow => row !== undefined);
  }

  move(delta: -1 | 1, rows: AgentLiveRow[]): void {
    const selectableRows = selectFleetMenuLeafRows(rows);
    if (selectableRows.length === 0) return;
    const currentIndex = selectableRows.findIndex((row) => row.id === this.#selectedRowId);
    const start = currentIndex < 0 ? 0 : currentIndex;
    const next = Math.max(0, Math.min(selectableRows.length - 1, start + delta));
    const nextId = selectableRows[next]?.id;
    if (nextId === undefined || nextId === this.#selectedRowId) return;
    this.#selectedRowId = nextId;
    this.emitter.emit("change");
  }

  reconcileVisibleRows(): void {
    const liveIds = this.#sourceRows().map((row) => row.id);
    const membershipChanged = liveIds.length !== this.#sourceRowIds.length;
    if (membershipChanged) this.#sourceRowIds = liveIds;
    const selectionChanged = this.#normalizeSelection(this.visibleRows());
    if (!membershipChanged && !selectionChanged) return;
    this.emitter.emit("change");
  }

  registerProjectionOwner(priority: number): FleetProjectionOwner {
    const id = Symbol("fleet-projection-owner");
    this.#projectionOwners.set(id, { priority, order: ++this.#projectionOwnerOrder });
    if (this.#focused) this.emitter.emit("change");
    let released = false;
    return {
      isPrimary: () => this.#primaryProjectionOwner() === id,
      release: () => {
        if (released) return;
        released = true;
        this.#projectionOwners.delete(id);
        if (this.#focused) this.emitter.emit("change");
      },
    };
  }

  get hasProjectionOwner(): boolean {
    return this.#projectionOwners.size > 0;
  }

  #normalizeSelection(rows: AgentLiveRow[]): boolean {
    const previous = this.#selectedRowId;
    const selectableRowIds = new Set(selectFleetMenuLeafRows(rows).map((row) => row.id));
    if (this.#selectedRowId === undefined || !selectableRowIds.has(this.#selectedRowId)) {
      this.#selectedRowId = preferredInitialRow(rows)?.id;
    }
    return previous !== this.#selectedRowId;
  }

  #primaryProjectionOwner(): symbol | undefined {
    return [...this.#projectionOwners.entries()]
      .sort((a, b) => b[1].priority - a[1].priority || b[1].order - a[1].order)
      .at(0)?.[0];
  }
}

export interface FleetProjectionOwner {
  isPrimary(): boolean;
  release(): void;
}

const FLEET_MENU_STATE_GLOBAL_KEY = Symbol.for("locus-pi.fleet-menu-state.v3");
const FLEET_VIEWED_ROW_GLOBAL_KEY = Symbol.for("locus-pi.fleet-viewed-row.v1");
interface SharedFleetMenuStateSlot {
  version: 3;
  state: FleetMenuState;
}

interface SharedFleetViewedRowSlot {
  version: 1;
  readonly rowsByViewer: Map<symbol, string>;
}

function sharedFleetMenuState(): FleetMenuState {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[FLEET_MENU_STATE_GLOBAL_KEY];
  if (existing !== undefined) {
    if (!isSharedFleetMenuStateSlot(existing)) throw new Error("locus-pi: incompatible global fleet-menu state slot");
    return existing.state as FleetMenuState;
  }
  const slot: SharedFleetMenuStateSlot = { version: 3, state: new FleetMenuState() };
  Object.defineProperty(runtimeGlobal, FLEET_MENU_STATE_GLOBAL_KEY, {
    value: slot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return slot.state;
}

function isSharedFleetMenuStateSlot(value: unknown): value is SharedFleetMenuStateSlot {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.state)) return false;
  return (
    typeof value.state.setFocused === "function" &&
    typeof value.state.visibleRows === "function" &&
    typeof value.state.setEmptyEditorFocusAvailable === "function" &&
    typeof value.state.registerProjectionOwner === "function"
  );
}

export const fleetMenuState = sharedFleetMenuState();

export function registerFleetProjectionOwner(priority: number): FleetProjectionOwner {
  return fleetMenuState.registerProjectionOwner(priority);
}

function sharedFleetViewedRowSlot(): SharedFleetViewedRowSlot {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[FLEET_VIEWED_ROW_GLOBAL_KEY];
  if (existing !== undefined) {
    if (!isRecord(existing) || existing.version !== 1 || !(existing.rowsByViewer instanceof Map)) {
      throw new Error("locus-pi: incompatible global fleet-viewed-row slot");
    }
    return existing as unknown as SharedFleetViewedRowSlot;
  }
  const slot: SharedFleetViewedRowSlot = { version: 1, rowsByViewer: new Map() };
  Object.defineProperty(runtimeGlobal, FLEET_VIEWED_ROW_GLOBAL_KEY, {
    value: slot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return slot;
}

const fleetViewedRows = sharedFleetViewedRowSlot();

/**
 * Lease the row whose transcript currently owns Pi's inline viewer. The newest
 * viewer wins; releasing it restores an older overlapping viewer, if one exists.
 */
export function acquireFleetViewedRow(rowId: string): () => void {
  const owner = Symbol("fleet-viewer-row-owner");
  fleetViewedRows.rowsByViewer.set(owner, rowId);
  fleetMenuState.emitter.emit("change");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fleetViewedRows.rowsByViewer.delete(owner);
    fleetMenuState.emitter.emit("change");
  };
}

/** The row shown by the currently foregrounded agent transcript viewer. */
export function fleetViewedRowId(): string | undefined {
  return [...fleetViewedRows.rowsByViewer.values()].at(-1);
}

/** Stable active-first projection, capped to the eight rows the menu can own. */
export function selectFleetMenuRows(rows: AgentLiveRow[], limit = FLEET_MENU_MAX_ROWS): AgentLiveRow[] {
  const ordered = orderAgentLiveRows(rows);
  if (ordered.length <= limit) return ordered;
  const active = ordered.filter((row) => row.status === "working" || row.status === "queued");
  const terminal = ordered.filter(
    (row) => row.status === "done" || row.status === "cancelled" || row.status === "error",
  );
  const selected = [...active.slice(0, limit), ...terminal.slice(-Math.max(0, limit - active.length))];
  const ids = new Set(selected.map((row) => row.id));
  return ordered.filter((row) => ids.has(row.id)).slice(0, limit);
}

/** Aggregate/anchor rows remain visible headings; only terminal child/agent rows are actionable. */
export function selectFleetMenuLeafRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const parentIds = new Set(rows.flatMap((row) => (row.parentRowId === undefined ? [] : [row.parentRowId])));
  return rows.filter((row) => row.groupKind === undefined && !parentIds.has(row.id));
}

/** Workflow-owned rows are inspectable here but stop only through /workflows stop. */
export function isFleetRowStoppable(row: AgentLiveRow | undefined): row is AgentLiveRow {
  return row?.status === "working" && row.groupKind === undefined && row.workflowRunId === undefined;
}

export interface RenderFleetMenuOptions {
  focused?: boolean;
  selectedRowId?: string;
  spinnerIndex?: number;
  theme?: AgentLiveThemeLike;
  /** Retained for compatibility with older widgets; bare arrows are never fleet shortcuts. */
  emptyEditorFocusAvailable?: boolean;
  /** Shift+Down remains available when raw terminal Down cannot be used. */
  fallbackFocusAvailable?: boolean;
  /** Legacy combined capability flag; prefer the two explicit fields above. */
  focusShortcutsAvailable?: boolean;
  /** Calm rendering (render-profile.ts): coarse elapsed text, no per-second tool timer. */
  calm?: boolean;
  /** Focused viewport row budget supplied by the owning terminal panel. */
  maxRows?: number;
}

/**
 * One row projection for passive and focused modes. Focus changes only the
 * two-column cursor prefix; the row text itself comes from AgentLivePanel in
 * both modes, so entering management mode cannot move or reformat the fleet.
 */
export function renderFleetMenuRows(
  sourceRows: AgentLiveRow[],
  width: number,
  options: RenderFleetMenuOptions = {},
): string[] {
  if (options.focused === true) {
    const snapshotRows = projectFleetMenuSnapshotRows(sourceRows);
    const viewport = focusedFleetViewport(snapshotRows, options.selectedRowId, options.maxRows);
    return renderProjectedFleetMenuRows(viewport.rows, width, options, {
      before: viewport.hiddenBefore,
      after: viewport.hiddenAfter,
    });
  }
  const rows = projectFleetMenuRows(sourceRows);
  return renderProjectedFleetMenuRows(rows, width, options, { after: Math.max(0, sourceRows.length - rows.length) });
}

function projectFleetMenuRows(sourceRows: AgentLiveRow[]): AgentLiveRow[] {
  return partitionEarlierWorkflowRunRows(
    selectFleetMenuRows(withWorkflowGroupTotals(compactWorkflowParentRows(sourceRows))),
  );
}

/**
 * The focused `/ps` row set. Idempotent, and it has to be: the focused state
 * projects its frozen membership here, and `renderFleetMenuRows` projects again
 * on whatever it is handed, so a caller that passes an already-projected set
 * must get it back unchanged.
 */
function projectFleetMenuSnapshotRows(sourceRows: AgentLiveRow[]): AgentLiveRow[] {
  return partitionEarlierWorkflowRunRows(
    orderAgentLiveRows(withWorkflowGroupTotals(compactWorkflowParentRows(sourceRows))),
  );
}

/**
 * The window of rows the focused list shows, plus what it left off each end.
 *
 * The window is anchored on the cursor, and only leaf rows take the cursor, so
 * a fan-out longer than the window would scroll its own group heading off the
 * top and leave the operator looking at a wall of `↳` rows belonging to nothing
 * visible. The heading is not selectable, so no key can bring it back. It is
 * therefore pinned: when the first row of the window is a member of a group
 * whose heading sits above the window, the heading is re-shown on the line
 * above it.
 *
 * It is added to the window rather than taken out of it, the way the "earlier
 * workflow runs" label below is: `/ps` gives up no agent row (that is the
 * passive progress panel's job), and a heading nobody can select must not cost
 * an operator a row they can.
 *
 * Only the nearest ancestor heading is pinned — one line of context, so a
 * deeply nested fan-out cannot spend the whole viewport on headings.
 */
function focusedFleetViewport(
  rows: AgentLiveRow[],
  selectedRowId: string | undefined,
  requestedLimit = FLEET_MENU_MAX_ROWS,
): { rows: AgentLiveRow[]; hiddenBefore: number; hiddenAfter: number } {
  const limit = Math.max(1, Math.min(FLEET_MENU_MAX_ROWS, Math.floor(requestedLimit)));
  if (rows.length <= limit) return { rows, hiddenBefore: 0, hiddenAfter: 0 };
  const selectedIndex = rows.findIndex((row) => row.id === selectedRowId);
  const start = Math.max(0, Math.min(selectedIndex < 0 ? 0 : selectedIndex, rows.length - limit));
  const end = Math.min(rows.length, start + limit);
  const window = rows.slice(start, end);
  const heading = groupHeadingAboveWindow(rows, start);
  return {
    rows: heading === undefined ? window : [heading, ...window],
    hiddenBefore: selectFleetMenuLeafRows(rows.slice(0, start)).length,
    hiddenAfter: selectFleetMenuLeafRows(rows.slice(end)).length,
  };
}

/** The nearest group heading of the row at `start`, when it is above the window. */
function groupHeadingAboveWindow(rows: AgentLiveRow[], start: number): AgentLiveRow | undefined {
  const first = rows[start];
  if (first === undefined) return undefined;
  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  const seen = new Set<string>([first.id]);
  let parentRowId = first.parentRowId;
  while (parentRowId !== undefined && !seen.has(parentRowId)) {
    seen.add(parentRowId);
    const index = indexById.get(parentRowId);
    if (index === undefined) return undefined;
    const parent = rows[index]!;
    if (parent.groupKind !== undefined) return index < start ? parent : undefined;
    parentRowId = parent.parentRowId;
  }
  return undefined;
}

/**
 * Rows of the last few completed workflow runs stay drillable, so a re-run agent
 * appears once per run and the list reads as one confusing fleet. Keeping the
 * newest run (and every standalone agent) first, with earlier runs behind them
 * in their existing order, makes "what is running now" the top of the list
 * without hiding anything.
 *
 * Run ids are timestamp-prefixed, so lexicographic order is chronological.
 */
function partitionEarlierWorkflowRunRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const newestRunId = newestWorkflowRunId(rows);
  if (newestRunId === undefined) return rows;
  const current = rows.filter((row) => row.workflowRunId === undefined || row.workflowRunId === newestRunId);
  const earlier = rows.filter((row) => row.workflowRunId !== undefined && row.workflowRunId !== newestRunId);
  return earlier.length === 0 ? rows : orderAgentLiveRows([...current, ...earlier]);
}

export function newestWorkflowRunId(rows: readonly AgentLiveRow[]): string | undefined {
  let newest: string | undefined;
  for (const row of rows) {
    const runId = row.workflowRunId;
    if (runId === undefined) continue;
    if (newest === undefined || runId > newest) newest = runId;
  }
  return newest;
}

function renderProjectedFleetMenuRows(
  rows: AgentLiveRow[],
  width: number,
  options: RenderFleetMenuOptions,
  hidden: { before?: number; after?: number },
): string[] {
  if (rows.length === 0) return [];
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const panel = new AgentLivePanel({
    ...(options.spinnerIndex !== undefined ? { spinnerIndex: options.spinnerIndex } : {}),
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
    ...(options.calm === true ? { calm: true } : {}),
  });
  const focused = options.focused === true;
  const selectedRowId = options.selectedRowId;
  const newestRunId = newestWorkflowRunId(rows);
  let earlierRunsAnnounced = false;
  const lines = rows.flatMap((row) => {
    const heading: string[] = [];
    // One label is enough to answer "am I looking at this run or the last one".
    if (
      !earlierRunsAnnounced &&
      newestRunId !== undefined &&
      row.workflowRunId !== undefined &&
      row.workflowRunId !== newestRunId
    ) {
      earlierRunsAnnounced = true;
      heading.push(truncateToWidth("  earlier workflow runs", safeWidth));
    }
    const projected = panel.renderRows([row], Math.max(1, safeWidth - 2));
    return [
      ...heading,
      ...projected.map((line, index) => {
        // The cursor column is always two cells wide, so selecting a row shifts
        // nothing; only the marker and its accent tell the eye where it is.
        const selected = index === 0 && focused && row.groupKind === undefined && row.id === selectedRowId;
        const prefix = selected ? style(options.theme, "accent", `${FLEET_CURSOR_MARKER} `) : "  ";
        return truncateToWidth(`${prefix}${line}`, safeWidth);
      }),
    ];
  });
  if ((hidden.before ?? 0) > 0) lines.unshift(truncateToWidth(`  ↑ ${hidden.before} earlier`, safeWidth));
  if ((hidden.after ?? 0) > 0) {
    const label = focused ? `  ↓ ${hidden.after} later` : `  … and ${hidden.after} more`;
    lines.push(truncateToWidth(label, safeWidth));
  }
  const selected = rows.find((row) => row.groupKind === undefined && row.id === selectedRowId);
  const focusedHint = [
    safeKeyHint("tui.select.confirm", "drill", "enter drill"),
    ...(isFleetRowStoppable(selected) ? [safeRawKeyHint("x", "stop")] : []),
    safeKeyHint("tui.select.cancel", "back", "esc back"),
  ].join(" · ");
  const legacyAvailability = options.focusShortcutsAvailable === true;
  const fallbackFocusAvailable = options.fallbackFocusAvailable ?? legacyAvailability;
  const passiveControls = [
    ...(fallbackFocusAvailable ? [safeRawKeyHint(FLEET_FOCUS_FALLBACK_SHORTCUT, "manage")] : []),
  ];
  const hint = focused
    ? focusedHint
    : passiveControls.length === 0
      ? "fleet manage unavailable on this host"
      : passiveControls.join(" · ");
  // Passive panels keep this footer below the editor. The focused selector
  // renders the same row grammar and owns its own actionable footer.
  lines.push(truncateToWidth(`  ${hint}`, safeWidth));
  return lines;
}

/** Focused selector: the agents extension supplies global rows; this owns cursor projection and keys. */
export class FleetFocusComponent implements CustomUiComponent {
  #disposed = false;
  #closed = false;
  readonly #requestRender: () => void;
  readonly #scheduler: RenderScheduler;

  readonly #calm: boolean;
  /**
   * Last frame handed to the host, keyed by width. The scheduler callback
   * projects the next frame first and stays silent when it is byte-identical —
   * on a console where every repaint blinks, store churn that changes nothing
   * visible must not reach the terminal at all.
   */
  #lastFrame: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly rows: () => AgentLiveRow[],
    private readonly keybindings: unknown,
    private readonly tui: CustomUiTui,
    private readonly done: (action: FleetMenuAction) => void,
    private readonly theme: AgentLiveThemeLike = {},
  ) {
    this.#calm = defaultRenderProfile().calm;
    // Store churn is coalesced; keystrokes below stay on the direct path so the
    // cursor never lags behind the operator.
    this.#scheduler = new RenderScheduler(() => this.#paintIfChanged());
    this.#requestRender = () => this.#scheduler.request();
    agentLiveStore.emitter.on("change", this.#requestRender);
    if (fleetMenuState.visibleRows().length === 0) fleetMenuState.beginFocus(this.rows());
  }

  #paintIfChanged(): void {
    if (this.#disposed) return;
    fleetMenuState.reconcileVisibleRows();
    const previous = this.#lastFrame;
    if (previous === undefined) {
      this.tui.requestRender();
      return;
    }
    // render() is a pure projection over the shared store (setVisibleRows only
    // normalizes the cursor and never emits), so a speculative call is safe.
    const next = this.render(previous.width);
    if (framesEqual(previous.lines, next)) return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.#disposed) return [];
    fleetMenuState.reconcileVisibleRows();
    const rows = fleetMenuState.visibleRows();
    if (fleetMenuState.hasProjectionOwner) {
      this.#lastFrame = { width, lines: [] };
      return [];
    }
    const lines = renderFleetMenuRows(rows, width, {
      focused: true,
      ...(fleetMenuState.selectedRowId !== undefined ? { selectedRowId: fleetMenuState.selectedRowId } : {}),
      theme: this.theme,
      ...(this.#calm ? { calm: true } : {}),
    });
    this.#lastFrame = { width, lines };
    return lines;
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    fleetMenuState.reconcileVisibleRows();
    const rows = fleetMenuState.visibleRows();
    if (matchesConfigured(this.keybindings, data, "tui.select.up", Key.up)) {
      fleetMenuState.move(-1, rows);
      this.tui.requestRender();
      return;
    }
    if (matchesConfigured(this.keybindings, data, "tui.select.down", Key.down)) {
      fleetMenuState.move(1, rows);
      this.tui.requestRender();
      return;
    }
    if (matchesConfigured(this.keybindings, data, "tui.select.confirm", Key.enter)) {
      const rowId = fleetMenuState.selectedRowId;
      if (rowId !== undefined) this.done({ kind: "drill", rowId });
      return;
    }
    if (data === "x") {
      const row = rows.find((candidate) => candidate.id === fleetMenuState.selectedRowId);
      if (isFleetRowStoppable(row)) this.done({ kind: "stop", rowId: row.id });
      this.tui.requestRender();
      return;
    }
    if (matchesConfigured(this.keybindings, data, "tui.select.cancel", Key.escape)) {
      this.done({ kind: "close" });
    }
  }

  invalidate(): void {
    if (this.#disposed) return;
    // A theme or layout change renders the same store to different bytes; the
    // identity baseline must not survive it.
    this.#lastFrame = undefined;
  }

  /**
   * Hand the editor back through the host's own close path, the way Escape does.
   *
   * An owner that only calls `dispose()` leaves Pi's `custom()` promise pending
   * — Pi resolves it from its close callback and nowhere else — so the editor
   * container keeps a dead surface and the command awaiting this menu never
   * returns. Reporting the same `close` action the operator's Escape reports is
   * what makes a session-scoped teardown survivable.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
    this.done({ kind: "close" });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    agentLiveStore.emitter.off("change", this.#requestRender);
    // A trailing render must not outlive the component and paint over whatever
    // the host put in the editor slot next.
    this.#scheduler.cancel();
  }
}

function preferredInitialRow(rows: AgentLiveRow[]): AgentLiveRow | undefined {
  const selectableRows = selectFleetMenuLeafRows(rows);
  return (
    selectableRows.find((row) => row.status === "working") ??
    selectableRows.find((row) => row.status === "queued") ??
    selectableRows.at(-1)
  );
}

function matchesConfigured(
  value: unknown,
  data: string,
  keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  fallback: KeyId,
): boolean {
  if (isKeybindingsLike(value)) return value.matches(data, keybinding);
  return data === fallback || matchesKey(data, fallback);
}

function isKeybindingsLike(value: unknown): value is KeybindingsLike {
  return isRecord(value) && typeof value.matches === "function";
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** Themeless hosts (headless tests, string-widget fallbacks) still get readable text. */
function style(theme: AgentLiveThemeLike | undefined, color: string, text: string): string {
  return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
}

function safeKeyHint(
  keybinding: "tui.select.confirm" | "tui.select.cancel",
  description: string,
  fallback: string,
): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    // Headless/unit hosts do not initialize Pi's global theme. The component is
    // still renderable, while interactive Pi takes the configured keyHint path.
    return fallback;
  }
}

function safeRawKeyHint(key: string, description: string): string {
  try {
    return rawKeyHint(key, description);
  } catch {
    return `${key} ${description}`;
  }
}
