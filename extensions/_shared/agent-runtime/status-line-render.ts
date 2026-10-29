import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "./agent-live-panel.js";
const BAR_BACKGROUND = "\u001b[48;2;42;27;61m";
const BAR_FOREGROUND = "\u001b[38;2;222;201;255m";
const BAR_RESET = "\u001b[0m";
export type CompactionDisplayState =
  | { kind: "idle" }
  | { kind: "unknown" }
  | { kind: "compacting" }
  | { kind: "compacted"; tokensBefore?: number; completedAt: number };

export interface StatusLineSnapshot {
  model: string;
  effort: string;
  cwd: string;
  branch?: string;
  controls: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  compaction: CompactionDisplayState;
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

  const fullLeft = `${leftCandidates[0] ?? ""}  ${snapshot.controls}`;
  const fullLine = alignStatusGroups(fullLeft, rightCandidates[0] ?? "", safeWidth);
  if (fullLine !== undefined) return [fullLine];

  const left =
    leftCandidates.find((candidate) => visibleWidth(candidate) <= safeWidth) ?? truncatePlain(cwdBase, safeWidth);
  const right =
    rightCandidates.find((candidate) => visibleWidth(candidate) <= safeWidth) ??
    truncatePlain(rightCandidates.at(-1) ?? "", safeWidth);
  const controlsWithStatus = rightCandidates
    .map((candidate) => alignStatusGroups(snapshot.controls, candidate, safeWidth))
    .find((candidate) => candidate !== undefined);
  if (controlsWithStatus !== undefined) return [left, controlsWithStatus];
  return [left, truncatePlain(snapshot.controls, safeWidth), right.padStart(safeWidth)];
}

export function defaultControlHints(platform: NodeJS.Platform = process.platform): string {
  const exit = "Ctrl+D exit (empty)";
  return platform === "win32" ? exit : `${exit} · Ctrl+Z suspend`;
}

export function formatStatusCwd(cwd: string): string {
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
  if (snapshot.compaction.kind === "unknown") return "(compact:?)";
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

export function paintStatusLines(lines: string[], width: number): string[] {
  return lines.map(
    (plain) =>
      `${BAR_BACKGROUND}${BAR_FOREGROUND}${plain}${" ".repeat(Math.max(0, width - visibleWidth(plain)))}${BAR_RESET}`,
  );
}
