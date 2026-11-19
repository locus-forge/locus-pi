import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  clearCommandWidgetPresentation,
  currentCommandWidgetPresentation,
  registerCommandWithUiLifecycle,
  registerTransientUiCleanup,
  setCommandWidget,
} from "../../../../extensions/_shared/operator/command-ui.js";
import { setOperatorStatus } from "../../../../extensions/_shared/operator/operator-status.js";
import { setOperatorWidget } from "../../../../extensions/_shared/operator/widget-render.js";
import { setWorkflowLaunchStatus } from "../../../../extensions/workflows/operator/operator-surface.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  type WorkflowProgressComponent,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { createHarness, emit, runTool } from "../../../test-harness.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

describe("workflow cleanup effects", () => {
  it.each([false, true])(
    "keeps a disposal-time replacement in the actual Pi widget map (throw=%s)",
    (throwAfterDelete) => {
      initTheme("dark");
      const h = createHarness();
      const extensionWidgetsAbove = new Map<string, { render(width: number): string[] }>();
      const host = {
        extensionWidgetsAbove,
        extensionWidgetsBelow: new Map(),
        ui: { requestRender() {} },
        renderWidgets() {
          if (throwAfterDelete && !extensionWidgetsAbove.has("workflows")) throw new Error("Render after deletion");
        },
      };
      const { setExtensionWidget } = InteractiveMode.prototype as unknown as {
        setExtensionWidget: typeof h.ctx.ui.setWidget;
      };
      h.ctx.ui.setWidget = setExtensionWidget.bind(host);
      let replaced = false;
      setCommandWidget(
        h.ctx,
        "workflows",
        () => ({
          render: () => ["Old view"],
          invalidate() {},
          dispose() {
            if (replaced) return;
            replaced = true;
            setOperatorWidget(h.ctx, "workflows", { type: "ERROR", subject: "Nested winner", primary: "Keep this" });
          },
        }),
        { placement: "aboveEditor" },
        "VIEW",
      );
      const old = currentCommandWidgetPresentation(h.ctx, "workflows")!;

      expect(clearCommandWidgetPresentation(h.ctx, old)).toBe(false);
      expect(extensionWidgetsAbove.get("workflows")?.render(90).join("\n")).toContain("Nested winner");
      expect(currentCommandWidgetPresentation(h.ctx, "workflows")).toMatchObject({ surface: "ERROR" });
      expect(currentCommandWidgetPresentation(h.ctx, "workflows")).not.toBe(old);
      expect(h.terminalInputHandlers.size).toBe(0);
    },
  );

  it("selects and applies an owner cleanup once across both cleared keys", async () => {
    const h = createHarness();
    const apply = vi.fn();
    const select = vi.fn(() => apply);
    registerTransientUiCleanup(h.pi, "workflows", select);
    registerTransientUiCleanup(h.pi, WORKFLOW_LIVE_WIDGET_KEY, select);
    workflows(h.pi);
    setCommandWidget(h.ctx, "workflows", ["Old warning"]);
    setCommandWidget(h.ctx, WORKFLOW_LIVE_WIDGET_KEY, ["Old progress"]);
    await h.commands.get("workflows")!.handler("status missing", h.ctx);
    expect(select).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("clears a settled status with no widget once, and only on admission", async () => {
    const h = createHarness();
    workflows(h.pi);
    setWorkflowLaunchStatus(h.ctx, "fixture", "status-only");
    const setStatus = vi.spyOn(h.ctx.ui, "setStatus");
    await emit(h, "input", { text: "ordinary input", source: "interactive" });
    expect(setStatus).not.toHaveBeenCalled();
    expect(h.statuses.get("locus")).toContain("WF launch");
    await h.commands.get("workflows")!.handler("status missing", h.ctx);
    expect(setStatus.mock.calls.filter(([key, text]) => key === "locus" && text === undefined)).toHaveLength(1);
    expect(h.statuses.get("locus")).toBeUndefined();
  });

  it("preserves a fresh ERROR rendered during cleanup through the catalog", async () => {
    const h = createHarness();
    registerCommandWithUiLifecycle(
      h.pi,
      {
        command: "peer-status",
        surfaces: ["status"],
        transientStatuses: ["test-status"],
      },
      { handler() {} },
    );
    workflows(h.pi);
    const run = h.commands.get("workflows")!.handler;
    await run("status t162-missing-run", h.ctx);
    h.ctx.ui.setStatus("test-status", "stale peer status");
    setCommandWidget(h.ctx, WORKFLOW_LIVE_WIDGET_KEY, ["Older settled panel"]);
    setWorkflowLaunchStatus(h.ctx, "fixture", "old contribution");
    const setStatus = h.ctx.ui.setStatus.bind(h.ctx.ui);
    vi.spyOn(h.ctx.ui, "setStatus").mockImplementation((key, text) => {
      setStatus(key, text);
      if (key === "test-status" && text === undefined) {
        setOperatorWidget(h.ctx, "workflows", { type: "ERROR", subject: "Concurrent failure", primary: "New output" });
        setOperatorStatus(h.ctx, {
          id: "workflow.run",
          lane: "activity",
          priority: 70,
          wide: "New status",
          compact: "New status",
          narrow: "New status",
        });
      }
    });
    h.customInputQueue.push("\x1b");

    await run("list", h.ctx);
    expect(h.customComponents).toHaveLength(1);
    expect(h.widgets.get("workflows")).toContain("[ERROR] Concurrent failure");
    expect(h.widgets.get(WORKFLOW_LIVE_WIDGET_KEY)).toBe("");
    expect(h.statuses.get("locus")).toContain("New status");
  });

  it.each([false, true])(
    "clears its completed surface once and retains drill rows (republish=%s)",
    async (republish) => {
      const root = mkdtempSync(path.join(tmpdir(), "wf-live-turn-end-"));
      try {
        writeFileSync(path.join(root, "done.workflow.mjs"), "export default () => ({ summary: 'done' });\n", "utf8");
        const harness = createHarness(root);
        harness.ctx.hasUI = true;
        workflows(harness.pi);

        await harness.commands.get("workflows")!.handler("run done.workflow.mjs", harness.ctx);
        await waitUntil(() =>
          harness.sentMessages.some(
            (entry) => (entry.message.details as { eventKind?: string } | undefined)?.eventKind === "workflow_end",
          ),
        );
        const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
        expect(typeof payload).toBe("function");
        const component = (
          payload as (tui: { requestRender: () => void }, theme: unknown) => WorkflowProgressComponent
        )({ requestRender: () => {} }, {});
        const ownedRowId = `workflow:${component.runId}:default:test:`;
        agentLiveStore.begin({ id: ownedRowId, agentName: "default", label: "test", isolated: false, noMcp: false });
        agentLiveStore.patch(ownedRowId, { status: "done", currentTools: ["read"] });

        const originalSetStatus = harness.ctx.ui.setStatus.bind(harness.ctx.ui);
        let clears = 0;
        const setStatus = vi.spyOn(harness.ctx.ui, "setStatus").mockImplementation((key, value) => {
          originalSetStatus(key, value);
          if (key === "locus" && value === undefined && ++clears === 1 && republish) {
            setOperatorStatus(harness.ctx, {
              id: "workflow.run",
              lane: "activity",
              priority: 70,
              wide: "New status",
              compact: "New status",
              narrow: "New status",
            });
          }
        });
        await emit(harness, "turn_end");
        await emit(harness, "turn_end");

        expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
        expect(agentLiveStore.rows.get(ownedRowId)).toMatchObject({ status: "done", currentTools: [] });
        expect(setStatus.mock.calls.filter(([key, value]) => key === "locus" && value === undefined)).toHaveLength(1);
        if (republish) expect(harness.statuses.get("locus")).toContain("New status");
        else expect(harness.statuses.has("locus")).toBe(false);
      } finally {
        agentLiveStore.reset();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps launch observer entry from clearing progress published after admission", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    registerCommandWithUiLifecycle(
      harness.pi,
      {
        command: "peer-status",
        surfaces: ["status"],
        transientStatuses: ["stale"],
      },
      { handler() {} },
    );
    workflows(harness.pi);
    const newer = ["Published during admission"];
    const original = harness.ctx.ui.setStatus.bind(harness.ctx.ui);
    vi.spyOn(harness.ctx.ui, "setStatus").mockImplementation((key, value) => {
      original(key, value);
      if (key === "stale" && value === undefined) setCommandWidget(harness.ctx, WORKFLOW_LIVE_WIDGET_KEY, newer);
    });
    let atRunnerEntry: unknown;
    const run = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async () => {
      atRunnerEntry = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
      return {
        runId: "after-admission",
        runDir: "/tmp/after-admission",
        ok: true,
        result: {},
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/after-admission/result.json" },
      };
    });
    try {
      await harness.commands.get("workflows")!.handler("run live-smoke hello", harness.ctx);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(atRunnerEntry).toBe(newer);
    } finally {
      await emit(harness, "session_shutdown");
      run.mockRestore();
    }
  });

  it("preserves the workflow status and attached tool work through admission and turn_end", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflows(harness.pi);
    const result: runner.RunWorkflowScriptResult = {
      runId: "attached",
      runDir: "/tmp/attached",
      ok: true,
      result: {},
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/attached/result.json" },
    };
    let finish!: () => void;
    const held = new Promise<runner.RunWorkflowScriptResult>((resolve) => {
      finish = () => resolve(result);
    });
    const run = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (options) => {
      options.onRunStart?.({ runId: result.runId, runDir: result.runDir });
      return held;
    });
    const tool = runTool(harness, "workflow", { name: "live-smoke", input: "held" });
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      setOperatorStatus(harness.ctx, {
        id: "workflow.run",
        lane: "activity",
        priority: 70,
        wide: "Live status",
        compact: "Live status",
        narrow: "Live status",
      });
      await harness.commands.get("workflows")!.handler("status missing", harness.ctx);
      await emit(harness, "turn_end");
      expect(harness.statuses.get("locus")).toContain("Live status");
      expect(run.mock.calls[0]?.[0].signal?.aborted).toBe(false);
      expect(harness.abortCalls).toBe(0);
    } finally {
      finish();
      await tool;
      run.mockRestore();
    }
  });
});
