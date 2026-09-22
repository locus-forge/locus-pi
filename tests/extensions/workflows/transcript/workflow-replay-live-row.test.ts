import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  createWorkflowArtifactStore,
  readWorkflowArtifactRecord,
  type WorkflowArtifactRef,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  resetWorkflowLiveExecutions,
  workflowAgentLiveRowId,
  workflowLiveExecutionCount,
} from "../../../../extensions/workflows/runtime/workflow-live.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { workflowRunArtifactsDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  resetWorkflowLiveExecutions();
  agentLiveStore.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow replay live-row answer hydration", () => {
  it("hydrates a command replay in the event adapter before passive projection", async () => {
    const fixture = replayFixture("Verified replay answer.");
    const harness = createHarness(fixture.root);
    harness.ctx.hasUI = true;
    workflows(harness.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: fixture.runId, runDir: fixture.runDir });
      request.onEvent?.(fixture.start);
      request.onEvent?.(fixture.end);
      return {
        runId: fixture.runId,
        runDir: fixture.runDir,
        ok: true,
        result: { summary: "replayed" },
        journal: [fixture.start, fixture.end],
        resultPersistence: { ok: true, path: workflowResultFile(fixture.runDir) },
      };
    });
    try {
      await harness.commands.get("workflows")!.handler("run task/plan", harness.ctx);
      for (
        let attempt = 0;
        attempt < 50 && agentLiveStore.rows.get(workflowAgentLiveRowId(fixture.end))?.finalAnswer === undefined;
        attempt += 1
      ) {
        await Promise.resolve();
      }

      expect(agentLiveStore.rows.get(workflowAgentLiveRowId(fixture.end))).toMatchObject({
        status: "done",
        finalAnswer: "Verified replay answer.",
        resultArtifact: `workflow-artifact:${fixture.runId}/${fixture.ref.artifactId}#sha256=${fixture.ref.sha256}`,
        errors: [],
      });
      expect(workflowLiveExecutionCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports missing and tampered replay evidence without fabricating output", () => {
    const missing = replayLines("missing-run");
    applyWorkflowJournalLineToAgentLiveStore(missing.start);
    applyWorkflowJournalLineToAgentLiveStore(missing.end, temporaryProject());
    const missingRow = agentLiveStore.rows.get(workflowAgentLiveRowId(missing.end));
    expect(missingRow?.finalAnswer).toBeUndefined();
    expect(missingRow?.errors).toContain("Replayed answer artifact is missing from the workflow journal.");
    expect(workflowLiveExecutionCount()).toBe(0);

    agentLiveStore.reset();
    const tampered = replayFixture("Original answer.");
    const read = readWorkflowArtifactRecord(tampered.root, tampered.runId, tampered.ref.artifactId);
    if (read.status !== "ready") throw new Error(read.message);
    writeFileSync(
      path.join(workflowRunArtifactsDir(tampered.runDir), read.record.relativePath),
      "Tampered answer.",
      "utf8",
    );
    applyWorkflowJournalLineToAgentLiveStore(tampered.start);
    applyWorkflowJournalLineToAgentLiveStore(tampered.end, tampered.root);
    const tamperedRow = agentLiveStore.rows.get(workflowAgentLiveRowId(tampered.end));
    expect(tamperedRow?.finalAnswer).toBeUndefined();
    expect(tamperedRow?.errors.join("\n")).toContain("Replayed answer artifact is tampered");
    expect(workflowLiveExecutionCount()).toBe(0);
  });

  it("reports unavailable replay verification context before exact terminal finalization", () => {
    const fixture = replayFixture("Unverified without a project root.");
    applyWorkflowJournalLineToAgentLiveStore(fixture.start);
    applyWorkflowJournalLineToAgentLiveStore(fixture.end);

    expect(agentLiveStore.rows.get(workflowAgentLiveRowId(fixture.end))).toMatchObject({
      status: "done",
      errors: ["Replayed answer verification context is unavailable."],
    });
    expect(agentLiveStore.rows.get(workflowAgentLiveRowId(fixture.end))?.finalAnswer).toBeUndefined();
    expect(workflowLiveExecutionCount()).toBe(0);
  });

  it("defers ready replay evidence through nonterminal and malformed ends until the exact terminal end", () => {
    const fixture = replayFixture("Hydrate only after validated completion.");
    const nonterminalEnd = { ...fixture.end };
    delete nonterminalEnd.status;
    applyWorkflowJournalLineToAgentLiveStore(fixture.start);

    for (const status of ["running", "pending", "unknown-status", undefined] as const) {
      applyWorkflowJournalLineToAgentLiveStore(
        {
          ...nonterminalEnd,
          ts: `nonterminal-${status ?? "missing"}`,
          ...(status === undefined ? {} : { status }),
        },
        fixture.root,
      );
      const earlyRow = agentLiveStore.rows.get(workflowAgentLiveRowId(fixture.end));
      expect(earlyRow?.finalAnswer).toBeUndefined();
      expect(earlyRow?.resultArtifact).toBeUndefined();
      expect(earlyRow?.errors).toEqual([]);
      expect(workflowLiveExecutionCount()).toBe(1);
    }

    applyWorkflowJournalLineToAgentLiveStore(fixture.end, fixture.root);
    expect(agentLiveStore.rows.get(workflowAgentLiveRowId(fixture.end))).toMatchObject({
      status: "done",
      finalAnswer: "Hydrate only after validated completion.",
      resultArtifact: `workflow-artifact:${fixture.runId}/${fixture.ref.artifactId}#sha256=${fixture.ref.sha256}`,
      errors: [],
    });
    expect(workflowLiveExecutionCount()).toBe(0);
  });

  it("does not hydrate or finalize a same-key replacement created during terminal status emission", () => {
    const fixture = replayFixture("Stale answer must not reach replacement B.");
    const rowId = workflowAgentLiveRowId(fixture.end);
    const replacementStart: WorkflowJournalLine = { ...fixture.start, ts: "replacement-b-start" };
    const replacementEnd: WorkflowJournalLine = {
      ...replacementStart,
      ts: "replacement-b-end",
      kind: "agent_end",
      status: "completed",
      replayed: false,
    };
    let replacement: ReturnType<typeof agentLiveStore.captureExecutionAuthority>;
    let replacementBytes = "";
    let replacementCount = 0;
    const replaceOnTerminalStatus = () => {
      const row = agentLiveStore.rows.get(rowId);
      if (replacementCount > 0 || row?.status !== "done" || row.finalAnswer !== undefined) return;
      replacementCount += 1;
      applyWorkflowJournalLineToAgentLiveStore(replacementStart);
      replacement = agentLiveStore.captureExecutionAuthority(rowId);
      if (replacement === undefined) throw new Error("Expected replacement execution B.");
      agentLiveStore.patchExecution(replacement, {
        status: "working",
        finalAnswer: "B status sentinel",
        errors: ["B status error sentinel"],
        tokenCount: { input: 21, output: 8 },
      });
      replacementBytes = JSON.stringify(agentLiveStore.rowForExecution(replacement));
    };

    applyWorkflowJournalLineToAgentLiveStore(fixture.start);
    agentLiveStore.emitter.on("change", replaceOnTerminalStatus);
    try {
      applyWorkflowJournalLineToAgentLiveStore(fixture.end, fixture.root);
    } finally {
      agentLiveStore.emitter.off("change", replaceOnTerminalStatus);
    }

    expect(replacementCount).toBe(1);
    expect(JSON.stringify(replacement === undefined ? undefined : agentLiveStore.rowForExecution(replacement))).toBe(
      replacementBytes,
    );
    expect(replacementBytes).not.toContain("Stale answer must not reach replacement B.");
    expect(workflowLiveExecutionCount()).toBe(1);

    applyWorkflowJournalLineToAgentLiveStore(replacementEnd, fixture.root);
    expect(workflowLiveExecutionCount()).toBe(0);
    const terminalReplacementBytes = JSON.stringify(agentLiveStore.rows.get(rowId));
    applyWorkflowJournalLineToAgentLiveStore(replacementEnd, fixture.root);
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(JSON.stringify(agentLiveStore.rows.get(rowId))).toBe(terminalReplacementBytes);
    expect(replacementCount).toBe(1);
  });

  it("does not let replay hydration or the old finalizer mutate a same-key replacement", () => {
    const fixture = replayFixture("Hydration emission answer A.");
    const rowId = workflowAgentLiveRowId(fixture.end);
    const resultArtifact = `workflow-artifact:${fixture.runId}/${fixture.ref.artifactId}#sha256=${fixture.ref.sha256}`;
    const replacementStart: WorkflowJournalLine = { ...fixture.start, ts: "hydration-replacement-b-start" };
    const replacementEnd: WorkflowJournalLine = {
      ...replacementStart,
      ts: "hydration-replacement-b-end",
      kind: "agent_end",
      status: "completed",
      replayed: false,
    };
    let replacement: ReturnType<typeof agentLiveStore.captureExecutionAuthority>;
    let replacementBytes = "";
    let replacementCount = 0;
    const replaceOnHydration = () => {
      const row = agentLiveStore.rows.get(rowId);
      if (
        replacementCount > 0 ||
        row?.status !== "done" ||
        row.finalAnswer !== "Hydration emission answer A." ||
        row.resultArtifact !== resultArtifact
      ) {
        return;
      }
      replacementCount += 1;
      applyWorkflowJournalLineToAgentLiveStore(replacementStart);
      replacement = agentLiveStore.captureExecutionAuthority(rowId);
      if (replacement === undefined) throw new Error("Expected hydration replacement execution B.");
      agentLiveStore.patchExecution(replacement, {
        status: "working",
        finalAnswer: "B hydration sentinel",
        errors: ["B hydration error sentinel"],
        tokenCount: { input: 34, output: 13 },
      });
      replacementBytes = JSON.stringify(agentLiveStore.rowForExecution(replacement));
    };

    applyWorkflowJournalLineToAgentLiveStore(fixture.start);
    agentLiveStore.emitter.on("change", replaceOnHydration);
    try {
      applyWorkflowJournalLineToAgentLiveStore(fixture.end, fixture.root);
    } finally {
      agentLiveStore.emitter.off("change", replaceOnHydration);
    }

    expect(replacementCount).toBe(1);
    expect(JSON.stringify(replacement === undefined ? undefined : agentLiveStore.rowForExecution(replacement))).toBe(
      replacementBytes,
    );
    expect(replacementBytes).not.toContain("Hydration emission answer A.");
    expect(replacementBytes).not.toContain(resultArtifact);
    expect(workflowLiveExecutionCount()).toBe(1);

    applyWorkflowJournalLineToAgentLiveStore(replacementEnd, fixture.root);
    expect(workflowLiveExecutionCount()).toBe(0);
    const terminalReplacementBytes = JSON.stringify(agentLiveStore.rows.get(rowId));
    applyWorkflowJournalLineToAgentLiveStore(replacementEnd, fixture.root);
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(JSON.stringify(agentLiveStore.rows.get(rowId))).toBe(terminalReplacementBytes);
    expect(replacementCount).toBe(1);
  });

  it("rejects stale end and replay hydration after another call replaces the same live slot", () => {
    const root = temporaryProject();
    const first = replayLines("overlap-run");
    const second = replayLinesForCall("overlap-run", "call-2");
    applyWorkflowJournalLineToAgentLiveStore(first.start);
    applyWorkflowJournalLineToAgentLiveStore(second.start);

    applyWorkflowJournalLineToAgentLiveStore(first.end, root);
    expect(workflowLiveExecutionCount()).toBe(1);

    const rowId = workflowAgentLiveRowId(second.start);
    expect(agentLiveStore.rows.get(rowId)).toMatchObject({ status: "working", errors: [] });
    expect(agentLiveStore.rows.get(rowId)?.finalAnswer).toBeUndefined();

    applyWorkflowJournalLineToAgentLiveStore(second.end, root);
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(agentLiveStore.rows.get(rowId)?.status).toBe("done");

    const third = replayLinesForCall("overlap-run", "call-3");
    applyWorkflowJournalLineToAgentLiveStore(third.start);
    applyWorkflowJournalLineToAgentLiveStore(third.end, root);
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(agentLiveStore.rows.get(rowId)?.status).toBe("done");
  });
});

function replayFixture(answer: string): {
  root: string;
  runId: string;
  runDir: string;
  ref: WorkflowArtifactRef;
  start: WorkflowJournalLine;
  end: WorkflowJournalLine;
} {
  const root = temporaryProject();
  const runId = `replay-${roots.length}`;
  const runDir = path.join(root, ".locus-pi", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const store = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
  const ref = store.recordAgentEvidence({
    callId: "call-1",
    name: "review.md",
    text: answer,
    replayed: true,
    replaySourceRunId: "source-run",
  }).answer;
  if (ref === undefined) throw new Error("Expected answer artifact.");
  const lines = replayLines(runId, ref);
  return { root, runId, runDir, ref, ...lines };
}

function replayLines(
  runId: string,
  answerArtifact?: WorkflowArtifactRef,
): {
  start: WorkflowJournalLine;
  end: WorkflowJournalLine;
} {
  const common = {
    runId,
    agent: "reviewer",
    label: "review",
    phase: "review",
    callId: "call-1",
    replayed: true,
  } as const;
  return {
    start: { ...common, ts: "2026-07-22T00:00:00.000Z", kind: "agent_start" },
    end: {
      ...common,
      ts: "2026-07-22T00:00:01.000Z",
      kind: "agent_end",
      status: "completed",
      ...(answerArtifact === undefined ? {} : { answerArtifact }),
    },
  };
}

function replayLinesForCall(runId: string, callId: string): ReturnType<typeof replayLines> {
  const lines = replayLines(runId);
  return {
    start: { ...lines.start, callId },
    end: { ...lines.end, callId },
  };
}

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-replay-live-row-"));
  roots.push(root);
  return root;
}
