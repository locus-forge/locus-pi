import { EventEmitter } from "node:events";
import { PetnameRegistry } from "./agent-names.js";
import { AgentLiveTranscript, type AgentLiveTranscriptSnapshot } from "./agent-live-transcript.js";

/**
 * The one process-global live-agent store.
 *
 * Every surface that only READS or PATCHES live rows — fleet menu, live panel,
 * session viewer, drill, workflow live projection — depends on this module and
 * NOT on the SDK executor that writes into it. `agent-sdk-host.ts` consumes the
 * store; the store never reaches back into the executor.
 */

export interface SdkSessionStatsLike {
  sessionId: string;
  toolCalls: number;
  toolResults: number;
  /**
   * Cumulative token usage for the child session (T-190 GREEN). pi-ai `Usage`
   * shape: `input`/`output` are the in/out token sums; `total` additionally folds
   * in cacheRead/cacheWrite, so the row counter must use `input + output`, NOT
   * `total` (which over-counts). Optional because older hosts / mocks may omit it.
   */
  tokens?: { input: number; output: number; total?: number; cacheRead?: number; cacheWrite?: number };
}

export type AgentLiveStatus = "queued" | "working" | "done" | "cancelled" | "error";
export type AgentLiveActivityState = "waiting" | "active" | "completed" | "cancelled" | "failed";
export type AgentLiveGroupKind = "parallel" | "pipeline";

const MAX_AGENT_LIVE_EVENT_LINES = 200;
const MAX_AGENT_LIVE_EVENT_LINE_LENGTH = 300;
const MAX_AGENT_LIVE_REQUEST_LENGTH = 32_000;

export interface AgentLiveRow {
  id: string;
  parentRowId?: string;
  /** Durable owner provenance. Workflow-owned rows stop only through /workflows stop. */
  workflowRunId?: string;
  agentName?: string;
  /** Memorable, deterministic petname for this row (REQ-002); assigned in `begin`. */
  displayName?: string;
  label: string;
  /** Short work description shown in the live row (≤128 chars, REQ-003); falls back to the label. */
  title?: string;
  /** Bounded original task sent to the child, kept separate from the internal kickoff capsule. */
  request?: string;
  /**
   * Workflow loop slot descriptor `(phase, label)` (REQ-009, D-006). Present only for
   * workflow agents anchored to a repeatable slot; correlates the live row with the
   * per-round journal records the drill submenu reads. Interactive agents leave it unset.
   */
  slotKey?: string;
  /**
   * Loop round for a slot (≥1). Grows only when the SAME slot is re-invoked; the row is
   * reused (never re-created), so `round++` must not re-sort or move it (T-188 W4). The
   * `· r<N>` badge renders from r2 up (r1 implicit). Unset for non-slot rows.
   */
  round?: number;
  status: AgentLiveStatus;
  activityState?: AgentLiveActivityState;
  startedAt?: number;
  elapsedMs?: number;
  lastActivityAt?: number;
  model?: string;
  thinking?: string;
  currentPath?: string;
  currentTools: string[];
  currentToolArgs?: string | undefined;
  /**
   * Wall-clock ms stamped when the active tool started; cleared on tool end /
   * tool change (T-196). Gates the `> 5s` action-sub-line timer (REQ-004 kind (c)).
   * Explicit `| undefined` so a clearing `patch` can null it under
   * exactOptionalPropertyTypes (mirrors `currentToolArgs`).
   */
  currentToolStartMs?: number | undefined;
  stepCount: number;
  turnCount?: number;
  /** Cumulative agent tokens split in/out (REQ-006); the row shows `↓(input+output)`. */
  tokenCount?: { input: number; output: number };
  childSessionId?: string;
  resultArtifact?: string;
  finalAnswer?: string;
  isolated: boolean;
  noMcp: boolean;
  groupKind?: AgentLiveGroupKind;
  groupTotal?: number;
  groupCompleted?: number;
  groupFailed?: number;
  errors: string[];
  eventLines: string[];
  /** One bounded typed semantic timeline consumed by fleet and viewer. */
  transcript?: AgentLiveTranscriptSnapshot;
  /** Pure projection of `transcript.blocks`; never independently mutated. */
  latestMessage?: string | undefined;
}

export interface AgentLiveBeginOptions {
  id?: string;
  parentRowId?: string;
  workflowRunId?: string;
  agentName?: string;
  label: string;
  title?: string;
  request?: string;
  slotKey?: string;
  round?: number;
  model?: string;
  thinking?: string;
  currentPath?: string;
  isolated?: boolean;
  noMcp?: boolean;
  groupKind?: AgentLiveGroupKind;
  groupTotal?: number;
  now?: number;
}

const AGENT_LIVE_EXECUTION_AUTHORITY = Symbol("agent-live-execution-authority");
const AGENT_LIVE_CANCELLATION_AUTHORITY = Symbol("agent-live-cancellation-authority");

export interface AgentLiveExecutionHandle {
  readonly [AGENT_LIVE_EXECUTION_AUTHORITY]: true;
}
interface AgentLiveCancellationAuthority {
  readonly [AGENT_LIVE_CANCELLATION_AUTHORITY]: true;
}

interface AgentLiveCancelRegistration {
  authority: AgentLiveCancellationAuthority;
  cancel: () => void;
  execution: AgentLiveExecutionHandle;
}

interface AgentLiveInputRegistration {
  execution: AgentLiveExecutionHandle;
  send: (text: string) => Promise<void>;
  available: () => boolean;
}

export type AgentLiveInputResult = { ok: true } | { ok: false; reason: string };

class AgentLiveStore {
  readonly rows = new Map<string, AgentLiveRow>();
  readonly emitter = new EventEmitter();
  readonly #agentNames = new Map<string, string>();
  readonly #petnames = new PetnameRegistry();
  readonly #executionAuthorities = new Map<string, AgentLiveExecutionHandle>();
  readonly #executionAuthorityRows = new WeakMap<AgentLiveExecutionHandle, string>();
  readonly #cancelRegistrations = new Map<string, AgentLiveCancelRegistration>();
  readonly #cancellationAuthorityRows = new WeakMap<AgentLiveCancellationAuthority, string>();
  readonly #inputRegistrations = new Map<string, AgentLiveInputRegistration>();
  readonly #transcripts = new Map<string, AgentLiveTranscript>();
  #nextId = 0;

  reset(): void {
    this.rows.clear();
    this.#agentNames.clear();
    this.#petnames.reset();
    this.#executionAuthorities.clear();
    this.#cancelRegistrations.clear();
    this.#inputRegistrations.clear();
    this.#transcripts.clear();
    this.#emit();
  }

  /** Remove retired rows and every private store owned by the same ids. */
  removeRows(ids: Iterable<string>): number {
    let removed = 0;
    for (const id of ids) {
      if (!this.rows.delete(id)) continue;
      this.#agentNames.delete(id);
      this.#petnames.release(id);
      this.#executionAuthorities.delete(id);
      this.#cancelRegistrations.delete(id);
      this.#inputRegistrations.delete(id);
      this.#transcripts.delete(id);
      removed += 1;
    }
    if (removed > 0) this.#emit();
    return removed;
  }

  /**
   * Attach the already-existing AbortSignal seam to a concrete live row. The
   * returned cleanup is identity-safe: a later run that reuses the same slot id
   * cannot be unregistered by an older run's finally block.
   */
  registerCancel(rowId: string, cancel: () => void): () => void {
    const execution = this.#executionAuthorities.get(rowId);
    if (execution === undefined) return () => {};
    return this.#registerCancel(rowId, execution, cancel);
  }

  registerCancelForExecution(execution: AgentLiveExecutionHandle, cancel: () => void): () => void {
    const rowId = this.#currentExecutionRowId(execution);
    if (rowId === undefined) return () => {};
    return this.#registerCancel(rowId, execution, cancel);
  }

  #registerCancel(rowId: string, execution: AgentLiveExecutionHandle, cancel: () => void): () => void {
    const authority = Object.freeze({}) as AgentLiveCancellationAuthority;
    const registration: AgentLiveCancelRegistration = { authority, cancel, execution };
    this.#cancellationAuthorityRows.set(authority, rowId);
    this.#cancelRegistrations.set(rowId, registration);
    return () => {
      if (this.#cancelRegistrations.get(rowId) === registration) this.#cancelRegistrations.delete(rowId);
    };
  }

  /** Attach the live child prompt seam while one SDK turn is accepting input. */
  registerInputForExecution(
    execution: AgentLiveExecutionHandle,
    send: (text: string) => Promise<void>,
    available: () => boolean = () => true,
  ): () => void {
    const rowId = this.#currentExecutionRowId(execution);
    if (rowId === undefined) return () => {};
    const registration: AgentLiveInputRegistration = { execution, send, available };
    this.#inputRegistrations.set(rowId, registration);
    this.#emit();
    return () => {
      if (this.#inputRegistrations.get(rowId) !== registration) return;
      this.#inputRegistrations.delete(rowId);
      this.#emit();
    };
  }

  canSendInputForExecution(execution: AgentLiveExecutionHandle): boolean {
    const rowId = this.#currentExecutionRowId(execution);
    const registration = rowId === undefined ? undefined : this.#inputRegistrations.get(rowId);
    return registration?.execution === execution && registration.available();
  }

  async sendInputForExecution(execution: AgentLiveExecutionHandle, text: string): Promise<AgentLiveInputResult> {
    if (text.trim() === "") return { ok: false, reason: "Enter a message before submitting." };
    const rowId = this.#currentExecutionRowId(execution);
    const registration = rowId === undefined ? undefined : this.#inputRegistrations.get(rowId);
    if (registration?.execution !== execution || !registration.available()) {
      return { ok: false, reason: "This agent is no longer accepting input." };
    }
    try {
      await registration.send(text);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `Agent input failed: ${errorMessage(error)}` };
    }
  }

  captureExecutionAuthority(rowId: string): AgentLiveExecutionHandle | undefined {
    return this.#executionAuthorities.get(rowId);
  }

  isExecutionAuthorityCurrent(authority: AgentLiveExecutionHandle): boolean {
    return this.#currentExecutionRowId(authority) !== undefined;
  }

  rowForExecution(execution: AgentLiveExecutionHandle): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.rows.get(rowId);
  }

  patchExecution(
    execution: AgentLiveExecutionHandle,
    patch: Partial<Omit<AgentLiveRow, "id">>,
    now = Date.now(),
  ): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.patch(rowId, patch, now);
  }

  /**
   * Terminal patch when the host lacks execution readback. Missing model proof
   * clears both request-side labels; missing thinking proof keeps the model, which
   * `patch` may replace with its readback.
   *
   * Exact optional types rule out `patch({ model: undefined })`; this also keeps request intent apart from execution.
   */
  patchExecutionWithoutReadback<Missing extends "model" | "thinking">(
    execution: AgentLiveExecutionHandle,
    missing: Missing,
    patch: Partial<Omit<AgentLiveRow, "id" | "thinking" | (Missing extends "model" ? "model" : never)>>,
    now = Date.now(),
  ): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    if (rowId === undefined) return undefined;
    const patched = this.patch(rowId, patch, now);
    if (patched === undefined) return undefined;
    // `patch()` emits, and a store listener may synchronously replace this row's
    // execution authority on that emit — the terminal-listener replacement case. The
    // second write must therefore re-check ownership and re-read the row rather than
    // writing back the pre-emit snapshot: without this, clearing the model clobbers a
    // replacement row that this execution no longer owns, and silently reverts
    // whatever the listener wrote.
    if (this.#currentExecutionRowId(execution) !== rowId) return undefined;
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    const cleared: AgentLiveRow = { ...current };
    if (missing === "model") delete cleared.model;
    delete cleared.thinking;
    this.rows.set(rowId, cleared);
    this.#emit();
    return cleared;
  }

  feedExecutionEvent(execution: AgentLiveExecutionHandle, event: unknown, now = Date.now()): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.feedSessionEvent(rowId, event, now);
  }

  applyExecutionStats(execution: AgentLiveExecutionHandle, stats: SdkSessionStatsLike): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.applySessionStats(rowId, stats);
  }

  replaceExecutionTranscript(
    execution: AgentLiveExecutionHandle,
    messages: readonly unknown[],
  ): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.replaceTranscriptFromMessages(rowId, messages);
  }

  #currentExecutionRowId(execution: AgentLiveExecutionHandle): string | undefined {
    const rowId = this.#executionAuthorityRows.get(execution);
    return rowId !== undefined && this.#executionAuthorities.get(rowId) === execution ? rowId : undefined;
  }

  captureCancellationAuthority(rowId: string): AgentLiveCancellationAuthority | undefined {
    const registration = this.#cancelRegistrations.get(rowId);
    if (registration === undefined || !this.isExecutionAuthorityCurrent(registration.execution)) return undefined;
    return registration.authority;
  }

  isCancellationAuthorityCurrent(authority: AgentLiveCancellationAuthority): boolean {
    const rowId = this.#cancellationAuthorityRows.get(authority);
    const registration = rowId === undefined ? undefined : this.#cancelRegistrations.get(rowId);
    return registration?.authority === authority && this.isExecutionAuthorityCurrent(registration.execution);
  }

  cancelWithAuthority(authority: AgentLiveCancellationAuthority): boolean {
    const rowId = this.#cancellationAuthorityRows.get(authority);
    const registration = rowId === undefined ? undefined : this.#cancelRegistrations.get(rowId);
    if (registration?.authority !== authority || !this.isExecutionAuthorityCurrent(registration.execution))
      return false;
    registration.cancel();
    return true;
  }

  /** Request cancellation of one selected child. False means no active child seam. */
  cancel(rowId: string): boolean {
    const authority = this.captureCancellationAuthority(rowId);
    return authority !== undefined && this.cancelWithAuthority(authority);
  }

  /**
   * Synchronous projection/compatibility API. It is intentionally row-id based
   * and must not be retained across an async boundary. Async producers must use
   * beginExecution() and the corresponding execution-handle methods.
   */
  begin(options: AgentLiveBeginOptions): AgentLiveRow {
    return this.#begin(options, false).row;
  }

  beginExecution(options: AgentLiveBeginOptions): AgentLiveExecutionHandle {
    return this.#begin(options, true).execution;
  }

  #begin(
    options: AgentLiveBeginOptions,
    freshExecution: boolean,
  ): { row: AgentLiveRow; execution: AgentLiveExecutionHandle } {
    const id = options.id ?? `agent-live-${Date.now()}-${++this.#nextId}`;
    const existing = this.rows.get(id);
    // Petname is stable per row: assigned once (never re-derived), and skipped for
    // group summary rows which render from their own label, not a petname.
    const isGroupRow = (options.groupKind ?? existing?.groupKind) !== undefined;
    const displayName =
      existing?.displayName ??
      (isGroupRow ? undefined : this.#displayNameFor(id, existing?.parentRowId ?? options.parentRowId));
    // Slot rounds (REQ-009): the SAME row is reused when a workflow slot is re-invoked.
    // A strictly higher round means a new iteration began — reset the per-round transient
    // fields (tools/args/tool-start/tokens/elapsed) so the row shows THIS round, not the
    // last. `round`/`slotKey` are options-win (the newer call carries the current value).
    const round = options.round ?? existing?.round;
    const slotKey = options.slotKey ?? existing?.slotKey;
    const isNewRound = existing !== undefined && options.round !== undefined && options.round > (existing.round ?? 0);
    const resetTransient = freshExecution || isNewRound;
    const lastActivityAt = freshExecution ? options.now : (existing?.lastActivityAt ?? options.now);
    const model = freshExecution ? (options.model ?? existing?.model) : (existing?.model ?? options.model);
    const thinking = freshExecution
      ? (options.thinking ?? existing?.thinking)
      : (existing?.thinking ?? options.thinking);
    const currentPath = freshExecution
      ? (options.currentPath ?? existing?.currentPath)
      : (existing?.currentPath ?? options.currentPath);
    const groupKind = freshExecution
      ? (options.groupKind ?? existing?.groupKind)
      : (existing?.groupKind ?? options.groupKind);
    const groupTotal = freshExecution
      ? (options.groupTotal ?? existing?.groupTotal)
      : (existing?.groupTotal ?? options.groupTotal);
    const request = options.request ?? (freshExecution ? undefined : existing?.request);
    if (resetTransient) this.#transcripts.delete(id);
    const row: AgentLiveRow = {
      id,
      ...(existing?.parentRowId !== undefined || options.parentRowId !== undefined
        ? { parentRowId: existing?.parentRowId ?? options.parentRowId }
        : {}),
      ...(existing?.workflowRunId !== undefined || options.workflowRunId !== undefined
        ? { workflowRunId: existing?.workflowRunId ?? options.workflowRunId }
        : {}),
      ...(existing?.agentName !== undefined || options.agentName !== undefined
        ? { agentName: existing?.agentName ?? options.agentName }
        : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      label: options.label,
      ...(existing?.title !== undefined || options.title !== undefined
        ? { title: existing?.title ?? options.title }
        : {}),
      ...(request !== undefined ? { request: boundedAgentLiveRequest(request) } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      status: freshExecution ? "queued" : (existing?.status ?? "queued"),
      activityState: freshExecution
        ? activityStateForStatus("queued")
        : (existing?.activityState ?? activityStateForStatus(existing?.status ?? "queued")),
      ...(!freshExecution && existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(!resetTransient && existing?.elapsedMs !== undefined ? { elapsedMs: existing.elapsedMs } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(currentPath !== undefined ? { currentPath } : {}),
      currentTools: resetTransient ? [] : (existing?.currentTools ?? []),
      ...(!resetTransient && existing?.currentToolArgs !== undefined
        ? { currentToolArgs: existing.currentToolArgs }
        : {}),
      ...(!resetTransient && existing?.currentToolStartMs !== undefined
        ? { currentToolStartMs: existing.currentToolStartMs }
        : {}),
      stepCount: freshExecution ? 0 : (existing?.stepCount ?? 0),
      ...(!freshExecution && existing?.turnCount !== undefined ? { turnCount: existing.turnCount } : {}),
      ...(!resetTransient && existing?.tokenCount !== undefined ? { tokenCount: existing.tokenCount } : {}),
      ...(!freshExecution && existing?.childSessionId !== undefined ? { childSessionId: existing.childSessionId } : {}),
      ...(!freshExecution && existing?.resultArtifact !== undefined ? { resultArtifact: existing.resultArtifact } : {}),
      ...(!freshExecution && existing?.finalAnswer !== undefined ? { finalAnswer: existing.finalAnswer } : {}),
      isolated: options.isolated ?? existing?.isolated ?? false,
      noMcp: options.noMcp ?? existing?.noMcp ?? false,
      ...(groupKind !== undefined ? { groupKind } : {}),
      ...(groupTotal !== undefined ? { groupTotal } : {}),
      ...(!freshExecution && existing?.groupCompleted !== undefined ? { groupCompleted: existing.groupCompleted } : {}),
      ...(!freshExecution && existing?.groupFailed !== undefined ? { groupFailed: existing.groupFailed } : {}),
      errors: freshExecution ? [] : (existing?.errors ?? []),
      eventLines: freshExecution ? [] : (existing?.eventLines ?? []),
      ...(resetTransient || existing?.transcript === undefined ? {} : { transcript: existing.transcript }),
      ...(resetTransient || existing?.latestMessage === undefined ? {} : { latestMessage: existing.latestMessage }),
    };
    this.rows.set(id, row);
    const executionAuthority = Object.freeze({}) as AgentLiveExecutionHandle;
    this.#executionAuthorityRows.set(executionAuthority, id);
    this.#executionAuthorities.set(id, executionAuthority);
    this.#cancelRegistrations.delete(id);
    this.#inputRegistrations.delete(id);
    if (options.agentName !== undefined) this.#agentNames.set(id, options.agentName);
    this.#emit();
    return { row, execution: executionAuthority };
  }

  /**
   * One petname per LOGICAL agent, not per row. A row whose parent is a plain
   * (non-group) row is the same actor as its parent — the workflow anchor row and
   * the SDK executor row it spawns — so it adopts the parent's petname instead of
   * minting a second name for the same agent. Group summaries carry no petname
   * and never donate one; a parentless (or parent-unknown) row assigns fresh.
   */
  #displayNameFor(id: string, parentRowId: string | undefined): string {
    const parent = parentRowId === undefined ? undefined : this.rows.get(parentRowId);
    const inherited = parent !== undefined && parent.groupKind === undefined ? parent.displayName : undefined;
    return inherited === undefined ? this.#petnames.assign(id) : this.#petnames.adopt(id, inherited);
  }

  claimQueuedExecution(agentName: string, fallbackLabel: string): AgentLiveExecutionHandle {
    for (const [id, row] of this.rows) {
      if (row.status !== "queued" || this.#agentNames.get(id) !== agentName) continue;
      const execution = this.#executionAuthorities.get(id);
      if (execution !== undefined) return execution;
    }
    return this.beginExecution({ agentName, label: fallbackLabel });
  }

  /**
   * Synchronous projection/compatibility API. Async producers must retain an
   * AgentLiveExecutionHandle and call patchExecution() instead.
   */
  patch(id: string, patch: Partial<Omit<AgentLiveRow, "id">>, now = Date.now()): AgentLiveRow | undefined {
    const current = this.rows.get(id);
    if (current === undefined) return undefined;
    const activityState =
      patch.activityState ??
      (patch.status !== undefined ? activityStateForStatus(patch.status) : current.activityState);
    const row: AgentLiveRow = {
      ...current,
      ...patch,
      currentTools: patch.currentTools ?? current.currentTools,
      errors: patch.errors ?? current.errors,
      eventLines: patch.eventLines ?? current.eventLines,
    };
    if (patch.status !== undefined && isTerminalAgentLiveStatus(patch.status)) {
      row.currentTools = [];
      delete row.currentToolArgs;
      delete row.currentToolStartMs;
      if (patch.elapsedMs === undefined && current.elapsedMs === undefined && current.startedAt !== undefined) {
        row.elapsedMs = Math.max(0, now - current.startedAt);
      }
    }
    if (activityState !== undefined) row.activityState = activityState;
    this.rows.set(id, row);
    this.#emit();
    return row;
  }

  claimQueuedRow(agentName: string, fallbackLabel: string): AgentLiveRow {
    for (const [id, row] of this.rows) {
      if (row.status !== "queued") continue;
      if (this.#agentNames.get(id) === agentName) return row;
    }
    return this.begin({ agentName, label: fallbackLabel });
  }

  /** Synchronous compatibility API; async event sources must call feedExecutionEvent(). */
  feedSessionEvent(rowId: string, event: unknown, now = Date.now()): AgentLiveRow | undefined {
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    const patch: Partial<Omit<AgentLiveRow, "id">> = {
      lastActivityAt: now,
      eventLines: appendAgentLiveEventLine(current.eventLines, formatAgentLiveEventLine(event)),
      ...this.#projectTranscriptEvent(rowId, current, event),
    };
    const type = eventTypeName(event);
    const willRetry = isRecord(event) && event.willRetry === true;
    if (type === "agent_end" && !willRetry) {
      patch.status = "done";
      if (current.startedAt !== undefined) patch.elapsedMs = Math.max(0, now - current.startedAt);
    } else if (willRetry || type === "willRetry") {
      patch.status = "working";
      patch.errors = [...current.errors, eventErrorMessage(event) ?? "agent retry"];
    } else if (isToolOrStepEvent(event)) {
      patch.status = "working";
      patch.stepCount = current.stepCount + 1;
      const tool = eventToolName(event);
      if (tool !== undefined) {
        if (isToolResultEvent(event)) {
          patch.currentTools = current.currentTools.filter((item) => item !== tool);
          patch.currentToolArgs = undefined;
          patch.currentToolStartMs = undefined; // tool end → drop the elapsed anchor
        } else {
          patch.currentTools = unique([...current.currentTools, tool]);
          // Stamp the start only when a *new* tool becomes active (fresh call or a
          // tool change); a re-observed same tool keeps its original anchor so the
          // >5s timer measures the real run, not the latest event (T-196 W2).
          if (!current.currentTools.includes(tool)) patch.currentToolStartMs = now;
        }
      }
    } else if (type === "agent_start" || type === "turn_start") {
      patch.status = "working";
      patch.startedAt = current.startedAt ?? now;
    }
    if (type === "turn_start") patch.turnCount = (current.turnCount ?? 0) + 1;
    const turnUsage = eventTurnUsage(event);
    if (turnUsage !== undefined) {
      patch.tokenCount = {
        input: (current.tokenCount?.input ?? 0) + turnUsage.input,
        output: (current.tokenCount?.output ?? 0) + turnUsage.output,
      };
    }
    const pathValue = eventPath(event);
    if (pathValue !== undefined) patch.currentPath = pathValue;
    const toolArgs = eventToolArgs(event);
    if (toolArgs !== undefined) patch.currentToolArgs = toolArgs;
    const error = eventErrorMessage(event);
    if (error !== undefined && type !== "willRetry") patch.errors = [...current.errors, error];
    return this.patch(rowId, patch, now);
  }

  /** Synchronous compatibility API; async stats sources must call applyExecutionStats(). */
  applySessionStats(rowId: string, stats: SdkSessionStatsLike): AgentLiveRow | undefined {
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    return this.patch(rowId, {
      stepCount: Math.max(current.stepCount, stats.toolCalls + stats.toolResults),
      currentTools: [],
      currentToolArgs: undefined,
      currentToolStartMs: undefined,
      // Cumulative in+out from getSessionStats().tokens (T-190). No usage → leave
      // tokenCount untouched so the row omits `↓<tok>` rather than showing 0.
      ...(stats.tokens !== undefined ? { tokenCount: { input: stats.tokens.input, output: stats.tokens.output } } : {}),
      eventLines: appendAgentLiveEventLine(current.eventLines, formatAgentLiveStatsLine(stats)),
    });
  }

  /** Synchronous compatibility API; async transcript sources must call replaceExecutionTranscript(). */
  replaceTranscriptFromMessages(rowId: string, messages: readonly unknown[]): AgentLiveRow | undefined {
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    const transcript = this.#transcript(rowId, current);
    return this.patch(rowId, transcriptPatch(transcript.replaceMessages(messages, current.currentPath)));
  }

  #projectTranscriptEvent(
    rowId: string,
    current: AgentLiveRow,
    event: unknown,
  ): Pick<AgentLiveRow, "transcript" | "latestMessage"> {
    return transcriptPatch(this.#transcript(rowId, current).ingest(event, current.currentPath));
  }

  #transcript(rowId: string, current: AgentLiveRow): AgentLiveTranscript {
    const existing = this.#transcripts.get(rowId);
    if (existing !== undefined) return existing;
    const transcript = new AgentLiveTranscript(current.currentPath);
    this.#transcripts.set(rowId, transcript);
    return transcript;
  }

  #emit(): void {
    this.emitter.emit("change");
  }
}

function transcriptPatch(snapshot: AgentLiveTranscriptSnapshot): Pick<AgentLiveRow, "transcript" | "latestMessage"> {
  return {
    transcript: snapshot,
    latestMessage: snapshot.latestMessage,
  };
}

/**
 * Pi loads every package entrypoint through a fresh jiti instance with
 * `moduleCache:false`. A module-local singleton is therefore duplicated between
 * `extensions/agents` and `extensions/workflows`, even though both import this
 * file. Keep exactly one process-local store behind a versioned global symbol so
 * separately loaded entrypoints observe and control the same live rows.
 */
const AGENT_LIVE_STORE_GLOBAL_KEY = Symbol.for("locus-pi.agent-live-store.v5");
interface SharedAgentLiveStoreSlot {
  version: 5;
  store: AgentLiveStore;
}

function sharedAgentLiveStore(): AgentLiveStore {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[AGENT_LIVE_STORE_GLOBAL_KEY];
  if (existing !== undefined) {
    if (!isSharedAgentLiveStoreSlot(existing)) {
      throw new Error("locus-pi: incompatible global agent live-store slot");
    }
    // The object was created by another jiti module instance. Its methods keep
    // their original private-field brand; the structural cast only exposes the
    // shared contract to this separately evaluated copy of the class.
    return existing.store as AgentLiveStore;
  }
  const slot: SharedAgentLiveStoreSlot = { version: 5, store: new AgentLiveStore() };
  Object.defineProperty(runtimeGlobal, AGENT_LIVE_STORE_GLOBAL_KEY, {
    value: slot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return slot.store;
}

function isSharedAgentLiveStoreSlot(value: unknown): value is SharedAgentLiveStoreSlot {
  if (!isRecord(value) || value.version !== 5 || !isRecord(value.store)) return false;
  return (
    value.store.rows instanceof Map &&
    typeof value.store.begin === "function" &&
    typeof value.store.beginExecution === "function" &&
    typeof value.store.rowForExecution === "function" &&
    typeof value.store.patchExecution === "function" &&
    typeof value.store.feedExecutionEvent === "function" &&
    typeof value.store.applyExecutionStats === "function" &&
    typeof value.store.replaceExecutionTranscript === "function" &&
    typeof value.store.registerCancelForExecution === "function" &&
    typeof value.store.registerInputForExecution === "function" &&
    typeof value.store.canSendInputForExecution === "function" &&
    typeof value.store.sendInputForExecution === "function" &&
    typeof value.store.cancelWithAuthority === "function" &&
    typeof value.store.captureExecutionAuthority === "function"
  );
}

export const agentLiveStore = sharedAgentLiveStore();

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolOrStepEvent(event: unknown): boolean {
  const type = eventTypeName(event).toLowerCase();
  return type.includes("tool") || type.includes("step");
}

function isToolResultEvent(event: unknown): boolean {
  const type = eventTypeName(event).toLowerCase();
  return type.includes("result") || type.includes("end") || type.includes("finish");
}

export function eventToolName(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["toolName", "tool", "name"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const toolCall = event["toolCall"];
  if (isRecord(toolCall)) {
    const name = toolCall["name"] ?? toolCall["toolName"];
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return undefined;
}

function eventPath(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["currentPath", "cwd", "workingDirectory", "path"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim() !== "") return compactAgentLiveValue(value);
  }
  return undefined;
}

function eventToolArgs(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["args", "arguments", "input"]) {
    const value = event[key];
    const formatted = eventFieldValue(value);
    if (formatted !== undefined) return formatted;
  }
  const toolCall = event["toolCall"];
  if (isRecord(toolCall)) {
    for (const key of ["args", "arguments", "input"]) {
      const formatted = eventFieldValue(toolCall[key]);
      if (formatted !== undefined) return formatted;
    }
  }
  return undefined;
}

function eventErrorMessage(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const nested of [event.message, event.error]) {
    if (!isRecord(nested)) continue;
    const message = eventFieldMessage(nested.errorMessage);
    if (message !== undefined) return message;
  }
  for (const key of ["error", "message", "reason"]) {
    const value = event[key];
    const message = eventFieldMessage(value);
    if (message !== undefined) return message;
  }
  return undefined;
}

/** Count one completed model turn. message_end carries the same message, so it is ignored. */
function eventTurnUsage(event: unknown): { input: number; output: number } | undefined {
  if (!isRecord(event) || eventTypeName(event) !== "turn_end") return undefined;
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  const input = finiteNonNegativeNumber(usage.input);
  const output = finiteNonNegativeNumber(usage.output);
  return input === undefined || output === undefined ? undefined : { input, output };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function eventTypeName(event: unknown): string {
  if (!isRecord(event)) return "unknown";
  const value = event.type;
  return typeof value === "string" && value.trim() !== "" ? value : "unknown";
}

function formatAgentLiveEventLine(event: unknown): string {
  const parts = [`event type=${eventTypeName(event)}`];
  const tool = eventToolName(event);
  if (tool !== undefined) parts.push(`tool=${tool}`);
  if (isRecord(event)) {
    for (const key of ["error", "message", "reason"]) {
      const message = eventFieldMessage(event[key]);
      if (message !== undefined) parts.push(`${key}=${message}`);
    }
  }
  return boundedAgentLiveLine(parts.join(" "));
}

function formatAgentLiveStatsLine(stats: SdkSessionStatsLike): string {
  return boundedAgentLiveLine(
    `stats sessionId=${stats.sessionId} toolCalls=${stats.toolCalls} toolResults=${stats.toolResults}`,
  );
}

function appendAgentLiveEventLine(lines: string[], line: string): string[] {
  return [...lines, line].slice(-MAX_AGENT_LIVE_EVENT_LINES);
}

export function eventFieldMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return compactAgentLiveValue(value);
  if (value instanceof Error && value.message.trim() !== "") return compactAgentLiveValue(value.message);
  return undefined;
}

function eventFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : boundedAgentLiveLine(value);
  try {
    return boundedAgentLiveLine(JSON.stringify(value));
  } catch {
    return boundedAgentLiveLine(String(value));
  }
}

function boundedAgentLiveLine(value: string): string {
  const compacted = compactAgentLiveValue(value);
  if (compacted.length <= MAX_AGENT_LIVE_EVENT_LINE_LENGTH) return compacted;
  return `${compacted.slice(0, MAX_AGENT_LIVE_EVENT_LINE_LENGTH - 1)}…`;
}

function compactAgentLiveValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function boundedAgentLiveRequest(value: string): string {
  if (value.length <= MAX_AGENT_LIVE_REQUEST_LENGTH) return value;
  const omitted = value.length - MAX_AGENT_LIVE_REQUEST_LENGTH;
  return `${value.slice(0, MAX_AGENT_LIVE_REQUEST_LENGTH)}\n\n… ${omitted} additional request character(s) omitted`;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function activityStateForStatus(status: AgentLiveStatus): AgentLiveActivityState {
  switch (status) {
    case "queued":
      return "waiting";
    case "working":
      return "active";
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}

function isTerminalAgentLiveStatus(status: AgentLiveStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}
