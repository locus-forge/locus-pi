/**
 * Terminal and headless projection: what the workflow tool and `/workflows`
 * commands return as text, with no TUI to render into.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflowsExt from "../../../../extensions/workflows/index.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  WorkflowProgressComponent,
  WorkflowTextComponent,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  workflowJournalFile,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness, emit, runTool } from "../../../test-harness.js";
import { clearViewerExternalRows } from "../../../../extensions/_shared/operator/viewer-geometry.js";

afterEach(() => clearViewerExternalRows("workflow-live"));

function line(input: Omit<WorkflowJournalLine, "ts"> & { ts: string | number }): WorkflowJournalLine {
  return input as WorkflowJournalLine;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function writeWorkflowRun(root: string, runId: string): void {
  const dir = ensureWorkflowRunDir(root, runId);
  const journal: WorkflowJournalLine[] = [
    { ts: "2026-01-01T00:00:00.000Z", runId, kind: "phase", phase: "repair-proof" },
    { ts: "2026-01-01T00:00:01.000Z", runId, kind: "error", message: "failed proof" },
  ];
  writeFileSync(workflowJournalFile(dir), journal.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  writeFileSync(workflowResultFile(dir), JSON.stringify({ runId, ok: false, journal }), "utf8");
}

function renderHarnessWidget(harness: ReturnType<typeof createHarness>, key = "workflows", width = 220): string {
  const payload = harness.widgetPayloads.get(key);
  expect(typeof payload).toBe("function");
  const stubTui = { requestRender: vi.fn(), terminal: { rows: 100, columns: width } };
  const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
  return component.render(width).join("\n");
}

describe("workflow progress terminal and headless projection", () => {
  it("run branch delegates approval to Pi before launch", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflowsExt(harness.pi);
    const handler = harness.commands.get("workflows")!.handler;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-1",
      runDir: "/tmp/run-1",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-1/result.json" },
    });

    try {
      await handler("run live-smoke hello", harness.ctx);

      expect(harness.selectCalls).toHaveLength(0);
      expect(harness.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
      expect(harness.statuses.get("locus")).toContain("WF launch");
      expect(harness.statuses.has(WORKFLOW_LIVE_WIDGET_KEY)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("run branch does not depend on Locus select UI", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = false;
    harness.ctx.ui.select = undefined as unknown as typeof harness.ctx.ui.select;
    workflowsExt(harness.pi);
    const handler = harness.commands.get("workflows")!.handler;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-2",
      runDir: "/tmp/run-2",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-2/result.json" },
    });

    try {
      await handler("run live-smoke hello", harness.ctx);

      expect(harness.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
      expect(harness.statuses.get("locus")).toContain("WF launch");
      expect(harness.statuses.has("workflows")).toBe(false);
      expect(harness.selectCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("labels a settled command result as run history plus its workflow source", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-command-result-source-"));
    const scriptPath = path.join(root, "project.workflow.mjs");
    try {
      writeFileSync(scriptPath, "export default () => ({ verdict: 'ok' });\n", "utf8");
      const harness = createHarness(root);
      workflowsExt(harness.pi);
      const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
        runId: "run-project",
        runDir: "/tmp/run-project",
        ok: true,
        result: { verdict: "ok" },
        journal: [],
        target: { kind: "scriptPath", ref: "project.workflow.mjs", path: scriptPath, source: "project" },
        resultPersistence: { ok: true, path: "/tmp/run-project/result.json" },
      });

      try {
        await harness.commands.get("workflows")!.handler("run project.workflow.mjs", harness.ctx);
        await waitUntil(() => typeof harness.widgetPayloads.get("workflows") === "function");

        const text = renderHarnessWidget(harness);
        expect(text).toContain("[RESULT] Workflow run");
        expect(text).toContain("[R] [P]");
        expect(text).toContain("Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history");
        expect(text).toContain("Detail: /workflows status run-project");
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the same semantic completion in TUI/RPC and does not claim delivery in no-UI mode", async () => {
    for (const surface of ["tui", "rpc", "no-ui"] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `wf-zero-event-${surface}-`));
      try {
        writeFileSync(
          path.join(root, "silent.workflow.mjs"),
          "export default function() { return { verdict: 'silent-ok', rawSecret: { nested: true } }; }\n",
          "utf8",
        );
        const harness = createHarness(root, { mode: surface === "rpc" ? "rpc" : "tui" });
        harness.ctx.hasUI = surface !== "no-ui";
        workflowsExt(harness.pi);

        await harness.commands.get("workflows")!.handler("run silent.workflow.mjs", harness.ctx);
        await waitUntil(() =>
          harness.sentMessages.some(
            (entry) => (entry.message.details as { eventKind?: string } | undefined)?.eventKind === "workflow_end",
          ),
        );

        let text: string;
        if (surface === "tui") {
          const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
          expect(typeof payload).toBe("function");
          const stubTui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 220 } };
          const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowProgressComponent)(
            stubTui,
            {},
          );
          text = component.render(220).join("\n");
        } else if (surface === "rpc") {
          text = harness.widgets.get(WORKFLOW_LIVE_WIDGET_KEY) ?? "";
          expect(Array.isArray(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY))).toBe(true);
        } else {
          text = harness.widgets.get("workflows") ?? "";
          expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
        }
        if (surface === "no-ui") {
          expect(text).toBe("");
        } else {
          expect(text).toContain("silent-ok");
          expect(text).not.toContain("rawSecret");
          expect(text).not.toContain("nested");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("keeps zero-event tool output semantic and exposes raw result only through status/result.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-zero-event-tool-"));
    try {
      writeFileSync(
        path.join(root, "silent.workflow.mjs"),
        "export default function({ publishArtifact }) { publishArtifact('handoff.md', 'reader handoff'); return { summary: 'tool-ok', rawSecret: { nested: true } }; }\n",
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      const result = await runTool(harness, "workflow", { scriptPath: "silent.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

      expect(text).toContain("✓ workflow silent.workflow.mjs finished · tool-ok");
      expect(text).toContain('"artifactId":"published-0001"');
      expect(text).toContain('"name":"handoff.md"');
      expect(text).not.toContain("rawSecret");
      expect(result.details).not.toHaveProperty("result");
      expect(result.details).toMatchObject({
        resultPath: expect.stringContaining("result.json"),
        resultPersistence: { ok: true },
        artifactRefs: [
          {
            runId: expect.any(String),
            artifactId: "published-0001",
            name: "handoff.md",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        ],
      });
      const resultPath = String(result.details?.resultPath ?? "");
      const persisted = readFileSync(resultPath, "utf8");
      expect(persisted).toContain('"rawSecret"');
      expect(persisted).toContain('"artifactRefs"');

      delete harness.ctx.ui.custom;
      await harness.commands.get("workflows")!.handler(`status ${String(result.details?.runId ?? "")}`, harness.ctx);
      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 60, columns: 220 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      expect(component.render(220).join("\n")).toContain('"rawSecret"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects a non-JSON-safe trusted-file result as failure through tool, status, and result.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-non-json-tool-"));
    try {
      writeFileSync(path.join(root, "unsafe.workflow.mjs"), "export default function() { return 42n; }\n", "utf8");
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      const result = await runTool(harness, "workflow", { scriptPath: "unsafe.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

      expect(result.isError).toBe(true);
      expect(text).toContain("✗ workflow unsafe.workflow.mjs failed");
      expect(text).toContain("not JSON-safe");
      expect(text).not.toContain("finished");
      expect(result.details?.resultDiagnostic).toMatchObject({ code: "WORKFLOW_RESULT_NOT_JSON_SAFE" });

      const resultPath = String(result.details?.resultPath ?? "");
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
        ok: false,
        resultDiagnostic: { code: "WORKFLOW_RESULT_NOT_JSON_SAFE" },
      });

      delete harness.ctx.ui.custom;
      await harness.commands.get("workflows")!.handler(`status ${String(result.details?.runId ?? "")}`, harness.ctx);
      expect(renderHarnessWidget(harness)).toContain("status:failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a persistence failure message once in tool output while retaining typed details", async () => {
    const message = "Workflow result was not persisted: blocked";
    const failed = {
      runId: "persistence-failure",
      runDir: "/tmp/persistence-failure",
      ok: false,
      result: { summary: "execution completed" },
      error: message,
      journal: [],
      resultPersistence: {
        ok: false as const,
        path: "/tmp/persistence-failure/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED" as const,
        message,
      },
    };
    const harness = createHarness();
    workflowsExt(harness.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(failed);
    try {
      const result = await runTool(harness, "workflow", { scriptPath: "persistence.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

      expect(result.isError).toBe(true);
      expect(text.match(/Workflow result was not persisted: blocked/gu)).toHaveLength(1);
      expect(text).toContain("persistence: WORKFLOW_RESULT_WRITE_FAILED");
      expect(result.details?.resultPersistence).toEqual(failed.resultPersistence);
    } finally {
      spy.mockRestore();
    }
  });

  it("projects semantic failure rows through tool and headless command surfaces", async () => {
    const failed = {
      runId: "semantic-failure",
      runDir: "/tmp/semantic-failure",
      ok: false,
      result: { ok: false, summary: "Acceptance remains open", unresolvedRows: ["R-GIT", "R-CODE"] },
      journal: [],
      resultPersistence: { ok: true as const, path: "/tmp/semantic-failure/result.json" },
    };

    const toolHarness = createHarness();
    workflowsExt(toolHarness.pi);
    const toolSpy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(failed);
    try {
      const result = await runTool(toolHarness, "workflow", { scriptPath: "semantic.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
      expect(result.isError).toBe(true);
      expect(text).toContain("Acceptance remains open");
      expect(text).toContain("R-CODE, R-GIT");
      expect(text).not.toContain("unknown error");
      expect(result.details?.result).toEqual(failed.result);
    } finally {
      toolSpy.mockRestore();
    }

    const commandHarness = createHarness();
    delete commandHarness.ctx.hasUI;
    workflowsExt(commandHarness.pi);
    const commandSpy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(failed);
    try {
      await commandHarness.commands.get("workflows")!.handler("run semantic.workflow.mjs", commandHarness.ctx);
      await waitUntil(() => typeof commandHarness.widgetPayloads.get("workflows") === "function");
      const text = renderHarnessWidget(commandHarness);
      expect(text).toContain("[ERROR] Workflow run");
      expect(text).toContain("Acceptance remains open");
      expect(text).toContain("R-CODE, R-GIT");
      expect(text).not.toContain("Workflow execution failed.");
    } finally {
      commandSpy.mockRestore();
    }
  });

  it("keeps terminal metadata identical between success and error tool results", async () => {
    const success = {
      runId: "terminal-parity-success",
      runDir: "/tmp/terminal-parity-success",
      ok: true,
      result: { summary: "done" },
      disposition: { status: "completed" as const },
      journal: [],
      resultPersistence: { ok: true as const, path: "/tmp/terminal-parity-success/result.json" },
    };
    const failure = {
      runId: "terminal-parity-failure",
      runDir: "/tmp/terminal-parity-failure",
      ok: false,
      result: { summary: "failed" },
      error: "failed",
      disposition: { status: "failed" as const },
      journal: [],
      resultPersistence: { ok: true as const, path: "/tmp/terminal-parity-failure/result.json" },
    };
    const harness = createHarness();
    workflowsExt(harness.pi);
    const runSpy = vi.spyOn(runner, "runWorkflowScript");
    runSpy.mockResolvedValueOnce(success).mockResolvedValueOnce(failure);
    try {
      const successResult = await runTool(harness, "workflow", { name: "terminal-parity" });
      const failureResult = await runTool(harness, "workflow", { name: "terminal-parity" });
      const successDetails = successResult.details as Record<string, unknown>;
      const failureDetails = failureResult.details as Record<string, unknown>;
      const intentionalDifferences = new Set([
        "status",
        "summary",
        "disposition",
        "transcript",
        "runId",
        "runDir",
        "outputDir",
        "resultPath",
        "resultPersistence",
        "result",
        "error",
      ]);
      const successSharedKeys = Object.keys(successDetails)
        .filter((key) => !intentionalDifferences.has(key))
        .sort();
      const failureSharedKeys = Object.keys(failureDetails)
        .filter((key) => !intentionalDifferences.has(key))
        .sort();
      expect(failureSharedKeys).toEqual(successSharedKeys);
      for (const key of successSharedKeys) {
        expect(failureDetails[key], `shared terminal metadata: ${key}`).toEqual(successDetails[key]);
      }
      expect(successDetails.status).toBe("completed");
      expect(failureDetails.status).toBe("failed");
      expect(failureDetails.transcript).toMatchObject({ surface: "tool", eventKind: "workflow_end" });
      expect(successDetails).not.toHaveProperty("result");
      expect(failureDetails).toMatchObject({ result: failure.result, error: failure.error });
    } finally {
      runSpy.mockRestore();
    }
  });

  it("pins an active run, then retires its widget while retaining terminal rows on next input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-live-input-"));
    try {
      const exactResult = `${"Complete implementation plan line. ".repeat(200)}\nUNTRUNCATED_COMMAND_RESULT`;
      writeFileSync(
        path.join(root, "slow.workflow.mjs"),
        `export default async function run(dsl) {\n` +
          `  dsl.phase("slow");\n` +
          `  dsl.log("started");\n` +
          `  await new Promise((resolve) => setTimeout(resolve, 100));\n` +
          `  return ${JSON.stringify(exactResult)};\n` +
          `}\n`,
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      const runPromise = Promise.resolve(handler("run slow.workflow.mjs", harness.ctx));
      await waitUntil(() => harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY) !== undefined);
      expect(harness.statuses.get("locus")).toContain("WF");
      await emit(harness, "input", { text: "new prompt while workflow runs" });
      expect(harness.statuses.get("locus")).toContain("WF");
      await emit(harness, "turn_end");

      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).not.toBeUndefined();
      expect(harness.statuses.get("locus")).toContain("WF");

      await runPromise;
      await waitUntil(() =>
        harness.sentMessages.some(
          (entry) => (entry.message.details as { eventKind?: string } | undefined)?.eventKind === "workflow_end",
        ),
      );
      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).not.toBeUndefined();
      const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
      const component = (payload as (tui: { requestRender: () => void }, theme: unknown) => WorkflowProgressComponent)(
        { requestRender: () => {} },
        {},
      );
      const ownedRowId = `workflow:${component.runId}:group:test`;
      agentLiveStore.begin({
        id: ownedRowId,
        agentName: "workflow-group",
        label: "test",
        groupKind: "parallel",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.begin({
        id: "agent-live-unlabelled",
        parentRowId: ownedRowId,
        agentName: "task",
        label: "child",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.begin({
        id: "agent-live-grandchild",
        parentRowId: "agent-live-unlabelled",
        agentName: "task",
        label: "grandchild",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.begin({
        id: "unrelated-row",
        agentName: "task",
        label: "other work",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(ownedRowId, { status: "done" });
      agentLiveStore.patch("agent-live-unlabelled", { status: "done", currentTools: ["bash"] });
      agentLiveStore.patch("agent-live-grandchild", { status: "done", currentTools: ["read"] });

      await emit(harness, "input", { text: "new prompt after workflow completed" });

      expect(harness.widgetPayloads.has(WORKFLOW_LIVE_WIDGET_KEY)).toBe(true);
      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
      expect(agentLiveStore.rows.get(ownedRowId)).toMatchObject({ status: "done" });
      expect(agentLiveStore.rows.get("agent-live-unlabelled")).toMatchObject({ status: "done", currentTools: [] });
      expect(agentLiveStore.rows.get("agent-live-grandchild")).toMatchObject({ status: "done", currentTools: [] });
      expect(agentLiveStore.rows.has("unrelated-row")).toBe(true);
      expect(harness.statuses.has("locus")).toBe(false);
      const persisted = harness.sentMessages.map((entry) => String(entry.message.content));
      expect(persisted).toHaveLength(3);
      expect(persisted[0]).toContain("workflow slow.workflow.mjs · run #");
      expect(persisted[0]).not.toContain("── workflow slow.workflow.mjs");
      expect(persisted[0]).toContain("● workflow started");
      expect(persisted[0]).toContain(`runDir: ${path.join(root, ".locus-pi", "runs")}`);
      expect(persisted[1]).toContain("✓ workflow slow.workflow.mjs finished");
      expect(persisted[1]).not.toContain("Complete implementation plan line.");
      expect(persisted[2]).toBe(exactResult);
      expect(harness.sentMessages.map((entry) => entry.message.customType)).toEqual([
        "locus-workflow-run",
        "locus-workflow-run",
        "locus-workflow-result",
      ]);
      expect(harness.sentMessages.every((entry) => entry.message.display === true)).toBe(true);
      expect(
        harness.sentMessages.every(
          (entry) => entry.options?.triggerTurn === false && entry.options.deliverAs === undefined,
        ),
      ).toBe(true);
    } finally {
      agentLiveStore.reset();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears a completed workflow surface on Pi turn_end but retains terminal drill rows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-live-turn-end-"));
    try {
      writeFileSync(path.join(root, "done.workflow.mjs"), "export default () => ({ summary: 'done' });\n", "utf8");
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      await harness.commands.get("workflows")!.handler("run done.workflow.mjs", harness.ctx);
      await waitUntil(() =>
        harness.sentMessages.some(
          (entry) => (entry.message.details as { eventKind?: string } | undefined)?.eventKind === "workflow_end",
        ),
      );
      const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
      expect(typeof payload).toBe("function");
      const component = (payload as (tui: { requestRender: () => void }, theme: unknown) => WorkflowProgressComponent)(
        { requestRender: () => {} },
        {},
      );
      const ownedRowId = `workflow:${component.runId}:default:test:`;
      agentLiveStore.begin({ id: ownedRowId, agentName: "default", label: "test", isolated: false, noMcp: false });
      agentLiveStore.patch(ownedRowId, { status: "done", currentTools: ["read"] });

      await emit(harness, "turn_end");

      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
      expect(agentLiveStore.rows.get(ownedRowId)).toMatchObject({ status: "done", currentTools: [] });
    } finally {
      agentLiveStore.reset();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run command passes --resume as persisted retry metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-command-resume-"));
    const sourceRunId = "20260101-000001-source";
    const runDir = ensureWorkflowRunDir(root, sourceRunId);
    try {
      writeFileSync(
        workflowJournalFile(runDir),
        JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", runId: sourceRunId, kind: "log", message: "source" }) + "\n",
        "utf8",
      );
      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({ runId: sourceRunId, ok: true, result: { source: true }, journal: [] }),
        "utf8",
      );
      writeFileSync(
        path.join(root, "retry.workflow.mjs"),
        "export default function(dsl, input) { dsl.log('retry command'); return { input }; }\n",
        "utf8",
      );

      const harness = createHarness(root);
      harness.ctx.hasUI = false;
      workflowsExt(harness.pi);
      harness.ctx.hasUI = true;
      const handler = harness.commands.get("workflows")!.handler;

      await handler(`run retry.workflow.mjs --resume ${sourceRunId} payload`, harness.ctx);

      expect(harness.selectCalls).toHaveLength(0);
      expect(harness.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("status detail keeps raw result and distinguishes script, runtime, and legacy logs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-status-detail-"));
    const runId = "20260101-000001-detail";
    const runDir = ensureWorkflowRunDir(root, runId);
    const journal: WorkflowJournalLine[] = [
      { ts: "2026-01-01T00:00:00.000Z", runId, kind: "log", source: "script", message: "compare candidates" },
      { ts: "2026-01-01T00:00:01.000Z", runId, kind: "log", source: "runtime", message: "[workflow:exit]" },
      { ts: "2026-01-01T00:00:02.000Z", runId, kind: "log", message: "old journal line" },
      { ts: "2026-01-01T00:00:03.000Z", runId, kind: "agent_start", agent: "reviewer", label: "check" },
      {
        ts: "2026-01-01T00:00:04.000Z",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "check",
        status: "completed",
      },
      {
        ts: "2026-01-01T00:00:06.000Z",
        runId,
        kind: "error",
        label: "classify",
        message: "Workflow agent bridge: request auth failed: No API key found",
      },
    ];
    try {
      writeFileSync(
        workflowJournalFile(runDir),
        journal.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({
          runId,
          ok: true,
          result: { summary: "match=true", rawEvidence: { first: 55, second: 55 } },
          journal,
          target: { kind: "name", ref: "detail", source: "project" },
          scriptIdentity: {
            sourcePath: path.join(root, ".locus-pi", "workflows", "detail.workflow.mjs"),
            snapshotPath: path.join(workflowRunRuntimeDir(runDir), `script-${"a".repeat(64)}.workflow.mjs`),
            scriptSha256: "a".repeat(64),
          },
        }),
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);

      await harness.commands.get("workflows")!.handler(`status ${runId}`, harness.ctx);

      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 60, columns: 220 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      const text = component.render(220).join("\n");
      expect(text).toContain(`[R] [P] ${runId}`);
      expect(text).toContain("Source: [R] [P]");
      expect(text).toContain(`runDir: ${runDir}`);
      expect(text).toContain(
        `script: detail · coverage=entry-only-legacy · exec=source · unbound=unknown · snapshot=script-${"a".repeat(64)}.workflow.mjs · sha256=${"a".repeat(12)} · node=unknown`,
      );
      expect(text).not.toContain("/private/source/detail.workflow.mjs");
      expect(text).toContain("[script] compare candidates");
      expect(text).toContain("[runtime] [workflow:exit]");
      expect(text).toContain("[journal] old journal line");
      expect(text).toContain("[agent] -> reviewer (check)");
      expect(text).toContain("[agent] <- reviewer completed");
      expect(text).toContain("[error] Workflow agent bridge: request auth failed: No API key found");
      expect(text).toContain('"rawEvidence"');
      expect(text).not.toContain("[log]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps agent transport markers out of main status while retaining warnings and errors", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    delete harness.ctx.ui.custom;
    workflowsExt(harness.pi);
    const runId = "20260101-000001-marker";
    const journal: WorkflowJournalLine[] = [
      { ts: "2026-01-01T00:00:00.000Z", runId, kind: "agent_start", agent: "reviewer", label: "check" },
      {
        ts: "2026-01-01T00:00:01.000Z",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "check",
        status: "completed",
        evidenceWarnings: ["weak proof"],
      },
      { ts: "2026-01-01T00:00:02.000Z", runId, kind: "error", message: "boom" },
    ];
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (options) => {
      options.onRunStart?.({ runId, runDir: `/tmp/${runId}` });
      for (const entry of journal) options.onEvent?.(entry);
      return {
        runId,
        runDir: `/tmp/${runId}`,
        ok: false,
        result: null,
        error: "boom",
        journal,
        resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
      };
    });
    try {
      await harness.commands.get("workflows")!.handler("run live-smoke", harness.ctx);
      await waitUntil(() =>
        harness.sentMessages.some(
          (entry) => (entry.message.details as { eventKind?: string } | undefined)?.eventKind === "workflow_end",
        ),
      );

      const mainStatuses = [...harness.statuses.values()].join("\n");
      expect(mainStatuses).not.toContain("[agent] ->");
      expect(mainStatuses).not.toContain("[agent] <-");
      expect(mainStatuses).toContain("[error] boom");
      const persisted = harness.sentMessages.map((entry) => String(entry.message.content));
      expect(persisted).toHaveLength(2);
      // One row per agent: the finished row replaced the started row in place.
      expect(persisted[1]).toContain("✓ agent ");
      expect(persisted[1]).not.toContain("● agent ");
      expect(harness.notifications).toContain("⚠ agent evidence · weak proof");
      expect(harness.notificationEvents).toContainEqual({ message: "⚠ agent evidence · weak proof", level: "warning" });
      expect(persisted.filter((message) => message.includes("boom"))).toEqual([
        expect.stringContaining("✗ workflow live-smoke failed · boom"),
      ]);
      const finalFailure = harness.sentMessages.find((entry) => String(entry.message.content).includes("boom"));
      expect(finalFailure?.message.details).toMatchObject({ eventKind: "workflow_end", runId });
    } finally {
      spy.mockRestore();
      agentLiveStore.reset();
    }
  });

  it("renders recent, project, personal, and packaged catalog groups in stable order", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const projectDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, "alpha.workflow.mjs"),
        "export const meta = { description: 'Handles alpha invoices' }; export default () => 'alpha';\n",
        "utf8",
      );
      writeFileSync(
        path.join(projectDir, "beta.workflow.mjs"),
        "export const meta = { description: 'Reviews beta releases' }; export default () => 'beta';\n",
        "utf8",
      );
      const runId = "20260101-000001-alpha";
      const runDir = ensureWorkflowRunDir(root, runId);
      writeFileSync(workflowJournalFile(runDir), "", "utf8");
      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({ runId, ok: true, result: "alpha", target: { kind: "name", ref: "alpha", source: "project" } }),
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);

      await harness.commands.get("workflows")!.handler("list", harness.ctx);
      const text = renderHarnessWidget(harness);

      expect(text).toContain("[VIEW] Workflow catalog");
      expect(text.indexOf("[R] Run history:")).toBeLessThan(text.indexOf("[P] Project:"));
      expect(text.indexOf("[P] Project:")).toBeLessThan(text.indexOf("[U] User:"));
      expect(text.indexOf("[U] User:")).toBeLessThan(text.indexOf("[PKG] Package:"));
      expect(text).toContain("alpha · run 20260101-000001-alpha · [P] · historical run snapshot");
      expect(text).toContain("alpha · [P] · Handles alpha invoices");
      expect(text).toContain("beta · [P] · Reviews beta releases");
      expect(text).toContain("live-smoke · [PKG] ·");
      expect(text).toContain("[U] User:");
      expect(text).toContain("(none found)");
      expect(text.match(/Sources: \[P\]/gu)).toHaveLength(1);
      expect(harness.widgetOptions.get("workflows")).toEqual({ placement: "belowEditor" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters /workflows list by name and description and reports no-match separately from an empty catalog", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-filter-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const projectDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, "alpha.workflow.mjs"),
        "export const meta = { description: 'Handles alpha invoices' }; export default () => 'alpha';\n",
        "utf8",
      );
      writeFileSync(
        path.join(projectDir, "beta.workflow.mjs"),
        "export const meta = { description: 'Reviews beta releases' }; export default () => 'beta';\n",
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      await handler("list invoices", harness.ctx);
      const filtered = renderHarnessWidget(harness);
      expect(filtered).toContain("alpha · [P] · Handles alpha invoices");
      expect(filtered).not.toContain("beta · [P]");

      await handler("list definitely-no-match", harness.ctx);
      const noMatch = renderHarnessWidget(harness);
      expect(noMatch).toContain('No workflows match "definitely-no-match".');
      expect(noMatch).toMatch(/Catalog contains \d+ top-level workflow\(s\) · \d+ child workflow\(s\)/u);
      expect(noMatch).not.toContain("Workflow catalog:\n  (none)");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps workflow catalog, history, and detail controls inside the RPC string-array budget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-static-rpc-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      for (let index = 0; index < 6; index += 1) {
        writeFileSync(
          path.join(workflowDir, `project-${index}.workflow.mjs`),
          `export const meta = { description: "Project workflow ${index}" }; export default () => null;\n`,
          "utf8",
        );
        writeWorkflowRun(root, `20260101-00000${index}-rpc`);
      }
      const longRunDir = path.join(root, ".locus-pi", "runs", "20260101-000005-rpc");
      writeFileSync(
        workflowJournalFile(longRunDir),
        `${JSON.stringify({
          ts: "2026-01-01T00:00:02.000Z",
          runId: "20260101-000005-rpc",
          kind: "log",
          source: "script",
          message: `long diagnostic ${"x".repeat(240)}`,
        })}\n`,
        "utf8",
      );
      const harness = createHarness(root, { mode: "rpc" });
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      for (const [command, expectedControl] of [
        ["list", "Run: /workflows run <name|path>"],
        ["status", "Detail: /workflows status <runId>"],
        ["status 20260101-000005-rpc", "Full artifact: result.json"],
      ] as const) {
        await handler(command, harness.ctx);
        expect(Array.isArray(harness.widgetPayloads.get("workflows"))).toBe(true);
        const text = harness.widgets.get("workflows") ?? "";
        expect(text).toContain(expectedControl);
        expect(text).not.toContain("widget truncated");
        expect(text.split(/\r?\n/u).length).toBeLessThanOrEqual(10);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("status self-bounds many historical runs for an 80x24 widget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-status-many-"));
    try {
      for (let i = 0; i < 25; i += 1) {
        writeWorkflowRun(root, `20260101-0000${String(i).padStart(2, "0")}-${String(i).padStart(4, "0")}`);
      }
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      await handler("status", harness.ctx);

      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      const rendered = component.render(80);
      const text = rendered.join("\n");
      const runRows = rendered.filter((renderedLine) => /\[R\].*failed.*20260101-/u.test(renderedLine));

      expect(rendered.length).toBeLessThanOrEqual(24 - 6);
      expect(runRows.length).toBeGreaterThan(0);
      expect(runRows.length).toBeLessThan(20);
      expect(rendered.every((renderedLine) => renderedLine.length <= 80)).toBe(true);
      expect(text).toContain("[VIEW]");
      expect(text).toContain("Showing 10 newest of 25 workflow run(s).");
      expect(text).toContain("Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history");
      expect(text).toContain("+15 older run(s) hidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
