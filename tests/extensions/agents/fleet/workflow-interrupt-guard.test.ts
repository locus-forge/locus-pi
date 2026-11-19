import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { setOperatorWidget } from "../../../../extensions/_shared/operator/widget-render.js";
import {
  pinTransientUiKey,
  registerCommandWithUiLifecycle,
} from "../../../../extensions/_shared/operator/command-ui.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
import { createHarness, emit } from "../../../test-harness.js";

afterEach(() => agentLiveStore.reset());

function dispatch(h: ReturnType<typeof createHarness>, raw: string, focused: (data: string) => void): boolean {
  // Pi uses the live Set. Deleting the next listener prevents it from seeing the key.
  for (const listener of h.terminalInputHandlers) if (listener(raw)?.consume) return true;
  if (!isKeyRelease(raw)) focused(raw);
  return false;
}

const view = { type: "VIEW", subject: "Passive view", primary: "Original" } as const;

describe("workflow interrupt guard", () => {
  it.each(["guard first", "view first"] as const)(
    "keeps native abort fenced when the %s encounters a failed VIEW clear",
    async (order) => {
      const h = createHarness(process.cwd(), { isStreaming: true });
      h.ctx.hasUI = true;
      agents(h.pi);
      if (order === "view first") setOperatorWidget(h.ctx, "workflows", view);
      await emit(h, "session_start");
      if (order === "guard first") setOperatorWidget(h.ctx, "workflows", view);
      const child = agentLiveStore.begin({ id: "held-child", label: "held", workflowRunId: "held-run" });
      const cancel = vi.fn();
      agentLiveStore.registerCancel(child.id, cancel);
      const hostSetWidget = h.ctx.ui.setWidget.bind(h.ctx.ui);
      h.ctx.ui.setWidget = (key, content, options) => {
        if (key === "workflows" && content === undefined) throw new Error("Injected widget failure");
        hostSetWidget(key, content, options);
      };
      const nativeAbort = vi.fn();

      expect(dispatch(h, "\x1b[27u", nativeAbort)).toBe(true);
      expect(dispatch(h, "\x1b[27;1:3u", nativeAbort)).toBe(false);
      expect(nativeAbort).not.toHaveBeenCalled();
      expect(h.confirmCalls).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it.each(["guard first", "peer first"] as const)(
    "protects the busy turn with the replacement peer %s",
    async (order) => {
      const h = createHarness(process.cwd(), { isStreaming: true });
      h.ctx.hasUI = true;
      const peer = vi.fn((raw: string): undefined => {
        if (isKeyRelease(raw) || !matchesKey(raw, "escape")) return;
        setOperatorWidget(h.ctx, "workflows", { type: "ERROR", subject: "Replacement", primary: "Fresh failure" });
        return undefined;
      });
      if (order === "peer first") h.ctx.ui.onTerminalInput?.(peer);
      agents(h.pi);
      await emit(h, "session_start");
      if (order === "guard first") h.ctx.ui.onTerminalInput?.(peer);
      setOperatorWidget(h.ctx, "workflows", view);
      const child = agentLiveStore.begin({ id: "held-child", label: "held", workflowRunId: "held-run" });
      const cancel = vi.fn();
      agentLiveStore.registerCancel(child.id, cancel);
      registerCommandWithUiLifecycle(
        h.pi,
        { command: "attach-child-panel", surfaces: ["transient-widget"], transientWidgets: ["held-child"] },
        { handler() {} },
      );
      await h.commands.get("attach-child-panel")!.handler("", h.ctx);
      setOperatorWidget(h.ctx, "held-child", { type: "LIVE", subject: "Child", primary: "Running" });
      pinTransientUiKey(h.pi, "held-child");
      const childPanel = h.widgetPayloads.get("held-child");
      setOperatorWidget(h.ctx, "workflows", view);
      const nativeAbort = vi.fn();

      expect(dispatch(h, "\x1b[27u", nativeAbort)).toBe(true);
      expect(nativeAbort).not.toHaveBeenCalled();
      expect(h.confirmCalls).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
      expect(h.widgetPayloads.get("held-child")).toBe(childPanel);
      expect(h.widgets.get("workflows")).toContain(
        order === "peer first" ? "[ERROR] Replacement" : "[VIEW] Passive view",
      );
      expect(peer).toHaveBeenCalledTimes(order === "peer first" ? 1 : 0);
    },
  );

  it.each([false, true])("routes both Escape encodings to the focused native selector, busy=%s", async (busy) => {
    const close = vi.fn();
    const selector = Object.assign(Object.create(ExtensionSelectorComponent.prototype), {
      handleInput(data: string) {
        if (matchesKey(data, "escape")) close();
      },
    });
    const h = createHarness(process.cwd(), { isStreaming: busy, getFocusedComponent: () => selector });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    if (busy) agentLiveStore.begin({ id: "held-child", label: "held", workflowRunId: "held-run" });
    setOperatorWidget(h.ctx, "workflows", busy ? { ...view, type: "WARN" } : view);
    const previous = h.widgetPayloads.get("workflows");
    const hostFocus = (raw: string) => selector.handleInput(raw);

    dispatch(h, "\x1b", hostFocus);
    dispatch(h, "\x1b[27u", hostFocus);
    expect(dispatch(h, "\x1b[27;1:3u", hostFocus)).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
    expect(h.widgetPayloads.get("workflows")).toBe(previous);
    expect(h.confirmCalls).toEqual([]);
  });

  it.each([
    ["first", true],
    ["first", false],
    ["last", true],
    ["last", false],
  ] as const)("protects a held workflow with the guard %s and WARN present=%s", async (order, warn) => {
    const root = process.cwd();
    const sessionId = "held-workflow-escape";
    const h = createHarness(root, { isStreaming: true, sessionId });
    h.ctx.hasUI = true;
    const registry = workflowBackgroundRunRegistry();
    const lease = registry.startSession(root, sessionId);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const parent = new AbortController();
    let runSignal: AbortSignal | undefined;
    const launched = registry.attach(lease, parent.signal, ({ signal }) => {
      runSignal = signal;
      return pending;
    });
    if (!launched.ok) throw new Error("Held run did not attach");
    try {
      const peer = vi.fn(() => undefined);
      if (order === "last") h.ctx.ui.onTerminalInput?.(peer);
      agents(h.pi);
      await emit(h, "session_start");
      if (order === "first") h.ctx.ui.onTerminalInput?.(peer);
      const child = agentLiveStore.begin({
        id: "held-workflow-child",
        agentName: "fixture",
        label: "Held child",
        workflowRunId: "held-workflow",
      });
      const cancel = vi.fn();
      agentLiveStore.registerCancel(child.id, cancel);
      if (warn) setOperatorWidget(h.ctx, "workflows", { type: "WARN", subject: "Workflow run", primary: "Refusal" });
      const widget = h.widgetPayloads.get("workflows");

      for (const raw of ["\x1b", "\x1b[27u", "\x1b[27;1:3u"]) {
        const consumed = [...h.terminalInputHandlers].some((handle) => handle(raw)?.consume);
        if (!consumed && !isKeyRelease(raw) && matchesKey(raw, "escape")) {
          h.ctx.abort?.();
          parent.abort();
        }
      }
      expect(h.abortCalls).toBe(0);
      expect(h.confirmCalls).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
      expect(runSignal?.aborted).toBe(false);
      expect(registry.unsettled(lease)[0]?.stopRequested).toBe(false);
      expect(registry.hasActiveSession(root, sessionId)).toBe(true);
      expect(agentLiveStore.rows.get(child.id)?.status).toBe(child.status);
      expect(h.widgetPayloads.get("workflows")).toBe(widget);
    } finally {
      settle();
      await launched.run.terminal;
      registry.shutdown(lease);
    }
  });
});
