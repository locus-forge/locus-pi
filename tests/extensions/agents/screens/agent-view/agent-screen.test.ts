import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentScreen } from "../../../../../extensions/agents/fleet/agent-screen.js";
import { agentLiveStore } from "../../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  getKeybindings,
  setKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type TUI,
  type Component,
} from "@earendil-works/pi-tui";
import { activityStore, renderActivityStrip } from "../../../../../extensions/_shared/agent-runtime/activity-store.js";
import { NativeAgentConversation } from "../../../../../extensions/agents/fleet/native-conversation.js";

const originalKeybindings = getKeybindings();
beforeEach(() =>
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    }),
  ),
);
afterEach(() => {
  agentLiveStore.reset();
  setKeybindings(originalKeybindings);
  vi.restoreAllMocks();
});
it.each(["\u001b", "\u001b[27u"])("switches to main with escape encoding %j", async (key) => {
  let focused: { handleInput?(data: string): void } | undefined;
  const main = vi.fn();
  const tui = {
    requestRender() {},
    setLayoutRoot() {},
    setFocus(component: object) {
      focused = component;
    },
  } as unknown as TUI & { setLayoutRoot(component: Component): void };
  agentLiveStore.beginExecution({ id: "a", label: "A" });
  const screen = new AgentScreen(tui, main);
  await screen.select("a");
  focused?.handleInput?.(key);
  expect(main).toHaveBeenCalledOnce();
  screen.dispose();
});
it.each(["\u0003", "\u001b[99;5u"])("cancels only the selected agent with encoding %j", async (key) => {
  let focused: { handleInput?(data: string): void } | undefined;
  const tui = {
    requestRender() {},
    setLayoutRoot() {},
    setFocus(component: object) {
      focused = component;
    },
  } as unknown as TUI & { setLayoutRoot(component: Component): void };
  const a = agentLiveStore.beginExecution({ id: "a", label: "A" });
  const b = agentLiveStore.beginExecution({ id: "b", label: "B" });
  const cancelA = vi.fn(),
    cancelB = vi.fn();
  agentLiveStore.registerCancelForExecution(a, cancelA);
  agentLiveStore.registerCancelForExecution(b, cancelB);
  const screen = new AgentScreen(tui, () => {});
  await screen.select("a");
  focused?.handleInput?.(key);
  expect(cancelA).toHaveBeenCalledOnce();
  expect(cancelB).not.toHaveBeenCalled();
  screen.dispose();
});

it("lists workflow executor once, not its journal slot projection", async () => {
  const { isAgentScreenRow } = await import("../../../../../extensions/agents/fleet/agent-screen.js");
  agentLiveStore.beginExecution({ id: "workflow:run:slot", label: "projection" });
  agentLiveStore.beginExecution({ id: "workflow-agent:run:slot", label: "runtime", parentRowId: "workflow:run:slot" });
  agentLiveStore.beginExecution({ id: "a", label: "A" });
  expect([...agentLiveStore.rows.values()].filter(isAgentScreenRow).map((row) => row.id)).toEqual([
    "workflow-agent:run:slot",
    "a",
  ]);
});

it("fullscreen center dismissal restores the exact child editor draft and layout", async () => {
  let input: { handleInput(data: string): void; setText(text: string): void; getText(): string } | undefined;
  const setLayoutRoot = vi.fn();
  const tui = {
    requestRender() {},
    setLayoutRoot,
    setFocus(value: unknown) {
      input = value as typeof input;
    },
  } as unknown as TUI & { setLayoutRoot(component: Component): void };
  agentLiveStore.beginExecution({ id: "a", label: "A" });
  const main = vi.fn();
  const screen = new AgentScreen(tui, main);
  await screen.select("a");
  input!.setText("unfinished draft");
  screen.list();
  input!.handleInput("\u001b");
  expect(input!.getText()).toBe("unfinished draft");
  expect(setLayoutRoot).toHaveBeenCalledTimes(3);
  expect(setLayoutRoot.mock.calls[2]![0]).toBe(setLayoutRoot.mock.calls[0]![0]);
  expect(main).not.toHaveBeenCalled();
  screen.list();
  input!.handleInput("\u007f");
  expect(input!.getText()).toBe("unfinished draft");
  expect(main).not.toHaveBeenCalled();
  screen.dispose();
});

it("opens the center rather than leaving a blank terminal on an unknown initial target", async () => {
  const main = vi.fn();
  const error = vi.fn();
  const tui = { requestRender() {}, setLayoutRoot() {}, setFocus() {} } as unknown as TUI & {
    setLayoutRoot(component: Component): void;
  };
  const screen = new AgentScreen(tui, main, error);
  await screen.select("missing");
  expect(main).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("Unknown agent: missing");
  screen.dispose();
});

it.each(["working", "done", "error"] as const)(
  "keeps %s labels consistent in the strip, center and child view",
  async (status) => {
    activityStore.agents.clear();
    activityStore.workflows.clear();
    let root: Component | undefined;
    const tui = {
      terminal: { rows: 24, columns: 180 },
      requestRender() {},
      setFocus() {},
      setLayoutRoot(value: Component) {
        root = value;
      },
    } as unknown as TUI & { setLayoutRoot(component: Component): void };
    const execution = agentLiveStore.beginExecution({ id: "a", label: "A" });
    agentLiveStore.patchExecution(execution, { status });
    agentLiveStore.registerInputForExecution(execution, async () => {});
    const expected = status === "working" ? "running" : status === "done" ? "idle" : "failed";
    const screen = new AgentScreen(tui, vi.fn());
    await screen.select("a");
    expect(root!.render(180).join("\n")).toContain(` · ${expected} · Esc main`);
    activityStore.agents.clear();
    expect(root!.render(180).join("\n")).toContain(` · ${expected} · Esc main`);
    activityStore.capture();
    expect(renderActivityStrip(180).join("\n")).toContain(` · ${expected}`);
    screen.list();
    const details = root!
      .render(180)
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(details).toContain(`Activity: ${expected}`);
    if (status === "done") expect(details).toContain("Last turn: completed");
    else expect(details).not.toContain("Last turn: completed");
    expect(agentLiveStore.rowForExecution(execution)!.status).toBe(status);
    screen.dispose();
  },
);

it.each([
  ["current", false],
  ["history", false],
  ["current", true],
  ["history", true],
] as const)(
  "routes configured expansion in the %s view (remapped: %s) without submitting input",
  async (kind, remapped) => {
    if (remapped) getKeybindings().setUserBindings({ "app.tools.expand": "ctrl+e" });
    activityStore.agents.clear();
    activityStore.workflows.clear();
    let focused: { handleInput(data: string): void; setText?(text: string): void; getText?(): string } | undefined;
    let root: Component | undefined;
    const tui = {
      terminal: { rows: 24, columns: 180 },
      requestRender() {},
      setLayoutRoot(value: Component) {
        root = value;
      },
      setFocus(value: unknown) {
        focused = value as typeof focused;
      },
    } as unknown as TUI & { setLayoutRoot(component: Component): void };
    const execution = agentLiveStore.beginExecution({ id: "a", label: "A" });
    const send = vi.fn(async () => {});
    agentLiveStore.registerInputForExecution(execution, send);
    const screen = new AgentScreen(tui, vi.fn());
    if (kind === "history") {
      agentLiveStore.beginExecution({ id: "a", label: "Replacement" });
      screen.list();
      root!.render(180);
      focused!.handleInput("\r");
    } else await screen.select("a");
    const expand = vi.spyOn(NativeAgentConversation.prototype, "toggleToolsExpanded");
    focused?.setText?.("unfinished draft");
    if (remapped) {
      focused!.handleInput("\x0f");
      expect(expand).not.toHaveBeenCalled();
    }
    focused!.handleInput(remapped ? "\x05" : "\x0f");
    expect(expand).toHaveBeenCalledOnce();
    if (kind === "current") expect(focused?.getText?.()).toBe("unfinished draft");
    expect(send).not.toHaveBeenCalled();
    expand.mockRestore();
    screen.dispose();
  },
);
