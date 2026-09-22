/**
 * extensions/agents/tool/agent-tool-card.ts — transcript card for ONE spawned agent
 * (`spawn_agent` tool call). Each launched agent owns its own block in
 * the main window: a LOCUS rail with the agent's petname, live status, the task
 * title it is working on, and elapsed time — and, when the child returns text,
 * that answer rendered under the row marked with a left bar so it reads as the
 * agent's own words. Workflow agents stay inside the workflow's card; this card
 * exists so a directly spawned agent is never folded into someone else's block.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  CustomUiComponent,
  ThemeLike,
  ToolRenderContext,
  ToolRenderResultOptions,
  ToolResult,
} from "../../_shared/host/pi-api.js";
import { agentLiveDisplayName, agentLiveTitle } from "../../_shared/agent-runtime/agent-live-panel.js";
import { agentLiveStore, type AgentLiveStatus } from "../../_shared/agent-runtime/agent-live-store.js";
import {
  AGENT_ANSWER_BAR,
  CARD_TICK_MS,
  TECHNICAL_TONE,
  agentStatusPresentation,
  formatAgentElapsed,
  singleLine,
  spinnerIndex,
} from "../../workflows/tool/workflow-tool-card.js";

export interface AgentToolCardModel {
  /** Petname of the live row (falls back to the catalog agent name). */
  displayName: string;
  /** Catalog agent name (explore, reviewer, …) shown as dim context. */
  agentName: string;
  /** Task title the agent is working on. */
  title: string;
  status: AgentLiveStatus;
  startedAt?: number;
  elapsedMs?: number;
  /** The child's returned text (successful runs). */
  answer?: string;
  technicalLines?: readonly string[];
}

/** Collapsed answers show one line; expanded answers are complete (wrapped). */
const ANSWER_COLLAPSED_LINES = 1;

/**
 * Compose the card model from the freshest source available: the live store row
 * while the session is alive (status/elapsed/petname tick in place), otherwise
 * the persisted tool `details` written by the task tool at completion.
 */
export function renderAgentToolResultCard(
  result: ToolResult,
  options: ToolRenderResultOptions,
  theme: ThemeLike,
  context: ToolRenderContext,
): AgentToolCardComponent {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const agentName = typeof details.agent === "string" ? details.agent : "agent";
  const rowId = typeof details.rowId === "string" ? details.rowId : undefined;
  const row = rowId === undefined ? undefined : agentLiveStore.rows.get(rowId);
  const status =
    row?.status ?? agentToolCardStatus(details.status, options.isPartial, context.isError || result.isError === true);
  const displayName =
    (row === undefined ? undefined : singleLine(agentLiveDisplayName(row))) ??
    (typeof details.displayName === "string" ? details.displayName : agentName);
  const title =
    (row === undefined ? undefined : singleLine(agentLiveTitle(row))) ??
    (typeof details.title === "string" ? singleLine(details.title) : "");
  const technicalLines: string[] = [];
  if (options.expanded && typeof details.childSessionId === "string") {
    technicalLines.push(`session: ${details.childSessionId}`);
  }
  if (
    (options.expanded || status === "error" || status === "cancelled") &&
    typeof details.resultArtifact === "string"
  ) {
    technicalLines.push(`result: ${details.resultArtifact}`);
  }
  if (!options.isPartial && (status === "error" || status === "cancelled")) {
    if (typeof details.failureCause === "string") technicalLines.push(`cause: ${details.failureCause}`);
    if (typeof details.errorLogPath === "string") technicalLines.push(`errors: ${details.errorLogPath}`);
    if (typeof details.errorLogWarning === "string") technicalLines.push(details.errorLogWarning);
  }
  const failureReason = failureReasonLine(result, status, options.isPartial);
  if (failureReason !== undefined) technicalLines.push(failureReason);
  const model: AgentToolCardModel = {
    displayName,
    agentName,
    title,
    status,
    ...(row?.startedAt !== undefined
      ? { startedAt: row.startedAt }
      : typeof details.startedAt === "number"
        ? { startedAt: details.startedAt }
        : {}),
    ...(row?.elapsedMs !== undefined
      ? { elapsedMs: row.elapsedMs }
      : typeof details.elapsedMs === "number"
        ? { elapsedMs: details.elapsedMs }
        : {}),
    ...(answerFromResult(result, status, options.isPartial) ?? {}),
    technicalLines,
  };
  const previous = context.lastComponent;
  if (previous instanceof AgentToolCardComponent) {
    previous.update(model, options, theme, context.invalidate);
    return previous;
  }
  return new AgentToolCardComponent(model, options, theme, context.invalidate);
}

/** Empty call component: the result card owns the whole tool surface. */
export class EmptyAgentToolCallComponent implements CustomUiComponent {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

export class AgentToolCardComponent implements CustomUiComponent {
  #model: AgentToolCardModel;
  #options: ToolRenderResultOptions;
  #theme: ThemeLike;
  #invalidate: () => void;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(model: AgentToolCardModel, options: ToolRenderResultOptions, theme: ThemeLike, invalidate: () => void) {
    this.#model = model;
    this.#options = options;
    this.#theme = theme;
    this.#invalidate = invalidate;
    this.#syncTimer();
  }

  update(model: AgentToolCardModel, options: ToolRenderResultOptions, theme: ThemeLike, invalidate: () => void): void {
    this.#model = model;
    this.#options = options;
    this.#theme = theme;
    this.#invalidate = invalidate;
    this.#syncTimer();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const contentWidth = Math.max(1, safeWidth - 2);
    return [
      this.#rail(this.#renderHeader(contentWidth), safeWidth),
      this.#rail(this.#renderAgentRow(contentWidth), safeWidth),
      ...this.#renderAnswer(contentWidth, safeWidth),
      ...(this.#model.technicalLines ?? []).flatMap((line) =>
        wrapTextWithAnsi(this.#fg("dim", singleLine(line)), contentWidth).map((part) => this.#rail(part, safeWidth)),
      ),
    ];
  }

  invalidate(): void {
    // Theme and model are supplied again by Pi's renderer on the next redraw.
  }

  dispose(): void {
    this.#stopTimer();
  }

  #renderHeader(width: number): string {
    const status = agentHeaderPresentation(this.#model.status);
    const state = this.#fg(status.tone, status.label);
    const name = this.#fg(TECHNICAL_TONE, this.#theme.bold(this.#model.displayName));
    const candidates = [
      [this.#fg(TECHNICAL_TONE, "LOCUS"), " · agent ", name, " · ", state],
      ["agent ", name, " · ", state],
      [name, " · ", state],
    ];
    for (const parts of candidates) {
      const line = parts.join("");
      if (visibleWidth(line) <= width) return line;
    }
    return truncateToWidth(`${this.#model.displayName} · ${status.label}`, width);
  }

  #renderAgentRow(width: number): string {
    const state = agentStatusPresentation(this.#model.status, spinnerIndex());
    const marker = this.#fg(state.tone, state.marker);
    const stateText = this.#fg(state.tone, state.label);
    const identity = this.#fg(TECHNICAL_TONE, `[agent ${this.#model.displayName}]`);
    const work = this.#model.title === "" ? "" : ` · ${this.#model.title}`;
    const elapsed = formatAgentElapsed(this.#model);
    const elapsedText = elapsed === "" ? "" : this.#fg("dim", ` · ${elapsed}`);
    const full = `${marker} ${identity} ${stateText}${work}${elapsedText}`;
    if (visibleWidth(full) <= width) return full;
    const medium = `${marker} ${identity} ${stateText}${work}`;
    if (visibleWidth(medium) <= width) return medium;
    return truncateToWidth(`${marker} ${identity} ${stateText}`, width);
  }

  /**
   * The agent's returned text, marked with a left bar inside the agent's block.
   * Collapsed: the first line plus an honest remainder count. Expanded: the
   * complete answer, wrapped.
   */
  #renderAnswer(width: number, totalWidth: number): string[] {
    const text = this.#model.answer?.replace(/\n+$/u, "") ?? "";
    if (text.trim() === "") return [];
    const bar = this.#fg(TECHNICAL_TONE, AGENT_ANSWER_BAR);
    const room = Math.max(1, width - visibleWidth(`${AGENT_ANSWER_BAR} `));
    const lines = text.split(/\r?\n/u);
    if (!this.#options.expanded) {
      const first = lines.find((line) => line.trim() !== "") ?? "";
      const omitted = lines.length - ANSWER_COLLAPSED_LINES;
      const preview = omitted > 0 ? `${first} … (+${omitted} lines)` : first;
      return [this.#rail(`${bar} ${this.#fg("toolOutput", truncateToWidth(preview, room))}`, totalWidth)];
    }
    return lines.flatMap((line) =>
      wrapTextWithAnsi(this.#fg("toolOutput", line), room).map((part) => this.#rail(`${bar} ${part}`, totalWidth)),
    );
  }

  #rail(content: string, width: number): string {
    return truncateToWidth(`${this.#fg(TECHNICAL_TONE, "│")} ${content}`, width);
  }

  #fg(tone: string, text: string): string {
    return this.#theme.fg(tone, text);
  }

  #syncTimer(): void {
    const needsTicks = this.#options.isPartial && (this.#model.status === "working" || this.#model.status === "queued");
    if (needsTicks && this.#timer === undefined) {
      this.#timer = setInterval(() => this.#invalidate(), CARD_TICK_MS);
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

function agentHeaderPresentation(status: AgentLiveStatus): {
  label: string;
  tone: "warning" | "success" | "error" | "muted";
} {
  switch (status) {
    case "queued":
      return { label: "QUEUED", tone: "muted" };
    case "working":
      return { label: "RUNNING", tone: "warning" };
    case "done":
      return { label: "COMPLETED", tone: "success" };
    case "cancelled":
      return { label: "CANCELLED", tone: "warning" };
    case "error":
      return { label: "FAILED", tone: "error" };
  }
}

/** Persisted boundary status → live-row status vocabulary; partial runs are working. */
function agentToolCardStatus(value: unknown, isPartial: boolean, isError: boolean): AgentLiveStatus {
  if (isPartial) return "working";
  if (value === "completed") return "done";
  if (value === "cancelled") return "cancelled";
  if (value === "failed" || value === "blocked" || value === "storage-failed") return "error";
  return isError ? "error" : "done";
}

/** Successful final text is the agent's answer; partials and failures are not. */
function answerFromResult(
  result: ToolResult,
  status: AgentLiveStatus,
  isPartial: boolean,
): { answer: string } | undefined {
  if (isPartial || status !== "done") return undefined;
  const first = result.content.find((part) => part.type === "text");
  if (first?.type !== "text" || first.text.trim() === "") return undefined;
  return { answer: first.text };
}

/** Failures surface their reason as a dim technical line, never as an answer. */
function failureReasonLine(result: ToolResult, status: AgentLiveStatus, isPartial: boolean): string | undefined {
  if (isPartial || (status !== "error" && status !== "cancelled")) return undefined;
  const first = result.content.find((part) => part.type === "text");
  if (first?.type !== "text") return undefined;
  const firstLine = (first.text.split(/\r?\n/u, 1)[0] ?? "").trim();
  return firstLine === "" ? undefined : `reason: ${firstLine}`;
}
