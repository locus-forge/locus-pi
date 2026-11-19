import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { CustomEditor, ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import workflows from "../../../../extensions/workflows/index.js";
import { AGENTS_WIDGET_KEY } from "../../../../extensions/agents/operator/operator-surface.js";
import {
  installWorkflowProgress,
  WORKFLOW_LIVE_WIDGET_KEY,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { setOperatorWidget } from "../../../../extensions/_shared/operator/widget-render.js";
import {
  pinTransientUiKey,
  observeCommandUiFocus,
  registerCommandWithUiLifecycle,
  unpinTransientUiKey,
} from "../../../../extensions/_shared/operator/command-ui.js";
import {
  decideEscape,
  type EscapeDecision,
  type EscapeSnapshot,
} from "../../../../extensions/_shared/operator/operator-keys.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
import * as workflowRunner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness, emit } from "../../../test-harness.js";

afterEach(() => agentLiveStore.reset());

function dispatch(h: ReturnType<typeof createHarness>, raw: string, focused: (data: string) => void): boolean {
  // Pi uses the live Set. Deleting the next listener prevents it from seeing the key.
  for (const listener of h.terminalInputHandlers) if (listener(raw)?.consume) return true;
  if (!isKeyRelease(raw)) focused(raw);
  return false;
}

const view = { type: "VIEW", subject: "Passive view", primary: "Original" } as const;

const viewPanel = { identity: {}, surface: "VIEW", pinned: false } as const;
const warnPanel = { identity: {}, surface: "WARN", pinned: false } as const;
const errorPanel = { identity: {}, surface: "ERROR", pinned: false } as const;
const decisionRows: readonly [EscapeSnapshot, EscapeDecision][] = [
  [{ focus: "primary", presentation: viewPanel, responseActive: true, busyWork: false }, "close-view"],
  [{ focus: "primary", presentation: viewPanel, responseActive: false, busyWork: false }, "close-view"],
  [{ focus: "primary", presentation: viewPanel, responseActive: true, busyWork: true }, "close-view"],
  [{ focus: "local", presentation: viewPanel, responseActive: false, busyWork: false }, "deliver"],
  [{ focus: "local", presentation: warnPanel, responseActive: true, busyWork: true }, "deliver"],
  [{ focus: "local", responseActive: true, busyWork: true }, "deliver"],
  [{ focus: "unknown", presentation: viewPanel, responseActive: true, busyWork: false }, "protect"],
  [{ focus: "unknown", presentation: viewPanel, responseActive: false, busyWork: false }, "pass"],
  [
    { focus: "primary", presentation: { ...viewPanel, pinned: true }, responseActive: true, busyWork: false },
    "protect",
  ],
  [{ focus: "primary", presentation: { ...viewPanel, pinned: true }, responseActive: false, busyWork: false }, "pass"],
  [{ focus: "primary", presentation: warnPanel, responseActive: false, busyWork: false }, "pass"],
  [{ focus: "primary", presentation: warnPanel, responseActive: true, busyWork: false }, "protect"],
  [{ focus: "unknown", presentation: warnPanel, responseActive: false, busyWork: true }, "protect"],
  [{ focus: "primary", presentation: errorPanel, responseActive: false, busyWork: false }, "pass"],
  [{ focus: "unknown", presentation: errorPanel, responseActive: true, busyWork: false }, "protect"],
  [
    {
      focus: "unknown",
      presentation: { identity: {}, surface: "LIVE", pinned: false },
      responseActive: true,
      busyWork: false,
    },
    "protect",
  ],
  [{ focus: "unknown", responseActive: false, busyWork: true }, "protect"],
  [{ focus: "unknown", responseActive: true, busyWork: false }, "pass"],
  [{ focus: "unknown", responseActive: false, busyWork: false }, "pass"],
];

describe("workflow interrupt guard", () => {
  it("returns the four Escape decisions from a keypress snapshot", () => {
    for (const [snapshot, decision] of decisionRows)
      expect(decideEscape(snapshot), JSON.stringify(snapshot)).toBe(decision);
  });

  it.each(["guard first", "panel first"] as const)("applies the complete Escape table with %s", async (order) => {
    for (const [snapshot, decision] of decisionRows) {
      const delivered = vi.fn();
      const focus =
        snapshot.focus === "local"
          ? Object.assign(Object.create(ExtensionSelectorComponent.prototype), { handleInput: delivered })
          : snapshot.focus === "primary"
            ? Object.assign(Object.create(CustomEditor.prototype), { isShowingAutocomplete: () => false })
            : undefined;
      const tui = { getFocusedComponent: () => focus, requestRender() {} };
      const h = createHarness(process.cwd(), {
        isStreaming: snapshot.responseActive,
        getFocusedComponent: tui.getFocusedComponent,
      });
      h.ctx.hasUI = true;
      agents(h.pi);
      registerCommandWithUiLifecycle(h.pi, { command: "bind-proof", surfaces: ["no-ui"] }, { handler() {} });
      await h.commands.get("bind-proof")!.handler("", h.ctx);
      const showPanel = () => {
        if (snapshot.presentation?.surface === undefined) return;
        setOperatorWidget(h.ctx, "workflows", { ...view, type: snapshot.presentation.surface });
        if (snapshot.presentation.pinned) pinTransientUiKey(h.pi, "workflows");
      };
      if (order === "panel first") showPanel();
      await emit(h, "session_start");
      h.ctx.ui.setEditorComponent?.(undefined);
      if (order === "guard first") showPanel();
      observeCommandUiFocus(h.ctx, tui);
      if (snapshot.busyWork) agentLiveStore.begin({ id: "held", label: "held", workflowRunId: "held-run" });
      const before = h.widgetPayloads.get("workflows");
      const native = vi.fn();

      expect(dispatch(h, "\x1b[27;1:3u", native)).toBe(false);
      expect(dispatch(h, "\x1b[27u", native), JSON.stringify(snapshot)).toBe(decision !== "pass");
      expect(native).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
      expect(delivered).toHaveBeenCalledTimes(decision === "deliver" ? 1 : 0);
      expect(h.widgetPayloads.get("workflows")).toBe(decision === "close-view" ? undefined : before);
      expect(h.abortCalls).toBe(0);
      expect(h.confirmCalls).toEqual([]);
      if (snapshot.presentation?.pinned) unpinTransientUiKey(h.pi, "workflows");
    }
  });

  it.each(["throw", "replace"] as const)("consumes Escape if a streaming VIEW clear would %s", async (effect) => {
    const editor = Object.assign(Object.create(CustomEditor.prototype), { isShowingAutocomplete: () => false });
    const h = createHarness(process.cwd(), { isStreaming: true, getFocusedComponent: () => editor });
    setOperatorWidget(h.ctx, "workflows", view);
    const setWidget = h.ctx.ui.setWidget.bind(h.ctx.ui);
    let attempts = 0;
    h.ctx.ui.setWidget = (key, content, options) => {
      if (key === "workflows" && content === undefined) {
        attempts += 1;
        if (effect === "throw") throw new Error("Injected host clear failure");
        setOperatorWidget(h.ctx, key, { ...view, type: "ERROR", subject: "Replacement" });
      } else setWidget(key, content, options);
    };
    const nativeAbort = vi.fn();
    expect(dispatch(h, "\x1b[27u", nativeAbort)).toBe(true);
    expect(attempts).toBe(1);
    expect(nativeAbort).not.toHaveBeenCalled();
    expect(h.widgets.get("workflows")).toContain(effect === "replace" ? "[ERROR] Replacement" : "[VIEW] Passive view");
  });

  it.each(["guard first", "panel first"] as const)(
    "closes a real skills status VIEW during an ordinary response with %s",
    async (order) => {
      const editor = Object.assign(Object.create(CustomEditor.prototype), { isShowingAutocomplete: () => false });
      const h = createHarness(process.cwd(), { isStreaming: true, getFocusedComponent: () => editor });
      h.ctx.hasUI = true;
      const run = async () => {
        await h.commands.get("workflows")!.handler("skills status --host codex --scope user", h.ctx);
        expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow skills");
      };
      workflows(h.pi);
      if (order === "panel first") await run();
      agents(h.pi);
      await emit(h, "session_start");
      h.ctx.ui.setEditorComponent?.(undefined);
      if (order === "guard first") await run();
      const nativeAbort = vi.fn();
      for (const key of ["\x1b[27u", "\x1b"]) {
        expect(dispatch(h, "\x1b[27;1:3u", nativeAbort)).toBe(false);
        expect(dispatch(h, key, nativeAbort)).toBe(true);
        expect(h.widgets.get("workflows")).toBe("");
        await run();
      }
      expect(nativeAbort).not.toHaveBeenCalled();
    },
  );

  it("delivers Kitty Escape to a direct Pi custom input during a held workflow", async () => {
    let focus: { handleInput(data: string): void } | undefined;
    const tui = { getFocusedComponent: () => focus, requestRender() {} };
    const h = createHarness(process.cwd(), { isStreaming: true, getFocusedComponent: tui.getFocusedComponent });
    h.ctx.hasUI = true;
    h.ctx.ui.custom = async (factory) => {
      await factory(tui, {}, {}, () => {
        focus = undefined;
      });
      return undefined as never;
    };
    agents(h.pi);
    await emit(h, "session_start");
    agentLiveStore.begin({ id: "held-child", label: "held", workflowRunId: "held-run" });
    setOperatorWidget(h.ctx, "workflows", { ...view, type: "WARN" });
    const close = vi.fn();
    await h.ctx.ui.custom((_tui, _theme, _keys, done) => {
      const input = {
        render: () => ["Peer input"],
        invalidate() {},
        handleInput(data: string) {
          if (!matchesKey(data, "escape")) return;
          close();
          done(undefined);
        },
      };
      focus = input;
      return input;
    });
    dispatch(h, "\x1b[27u", (raw) => focus?.handleInput(raw));
    expect(close).toHaveBeenCalledOnce();
    expect(h.widgets.get("workflows")).toContain("[WARN]");
  });

  it("keeps the real agents key pinned until the last child releases it, through Escape and command cleanup", async () => {
    const h = createHarness(process.cwd());
    h.ctx.hasUI = true;
    const menu = vi.spyOn(h.ctx.ui, "select").mockResolvedValue(undefined);
    agents(h.pi);
    workflows(h.pi);
    await emit(h, "session_start");
    let settle!: () => void;
    const held = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const runner = vi.spyOn(workflowRunner, "runWorkflowScript").mockImplementation(async (options) => {
      options.onRunStart?.({ runId: "held-run", runDir: "/tmp/held-run" });
      await held;
      return {
        runId: "held-run",
        runDir: "/tmp/held-run",
        ok: true,
        result: null,
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/held-run/result.json" },
      };
    });
    const child = agentLiveStore.begin({ id: "held-child", label: "held", workflowRunId: "held-run" });
    const cancel = vi.fn();
    agentLiveStore.registerCancel(child.id, cancel);
    let childPanel: ReturnType<typeof installWorkflowProgress> | undefined;
    try {
      // Enter through the normal workflow launcher, then publish the child panel at the real key.
      await h.commands.get("workflows")!.handler("run live-smoke", h.ctx);
      await vi.waitFor(() => expect(h.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeDefined());
      h.setStreaming(true);
      childPanel = installWorkflowProgress(h.ctx, AGENTS_WIDGET_KEY, "held child", "held-child");
      const parentWidget = h.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
      const childWidget = h.widgetPayloads.get(AGENTS_WIDGET_KEY);
      expect(parentWidget).toBeDefined();
      expect(childWidget).toBeDefined();
      const status = h.statuses.get("locus");
      expect(status).toContain("WF");
      pinTransientUiKey(h.pi, AGENTS_WIDGET_KEY);
      pinTransientUiKey(h.pi, AGENTS_WIDGET_KEY);
      unpinTransientUiKey(h.pi, AGENTS_WIDGET_KEY);
      setOperatorWidget(h.ctx, "workflows", { ...view, type: "WARN" });
      const nativeAbort = vi.fn();
      expect(dispatch(h, "\x1b[27u", nativeAbort)).toBe(true);
      await h.commands.get("workflows")!.handler("", h.ctx);
      expect(menu).toHaveBeenCalled();
      expect(h.widgetPayloads.get(AGENTS_WIDGET_KEY)).toBe(childWidget);
      expect(h.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBe(parentWidget);
      expect(h.statuses.get("locus")).toBe(status);
      expect(agentLiveStore.rows.get(child.id)?.status).toBe(child.status);
      expect(nativeAbort).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(h.confirmCalls).toEqual([]);

      // The identical cleanup reaches the real AGENTS_WIDGET_KEY once its last owner releases it.
      unpinTransientUiKey(h.pi, AGENTS_WIDGET_KEY);
      await emit(h, "input", { text: "next input" });
      expect(h.widgetPayloads.get(AGENTS_WIDGET_KEY)).toBeUndefined();
      expect(h.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBe(parentWidget);
    } finally {
      unpinTransientUiKey(h.pi, AGENTS_WIDGET_KEY);
      childPanel?.dispose();
      h.setStreaming(false);
      settle();
      await emit(h, "session_shutdown");
      runner.mockRestore();
    }
  });

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
