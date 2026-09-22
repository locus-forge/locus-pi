import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearViewerExternalRows,
  setViewerExternalRows,
} from "../../../../extensions/_shared/operator/viewer-geometry.js";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { readWorkflowRunJournalState } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  workflowJournalFile,
  workflowRunArtifactsDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import workflows from "../../../../extensions/workflows/index.js";
import { WorkflowRunViewer } from "../../../../extensions/workflows/run/run-viewer.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  clearViewerExternalRows("test-workflow-run");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow persisted evidence viewer", () => {
  it("reserves the active workflow widget beneath the focused run viewer", () => {
    const root = makeRoot();
    for (let index = 0; index < 25; index += 1) {
      writeJournal(root, `20260722-0101${String(index).padStart(2, "0")}-ab12`, []);
    }
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } },
      {},
      {},
      root,
      vi.fn(),
    );

    expect(viewer.render(80)).toHaveLength(24 - 3);
    setViewerExternalRows("test-workflow-run", 2);
    expect(viewer.render(80)).toHaveLength(24 - 3 - 2);
  });

  it("stops the run list at its own content instead of padding the terminal", () => {
    const root = makeRoot();
    writeJournal(root, "20260722-010101-ab12", []);
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } },
      {},
      {},
      root,
      vi.fn(),
    );

    const lines = viewer.render(80);
    expect(lines).toHaveLength(4);
    expect(lines).not.toContain(" ".repeat(80));
  });

  it("navigates runs to stages, distinct repeated calls, and readable Markdown/JSON evidence", () => {
    const root = makeRoot();
    const runId = "20260722-010101-ab12";
    createEvidenceRun(root, runId, [
      { callId: "call-0002", name: "second.md", answer: "## Second answer\n\nDone." },
      { callId: "call-0001", name: "first.md", answer: "## First answer\n\nPlanned." },
    ]);
    const done = vi.fn();
    const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } };
    const viewer = new WorkflowRunViewer(tui, {}, {}, root, done);

    expect(viewer.render(80).join("\n")).toContain(runId);
    viewer.handleInput("enter");
    expect(viewer.screenKind).toBe("stages");
    expect(viewer.render(80).join("\n")).toContain("plan · 7 evidence item(s)");
    viewer.handleInput("enter");
    const evidence = viewer.render(100).join("\n");
    expect(evidence.indexOf("call-0001")).toBeLessThan(evidence.indexOf("call-0002"));
    expect(evidence).toContain("answer · call-0001 · first.md");
    expect(evidence).toContain("transcript · call-0001");
    expect(evidence).toContain("result · call-0001");
    expect(evidence).toContain("log · 5 journal event(s)");

    viewer.handleInput("enter");
    const markdown = viewer.render(100).join("\n");
    expect(markdown).toContain("First answer");
    expect(markdown).not.toContain('{\\"answer\\"');
    viewer.handleInput("escape");
    viewer.handleInput("down");
    viewer.handleInput("enter");
    const transcript = viewer.render(100).join("\n");
    expect(transcript).toContain('"type": "session"');
    expect(transcript).toContain('"id": "child-call-0001"');
  });

  it("refuses tampered evidence instead of rendering changed bytes", () => {
    const root = makeRoot();
    const runId = "20260722-010102-ab12";
    createEvidenceRun(root, runId, [{ callId: "call-0001", name: "answer.md", answer: "trusted answer" }]);
    const index = JSON.parse(
      readFileSync(
        path.join(workflowRunArtifactsDir(path.join(root, ".locus-pi", "runs", runId)), "index.json"),
        "utf8",
      ),
    ) as { artifacts: Array<{ kind: string; relativePath: string }> };
    const answer = index.artifacts.find((record) => record.kind === "answer")!;
    writeFileSync(
      path.join(workflowRunArtifactsDir(path.join(root, ".locus-pi", "runs", runId)), answer.relativePath),
      "changed after indexing",
      "utf8",
    );
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 80 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );

    viewer.handleInput("enter");
    viewer.handleInput("enter");
    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("digest mismatch");
    expect(rendered).not.toContain("changed after indexing");
  });

  it("renders indexed operator answers through the digest-verifying JSON reader", () => {
    const root = makeRoot();
    const runId = "20260722-010109-ab12";
    const runDir = writeJournal(root, runId, []);
    const store = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
    store.recordOperatorAskEvidence("call-0001", "tool-call-7", 1, {
      tool: "workflow_ask",
      toolCallId: "tool-call-7",
      declined: false,
      entries: [
        {
          id: "storage",
          question: "Which storage?",
          status: "answered",
          answer: "sqlite",
          kind: "option",
        },
      ],
    });
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 100 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );

    expect(viewer.render(100).join("\n")).toContain("run · 1 evidence item(s)");
    viewer.handleInput("enter");
    expect(viewer.render(100).join("\n")).toContain("operator-ask · call-0001 · operator-ask-0001.json");
    viewer.handleInput("enter");
    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain('"question": "Which storage?"');
    expect(rendered).toContain('"answer": "sqlite"');
  });

  it.each([
    { label: "identity-only", metadata: { workspacePhysicalIdentity: "workspace" } },
    { label: "schema-only", metadata: { workspacePhysicalIdentitySchemaVersion: 1 } },
    { label: "unsupported-schema", metadata: { workspacePhysicalIdentitySchemaVersion: 2 } },
    {
      label: "unsafe-identity",
      metadata: { workspacePhysicalIdentity: "../escape", workspacePhysicalIdentitySchemaVersion: 1 },
    },
  ])("surfaces malformed physical workspace metadata as unknown viewer evidence ($label)", ({ label, metadata }) => {
    const root = makeRoot();
    const runId = `20260722-010101-${label}`;
    createEvidenceRun(root, runId, [{ callId: "call-0001", name: "answer.md", answer: "answer" }]);
    const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", runId));
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    Object.assign(result, metadata);
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");

    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 100 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );
    const stages = viewer.render(100).join("\n");
    expect(stages).toContain(`${runId} · unknown · stages`);
    viewer.handleInput("enter");
    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain("Malformed persisted metadata");
    expect(rendered).toContain("workspace physical identity is malformed");
  });

  it("refuses evidence whose semantic artifact record changed after the run screen opened", () => {
    const root = makeRoot();
    const runId = "20260722-010107-ab12";
    createEvidenceRun(root, runId, [{ callId: "call-0001", name: "answer.md", answer: "stable bytes" }]);
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 80 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );
    viewer.handleInput("enter");

    const indexPath = path.join(workflowRunArtifactsDir(path.join(root, ".locus-pi", "runs", runId)), "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      artifacts: Array<{ kind: string; name: string }>;
    };
    index.artifacts.find((record) => record.kind === "answer")!.name = "renamed.md";
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    viewer.handleInput("enter");
    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("index changed while this evidence view was open");
    expect(rendered).not.toContain("stable bytes");
  });

  it("reports JSON and structural journal corruption and never sends malformed phase data to the viewer", async () => {
    const root = makeRoot();
    const runId = "20260722-010108-ab12";
    const runDir = writeJournal(root, runId, [journal(runId, "phase", { phase: "inspect" })]);
    writeFileSync(
      workflowJournalFile(runDir),
      [
        JSON.stringify(journal(runId, "phase", { phase: "inspect" })),
        "{not-json",
        JSON.stringify(journal(runId, "phase", { phase: 42 })),
        JSON.stringify({ ts: "2026-07-22T01:01:01.000Z", runId, kind: "unknown" }),
        JSON.stringify({ ts: "2026-07-22T01:01:02.000Z", runId, kind: "agent_end" }),
        JSON.stringify({ ts: "2026-07-22T01:01:03.000Z", runId, kind: "log", message: "ok", agent: "forged" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const state = readWorkflowRunJournalState(root, runId);
    expect(state.lines).toHaveLength(1);
    expect(state.diagnostics).toEqual([
      { kind: "json", lineNumber: 2, message: "Invalid JSON." },
      { kind: "structure", lineNumber: 3, message: "Field phase must be string." },
      { kind: "structure", lineNumber: 4, message: "Field kind is not a supported workflow journal event." },
      { kind: "structure", lineNumber: 5, message: "Field status is required for agent_end events." },
      { kind: "structure", lineNumber: 6, message: "Field agent is not allowed for log events." },
    ]);

    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 100 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );
    expect(() => viewer.render(100)).not.toThrow();
    expect(viewer.render(100).join("\n")).toContain("journal corruption (5)");
    viewer.handleInput("enter");
    viewer.handleInput("enter");
    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain("Journal corruption detected: 5");
    expect(rendered).toContain("line 3: Field phase must be string.");

    const rpc = createHarness(root, { mode: "rpc" });
    workflows(rpc.pi);
    await rpc.commands.get("workflows")!.handler(`status ${runId}`, rpc.ctx);
    const staticDetail = rpc.widgets.get("workflows") ?? "";
    expect(staticDetail).toContain("journal corruption: 5 row(s); first=line 2: Invalid JSON.");
    expect(staticDetail.split(/\r?\n/u).length).toBeLessThanOrEqual(10);
  });

  it("renders the verified source-to-current continuation binding as readable log evidence", () => {
    const root = makeRoot();
    const runId = "20260722-010110-ab12";
    const sourceRef = {
      runId: "source-run",
      artifactId: "published-0001",
      name: "intent.md",
      sha256: "a".repeat(64),
    };
    const consumedRef = { ...sourceRef, runId, artifactId: "input-0001" };
    writeJournal(root, runId, [
      {
        ts: "2026-07-22T01:01:01.000Z",
        runId,
        kind: "log",
        source: "runtime",
        message: "[workflow:continuation]",
        continuation: {
          originRunId: "source-run",
          artifacts: [{ sourceRef, consumedRef }],
        },
      },
    ]);
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 120 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );

    viewer.handleInput("enter");
    viewer.handleInput("enter");
    const rendered = viewer.render(120).join("\n");
    expect(rendered).toContain("[workflow:continuation]");
    expect(rendered).toContain("continuation=source-run");
    expect(rendered).toContain("intent.md:published-0001->input-0001");
  });

  it("makes missing and malformed indexes explicit without crashing", () => {
    for (const malformed of [false, true]) {
      const root = makeRoot();
      const runId = malformed ? "20260722-010104-ab12" : "20260722-010103-ab12";
      const runDir = writeJournal(root, runId, [journal(runId, "phase", { phase: "inspect" })]);
      if (malformed) {
        const artifactsDir = workflowRunArtifactsDir(runDir);
        mkdirSync(artifactsDir, { recursive: true });
        writeFileSync(path.join(artifactsDir, "index.json"), "{not-json", "utf8");
      }
      const viewer = new WorkflowRunViewer(
        { requestRender: vi.fn(), terminal: { rows: 20, columns: 80 } },
        {},
        {},
        root,
        vi.fn(),
        runId,
      );
      viewer.handleInput("enter");
      viewer.handleInput("down");
      viewer.handleInput("enter");
      const rendered = viewer.render(80).join("\n");
      expect(rendered).toMatch(malformed ? /index is corrupt/iu : /index is missing/iu);
    }
  });

  it("keeps every screen bounded in a narrow terminal and Esc returns one level", () => {
    const root = makeRoot();
    const runId = "20260722-010105-ab12";
    createEvidenceRun(root, runId, [{ callId: "call-0001", name: "wide.md", answer: "x".repeat(400) }]);
    const done = vi.fn();
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 8, columns: 24 } },
      {},
      {},
      root,
      done,
    );

    for (const input of ["enter", "enter", "enter"]) {
      viewer.handleInput(input);
      const lines = viewer.render(24);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    }
    expect(viewer.screenKind).toBe("content");
    viewer.handleInput("escape");
    expect(viewer.screenKind).toBe("evidence");
    viewer.handleInput("escape");
    expect(viewer.screenKind).toBe("stages");
    viewer.handleInput("escape");
    expect(viewer.screenKind).toBe("runs");
    viewer.handleInput("escape");
    expect(done).toHaveBeenCalledOnce();
  });

  it("routes dashboard and status through custom UI while RPC keeps bounded static output", async () => {
    const root = makeRoot();
    const runId = "20260722-010106-ab12";
    createEvidenceRun(root, runId, [{ callId: "call-0001", name: "answer.md", answer: "answer" }]);

    for (const [command, inputs] of [
      ["dashboard", ["escape"]],
      ["status", ["escape"]],
      [`status ${runId}`, ["escape", "escape"]],
    ] as const) {
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      harness.customInputQueue.push(...inputs);
      workflows(harness.pi);
      await harness.commands.get("workflows")!.handler(command, harness.ctx);
      expect(harness.customComponents).toHaveLength(1);
      expect(harness.customRenderFrames.some((frame) => frame.join("\n").includes(runId))).toBe(true);
    }

    const rpc = createHarness(root, { mode: "rpc" });
    rpc.ctx.hasUI = true;
    workflows(rpc.pi);
    for (const command of ["dashboard", "status", `status ${runId}`]) {
      await rpc.commands.get("workflows")!.handler(command, rpc.ctx);
      const lines = (rpc.widgetPayloads.get("workflows") as string[]) ?? [];
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(10);
    }
  });

  it("falls back immediately to bounded static status when custom UI fails", async () => {
    const root = makeRoot();
    const runId = "20260722-010109-ab12";
    createEvidenceRun(root, runId, [{ callId: "call-0001", name: "answer.md", answer: "answer" }]);

    for (const command of ["dashboard", "status", `status ${runId}`]) {
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      harness.ctx.ui.custom = (async () => {
        throw new Error("custom renderer failed");
      }) as NonNullable<typeof harness.ctx.ui.custom>;
      workflows(harness.pi);

      await harness.commands.get("workflows")!.handler(command, harness.ctx);

      const rendered = harness.widgets.get("workflows") ?? "";
      expect(rendered).toContain("[VIEW] Workflow run");
      expect(rendered).toContain("Interactive evidence viewer failed: custom renderer failed");
      expect(rendered).toContain(runId);
      expect(rendered).not.toContain("Recovery: /workflows status");
      expect(rendered.split(/\r?\n/u).length).toBeLessThanOrEqual(24);
    }
  });

  it("refuses malformed direct initial run ids through the shared run-id contract", () => {
    for (const runId of ["../outside", "bad/id", "запуск", "a".repeat(129)]) {
      const viewer = new WorkflowRunViewer(
        { requestRender: vi.fn(), terminal: { rows: 20, columns: 160 } },
        {},
        {},
        makeRoot(),
        vi.fn(),
        runId,
      );

      expect(viewer.screenKind, runId).toBe("stages");
      expect(() => viewer.render(160), runId).not.toThrow();
      viewer.handleInput("enter");
      expect(viewer.render(160).join("\n"), runId).toContain("Run id refused before filesystem access.");
    }
  });

  it("accepts canonical run ids containing adjacent dots", () => {
    const root = makeRoot();
    const runId = "run..valid";
    writeJournal(root, runId, [journal(runId, "phase", { phase: "inspect" })]);
    const viewer = new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 100 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );

    viewer.handleInput("enter");
    const rendered = viewer.render(100).join("\n");
    expect(rendered).not.toContain("Invalid workflow run id");
    expect(rendered).toContain("artifact index is missing");
  });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-viewer-"));
  roots.push(root);
  return root;
}

function createEvidenceRun(
  root: string,
  runId: string,
  calls: Array<{ callId: string; name: string; answer: string }>,
): void {
  const lines = [journal(runId, "phase", { phase: "plan" })];
  for (const call of calls) {
    lines.push(journal(runId, "agent_start", { phase: "plan", callId: call.callId, agent: "planner" }));
    lines.push(
      journal(runId, "agent_end", { phase: "plan", callId: call.callId, agent: "planner", status: "completed" }),
    );
  }
  const runDir = writeJournal(root, runId, lines);
  const store = createWorkflowArtifactStore({
    projectRoot: root,
    runId,
    runDir,
    now: () => "2026-07-22T01:01:01.000Z",
  });
  for (const call of calls) {
    const destinations = store.childEvidenceDestinations(call.callId);
    const transcript = path.join(destinations.transcriptDir, "session.jsonl");
    const result = path.join(destinations.resultArtifactsDir, "result.json");
    mkdirSync(destinations.transcriptDir, { recursive: true });
    mkdirSync(destinations.resultArtifactsDir, { recursive: true });
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "session", id: `child-${call.callId}` })}\n${JSON.stringify({ type: "message", role: "assistant", text: call.answer })}\n`,
      "utf8",
    );
    writeFileSync(result, `${JSON.stringify({ ok: true, answer: call.answer })}\n`, "utf8");
    store.recordAgentEvidence({
      callId: call.callId,
      name: call.name,
      stage: "plan",
      text: call.answer,
      replayed: false,
      childSessionId: `child-${call.callId}`,
      childTracePath: transcript,
      resultArtifactPath: result,
    });
  }
}

function writeJournal(root: string, runId: string, lines: Array<Record<string, unknown>>): string {
  const runDir = ensureWorkflowRunDir(root, runId);
  writeFileSync(workflowJournalFile(runDir), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  writeFileSync(workflowResultFile(runDir), `${JSON.stringify({ runId, ok: true, result: "done" })}\n`, "utf8");
  return runDir;
}

function journal(
  runId: string,
  kind: "phase" | "agent_start" | "agent_end",
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ts: "2026-07-22T01:01:01.000Z", runId, kind, ...extra };
}
