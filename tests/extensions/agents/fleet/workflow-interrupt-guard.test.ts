import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { setOperatorWidget } from "../../../../extensions/_shared/operator/widget-render.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
import { createHarness, emit } from "../../../test-harness.js";

afterEach(() => agentLiveStore.reset());

describe("workflow interrupt guard", () => {
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
