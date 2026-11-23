import { CustomEditor, ExtensionInputComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import { installAgentInterruptGuard } from "../../../../extensions/agents/fleet/interrupt-guard.js";
import workflows from "../../../../extensions/workflows/index.js";
import { installWorkflowProgress } from "../../../../extensions/workflows/operator/progress-widget.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { setOperatorWidget } from "../../../../extensions/_shared/operator/widget-render.js";
import { createHarness, emit } from "../../../test-harness.js";

const legacy = "\x1b";
const kitty = "\x1b[27u";
const release = "\x1b[27;1:3u";
const view = { type: "VIEW", subject: "Passive view", primary: "Original" } as const;
const orders = ["guard first", "view first"] as const;

beforeAll(() => initTheme("dark"));
afterEach(() => {
  agentLiveStore.reset();
  vi.restoreAllMocks();
});

type Harness = ReturnType<typeof createHarness>;

function dispatch(h: Harness, raw: string, focused: (data: string) => void): boolean {
  // Pi walks the live Set and stops at the first consumer.
  for (const listener of h.terminalInputHandlers) {
    const result = listener(raw);
    if (result?.consume) return true;
    raw = result?.data ?? raw;
  }
  if (!isKeyRelease(raw)) focused(raw);
  return false;
}

async function withHeldRun(
  h: Harness,
  check: (
    abort: () => void,
    lease: ReturnType<ReturnType<typeof workflowBackgroundRunRegistry>["startSession"]>,
  ) => void,
): Promise<void> {
  const registry = workflowBackgroundRunRegistry();
  const lease = registry.startSession(h.ctx.session!.projectRoot!, h.ctx.session!.id);
  const parent = new AbortController();
  const nativeAbort = vi.fn(() => {
    h.ctx.abort?.();
    parent.abort();
  });
  const childCancel = vi.fn();
  const child = agentLiveStore.begin({ id: "workflow-child", label: "Held child", workflowRunId: "held" });
  agentLiveStore.registerCancel(child.id, childCancel);
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const run = registry.attach(lease, parent.signal, ({ signal }) => {
    signal.addEventListener("abort", childCancel);
    return pending;
  });
  if (!run.ok) throw new Error("Fixture did not attach");
  await Promise.resolve();
  try {
    check(nativeAbort, lease);
    expect(nativeAbort).not.toHaveBeenCalled();
    expect(h.abortCalls).toBe(0);
    expect(h.confirmCalls).toEqual([]);
    expect(childCancel).not.toHaveBeenCalled();
    expect(registry.unsettled(lease)[0]).toMatchObject({ state: "running", stopRequested: false });
    expect(agentLiveStore.rows.get(child.id)?.status).toBe(child.status);
  } finally {
    settle();
    await run.run.terminal;
    registry.shutdown(lease);
  }
}

function nativeEditor(abort: () => void): (raw: string) => void {
  // Use Pi's actual native shortcut handler with the default Escape binding.
  const editor = Object.assign(Object.create(CustomEditor.prototype) as object, {
    keybindings: {
      matches: (data: string, action: string) => action === "app.interrupt" && matchesKey(data, "escape"),
    },
    onEscape: abort,
    isShowingAutocomplete: () => false,
  });
  return (raw) => CustomEditor.prototype.handleInput.call(editor, raw);
}

describe("workflow interrupt guard", () => {
  it.each(orders)("matches Kitty and legacy Escape with a held VIEW (%s)", async (order) => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    await withHeldRun(h, (abort) => {
      for (const press of [kitty, legacy]) {
        if (order === "guard first") installAgentInterruptGuard(h.ctx);
        setOperatorWidget(h.ctx, "workflows", view);
        if (order === "view first") installAgentInterruptGuard(h.ctx);
        const oldView = h.widgetPayloads.get("workflows");
        expect(dispatch(h, release, nativeEditor(abort))).toBe(false);
        expect(h.widgetPayloads.get("workflows")).toBe(oldView);
        expect(dispatch(h, press, nativeEditor(abort))).toBe(true);
        expect(h.widgetPayloads.get("workflows")).toBeUndefined();
      }
    });
  });

  it("consumes the eligible VIEW press even when the host throws on clear", async () => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    installAgentInterruptGuard(h.ctx);
    setOperatorWidget(h.ctx, "workflows", view);
    const clear = vi.spyOn(h.ctx.ui, "setWidget").mockImplementationOnce(() => {
      throw new Error("Host clear failed");
    });
    await withHeldRun(h, (abort) => {
      expect(dispatch(h, kitty, nativeEditor(abort))).toBe(true);
      expect(clear).toHaveBeenCalledWith("workflows", undefined, undefined);
      expect(h.widgets.get("workflows")).toContain("[VIEW]");
    });
  });

  it.each(["peer first", "guard first"] as const)("preserves native ordering if a %s replaces the VIEW", (order) => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    const replace = () => {
      setOperatorWidget(h.ctx, "workflows", { ...view, type: "ERROR" });
      return undefined;
    };
    if (order === "guard first") installAgentInterruptGuard(h.ctx);
    h.ctx.ui.onTerminalInput?.(replace);
    if (order === "peer first") installAgentInterruptGuard(h.ctx);
    setOperatorWidget(h.ctx, "workflows", view);
    agentLiveStore.begin({ id: "peer-replacement-child", label: "Held child", workflowRunId: "held" });
    const nativeAbort = vi.fn();
    expect(dispatch(h, legacy, nativeEditor(nativeAbort))).toBe(order === "peer first");
    expect(nativeAbort).toHaveBeenCalledTimes(order === "peer first" ? 0 : 1);
    expect(h.widgets.get("workflows")).toContain("[ERROR]");
    expect(h.terminalInputHandlers.size).toBe(2);
  });

  it.each([false, true])("protects held work with WARN present=%s", async (warn) => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    if (warn) setOperatorWidget(h.ctx, "workflows", { ...view, type: "WARN" });
    const widget = h.widgetPayloads.get("workflows");
    await withHeldRun(h, (abort) => {
      expect(dispatch(h, release, nativeEditor(abort))).toBe(false);
      for (const press of [kitty, legacy]) expect(dispatch(h, press, nativeEditor(abort))).toBe(true);
      expect(h.widgetPayloads.get("workflows")).toBe(widget);
    });
  });

  it("gives native Pi input the legacy protected-work outcome for both encodings", async () => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    await withHeldRun(h, () => {
      const cancelInput = vi.fn();
      const input = new ExtensionInputComponent("Native input", "", vi.fn(), cancelInput);
      expect(dispatch(h, release, (key) => input.handleInput(key))).toBe(false);
      for (const press of [kitty, legacy]) expect(dispatch(h, press, (key) => input.handleInput(key))).toBe(true);
      expect(cancelInput).not.toHaveBeenCalled();
    });
  });

  it.each(["WARN", "ERROR", "progress"] as const)(
    "leaves native ordinary interruption available over %s",
    (surface) => {
      const h = createHarness(undefined, { isStreaming: true });
      h.ctx.hasUI = true;
      installAgentInterruptGuard(h.ctx);
      const progress = surface === "progress" ? installWorkflowProgress(h.ctx, "agents", "Task", "offline") : undefined;
      try {
        if (surface !== "progress") setOperatorWidget(h.ctx, "workflows", { ...view, type: surface });
        const abort = vi.fn();
        for (const press of [legacy, kitty]) expect(dispatch(h, press, nativeEditor(abort))).toBe(false);
        expect(abort).toHaveBeenCalledTimes(2);
      } finally {
        progress?.dispose();
      }
    },
  );

  it("passes an idle held-work Escape down the native route", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    installAgentInterruptGuard(h.ctx);
    await withHeldRun(h, () => {
      const focused = vi.fn();
      expect(dispatch(h, kitty, focused)).toBe(false);
      expect(focused).toHaveBeenCalledWith(kitty);
    });
  });

  it("keeps Pi's native custom mount and delivers the raw key after peer transforms", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    const custom = h.ctx.ui.custom;
    installAgentInterruptGuard(h.ctx);
    const cancelInput = vi.fn();
    const input = new ExtensionInputComponent("Native input", "", vi.fn(), cancelInput);
    h.ctx.ui.onTerminalInput?.(() => ({ data: kitty }));
    const focused = vi.fn((data: string) => input.handleInput(data));
    expect(dispatch(h, legacy, focused)).toBe(false);
    expect(focused).toHaveBeenCalledWith(kitty);
    expect(cancelInput).toHaveBeenCalledOnce();
    expect(h.ctx.ui.custom).toBe(custom);
  });

  it("closes a Doctor VIEW during streaming even after a newer progress widget", async () => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    workflows(h.pi);
    installAgentInterruptGuard(h.ctx);
    await h.commands.get("workflows")!.handler("doctor check --host codex --scope project", h.ctx);
    expect(h.widgets.get("workflows")).toContain("[VIEW]");
    const progress = installWorkflowProgress(h.ctx, "agents", "Later progress", "offline");
    try {
      const payload = h.widgetPayloads.get("agents");
      const abort = vi.fn();
      expect(dispatch(h, legacy, nativeEditor(abort))).toBe(true);
      expect(h.widgetPayloads.get("workflows")).toBeUndefined();
      expect(h.widgetPayloads.get("agents")).toBe(payload);
      expect(abort).not.toHaveBeenCalled();
      expect(dispatch(h, legacy, nativeEditor(abort))).toBe(false);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      progress.dispose();
    }
  });

  it("restores standalone confirmation over progress and ignores repeat while pending", async () => {
    const h = createHarness(undefined, { isStreaming: true });
    h.ctx.hasUI = true;
    installAgentInterruptGuard(h.ctx);
    let answer!: (confirmed: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const confirm = vi.spyOn(h.ctx.ui, "confirm").mockReturnValue(pending);
    const standalone = agentLiveStore.begin({ id: "standalone", label: "Standalone" });
    const cancel = vi.fn();
    agentLiveStore.registerCancel(standalone.id, cancel);
    const progress = installWorkflowProgress(h.ctx, "agents", "Standalone", "offline");
    try {
      const focused = vi.fn();
      expect(dispatch(h, kitty, focused)).toBe(true);
      expect(dispatch(h, legacy, focused)).toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
      answer(false);
      await vi.waitFor(() => expect(h.notifications).toContain("Agent operation continues."));
      expect(h.abortCalls).toBe(0);
      expect(cancel).not.toHaveBeenCalled();
      confirm.mockResolvedValueOnce(true);
      expect(dispatch(h, kitty, focused)).toBe(true);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(h.abortCalls).toBe(1);
    } finally {
      answer(false);
      progress.dispose();
    }
  });
});
