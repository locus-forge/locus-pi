import type { CustomUiComponent, ExtensionContext, WidgetFactoryTui } from "../../_shared/host/pi-api.js";
import { DEFAULT_RENDER_MIN_INTERVAL_MS, framesEqual, RenderScheduler } from "../../_shared/host/render-scheduler.js";
import { coerceTheme, defaultRenderProfile, type ThemeLike } from "../../_shared/host/render-profile.js";
import { agentLiveStore, type AgentLiveRow } from "../../_shared/agent-runtime/agent-live-store.js";
import {
  AgentLivePanel,
  AGENT_LIVE_SPINNER_FRAME_COUNT,
  compactWorkflowParentRows,
  countAgentLiveStatuses,
  orderAgentLiveRows,
  selectAgentLiveRowsForParents,
  truncate,
  withWorkflowGroupTotals,
} from "../../_shared/agent-runtime/agent-live-panel.js";
import {
  fleetMenuState,
  registerFleetProjectionOwner,
  fleetViewedRowId,
  renderFleetMenuRows,
  selectFleetMenuLeafRows,
} from "../../_shared/agent-runtime/fleet-menu.js";
import { formatWorkflowFailureDiagnosticLines, type WorkflowFailureDiagnostic } from "../runtime/workflow-failure.js";
import { workflowAgentLiveRowId, workflowGroupLiveRowId } from "../runtime/workflow-live.js";
import {
  projectWorkflowDisposition,
  type WorkflowDisposition,
  type WorkflowProjectedStatus,
} from "../runtime/workflow-outcome.js";
import type { WorkflowResultPersistence } from "../runtime/workflow-result.js";
import { FLEET_MENU_PLACEMENT } from "../../_shared/operator/widget-render.js";
import { clearViewerExternalRows, setViewerExternalRows } from "../../_shared/operator/viewer-geometry.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import {
  agentCollapseRank,
  alignWorkflowRail,
  clampRosterLines,
  currentWorkflowPhase,
  fitLines,
  focusedFleetRowBudget,
  formatCompactTokenCount,
  formatProgressTailLine,
  isTerminalRosterStatus,
  normalizeWorkflowPhase,
  ROSTER_COLLAPSE_RANK_FINISHED,
  ROSTER_COLLAPSE_RANK_LIVE,
  ROSTER_COLLAPSE_RANK_TERMINAL_GROUP_HEADING,
  shortWorkflowRunId,
  workflowProgressDonePresentation,
  workflowProgressStatusLabel,
  workflowProgressStatusMark,
  workflowRailRef,
  workflowStageFrontier,
  type WorkflowDeclaredStage,
} from "./progress-render.js";

/**
 * Ownership re-exports. Three responsibilities that used to live in this file now
 * belong to the modules that own them; this widget keeps NAMED re-exports so an
 * existing importer of the old owner still resolves:
 *
 *   - `coerceTheme` / `ThemeLike` → `_shared/host/render-profile.ts` (host contract);
 *   - the layout helpers and `WorkflowDeclaredStage` → `./progress-render.ts`;
 *   - `renderAgentObserverText` → `agents/operator/agent-observer.ts`, which this
 *     file may NOT import (workflows may not reach into the agents feature), so
 *     it is not re-exported here — its one caller imports the new owner directly.
 */
export { coerceTheme, type ThemeLike } from "../../_shared/host/render-profile.js";
export { type WorkflowDeclaredStage } from "./progress-render.js";

export const WORKFLOW_LIVE_WIDGET_KEY = "workflows-live";

const LIVE_TICK_MS = 1000;
const WORKFLOW_RAIL_BACKGROUND = "\u001b[48;2;88;61;121m";
const WORKFLOW_RAIL_FOREGROUND = "\u001b[38;2;248;241;255m";
const WORKFLOW_RAIL_RESET = "\u001b[0m";
const WORKFLOW_VIEWER_RESERVATION_OWNER = "workflow-live";
const NOOP_TUI: WidgetFactoryTui = { requestRender: () => {} };

export interface WorkflowProgressOptions {
  scope?: "fleet" | "workflow";
  /** Statically declared stages (`meta.phases`): titles plus their planned detail. */
  declaredStages?: readonly WorkflowDeclaredStage[];
  /** Source run whose settled agents stay visible while an operator continuation runs. */
  continuationSourceRunId?: string;
  /** Render coalescing window; `0` renders on every change. Defaults to the shared 4 fps ceiling. */
  renderMinIntervalMs?: number;
  /**
   * Calm rendering: frozen spinner, coarse elapsed, no per-second tool timer —
   * so an idle fleet produces byte-identical frames and the identity gate
   * suppresses every repaint. Defaults from render-profile.ts (auto-on under WSL).
   */
  calm?: boolean;
  /** Internal host wiring: only an installed below-editor component may own focused fleet projection. */
  ownsFleetProjection?: boolean;
}

export class WorkflowProgressComponent implements CustomUiComponent {
  journal: WorkflowJournalLine[] = [];
  done?: {
    status: WorkflowProjectedStatus;
    summary: string;
    runDir?: string;
    resultTextPath?: string;
    resultPersistence?: WorkflowResultPersistence;
    failureDiagnostic?: WorkflowFailureDiagnostic;
  };
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #spinnerIndex = 0;
  #disposed = false;
  readonly #knownRowIds = new Set<string>();
  readonly #scheduler: RenderScheduler;
  readonly #calm: boolean;
  /**
   * The last frame handed to the host, keyed by the width it was built for.
   * Compared against a fresh projection to suppress repaints that would change
   * nothing on screen. Cleared by `invalidate()` so a theme or layout change
   * can never be masked by a stale identity proof.
   */
  #lastFrame: { width: number; lines: string[] } | undefined;
  readonly #onStoreChange = () => {
    this.#syncLiveTimer();
    this.#scheduler.request();
  };
  #fleetProjectionOwner: ReturnType<typeof registerFleetProjectionOwner> | undefined;

  constructor(
    public tui: WidgetFactoryTui,
    public theme: ThemeLike,
    readonly scriptRef: string,
    readonly runId: string,
    readonly options: WorkflowProgressOptions = {},
  ) {
    this.#calm = options.calm ?? defaultRenderProfile().calm;
    this.#scheduler = new RenderScheduler(() => this.#paintIfChanged(), {
      minIntervalMs: options.renderMinIntervalMs ?? DEFAULT_RENDER_MIN_INTERVAL_MS,
    });
    agentLiveStore.emitter.on("change", this.#onStoreChange);
    fleetMenuState.emitter.on("change", this.#onStoreChange);
    this.#syncLiveTimer();
  }

  /**
   * Project the next frame and ask for a paint only when it differs from the
   * one already on screen. The store emits on every row mutation, and most of
   * those — `lastActivityAt` bumps, undisplayed event lines, sub-second elapsed
   * drift — produce a byte-identical panel.
   */
  #paintIfChanged(): void {
    if (this.#disposed && this.done === undefined) return;
    const previous = this.#lastFrame;
    const width = previous?.width ?? this.tui.terminal?.columns ?? 80;
    const next = this.render(width);
    if (previous !== undefined && previous.width === width && framesEqual(previous.lines, next)) return;
    this.tui.requestRender();
  }

  attachTui(tui: WidgetFactoryTui): void {
    this.tui = tui;
    if (this.options.ownsFleetProjection === true && this.#fleetProjectionOwner === undefined) {
      this.#fleetProjectionOwner = registerFleetProjectionOwner(this.options.scope === "workflow" ? 2 : 1);
    }
    this.#syncLiveTimer();
  }

  invalidate(): void {
    // Pi invalidates render/theme cache without disposing live progress state.
    // The cached frame is part of that cache: a re-themed panel renders the
    // same source to different bytes, so the identity gate must not hold it.
    this.#lastFrame = undefined;
  }

  dispose(): void {
    clearViewerExternalRows(WORKFLOW_VIEWER_RESERVATION_OWNER);
    this.#stopRuntimeUpdates();
    this.#fleetProjectionOwner?.release();
    this.#fleetProjectionOwner = undefined;
  }

  #stopRuntimeUpdates(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    agentLiveStore.emitter.off("change", this.#onStoreChange);
    fleetMenuState.emitter.off("change", this.#onStoreChange);
    this.#scheduler.cancel();
    this.#stopLiveTimer();
  }

  push(line: WorkflowJournalLine): void {
    this.journal.push(line);
    if (line.agent !== undefined) this.#knownRowIds.add(workflowAgentLiveRowId(line));
    else if (line.kind === "group_start" || line.kind === "group_end") {
      this.#knownRowIds.add(workflowGroupLiveRowId(line));
    }
    this.#syncLiveTimer();
    // A journal line usually also mutates the live store, so this and
    // `#onStoreChange` fire back to back; the scheduler folds them into one frame.
    this.#scheduler.request();
  }

  finish(res: {
    ok: boolean;
    error?: string;
    result?: unknown;
    disposition?: WorkflowDisposition;
    runDir?: string;
    resultTextPath?: string;
    resultPersistence?: WorkflowResultPersistence;
    failureDiagnostic?: WorkflowFailureDiagnostic;
  }): void {
    const disposition = projectWorkflowDisposition({
      ok: res.ok,
      result: res.result,
      ...(res.error !== undefined ? { error: res.error } : {}),
      ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
    });
    this.done = {
      status: disposition.status,
      summary: disposition.summary,
      ...(res.runDir !== undefined ? { runDir: res.runDir } : {}),
      ...(res.resultTextPath !== undefined ? { resultTextPath: res.resultTextPath } : {}),
      ...(res.resultPersistence !== undefined ? { resultPersistence: res.resultPersistence } : {}),
      ...(res.failureDiagnostic !== undefined ? { failureDiagnostic: res.failureDiagnostic } : {}),
    };
    this.#stopRuntimeUpdates();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = this.#project(width);
    // Always cache what was actually produced, including host-initiated renders
    // (typing, resize), so the identity gate compares against what is on screen.
    this.#lastFrame = { width, lines };
    return lines;
  }

  /** Pull-based projection. Never serves a cached frame — the cache is only a comparison baseline. */
  #project(width: number): string[] {
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, Math.min(rows - 6, 24));
    const liveRows = this.visibleRows();
    const doneLines = this.doneLines(width);
    const header = this.renderHeader(width, liveRows);
    if (fleetMenuState.focused && this.#fleetProjectionOwner !== undefined && !this.#fleetProjectionOwner.isPrimary()) {
      const rendered = fitLines([header, ...doneLines], [], budget, width, doneLines.length);
      setViewerExternalRows(WORKFLOW_VIEWER_RESERVATION_OWNER, rendered.length);
      return rendered;
    }
    if (this.options.scope !== "workflow") {
      const focused = fleetMenuState.focused && this.#fleetProjectionOwner?.isPrimary() === true;
      const fleetLines = renderFleetMenuRows(focused ? fleetMenuState.visibleRows() : liveRows, width, {
        spinnerIndex: this.#spinnerIndex,
        theme: this.theme,
        ...(focused ? { focused: true } : {}),
        ...(focused ? { maxRows: focusedFleetRowBudget(budget) } : {}),
        ...(focused && fleetMenuState.selectedRowId !== undefined
          ? { selectedRowId: fleetMenuState.selectedRowId }
          : {}),
        emptyEditorFocusAvailable: fleetMenuState.emptyEditorFocusAvailable,
        fallbackFocusAvailable: fleetMenuState.fallbackFocusAvailable,
        ...(this.#calm ? { calm: true } : {}),
      });
      const fleetFooter = fleetLines.at(-1);
      const fleetBody = fleetFooter === undefined ? [] : fleetLines.slice(0, -1);
      const fixedLines = [header, ...fleetBody, ...doneLines];
      const tailLines = this.progressTailLines(width);
      if (fleetFooter === undefined) return fitLines(fixedLines, tailLines, budget, width, doneLines.length);
      return [...fitLines(fixedLines, tailLines, Math.max(0, budget - 1), width, doneLines.length), fleetFooter];
    }

    if (fleetMenuState.focused && this.#fleetProjectionOwner?.isPrimary() === true) {
      const fleetLines = renderFleetMenuRows(fleetMenuState.visibleRows(), width, {
        focused: true,
        maxRows: focusedFleetRowBudget(budget),
        ...(fleetMenuState.selectedRowId !== undefined ? { selectedRowId: fleetMenuState.selectedRowId } : {}),
        spinnerIndex: this.#spinnerIndex,
        theme: this.theme,
        ...(this.#calm ? { calm: true } : {}),
      });
      const body = [header, ...fleetLines, ...doneLines];
      const rendered = fitLines(body, [], budget, width, doneLines.length);
      setViewerExternalRows(WORKFLOW_VIEWER_RESERVATION_OWNER, rendered.length);
      return rendered;
    }

    const passiveDiagnostics = this.journal
      .filter(
        (line) =>
          line.kind === "error" ||
          (line.kind === "agent_end" && line.evidenceWarnings !== undefined && line.evidenceWarnings.length > 0),
      )
      .slice(-2)
      .map((line) => truncate(formatProgressTailLine(line), width));
    // One workflow rail owns workflow identity, stage, counters, tokens, and
    // commands. Agent rows begin immediately beneath it; no detached hint/stage
    // rows can be mistaken for another footer.
    const fixedCount = 1 + doneLines.length + passiveDiagnostics.length;
    const rowLines = this.renderRoster(liveRows, width, Math.max(1, budget - fixedCount));
    const body = [header, ...rowLines, ...doneLines];
    const rendered = fitLines(body, passiveDiagnostics, budget, width, doneLines.length);
    setViewerExternalRows(WORKFLOW_VIEWER_RESERVATION_OWNER, rendered.length);
    return rendered;
  }

  private progressTailLines(width: number): string[] {
    return this.journal
      .filter(
        (line) =>
          line.kind === "log" ||
          line.kind === "error" ||
          (line.kind === "agent_end" && line.evidenceWarnings !== undefined && line.evidenceWarnings.length > 0),
      )
      .slice(-3)
      .map((line) => truncate(formatProgressTailLine(line), width));
  }

  private visibleRows(): AgentLiveRow[] {
    const all = [...agentLiveStore.rows.values()];
    const sourceRunId = this.options.continuationSourceRunId;
    const sourceRows = sourceRunId === undefined ? [] : all.filter((row) => row.workflowRunId === sourceRunId);
    let visible: AgentLiveRow[];
    if (this.#knownRowIds.size > 0) {
      const currentRows = selectAgentLiveRowsForParents(all, this.#knownRowIds);
      visible = compactWorkflowParentRows([
        ...new Map([...sourceRows, ...currentRows].map((row) => [row.id, row])).values(),
      ]);
    } else if (this.options.scope !== "workflow") {
      visible = compactWorkflowParentRows(all);
    } else {
      const prefix = `workflow:${this.runId}:`;
      const scopedParentIds = new Set(all.filter((row) => row.id.startsWith(prefix)).map((row) => row.id));
      const scoped = all.filter(
        (row) =>
          row.workflowRunId === sourceRunId ||
          row.id.startsWith(prefix) ||
          (row.parentRowId !== undefined && scopedParentIds.has(row.parentRowId)),
      );
      visible = compactWorkflowParentRows(scoped);
    }
    const viewedRowId = fleetViewedRowId();
    return viewedRowId === undefined ? visible : visible.filter((row) => row.id === viewedRowId);
  }

  private renderHeader(width: number, rows: AgentLiveRow[]): string {
    const headerStatus: WorkflowProjectedStatus | "running" = this.done?.status ?? "running";
    const headerLabel = workflowProgressStatusLabel(headerStatus);
    if (this.options.scope !== "workflow") {
      const counts = countAgentLiveStatuses(rows);
      const phase = currentWorkflowPhase(this.journal);
      const terminalCount = counts.done + counts.cancelled + counts.error;
      const cancelledText = counts.cancelled > 0 ? ` cancelled=${counts.cancelled}` : "";
      const failedText = counts.error > 0 ? ` failed=${counts.error}` : "";
      const replayedCount = this.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
      const replayedText = replayedCount > 0 ? ` replayed=${replayedCount}` : "";
      // Same identity budget as the workflow rail below. This line has no
      // right-hand block to lose, but it is truncated from the right, so a long
      // path pushes the counters — the reason the header exists — off the end.
      const text = `workflow ${workflowRailRef(this.scriptRef)} (${this.runId}) - ${headerLabel} phase=${phase ?? "not-set"} active=${counts.working} done=${terminalCount}/${rows.length}${cancelledText}${failedText}${replayedText}`;
      return this.#bold(truncate(text, width));
    }
    const statusMark = workflowProgressStatusMark(headerStatus);
    const frontier = workflowStageFrontier(this.options.declaredStages ?? [], this.journal);
    const current =
      frontier.find((stage) => stage.state === "current") ??
      frontier.filter((stage) => stage.state === "reached").at(-1);
    const stageIndex = current === undefined ? 0 : frontier.indexOf(current) + 1;
    const stage =
      frontier.length === 0 ? "stage —" : `stage ${stageIndex}/${frontier.length} · ${current?.title ?? "waiting"}`;
    const replayedCount = this.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
    const replayedText = replayedCount > 0 ? ` · replayed ${replayedCount}` : "";
    const currentRows =
      this.options.continuationSourceRunId === undefined
        ? rows
        : rows.filter((row) => row.workflowRunId !== this.options.continuationSourceRunId);
    const leaves = selectFleetMenuLeafRows(currentRows);
    const counts = countAgentLiveStatuses(leaves);
    const terminalCount = counts.done + counts.cancelled + counts.error;
    const tokenTotal = leaves.reduce(
      (sum, row) => sum + (row.tokenCount === undefined ? 0 : row.tokenCount.input + row.tokenCount.output),
      0,
    );
    const tokenText = tokenTotal > 0 ? `tok ${formatCompactTokenCount(tokenTotal)}` : "tok —";
    const state = `${statusMark} ${headerLabel}`;
    const progressText = `${terminalCount}/${leaves.length} done${replayedText}`;
    const fullCommands =
      this.done === undefined
        ? "/ps inspect agents · /workflows status last · /workflows stop last"
        : "/ps inspect agents · /workflows status last";
    const mediumCommands =
      this.done === undefined ? "/ps inspect agents · /workflows stop last" : "/workflows status last";
    const shortCommands = this.done === undefined ? "/workflows stop last" : "/workflows status last";
    const continuationText =
      this.options.continuationSourceRunId === undefined
        ? ""
        : ` · continues #${shortWorkflowRunId(this.options.continuationSourceRunId)}`;
    // The rail's identity is shortened BEFORE composition: a workflow started by
    // absolute path otherwise spends the whole line on a directory prefix, every
    // projection overflows, and the right-hand commands vanish instead of degrading.
    const ref = workflowRailRef(this.scriptRef);
    const full = `◆ WORKFLOW · ${ref}${continuationText} │ ${tokenText} │ ${stage} · ${state} │ ${progressText}`;
    const medium = `◆ WF ${ref}${continuationText} │ ${tokenText} │ ${stageIndex}/${frontier.length || "—"} ${current?.title ?? "waiting"} · ${state} │ ${progressText}`;
    const compact = `◆ ${ref}${continuationText} │ ${tokenText} │ ${stageIndex}/${frontier.length || "—"} ${current?.title ?? "waiting"} · ${state}`;
    const projections: ReadonlyArray<readonly [string, string]> = [
      [full, fullCommands],
      [full, mediumCommands],
      [medium, mediumCommands],
      [compact, mediumCommands],
      [compact, shortCommands],
    ];
    const text =
      projections
        .map(([left, right]) => alignWorkflowRail(left, right, width))
        .find((candidate) => candidate !== undefined) ?? truncate(compact, width);
    return this.#rail(text, width);
  }

  /**
   * The full agent roster for this run, as the run tree: the group summary rows
   * that earned a heading, each followed by its member agents, then every
   * declared stage the run has not reached yet (`○`, dim). Finished agents keep
   * `✓` and their duration, the agent working right now keeps its spinner in the
   * shared `accent` tone, and a re-entered slot keeps ONE row carrying its `r<N>`
   * round badge, so a loop updates a row instead of appending a duplicate.
   *
   * Which rows survive and in what order is `orderAgentLiveRows` — the same
   * set-level projection `/ps` runs — so both surfaces show one structure.
   * Everything below it is the passive panel's own business: only here is the
   * roster collapsed to fit a budget, because only here is nothing selectable.
   */
  private renderRoster(rows: AgentLiveRow[], width: number, budget: number): string[] {
    // `withWorkflowGroupTotals` before the ordering, exactly as `/ps` and
    // `AgentLivePanel.renderRows` do it: without it the same group heading would
    // report tokens on one surface and `tok —` on the other.
    const projected = orderAgentLiveRows(withWorkflowGroupTotals(rows));
    const leaves = selectFleetMenuLeafRows(projected);
    const sourceRunId = this.options.continuationSourceRunId;
    const previousLeaves = sourceRunId === undefined ? [] : leaves.filter((row) => row.workflowRunId === sourceRunId);
    const currentRows =
      sourceRunId === undefined ? projected : projected.filter((row) => row.workflowRunId !== sourceRunId);
    const currentLeaves =
      sourceRunId === undefined ? leaves : leaves.filter((row) => row.workflowRunId !== sourceRunId);
    const current =
      currentLeaves.find((row) => row.status === "working") ??
      currentLeaves.find((row) => row.status === "queued") ??
      currentLeaves.at(-1);
    const rowWidth = Math.max(1, width - 2);
    const panel = new AgentLivePanel({
      spinnerIndex: this.#spinnerIndex,
      theme: this.theme,
      ...(this.#calm ? { calm: true } : {}),
    });
    // Only the current row keeps its sub-lines (latest message / live tool action);
    // settled rows stay one line each so the roster fits a short terminal.
    const renderAgentLines = (row: AgentLiveRow) =>
      (row === current ? panel.renderRows([row], rowWidth) : [panel.renderRow(row, rowWidth)]).map(
        (line) => `  ${line}`,
      );
    // What the roster gives up, and in what order (see `clampRosterLines`):
    //
    //   * A group heading is the summary of the rows beneath it (`k/n done ·
    //     f failed`), so it outlives its own members: when they collapse, the
    //     heading is what still answers "how did that fan-out go". It is given
    //     up only after every settled leaf, and only once the group itself has
    //     finished — a LIVE group's heading is never collapsed, because the work
    //     it names is still happening.
    //   * A working agent is live work. `orderAgentLiveRows` puts it on top of
    //     its group for exactly that reason, so it is the last thing collapsed;
    //     collapsing it first would hide the running fan-out behind the finished
    //     one and defeat the ordering rule.
    const currentAgentLines = currentRows.map((row) => {
      const isGroupHeading = row.groupKind !== undefined;
      return {
        settled: isGroupHeading ? isTerminalRosterStatus(row.status) : row !== current,
        collapseRank: isGroupHeading ? ROSTER_COLLAPSE_RANK_TERMINAL_GROUP_HEADING : agentCollapseRank(row.status),
        hiddenAgents: isGroupHeading ? 0 : 1,
        hiddenGroups: isGroupHeading ? 1 : 0,
        lines: renderAgentLines(row),
      };
    });
    // The previous run contributes its LEAVES only — no headings. It is a closed
    // history block an operator cannot act on, so it is one collapsible unit; the
    // "one structure" promise above is about the run in progress.
    const previousRunBlock =
      sourceRunId === undefined
        ? []
        : previousLeaves.length === 0
          ? [
              {
                settled: true,
                collapseRank: ROSTER_COLLAPSE_RANK_FINISHED,
                hiddenAgents: 0,
                hiddenGroups: 0,
                lines: [
                  this.#fg(
                    "dim",
                    truncate(
                      `  ↳ previous run #${shortWorkflowRunId(sourceRunId)} · history unavailable · /workflows status ${shortWorkflowRunId(sourceRunId)}`,
                      width,
                    ),
                  ),
                ],
              },
            ]
          : [
              {
                settled: true,
                collapseRank: ROSTER_COLLAPSE_RANK_FINISHED,
                hiddenAgents: previousLeaves.length,
                hiddenGroups: 0,
                lines: [
                  this.#fg("dim", truncate(`  ↳ previous run #${shortWorkflowRunId(sourceRunId)}`, width)),
                  ...previousLeaves.flatMap((row) => renderAgentLines(row)),
                ],
              },
            ];
    const pendingLines = (fleetViewedRowId() === undefined ? this.pendingStageLines(width) : []).map((line) => ({
      settled: false,
      collapseRank: ROSTER_COLLAPSE_RANK_LIVE,
      hiddenAgents: 0,
      hiddenGroups: 0,
      lines: [line],
    }));
    const roster = [...previousRunBlock, ...currentAgentLines, ...pendingLines];
    if (roster.length === 0) return [this.#fg("dim", truncate("  waiting for workflow agents…", width))];
    return clampRosterLines(roster, budget, width);
  }

  /**
   * Declared stages the run has not reached yet — the work still ahead. Titles
   * come from `meta.phases`, so an undeclared dynamic stage never appears here
   * before it actually runs.
   *
   * The whole tail is ONE line. A single pending stage still gets its full
   * `○ <title> · planned · <detail>` reading, because there is nothing to
   * collapse and the detail is the useful part. Two or more collapse into
   * `○ next: <title> (+k planned)`: the next stage is the only one an operator
   * can act on, and a long declared plan otherwise eats the roster budget one
   * line per stage.
   */
  private pendingStageLines(width: number): string[] {
    const declared = new Map(
      (this.options.declaredStages ?? []).flatMap((stage) => {
        const title = normalizeWorkflowPhase(stage.title);
        return title === undefined ? [] : [[title, stage.detail] as const];
      }),
    );
    const pending = workflowStageFrontier(this.options.declaredStages ?? [], this.journal).filter(
      (stage) => stage.state === "declared",
    );
    const next = pending[0];
    if (next === undefined) return [];
    if (pending.length === 1) {
      const detail = normalizeWorkflowPhase(declared.get(next.title));
      const text = `  ○ ${next.title}  ·  planned${detail === undefined ? "" : `  ·  ${detail}`}`;
      return [this.#fg("dim", truncate(text, width))];
    }
    return [this.#fg("dim", truncate(`  ○ next: ${next.title} (+${pending.length - 1} planned)`, width))];
  }

  private doneLines(width: number): string[] {
    if (this.done === undefined) return [];
    const lines: string[] = [];
    const presentation = workflowProgressDonePresentation(this.done.status);
    lines.push(this.#fg(presentation.color, truncate(`${presentation.marker} ${this.done.summary}`, width)));
    if (this.done.resultPersistence?.ok === false) {
      lines.push(this.#fg("warning", truncate(`persistence: ${this.done.resultPersistence.code}`, width)));
    }
    // A failed run says WHERE it broke and WHAT to hand a repairing agent; the
    // `copy:` line is one selectable line, never wrapped or abbreviated.
    if (this.done.failureDiagnostic !== undefined) {
      for (const line of formatWorkflowFailureDiagnosticLines(this.done.failureDiagnostic)) {
        lines.push(this.#fg("dim", truncate(line, width)));
      }
    }
    // The verdict line above is clipped to the terminal width, so a run whose
    // result is prose needs one line saying where the whole text is and the one
    // command that opens it.
    // Gated on the same fact the digest uses: a readable text copy exists. A run
    // that produced none must not be told to go and read one.
    if (this.done.resultTextPath !== undefined) {
      const command = `read the full result: /workflows result ${shortWorkflowRunId(this.runId)}`;
      lines.push(this.#fg("dim", truncate(command, width)));
      lines.push(this.#fg("dim", truncate(`result: ${this.done.resultTextPath}`, width)));
    } else if (this.done.status !== "completed") {
      // Same rule for the run that ended badly with no prose result: the clipped
      // verdict line above is all the operator got, and the reason lives in the
      // structured result that only this command prints.
      const command = `read the full reason: /workflows status ${shortWorkflowRunId(this.runId)}`;
      lines.push(this.#fg("dim", truncate(command, width)));
    }
    // Honest pointer to the saved run on disk (T-188 W5, fix-candidate #8).
    if (this.done.runDir !== undefined) lines.push(this.#fg("dim", truncate(`saved: ${this.done.runDir}`, width)));
    return lines;
  }

  #syncLiveTimer(): void {
    if (this.#disposed || this.done !== undefined) {
      this.#stopLiveTimer();
      return;
    }
    if (this.visibleRows().some((row) => row.status === "working")) this.#startLiveTimer();
    else this.#stopLiveTimer();
  }

  #startLiveTimer(): void {
    if (this.#disposed || this.#tickTimer !== undefined) return;
    const timer = setInterval(() => {
      if (this.#disposed || this.done !== undefined || !this.visibleRows().some((row) => row.status === "working")) {
        this.#stopLiveTimer();
        return;
      }
      // Calm rendering freezes the spinner: the tick still fires so elapsed
      // buckets can roll over, but a frame with no visible change is then
      // byte-identical and the identity gate suppresses the repaint entirely.
      if (!this.#calm) this.#spinnerIndex = (this.#spinnerIndex + 1) % AGENT_LIVE_SPINNER_FRAME_COUNT;
      // 1 Hz is slower than the coalescing window, so this always lands on a
      // leading edge and liveness is unchanged.
      this.#scheduler.request();
    }, LIVE_TICK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.#tickTimer = timer;
  }

  #stopLiveTimer(): void {
    if (this.#tickTimer === undefined) return;
    clearInterval(this.#tickTimer);
    this.#tickTimer = undefined;
  }

  #fg(color: string, text: string): string {
    return this.theme.fg ? this.theme.fg(color, text) : text;
  }

  #bold(text: string): string {
    return this.theme.bold ? this.theme.bold(text) : text;
  }

  #rail(text: string, width: number): string {
    const fitted = truncate(text, width);
    const padded = `${fitted}${" ".repeat(Math.max(0, width - fitted.length))}`;
    if (this.theme.fg === undefined && this.theme.bg === undefined) return padded;
    return `${WORKFLOW_RAIL_BACKGROUND}${WORKFLOW_RAIL_FOREGROUND}${padded}${WORKFLOW_RAIL_RESET}`;
  }
}

export class WorkflowTextComponent implements CustomUiComponent {
  constructor(
    public tui: WidgetFactoryTui,
    public theme: ThemeLike,
    readonly content: string,
  ) {}

  attachTui(tui: WidgetFactoryTui): void {
    this.tui = tui;
  }

  invalidate(): void {
    // Static text widget owns no timers or external handles.
  }

  render(width: number): string[] {
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, Math.min(rows - 6, 48));
    const lines = this.content.split(/\r?\n/).map((line) => truncate(line, width));
    if (lines.length <= budget) return lines;
    const visible = lines.slice(0, Math.max(0, budget - 1));
    return [...visible, truncate(`(+${lines.length - visible.length} more)`, width)];
  }
}

export function installWorkflowTextWidget(ctx: ExtensionContext, key: string, content: string): WorkflowTextComponent {
  const component = new WorkflowTextComponent(NOOP_TUI, coerceTheme(undefined), content);
  if (ctx.hasUI === true) {
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(key, component.render(80), { placement: "belowEditor" });
      return component;
    }
    try {
      ctx.ui?.setWidget?.(key, (tui, theme) => {
        component.attachTui(tui as WidgetFactoryTui);
        component.theme = coerceTheme(theme);
        return component;
      });
    } catch {
      try {
        ctx.ui?.setWidget?.(key, content.split(/\r?\n/));
      } catch {
        // Best-effort display path only.
      }
    }
  }
  return component;
}

export function installWorkflowProgress(
  ctx: ExtensionContext,
  key: string,
  scriptRef: string,
  runIdPlaceholder: string,
  options: WorkflowProgressOptions = {},
): WorkflowProgressComponent {
  const component = new WorkflowProgressComponent(NOOP_TUI, coerceTheme(undefined), scriptRef, runIdPlaceholder, {
    ...options,
    ownsFleetProjection: true,
  });
  if (ctx.hasUI === true) {
    if (ctx.mode !== "tui") {
      const requestRender = () => {
        ctx.ui.setWidget(key, component.render(80), { placement: FLEET_MENU_PLACEMENT });
      };
      component.attachTui({ requestRender });
      requestRender();
      return component;
    }
    try {
      ctx.ui?.setWidget?.(
        key,
        (tui, theme) => {
          component.attachTui(tui as WidgetFactoryTui);
          component.theme = coerceTheme(theme);
          return component;
        },
        // Fleet control surface → below the editor (REQ-007; policy in widget-render.ts).
        { placement: FLEET_MENU_PLACEMENT },
      );
    } catch {
      // Host accepted UI but rejected this widget: keep the live component anyway.
    }
  }
  return component;
}

export function renderAgentLiveRowsText(): string {
  const rows = [...agentLiveStore.rows.values()];
  if (rows.length === 0) return "Agents: no live rows.";
  return new AgentLivePanel({})
    .renderRows(orderAgentLiveRows(compactWorkflowParentRows(rows)), Number.POSITIVE_INFINITY)
    .join("\n");
}
