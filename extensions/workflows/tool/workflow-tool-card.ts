import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  CustomUiComponent,
  ThemeLike,
  ToolRenderContext,
  ToolRenderResultOptions,
} from "../../_shared/host/pi-api.js";
import {
  agentLiveDisplayName,
  agentLiveTitle,
  compactWorkflowParentRows,
  formatDuration,
  formatDurationCoarse,
  orderAgentLiveRows,
} from "../../_shared/agent-runtime/agent-live-panel.js";
import { defaultRenderProfile } from "../../_shared/host/render-profile.js";
import {
  agentLiveStore,
  type AgentLiveRow,
  type AgentLiveStatus,
} from "../../_shared/agent-runtime/agent-live-store.js";

const SPINNER_FRAMES = ["⠿", "⠻", "⠽", "⠾"] as const;
/**
 * The card's only time-varying content is the spinner glyph and a
 * second-granular elapsed counter, so anything faster than 1 Hz repaints
 * without a visible difference. This also matches the fleet panel's tick, which
 * stops the two live surfaces beating against each other.
 */
export const CARD_TICK_MS = 1000;
/**
 * Calm rendering has no spinner to animate and shows elapsed in coarse buckets,
 * so a 1 Hz tick would mostly re-render identical bytes; a bucket boundary can
 * lag by at most one calm tick, which is the honest trade for a still screen.
 */
const CALM_CARD_TICK_MS = 10_000;
const COMPACT_AGENT_LIMIT = 4;
export const TECHNICAL_TONE = "syntaxKeyword";
/** Left bar marking agent-answer lines so they read as the agent's own words. */
export const AGENT_ANSWER_BAR = "▌";
/** Indent that seats an answer under its agent row (marker + space width). */
const AGENT_ANSWER_INDENT = "  ";
/** Expanded per-agent answer budget; the drill overlay owns the full transcript. */
const AGENT_ANSWER_EXPANDED_MAX_LINES = 12;
/** Answers travel inside persisted tool details; keep the snapshot bounded. */
const AGENT_ANSWER_SNAPSHOT_MAX_CHARS = 2000;

export type WorkflowToolCardStatus = "running" | "completed" | "awaiting_operator" | "cancelled" | "failed" | "unknown";

export interface WorkflowToolCardAgent {
  name: string;
  work: string;
  status: AgentLiveStatus;
  startedAt?: number;
  elapsedMs?: number;
  /** The agent's returned text (completed rows only), bounded for persistence. */
  answer?: string;
}

export interface WorkflowToolCardModel {
  workflowName: string;
  status: WorkflowToolCardStatus;
  /** The operator-facing task the workflow is working on (its semantic input). */
  taskTitle?: string;
  agents: readonly WorkflowToolCardAgent[];
  technicalLines?: readonly string[];
  modelText?: string;
}

/**
 * One entry per LOGICAL agent: the journal anchor row and the SDK executor row it
 * spawned are the same actor, so anchors with a live child collapse away exactly
 * as they do in the fleet panel (`compactWorkflowParentRows`). Group summaries
 * render through the workflow rail, not as agent rows.
 */
export function snapshotWorkflowToolCardAgents(runId: string): WorkflowToolCardAgent[] {
  const scoped = [...agentLiveStore.rows.values()].filter((row) => row.workflowRunId === runId);
  return orderAgentLiveRows(compactWorkflowParentRows(scoped).filter((row) => row.groupKind === undefined)).map(
    snapshotAgent,
  );
}

function snapshotAgent(row: AgentLiveRow): WorkflowToolCardAgent {
  const answer = row.status === "done" ? (row.finalAnswer?.trim() ?? "") : "";
  return {
    name: singleLine(agentLiveDisplayName(row)) || "agent",
    work: singleLine(agentLiveTitle(row)),
    status: row.status,
    ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    ...(row.elapsedMs === undefined ? {} : { elapsedMs: row.elapsedMs }),
    ...(answer === "" ? {} : { answer: clampAnswerSnapshot(answer) }),
  };
}

function clampAnswerSnapshot(answer: string): string {
  if (answer.length <= AGENT_ANSWER_SNAPSHOT_MAX_CHARS) return answer;
  return `${answer.slice(0, AGENT_ANSWER_SNAPSHOT_MAX_CHARS - 1)}…`;
}

export function renderWorkflowToolCard(
  model: WorkflowToolCardModel,
  options: ToolRenderResultOptions,
  theme: ThemeLike,
  context: ToolRenderContext,
): WorkflowToolCardComponent {
  const previous = context.lastComponent;
  if (previous instanceof WorkflowToolCardComponent) {
    previous.update(model, options, theme, context.invalidate);
    return previous;
  }
  return new WorkflowToolCardComponent(model, options, theme, context.invalidate);
}

export class WorkflowToolCardComponent implements CustomUiComponent {
  #model: WorkflowToolCardModel;
  #options: ToolRenderResultOptions;
  #theme: ThemeLike;
  #invalidate: () => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #calm = defaultRenderProfile().calm;

  constructor(
    model: WorkflowToolCardModel,
    options: ToolRenderResultOptions,
    theme: ThemeLike,
    invalidate: () => void,
  ) {
    this.#model = model;
    this.#options = options;
    this.#theme = theme;
    this.#invalidate = invalidate;
    this.#syncTimer();
  }

  update(
    model: WorkflowToolCardModel,
    options: ToolRenderResultOptions,
    theme: ThemeLike,
    invalidate: () => void,
  ): void {
    this.#model = model;
    this.#options = options;
    this.#theme = theme;
    this.#invalidate = invalidate;
    this.#syncTimer();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const technicalWidth = Math.max(1, safeWidth - 2);
    const lines = [
      this.#rail(this.#renderHeader(technicalWidth), safeWidth),
      ...this.#renderTaskTitle(technicalWidth, safeWidth),
      ...this.#renderAgentRows(technicalWidth, safeWidth),
      ...(this.#model.technicalLines ?? []).flatMap((line) =>
        wrapTextWithAnsi(this.#fg("dim", singleLine(line)), technicalWidth).map((part) => this.#rail(part, safeWidth)),
      ),
    ];
    const modelLines = this.#renderModelText(safeWidth);
    return modelLines.length === 0 ? lines : [...lines, "", ...modelLines];
  }

  invalidate(): void {
    // Theme and model are supplied again by Pi's renderer on the next redraw.
  }

  dispose(): void {
    this.#stopTimer();
  }

  #renderHeader(width: number): string {
    const status = workflowStatusPresentation(this.#model.status);
    const state = this.#fg(status.tone, status.label);
    const name = singleLine(this.#model.workflowName) || "unknown";
    const candidates = [
      [this.#fg(TECHNICAL_TONE, "LOCUS"), " · workflow ", this.#identity(name), " · ", state],
      ["workflow ", this.#identity(name), " · ", state],
      [this.#identity(name), " · ", state],
    ];
    for (const parts of candidates) {
      const line = parts.join("");
      if (visibleWidth(line) <= width) return line;
    }
    return fitIdentityBeforeState(name, status.label, width, this.#theme, status.tone);
  }

  /** `task: <title>` directly under the LOCUS header — what this run is working on. */
  #renderTaskTitle(width: number, totalWidth: number): string[] {
    const title = singleLine(this.#model.taskTitle ?? "");
    if (title === "") return [];
    const label = this.#fg("dim", "task: ");
    const room = Math.max(1, width - visibleWidth("task: "));
    return [this.#rail(`${label}${truncateToWidth(title, room)}`, totalWidth)];
  }

  #renderAgentRows(width: number, totalWidth: number): string[] {
    if (this.#model.agents.length === 0) {
      if (this.#model.status === "running") {
        return [this.#rail(this.#fg("dim", truncateToWidth("waiting for agents…", width)), totalWidth)];
      }
      if (this.#model.status === "awaiting_operator") {
        return [this.#rail(this.#fg("warning", truncateToWidth("◐ waiting for operator decision", width)), totalWidth)];
      }
      return [];
    }
    const selected = selectAgentRows(this.#model.agents, this.#options.expanded);
    const hidden = this.#model.agents.length - selected.length;
    return [
      ...(hidden > 0
        ? [this.#rail(this.#fg("dim", truncateToWidth(`… +${hidden} other agents`, width)), totalWidth)]
        : []),
      ...selected.flatMap((agent) => [
        this.#rail(this.#renderAgent(agent, width), totalWidth),
        ...this.#renderAgentAnswer(agent, width, totalWidth),
      ]),
      ...(this.#model.status === "awaiting_operator"
        ? [this.#rail(this.#fg("warning", truncateToWidth("◐ waiting for operator decision", width)), totalWidth)]
        : []),
    ];
  }

  /**
   * The agent's returned text, seated under its row and marked with a left bar so
   * it reads as the agent's own answer: one line collapsed, a bounded block when
   * the card is expanded.
   */
  #renderAgentAnswer(agent: WorkflowToolCardAgent, width: number, totalWidth: number): string[] {
    const answerLines = agentAnswerLines(agent.answer, this.#options.expanded);
    if (answerLines.length === 0) return [];
    const bar = this.#fg(TECHNICAL_TONE, AGENT_ANSWER_BAR);
    const room = Math.max(1, width - visibleWidth(`${AGENT_ANSWER_INDENT}${AGENT_ANSWER_BAR} `));
    return answerLines.map((line) =>
      this.#rail(`${AGENT_ANSWER_INDENT}${bar} ${this.#fg("toolOutput", truncateToWidth(line, room))}`, totalWidth),
    );
  }

  #renderAgent(agent: WorkflowToolCardAgent, width: number): string {
    // Calm rendering pins the spinner to its first frame and coarsens elapsed,
    // so the card's bytes hold still between real transitions.
    const state = agentStatusPresentation(agent.status, this.#calm ? 0 : spinnerIndex());
    const marker = this.#fg(state.tone, state.marker);
    const stateText = this.#fg(state.tone, state.label);
    const identity = this.#fg(TECHNICAL_TONE, `[agent ${agent.name}]`);
    const work = agent.work === "" ? "" : ` · ${agent.work}`;
    const elapsed = formatAgentElapsed(agent, this.#calm);
    const elapsedText = elapsed === "" ? "" : this.#fg("dim", ` · ${elapsed}`);
    const full = `${marker} ${identity} ${stateText}${work}${elapsedText}`;
    if (visibleWidth(full) <= width) return full;
    const medium = `${marker} ${identity} ${stateText}${work}`;
    if (visibleWidth(medium) <= width) return medium;
    const short = `${marker} ${this.#fg(TECHNICAL_TONE, `agent ${agent.name}`)} · ${stateText}`;
    if (visibleWidth(short) <= width) return short;
    return fitAgentIdentityBeforeState(agent.name, state, width, this.#theme);
  }

  #renderModelText(width: number): string[] {
    const text = this.#model.modelText?.replace(/\n$/u, "");
    if (text === undefined || text === "") return [];
    if (!this.#options.expanded) {
      const first = text.split(/\r?\n/u).find((line) => line.trim() !== "") ?? "";
      return [truncateToWidth(this.#fg("toolOutput", first), width)];
    }
    return text
      .split(/\r?\n/u)
      .flatMap((line) => wrapTextWithAnsi(this.#fg("toolOutput", line), width))
      .map((line) => truncateToWidth(line, width));
  }

  #rail(content: string, width: number): string {
    return truncateToWidth(`${this.#fg(TECHNICAL_TONE, "│")} ${content}`, width);
  }

  #identity(text: string): string {
    return this.#fg(TECHNICAL_TONE, this.#theme.bold(text));
  }

  #fg(tone: string, text: string): string {
    return this.#theme.fg(tone, text);
  }

  #syncTimer(): void {
    const needsTicks = this.#options.isPartial && this.#model.status === "running";
    if (needsTicks && this.#timer === undefined) {
      this.#timer = setInterval(() => this.#invalidate(), this.#calm ? CALM_CARD_TICK_MS : CARD_TICK_MS);
      this.#timer.unref?.();
    } else if (!needsTicks) {
      this.#stopTimer();
    }
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export class EmptyWorkflowToolCallComponent implements CustomUiComponent {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

function workflowStatusPresentation(status: WorkflowToolCardStatus): {
  label: string;
  tone: "warning" | "success" | "error" | "muted";
} {
  switch (status) {
    case "running":
      return { label: "RUNNING", tone: "warning" };
    case "completed":
      return { label: "COMPLETED", tone: "success" };
    case "awaiting_operator":
      return { label: "AWAITING OPERATOR", tone: "warning" };
    case "cancelled":
      return { label: "CANCELLED", tone: "warning" };
    case "failed":
      return { label: "FAILED", tone: "error" };
    case "unknown":
      return { label: "UNKNOWN", tone: "muted" };
  }
}

export function agentStatusPresentation(
  status: AgentLiveStatus,
  spinner: number,
): {
  marker: string;
  label: string;
  tone: "dim" | "warning" | "success" | "error";
} {
  switch (status) {
    case "queued":
      return { marker: "○", label: "queued", tone: "dim" };
    case "working":
      return { marker: SPINNER_FRAMES[spinner] ?? "⠿", label: "working", tone: "warning" };
    case "done":
      return { marker: "✓", label: "completed", tone: "success" };
    case "cancelled":
      return { marker: "⊘", label: "cancelled", tone: "dim" };
    case "error":
      return { marker: "✗", label: "failed", tone: "error" };
  }
}

/**
 * Project an answer into displayable lines: collapsed → the first non-empty line;
 * expanded → up to {@link AGENT_ANSWER_EXPANDED_MAX_LINES} lines plus an honest
 * `… (+N lines)` tail. Empty answers yield nothing.
 */
export function agentAnswerLines(answer: string | undefined, expanded: boolean): string[] {
  const text = answer?.replace(/\n+$/u, "") ?? "";
  if (text.trim() === "") return [];
  const lines = text.split(/\r?\n/u);
  if (!expanded) {
    const first = lines.find((line) => line.trim() !== "") ?? "";
    const omitted = lines.length - 1;
    return [omitted > 0 ? `${first} … (+${omitted} lines)` : first];
  }
  if (lines.length <= AGENT_ANSWER_EXPANDED_MAX_LINES) return lines;
  const visible = lines.slice(0, AGENT_ANSWER_EXPANDED_MAX_LINES);
  return [...visible, `… (+${lines.length - visible.length} lines)`];
}

function selectAgentRows(rows: readonly WorkflowToolCardAgent[], expanded: boolean): WorkflowToolCardAgent[] {
  if (expanded || rows.length <= COMPACT_AGENT_LIMIT) return [...rows];
  const selected = new Set<WorkflowToolCardAgent>();
  for (const row of rows) {
    if (row.status === "working" || row.status === "queued") selected.add(row);
  }
  for (let index = rows.length - 1; index >= 0 && selected.size < COMPACT_AGENT_LIMIT; index -= 1) {
    const row = rows[index];
    if (row !== undefined) selected.add(row);
  }
  return rows.filter((row) => selected.has(row)).slice(-COMPACT_AGENT_LIMIT);
}

export function formatAgentElapsed(
  agent: Pick<WorkflowToolCardAgent, "startedAt" | "elapsedMs">,
  calm = false,
): string {
  // A recorded duration is fixed and stays exact; only the live wall-clock
  // reading is coarsened in calm mode, since its text changes every second.
  if (agent.elapsedMs !== undefined) return formatDuration(agent.elapsedMs);
  if (agent.startedAt === undefined) return "";
  const live = Math.max(0, Date.now() - agent.startedAt);
  return calm ? formatDurationCoarse(live) : formatDuration(live);
}

function fitIdentityBeforeState(name: string, state: string, width: number, theme: ThemeLike, tone: string): string {
  const suffix = ` · ${theme.fg(tone, state)}`;
  const available = Math.max(1, width - visibleWidth(suffix));
  const identity = theme.fg(TECHNICAL_TONE, theme.bold(truncateToWidth(name, available)));
  return truncateToWidth(`${identity}${suffix}`, width);
}

function fitAgentIdentityBeforeState(
  name: string,
  state: ReturnType<typeof agentStatusPresentation>,
  width: number,
  theme: ThemeLike,
): string {
  const marker = theme.fg(state.tone, state.marker);
  const suffix = ` · ${theme.fg(state.tone, state.label)}`;
  const fixedWidth = visibleWidth(`${marker} agent ${suffix}`);
  const available = Math.max(1, width - fixedWidth);
  const identity = theme.fg(TECHNICAL_TONE, truncateToWidth(name, available));
  return truncateToWidth(`${marker} agent ${identity}${suffix}`, width);
}

export function spinnerIndex(now = Date.now()): number {
  return Math.floor(now / CARD_TICK_MS) % SPINNER_FRAMES.length;
}

export function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
