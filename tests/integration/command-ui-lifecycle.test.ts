import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import agents from "../../extensions/agents/index.js";
import model from "../../extensions/model/index.js";
import workflows from "../../extensions/workflows/index.js";
import type { ExtensionCommandContext } from "../../extensions/_shared/host/pi-api.js";
import {
  clearCommandWidgetPresentation,
  currentCommandWidgetPresentation,
  pinTransientUiKey,
  registerCommandWithUiLifecycle,
  unpinTransientUiKey,
} from "../../extensions/_shared/operator/command-ui.js";
import { setOperatorWidget } from "../../extensions/_shared/operator/widget-render.js";
import {
  presentWorkflowHandoffPumpResult,
  setWorkflowLaunchStatus,
} from "../../extensions/workflows/operator/operator-surface.js";
import {
  WorkflowOperatorHandoffController,
  type WorkflowHandoffPumpResult,
} from "../../extensions/workflows/operator/operator-handoff-controller.js";
import { WORKFLOW_LIVE_WIDGET_KEY } from "../../extensions/workflows/operator/progress-widget.js";
import { ensureWorkflowRunDir, workflowJournalFile } from "../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../extensions/workflows/runtime/workflow-result.js";
import { appendProjectError } from "../../extensions/_shared/host/error-journal.js";
import { createHarness, emit } from "../test-harness.js";

describe("command UI lifecycle", () => {
  it("dismisses the latest passive VIEW with Escape and leaves no raw listener behind", async () => {
    const h = createHarness();
    delete h.ctx.ui.custom;
    workflows(h.pi);

    // A TUI with custom UI owns the persisted evidence viewer. Removing that
    // capability exercises the bounded passive status fallback and its raw
    // editor-level transient dismissal.
    await h.commands.get("workflows")!.handler("status", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow runs");
    expect(h.terminalInputHandlers.size).toBe(1);

    const result = [...h.terminalInputHandlers][0]?.("\x1b");

    expect(result).toEqual({ consume: true });
    expect(h.widgetPayloads.get("workflows")).toBeUndefined();
    expect(h.widgets.get("workflows")).toBe("");
    expect(h.terminalInputHandlers.size).toBe(0);
  });

  it("installs the passive lifecycle immediately when the workflow custom viewer fails", async () => {
    const h = createHarness();
    h.ctx.ui.custom = (async () => {
      throw new Error("viewer setup failed");
    }) as NonNullable<typeof h.ctx.ui.custom>;
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("status", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow runs");
    expect(h.widgets.get("workflows")).toContain("Interactive evidence viewer failed: viewer setup failed.");
    expect(h.widgets.get("workflows")).toContain("evidence is shown instead.");
    expect(h.widgets.get("workflows")).not.toContain("Recovery: /workflows status");
    expect(h.terminalInputHandlers.size).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "preserves a workflow ERROR and settled status with a peer %s input cleanup",
    async (order) => {
      const h = createHarness();
      const failure = () => {
        setOperatorWidget(h.ctx, "workflows", {
          type: "ERROR",
          subject: "New failure",
          primary: "Original diagnostics",
        });
        return { action: "continue" } as const;
      };
      if (order === "before") h.pi.on("input", failure);
      workflows(h.pi);
      if (order === "after") h.pi.on("input", failure);
      const run = h.commands.get("workflows")!.handler;
      await run("status t162-missing-run", h.ctx);
      expect(h.widgets.get("workflows")).toContain("[WARN]");
      setWorkflowLaunchStatus(h.ctx, "fixture", "settled");
      const status = h.statuses.get("locus");
      expect(status).toContain("WF launch");
      const setStatus = vi.spyOn(h.ctx.ui, "setStatus");
      const setWidget = vi.spyOn(h.ctx.ui, "setWidget");

      await emit(h, "input", { text: "ordinary input", source: "interactive" });
      expect(h.widgets.get("workflows")).toContain("[ERROR] New failure");
      expect(h.statuses.get("locus")).toBe(status);
      expect(setStatus).not.toHaveBeenCalled();
      expect(setWidget).not.toHaveBeenCalledWith(WORKFLOW_LIVE_WIDGET_KEY, undefined);

      h.customInputQueue.push("\x1b");
      await run("list", h.ctx);
      expect(h.statuses.get("locus")).toBeUndefined();
    },
  );

  it("does not clear a warning when a peer handles input before the lifecycle", async () => {
    const h = createHarness();
    h.pi.on("input", () => ({ action: "handled" }));
    workflows(h.pi);
    await h.commands.get("workflows")!.handler("status missing", h.ctx);
    const old = h.widgetPayloads.get("workflows");
    for (const listener of h.handlers.get("input") ?? []) {
      const result = await listener({ type: "input", text: "peer text", source: "interactive" }, h.ctx);
      if (typeof result === "object" && result !== null && "action" in result && result.action === "handled") break;
    }
    expect(h.widgetPayloads.get("workflows")).toBe(old);
  });

  it("keeps a later ERROR through deferred input and the pending Escape route", async () => {
    const h = createHarness();
    workflows(h.pi);
    const run = h.commands.get("workflows")!.handler;
    setOperatorWidget(h.ctx, "workflows", { type: "VIEW", subject: "Old view", primary: "Old evidence" });
    const oldListener = [...h.terminalInputHandlers][0]!;
    await run("status t162-missing-run", h.ctx);
    expect(h.widgets.get("workflows")).toContain("[WARN]");
    // A handoff failure can render while the input accepted by Pi is still queued.
    presentWorkflowHandoffPumpResult(h.ctx, { status: "invalid", message: "Handoff fixture warning" });
    expect(h.widgets.get("workflows")).toContain("Handoff fixture warning");
    setOperatorWidget(h.ctx, "workflows", { type: "ERROR", subject: "Late failure", primary: "Compaction fixture" });
    expect(oldListener("\x1b[27u")).toBeUndefined();
    expect(h.widgets.get("workflows")).toContain("[ERROR] Late failure");

    await emit(h, "input", { text: "queued text", source: "interactive" });
    expect(h.widgets.get("workflows")).toContain("[ERROR] Late failure");
    h.customInputQueue.push("\x1b");
    await run("list", h.ctx);
    expect(h.widgets.get("workflows")).toBe("");
    expect(h.customComponents).toHaveLength(1);
  });

  it("keeps a rebound VIEW safe from the old listener after an asynchronous handoff warning", async () => {
    const h = createHarness();
    const view = { type: "VIEW", subject: "Workflow view", primary: "Recorded evidence" } as const;
    let finish!: (result: WorkflowHandoffPumpResult) => void;
    const result = new Promise<WorkflowHandoffPumpResult>((resolve) => {
      finish = resolve;
    });
    const pump = vi.spyOn(WorkflowOperatorHandoffController.prototype, "pump").mockReturnValueOnce(result);
    workflows(h.pi);
    try {
      await emit(h, "session_start");
      setOperatorWidget(h.ctx, "workflows", view);
      const oldListener = [...h.terminalInputHandlers][0]!;
      await emit(h, "agent_settled");
      await vi.waitFor(() => expect(pump).toHaveBeenCalledOnce());
      finish({ status: "invalid", message: "Late handoff warning" });
      await vi.waitFor(() => expect(h.widgets.get("workflows")).toContain("Late handoff warning"));
      expect(oldListener("\x1b[27u")).toBeUndefined();
      expect(h.widgets.get("workflows")).toContain("Late handoff warning");

      await emit(h, "session_shutdown");
      h.ctx.session!.id = "rebound-session";
      await emit(h, "session_start");
      setOperatorWidget(h.ctx, "workflows", view);
      expect(oldListener("\x1b[27u")).toBeUndefined();
      expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow view");
      const listener = [...h.terminalInputHandlers][0]!;
      expect(listener("\x1b[27;1:3u")).toBeUndefined();
      expect(listener("\x1b[27u")).toEqual({ consume: true });
    } finally {
      pump.mockRestore();
    }
  });

  it("refreshes the VIEW listener when Pi clears subscriptions on a same-UI rebind", async () => {
    const h = createHarness();
    workflows(h.pi);
    const view = { type: "VIEW", subject: "Rebound view", primary: "Current" } as const;
    setOperatorWidget(h.ctx, "workflows", view);
    const old = [...h.terminalInputHandlers][0]!;
    h.terminalInputHandlers.clear();
    setOperatorWidget(h.ctx, "workflows", view);
    const current = [...h.terminalInputHandlers][0];
    expect(current).toBeDefined();
    expect(old("\x1b[27u")).toBeUndefined();
    expect(current?.("\x1b[27u")).toEqual({ consume: true });
    expect(h.widgets.get("workflows")).toBe("");
  });

  it("leaves the pinned progress widget in place when the root menu opens", async () => {
    const h = createHarness();
    workflows(h.pi);
    const run = h.commands.get("workflows")!.handler;
    await run("status t162-missing-run", h.ctx);
    const progress = ["Live workflow progress"];
    h.ctx.ui.setWidget(WORKFLOW_LIVE_WIDGET_KEY, progress);
    pinTransientUiKey(h.pi, WORKFLOW_LIVE_WIDGET_KEY);
    const select = vi.spyOn(h.ctx.ui, "select").mockResolvedValue(undefined);
    await run("", h.ctx);
    expect(h.widgets.get("workflows")).toBe("");
    expect(h.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBe(progress);
    expect(select).toHaveBeenCalledOnce();
  });

  it("clears only the selected presentation, once, within its UI and while unpinned", async () => {
    const h = createHarness();
    workflows(h.pi);
    await h.commands.get("workflows")!.handler("status t162-missing-run", h.ctx);
    const warn = { type: "WARN", subject: "Workflow run", primary: "Same content" } as const;
    setOperatorWidget(h.ctx, "workflows", warn);
    const stale = currentCommandWidgetPresentation(h.ctx, "workflows")!;
    setOperatorWidget(h.ctx, "workflows", warn);
    const selected = currentCommandWidgetPresentation(h.ctx, "workflows")!;
    expect(selected.surface).toBe("WARN");
    expect(clearCommandWidgetPresentation(h.ctx, stale)).toBe(false);
    expect(clearCommandWidgetPresentation(createHarness().ctx, selected)).toBe(false);
    pinTransientUiKey(h.pi, "workflows");
    expect(clearCommandWidgetPresentation(h.ctx, selected)).toBe(false);
    expect(h.widgets.get("workflows")).toContain("Same content");
    unpinTransientUiKey(h.pi, "workflows");
    expect(clearCommandWidgetPresentation(h.ctx, selected)).toBe(true);
    expect(clearCommandWidgetPresentation(h.ctx, selected)).toBe(false);
    expect(h.widgets.get("workflows")).toBe("");
  });

  it("reopens persisted run evidence after a warning clears", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-transient-evidence-"));
    try {
      const runId = "20261119-000001-proof";
      const runDir = ensureWorkflowRunDir(root, runId);
      const journalPath = workflowJournalFile(runDir);
      const failure = appendProjectError(root, {
        ts: "2026-11-19T00:00:00.000Z",
        source: "workflow",
        event: "error",
        message: "Original failure",
        runId,
        journalPath,
      });
      expect(failure.id).toBeDefined();
      const journal = [
        {
          ts: "2026-11-19T00:00:00.000Z",
          runId,
          kind: "error",
          message: "Original failure",
          errorLogPath: failure.path,
        },
      ];
      const result = { runId, ok: false, result: "Original stored result", journal };
      writeFileSync(journalPath, JSON.stringify(journal[0]) + "\n");
      writeFileSync(workflowResultFile(runDir), JSON.stringify(result));

      const h = createHarness(root);
      delete h.ctx.ui.custom;
      workflows(h.pi);
      const run = h.commands.get("workflows")!.handler;
      await run("status t162-missing-run", h.ctx);
      await run(`status ${runId}`, h.ctx);
      expect(h.widgets.get("workflows")).toContain("Original failure");
      await run(`result ${runId}`, h.ctx);
      expect(h.widgets.get("workflows")).toContain("Original stored result");
      expect(JSON.parse(readFileSync(journalPath, "utf8"))).toEqual(journal[0]);
      expect(JSON.parse(readFileSync(workflowResultFile(runDir), "utf8"))).toEqual(result);
      expect(JSON.parse(readFileSync(failure.path, "utf8"))).toMatchObject({ id: failure.id, runId, journalPath });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears transient widgets and statuses when an unrelated slash command is entered", async () => {
    const h = createHarness();
    agents(h.pi);
    model(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    h.ctx.ui.setStatus("agents", "stale agent status");

    await emit(h, "input", { text: "/model-roles" });

    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(h.widgets.get("agents")).toBe("");
    expect(h.statuses.has("agents")).toBe(false);
  });

  it("keeps related transient UI on input so the command handler can replace it", async () => {
    const h = createHarness();
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    await emit(h, "input", { text: "/agent list" });

    expect(h.widgets.get("agents")).toBe("Agent observer: no live rows");
    expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
  });

  it("keeps a pinned live progress widget alive when a chat message is submitted", async () => {
    const h = createHarness();
    agents(h.pi);

    // A live task/spawn_agent run installs the "agents" progress widget and pins it.
    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
    pinTransientUiKey(h.pi, "agents");

    try {
      // A plain chat line normally clears transient command UI; a pinned key survives.
      await emit(h, "input", { text: "just a chat message" });
      expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
      expect(h.widgets.get("agents")).toBe("Agent observer: no live rows");
    } finally {
      unpinTransientUiKey(h.pi, "agents");
    }

    // Once unpinned, the next chat message clears it (no regression to lifecycle UX).
    await emit(h, "input", { text: "another chat message" });
    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(h.widgets.get("agents")).toBe("");
  });

  it("does not clear explicitly persistent command status surfaces", async () => {
    const h = createHarness();
    model(h.pi);
    agents(h.pi);

    h.ctx.ui.setStatus("model-roles", "Model roles: DEFAULT=test/fast");

    await h.commands.get("agent")!.handler("list", h.ctx as ExtensionCommandContext);

    expect(h.statuses.get("model-roles")).toBe("Model roles: DEFAULT=test/fast");
  });

  it("shares cleanup, pinning, and owner callbacks across fresh entrypoint module caches without leaking UI scopes", async () => {
    const alphaPath = path.resolve("tests/fixtures/extensions/command-ui-alpha.ts");
    const betaPath = path.resolve("tests/fixtures/extensions/command-ui-beta.ts");
    const emptyAgentDir = mkdtempSync(path.join(tmpdir(), "locus-pi-empty-agent-dir-"));

    try {
      const loaded = await discoverAndLoadExtensions([alphaPath, betaPath], process.cwd(), emptyAgentDir);
      expect(loaded.errors).toEqual([]);
      const alpha = loaded.extensions.find((extension) => extension.resolvedPath === alphaPath);
      const beta = loaded.extensions.find((extension) => extension.resolvedPath === betaPath);
      const showAlpha = alpha?.commands.get("test-alpha-view")?.handler as unknown as
        ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
      const showBeta = beta?.commands.get("test-beta-view")?.handler as unknown as
        ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
      const betaInput = beta?.handlers.get("input")?.[0] as unknown as
        ((event: { type: "input"; text: string }, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
      const h = createHarness();

      expect(showAlpha).toBeDefined();
      expect(showBeta).toBeDefined();
      expect(betaInput).toBeDefined();
      await showAlpha?.("", h.ctx);
      expect(h.widgets.get("fixture-alpha")).toBe("alpha view");
      expect(h.statuses.get("fixture-alpha-route")).toBe("alpha persistent route");

      await betaInput?.({ type: "input", text: "/test-alpha-view" }, h.ctx);
      expect(h.widgets.get("fixture-alpha")).toBe("alpha view");

      const widgetWrites: Array<{ key: string; cleared: boolean }> = [];
      const setWidget = h.ctx.ui.setWidget.bind(h.ctx.ui);
      h.ctx.ui.setWidget = (key, content, options) => {
        widgetWrites.push({ key, cleared: content === undefined });
        setWidget(key, content, options);
      };
      await showBeta?.("", h.ctx);

      const alphaClear = widgetWrites.findIndex((write) => write.key === "fixture-alpha" && write.cleared);
      const betaRender = widgetWrites.findIndex((write) => write.key === "fixture-beta" && !write.cleared);
      expect(alphaClear).toBeGreaterThanOrEqual(0);
      expect(betaRender).toBeGreaterThan(alphaClear);
      expect(h.widgetPayloads.get("fixture-alpha")).toBeUndefined();
      expect(h.statuses.has("fixture-alpha")).toBe(false);
      expect(h.statuses.get("fixture-alpha-cleanup")).toBe("alpha owner cleanup ran");
      expect(h.statuses.get("fixture-alpha-route")).toBe("alpha persistent route");
      expect(h.widgets.get("fixture-beta")).toBe("beta view");

      await showAlpha?.("pin", h.ctx);
      await showBeta?.("", h.ctx);
      expect(h.widgets.get("fixture-alpha")).toBe("alpha view");
      expect(h.statuses.get("fixture-alpha")).toBe("alpha transient status");
      expect(h.statuses.has("fixture-alpha-cleanup")).toBe(false);
      expect(h.statuses.get("fixture-alpha-route")).toBe("alpha persistent route");

      await showAlpha?.("unpin", h.ctx);
      await showBeta?.("", h.ctx);
      expect(h.widgetPayloads.get("fixture-alpha")).toBeUndefined();
      expect(h.statuses.get("fixture-alpha-cleanup")).toBe("alpha owner cleanup ran");

      const isolatedAlpha = createHarness();
      const isolatedBeta = createHarness();
      await showAlpha?.("", isolatedAlpha.ctx);
      await showBeta?.("", isolatedBeta.ctx);
      expect(isolatedAlpha.widgets.get("fixture-alpha")).toBe("alpha view");
      expect(isolatedBeta.widgets.get("fixture-beta")).toBe("beta view");
    } finally {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    }
  });
});
