import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearViewerExternalRows,
  setViewerExternalRows,
} from "../../../../extensions/_shared/operator/viewer-geometry.js";
import { type TUI, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
} from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { AgentTranscriptToolBlock } from "../../../../extensions/_shared/agent-runtime/agent-live-transcript.js";
import { statusMeta } from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { DEFAULT_RENDER_MIN_INTERVAL_MS } from "../../../../extensions/_shared/host/render-scheduler.js";
import agents from "../../../../extensions/agents/index.js";
import {
  AgentSessionViewer,
  createAgentViewerCapability,
  disposeAgentSessionViewers,
  loadAgentViewerCapability,
} from "../../../../extensions/agents/fleet/session-viewer.js";
import { createHarness, emit } from "../../../test-harness.js";

const PAGE_HISTORY_HINT = process.platform === "darwin" ? "fn+Up/Down history" : "pgup/pgdn history";

class FakeAssistantComponent {
  #message: any;
  constructor(message?: unknown) {
    this.#message = message;
  }
  updateContent(message: unknown): void {
    this.#message = message;
  }
  render(): string[] {
    return (
      this.#message?.content
        ?.filter((item: any) => item.type === "text")
        .map((item: any) => `assistant:${item.text}`) ?? []
    );
  }
  invalidate(): void {}
}

class FakeToolComponent {
  #expanded = false;
  constructor(
    readonly name: string,
    readonly id: string,
    _args?: unknown,
    _options?: unknown,
    _definition?: unknown,
    private readonly ui?: { requestRender(): void },
  ) {}
  updateArgs(): void {
    this.ui?.requestRender();
  }
  markExecutionStarted(): void {
    this.ui?.requestRender();
  }
  setArgsComplete(): void {
    this.ui?.requestRender();
  }
  updateResult(): void {
    this.ui?.requestRender();
  }
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    this.ui?.requestRender();
  }
  render(): string[] {
    return [`tool:${this.name}:${this.#expanded ? "expanded" : "compact"}`];
  }
  invalidate(): void {}
}

class TallFakeToolComponent extends FakeToolComponent {
  override render(): string[] {
    return Array.from({ length: 12 }, (_, index) => `tool-output-${index}`);
  }
}

class FakeEditorComponent {
  focused = false;
  #value = "";
  constructor(
    _tui: unknown,
    _keybindings: unknown,
    private readonly title: string,
    _prefill: string | undefined,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel: () => void,
  ) {}
  render(): string[] {
    return [this.title, `> ${this.#value}`, "Enter submit · Esc cancel"];
  }
  handleInput(data: string): void {
    if (data === "enter" || data === "\n") this.onSubmit(this.#value);
    else if (data === "escape") this.onCancel();
    else this.#value += data;
  }
  invalidate(): void {}
  dispose(): void {}
}

/**
 * Stands in for Pi's editor as a container: nine children, drawn in order. A
 * viewer that keeps only some of them by index loses their markers.
 */
class ChromeFakeEditorComponent {
  focused = false;
  children = Array.from({ length: 9 }, (_, index) => ({
    render: (_width: number) => [`chrome-${index}`],
    invalidate(): void {},
  }));
  constructor(
    _tui: unknown,
    _keybindings: unknown,
    _title: string,
    _prefill: string | undefined,
    _onSubmit: (value: string) => void,
    _onCancel: () => void,
  ) {}
  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
  handleInput(): void {}
  invalidate(): void {}
  dispose(): void {}
}

/** An editor the size of the real one: 12 rows empty, one row per typed line. */
class TallFakeEditorComponent {
  static readonly floorRows = 12;
  focused = false;
  #value = "";
  constructor(
    _tui: unknown,
    _keybindings: unknown,
    _title: string,
    _prefill: string | undefined,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel: () => void,
  ) {}
  render(): string[] {
    const rows = TallFakeEditorComponent.floorRows + this.#value.split("\n").length - 1;
    const typed = this.#value.replace(/\n/gu, "|");
    return Array.from({ length: rows }, (_, index) => (index === 1 ? `editor:${typed}` : `editor-row-${index}`));
  }
  handleInput(data: string): void {
    if (data === "enter") this.onSubmit(this.#value);
    else if (data === "escape") this.onCancel();
    else this.#value += data;
  }
  invalidate(): void {}
  dispose(): void {}
}

function capability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: FakeToolComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function tallToolCapability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: TallFakeToolComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function interactiveCapability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: FakeToolComponent,
    ExtensionEditorComponent: FakeEditorComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function editorCapability(Editor: unknown) {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: FakeToolComponent,
    ExtensionEditorComponent: Editor,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function executionFor(rowId: string): AgentLiveExecutionHandle {
  const execution = agentLiveStore.captureExecutionAuthority(rowId);
  if (execution === undefined) throw new Error(`No live execution for ${rowId}`);
  return execution;
}

function workflowReturnBlock(args: unknown): AgentTranscriptToolBlock {
  return {
    id: "tool:workflow-return",
    kind: "tool",
    toolCallId: "workflow-return",
    toolName: "workflow_return",
    args,
    cwd: process.cwd(),
    executionStarted: false,
    argsComplete: false,
    isPartial: true,
  };
}

class RecordingTerminal implements Terminal {
  readonly writes: string[] = [];
  readonly kittyProtocolActive = false;

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {}

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  get output(): string {
    return this.writes.join("");
  }

  reset(): void {
    this.writes.length = 0;
  }
}

async function flushForcedRender(tui: TUI): Promise<void> {
  tui.requestRender(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  disposeAgentSessionViewers();
  agentLiveStore.reset();
  vi.unstubAllEnvs();
});

describe("AgentSessionViewer", () => {
  it("keeps a terminal-height live viewport and makes the original request reachable", () => {
    const row = agentLiveStore.begin({
      id: "request-viewer",
      agentName: "reviewer",
      label: "Review",
      request: "Inspect the changed command router and explain every regression risk before editing.",
    });
    for (let index = 0; index < 8; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `history-${index}` }], stopReason: "stop" },
      });
    }
    // Nine rows, not eight: the live status line under the header costs one body
    // row, so the same REQUEST + RUNTIME reach needs one more terminal row.
    const tui = { terminal: { rows: 9, columns: 32 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    const rendered = viewer.render(32);
    expect(rendered).toHaveLength(tui.terminal.rows - 1);
    expect(rendered.every((line) => visibleWidth(line) === 32)).toBe(true);
    expect(rendered[0]).toMatch(/^╭─ \[agent .+\] started work/u);
    expect(rendered[1]).toContain("Queued");
    expect(rendered.at(-1)).toMatch(/^╰─ esc close/u);
    expect(rendered.join("\n")).toContain("history-7");
    expect(rendered.join("\n")).not.toContain("history-0");

    viewer.handleInput("home");
    const historyStart = viewer.render(32).join("\n");
    expect(historyStart).toContain("├─ REQUEST");
    expect(historyStart).toContain("Inspect the changed command");
    expect(historyStart.indexOf("├─ REQUEST")).toBeLessThan(historyStart.indexOf("├─ RUNTIME"));
    for (const width of [1, 2, 8]) {
      const narrow = viewer.render(width);
      expect(narrow).toHaveLength(tui.terminal.rows - 1);
      expect(narrow.every((line) => visibleWidth(line) === width)).toBe(true);
    }
    viewer.dispose();
  });

  it("renders every labelled divider in one rounded frame and the readable muted tone", () => {
    const row = agentLiveStore.begin({ id: "muted-frame", agentName: "reviewer", label: "Review" });
    const fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
      undefined,
      undefined,
      { fg },
    );

    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("<muted>╭─ [agent");
    expect(rendered).toContain("<muted>├─ REQUEST");
    expect(rendered).toContain("<muted>├─ RUNTIME");
    expect(rendered).toContain("<muted>╰─ esc close");
    // Only the dividers are claimed by this rule; the status line carries the tone
    // of the state it reports (`statusMeta`), which is a different contract.
    expect(fg.mock.calls.filter(([, text]) => /^[╭├╰]/u.test(String(text))).every(([color]) => color === "muted")).toBe(
      true,
    );
    // Double-weight rules read as a second, unrelated component.
    expect(rendered).not.toMatch(/[╞╘═]/u);
    viewer.dispose();
  });

  it("reserves both the permanent footer and an active workflow widget", () => {
    const row = agentLiveStore.begin({ id: "reserved-viewer", agentName: "reviewer", label: "Review" });
    const tui = { terminal: { rows: 12, columns: 80 }, requestRender: vi.fn() };
    setViewerExternalRows("test-active-workflow", 3);
    try {
      const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());
      // header + status + 4 content rows + footer; the widget's 3 rows stay reserved.
      expect(viewer.render(80)).toHaveLength(7);
      viewer.dispose();
    } finally {
      clearViewerExternalRows("test-active-workflow");
    }
  });

  it("top-aligns a short transcript and releases unused terminal rows", () => {
    const row = agentLiveStore.begin({
      id: "short-top-aligned-viewer",
      agentName: "reviewer",
      label: "Review",
      request: "Check one file.",
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "One-line result." }], stopReason: "stop" },
    });
    const tui = { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    const rendered = viewer.render(80);
    expect(rendered).toHaveLength(7);
    expect(rendered[0]).toMatch(/^╭─ \[agent/u);
    expect(rendered[1]).toContain("Queued");
    expect(rendered[2]).toMatch(/^├─ REQUEST/u);
    expect(rendered[3]).toContain("Check one file.");
    expect(rendered[4]).toMatch(/^├─ RUNTIME/u);
    expect(rendered[5]).toContain("One-line result.");
    expect(rendered[6]).toMatch(/^╰─ esc close/u);
    expect(rendered.every((line) => line.trim() !== "")).toBe(true);
    expect(rendered.length).toBeLessThan(tui.terminal.rows - 1);
    viewer.dispose();
  });

  it("renders request control characters as text instead of terminal control sequences", () => {
    const row = agentLiveStore.begin({
      id: "safe-request-viewer",
      agentName: "reviewer",
      label: "Review",
      request: "Check \u001b[31mred\u001b[0m and \u009b31mC1-red\u009b0m output\tcarefully.",
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const rendered = viewer.render(80).join("\n");
    expect(rendered).not.toContain("\u001b[31mred");
    expect(rendered).not.toContain("\u009b");
    expect(rendered).toContain("Check �[31mred�[0m and �31mC1-red�0m output  carefully.");
    viewer.dispose();
  });

  it("follows live additions at the tail and pages through retained history", () => {
    const row = agentLiveStore.begin({ id: "viewer-row", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `message-${index}` }], stopReason: "stop" },
      });
    }
    const tui = { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    const initial = viewer.render(80);
    expect(initial).toHaveLength(tui.terminal.rows - 1);
    expect(initial.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(initial.join("\n")).toContain("message-11");
    expect(initial.join("\n")).not.toContain("message-0");

    tui.requestRender.mockClear();
    viewer.handleInput("up");
    expect(tui.requestRender).not.toHaveBeenCalled();
    viewer.handleInput("\u001b[5~");
    const pageUp = viewer.render(80).join("\n");
    expect(pageUp).toContain("message-8");
    expect(pageUp).not.toContain("message-11");
    viewer.handleInput("\u001b[6~");
    expect(viewer.render(80).join("\n")).toContain("message-11");
    viewer.handleInput("home");
    expect(viewer.render(80).join("\n")).toContain("message-0");
    viewer.handleInput("end");
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "message-12" }], stopReason: "stop" },
    });
    expect(tui.requestRender).toHaveBeenCalled();
    const updated = viewer.render(80).join("\n");
    expect(updated).toContain("message-12");
    viewer.dispose();
  });

  it("coalesces a streaming event storm into a bounded number of repaints", () => {
    // A streaming child mutates its row per SDK event. The drill overlay is
    // full-screen, so an unthrottled repaint per event is the most expensive
    // flicker source of all on a slow console.
    vi.useFakeTimers();
    try {
      const row = agentLiveStore.begin({ id: "storm-viewer", agentName: "reviewer", label: "Review" });
      const tui = { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() };
      const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());
      viewer.render(80);
      tui.requestRender.mockClear();

      for (let i = 0; i < 50; i += 1) {
        agentLiveStore.feedSessionEvent(row.id, {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: `stream-${i}` }], stopReason: "stop" },
        });
      }

      expect(tui.requestRender).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      expect(tui.requestRender).toHaveBeenCalledTimes(2);

      // The newest streamed content is still what the viewer projects.
      expect(viewer.render(80).join("\n")).toContain("stream-49");

      tui.requestRender.mockClear();
      viewer.dispose();
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures wheel history under LOCUS_DRILL_MOUSE, anchors the child output, and returns to the live tail", () => {
    vi.stubEnv("LOCUS_DRILL_MOUSE", "1");
    const row = agentLiveStore.begin({ id: "wheel-viewer", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `wheel-${index}` }], stopReason: "stop" },
      });
    }
    const execution = executionFor(row.id);
    const unregister = agentLiveStore.registerInputForExecution(execution, async () => {});
    const write = vi.fn();
    const tui = { mode: "regular" as const, terminal: { rows: 14, columns: 80, write }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(execution, tui, vi.fn(), interactiveCapability(), undefined, {
      matches: () => false,
    });

    expect(write).toHaveBeenCalledWith("\u001b[?1000h\u001b[?1006h");
    const initial = viewer.render(80).join("\n");
    expect(initial).toContain("wheel-11");
    expect(initial).not.toContain("Message to Agent");

    viewer.handleInput("\u001b[<64;10;5M");
    const scrolled = viewer.render(80).join("\n");
    expect(scrolled).toContain("wheel-5");
    expect(scrolled).not.toContain("wheel-11");

    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "wheel-12" }], stopReason: "stop" },
    });
    const anchored = viewer.render(80).join("\n");
    expect(anchored).toContain("wheel-5");
    expect(anchored).not.toContain("wheel-12");

    viewer.handleInput("\u001b[<65;10;5M");
    viewer.handleInput("\u001b[<65;10;5M");
    expect(viewer.render(80).join("\n")).toContain("wheel-12");

    viewer.handleInput("\u001b[<0;10;5M");
    viewer.handleInput("x");
    expect(viewer.render(80).join("\n")).toContain("> x");

    viewer.dispose();
    expect(write).toHaveBeenLastCalledWith("\u001b[?1000l\u001b[?1006l");
    unregister();
  });

  it("keeps mouse capture under the flag until the last overlapping viewer releases the shared terminal", () => {
    vi.stubEnv("LOCUS_DRILL_MOUSE", "1");
    const first = agentLiveStore.begin({ id: "mouse-owner-a", agentName: "reviewer", label: "A" });
    const second = agentLiveStore.begin({ id: "mouse-owner-b", agentName: "reviewer", label: "B" });
    const write = vi.fn();
    const tui = { mode: "regular" as const, terminal: { rows: 8, columns: 80, write }, requestRender: vi.fn() };
    const firstViewer = new AgentSessionViewer(executionFor(first.id), tui, vi.fn(), capability());
    const secondViewer = new AgentSessionViewer(executionFor(second.id), tui, vi.fn(), capability());

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith("\u001b[?1000h\u001b[?1006h");
    firstViewer.dispose();
    expect(write).toHaveBeenCalledTimes(1);
    secondViewer.dispose();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith("\u001b[?1000l\u001b[?1006l");
  });

  it("releases mouse capture under the flag when the owning Pi session shuts down", async () => {
    vi.stubEnv("LOCUS_DRILL_MOUSE", "1");
    const h = createHarness(process.cwd());
    agents(h.pi);
    await emit(h, "session_start");
    const row = agentLiveStore.begin({ id: "shutdown-viewer", agentName: "reviewer", label: "Shutdown" });
    const write = vi.fn();
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { mode: "regular" as const, terminal: { rows: 8, columns: 80, write }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    expect(write).toHaveBeenLastCalledWith("\u001b[?1000h\u001b[?1006h");

    await emit(h, "session_shutdown", { reason: "exit" });

    expect(write).toHaveBeenLastCalledWith("\u001b[?1000l\u001b[?1006l");
    expect(viewer.render(80)).toEqual([]);
  });

  it("leaves the terminal mouse alone in regular mode without the flag, and drops wheel from the hint", () => {
    const row = agentLiveStore.begin({ id: "no-flag-viewer", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const unregister = agentLiveStore.registerInputForExecution(execution, async () => {});
    const write = vi.fn();
    const tui = { mode: "regular" as const, terminal: { rows: 14, columns: 80, write }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(execution, tui, vi.fn(), interactiveCapability(), undefined, {
      matches: () => false,
    });

    expect(write).not.toHaveBeenCalled();
    const footer = viewer.render(80).at(-1) ?? "";
    expect(footer).toContain(`${PAGE_HISTORY_HINT} · enter send`);
    expect(footer).not.toContain("wheel");

    viewer.dispose();
    expect(write).not.toHaveBeenCalled();
    unregister();
  });

  it("writes neither enable nor disable in fullscreen even with the flag set", () => {
    vi.stubEnv("LOCUS_DRILL_MOUSE", "1");
    const row = agentLiveStore.begin({ id: "fullscreen-viewer", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `fullscreen-${index}` }], stopReason: "stop" },
      });
    }
    const write = vi.fn();
    const tui = { mode: "fullscreen" as const, terminal: { rows: 14, columns: 80, write }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    expect(write).not.toHaveBeenCalled();
    // Pi owns the wheel in fullscreen; the viewer neither decodes nor scrolls on it.
    const tail = viewer.render(80).join("\n");
    viewer.handleInput("\u001b[<64;10;5M");
    expect(viewer.render(80).join("\n")).toEqual(tail);

    viewer.dispose();
    expect(write).not.toHaveBeenCalled();
  });

  it("stays fail-closed when the host TUI reports no mode, even with the flag set", () => {
    vi.stubEnv("LOCUS_DRILL_MOUSE", "1");
    const row = agentLiveStore.begin({ id: "unknown-mode-viewer", agentName: "reviewer", label: "Review" });
    const write = vi.fn();
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 8, columns: 80, write }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    expect(write).not.toHaveBeenCalled();
    viewer.dispose();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a stable terminal-height viewport through Pi TUI across live and control redraws", async () => {
    const row = agentLiveStore.begin({
      id: "tui-scrollback-row",
      agentName: "reviewer",
      label: "Review",
      request: "Inspect every retained message.",
    });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `scrollback-${index}` }], stopReason: "stop" },
      });
    }
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-scrollback",
      toolName: "read",
      args: { path: "README.md" },
    });
    const terminal = new RecordingTerminal(80, 8);
    const tui = new TuiMainScreen(terminal, false);
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability(), {
      active: 2,
      list: [1, 2],
      readBody: (round) => (round === 1 ? ["historical-round-1"] : undefined),
    });
    tui.addChild(viewer);

    await flushForcedRender(tui);
    expect(terminal.output.split("\r\n")).toHaveLength(terminal.rows - 1);
    expect(terminal.output).toContain("scrollback-11");
    expect(terminal.output).toContain("tool:read:compact");

    viewer.handleInput("home");
    expect(viewer.render(80).join("\n")).toContain("Inspect every retained message.");
    viewer.handleInput("end");

    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "scrollback-12" }], stopReason: "stop" },
    });
    await vi.waitFor(() => expect(terminal.output).toContain("scrollback-12"));

    terminal.reset();
    viewer.handleInput("d");
    await flushForcedRender(tui);
    expect(terminal.output).toContain("tool:read:expanded");
    expect(viewer.render(80).join("\n")).toContain("scrollback-12");

    terminal.reset();
    viewer.handleInput("left");
    await flushForcedRender(tui);
    expect(terminal.output).toContain("historical-round-1");
    viewer.handleInput("right");
    await flushForcedRender(tui);
    expect(viewer.render(80).join("\n")).toContain("scrollback-12");

    viewer.dispose();
    tui.stop();
  });

  it("does not clear the terminal or scrollback when live content above a tall tool changes", async () => {
    const row = agentLiveStore.begin({ id: "stable-live-viewport", agentName: "reviewer", label: "Review" });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_start",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "draft" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
        ],
      },
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    const terminal = new RecordingTerminal(80, 8);
    const tui = new TuiMainScreen(terminal, false);
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), tallToolCapability());
    tui.addChild(viewer);
    await flushForcedRender(tui);

    terminal.reset();
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "revised" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
        ],
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminal.output).not.toContain("\u001b[2J\u001b[H\u001b[3J");
    viewer.dispose();
    tui.stop();
  });

  it("toggles native tool detail and closes without cancelling the row", () => {
    const row = agentLiveStore.begin({ id: "tool-row", agentName: "reviewer", label: "Review" });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    const done = vi.fn();
    const tui = { terminal: { rows: 6, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, done, capability());

    expect(viewer.render(80).join("\n")).toContain("tool:read:compact");
    tui.requestRender.mockClear();
    viewer.render(80);
    expect(tui.requestRender).not.toHaveBeenCalled();
    viewer.handleInput("d");
    expect(viewer.render(80).join("\n")).toContain("tool:read:expanded");
    viewer.handleInput("escape");
    viewer.dispose();

    expect(done).toHaveBeenCalledTimes(1);
    expect(agentLiveStore.rows.get(row.id)?.status).toBe("working");
  });

  it("uses Pi's editor surface to send input to the active child", async () => {
    const row = agentLiveStore.begin({ id: "interactive-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const done = vi.fn();
    const tui = { terminal: { rows: 14, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(execution, tui, done, interactiveCapability(), undefined, {
      matches: () => false,
    });

    const initial = viewer.render(80);
    // 9 + the status line: header, status, 4 content rows, 3 editor rows, footer.
    expect(initial).toHaveLength(10);
    expect(initial.length).toBeLessThan(tui.terminal.rows - 1);
    expect(initial.join("\n")).not.toContain("Message to Agent");
    expect(initial.join("\n")).not.toContain("MESSAGE TO AGENT");
    expect(initial[1]).toContain("Queued");
    expect(initial.at(-1)).toMatch(/^╰─ esc close/u);
    viewer.handleInput("h");
    viewer.handleInput("i");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("hi"));
    await vi.waitFor(() => expect(viewer.render(80).join("\n")).toContain("message queued"));
    expect(done).not.toHaveBeenCalled();

    unregister();
    viewer.dispose();
  });

  it("does not capture input through an editor that cannot fit in the terminal", async () => {
    const row = agentLiveStore.begin({ id: "short-interactive-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const tui = { terminal: { rows: 4, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(execution, tui, vi.fn(), interactiveCapability(), undefined, {
      matches: () => false,
    });

    const compact = viewer.render(80);
    expect(compact).toHaveLength(tui.terminal.rows - 1);
    expect(compact.join("\n")).toContain("resize terminal for input");
    viewer.handleInput("x");
    viewer.handleInput("enter");
    expect(send).not.toHaveBeenCalled();

    tui.terminal.rows = 14;
    expect(viewer.render(80).join("\n")).toContain("enter send");
    viewer.handleInput("x");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("x"));

    unregister();
    viewer.dispose();
  });

  it("types round-number digits into the active editor instead of changing rounds", async () => {
    const row = agentLiveStore.begin({ id: "round-input-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const viewer = new AgentSessionViewer(
      execution,
      { terminal: { rows: 14, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      interactiveCapability(),
      { active: 2, list: [1, 2], readBody: () => ["historical round"] },
      { matches: () => false },
    );

    viewer.render(80);
    viewer.handleInput("1");
    viewer.handleInput("x");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("1x"));

    unregister();
    viewer.dispose();
  });

  it("draws every part of the editor component instead of keeping children by index", () => {
    const row = agentLiveStore.begin({ id: "whole-editor-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const unregister = agentLiveStore.registerInputForExecution(execution, async () => {});
    const viewer = new AgentSessionViewer(
      execution,
      { terminal: { rows: 30, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      editorCapability(ChromeFakeEditorComponent),
      undefined,
      { matches: () => false },
    );

    const rendered = viewer.render(80).map((line) => line.trimEnd());
    for (let index = 0; index < 9; index += 1) expect(rendered).toContain(`chrome-${index}`);
    // The editor's own hints are whatever it drew; the viewer adds none of its own.
    expect(rendered.join("\n")).not.toContain("↵ send");

    unregister();
    viewer.dispose();
  });

  it("asks for the rows a whole editor needs before mounting one", () => {
    const row = agentLiveStore.begin({ id: "editor-floor-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const unregister = agentLiveStore.registerInputForExecution(execution, async () => {});
    // 12 editor rows + 3 frame rows + 2 body rows + Pi's own footer row.
    const tui = { terminal: { rows: 17, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(
      execution,
      tui,
      vi.fn(),
      editorCapability(TallFakeEditorComponent),
      undefined,
      {
        matches: () => false,
      },
    );

    const tooShort = viewer.render(80);
    expect(tooShort.join("\n")).toContain("resize terminal for input");
    expect(tooShort.join("\n")).not.toContain("editor:");
    expect(tooShort.length).toBeLessThan(tui.terminal.rows);

    tui.terminal.rows = 18;
    const fits = viewer.render(80);
    expect(fits.join("\n")).toContain("editor:");
    expect(fits.join("\n")).toContain("enter send");
    expect(fits).toHaveLength(tui.terminal.rows - 1);

    unregister();
    viewer.dispose();
  });

  it("lets a growing editor take the body's rows rather than dropping what was typed", () => {
    const row = agentLiveStore.begin({ id: "growing-editor-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const tui = { terminal: { rows: 18, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(
      execution,
      tui,
      vi.fn(),
      editorCapability(TallFakeEditorComponent),
      undefined,
      {
        matches: () => false,
      },
    );

    viewer.render(80);
    // Two more editor rows than the mount budget allowed: the two body rows go
    // first, and the half-written message is still on screen.
    viewer.handleInput("a");
    viewer.handleInput("\n");
    viewer.handleInput("b");
    viewer.handleInput("\n");
    viewer.handleInput("c");
    const grown = viewer.render(80);
    expect(grown.join("\n")).toContain("editor:a|b|c");
    expect(grown).toHaveLength(tui.terminal.rows - 1);
    expect(grown.join("\n")).not.toContain("resize terminal for input");

    unregister();
    viewer.dispose();
  });

  it("mounts the installed Pi native editor inside the compact content-height viewport", async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme(undefined, false);
    const loaded = await loadAgentViewerCapability();
    if (!loaded.ok) throw new Error(loaded.reason);
    const row = agentLiveStore.begin({ id: "native-editor-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const terminal = new RecordingTerminal(80, 24);
    const tui = new TuiMainScreen(terminal, false);
    const viewer = new AgentSessionViewer(execution, tui, vi.fn(), loaded.capability, undefined, {
      matches: () => false,
    });
    tui.addChild(viewer);

    const rendered = viewer.render(80);
    // Header, status, four content rows, the whole 12-row Pi editor, footer. The
    // editor is no longer cut down to four of its children, so it costs the rows
    // Pi charges for it and the viewer still fits inside the terminal.
    expect(rendered).toHaveLength(19);
    expect(rendered.length).toBeLessThan(terminal.rows - 1);
    // Pi's own key hints, read from the live keybindings, instead of a
    // hand-written line that named keys this build may not bind.
    const text = rendered.join("\n");
    expect(text).not.toContain("↵ send · ⇧↵ newline");
    expect(text).toContain(" submit");
    expect(text).toContain(" newline");
    expect(text).toContain(" cancel");
    expect(text).toContain("external");
    viewer.handleInput("o");
    viewer.handleInput("k");
    viewer.handleInput("\r");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("ok"));

    unregister();
    viewer.dispose();
    tui.stop();
  });

  it("renders workflow_return Markdown leaves under their exact keys and indices while retaining raw args", async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme(undefined, false);
    const loaded = await loadAgentViewerCapability();
    if (!loaded.ok) throw new Error(loaded.reason);
    const tui = { requestRender: vi.fn() };
    const args = {
      value: [
        "# Summary\n\n- exact line",
        { section: "**Nested result**\n\n`code`", count: 2 },
        false,
        "literal\\nsequence",
        "unsafe:\u001b]52;c;payload\u0007",
      ],
    };
    const retained = structuredClone(args);
    const block = workflowReturnBlock(args);

    const compact = loaded.capability.render([block], tui, 80, false).join("\n");
    expect(compact).toContain("workflow_return");
    expect(compact).toContain('"value":');
    expect(compact).toContain("[0]:");
    expect(compact).toContain("[1]:");
    expect(compact).toContain('"section":');
    expect(compact).toContain("Summary");
    expect(compact).toContain("Nested result");
    expect(compact).toContain('"count":');
    expect(compact).toContain("2");
    expect(compact).toContain("literal\\nsequence");
    expect(compact).toContain("unsafe:�]52;c;payload�");
    expect(compact).not.toContain("\u001b]52");
    expect(compact).not.toContain("# Summary\\n\\n- exact line");
    expect(args).toEqual(retained);

    const expanded = loaded.capability.render([block], tui, 120, true).join("\n");
    expect(expanded).toContain('"value": [');
    expect(expanded).toContain("# Summary\\n\\n- exact line");
    expect(expanded).toContain("unsafe:\\u001b]52;c;payload\\u0007");
    expect(args).toEqual(retained);
  });

  it("keeps native workflow_return result and error transitions around the readable call", async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme(undefined, false);
    const loaded = await loadAgentViewerCapability();
    if (!loaded.ok) throw new Error(loaded.reason);
    const tui = { requestRender: vi.fn() };
    const pending = workflowReturnBlock({ value: "## Result\n\nReadable while pending." });
    const started = { ...pending, executionStarted: true, argsComplete: true };
    const complete: AgentTranscriptToolBlock = {
      ...started,
      result: { content: [{ type: "text", text: "workflow accepted" }], isError: false },
      isPartial: false,
    };
    const failed: AgentTranscriptToolBlock = {
      ...complete,
      result: { content: [{ type: "text", text: "workflow rejected" }], isError: true },
    };

    expect(loaded.capability.render([pending], tui, 80, false).join("\n")).toContain("Readable while pending.");
    expect(loaded.capability.render([started], tui, 80, false).join("\n")).toContain("Readable while pending.");
    expect(loaded.capability.render([complete], tui, 80, false).join("\n")).toContain("workflow accepted");
    const error = loaded.capability.render([failed], tui, 80, false).join("\n");
    expect(error).toContain("Readable while pending.");
    expect(error).toContain("workflow rejected");
  });

  it("falls back to raw malformed workflow_return args without a title-only card and stays within width", async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme(undefined, false);
    const loaded = await loadAgentViewerCapability();
    if (!loaded.ok) throw new Error(loaded.reason);
    const tui = { requestRender: vi.fn() };
    const malformed = workflowReturnBlock({ unexpected: "line one\nline two" });

    const rendered = loaded.capability.render([malformed], tui, 80, false).join("\n");
    expect(rendered).toContain("workflow_return");
    expect(rendered).toContain('"unexpected": "line one\\nline two"');

    const row = agentLiveStore.begin({ id: "malformed-workflow-return", agentName: "reviewer", label: "Review" });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: malformed.toolCallId,
            name: malformed.toolName,
            arguments: malformed.args,
          },
        ],
        stopReason: "toolUse",
      },
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      loaded.capability,
    );
    for (const width of [1, 2, 8, 24]) {
      expect(viewer.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
    }
    viewer.dispose();
  });

  it("keeps Escape ownership without treating bare arrow keys as transcript scrolling", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    const row = agentLiveStore.begin({ id: "guarded-viewer", agentName: "reviewer", label: "Review" });
    const done = vi.fn();
    const tui = { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, done, capability());

    expect([...h.terminalInputHandlers].map((handler) => handler("down")).every((result) => result === undefined)).toBe(
      true,
    );
    tui.requestRender.mockClear();
    viewer.handleInput("down");
    expect(tui.requestRender).not.toHaveBeenCalled();

    expect(
      [...h.terminalInputHandlers].map((handler) => handler("escape")).every((result) => result === undefined),
    ).toBe(true);
    expect(h.confirmCalls).toHaveLength(0);
    viewer.handleInput("escape");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cleans its listener idempotently and reports missing native capability", () => {
    const row = agentLiveStore.begin({ id: "cleanup-row", agentName: "reviewer", label: "Review" });
    const before = agentLiveStore.emitter.listenerCount("change");
    const viewer = new AgentSessionViewer(executionFor(row.id), { requestRender: vi.fn() }, vi.fn(), capability());
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);
    viewer.dispose();
    viewer.dispose();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);

    expect(createAgentViewerCapability({})).toEqual({
      ok: false,
      reason: "Installed Pi host does not export AssistantMessageComponent and ToolExecutionComponent.",
    });
  });

  it("closes exactly once and becomes inert when its live execution is replaced", () => {
    const first = agentLiveStore.begin({ id: "replaced-viewer", agentName: "reviewer", label: "execution A" });
    const done = vi.fn();
    const tui = { terminal: { rows: 6, columns: 80 }, requestRender: vi.fn() };
    const before = agentLiveStore.emitter.listenerCount("change");
    const viewer = new AgentSessionViewer(executionFor(first.id), tui, done, capability());
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);

    agentLiveStore.begin({ id: first.id, agentName: "reviewer", label: "execution B" });

    expect(done).toHaveBeenCalledOnce();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    expect(viewer.render(80)).toEqual([]);
    viewer.handleInput("down");
    viewer.invalidate();
    viewer.dispose();
    agentLiveStore.reset();
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps a selected historical round readable after replacement but never opens replacement live output", () => {
    const first = agentLiveStore.begin({ id: "round-viewer", agentName: "reviewer", label: "execution A" });
    const done = vi.fn();
    const tui = { terminal: { rows: 6, columns: 100 }, requestRender: vi.fn() };
    const listenerBaseline = agentLiveStore.emitter.listenerCount("change");
    const viewer = new AgentSessionViewer(executionFor(first.id), tui, done, capability(), {
      active: 2,
      list: [1, 2],
      readBody: (round) => (round === 1 ? ["historical round A"] : undefined),
    });
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(listenerBaseline + 1);
    viewer.handleInput("left");
    tui.requestRender.mockClear();
    agentLiveStore.begin({ id: first.id, agentName: "reviewer", label: "execution B" });

    expect(agentLiveStore.emitter.listenerCount("change")).toBe(listenerBaseline);
    expect(tui.requestRender).not.toHaveBeenCalled();
    const historical = viewer.render(100).join("\n");
    expect(historical).toContain("historical round A");
    expect(historical).toContain("execution A");
    expect(historical).not.toContain("execution B");
    expect(done).not.toHaveBeenCalled();

    viewer.handleInput("right");
    expect(done).toHaveBeenCalledOnce();
    expect(viewer.render(100)).toEqual([]);
    viewer.dispose();
    expect(done).toHaveBeenCalledOnce();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(listenerBaseline);
  });

  it.each([
    ["queued", "Agent is queued; no assistant output yet."],
    ["working", "Agent is working; waiting for assistant output…"],
    ["done", "Agent completed without assistant output."],
    ["cancelled", "Agent was cancelled before assistant output."],
    ["error", "Agent failed before assistant output."],
  ] as const)("renders leaf-status-aware empty text for %s", (status, message) => {
    const row = agentLiveStore.begin({ id: `empty-${status}`, agentName: "reviewer", label: status });
    agentLiveStore.patch(row.id, { status });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 5, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    expect(viewer.render(80).join("\n")).toContain(message);
    viewer.dispose();
  });

  it("renders a readable recorded answer and provenance without inferring verification", () => {
    const row = agentLiveStore.begin({ id: "replay-answer", agentName: "reviewer", label: "Review" });
    agentLiveStore.patch(row.id, {
      status: "done",
      finalAnswer: "## Review\n\nNo blocking findings.",
      resultArtifact: `workflow-artifact:run-1/call-1-answer#sha256=${"a".repeat(64)}`,
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      // One row more than before: the status line takes one body row.
      { terminal: { rows: 10, columns: 100 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const text = viewer.render(100).join("\n");
    expect(text).toContain("showing recorded terminal text");
    expect(text).not.toContain("verified");
    expect(text).toContain("source: workflow-artifact:run-1/call-1-answer");
    expect(text).toContain("## Review");
    expect(text).toContain("No blocking findings.");
    expect(text).not.toContain("assistant:");
    viewer.dispose();
  });

  it.each([
    ["done", "recorded terminal text"],
    ["cancelled", "recorded cancellation text"],
    ["error", "recorded failure text"],
  ] as const)("labels ordinary %s row text without claiming it is an answer", (status, label) => {
    const row = agentLiveStore.begin({ id: `ordinary-${status}`, agentName: "reviewer", label: status });
    agentLiveStore.patch(row.id, {
      status,
      finalAnswer: `${status} terminal payload`,
      ...(status === "error" ? { errors: ["ordinary failure"] } : {}),
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      // One row more than before: the status line takes one body row.
      { terminal: { rows: 8, columns: 100 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const text = viewer.render(100).join("\n");
    expect(text).toContain(`showing ${label}`);
    expect(text).not.toContain("recorded final answer");
    expect(text).toContain(`${status} terminal payload`);
    if (status === "error") expect(text).toContain("error: ordinary failure");
    viewer.dispose();
  });

  it("renders explicit artifact errors when a replay has neither transcript nor readable answer", () => {
    const row = agentLiveStore.begin({ id: "replay-error", agentName: "reviewer", label: "Review" });
    agentLiveStore.patch(row.id, { status: "done", errors: ["Replayed answer artifact is tampered."] });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 6, columns: 100 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const text = viewer.render(100).join("\n");
    expect(text).toContain("No child transcript or readable answer is available.");
    expect(text).toContain("error: Replayed answer artifact is tampered.");
    viewer.dispose();
  });

  it("locates a workflow agent by walking the store's parents up to its group", () => {
    const group = agentLiveStore.begin({
      id: "workflow:run-7:group:parallel-1",
      workflowRunId: "run-7",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      groupTotal: 2,
    });
    const anchor = agentLiveStore.begin({
      id: "workflow:run-7:sdk:reviewer:audit:plan",
      workflowRunId: "run-7",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "reviewer (audit)",
    });
    const child = agentLiveStore.begin({
      id: "workflow-agent:run-7:sdk:reviewer:audit:plan",
      workflowRunId: "run-7",
      parentRowId: anchor.id,
      agentName: "reviewer",
      label: "audit",
      title: "Audit the router",
    });
    const viewer = new AgentSessionViewer(
      executionFor(child.id),
      { terminal: { rows: 8, columns: 160 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const header = viewer.render(160)[0] ?? "";
    // Outermost first: run, then the group, then the anchor slot, then this agent.
    expect(header).toContain("workflow run-7");
    expect(header).toContain("parallel (2)");
    expect(header).toContain("audit");
    expect(header).toContain("Audit the router");
    expect(header.indexOf("workflow run-7")).toBeLessThan(header.indexOf("parallel (2)"));
    expect(header.indexOf("parallel (2)")).toBeLessThan(header.indexOf("Audit the router"));
    viewer.dispose();
  });

  it("names the stage between the run and the group for a production-shaped workflow child", () => {
    // Exactly what the runtime writes: a group row labelled by kind and count, an anchor
    // row whose label unwraps to the child's own label, and a child with a label and NO
    // title. Nothing here states the phase — the caller reads it from the run journal and
    // passes it in, which is what makes the stage segment appear at all.
    const group = agentLiveStore.begin({
      id: "workflow:run-11:group:parallel-1",
      workflowRunId: "run-11",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      groupTotal: 2,
    });
    const anchor = agentLiveStore.begin({
      id: "workflow:run-11:sdk:reviewer:audit:review",
      workflowRunId: "run-11",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "reviewer (audit)",
    });
    const child = agentLiveStore.begin({
      id: "workflow-agent:run-11:sdk:reviewer:audit:review",
      workflowRunId: "run-11",
      parentRowId: anchor.id,
      agentName: "reviewer",
      label: "audit",
    });
    const viewer = new AgentSessionViewer(
      executionFor(child.id),
      { terminal: { rows: 8, columns: 160 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
      undefined,
      undefined,
      undefined,
      { phase: "review" },
    );

    const header = viewer.render(160)[0] ?? "";
    expect(header).toContain("workflow run-11");
    expect(header).toContain("review");
    expect(header).toContain("parallel (2)");
    expect(header).toContain("audit");
    // run · stage · group · agent, outermost first.
    expect(header.indexOf("workflow run-11")).toBeLessThan(header.indexOf("review"));
    expect(header.indexOf("review")).toBeLessThan(header.indexOf("parallel (2)"));
    expect(header.indexOf("parallel (2)")).toBeLessThan(header.indexOf("audit"));
    viewer.dispose();
  });

  it("omits the stage when the caller resolved none", () => {
    const group = agentLiveStore.begin({
      id: "workflow:run-12:group:parallel-1",
      workflowRunId: "run-12",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      groupTotal: 2,
    });
    const child = agentLiveStore.begin({
      id: "workflow-agent:run-12:sdk:reviewer:audit:",
      workflowRunId: "run-12",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "audit",
    });
    const viewer = new AgentSessionViewer(
      executionFor(child.id),
      { terminal: { rows: 8, columns: 160 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const header = viewer.render(160)[0] ?? "";
    expect(header).toContain("workflow run-12");
    expect(header).toContain("parallel (2)");
    expect(header.indexOf("workflow run-12")).toBeLessThan(header.indexOf("parallel (2)"));
    viewer.dispose();
  });

  it("keeps the short heading for a non-workflow row and never repeats an anchor's own name", () => {
    const plain = agentLiveStore.begin({ id: "plain-row", agentName: "reviewer", label: "Review" });
    const plainViewer = new AgentSessionViewer(
      executionFor(plain.id),
      { terminal: { rows: 8, columns: 120 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    expect(plainViewer.render(120)[0]).toMatch(/^╭─ \[agent .+\] started work · Review/u);
    expect(plainViewer.render(120)[0]).not.toContain("workflow ");
    plainViewer.dispose();

    // The anchor and its child are one actor: the anchor's name adds no segment,
    // and a parent that is no longer in the store ends the walk instead of it.
    const anchor = agentLiveStore.begin({
      id: "workflow:run-9:sdk:reviewer:audit:",
      workflowRunId: "run-9",
      parentRowId: "workflow:run-9:group:gone",
      agentName: "reviewer",
      label: "reviewer (audit)",
    });
    const child = agentLiveStore.begin({
      id: "workflow-agent:run-9:sdk:reviewer:audit:",
      workflowRunId: "run-9",
      parentRowId: anchor.id,
      agentName: "reviewer",
      label: "audit",
    });
    const viewer = new AgentSessionViewer(
      executionFor(child.id),
      { terminal: { rows: 8, columns: 120 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    const header = viewer.render(120)[0] ?? "";
    expect(header).toContain("workflow run-9");
    expect(header.match(/audit/gu)).toHaveLength(1);
    viewer.dispose();
  });

  it("advances the status frame on the shared tick", () => {
    vi.useFakeTimers();
    try {
      const row = agentLiveStore.begin({ id: "tick-viewer", agentName: "reviewer", label: "Review" });
      agentLiveStore.patch(row.id, { status: "working" });
      const tui = { terminal: { rows: 10, columns: 80 }, requestRender: vi.fn() };
      const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

      expect(viewer.render(80)[1]).toContain(statusMeta("working", 0).icon);
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(80)[1]).toContain(statusMeta("working", 1).icon);
      viewer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the status line byte-identical across ticks under calm rendering", () => {
    vi.stubEnv("LOCUS_PS_CALM", "1");
    vi.useFakeTimers();
    try {
      const row = agentLiveStore.begin({ id: "calm-viewer", agentName: "reviewer", label: "Review" });
      agentLiveStore.patch(row.id, { status: "working" });
      const tui = { terminal: { rows: 10, columns: 80 }, requestRender: vi.fn() };
      const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

      const first = viewer.render(80)[1];
      expect(first).toContain(statusMeta("working", 0).icon);
      // The clock still runs — the tick asks for repaints — but the frame and the
      // coarse elapsed bucket do not move, so the line is identical.
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(80)[1]).toEqual(first);
      viewer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the status tick when the viewer is disposed", () => {
    vi.useFakeTimers();
    try {
      const row = agentLiveStore.begin({ id: "tick-leak-viewer", agentName: "reviewer", label: "Review" });
      agentLiveStore.patch(row.id, { status: "working" });
      const tui = { terminal: { rows: 10, columns: 80 }, requestRender: vi.fn() };
      const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());
      viewer.render(80);

      viewer.dispose();
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(10_000);
      expect(tui.requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("accepts Home and End in every encoding a terminal sends, not only CSI H and CSI F", () => {
    const row = agentLiveStore.begin({ id: "home-end-encodings-row", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 40; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `encoded-${index}` }], stopReason: "stop" },
      });
    }
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { mode: "regular" as const, terminal: { rows: 10, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    expect(viewer.render(80).join("\n")).toContain("encoded-39");

    // `tmux-256color` khome/kend, `xterm-256color` khome/kend, the CSI pair the
    // viewer already knew, and the rxvt forms pi-tui also lists.
    const homeEndPairs = [
      ["\u001b[1~", "\u001b[4~"],
      ["\u001bOH", "\u001bOF"],
      ["\u001b[H", "\u001b[F"],
      ["\u001b[7~", "\u001b[8~"],
      ["home", "end"],
    ] as const;
    for (const [home, end] of homeEndPairs) {
      viewer.handleInput(home);
      expect(viewer.render(80).join("\n"), `home ${JSON.stringify(home)}`).toContain("├─ REQUEST");
      viewer.handleInput(end);
      expect(viewer.render(80).join("\n"), `end ${JSON.stringify(end)}`).toContain("encoded-39");
    }
    viewer.dispose();
  });
  it("keeps the footer on screen in fullscreen by leaving Pi's transcript row alone", () => {
    // Pi's fullscreen dock sits under a ScrollView it may never shrink below one
    // row, so a component that claims `rows - 1` loses its last line — the footer
    // with every control on it — and Pi's own view is already at its bottom, so
    // there is nowhere to scroll to reach it.
    const row = agentLiveStore.begin({ id: "fullscreen-geometry-row", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 120; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `line-${index}` }], stopReason: "stop" },
      });
    }
    const execution = executionFor(row.id);

    const fullscreen = new AgentSessionViewer(
      execution,
      { mode: "fullscreen" as const, terminal: { rows: 50, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    const fullscreenLines = fullscreen.render(80);
    expect(fullscreenLines).toHaveLength(48);
    expect(fullscreenLines.at(-1)).toMatch(/^╰─ esc close/u);
    fullscreen.dispose();

    // Regular mode keeps the row it always had: one line more of transcript.
    const regular = new AgentSessionViewer(
      execution,
      { mode: "regular" as const, terminal: { rows: 50, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    const regularLines = regular.render(80);
    expect(regularLines).toHaveLength(49);
    expect(regularLines.at(-1)).toMatch(/^╰─ esc close/u);
    regular.dispose();

    // A host that reports no mode is laid out like regular, unchanged.
    const unknown = new AgentSessionViewer(
      execution,
      { terminal: { rows: 50, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );
    expect(unknown.render(80)).toHaveLength(49);
    unknown.dispose();
  });
  it("does not promise key scrolling in fullscreen, where Pi consumes those keys first", () => {
    // `TuiAltScreen` registers its viewport listener in its own constructor and
    // consumes PageUp/PageDown/Home/End before any component is reached, so this
    // screen cannot scroll by key there. The footer says only what is true.
    const row = agentLiveStore.begin({ id: "fullscreen-footer-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const unregister = agentLiveStore.registerInputForExecution(execution, async () => {});

    const fullscreen = new AgentSessionViewer(
      execution,
      { mode: "fullscreen" as const, terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      interactiveCapability(),
      undefined,
      { matches: () => false },
    );
    const fullscreenFooter = fullscreen.render(80).at(-1) ?? "";
    expect(fullscreenFooter).not.toContain("pgup");
    expect(fullscreenFooter).not.toContain("history");
    expect(fullscreenFooter).toContain("esc close · enter send");
    fullscreen.dispose();

    const regular = new AgentSessionViewer(
      execution,
      { mode: "regular" as const, terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      interactiveCapability(),
      undefined,
      { matches: () => false },
    );
    expect(regular.render(80).at(-1) ?? "").toContain(PAGE_HISTORY_HINT);
    regular.dispose();
    unregister();
  });

  it("offers the wheel wherever it captures it, not only beside an editor", () => {
    vi.stubEnv("LOCUS_DRILL_MOUSE", "1");
    const row = agentLiveStore.begin({ id: "settled-wheel-row", agentName: "reviewer", label: "Review" });
    agentLiveStore.patch(row.id, { status: "done" });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { mode: "regular" as const, terminal: { rows: 14, columns: 80, write: vi.fn() }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const footer = viewer.render(80).at(-1) ?? "";
    // No editor is mounted on a settled row, but the wheel is still captured.
    expect(footer).not.toContain("enter send");
    expect(footer).toContain(`wheel/${PAGE_HISTORY_HINT}`);
    viewer.dispose();
  });

  it("drops the queued-message notice once the child stops taking input", async () => {
    const row = agentLiveStore.begin({ id: "stale-notice-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    let accepting = true;
    const unregister = agentLiveStore.registerInputForExecution(execution, send, () => accepting);
    const viewer = new AgentSessionViewer(
      execution,
      { mode: "regular" as const, terminal: { rows: 14, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      interactiveCapability(),
      undefined,
      { matches: () => false },
    );

    viewer.render(80);
    viewer.handleInput("h");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("h"));
    await vi.waitFor(() => expect(viewer.render(80).at(-1) ?? "").toContain("message queued"));

    // The child settles: the editor is withdrawn, and the notice about a message
    // it was going to read must go with it.
    accepting = false;
    agentLiveStore.patch(row.id, { status: "done" });
    const settled = viewer.render(80).at(-1) ?? "";
    expect(settled).not.toContain("message queued");
    expect(settled).not.toContain("enter send");
    expect(settled).toContain(`esc close · ${PAGE_HISTORY_HINT}`);

    unregister();
    viewer.dispose();
  });
});
