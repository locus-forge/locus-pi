/**
 * A Fusion panel across the replay boundary, and the evidence a replayed leg leaves.
 * The invariant under test is that a panel is never MIXED: before divergence every leg
 * is served from the record or the panel fails, and after it every leg runs fresh with
 * its own model preflight and its own reservation.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  createWorkflowReplayController,
  workflowReplayFile,
} from "../../../../extensions/workflows/runtime/workflow-replay.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "workflow-fusion-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function temporaryRunDir(prefix: string, runId: string): string {
  return ensureWorkflowRunDir(temporaryRoot(prefix), runId);
}

function success(request: WorkflowAgentRequest, text: string): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary: "done",
    text,
    diagnostics: [],
    agent: request.agent,
    ...(request.returnContract === undefined
      ? {}
      : { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }),
    ...(request.capabilityMode === undefined
      ? {}
      : { activeToolNames: request.capabilityMode === "tool-free" ? [] : ["read"] }),
    ...(request.model !== undefined ? { model: request.model, executedModel: request.model } : {}),
    ...(request.modelRole !== undefined ? { executedModel: `resolved/${request.modelRole}` } : {}),
  };
}

const BASE = {
  mode: "agent",
  members: [
    { label: "alpha", model: "test/alpha" },
    { label: "beta", model: "test/beta" },
  ],
  judge: { label: "synthesizer", model: "test/judge" },
} as const;

describe("dsl.fusion", () => {
  it("replays the complete fan-out and judge without spawning fresh children", async () => {
    const sourceDir = temporaryRunDir("workflow-fusion-replay-source-", "fusion-replay-source");
    const sourceController = createWorkflowReplayController({ runDir: sourceDir });
    let sourceCalls = 0;
    const source = createWorkflowRuntime({
      runId: "fusion-replay-source",
      replay: sourceController,
      agentRunner: async (request) => {
        sourceCalls += 1;
        return success(request, request.model === "test/judge" ? "replayed final" : `candidate ${request.model}`);
      },
    });
    await expect(source.dsl.fusion("question", BASE)).resolves.toBe("replayed final");
    expect(sourceCalls).toBe(3);

    const sourceEntries = readFileSync(workflowReplayFile(sourceDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    let resumedCalls = 0;
    let resumedPreflights = 0;
    const resumedController = createWorkflowReplayController({
      runDir: temporaryRunDir("workflow-fusion-replay-resumed-", "fusion-replay-resumed"),
      recorded: sourceEntries,
    });
    const resumed = createWorkflowRuntime({
      runId: "fusion-replay-resumed",
      replay: resumedController,
      replaySourceRunId: "fusion-replay-source",
      preflightAgentRequests: async () => {
        resumedPreflights += 1;
        throw new Error("current host no longer resolves the recorded models");
      },
      agentRunner: async (request) => {
        resumedCalls += 1;
        return success(request, "unexpected fresh answer");
      },
    });
    await expect(resumed.dsl.fusion("question", BASE)).resolves.toBe("replayed final");
    expect(resumedCalls).toBe(0);
    expect(resumedPreflights).toBe(0);
    expect(resumedController.counts()).toEqual({ replayedCalls: 3, freshCalls: 0 });
    expect(
      resumed
        .getJournal()
        .filter((line) => line.kind === "agent_end")
        .map((line) => ({
          mode: line.capabilityMode,
          activeToolNames: line.activeToolNames,
          replayed: line.replayed,
        })),
    ).toEqual([
      { mode: "agent", activeToolNames: undefined, replayed: true },
      { mode: "agent", activeToolNames: undefined, replayed: true },
      { mode: "agent", activeToolNames: undefined, replayed: true },
    ]);

    const modeChanged = createWorkflowRuntime({
      runId: "fusion-replay-mode-changed",
      replay: createWorkflowReplayController({
        runDir: temporaryRoot("workflow-fusion-replay-mode-changed-"),
        recorded: sourceEntries,
      }),
      replaySourceRunId: "fusion-replay-source",
      agentRunner: async (request) => success(request, "unexpected fresh answer"),
    });
    await expect(modeChanged.dsl.fusion("question", { ...BASE, mode: "tool-free" })).rejects.toThrow(
      /cannot mix recorded and fresh agent calls/u,
    );
    expect(modeChanged.getJournal().filter((line) => line.kind === "agent_end")).toHaveLength(0);

    let divergentCalls = 0;
    const divergent = createWorkflowRuntime({
      runId: "fusion-replay-divergent",
      replay: createWorkflowReplayController({
        runDir: temporaryRoot("workflow-fusion-replay-divergent-"),
        recorded: sourceEntries,
      }),
      replaySourceRunId: "fusion-replay-source",
      preflightAgentRequests: async () => {
        throw new Error("resume must not consult current model configuration");
      },
      agentRunner: async (request) => {
        divergentCalls += 1;
        return success(request, "unexpected fresh answer");
      },
    });
    let divergence: unknown;
    try {
      await divergent.dsl.fusion("changed question", BASE);
    } catch (error) {
      divergence = error;
    }
    expect(divergence).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("cannot mix recorded and fresh agent calls") }),
      ]),
    });
    expect(divergentCalls).toBe(0);
  });

  it("replays a whole recorded panel under a totalAgents budget too small to run it fresh", async () => {
    // `totalAgents` bounds the children a run STARTS, and a replayed leg starts none —
    // which is why `spendInvocation("replayed")` charges nothing. The panel reservation
    // used to be taken for the whole worst case before replay or fresh was known, so a
    // resume was billed again for work the original run had already paid for: three
    // recorded legs were refused under `totalAgents: 1` before the first record lookup.
    const sourceDir = temporaryRunDir("workflow-fusion-replay-budget-source-", "fusion-replay-budget-source");
    const source = createWorkflowRuntime({
      runId: "fusion-replay-budget-source",
      replay: createWorkflowReplayController({ runDir: sourceDir }),
      agentRunner: async (request) =>
        success(request, request.model === "test/judge" ? "replayed final" : `candidate ${request.model}`),
    });
    await expect(source.dsl.fusion("question", BASE)).resolves.toBe("replayed final");
    const sourceEntries = readFileSync(workflowReplayFile(sourceDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(sourceEntries).toHaveLength(3);

    let freshCalls = 0;
    const controller = createWorkflowReplayController({
      runDir: temporaryRunDir("workflow-fusion-replay-budget-resumed-", "fusion-replay-budget-resumed"),
      recorded: sourceEntries,
    });
    const resumed = createWorkflowRuntime({
      runId: "fusion-replay-budget-resumed",
      replay: controller,
      replaySourceRunId: "fusion-replay-budget-source",
      maxTotalAgentInvocations: 1,
      agentRunner: async (request) => {
        freshCalls += 1;
        return success(request, "unexpected fresh answer");
      },
    });

    await expect(resumed.dsl.fusion("question", BASE)).resolves.toBe("replayed final");
    expect(freshCalls).toBe(0);
    expect(controller.counts()).toEqual({ replayedCalls: 3, freshCalls: 0 });
    // No budget stop was journalled, because nothing was charged.
    expect(
      resumed.getJournal().filter((line) => line.kind === "log" && /stopped by budget/u.test(line.message ?? "")),
    ).toHaveLength(0);
  });

  /**
   * A `fusion()` group standing AFTER the divergence point is an ordinary fresh panel.
   *
   * Replay is a strict prefix with a one-way latch: once the run has diverged, no later
   * call can be served from the record, so the whole panel is fresh and cannot be mixed.
   * Refusing it outright — the previous rule — meant a resume could never run a fusion
   * that had not happened yet in the recorded run, which is exactly what repair-and-
   * continue is for. What stays refused is a MIXED panel before the boundary, which the
   * two divergence tests above pin.
   */
  it("runs a whole fresh panel after the replay boundary, with its model preflight", async () => {
    const sourceDir = temporaryRunDir("workflow-fusion-repair-source-", "fusion-repair-source");
    const source = createWorkflowRuntime({
      runId: "fusion-repair-source",
      replay: createWorkflowReplayController({ runDir: sourceDir }),
      agentRunner: async (request) =>
        success(request, request.model === "test/judge" ? "recorded verdict" : `candidate ${request.model}`),
    });
    await source.dsl.agent("stage-a", { label: "node-a" });
    await expect(source.dsl.fusion("question", BASE)).resolves.toBe("recorded verdict");

    const sourceEntries = readFileSync(workflowReplayFile(sourceDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    let freshCalls = 0;
    const preflighted: string[][] = [];
    const repaired = createWorkflowRuntime({
      runId: "fusion-repair-resumed",
      preflightAgentRequests: async (batch) => {
        preflighted.push(batch.map((entry) => entry.model ?? entry.modelRole ?? "?"));
      },
      replay: createWorkflowReplayController({
        runDir: temporaryRunDir("workflow-fusion-repair-resumed-", "fusion-repair-resumed"),
        recorded: sourceEntries,
        sourceScriptChanged: true,
      }),
      replaySourceRunId: "fusion-repair-source",
      agentRunner: async (request) => {
        freshCalls += 1;
        return success(request, "fresh answer");
      },
    });
    // The repair edits the node before the group, so the latch is set by the time
    // the panel is reached.
    await expect(repaired.dsl.agent("stage-a repaired", { label: "node-a" })).resolves.toBe("fresh answer");
    await expect(repaired.dsl.fusion("question", BASE)).resolves.toBe("fresh answer");
    // One repaired node plus two members plus the judge — every leg fresh, none mixed.
    expect(freshCalls).toBe(4);
    // A fresh panel is preflighted like any other: it must not start spending on
    // selectors nobody checked just because the run happens to be a resume.
    expect(preflighted).toEqual([["test/alpha", "test/beta", "test/judge"]]);
  });

  it("runs a fresh panel after a recorded failure diverged the run", async () => {
    const sourceDir = temporaryRunDir("workflow-fusion-failure-source-", "fusion-failure-source");
    const sourceController = createWorkflowReplayController({ runDir: sourceDir });
    // A recorded `ok:false` followed by a recorded panel. Before divergence
    // latched on every miss, this exact resume replayed the whole fusion tail.
    // Losing that is a deliberate tightening: the tail's answers were produced
    // after the failed node behaved differently.
    sourceController.recordAgentAttempt({ canonicalRequest: "stage-a" }, { ok: false });
    const source = createWorkflowRuntime({
      runId: "fusion-failure-source",
      replay: sourceController,
      agentRunner: async (request) =>
        success(request, request.model === "test/judge" ? "recorded verdict" : `candidate ${request.model}`),
    });
    await expect(source.dsl.fusion("question", BASE)).resolves.toBe("recorded verdict");

    const sourceEntries = readFileSync(workflowReplayFile(sourceDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    let freshCalls = 0;
    const resumed = createWorkflowRuntime({
      runId: "fusion-failure-resumed",
      replay: createWorkflowReplayController({
        runDir: temporaryRunDir("workflow-fusion-failure-resumed-", "fusion-failure-resumed"),
        recorded: sourceEntries,
      }),
      replaySourceRunId: "fusion-failure-source",
      agentRunner: async (request) => {
        freshCalls += 1;
        return success(request, "fresh answer");
      },
    });
    await expect(resumed.dsl.agent("stage-a")).resolves.toBe("fresh answer");
    await expect(resumed.dsl.fusion("question", BASE)).resolves.toBe("fresh answer");
    expect(freshCalls).toBe(4);
  });

  it("marks a replayed judge validator throw as replayed terminal evidence", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", minLength: 1 } },
    };
    const sourceDir = temporaryRunDir("workflow-fusion-validator-source-", "fusion-validator-source");
    const source = createWorkflowRuntime({
      runId: "fusion-validator-source",
      replay: createWorkflowReplayController({ runDir: sourceDir }),
      agentRunner: async (request) =>
        success(request, request.model === "test/judge" ? '{"answer":"safe"}' : `candidate ${request.model}`),
    });
    await source.dsl.fusion("question", { ...BASE, schema, validate: () => [] });
    const recorded = readFileSync(workflowReplayFile(sourceDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    let freshCalls = 0;
    const resumedRoot = temporaryRoot("workflow-fusion-validator-resumed-");
    const resumedRunId = "fusion-validator-resumed";
    const resumed = createWorkflowRuntime({
      runId: resumedRunId,
      projectRoot: resumedRoot,
      journal: createWorkflowJournalSink(resumedRoot, resumedRunId),
      replay: createWorkflowReplayController({
        runDir: ensureWorkflowRunDir(resumedRoot, resumedRunId),
        recorded,
      }),
      replaySourceRunId: "fusion-validator-source",
      agentRunner: async (request) => {
        freshCalls += 1;
        return success(request, "unexpected fresh answer");
      },
    });

    await expect(
      resumed.dsl.fusion("question", {
        ...BASE,
        schema,
        validate: () => {
          throw new Error("validator exploded after replay");
        },
      }),
    ).rejects.toThrow("validator exploded after replay");
    expect(freshCalls).toBe(0);
    const [terminal] = resumed.getJournal().filter((line) => line.kind === "error");
    expect(terminal).toMatchObject({
      source: "script",
      replayed: true,
      capabilityMode: "agent",
      message: "validator exploded after replay",
    });
    expect(terminal?.activeToolNames).toBeUndefined();
    const persisted = readWorkflowRunJournalState(resumedRoot, resumedRunId);
    expect(persisted.diagnostics).toEqual([]);
    expect(persisted.lines.find((line) => line.kind === "error")).toMatchObject({ replayed: true });
  });

  it("marks replayed answer adoption failures as replayed terminal evidence", async () => {
    const sourceDir = temporaryRunDir("workflow-fusion-adoption-source-", "fusion-adoption-source");
    const source = createWorkflowRuntime({
      runId: "fusion-adoption-source",
      replay: createWorkflowReplayController({ runDir: sourceDir }),
      agentRunner: async (request) =>
        success(request, request.model === "test/judge" ? "final" : `candidate ${request.model}`),
    });
    await source.dsl.fusion("question", BASE);
    const recorded = readFileSync(workflowReplayFile(sourceDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const resumedRoot = temporaryRoot("workflow-fusion-adoption-resumed-");
    const resumedRunId = "fusion-adoption-resumed";
    const artifactStore = createWorkflowArtifactStore({
      projectRoot: resumedRoot,
      runId: resumedRunId,
      runDir: ensureWorkflowRunDir(resumedRoot, resumedRunId),
    });
    let freshCalls = 0;
    const resumed = createWorkflowRuntime({
      runId: resumedRunId,
      replay: createWorkflowReplayController({
        runDir: temporaryRunDir("workflow-fusion-adoption-record-", resumedRunId),
        recorded,
      }),
      replaySourceRunId: "fusion-adoption-source",
      artifactPorts: {
        recordAgentEvidence() {
          throw new Error("replayed answer adoption failed");
        },
        publishText: artifactStore.publishText,
        consumeText: artifactStore.consumeText,
      },
      agentRunner: async (request) => {
        freshCalls += 1;
        return success(request, "unexpected fresh answer");
      },
    });

    await expect(resumed.dsl.fusion("question", BASE)).rejects.toThrow();
    expect(freshCalls).toBe(0);
    const adoptionErrors = resumed
      .getJournal()
      .filter(
        (line) =>
          line.kind === "error" && line.callId !== undefined && line.message === "replayed answer adoption failed",
      );
    expect(adoptionErrors).toHaveLength(2);
    for (const line of adoptionErrors) {
      expect(line).toMatchObject({ source: "runtime", replayed: true, capabilityMode: "agent" });
      expect(line.activeToolNames).toBeUndefined();
    }
  });
});
