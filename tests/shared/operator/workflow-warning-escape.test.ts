import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  currentCommandWidgetPresentation,
  installWarningEscapeDismissal,
  pinTransientUiKey,
  registerCommandWithUiLifecycle,
} from "../../../extensions/_shared/operator/command-ui.js";
import { setOperatorWidget } from "../../../extensions/_shared/operator/widget-render.js";
import { installAgentInterruptGuard } from "../../../extensions/agents/fleet/interrupt-guard.js";
import { createHarness } from "../../test-harness.js";

const presses = ["\x1b", "\x1b[27u"] as const;
const release = "\x1b[27;1:3u";
const warning = { type: "WARN", subject: "Stale warning", primary: "fixture" } as const;
const view = { type: "VIEW", subject: "Selected view", primary: "fixture" } as const;

function harness(isStreaming = false) {
  const h = createHarness(undefined, { isStreaming });
  h.ctx.hasUI = true;
  installWarningEscapeDismissal(h.ctx, "workflows");
  return h;
}

function dispatch(h: ReturnType<typeof harness>, data: string) {
  for (const handler of h.terminalInputHandlers) {
    const result = handler(data);
    if (result?.consume) return { consumed: true };
    data = result?.data ?? data;
  }
  return { consumed: false, data };
}

function heldChild() {
  const row = agentLiveStore.begin({ id: "held-child", label: "Held", workflowRunId: "workflow" });
  agentLiveStore.patch(row.id, { status: "working" });
}

afterEach(() => agentLiveStore.reset());

describe("workflow WARN Escape observation", () => {
  it.each(presses)("clears the WARN and forwards the original bytes for %j", async (press) => {
    const h = harness();
    setOperatorWidget(h.ctx, "workflows", warning);
    setOperatorWidget(h.ctx, "peer", warning);
    expect(dispatch(h, press)).toEqual({ consumed: false, data: press });
    await Promise.resolve();
    expect(h.widgets.get("workflows")).toBe("");
    expect(h.widgets.get("peer")).toContain("Stale warning");
  });

  it.each(["guard-first", "warning-first"] as const)(
    "keeps held work protected with %s registration",
    async (order) => {
      const h = harness(true);
      heldChild();
      if (order === "guard-first") installAgentInterruptGuard(h.ctx);
      setOperatorWidget(h.ctx, "workflows", warning);
      if (order === "warning-first") installAgentInterruptGuard(h.ctx);
      const writes = vi.spyOn(h.ctx.ui, "setWidget");
      expect(dispatch(h, release)).toEqual({ consumed: false, data: release });
      await Promise.resolve();
      expect(writes).not.toHaveBeenCalled();
      for (const press of presses) {
        expect(dispatch(h, press)).toEqual({ consumed: true });
        await Promise.resolve();
        expect(h.widgets.get("workflows")).toBe("");
        const control = dispatch(h, press);
        expect(control).toEqual({ consumed: true });
        setOperatorWidget(h.ctx, "workflows", warning);
      }
      expect(writes.mock.calls.filter(([key, value]) => key === "workflows" && value === undefined)).toHaveLength(2);
      expect(h.abortCalls).toBe(0);
      expect(h.confirmCalls).toHaveLength(0);
      expect(agentLiveStore.rows.get("held-child")?.status).toBe("working");
    },
  );

  it.each(["warning-first", "view-first"] as const)(
    "closes the selected WARN and VIEW without changing VIEW consumption in %s order",
    async (order) => {
      const h = harness(true);
      heldChild();
      installAgentInterruptGuard(h.ctx);
      const publish = () => {
        if (order === "warning-first") setOperatorWidget(h.ctx, "workflows", warning);
        setOperatorWidget(h.ctx, "other-view", view);
        if (order === "view-first") setOperatorWidget(h.ctx, "workflows", warning);
      };
      for (const press of presses) {
        publish();
        const writes = vi.spyOn(h.ctx.ui, "setWidget");
        expect(dispatch(h, release)).toEqual({ consumed: false, data: release });
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
        expect(dispatch(h, press)).toEqual({ consumed: true });
        await Promise.resolve();
        expect(writes.mock.calls.map(([key, value]) => [key, value])).toEqual([
          ["other-view", undefined],
          ["workflows", undefined],
        ]);
        writes.mockRestore();
        setOperatorWidget(h.ctx, "other-view", view);
        expect(dispatch(h, press)).toEqual({ consumed: true });
      }
      expect(h.abortCalls).toBe(0);
      expect(h.confirmCalls).toHaveLength(0);
    },
  );

  it.each(["ERROR", "VIEW", "WARN"] as const)("preserves a newer %s published by the VIEW clear", (type) => {
    const h = harness();
    setOperatorWidget(h.ctx, "other-view", view);
    setOperatorWidget(h.ctx, "workflows", warning);
    const write = h.ctx.ui.setWidget.bind(h.ctx.ui);
    const proxy = vi.spyOn(h.ctx.ui, "setWidget").mockImplementation((key, content, options) => {
      write(key, content, options);
      if (key === "other-view" && content === undefined) {
        setOperatorWidget(h.ctx, "workflows", { ...warning, type, subject: "New presentation" });
      }
    });
    expect(dispatch(h, presses[0])).toEqual({ consumed: true });
    expect(h.widgets.get("workflows")).toContain("New presentation");
    expect(proxy.mock.calls.some(([key, value]) => key === "workflows" && value === undefined)).toBe(false);
  });

  it("leaves a newer ERROR from native dispatch and ignores a pinned warning", async () => {
    const h = harness();
    registerCommandWithUiLifecycle(h.pi, { command: "bind", surfaces: ["no-ui"] }, { handler() {} });
    await h.commands.get("bind")!.handler("", h.ctx);
    setOperatorWidget(h.ctx, "workflows", warning);
    expect(dispatch(h, presses[0])).toEqual({ consumed: false, data: presses[0] });
    setOperatorWidget(h.ctx, "workflows", { ...warning, type: "ERROR" });
    await Promise.resolve();
    expect(currentCommandWidgetPresentation(h.ctx, "workflows")?.surface).toBe("ERROR");

    setOperatorWidget(h.ctx, "workflows", warning);
    const pinned = currentCommandWidgetPresentation(h.ctx, "workflows");
    pinTransientUiKey(h.pi, "workflows");
    setOperatorWidget(h.ctx, "other-view", view);
    expect(dispatch(h, presses[1])).toEqual({ consumed: true });
    await Promise.resolve();
    expect(currentCommandWidgetPresentation(h.ctx, "workflows")).toBe(pinned);
  });
});
