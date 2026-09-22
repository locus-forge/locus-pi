import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type OperatorSurfaceType = "VIEW" | "CHANGE" | "RUN" | "INPUT" | "SELECT" | "RESULT" | "LIVE" | "WARN" | "ERROR";

export type OperatorTone = "accent" | "text" | "success" | "warning" | "error" | "muted" | "dim";

export interface OperatorBadge {
  text: string;
  tone?: OperatorTone;
}

export interface OperatorBlock {
  type: OperatorSurfaceType;
  subject: string;
  primary: string;
  badges?: readonly OperatorBadge[];
  body?: readonly string[];
  metadata?: readonly string[];
  hint?: readonly string[];
  controls?: readonly string[];
}

export interface OperatorThemeLike {
  fg?: (color: OperatorTone | "borderAccent" | "borderMuted", text: string) => string;
  bold?: (text: string) => string;
}

export interface OperatorRenderOptions {
  maxLines?: number;
}

interface OperatorContentLine {
  text: string;
  tone: OperatorTone;
  bold?: boolean;
}

const NARROW_WIDTH = 60;
const WIDE_WIDTH = 100;
const FRAME_SIDE_WIDTH = 4;
const MIN_FRAMED_WIDTH = 12;
// Selection is a Locus interaction state, not a Pi theme accent. Keep one
// contrast-tested palette so user themes cannot turn active choices neutral.
const ACTIVE_SELECTION_BACKGROUND = "\u001b[48;2;88;61;121m";
const ACTIVE_SELECTION_FOREGROUND = "\u001b[38;2;248;241;255m";
const ACTIVE_SELECTION_BORDER = "\u001b[38;2;196;167;231m";
const ACTIVE_SELECTION_RESET = "\u001b[0m";
const ACTIVE_SELECTION_BORDER_RESET = "\u001b[39m";

/** Render one active choice with the shared purple fill and a plain fallback. */
export function styleActiveSelection(theme: OperatorThemeLike | undefined, text: string): string {
  return hasLiveTheme(theme)
    ? `${ACTIVE_SELECTION_BACKGROUND}${ACTIVE_SELECTION_FOREGROUND}${text}${ACTIVE_SELECTION_RESET}`
    : text;
}

/** Render an active selection boundary in the lighter edge color of the same palette. */
function styleSelectionBorder(theme: OperatorThemeLike | undefined, text: string): string {
  return hasLiveTheme(theme) ? `${ACTIVE_SELECTION_BORDER}${text}${ACTIVE_SELECTION_BORDER_RESET}` : text;
}

/**
 * Render a semantic operator block for the interactive TUI.
 *
 * This module owns only presentation. Callers retain domain ordering inside
 * each section, and the host adapter owns `setWidget` delivery and placement.
 */
export function renderOperatorBlock(
  block: OperatorBlock,
  width: number,
  theme?: OperatorThemeLike,
  options: OperatorRenderOptions = {},
): string[] {
  const safeWidth = normalizeWidth(width);
  const lines = renderOperatorBlockUnbounded(block, safeWidth, theme);
  const maxLines = normalizeMaxLines(options.maxLines);
  return maxLines === undefined || lines.length <= maxLines
    ? lines
    : boundOperatorBlock(block, safeWidth, theme, maxLines, lines.length);
}

function renderOperatorBlockUnbounded(block: OperatorBlock, safeWidth: number, theme?: OperatorThemeLike): string[] {
  if (safeWidth < MIN_FRAMED_WIDTH) return renderOperatorBlockPlain(block, safeWidth);

  const innerWidth = safeWidth - FRAME_SIDE_WIDTH;
  const borderTone = block.type === "INPUT" || block.type === "SELECT" ? "borderAccent" : "borderMuted";
  // The top rule is one fixed-width slot — heading first, dashes for the rest —
  // sitting between "╭─ " and " ╮". Giving the heading a column less than the
  // body reserves the space that keeps the title off the rule: without it a
  // full-width heading rendered as `╭─ [SELECT] Model roles [models]────────╮`.
  const headingWidth = Math.max(0, innerWidth - 1);
  const heading = truncateToWidth(renderHeading(block, safeWidth, theme), headingWidth);
  const topFill = "─".repeat(Math.max(0, headingWidth - visibleWidth(heading)));
  const frame = (text: string) =>
    block.type === "SELECT" ? styleSelectionBorder(theme, text) : style(theme, borderTone, text);
  const lines = [`${frame("╭─ ")}${heading}${frame(` ${topFill}╮`)}`];

  for (const content of contentLines(block)) {
    const styled = styleContentLine(content, theme);
    for (const wrapped of wrapTextWithAnsi(styled, innerWidth)) {
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(wrapped)));
      lines.push(`${frame("│ ")}${wrapped}${padding}${frame(" │")}`);
    }
  }

  lines.push(frame(`╰${"─".repeat(safeWidth - 2)}╯`));
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

/** Render the same semantic hierarchy without ANSI or decorative framing. */
export function renderOperatorBlockPlain(
  block: OperatorBlock,
  width: number,
  options: OperatorRenderOptions = {},
): string[] {
  const safeWidth = normalizeWidth(width);
  const lines = renderPlainUnbounded(block, safeWidth);
  const maxLines = normalizeMaxLines(options.maxLines);
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  if (maxLines <= 2) return compactPlainOperatorBlock(block, safeWidth, maxLines);

  // Without this the caller hands an over-budget array to a host that clamps it
  // by slicing the tail, which silently drops the controls — the one part that
  // tells the operator how to recover. Degrading here keeps them.
  return (
    degradeToBudget(block, maxLines, (candidate) => renderPlainUnbounded(candidate, safeWidth)) ??
    compactPlainOperatorBlock(block, safeWidth, maxLines)
  );
}

function renderPlainUnbounded(block: OperatorBlock, safeWidth: number): string[] {
  const source = [renderHeading(block, safeWidth), ...contentLines(block).map((line) => line.text)];

  return source.flatMap((line) => wrapTextWithAnsi(line, safeWidth)).map((line) => truncateToWidth(line, safeWidth));
}

function renderHeading(block: OperatorBlock, width: number, theme?: OperatorThemeLike): string {
  const typeTone = surfaceTone(block.type);
  const heading = `${style(theme, typeTone, `[${block.type}]`)} ${style(theme, "accent", block.subject)}`;
  const badges = visibleBadges(block.badges ?? [], width);
  if (badges.length === 0) return heading;

  return `${heading} ${badges.map((badge) => style(theme, badge.tone ?? "muted", `[${badge.text}]`)).join(" ")}`;
}

function visibleBadges(badges: readonly OperatorBadge[], width: number): readonly OperatorBadge[] {
  if (width < NARROW_WIDTH) return [];
  if (width < WIDE_WIDTH) return badges.slice(0, 1);
  return badges;
}

function contentLines(block: OperatorBlock): OperatorContentLine[] {
  return [
    { text: block.primary, tone: "text", bold: true },
    ...(block.body ?? []).map((text) => ({ text, tone: "text" as const })),
    ...(block.metadata ?? []).map((text) => ({ text, tone: "muted" as const })),
    ...(block.hint ?? []).map((text) => ({ text, tone: "dim" as const })),
    ...(block.controls ?? []).map((text) => ({ text, tone: "dim" as const })),
  ];
}

function styleContentLine(line: OperatorContentLine, theme?: OperatorThemeLike): string {
  const weighted = line.bold && typeof theme?.bold === "function" ? theme.bold(line.text) : line.text;
  return style(theme, line.tone, weighted);
}

function style(
  theme: OperatorThemeLike | undefined,
  tone: OperatorTone | "borderAccent" | "borderMuted",
  text: string,
): string {
  return typeof theme?.fg === "function" ? theme.fg(tone, text) : text;
}

function hasLiveTheme(theme: OperatorThemeLike | undefined): boolean {
  return typeof theme?.fg === "function";
}

function surfaceTone(type: OperatorSurfaceType): OperatorTone {
  if (type === "ERROR") return "error";
  if (type === "WARN") return "warning";
  if (type === "RESULT") return "success";
  return "accent";
}

function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) throw new RangeError("Operator block width must be finite");
  return Math.max(1, Math.floor(width));
}

function normalizeMaxLines(maxLines: number | undefined): number | undefined {
  if (maxLines === undefined) return undefined;
  if (!Number.isFinite(maxLines)) throw new RangeError("Operator block maxLines must be finite");
  return Math.max(1, Math.floor(maxLines));
}

/**
 * Enforce the passive-widget height budget at the semantic layer. Body rows are
 * the first overflow tier. Exceptionally short screens collapse to a framed or
 * plain projection that still names both type and primary value.
 */
function boundOperatorBlock(
  block: OperatorBlock,
  width: number,
  theme: OperatorThemeLike | undefined,
  maxLines: number,
  originalLineCount: number,
): string[] {
  if (maxLines <= 2 || width < MIN_FRAMED_WIDTH) {
    return compactPlainOperatorBlock(block, width, maxLines);
  }

  const ladder = degradeToBudget(block, maxLines, (candidate) => renderOperatorBlockUnbounded(candidate, width, theme));
  if (ladder !== undefined) return ladder;

  const exhausted = lastLadderState(block);
  return renderCompactFramedBlock(
    block,
    width,
    theme,
    maxLines,
    Math.max(1, exhausted.hidden, originalLineCount - maxLines),
    exhausted.metadata,
    exhausted.hint,
    exhausted.controls,
  );
}

/**
 * Shed content in the order the operator can most afford to lose it: body rows
 * first, then supporting metadata and hints, and controls only last. Returns
 * `undefined` when even the most degraded candidate still overflows, leaving the
 * final projection to the caller's own shape.
 */
function degradeToBudget(
  block: OperatorBlock,
  maxLines: number,
  render: (candidate: OperatorBlock) => string[],
): string[] | undefined {
  const body = [...(block.body ?? [])];
  const metadata = [...(block.metadata ?? [])];
  const hint = [...(block.hint ?? [])];
  const controls = [...(block.controls ?? [])];
  let hidden = 0;

  const attempt = (): string[] | undefined => {
    const candidate = render(compactCandidate(block, body, metadata, hint, controls, hidden));
    return candidate.length <= maxLines ? candidate : undefined;
  };

  for (const shed of [
    () => (body.length > 0 ? (body.pop(), true) : false),
    () => (metadata.length > 1 ? (metadata.pop(), true) : false),
    () => (hint.length > 1 ? (hint.pop(), true) : false),
    () => (controls.length > 1 ? (controls.pop(), true) : false),
  ]) {
    while (shed()) {
      hidden += 1;
      const fitted = attempt();
      if (fitted !== undefined) return fitted;
    }
  }

  return undefined;
}

function lastLadderState(block: OperatorBlock): {
  hidden: number;
  metadata: readonly string[];
  hint: readonly string[];
  controls: readonly string[];
} {
  const body = block.body ?? [];
  const metadata = block.metadata ?? [];
  const hint = block.hint ?? [];
  const controls = block.controls ?? [];
  const dropped =
    body.length + Math.max(0, metadata.length - 1) + Math.max(0, hint.length - 1) + Math.max(0, controls.length - 1);

  return {
    hidden: dropped,
    metadata: metadata.slice(0, 1),
    hint: hint.slice(0, 1),
    controls: controls.slice(0, 1),
  };
}

function compactCandidate(
  block: OperatorBlock,
  body: readonly string[],
  metadata: readonly string[],
  hint: readonly string[],
  controls: readonly string[],
  hidden: number,
): OperatorBlock {
  return {
    ...block,
    body: [...body, `(+${hidden} hidden)`],
    metadata,
    hint,
    controls,
  };
}

function renderCompactFramedBlock(
  block: OperatorBlock,
  width: number,
  theme: OperatorThemeLike | undefined,
  maxLines: number,
  hidden: number,
  metadata: readonly string[],
  hint: readonly string[],
  controls: readonly string[],
): string[] {
  const innerWidth = Math.max(1, width - FRAME_SIDE_WIDTH);
  const tailSlots = Math.max(0, maxLines - 4);
  const compactMetadata = tailSlots >= 2 && metadata[0] !== undefined ? [truncateToWidth(metadata[0], innerWidth)] : [];
  const compactHint = tailSlots >= 3 && hint[0] !== undefined ? [truncateToWidth(hint[0], innerWidth)] : [];
  const compactControls = tailSlots >= 1 && controls[0] !== undefined ? [truncateToWidth(controls[0], innerWidth)] : [];
  const compact = renderOperatorBlockUnbounded(
    {
      ...block,
      primary: truncateToWidth(block.primary, innerWidth),
      body: maxLines >= 4 ? [`(+${hidden} hidden)`] : [],
      metadata: compactMetadata,
      hint: compactHint,
      controls: compactControls,
    },
    width,
    theme,
  );

  if (compact.length <= maxLines) return compact;
  return compactPlainOperatorBlock(block, width, maxLines);
}

function compactPlainOperatorBlock(block: OperatorBlock, width: number, maxLines: number): string[] {
  const heading = `[${block.type}] ${block.subject}`;
  if (maxLines === 1) return [truncatePlainText(`[${block.type}] ${block.primary}`, width)];
  return [truncatePlainText(heading, width), truncatePlainText(block.primary, width)].slice(0, maxLines);
}

function truncatePlainText(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width <= 3) return ".".repeat(width);
  return `${sliceByColumn(text, 0, width - 3, true)}...`;
}

/**
 * One operator line compacted to `width` visible columns: whitespace collapsed,
 * trimmed, and column-sliced with an ellipsis when it does not fit. Three
 * extensions had this exact expression privately, differing only in the width
 * they pass.
 */
export function compactOperatorLine(value: string, width: number): string {
  const plain = value.replace(/\s+/gu, " ").trim();
  if (visibleWidth(plain) <= width) return plain;
  return `${sliceByColumn(plain, 0, width - 1)}…`;
}
