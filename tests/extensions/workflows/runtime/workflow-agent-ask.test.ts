import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest, AgentRunResult } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowAgentRunner,
  WORKFLOW_NO_OPERATOR_ASK_MESSAGE,
} from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { WORKFLOW_ASK_TOOL_NAME } from "../../../../extensions/workflows/runtime/workflow-ask-tool.js";
import {
  createWorkflowArtifactStore,
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { WorkflowReplayController } from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { createHarness } from "../../../test-harness.js";

/**
 * T-167 — the live ask bridge, wiring level.
 *
 * What must be true of the BRIDGE (the tool itself is unit-tested next door):
 * the stock `ask` is excluded from every child, `workflow_ask` is injected only
 * when the stage declared `ask: true`, an `ask: true` call gets exactly ONE
 * deadline — wall clock, operator wait included, no hidden allowance — the
 * question+answer pair lands as a durable run artifact, and the replay key forks
 * on `ask` so a no-ask record is never served to an asking call.
 */

function completedResult(text: string): AgentRunResult {
  return {
    status: "completed",
    agentName: "sub-agent",
    reason: "done",
    text,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

describe("workflow agent bridge — live ask wiring", () => {
  it("always excludes the stock ask; injects workflow_ask only when the stage declared it", async () => {
    const h = createHarness();
    const captured: AgentRunRequest[] = [];
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: () => ({
        async run(request) {
          captured.push(request);
          return completedResult("ok");
        },
      }),
    });
    await runner({ prompt: "plain stage", tools: ["*"] });
    await runner({ prompt: "asking stage", tools: ["*"], operatorAsk: true });
    expect(captured[0]?.additionalExcludeTools).toEqual(["ask"]);
    expect(captured[0]?.customTools).toBeUndefined();
    expect(captured[1]?.additionalExcludeTools).toEqual(["ask"]);
    expect(captured[1]?.customTools?.map((tool) => tool.name)).toEqual([WORKFLOW_ASK_TOOL_NAME]);
  });

  it("counts the operator wait against the call deadline, records it, and keeps the Q&A artifact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-ask-evidence-"));
    const h = createHarness(root);
    const runId = "ask-pause-run";
    const runDir = path.join(root, ".locus-pi", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactStore = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: runId,
      evidenceDestinations: (callId) => artifactStore.childEvidenceDestinations(callId),
      // A scripted operator that takes 200 ms to answer — four times the fuse.
      askRequestQuestion: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" };
      },
      createExecutor: () => ({
        async run(request, signal) {
          const tool = request.customTools?.find((candidate) => candidate.name === WORKFLOW_ASK_TOOL_NAME);
          expect(tool).toBeDefined();
          const toolResult = await tool!.execute(
            "call-1",
            { questions: [{ id: "q1", question: "Which storage?", options: [{ label: "sqlite" }] }] },
            signal,
          );
          const text = toolResult.content[0]?.text ?? "";
          return completedResult(text);
        },
      }),
    });
    const result = await runner({
      prompt: "decide storage",
      tools: ["*"],
      operatorAsk: true,
      timeoutMs: 5_000,
      callId: "ask-call-1",
    });
    // ONE clock. The declared 5 s deadline is wall clock and the 200 ms human wait
    // is inside it; the fuse no longer pauses, so the call and the SDK host cannot
    // disagree about how much time has passed and no hidden 24-hour allowance
    // exists to cover a pause.
    expect(result.failureCause).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Answer: sqlite");
    expect(result.diagnostics.some((line) => line.includes("workflow_ask: operator answered 1/1"))).toBe(true);
    // The wait is visible evidence: a call that dies on its deadline while a human
    // was thinking says so instead of looking like a slow model.
    const waitNote = result.diagnostics.find((line) => line.includes("operator wait of"));
    expect(waitNote).toBeDefined();
    expect(waitNote).toContain("counted against the call deadline");
    const index = readWorkflowArtifactIndex(root, runId);
    expect(index.status).toBe("ready");
    if (index.status !== "ready") throw new Error(index.message);
    const indexed = index.index.artifacts.find((entry) => entry.kind === "operator-ask");
    expect(indexed).toMatchObject({
      artifactId: "ask-call-1-operator-ask-0001",
      callId: "ask-call-1",
      toolCallId: "call-1",
      sequence: 1,
    });
    const readback = readWorkflowArtifactRecord(root, runId, indexed!.artifactId);
    expect(readback.status).toBe("ready");
    if (readback.status !== "ready") throw new Error(readback.message);
    const record = JSON.parse(readback.bytes.toString("utf8")) as {
      declined: boolean;
      entries: Array<{ id: string; status: string; answer?: string }>;
    };
    expect(record.declined).toBe(false);
    expect(record.entries[0]).toMatchObject({ id: "q1", status: "answered", answer: "sqlite" });
  });

  it("gives an ask: true call one deadline, equal to the declared timeout", async () => {
    // The defect this pins down: the bridge used to divide the declared fuse by the
    // turn count, add a per-turn margin, and then add a 24-hour allowance because the
    // host backstop could not pause during a human wait. The host multiplied that
    // back, and at ordinary values the product exceeded Node's maximum delay — which
    // `setTimeout` answers by firing after one millisecond.
    const h = createHarness();
    const factoryOptions: Array<{ childTimeoutMs?: number; cliRequestTimeoutMs?: number }> = [];
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "ask-one-deadline",
      createExecutor: (o) => {
        factoryOptions.push({ ...o });
        return {
          async run() {
            return completedResult("done");
          },
        };
      },
    });

    const asking = await runner({
      prompt: "decide",
      tools: ["*"],
      operatorAsk: true,
      timeoutMs: 86_400_000,
      maxTurns: 1000,
    });
    const plain = await runner({ prompt: "decide", tools: ["*"], timeoutMs: 86_400_000, maxTurns: 1000 });

    expect(asking.ok).toBe(true);
    expect(plain.ok).toBe(true);
    // One number, the declared one, and `ask: true` does not change it.
    expect(factoryOptions.map((o) => o.childTimeoutMs)).toEqual([86_400_000, 86_400_000]);
    for (const options of factoryOptions) {
      expect(options.childTimeoutMs).toBeLessThanOrEqual(2_147_483_647);
      expect(options.cliRequestTimeoutMs).toBe(86_400_000);
    }
  });

  it("aborts the current child with a typed cause when operator-answer indexing fails", async () => {
    const h = createHarness();
    let mounts = 0;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "ask-persistence-failure",
      evidenceDestinations: () => ({
        transcriptDir: path.join(tmpdir(), "unused-transcripts"),
        resultArtifactsDir: path.join(tmpdir(), "unused-results"),
        recordOperatorAskEvidence() {
          throw new Error("injected operator-ask index failure");
        },
      }),
      askRequestQuestion: async () => {
        mounts += 1;
        return { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" };
      },
      createExecutor: () => ({
        async run(request, signal) {
          const tool = request.customTools?.find((candidate) => candidate.name === WORKFLOW_ASK_TOOL_NAME);
          const toolResult = await tool!.execute(
            "tool-call-1",
            { questions: [{ id: "q1", question: "Which storage?", options: [{ label: "sqlite" }] }] },
            signal,
          );
          expect(toolResult.isError).toBe(true);
          expect(toolResult.content[0]?.text).not.toContain("Answer: sqlite");
          expect(signal.aborted).toBe(true);
          return {
            status: "cancelled",
            agentName: "sub-agent",
            reason: "aborted",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const result = await runner({
      prompt: "decide storage",
      tools: ["*"],
      operatorAsk: true,
      callId: "call-0001",
    });

    expect(mounts).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.failureCause).toBe("ask-evidence-persistence");
    expect(result.text).toBeUndefined();
    expect(result.diagnostics.join("\n")).toContain("injected operator-ask index failure");
  });

  it("forks the replay key on ask, so a no-ask record is never served to an asking call", async () => {
    const h = createHarness();
    const keys: string[] = [];
    const replay = {
      beginAgentAttempt(call: { canonicalRequest: string }) {
        keys.push(call.canonicalRequest);
        return { replayed: false, reason: "no-recorded-calls" } as const;
      },
      recordAgentAttempt() {},
      resolveValue(_kind: unknown, produce: () => number) {
        return produce();
      },
      counts() {
        return { agentReplayed: 0, agentRecorded: 0, valueReplayed: 0, valueRecorded: 0 };
      },
    } as unknown as WorkflowReplayController;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      askRequestQuestion: async () => ({ status: "answered", kind: "custom", answer: "yes" }),
      createExecutor: () => ({
        async run() {
          return completedResult("fine");
        },
      }),
    });
    const { dsl } = createWorkflowRuntime({ runId: "ask-key-run", agentRunner: runner, replay });
    await dsl.agent("same prompt");
    await dsl.agent("same prompt", { ask: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(keys[0]).toContain('"operatorAsk":null');
    expect(keys[1]).toContain('"operatorAsk":true');
  });

  it("refuses an ask stage under the run-level no-operator mode before any child exists (T-165)", async () => {
    const h = createHarness();
    let spawned = 0;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      noOperator: true,
      createExecutor: () => ({
        async run() {
          spawned += 1;
          return completedResult("must never run");
        },
      }),
    });
    const refused = await runner({ prompt: "asking stage", tools: ["*"], operatorAsk: true });
    expect(refused.ok).toBe(false);
    expect(refused.failureCause).toBe("ask-unavailable");
    expect(refused.summary).toBe(WORKFLOW_NO_OPERATOR_ASK_MESSAGE);
    expect(spawned).toBe(0);
    // A stage that does not ask is untouched by the mode.
    const plain = await runner({ prompt: "plain stage", tools: ["*"] });
    expect(plain.ok).toBe(true);
    expect(spawned).toBe(1);
  });
});
