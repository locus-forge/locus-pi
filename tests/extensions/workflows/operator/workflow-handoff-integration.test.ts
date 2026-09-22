import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindWorkflowHandoffClaim,
  createWorkflowOperatorHandoffEnvelope,
  readCurrentWorkflowScriptIdentity,
} from "../../../../extensions/workflows/runtime/workflow-handoff.js";
import type { CustomUiFactory } from "../../../../extensions/_shared/host/pi-api.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowTarget } from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowRunRuntimeDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness, emit } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithHandoff(runId: string, existingRoot?: string): string {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), "workflow-handoff-integration-"));
  if (existingRoot === undefined) roots.push(root);
  const workflowsDir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  const sourcePath = path.join(workflowsDir, "alpha.workflow.mjs");
  writeFileSync(
    sourcePath,
    'export const meta={name:"alpha",description:"Alpha"}; export default async()=>({ok:true});\n',
    "utf8",
  );
  const target = resolveWorkflowTarget({ script: "alpha" }, root, root);
  const currentIdentity = readCurrentWorkflowScriptIdentity(target.path);
  const runDir = ensureWorkflowRunDir(root, runId);
  const snapshotPath = path.join(workflowRunRuntimeDir(runDir), `script-${currentIdentity.scriptSha256}.workflow.mjs`);
  writeFileSync(snapshotPath, readFileSync(target.path));
  const scriptIdentity = {
    ...currentIdentity,
    sourcePath: target.path,
    snapshotPath,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinImports: [],
    unboundDependencies: [],
  };
  const artifactRef = {
    runId,
    artifactId: "intent",
    name: "intent.md",
    sha256: "0".repeat(64),
  };
  const operatorHandoff = createWorkflowOperatorHandoffEnvelope({
    declaration: {
      title: "Review clarification",
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose review scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
          recommended: "Current changes",
          allowCustom: true,
        },
      ],
      continuationArtifactRefs: [artifactRef],
    },
    runId,
    target,
    scriptIdentity,
    terminalArtifactRefs: [artifactRef],
  });
  const workspaceDir = path.join(root, "handoff-workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    workflowResultFile(runDir),
    `${JSON.stringify({
      runId,
      ok: true,
      result: { mode: "prepared" },
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
      journal: [],
      resultPersistence: { ok: true, path: workflowResultFile(runDir) },
      workspaceDir,
      workspaceDirRelative: "handoff-workspace",
      workspaceDirExplicit: true,
      target,
      scriptIdentity,
      artifactRefs: [artifactRef],
      operatorHandoff,
    })}\n`,
    "utf8",
  );
  return root;
}

function corruptPersistedHandoff(root: string, runId: string): void {
  const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", runId));
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  result.operatorHandoff = { ...(result.operatorHandoff as Record<string, unknown>), title: 42 };
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}

function persistCompletedChild(root: string, runId: string): void {
  const runDir = ensureWorkflowRunDir(root, runId);
  writeFileSync(
    workflowResultFile(runDir),
    `${JSON.stringify({
      runId,
      ok: true,
      result: { summary: "continued" },
      disposition: { status: "completed" },
      journal: [],
      resultPersistence: { ok: true, path: workflowResultFile(runDir) },
    })}\n`,
    "utf8",
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Promise.resolve();
}

async function flushBackground(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
}

function completedResult(runId: string): runner.RunWorkflowScriptResult {
  return {
    runId,
    runDir: `/tmp/${runId}`,
    ok: true,
    result: { summary: "continued" },
    disposition: { status: "completed" },
    journal: [],
    resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
  };
}

/**
 * Report each launch under a run id the test chooses, newest first.
 *
 * The automatic pump only raises questions belonging to runs THIS session
 * launched, so a test that wants one raised has to make the session launch the
 * run whose durable evidence carries it: the first (continuation-less) launch
 * reports `runIds[0]`, and every continuation reports the next id.
 */
function mockRuns(
  requests: runner.RunWorkflowScriptOptions[],
  runIds: string[],
  onLaunch?: (request: runner.RunWorkflowScriptOptions, runId: string) => void,
): void {
  vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
    const runId = runIds[requests.length] ?? `spare-${String(requests.length)}`;
    requests.push(request);
    onLaunch?.(request, runId);
    request.onRunStart?.({ runId, runDir: `/tmp/${runId}` });
    return completedResult(runId);
  });
}

/** The continuations a pumped question launched, without the run that opened it. */
function continuations(requests: runner.RunWorkflowScriptOptions[]): runner.RunWorkflowScriptOptions[] {
  return requests.filter((request) => request.continuation !== undefined);
}

/** Start `alpha` through the ordinary `/workflows run` path, so this session owns the run. */
async function runAlphaInSession(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.commands.get("workflows")!.handler("run alpha", harness.ctx);
}

describe("workflow actionable handoff integration", () => {
  it("claims and launches a continuation for a run this session started, as soon as it settles", async () => {
    const sourceRunId = "20260725-120000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-${Date.now()}` });
    harness.customInputQueue.push("\r");
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, [sourceRunId, "20260725-120100-child"]);

    workflows(harness.pi);
    await emit(harness, "session_start");
    // The split-run gate: a run this session started ends awaiting an operator,
    // and its question opens the moment the run settles — no command needed.
    await runAlphaInSession(harness);
    await waitFor(() => continuations(requests).length === 1);

    expect(continuations(requests)[0]).toMatchObject({
      name: "alpha",
      input: "Current changes",
      continuation: {
        originRunId: sourceRunId,
        artifactRefs: [expect.objectContaining({ name: "intent.md" })],
      },
      operatorHandoffClaim: {
        sourceRunId,
      },
    });
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Question 1 of 1");
    expect(harness.customOptions[0]).toEqual({ overlay: false });
    // The question never reaches the model as a steered turn.
    expect(harness.waitForIdleCalls).toBeGreaterThan(0);
    expect(harness.sentUserMessages).toEqual([]);
  });

  it("starts a session without picking up an unanswered question from an earlier run", async () => {
    const sourceRunId = "20260725-121000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-startup-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, ["20260725-121100-child"]);
    workflows(harness.pi);

    await emit(harness, "session_start");
    await flushBackground();
    expect(harness.customComponents).toEqual([]);
    expect(harness.widgets.get("workflows")).toBeUndefined();
    expect(requests).toEqual([]);

    // Still reachable, but only because the operator asked for it.
    harness.customInputQueue.push("\r");
    await harness.commands.get("workflows")!.handler(`continue ${sourceRunId}`, harness.ctx);
    await waitFor(() => requests.length === 1);
    expect(harness.customComponents).toHaveLength(1);
  });

  it("never pumps a question from a run this session did not launch, and still opens it on request", async () => {
    const sourceRunId = "20260725-121200-foreign";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-foreign-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, ["20260725-121300-child"]);
    workflows(harness.pi);

    await emit(harness, "session_start");
    // The turn after a clean start is where the removed session-start modal used
    // to reappear under another name. The scope, not the trigger, is what stops it.
    await emit(harness, "agent_settled");
    await emit(harness, "agent_settled");
    await flushBackground();
    expect(harness.customComponents).toEqual([]);
    expect(requests).toEqual([]);

    harness.customInputQueue.push("\r");
    await harness.commands.get("workflows")!.handler(`continue ${sourceRunId}`, harness.ctx);
    await waitFor(() => requests.length === 1);
    expect(requests[0]?.continuation?.originRunId).toBe(sourceRunId);
    expect(harness.customComponents).toHaveLength(1);
  });

  it("delivers an escaped question to the workflow as a refusal answer", async () => {
    const sourceRunId = "20260725-121500-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-refusal-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, [sourceRunId, "20260725-121600-child"]);
    workflows(harness.pi);

    harness.customInputQueue.push("\x1b");
    await emit(harness, "session_start");
    await runAlphaInSession(harness);
    await waitFor(() => continuations(requests).length === 1);

    expect(continuations(requests)[0]?.input).toBe(
      [
        "The operator declined to answer this workflow's questions.",
        "",
        "1. Choose review scope",
        "   id: scope",
        "   answer: none — the operator declined",
      ].join("\n"),
    );
    expect(continuations(requests)[0]?.continuation?.originRunId).toBe(sourceRunId);
  });

  it("does not mount a tool-origin question on turn_end and uses the fresh agent_settled context", async () => {
    const sourceRunId = "20260725-122000-source";
    const root = projectWithHandoff(sourceRunId);
    const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", sourceRunId));
    const deferredPath = `${resultPath}.deferred`;
    // Hidden while the run settles, so the terminal pump finds nothing and the
    // question can only arrive through the lifecycle event under test.
    renameSync(resultPath, deferredPath);
    const harness = createHarness(root, { sessionId: `handoff-settled-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, [sourceRunId, "20260725-122100-child"]);
    workflows(harness.pi);
    await emit(harness, "session_start");
    await runAlphaInSession(harness);
    await flushBackground();
    renameSync(deferredPath, resultPath);

    await emit(harness, "turn_end");
    expect(harness.customComponents).toEqual([]);
    expect(continuations(requests)).toEqual([]);

    harness.customInputQueue.push("\r");
    await emit(harness, "agent_settled");
    await waitFor(() => continuations(requests).length === 1);
    expect(harness.customComponents).toHaveLength(1);
  });

  it("continues one explicit answer in JSON mode through the canonical command without interactive UI", async () => {
    const sourceRunId = "20260725-123000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, {
      sessionId: `handoff-json-${Date.now()}`,
      mode: "json",
    });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, ["20260725-123100-child"]);
    workflows(harness.pi);
    await emit(harness, "session_start");
    await flushBackground();

    expect(harness.commands.get("workflows")?.getArgumentCompletions?.(`continue ${sourceRunId} `)).toEqual([
      expect.objectContaining({ value: `continue ${sourceRunId} --answer `, label: "--answer" }),
    ]);
    await harness.commands.get("workflows")!.handler(`continue ${sourceRunId} --answer Last commit`, harness.ctx);
    await waitFor(() => requests.length === 1);

    expect(requests[0]).toMatchObject({
      input: "Last commit",
      continuation: { originRunId: sourceRunId },
    });
    expect(harness.customComponents).toEqual([]);
    expect(harness.selectCalls).toEqual([]);
  });

  it("does not let a never-resolving question starve later lifecycle handlers", async () => {
    const sourceRunId = "20260725-124000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-never-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, [sourceRunId]);
    let mounted = 0;
    harness.ctx.ui.custom = vi.fn(
      async <T>(factory: CustomUiFactory<T>) =>
        await new Promise<T>(async () => {
          await factory({ requestRender() {} }, {}, {}, () => {});
          mounted += 1;
        }),
    ) as NonNullable<typeof harness.ctx.ui.custom>;
    workflows(harness.pi);

    await emit(harness, "session_start");
    await runAlphaInSession(harness);
    await waitFor(() => mounted === 1);
    await emit(harness, "agent_settled");
    await emit(harness, "agent_settled");

    expect(mounted).toBe(1);
    expect(harness.ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected question pump as a warning without rejecting the lifecycle handler", async () => {
    const sourceRunId = "20260725-125000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-reject-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, [sourceRunId]);
    harness.ctx.ui.custom = vi.fn(async () => {
      throw new Error("question mount exploded");
    });
    workflows(harness.pi);

    await emit(harness, "session_start");
    await runAlphaInSession(harness);
    await waitFor(() => (harness.widgets.get("workflows") ?? "").includes("question mount exploded"));
    // A later lifecycle event still settles normally rather than rejecting.
    await expect(emit(harness, "agent_settled")).resolves.toEqual([undefined]);

    expect(harness.widgets.get("workflows")).toContain("question mount exploded");
    expect(harness.widgets.get("workflows")).toContain("No workflow execution was started.");
  });

  it("pumps the next handoff when a continuation is itself a run that ends awaiting an operator", async () => {
    const firstRunId = "20260725-130000-first";
    const secondRunId = "20260725-131000-second";
    const root = projectWithHandoff(firstRunId);
    projectWithHandoff(secondRunId, root);
    const harness = createHarness(root, { sessionId: `handoff-fifo-${Date.now()}` });
    harness.customInputQueue.push("\r", "\r");
    const requests: runner.RunWorkflowScriptOptions[] = [];
    // The split-run chain, all inside one session: run one asks, its continuation
    // IS run two, and run two asks again. Both are this session's, so both pump.
    mockRuns(requests, [firstRunId, secondRunId, "20260725-132000-child"], (request, runId) => {
      if (request.operatorHandoffClaim === undefined) return;
      bindWorkflowHandoffClaim(request.operatorHandoffClaim, runId);
      if (runId !== secondRunId) persistCompletedChild(root, runId);
    });
    workflows(harness.pi);

    await emit(harness, "session_start");
    await runAlphaInSession(harness);
    await waitFor(() => continuations(requests).length === 2);

    expect(continuations(requests).map((request) => request.continuation?.originRunId)).toEqual([
      firstRunId,
      secondRunId,
    ]);
    expect(harness.customComponents).toHaveLength(2);
  });

  it("reports a malformed durable handoff instead of showing the no-attention home", async () => {
    const runId = "20260725-133000-malformed";
    const root = projectWithHandoff(runId);
    corruptPersistedHandoff(root, runId);
    const harness = createHarness(root, { sessionId: `handoff-malformed-${Date.now()}` });
    workflows(harness.pi);

    await emit(harness, "session_start");
    // Unreadable evidence from a run this session never launched is not raised on
    // its own; an explicit continuation path is where the operator asks and is told.
    await emit(harness, "agent_settled");
    await flushBackground();
    expect(harness.widgets.get("workflows")).toBeUndefined();

    await harness.commands.get("workflows")!.handler(`continue ${runId}`, harness.ctx);
    await waitFor(() => (harness.widgets.get("workflows") ?? "").includes("operatorHandoff title"));

    expect(harness.widgets.get("workflows")).toContain("operatorHandoff title");
    expect(harness.widgets.get("workflows")).not.toContain("No workflow needs an answer");
    expect(harness.commands.get("workflows")?.getArgumentCompletions?.("continue 20260725")).toEqual([]);
  });

  it("lets a valid actionable handoff win over malformed historical evidence", async () => {
    const malformedRunId = "20260725-134000-malformed";
    const actionableRunId = "20260725-135000-actionable";
    const root = projectWithHandoff(malformedRunId);
    corruptPersistedHandoff(root, malformedRunId);
    projectWithHandoff(actionableRunId, root);
    const harness = createHarness(root, { sessionId: `handoff-valid-wins-${Date.now()}` });
    harness.customInputQueue.push("\r");
    const requests: runner.RunWorkflowScriptOptions[] = [];
    mockRuns(requests, ["20260725-135100-child"]);
    workflows(harness.pi);
    await harness.commands.get("workflows")!.handler("unexpected", harness.ctx);
    expect(harness.commands.get("workflows")?.getArgumentCompletions?.("continue 20260725")).toEqual([
      expect.objectContaining({ value: `continue ${actionableRunId}` }),
    ]);

    await harness.commands.get("workflows")!.handler(`continue ${actionableRunId}`, harness.ctx);
    await waitFor(() => requests.length === 1);

    expect(requests[0]?.continuation?.originRunId).toBe(actionableRunId);
    expect(harness.customComponents).toHaveLength(1);
  });
});
