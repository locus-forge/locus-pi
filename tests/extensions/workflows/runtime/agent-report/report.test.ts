import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowRuntime,
  WorkflowAgentExecutionError,
  WorkflowOutputCapabilityError,
  type WorkflowAgentResult,
  type WorkflowAgentReportOptions,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  workflowReplayFile,
  type WorkflowReplayEntry,
} from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { ensureWorkflowRunDir } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { createWorkflowArtifactStore } from "../../../../../extensions/workflows/runtime/workflow-artifacts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dir() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-report-"));
  roots.push(root);
  return root;
}
function runDir() {
  return ensureWorkflowRunDir(dir(), "report-test");
}
const success = (text = "actual answer"): WorkflowAgentResult => ({
  ok: true,
  status: "completed",
  text,
  summary: "done",
  diagnostics: [],
});
const failure = (failureCause: WorkflowAgentResult["failureCause"] = "provider-error"): WorkflowAgentResult => ({
  ok: false,
  status: "failed",
  failureCause,
  summary: "provider refused",
  diagnostics: ["original diagnostic"],
});
const report = { result: "report", label: "review" } as const;

describe("explicit plain-text execution reports", () => {
  it("preserves the exact answer and leaves ordinary calls unchanged", async () => {
    const text = "  actual\nanswer  ";
    const { dsl } = createWorkflowRuntime({ runId: "success", agentRunner: async () => success(text) });
    expect(await dsl.agent("plain")).toBe(text);
    expect(await dsl.agent("reported", report)).toContain(`Agent answer:\n${text}`);
  });

  it("delivers all parallel observations to the arbiter while retaining failed child evidence", async () => {
    const runner = vi.fn(async (req) => (req.prompt === "bad" ? failure() : success(req.prompt)));
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "mixed", agentRunner: runner });
    const checks = await dsl.parallel([
      () => dsl.agent("bad", { ...report, phase: "review-phase" }),
      () => dsl.agent("good", { ...report, label: "other" }),
    ]);
    await dsl.agent(checks.join("\n"), { label: "arbiter" });
    expect(runner.mock.calls.at(-1)![0].prompt).toContain("Cause: provider-error");
    expect(checks[0]).toContain("No accepted agent answer");
    expect(checks[1]).toContain("Agent answer:\ngood");
    expect(getJournal()).toContainEqual(
      expect.objectContaining({ kind: "agent_end", status: "failed", failureCause: "provider-error" }),
    );
    expect(getJournal()).toContainEqual(
      expect.objectContaining({
        kind: "log",
        phase: "review-phase",
        message: expect.stringContaining("[workflow:report]"),
      }),
    );
  });

  it.each(["provider-error", "empty-answer"] as const)(
    "captures classified terminal %s only when opted in",
    async (cause) => {
      const { dsl } = createWorkflowRuntime({ runId: cause, agentRunner: async () => failure(cause) });
      await expect(dsl.agent("ordinary")).rejects.toBeInstanceOf(WorkflowAgentExecutionError);
      expect(await dsl.agent("reported", report)).toContain(`Cause: ${cause}`);
    },
  );

  it.each([
    "cancelled",
    "host-turn-timeout",
    "call-timeout",
    "ask-unavailable",
    "ask-evidence-persistence",
    "sdk-unavailable",
    "tool-call-budget",
    "assistant-turn-budget",
    "output-contract-exhausted",
    "output-contract-conflict",
    "output-contract-unavailable",
    "workspace-allocation",
    "run-policy-blocked",
    "unknown-agent",
    "script-rejected",
    "unparseable-answer",
    // Historical only: nothing produces it any more, and a report must not capture it.
    "answer-too-long",
    "unclassified",
  ] as const)("does not capture %s", async (cause) => {
    const { dsl } = createWorkflowRuntime({ runId: cause, agentRunner: async () => failure(cause) });
    // A transport that cannot carry a shaped result raises its own named capability
    // error; every other cause stays an ordinary execution failure.
    const expected =
      cause === "output-contract-unavailable" ? WorkflowOutputCapabilityError : WorkflowAgentExecutionError;
    await expect(dsl.agent("review", report)).rejects.toBeInstanceOf(expected);
  });

  it("does not capture cancellation even if paired with an eligible cause", async () => {
    const { dsl } = createWorkflowRuntime({
      runId: "cancelled",
      agentRunner: async () => ({ ...failure(), status: "cancelled" }),
    });
    await expect(dsl.agent("review", report)).rejects.toBeInstanceOf(WorkflowAgentExecutionError);
  });

  it.each([new Error("raw host failure"), new WorkflowAgentExecutionError(failure())])(
    "never captures runner throws before terminal persistence: %s",
    async (error) => {
      const { dsl } = createWorkflowRuntime({
        runId: "throw",
        agentRunner: async () => {
          throw error;
        },
      });
      await expect(dsl.agent("review", report)).rejects.toBe(error);
    },
  );

  it("does not swallow evidence persistence failure", async () => {
    const root = dir();
    const ports = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "persist",
      runDir: ensureWorkflowRunDir(root, "persist"),
    });
    const { dsl } = createWorkflowRuntime({
      runId: "persist",
      agentRunner: async () => failure(),
      artifactPorts: {
        ...ports,
        recordAgentEvidence() {
          throw new Error("disk failed");
        },
      },
    });
    await expect(dsl.agent("review", report)).rejects.toThrow("disk failed");
  });

  it.each(["choice", "choiceFallback", "handoffs", "schema", "validate", "returnVia", "output", "repair"])(
    "rejects a %s mixture before starting a child",
    async (key) => {
      const runner = vi.fn(async () => success());
      const { dsl } = createWorkflowRuntime({ runId: "invalid", agentRunner: runner });
      await expect(dsl.agent("review", { ...report, [key]: "invalid" } as WorkflowAgentReportOptions)).rejects.toThrow(
        `cannot be combined with ${key}`,
      );
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown result mode before starting a child", async () => {
    const runner = vi.fn(async () => success());
    const { dsl } = createWorkflowRuntime({ runId: "invalid", agentRunner: runner });
    // @ts-expect-error only the literal report mode exists
    await expect(dsl.agent("review", { result: "reprot" })).rejects.toThrow("result must be report");
    expect(runner).not.toHaveBeenCalled();
    if (false) {
      // @ts-expect-error shaped contracts cannot opt into reports
      await dsl.agent("review", { result: "report", choice: ["yes", "no"] });
      // @ts-expect-error tool output cannot opt into reports
      await dsl.agent("review", { result: "report", returnVia: "tool" });
    }
  });

  it("leaves global invocation and deadline controls fatal", async () => {
    let now = 0;
    const capped = createWorkflowRuntime({
      runId: "cap",
      maxTotalAgentInvocations: 1,
      agentRunner: async () => failure(),
    });
    await capped.dsl.agent("review", report);
    await expect(capped.dsl.agent("arbiter", report)).rejects.toThrow(/cap/i);
    const timed = createWorkflowRuntime({
      runId: "deadline",
      runtimeMs: 1,
      nowMs: () => now,
      agentRunner: async () => failure(),
    });
    now = 2;
    await expect(timed.dsl.agent("review", report)).rejects.toThrow(/runtimeMs/i);
  });
});

describe("report replay boundaries", () => {
  async function recorded(fail = false) {
    const root = runDir();
    const runtime = createWorkflowRuntime({
      runId: "source",
      replay: createWorkflowReplayController({ runDir: root }),
      agentRunner: async (req) => (req.prompt === "review" && fail ? failure() : success(req.prompt)),
    });
    const observation = await runtime.dsl.agent("review", report);
    await runtime.dsl.agent(observation, { label: "arbiter" });
    const entries = readFileSync(workflowReplayFile(root), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkflowReplayEntry);
    return { entries, observation };
  }

  it("renders stable successful report bytes and replays its downstream consumer", async () => {
    const source = await recorded();
    const runner = vi.fn(async () => success());
    const replay = createWorkflowReplayController({ runDir: runDir(), recorded: source.entries });
    const { dsl } = createWorkflowRuntime({ runId: "resume", replay, agentRunner: runner });
    const observation = await dsl.agent("review", report);
    expect(observation).toBe(source.observation);
    await dsl.agent(observation, { label: "arbiter" });
    expect(runner).not.toHaveBeenCalled();
    expect(replay.counts().replayedCalls).toBe(2);
  });

  it("reruns a captured failed child and the following suffix", async () => {
    const source = await recorded(true);
    expect(source.entries[0]).toMatchObject({ ok: false });
    const runner = vi.fn(async () => success());
    const replay = createWorkflowReplayController({ runDir: runDir(), recorded: source.entries });
    const { dsl } = createWorkflowRuntime({ runId: "resume", replay, agentRunner: runner });
    const observation = await dsl.agent("review", report);
    await dsl.agent(observation, { label: "arbiter" });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(replay.counts()).toMatchObject({ divergedAtCall: 0, freshCalls: 2 });
  });

  it("refuses the removed answer-size option by name, before touching the record", async () => {
    const source = await recorded();
    const runner = vi.fn(async () => success());
    const { dsl } = createWorkflowRuntime({
      runId: "resume",
      replay: createWorkflowReplayController({ runDir: runDir(), recorded: source.entries }),
      agentRunner: runner,
    });
    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("review", {
        ...report,
        maxAnswerChars: 1,
      }),
    ).rejects.toThrow(/maxAnswerChars was removed/u);
    expect(runner).not.toHaveBeenCalled();
  });

  it("replays a long recorded answer instead of refusing it for its length", async () => {
    const source = await recorded();
    const runner = vi.fn(async () => success());
    const { dsl } = createWorkflowRuntime({
      runId: "resume-long",
      replay: createWorkflowReplayController({ runDir: runDir(), recorded: source.entries }),
      agentRunner: runner,
    });
    await expect(dsl.agent("review", report)).resolves.toContain("Agent answer:");
    expect(runner).not.toHaveBeenCalled();
  });
});
