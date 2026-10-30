import { afterEach, expect, it, vi } from "vitest";
import { AgentScreen } from "../../../../extensions/agents/fleet/agent-screen.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { TUI, Component } from "@earendil-works/pi-tui";

afterEach(() => agentLiveStore.reset());
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
  const { isAgentScreenRow } = await import("../../../../extensions/agents/fleet/agent-screen.js");
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
