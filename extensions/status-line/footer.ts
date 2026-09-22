import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  CustomUiComponent,
  ExtensionContext,
  FooterDataProviderLike,
  ThemeLike,
  WidgetFactoryTui,
} from "../_shared/host/pi-api.js";
import { formatTokenCount } from "../_shared/agent-runtime/agent-live-panel.js";
import { clearViewerExternalRows, setViewerExternalRows } from "../_shared/operator/viewer-geometry.js";

const BAR_BACKGROUND = "\u001b[48;2;42;27;61m";
const BAR_FOREGROUND = "\u001b[38;2;222;201;255m";
const BAR_RESET = "\u001b[0m";
const COMPACTED_VISIBLE_MS = 12_000;
const STATUS_LINE_OVERFLOW_OWNER = "status-line-overflow";

export type CompactionDisplayState =
  { kind: "idle" } | { kind: "compacting" } | { kind: "compacted"; tokensBefore?: number; completedAt: number };

export interface StatusLineSnapshot {
  model: string;
  effort: string;
  cwd: string;
  branch?: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  compaction: CompactionDisplayState;
}

export class LocusFooterComponent implements CustomUiComponent {
  #unsubscribeBranch: (() => void) | undefined;
  #clearCompactedTimer: ReturnType<typeof setTimeout> | undefined;
  #compaction: CompactionDisplayState = { kind: "idle" };

  constructor(
    private readonly tui: WidgetFactoryTui,
    private readonly theme: ThemeLike,
    private readonly ctx: ExtensionContext,
    private readonly footerData: FooterDataProviderLike,
  ) {
    this.#unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
  }

  setCompaction(state: CompactionDisplayState): void {
    this.#compaction = state;
    if (this.#clearCompactedTimer !== undefined) clearTimeout(this.#clearCompactedTimer);
    this.#clearCompactedTimer = undefined;
    if (state.kind === "compacted") {
      this.#clearCompactedTimer = setTimeout(() => {
        this.#compaction = { kind: "idle" };
        this.#clearCompactedTimer = undefined;
        this.tui.requestRender();
      }, COMPACTED_VISIBLE_MS);
      this.#clearCompactedTimer.unref?.();
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.#unsubscribeBranch?.();
    this.#unsubscribeBranch = undefined;
    if (this.#clearCompactedTimer !== undefined) clearTimeout(this.#clearCompactedTimer);
    this.#clearCompactedTimer = undefined;
    clearViewerExternalRows(STATUS_LINE_OVERFLOW_OWNER);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const plainLines = renderStatusLines(snapshotStatusLine(this.ctx, this.footerData, this.#compaction), safeWidth);
    setViewerExternalRows(STATUS_LINE_OVERFLOW_OWNER, Math.max(0, plainLines.length - 1));
    // Stable violet identity. Semantic content remains plain text and survives
    // terminals/themes that strip ANSI styling.
    return plainLines.map((plain) => {
      const padded = `${plain}${" ".repeat(Math.max(0, safeWidth - visibleWidth(plain)))}`;
      return `${BAR_BACKGROUND}${BAR_FOREGROUND}${padded}${BAR_RESET}`;
    });
  }
}

export function snapshotStatusLine(
  ctx: ExtensionContext,
  footerData: FooterDataProviderLike,
  compaction: CompactionDisplayState = { kind: "idle" },
): StatusLineSnapshot {
  const cwd = ctx.sessionManager?.getCwd?.() ?? ctx.session?.workingDirectory ?? ctx.cwd ?? process.cwd();
  const context = ctx.getContextUsage?.();
  const modelName = ctx.model?.id ?? "no-model";
  const branch = footerData.getGitBranch();
  return {
    model: modelName,
    effort: ctx.thinkingLevel ?? "off",
    cwd: formatStatusCwd(cwd),
    ...(branch === null ? {} : { branch }),
    contextTokens: context?.tokens ?? null,
    contextWindow: context?.contextWindow ?? numericField(ctx.model, "contextWindow") ?? 0,
    contextPercent: context?.percent ?? null,
    compaction,
  };
}

export function renderStatusLines(snapshot: StatusLineSnapshot, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const context = formatContext(snapshot);
  const compaction = formatCompaction(snapshot);
  const cwdBase = path.basename(snapshot.cwd) || snapshot.cwd;
  const branch = snapshot.branch === undefined ? "" : ` (${snapshot.branch})`;
  const shortBranch = snapshot.branch === undefined ? "" : ` (${shortTail(snapshot.branch, 24)})`;
  const leftCandidates = [`${snapshot.cwd}${branch}`, `${cwdBase}${shortBranch}`, cwdBase];
  const rightCandidates = [
    `${context} ${compaction} ${snapshot.model} ${snapshot.effort}`,
    `${context} ${snapshot.model} ${snapshot.effort}`,
    `${context} ${snapshot.effort}`,
  ];

  const fullLine = alignStatusGroups(leftCandidates[0] ?? "", rightCandidates[0] ?? "", safeWidth);
  if (fullLine !== undefined) return [fullLine];

  const left =
    leftCandidates.find((candidate) => visibleWidth(candidate) <= safeWidth) ?? truncatePlain(cwdBase, safeWidth);
  const right =
    rightCandidates.find((candidate) => visibleWidth(candidate) <= safeWidth) ??
    truncatePlain(rightCandidates.at(-1) ?? "", safeWidth);
  return [left, right.padStart(safeWidth)];
}

function formatStatusCwd(cwd: string): string {
  const home = os.homedir();
  const relative = path.relative(home, cwd);
  if (relative === "") return "~";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~${path.sep}${relative}`;
  }
  return cwd;
}

function formatContext(snapshot: StatusLineSnapshot): string {
  const percent = snapshot.contextPercent === null ? "?" : `${trimDecimal(snapshot.contextPercent)}%`;
  return snapshot.contextWindow > 0 ? `${percent}/${formatTokenCount(snapshot.contextWindow)}` : percent;
}

function formatCompaction(snapshot: StatusLineSnapshot): string {
  if (snapshot.compaction.kind === "compacting") return "(COMPACTING)";
  if (snapshot.compaction.kind === "idle") return "(pi:auto)";
  const before = snapshot.compaction.tokensBefore;
  const after = snapshot.contextTokens;
  if (before === undefined)
    return after === null ? "(COMPACTED measuring…)" : `(COMPACTED →${formatTokenCount(after)})`;
  return `(COMPACTED ${formatTokenCount(before)}→${after === null ? "measuring…" : formatTokenCount(after)})`;
}

function shortTail(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

function alignStatusGroups(left: string, right: string, width: number): string | undefined {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const gap = left === "" ? width - rightWidth : width - leftWidth - rightWidth;
  if (gap < (left === "" ? 0 : 2)) return undefined;
  return `${left}${" ".repeat(gap)}${right}`;
}

function trimDecimal(value: number): string {
  const rounded = value.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

function truncatePlain(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 1) return "…".slice(0, width);
  const points = Array.from(value);
  while (points.length > 0 && visibleWidth(`${points.join("")}…`) > width) points.pop();
  return `${points.join("")}…`;
}

function numericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
