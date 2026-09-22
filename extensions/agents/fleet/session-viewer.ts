import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveRow,
} from "../../_shared/agent-runtime/agent-live-store.js";
import type {
  AgentLiveTranscriptSnapshot,
  AgentTranscriptBlock,
  AgentTranscriptToolBlock,
} from "../../_shared/agent-runtime/agent-live-transcript.js";
import type { CustomUiComponent, CustomUiTui } from "../../_shared/host/pi-api.js";
import { RenderScheduler } from "../../_shared/host/render-scheduler.js";
import {
  agentLiveDisplayName,
  agentLiveTitle,
  elapsedSinceStart,
  formatDuration,
  formatDurationCoarse,
  statusMeta,
} from "../../_shared/agent-runtime/agent-live-panel.js";
import { startAgentLiveTicker, type AgentLiveTicker } from "./agent-live-tick.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { padLine, viewerExternalRows } from "../../_shared/operator/viewer-geometry.js";
import { acquireFleetViewedRow } from "../../_shared/agent-runtime/fleet-menu.js";
import type { DrillRoundsConfig } from "./drill-overlay.js";
import { renderWorkflowReturnCall } from "./workflow-return-renderer.js";

/** Pi's own TUI mode; host wrappers that omit it are treated as unknown. */
type ViewerTuiMode = "regular" | "fullscreen";

type ViewerTui = CustomUiTui & {
  mode?: ViewerTuiMode;
  terminal?: { rows: number; columns: number; write?(data: string): void };
};

interface NativeComponentModule {
  getMarkdownTheme?: () => MarkdownTheme;
  AssistantMessageComponent: new (
    message?: unknown,
    hideThinkingBlock?: boolean,
    markdownTheme?: unknown,
    hiddenThinkingLabel?: string,
    outputPad?: number,
  ) => Component & {
    updateContent(message: unknown): void;
  };
  ToolExecutionComponent: new (
    toolName: string,
    toolCallId: string,
    args: unknown,
    options: { showImages?: boolean },
    toolDefinition: NativeToolDefinition | undefined,
    ui: TUI,
    cwd: string,
  ) => Component & {
    updateArgs(args: unknown): void;
    markExecutionStarted(): void;
    setArgsComplete(): void;
    updateResult(result: unknown, isPartial?: boolean): void;
    setExpanded(expanded: boolean): void;
  };
  ExtensionEditorComponent?: new (
    tui: TUI,
    keybindings: unknown,
    title: string,
    prefill: string | undefined,
    onSubmit: (value: string) => void,
    onCancel: () => void,
    options?: { autocompleteMaxVisible?: number },
  ) => NativeInputComponent;
}

interface NativeToolDefinition {
  renderCall(args: unknown, theme: Theme, context: { expanded: boolean }): Component;
}

interface NativeInputComponent extends Component {
  focused: boolean;
  handleInput(data: string): void;
  dispose?(): void;
}

type ViewerKeybindings = { matches(data: string, keybinding: string): boolean };

type NativeToolComponent = Component & {
  updateArgs(args: unknown): void;
  markExecutionStarted(): void;
  setArgsComplete(): void;
  updateResult(result: unknown, isPartial?: boolean): void;
  setExpanded(expanded: boolean): void;
};

type NativeComponentEntry =
  | { kind: "assistant"; component: Component & { updateContent(message: unknown): void }; messageKey: string }
  | {
      kind: "tool";
      component: NativeToolComponent;
      argsKey: string;
      executionStarted: boolean;
      argsComplete: boolean;
      resultKey?: string;
      expanded: boolean;
    };

/**
 * Rows Pi keeps outside the custom component, by the host's own TUI mode.
 *
 * Regular mode costs one: the default-loaded Locus footer drawn beneath custom
 * views. Fullscreen costs two, and the second row is not optional. Pi mounts a
 * custom editor component into `editorContainer`, which sits in a dock stacked
 * under the transcript `ScrollView`, and that ScrollView is declared
 * `{ basis: 0, grow: 1, shrink: 1, minSize: 1 }`
 * (`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:624`
 * and `:640`). The dock shrinks before the ScrollView surrenders its last row,
 * so a component that asked for `rows - 1` had its final line clipped — and the
 * final line is the footer carrying every control hint. Pi's own viewport was
 * already at its bottom, so the clipped row was not somewhere the operator could
 * scroll to; it was simply gone. Reserving the row costs one line of transcript
 * and keeps the footer on screen.
 */
const PI_HOST_ROWS_BY_MODE = { regular: 1, fullscreen: 2 } as const satisfies Record<ViewerTuiMode, number>;
/**
 * Rows the viewer's own frame always costs: the breadcrumb divider, the live
 * status line beneath it, and the footer divider. Every geometry threshold below
 * is expressed against this constant rather than a literal, so the frame can
 * gain or lose a line in one place.
 */
const VIEWER_CHROME_ROWS = 3;
/** Body rows an editor must leave behind to be worth mounting in the first place. */
const MIN_BODY_ROWS_WITH_INPUT = 2;
/** Bound on the `parentRowId` walk behind the header breadcrumb. */
const MAX_LOCATION_ANCESTORS = 4;
const MOUSE_SCROLL_LINES = 3;
const ENABLE_MOUSE_SCROLL = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_SCROLL = "\u001b[?1000l\u001b[?1006l";
const MOUSE_SCROLL_ENV = "LOCUS_DRILL_MOUSE";

/**
 * How the agent screen ended, for the caller that has somewhere to go back to.
 *
 * - `back` — the operator stepped out of this screen (Esc, or cancelling the
 *   input editor) and expects to land where they came from. Opened from `/ps`,
 *   that is `/ps` again on the same row.
 * - `quit` — the screen is done rather than stepped out of: `q` leaves the agent
 *   surface altogether and hands the editor back, and so does every close the
 *   operator did not ask for (the viewed row retired underneath the screen).
 *   Reopening a fleet nobody asked for would be a surprise, and with no live
 *   rows left it would also raise a "found no live agent rows" warning.
 */
export type AgentViewerCloseReason = "back" | "quit";

/**
 * The part of the drill heading the live store cannot answer for. Today that is the
 * stage: the phase lives on the run journal's `agent_start` line, not on any live row,
 * so the caller reads it once when it opens the screen and the viewer prints it. Absent
 * for a row with no slot, no journal, or no declared phase — the heading then omits the
 * segment rather than inventing one.
 */
export interface AgentViewerLocation {
  phase?: string;
}

export type AgentViewerCapabilityResult =
  { ok: true; capability: AgentViewerCapability } | { ok: false; reason: string };

/** One guarded Pi-version boundary for both public native components. */
export class AgentViewerCapability {
  readonly #components = new Map<string, NativeComponentEntry>();
  readonly #workflowReturnToolDefinition: NativeToolDefinition;

  constructor(private readonly module: NativeComponentModule) {
    this.#workflowReturnToolDefinition = {
      renderCall: (args, theme, context) =>
        renderWorkflowReturnCall(args, theme, context, this.module.getMarkdownTheme?.()),
    };
  }

  render(blocks: readonly AgentTranscriptBlock[], tui: ViewerTui, width: number, expanded: boolean): string[] {
    const liveIds = new Set(blocks.map((block) => block.id));
    for (const id of this.#components.keys()) if (!liveIds.has(id)) this.#components.delete(id);
    return blocks.flatMap((block) => this.#component(block, tui, expanded).render(width));
  }

  invalidate(): void {
    for (const entry of this.#components.values()) entry.component.invalidate();
  }

  /**
   * Pi's own editor, mounted whole.
   *
   * It used to be dismantled here: four of its nine children were kept by index
   * and the seventh had its `render` replaced with a hand-written `↵ send`
   * hint. That tied the drill to one Pi build's child order — a reordered or
   * resized editor would have silently lost its input line — and printed key
   * names the operator's keybindings may never have had. The component now goes
   * on screen exactly as Pi draws it, hints and all; the rows that costs are
   * paid for in the viewer's geometry instead.
   */
  createInput(
    tui: ViewerTui,
    keybindings: ViewerKeybindings | undefined,
    onSubmit: (value: string) => void,
    onCancel: () => void,
  ): NativeInputComponent | undefined {
    const Input = this.module.ExtensionEditorComponent;
    if (typeof Input !== "function" || keybindings === undefined) return undefined;
    const input = new Input(tui as TUI, keybindings, "", undefined, onSubmit, onCancel, { autocompleteMaxVisible: 4 });
    input.focused = true;
    return input;
  }

  #component(block: AgentTranscriptBlock, tui: ViewerTui, expanded: boolean): Component {
    const existing = this.#components.get(block.id);
    if (block.kind === "assistant") {
      const messageKey = fingerprint(block.message);
      if (existing?.kind === "assistant") {
        if (existing.messageKey !== messageKey) {
          existing.component.updateContent(block.message);
          existing.messageKey = messageKey;
        }
        return existing.component;
      }
      const component = new this.module.AssistantMessageComponent(block.message, false, undefined, "Thinking...", 1);
      this.#components.set(block.id, { kind: "assistant", component, messageKey });
      return component;
    }
    if (existing?.kind === "tool") {
      applyToolTransition(existing, block, expanded);
      return existing.component;
    }
    const component = new this.module.ToolExecutionComponent(
      block.toolName,
      block.toolCallId,
      block.args,
      { showImages: false },
      block.toolName === "workflow_return" ? this.#workflowReturnToolDefinition : undefined,
      tui as TUI,
      block.cwd,
    );
    const entry: Extract<NativeComponentEntry, { kind: "tool" }> = {
      kind: "tool",
      component,
      argsKey: fingerprint(block.args),
      executionStarted: false,
      argsComplete: false,
      expanded: false,
    };
    applyToolTransition(entry, block, expanded);
    this.#components.set(block.id, entry);
    return component;
  }
}

export async function loadAgentViewerCapability(): Promise<AgentViewerCapabilityResult> {
  try {
    const module: unknown = await import("@earendil-works/pi-coding-agent");
    return createAgentViewerCapability(module);
  } catch (error) {
    return { ok: false, reason: `Pi viewer components could not load: ${errorMessage(error)}` };
  }
}

export function createAgentViewerCapability(module: unknown): AgentViewerCapabilityResult {
  if (!isNativeComponentModule(module)) {
    return {
      ok: false,
      reason: "Installed Pi host does not export AssistantMessageComponent and ToolExecutionComponent.",
    };
  }
  return { ok: true, capability: new AgentViewerCapability(module) };
}

export class AgentSessionViewer implements CustomUiComponent {
  #disposed = false;
  #closed = false;
  #expandedTools = false;
  #selection: number;
  #historyOffset = 0;
  #lastHistoryLineCount = 0;
  #lastBodyHeight = 1;
  #input: NativeInputComponent | undefined;
  #inputSuppressedAtRows: number | undefined;
  #submitting = false;
  #inputNotice: string | undefined;
  readonly #title: string;
  readonly #unsubscribe: () => void;
  readonly #scheduler = new RenderScheduler(() => this.tui.requestRender());
  #storeAttached = true;
  readonly #ticker: AgentLiveTicker;
  readonly #mouseScrollOwned: boolean;
  #releaseMouseScroll = () => {};
  #releaseFleetViewedRow = () => {};
  #unregisterGlobal = () => {};

  constructor(
    private readonly execution: AgentLiveExecutionHandle,
    private readonly tui: ViewerTui,
    private readonly done: (reason: AgentViewerCloseReason) => void,
    private readonly capability: AgentViewerCapability,
    private readonly rounds?: DrillRoundsConfig,
    private readonly keybindings?: ViewerKeybindings,
    private readonly theme?: unknown,
    private readonly location?: AgentViewerLocation,
  ) {
    const row = agentLiveStore.rowForExecution(execution);
    this.#title = row === undefined ? "Agent execution unavailable" : formatAgentSessionStart(row);
    if (row !== undefined) this.#releaseFleetViewedRow = acquireFleetViewedRow(row.id);
    this.#selection = rounds?.active ?? 1;
    // Read the flag per viewer, not per module: a test or a live session can flip
    // it between drills, and a module-level read would freeze the first value.
    this.#mouseScrollOwned = viewerOwnsMouseScroll(this.tui.mode, process.env[MOUSE_SCROLL_ENV]);
    if (this.#mouseScrollOwned) this.#releaseMouseScroll = acquireTerminalMouseScroll(this.tui);
    // Row-lifecycle handling stays synchronous and unthrottled — a vanished row
    // must close or detach the overlay at once. Only the repaint is coalesced.
    const requestRender = () => {
      if (this.#disposed) return;
      if (agentLiveStore.rowForExecution(this.execution) === undefined) {
        if (this.#isHistoricalRound()) this.#detachStore();
        else this.#close("quit");
        return;
      }
      this.#scheduler.request();
    };
    agentLiveStore.emitter.on("change", requestRender);
    this.#unsubscribe = () => agentLiveStore.emitter.off("change", requestRender);
    // The store emits on state, not on time: without a heartbeat the status line's
    // spinner and elapsed text would stand still through a long tool call. The cadence
    // is the progress panel's own 1 Hz, so the two surfaces animate a row alike.
    this.#ticker = startAgentLiveTicker({
      onTick: () => {
        if (this.#disposed) return;
        this.#scheduler.request();
      },
    });
    const dispose = () => this.dispose();
    activeSessionViewers().add(dispose);
    this.#unregisterGlobal = () => activeSessionViewers().delete(dispose);
  }

  render(width: number): string[] {
    if (this.#disposed) return [];
    const safeWidth = Math.max(1, Math.floor(width));
    const row = agentLiveStore.rowForExecution(this.execution);
    // A historical round is read back from the journal and needs no live row. A live
    // round without one has nothing left to draw, so the screen closes here instead —
    // which is why `#statusLine` below is only ever handed a row that exists.
    let statusLine: string;
    if (this.#isHistoricalRound()) {
      statusLine = padLine(themeText(this.theme, "muted", `⊙ History · round ${this.#selection}`), safeWidth);
    } else if (row === undefined) {
      this.#close("quit");
      return [];
    } else {
      statusLine = this.#statusLine(row, safeWidth);
    }
    const rounds = this.roundsLabel();
    const header = this.#dividerLine(
      `${this.#headerLabel(row)}${rounds === "" ? "" : `  ${rounds}`}`,
      safeWidth,
      "top",
    );
    const snapshot = row?.transcript;
    const content = this.#isHistoricalRound()
      ? (this.rounds?.readBody(this.#selection) ?? [`Round ${this.#selection} is not available in the run journal.`])
      : this.#nativeLines(row, snapshot, safeWidth);
    const hostRows = finiteTerminalRows(this.tui.terminal?.rows);
    const terminalRows =
      hostRows === undefined
        ? undefined
        : Math.max(1, hostRows - piHostReservedRows(this.tui.mode) - viewerExternalRows());
    const hadInput = this.#input !== undefined;
    let input = this.#syncInput(terminalRows);
    let inputLines = input?.render(safeWidth).map((line) => padLine(line, safeWidth)) ?? [];
    // What the input costs was recomputed when the editor stopped being cut down
    // to four of its children: an empty Pi editor is 12 rows — its own frame,
    // spacers, title, hint and one text row — and it grows from there until Pi's
    // editor caps its own text at 30% of the terminal. So the smallest terminal
    // that still offers input is 18 rows, not the 9 the sliced editor fit into;
    // below that the operator gets "resize terminal for input".
    //
    // The floor differs by moment. Mounting an editor is only worth it when a
    // readable body survives beside it, so the first render demands those two
    // body rows. Once it is on screen the operator may be mid-sentence, and
    // dropping the component would drop what they typed: from then on the body
    // gives up its rows first, and only an editor taller than the whole grant is
    // suppressed.
    const minBodyRows = hadInput ? 0 : MIN_BODY_ROWS_WITH_INPUT;
    if (
      terminalRows !== undefined &&
      inputLines.length > Math.max(0, terminalRows - VIEWER_CHROME_ROWS - minBodyRows)
    ) {
      this.#suppressInputForRows(terminalRows);
      input = undefined;
      inputLines = [];
    }
    const footer = this.#dividerLine(this.#footerLabel(input !== undefined), safeWidth, "bottom");
    if (terminalRows === undefined) {
      return [header, statusLine, ...content.map((line) => padLine(line, safeWidth)), ...inputLines, footer];
    }
    // Below the frame's own height there is nothing to lay out: hand back the rows
    // that were granted, outermost first, rather than overflowing the grant.
    if (terminalRows < VIEWER_CHROME_ROWS) return [header, statusLine].slice(0, terminalRows);
    const bodyHeight = Math.max(0, terminalRows - inputLines.length - VIEWER_CHROME_ROWS);
    if (this.#historyOffset > 0 && this.#lastHistoryLineCount > 0) {
      this.#historyOffset +=
        content.length - this.#lastHistoryLineCount + (this.#lastBodyHeight - Math.max(1, bodyHeight));
    }
    this.#historyOffset = Math.min(Math.max(0, content.length - bodyHeight), Math.max(0, this.#historyOffset));
    this.#lastHistoryLineCount = content.length;
    this.#lastBodyHeight = Math.max(1, bodyHeight);
    const visible = historyWindow(content, bodyHeight, this.#historyOffset).map((line) => padLine(line, safeWidth));
    return [header, statusLine, ...visible, ...inputLines, footer];
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    // Esc steps back to whatever opened this screen; `q` leaves the agent surface
    // for the editor. Both still close, so the split is only in the reason.
    if (isClose(data)) {
      this.#close("back");
      return;
    }
    if (data === "q" && this.#input === undefined) {
      this.#close("quit");
      return;
    }
    if (this.#mouseScrollOwned) {
      // Only a viewer that turned reporting on decodes and swallows the reports.
      const mouse = mouseEvent(data);
      if (mouse !== undefined) {
        if (mouse === "wheel-up") this.#scrollHistory(MOUSE_SCROLL_LINES);
        if (mouse === "wheel-down") this.#scrollHistory(-MOUSE_SCROLL_LINES);
        return;
      }
    }
    if (this.#matches(data, "app.tools.expand", ["ctrl+o"])) {
      this.#expandedTools = !this.#expandedTools;
      this.capability.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.#matches(data, "tui.select.pageUp", ["pageup", "pageUp", "\u001b[5~"])) {
      this.#scrollHistory(Math.max(1, this.#lastBodyHeight - 1));
      return;
    }
    if (this.#matches(data, "tui.select.pageDown", ["pagedown", "pageDown", "\u001b[6~"])) {
      this.#scrollHistory(-Math.max(1, this.#lastBodyHeight - 1));
      return;
    }
    if (this.#input === undefined && isNamedKey(data, "home")) {
      this.#historyOffset = Math.max(0, this.#lastHistoryLineCount - this.#lastBodyHeight);
      this.tui.requestRender();
      return;
    }
    if (this.#input === undefined && isNamedKey(data, "end")) {
      this.#historyOffset = 0;
      this.tui.requestRender();
      return;
    }
    const selectedRound = this.#selectRound(data, this.#input === undefined);
    if (selectedRound !== undefined) {
      if (selectedRound === this.rounds?.active && agentLiveStore.rowForExecution(this.execution) === undefined) {
        // The live round the operator asked for is gone: nothing to step back to.
        this.#close("quit");
        return;
      }
      this.#selection = selectedRound;
      this.#historyOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (this.#input === undefined && data === "d") {
      this.#expandedTools = !this.#expandedTools;
      this.capability.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.#input !== undefined && !this.#submitting) this.#input.handleInput(data);
  }

  invalidate(): void {
    if (this.#disposed) return;
    this.capability.invalidate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ticker.stop();
    this.#releaseMouseScroll();
    this.#releaseMouseScroll = () => {};
    this.#releaseFleetViewedRow();
    this.#releaseFleetViewedRow = () => {};
    this.#input?.dispose?.();
    this.#input = undefined;
    this.#detachStore();
    this.#unregisterGlobal();
  }

  #detachStore(): void {
    if (!this.#storeAttached) return;
    this.#storeAttached = false;
    this.#unsubscribe();
    // Drop any coalesced repaint queued before the row went away.
    this.#scheduler.cancel();
  }

  #close(reason: AgentViewerCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
    this.done(reason);
  }

  get expandedTools(): boolean {
    return this.#expandedTools;
  }

  #nativeLines(
    row: AgentLiveRow | undefined,
    snapshot: AgentLiveTranscriptSnapshot | undefined,
    width: number,
  ): string[] {
    const transcript =
      snapshot === undefined || snapshot.blocks.length === 0
        ? noTranscriptLines(row)
        : [
            ...(snapshot.omittedBlockCount > 0 ? [`… ${snapshot.omittedBlockCount} earlier block(s) omitted`] : []),
            ...this.capability.render(snapshot.blocks, this.tui, width, this.#expandedTools),
          ];
    return [
      this.#dividerLine("REQUEST", width),
      ...requestLines(row?.request, width),
      this.#dividerLine("RUNTIME", width),
      ...transcript,
    ];
  }

  /**
   * Where this agent sits: the workflow run, the stage its caller declared, every
   * live ancestor from the outermost inwards, then the agent itself. Everything but
   * the stage is read from the store rather than from any text the agent wrote; the
   * stage is the one segment no live row carries, so the caller resolves it from the
   * run journal and hands it in (`drill-command.ts:buildDrillLocation`). A row outside
   * a workflow has no location to report, so it keeps the short one-segment heading it
   * has always had, and a workflow row whose stage cannot be resolved simply omits it.
   */
  #headerLabel(row: AgentLiveRow | undefined): string {
    if (row === undefined) return this.#title;
    return [...workflowLocationSegments(row, this.location?.phase), formatAgentSessionStart(row)].join(" · ");
  }

  /**
   * The one line that answers "is it alive": the shared `statusMeta` icon/word for
   * this row's state plus how long it has been in flight. Both halves move on the
   * 1 Hz ticker — the spinner frame while it is working, the elapsed text as it
   * crosses a bucket — and calm freezes only the frame, which is why the elapsed
   * text coarsens with it instead of counting seconds nobody is watching.
   */
  #statusLine(row: AgentLiveRow, width: number): string {
    const meta = statusMeta(row.status, this.#ticker.spinnerIndex);
    // A finished row reports its recorded duration; a live one is measured from its
    // start, so the number keeps moving exactly while the work does.
    const elapsedMs = row.elapsedMs ?? elapsedSinceStart(row);
    const elapsed = this.#ticker.calm ? formatDurationCoarse(elapsedMs) : formatDuration(elapsedMs);
    const text = `${meta.icon} ${meta.word}${elapsed === "" ? "" : ` · ${elapsed}`}`;
    return padLine(themeText(this.theme, meta.color, text), width);
  }

  #dividerLine(label: string, width: number, style: DividerStyle = "section"): string {
    // `borderMuted` sank the labelled dividers into the background; these lines
    // carry the section names, so they take the readable muted tone instead.
    return themeText(this.theme, "muted", dividerLine(label, width, style));
  }

  #isHistoricalRound(): boolean {
    return this.rounds !== undefined && this.#selection !== this.rounds.active;
  }

  #selectRound(data: string, allowPlainArrows: boolean): number | undefined {
    if (this.rounds === undefined || this.rounds.list.length <= 1) return undefined;
    const index = this.rounds.list.indexOf(this.#selection);
    if (data === "alt+left" || (allowPlainArrows && (data === "left" || data === "\u001b[D")))
      return this.rounds.list[Math.max(0, index - 1)];
    if (data === "alt+right" || (allowPlainArrows && (data === "right" || data === "\u001b[C")))
      return this.rounds.list[Math.min(this.rounds.list.length - 1, Math.max(0, index + 1))];
    if (allowPlainArrows && /^[1-9]$/u.test(data)) {
      const round = Number(data);
      return this.rounds.list.includes(round) ? round : undefined;
    }
    return undefined;
  }

  private roundsLabel(): string {
    if (this.rounds === undefined || this.rounds.list.length <= 1) return "";
    return `rounds: ${this.rounds.list.map((round) => (round === this.#selection ? `[${round}]` : String(round))).join(" ")}`;
  }

  #syncInput(terminalRows: number | undefined): NativeInputComponent | undefined {
    const available =
      !this.#isHistoricalRound() && agentLiveStore.canSendInputForExecution(this.execution) && !this.#disposed;
    if (!available) {
      this.#input?.dispose?.();
      this.#input = undefined;
      this.#inputSuppressedAtRows = undefined;
      // The notice describes an editor that is no longer there. `message queued`
      // outliving the child that was going to read it told the operator a message
      // was still in flight after the row had settled.
      this.#inputNotice = undefined;
      return undefined;
    }
    if (this.#inputSuppressedAtRows !== undefined) {
      if (terminalRows === this.#inputSuppressedAtRows) return undefined;
      this.#inputSuppressedAtRows = undefined;
    }
    this.#input ??= this.capability.createInput(
      this.tui,
      this.keybindings,
      (value) => this.#submitInput(value),
      // Cancelling the editor is the same Esc the operator would press with no
      // editor on screen, so it steps back the same way.
      () => this.#close("back"),
    );
    return this.#input;
  }

  #suppressInputForRows(terminalRows: number): void {
    this.#input?.dispose?.();
    this.#input = undefined;
    this.#inputSuppressedAtRows = terminalRows;
  }

  #submitInput(value: string): void {
    if (this.#submitting) return;
    this.#submitting = true;
    this.#inputNotice = "sending…";
    this.tui.requestRender();
    void agentLiveStore.sendInputForExecution(this.execution, value).then((result) => {
      if (this.#disposed) return;
      this.#submitting = false;
      this.#inputNotice = result.ok ? "message queued" : result.reason;
      if (result.ok) {
        this.#input?.dispose?.();
        this.#input = undefined;
        this.#historyOffset = 0;
      }
      this.tui.requestRender();
    });
  }

  #scrollHistory(delta: number): void {
    const maxOffset = Math.max(0, this.#lastHistoryLineCount - this.#lastBodyHeight);
    this.#historyOffset = Math.min(maxOffset, Math.max(0, this.#historyOffset + delta));
    this.tui.requestRender();
  }

  #matches(data: string, keybinding: string, fallbacks: readonly string[]): boolean {
    try {
      if (this.keybindings?.matches(data, keybinding) === true) return true;
    } catch {
      // A partial host keybinding object degrades to the stable raw-key fallback.
    }
    return fallbacks.includes(data);
  }

  /** Controls only. The agent's state moved to the status line under the header. */
  #footerLabel(hasInput: boolean): string {
    const notice = this.#inputNotice === undefined ? "" : `${this.#inputNotice} · `;
    const history = this.#historyControls();
    const controls = [
      "esc close",
      ...(history === "" ? [] : [history]),
      ...(hasInput ? ["enter send"] : []),
      ...(!hasInput && this.#inputSuppressedAtRows !== undefined ? ["resize terminal for input"] : []),
      `ctrl+o tools:${this.#expandedTools ? "expanded" : "compact"}`,
    ];
    return `${notice}${controls.join(" · ")}`;
  }

  /**
   * What actually moves this screen's history, which is not the same in both host
   * modes and does not depend on whether an editor is mounted.
   *
   * The wheel half was previously offered only next to an editor, so a settled row
   * under `LOCUS_DRILL_MOUSE=1` captured wheel reports while advertising keys alone.
   *
   * The key half is absent in fullscreen because it does not work there, and this
   * component cannot make it work. `TuiAltScreen` registers `handleViewportInput`
   * as a TUI-wide input listener in its own constructor
   * (`@earendil-works/pi-tui/dist/tui-alt-screen.js:77`), and that listener answers
   * `{ consume: true }` for `tui.altScreen.pageUp`, `pageDown`, `top` and `bottom` —
   * bound by default to PageUp, PageDown, Home and End
   * (`@earendil-works/pi-tui/dist/keybindings.js:91-116`), with the upstream comment
   * saying they "intentionally shadow the unmodified editor bindings in fullscreen
   * mode". Input listeners run to completion before `handleTerminalInput` ever
   * reaches the focused component (`@earendil-works/pi-tui/dist/tui.js:557-563`), and
   * the alt-screen listener is registered before any component exists, so no
   * ordering, focus or overlay trick puts this viewer in front of it. The keys are
   * still handled below: an operator who rebinds those four `tui.altScreen.*`
   * actions gets them back, and regular mode never had the problem.
   */
  #historyControls(): string {
    const keys = process.platform === "darwin" ? "fn+Up/Down" : "pgup/pgdn";
    if (this.#mouseScrollOwned) return `wheel/${keys} history`;
    return this.tui.mode === "fullscreen" ? "" : `${keys} history`;
  }
}

function noTranscriptLines(row: AgentLiveRow | undefined): string[] {
  if (row === undefined) return ["Agent row is no longer available."];
  const finalAnswer = row.finalAnswer?.trim();
  if (finalAnswer !== undefined && finalAnswer !== "") {
    const recordedText =
      row.status === "cancelled"
        ? "recorded cancellation text"
        : row.status === "error"
          ? "recorded failure text"
          : row.status === "done"
            ? "recorded terminal text"
            : "recorded row text";
    return [
      `No child transcript is available; showing ${recordedText}.`,
      ...(row.resultArtifact === undefined ? [] : [`source: ${row.resultArtifact}`]),
      "",
      ...finalAnswer.split(/\r?\n/u),
      ...row.errors.map((error) => `error: ${error}`),
    ];
  }
  if (row.errors.length > 0) {
    return ["No child transcript or readable answer is available.", ...row.errors.map((error) => `error: ${error}`)];
  }
  switch (row.status) {
    case "queued":
      return ["Agent is queued; no assistant output yet."];
    case "working":
      return ["Agent is working; waiting for assistant output…"];
    case "done":
      return ["Agent completed without assistant output."];
    case "cancelled":
      return ["Agent was cancelled before assistant output."];
    case "error":
      return ["Agent failed before assistant output."];
  }
}

const ACTIVE_SESSION_VIEWERS_KEY = Symbol.for("locus-pi.active-agent-session-viewers.v1");
const MOUSE_SCROLL_LEASES_PROPERTY = "__locusPiMouseScrollLeases";

type MouseScrollLease = { owners: number };

interface ActiveSessionViewerRegistry extends Set<() => void> {
  [MOUSE_SCROLL_LEASES_PROPERTY]?: Map<object, MouseScrollLease>;
}

function activeSessionViewers(): ActiveSessionViewerRegistry {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[ACTIVE_SESSION_VIEWERS_KEY];
  if (existing instanceof Set) return existing as ActiveSessionViewerRegistry;
  const registry: ActiveSessionViewerRegistry = new Set<() => void>();
  Object.defineProperty(runtimeGlobal, ACTIVE_SESSION_VIEWERS_KEY, {
    value: registry,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return registry;
}

export function disposeAgentSessionViewers(): void {
  for (const dispose of [...activeSessionViewers()]) dispose();
}

/** True while the expanded viewer owns terminal input and Escape. */
export function hasActiveAgentSessionViewer(): boolean {
  return activeSessionViewers().size > 0;
}

function applyToolTransition(
  entry: Extract<NativeComponentEntry, { kind: "tool" }>,
  block: AgentTranscriptToolBlock,
  expanded: boolean,
): void {
  const argsKey = fingerprint(block.args);
  if (entry.argsKey !== argsKey) {
    entry.component.updateArgs(block.args);
    entry.argsKey = argsKey;
  }
  if (block.executionStarted && !entry.executionStarted) {
    entry.component.markExecutionStarted();
    entry.executionStarted = true;
  }
  if (block.argsComplete && !entry.argsComplete) {
    entry.component.setArgsComplete();
    entry.argsComplete = true;
  }
  const resultKey = block.result === undefined ? undefined : fingerprint([block.result, block.isPartial]);
  if (resultKey !== undefined && entry.resultKey !== resultKey) {
    entry.component.updateResult(block.result, block.isPartial);
    entry.resultKey = resultKey;
  }
  if (entry.expanded !== expanded) {
    entry.component.setExpanded(expanded);
    entry.expanded = expanded;
  }
}

function isNativeComponentModule(value: unknown): value is NativeComponentModule {
  return (
    isRecord(value) &&
    typeof value.AssistantMessageComponent === "function" &&
    typeof value.ToolExecutionComponent === "function"
  );
}

function isClose(data: string): boolean {
  return data === "escape" || data === "\u001b";
}
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requestLines(request: string | undefined, width: number): string[] {
  if (request === undefined) return ["Original request is unavailable for this retained row."];
  const safe = request
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
  return safe.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

type DividerStyle = "top" | "section" | "bottom";

function dividerLine(label: string, width: number, style: DividerStyle = "section"): string {
  // One rounded, single-weight frame across every surface (operator blocks, drill
  // overlay, this viewer). A second line weight read as a different component.
  const fill = "─";
  const left = style === "top" ? "╭─ " : style === "bottom" ? "╰─ " : "├─ ";
  if (width <= visibleWidth(left)) return fill.repeat(width);
  const labelWidth = width - visibleWidth(left) - 1;
  const fitted = truncateToWidth(label, labelWidth, "…");
  return `${left}${fitted} ${fill.repeat(Math.max(0, labelWidth - visibleWidth(fitted)))}`;
}

/**
 * The run location of one live row, outermost segment first: `workflow <run>`, the
 * declared stage, then each live ancestor's own heading. The chain walks `parentRowId`
 * through `agentLiveStore.rows` and stops at the first row carrying a `groupKind` — a
 * group is the outermost live ancestor a workflow child has, and stopping there
 * keeps the walk bounded even if a future producer nests rows more deeply.
 *
 * Three deliberate choices:
 *
 * - Ancestors are read as ROWS (their own title/label), never by decomposing a
 *   `slotKey` or a row id. The phase is embedded in both as a string joined by an
 *   unprintable unit separator (`workflow-runtime.ts:workflowSlotKey`); a heading
 *   built by splitting those keys breaks silently the day the key format moves.
 * - The stage therefore arrives as an argument, resolved from the run journal by the
 *   caller. No live row states it: the group row is named `<kind> (<total>)`, the
 *   anchor row's label unwraps to exactly the child's own label (and is skipped here
 *   as a repetition), and the bridge gives a child no title at all.
 * - The store is the authority, not the panel projection:
 *   `compactWorkflowParentRows` re-parents a child onto the group for rendering,
 *   but it is a pure projection — here the anchor is still the child's parent and
 *   is worth naming when it says something the leaf does not.
 */
function workflowLocationSegments(row: AgentLiveRow, phase?: string): string[] {
  if (row.workflowRunId === undefined) return [];
  const leafTitle = agentLiveTitle(row);
  const stage = phase !== undefined && phase.trim() !== "" ? phase.trim() : undefined;
  const ancestors: string[] = [];
  const visited = new Set<string>([row.id]);
  let parentId = row.parentRowId;
  while (parentId !== undefined && !visited.has(parentId) && ancestors.length < MAX_LOCATION_ANCESTORS) {
    visited.add(parentId);
    const parent = agentLiveStore.rows.get(parentId);
    if (parent === undefined) break;
    const title = agentLiveTitle(parent);
    // An anchor row repeats its child's own name; one segment per distinct name,
    // and never a second spelling of the stage the caller already named.
    if (title !== "" && title !== leafTitle && title !== stage && !ancestors.includes(title)) ancestors.push(title);
    if (parent.groupKind !== undefined) break;
    parentId = parent.parentRowId;
  }
  return [`workflow ${row.workflowRunId}`, ...(stage === undefined ? [] : [stage]), ...ancestors.reverse()];
}

function themeText(theme: unknown, tone: string, text: string): string {
  if (!isRecord(theme) || typeof theme.fg !== "function") return text;
  return String(theme.fg.call(theme, tone, text));
}

function formatAgentSessionStart(row: AgentLiveRow): string {
  const start = `[agent ${agentLiveDisplayName(row)}] started work`;
  const title = agentLiveTitle(row);
  return title === "" ? start : `${start} · ${title}`;
}

function finiteTerminalRows(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(1, Math.floor(value));
}

/** Rows Pi keeps for itself; an unreported mode is laid out like regular, as before. */
function piHostReservedRows(mode: ViewerTuiMode | undefined): number {
  return mode === "fullscreen" ? PI_HOST_ROWS_BY_MODE.fullscreen : PI_HOST_ROWS_BY_MODE.regular;
}

/**
 * Home and End as terminals actually send them, not as one terminal sends them.
 *
 * Matching only `ESC[H` / `ESC[F` left both keys dead under `tmux-256color`, whose
 * terminfo says `khome=\E[1~` and `kend=\E[4~`, and under `xterm-256color`, which
 * sends `ESC O H` / `ESC O F`. `matchesKey` carries pi-tui's whole legacy and Kitty
 * table for the key (`@earendil-works/pi-tui/dist/keys.js:241-242`), so every
 * encoding a host may hand over resolves the same way. The bare name stays first
 * for hosts and tests that pass a parsed key name rather than bytes.
 */
function isNamedKey(data: string, key: "home" | "end"): boolean {
  if (data === key) return true;
  try {
    return matchesKey(data, key);
  } catch {
    // A host with a different key table must not take the screen down over a keypress.
    return false;
  }
}

function writeTerminalControl(tui: ViewerTui, sequence: string): boolean {
  const terminal = tui.terminal;
  if (terminal?.write === undefined) return false;
  try {
    terminal.write(sequence);
    return true;
  } catch {
    return false;
  }
}

/**
 * The drill leaves the terminal's mouse alone by default, so native selection and
 * the host scrollback keep working; `LOCUS_DRILL_MOUSE=1` restores wheel capture.
 * Fail-closed: fullscreen (Pi owns the mouse there) and an unknown or missing mode
 * write nothing even with the flag set.
 */
function viewerOwnsMouseScroll(mode: ViewerTuiMode | undefined, flag: string | undefined): boolean {
  return flag === "1" && mode === "regular";
}

function acquireTerminalMouseScroll(tui: ViewerTui): () => void {
  const terminal = tui.terminal;
  if (terminal?.write === undefined) return () => {};
  const registry = activeSessionViewers();
  const leases = terminalMouseScrollLeases(registry);
  const existing = leases.get(terminal);
  if (existing === undefined) {
    if (!writeTerminalControl(tui, ENABLE_MOUSE_SCROLL)) return () => {};
    leases.set(terminal, { owners: 1 });
  } else {
    existing.owners += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const lease = leases.get(terminal);
    if (lease === undefined) return;
    lease.owners -= 1;
    if (lease.owners > 0) return;
    leases.delete(terminal);
    writeTerminalControl(tui, DISABLE_MOUSE_SCROLL);
  };
}

function terminalMouseScrollLeases(registry: ActiveSessionViewerRegistry): Map<object, MouseScrollLease> {
  const existing = registry[MOUSE_SCROLL_LEASES_PROPERTY];
  if (existing !== undefined) return existing;
  const leases = new Map<object, MouseScrollLease>();
  Object.defineProperty(registry, MOUSE_SCROLL_LEASES_PROPERTY, {
    value: leases,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return leases;
}

function mouseEvent(data: string): "wheel-up" | "wheel-down" | "other" | undefined {
  const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/u.exec(data);
  if (match === null) return undefined;
  const button = Number(match[1]) & ~28;
  if (button === 64) return "wheel-up";
  if (button === 65) return "wheel-down";
  return "other";
}

function historyWindow(lines: readonly string[], height: number, offset: number): string[] {
  if (height <= 0) return [];
  const end = Math.max(0, lines.length - Math.max(0, offset));
  const start = Math.max(0, end - height);
  return lines.slice(start, end);
}
