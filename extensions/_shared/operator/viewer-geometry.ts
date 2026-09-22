/**
 * extensions/_shared/operator/viewer-geometry.ts — Geometry every scrollable TUI viewer
 * recomputes on each render: how many rows it may draw into, and how a single
 * line is cut to the width it was granted.
 *
 * A `CustomUiComponent` renders into a terminal whose height it cannot trust:
 * `tui.terminal.rows` may be absent, non-numeric, or fractional depending on the
 * host, and every viewer clamps its scroll offset into a valid range. Four
 * viewers across two extensions had grown identical private copies of both
 * answers. The differing numbers — how many rows are a usable minimum, what to
 * assume when the terminal reports nothing, how many rows the Pi host keeps for
 * itself — stay with the caller, because those are per-viewer layout decisions
 * rather than shared geometry.
 *
 * Line fitting comes in two shapes the viewers genuinely disagree about, so both
 * are exported by name rather than merged behind a flag: `fitLine` truncates and
 * leaves a short line short, `padLine` truncates and pads out to exactly `width`
 * because its caller draws a frame whose right edge has to land somewhere fixed.
 *
 * Rendering, key handling, and scroll policy stay in the viewer.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The value confined to `[min, max]`. Identical to the private copies it replaces. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The shape a viewer needs off its host `tui` handle; both `CustomUiTui` and the agents viewer handle satisfy it. */
export interface TerminalRowsSource {
  terminal?: { rows?: number } | undefined;
}

/**
 * The usable terminal height: the reported row count floored and held at
 * `minimumRows`, or `fallbackRows` when the host reports nothing usable.
 */
export function terminalRows(tui: TerminalRowsSource, minimumRows: number, fallbackRows: number): number {
  const rows = tui.terminal?.rows;
  return typeof rows === "number" && Number.isFinite(rows) ? Math.max(minimumRows, Math.floor(rows)) : fallbackRows;
}

/** The per-viewer numbers `viewerRows` needs; see the module note on why they stay with the caller. */
export interface ViewerRowsOptions {
  /** Smallest row count worth honouring when the terminal reports one. */
  readonly minimumRows: number;
  /** Rows to assume when the terminal reports nothing usable. */
  readonly fallbackRows: number;
  /** Rows the Pi host keeps for itself below the viewer. */
  readonly hostFooterRows: number;
}

/**
 * Rows a focused viewer may actually draw into: the usable terminal height less
 * the host footer and any rows another surface has reserved, never below one.
 */
export function viewerRows(tui: TerminalRowsSource, options: ViewerRowsOptions): number {
  const usable = terminalRows(tui, options.minimumRows, options.fallbackRows);
  return Math.max(1, usable - options.hostFooterRows - viewerExternalRows());
}

/**
 * The line truncated to `width`, ellipsised when it does not fit, and left short
 * when it is short. The second truncate is a defensive floor: `truncateToWidth`
 * is trusted to respect `width`, and a result that still overflowed would push
 * the viewer's own frame off the row, so it is cut again without an ellipsis.
 */
export function fitLine(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, "…");
  return visibleWidth(fitted) <= width ? fitted : truncateToWidth(fitted, width);
}

/**
 * The line truncated to `width` and then padded with spaces to exactly `width`.
 * Callers that draw a right-hand frame edge need every row to be the same
 * visible width, which `fitLine` does not promise.
 */
export function padLine(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, "…");
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

/**
 * Content clipped to the rows the viewer was granted, and never padded up to
 * them. A frame that claimed the full terminal height on every render pushed the
 * whole transcript into scrollback, so Escape left the operator staring at the
 * blank rows this viewer had just filled. Rendering the real content height lets
 * the host clear what it no longer needs; a screen longer than `height` still
 * clips exactly as before.
 */
export function clipLines(lines: readonly string[], height: number, width: number): string[] {
  return lines.slice(0, height).map((line) => fitLine(line, width));
}

const VIEWER_EXTERNAL_ROWS_KEY = Symbol.for("locus-pi.viewer-external-rows.v1");

interface ViewerExternalRowsRegistry {
  readonly rowsByOwner: Map<string, number>;
}

function viewerExternalRowsRegistry(): ViewerExternalRowsRegistry {
  const root = globalThis as typeof globalThis & { [VIEWER_EXTERNAL_ROWS_KEY]?: ViewerExternalRowsRegistry };
  const existing = root[VIEWER_EXTERNAL_ROWS_KEY];
  if (existing !== undefined) return existing;
  const created: ViewerExternalRowsRegistry = { rowsByOwner: new Map() };
  Object.defineProperty(root, VIEWER_EXTERNAL_ROWS_KEY, {
    value: created,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return created;
}

/** Publish rows that remain outside a focused custom viewer (for example a below-editor workflow widget). */
export function setViewerExternalRows(owner: string, rows: number): void {
  const normalized = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (normalized === 0) viewerExternalRowsRegistry().rowsByOwner.delete(owner);
  else viewerExternalRowsRegistry().rowsByOwner.set(owner, normalized);
}

export function clearViewerExternalRows(owner: string): void {
  viewerExternalRowsRegistry().rowsByOwner.delete(owner);
}

/** Total rows Pi still renders above/below the editor container replaced by ctx.ui.custom(). */
export function viewerExternalRows(): number {
  return [...viewerExternalRowsRegistry().rowsByOwner.values()].reduce((total, rows) => total + rows, 0);
}
