import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_FAILURE_CAUSES,
  executeAgentRunBoundary,
  type AgentExecutor,
  type AgentFailureCause,
} from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  AgentSdkUnavailableError,
  createAgentSdkSessionExecutor,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { WorkflowReplayController } from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { createHarness } from "../../../test-harness.js";
import {
  bridgeProject,
  hostRequest,
  retriesOn,
  runAcceptanceHost,
  runHost,
  runtimeOver,
  tmpReportsDir,
} from "../../../fixtures/agent-runtime/agent-failure-probes.js";

/**
 * T-130 W1 — the machine-readable failure cause, as an EXECUTABLE matrix.
 *
 * `status` tells a reader "failed" and nothing else: a turn timeout, a tool-call budget
 * breach, a provider error and a mid-turn throw all arrive as one status plus an English
 * sentence, and everything that must tell those apart would otherwise match on prose.
 *
 * So every member of the closed list has ONE entry below that drives a real path and
 * RETURNS the cause that path produced; the `it.each` over `AGENT_FAILURE_CAUSES` asserts
 * the returned value is the member it was asked for. The claim is therefore "this member
 * was obtained", not "this member was mentioned", and it holds for this file run alone —
 * the previous shape accumulated causes into a module-level set that sibling suites pushed
 * into, so the gate answered according to which tests had already run.
 *
 * `Record<AgentFailureCause, CauseCase>` makes the table total at compile time; the last
 * case refuses a leftover entry for a cause the list no longer declares.
 */

interface CauseCase {
  /** The layer the case drives, and what it asks of it. */
  readonly what: string;
  /** Drives the real path and returns the cause it actually produced. */
  readonly produce: () => Promise<AgentFailureCause | undefined>;
}

/** A bridge runner over `bridgeProject()` with only the executor faked. */
function bridgeRunner(sessionId: string, executor: AgentExecutor) {
  const harness = createHarness(bridgeProject(), { sessionId });
  return createWorkflowAgentRunner({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    createExecutor: (): AgentExecutor => executor,
  });
}

/** Resolve when the call's own fuse — or the run — aborts the child. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** What a child aborted mid-turn hands back to the bridge. */
function abortedChild(agentName: string) {
  return { status: "cancelled" as const, agentName, reason: "aborted", diagnostics: [], lifecycleEntryIds: [] };
}

/** An executor that must never be reached, for the refusals that precede a child. */
const neverRuns: AgentExecutor = {
  async run() {
    throw new Error("must not run");
  },
};

const CAUSE_MATRIX: Record<AgentFailureCause, CauseCase> = {
  "host-turn-timeout": {
    what: "the shared host aborts a turn its own budget outlived",
    async produce() {
      const result = await runHost({ lastAssistantText: undefined, neverEnds: true }, { childTimeoutMs: 5 });

      expect(result.status).toBe("failed");
      expect(await retriesOn(result.failureCause)).toBe(true);
      return result.failureCause;
    },
  },

  "call-timeout": {
    what: "the bridge's own per-call fuse ends a child that never finishes",
    async produce() {
      const runner = bridgeRunner("cause-call-timeout", {
        // Never finishes on its own: only the call fuse can end it.
        async run(_request, signal) {
          await untilAborted(signal);
          return abortedChild("default");
        },
      });

      const result = await runner({ prompt: "hang", agent: "default", timeoutMs: 25 });

      expect(result.summary).toContain("timeout and was aborted");
      expect(await retriesOn(result.failureCause)).toBe(true);
      return result.failureCause;
    },
  },

  "ask-unavailable": {
    what: "the bridge refuses a stage that asks with no operator UI (T-167 fail-closed)",
    async produce() {
      // The bridge is the layer that knows this cause: a `workflow_ask` call in a
      // no-UI parent must END the call with a named refusal, never leave refusal
      // prose in the child's context (the recorded fabrication probe).
      const h = createHarness(undefined, { mode: "print" });
      const runner = createWorkflowAgentRunner({
        pi: h.pi,
        ctx: h.ctx,
        signal: new AbortController().signal,
        createExecutor: () => ({
          async run(request, signal) {
            const tool = request.customTools?.find((candidate) => candidate.name === "workflow_ask");
            expect(tool).toBeDefined();
            const toolResult = await tool!.execute(
              "call-1",
              { questions: [{ question: "Which way?", options: [{ label: "A" }] }] },
              signal,
            );
            expect(toolResult.isError).toBe(true);
            await untilAborted(signal);
            return abortedChild("sub-agent");
          },
        }),
      });

      const result = await runner({ prompt: "decide", tools: ["*"], operatorAsk: true });

      expect(result.ok).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/failed closed/u);
      // Not retryable: re-asking with no UI would re-fail identically.
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "ask-evidence-persistence": {
    what: "the bridge aborts when an answered operator question cannot be indexed",
    async produce() {
      const root = mkdtempSync(path.join(tmpdir(), "workflow-ask-persistence-cause-"));
      const h = createHarness(root);
      const runner = createWorkflowAgentRunner({
        pi: h.pi,
        ctx: h.ctx,
        signal: new AbortController().signal,
        workflowRunId: "ask-persistence-cause",
        evidenceDestinations: () => ({
          transcriptDir: path.join(root, "transcripts"),
          resultArtifactsDir: path.join(root, "results"),
          recordOperatorAskEvidence() {
            throw new Error("injected operator-ask index failure");
          },
        }),
        askRequestQuestion: async () => ({ status: "answered", kind: "custom", answer: "operator answer" }),
        createExecutor: () => ({
          async run(request, signal) {
            const tool = request.customTools?.find((candidate) => candidate.name === "workflow_ask");
            await tool!.execute("tool-call-1", { questions: [{ question: "Which way?", options: [] }] }, signal);
            return abortedChild("sub-agent");
          },
        }),
      });

      const result = await runner({ prompt: "decide", tools: ["*"], operatorAsk: true, callId: "call-0001" });

      expect(result.text).toBeUndefined();
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "sdk-unavailable": {
    what: "the shared host has no substrate to create a session on",
    async produce() {
      const executor = createAgentSdkSessionExecutor({
        createSession: async () => {
          throw new AgentSdkUnavailableError("no substrate here");
        },
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
      });

      const result = await executor.run(hostRequest(), new AbortController().signal);

      expect(result.status).toBe("blocked");
      return result.failureCause;
    },
  },

  cancelled: {
    what: "the shared host reports operator cancellation, never a dropped channel",
    async produce() {
      const result = await runHost({ lastAssistantText: "unused" }, { aborted: true });

      expect(result.status).toBe("cancelled");
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "tool-call-budget": {
    what: "the shared host's tool-call fuse blows, and it is not transport",
    async produce() {
      const result = await runHost(
        {
          lastAssistantText: undefined,
          toolCalls: 4,
          toolResults: 3,
          neverEnds: true,
          events: [
            { type: "tool_execution_start", toolName: "bash" },
            { type: "tool_execution_start", toolName: "bash" },
            { type: "tool_execution_start", toolName: "bash" },
            { type: "tool_execution_start", toolName: "bash" },
          ],
        },
        { childTimeoutMs: 60_000, maxToolCalls: 3 },
      );

      expect(result.reason).toContain("tool-call budget");
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "provider-error": {
    what: "the provider ends the child's assistant turn with an error",
    async produce() {
      agentLiveStore.reset();
      try {
        const result = await runHost({
          lastAssistantText: undefined,
          messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded" }],
        });

        expect(result.reason).toBe("provider exploded");
        expect(await retriesOn(result.failureCause)).toBe(false);
        return result.failureCause;
      } finally {
        agentLiveStore.reset();
      }
    },
  },

  "unparseable-answer": {
    what: "the child ended its turn and the boundary found no final text",
    async produce() {
      const result = await runHost({ lastAssistantText: undefined });

      expect(result.status).toBe("failed");
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "output-contract-exhausted": {
    what: "the real return controller runs out of repair attempts",
    async produce() {
      const { result } = await runAcceptanceHost({ submissions: [["multi\nline"]] });

      expect(result.status).toBe("failed");
      expect(result.text).toBeUndefined();
      return result.failureCause;
    },
  },

  "output-contract-conflict": {
    what: "the child proposes a second, different answer — a protocol conflict",
    async produce() {
      const { result } = await runAcceptanceHost({ submissions: [["first answer", "second answer"]] });

      expect(result.status).toBe("failed");
      return result.failureCause;
    },
  },

  "output-contract-unavailable": {
    what: "the host cannot restrict the tool set, so it refuses before the first prompt",
    async produce() {
      const { result, prompts } = await runAcceptanceHost({
        submissions: [["only answer"]],
        withRestriction: false,
      });

      expect(result.status).toBe("failed");
      expect(prompts()).toBe(0);
      return result.failureCause;
    },
  },

  "assistant-turn-budget": {
    what: "clarification stops at the cumulative assistant-turn cap instead of forever",
    async produce() {
      const { result } = await runAcceptanceHost({ submissions: [], maxAttempts: 3, maxTurns: 1 });

      expect(result.status).toBe("failed");
      return result.failureCause;
    },
  },

  "run-policy-blocked": {
    what: "the run boundary refuses a request before any child exists",
    async produce() {
      const harness = createHarness(bridgeProject(), { sessionId: "cause-run-policy" });
      let childRuns = 0;
      const executor: AgentExecutor = {
        async run() {
          childRuns += 1;
          throw new Error("must not run");
        },
      };

      const result = await executeAgentRunBoundary({
        pi: harness.pi,
        ctx: harness.ctx,
        // maxTurns 0 is refused by validateRunPolicy, so no executor is ever reached.
        request: { ...hostRequest(), maxTurns: 0 },
        executor,
        signal: new AbortController().signal,
      });

      expect(childRuns).toBe(0);
      expect(result.status).toBe("blocked");
      return result.failureCause;
    },
  },

  "unknown-agent": {
    what: "the bridge names a catalog agent that does not exist — an author error",
    async produce() {
      const runner = bridgeRunner("cause-unknown-agent", neverRuns);

      const result = await runner({ prompt: "work", agent: "nowhere-agent" });

      expect(result.summary).toContain("Unknown agent");
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "workspace-allocation": {
    what: "the bridge cannot resolve the workspace a call named",
    async produce() {
      const runner = bridgeRunner("cause-workspace", neverRuns);

      // A workspace handle with no workspace manager configured: allocation, not transport.
      const result = await runner({ prompt: "work", agent: "default", workspaceHandle: "ws-1" });

      expect(result.summary).toContain("workspace manager");
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },

  "empty-answer": {
    what: "the runtime reads a completed child's blank final text as a decomposition signal",
    async produce() {
      const { dsl, getJournal } = runtimeOver("cause-empty", [
        { ok: true, status: "completed", summary: "done", text: "   ", diagnostics: [], agent: "default" },
      ]);

      await expect(dsl.agent("summarize")).rejects.toThrow(/Agent result text is empty\./u);
      return getJournal().find((line) => line.kind === "agent_end")?.failureCause;
    },
  },

  "answer-too-long": {
    what: "HISTORICAL — a run recorded before the size policy was deleted still reads back as itself",
    async produce() {
      // Nothing produces this cause any more: the runtime owns no answer-size policy.
      // The list stays closed over it so a journal written while it did still validates
      // instead of degrading to `unclassified`, and the only real path that can still
      // OBTAIN it is that readback — through the strict line codec, not a literal.
      const root = mkdtempSync(path.join(tmpdir(), "locus-cause-historical-"));
      const runId = "20260729-132000-abcd";
      const legacy: WorkflowAgentResult = {
        ok: false,
        status: "failed",
        failureCause: "answer-too-long",
        summary: "Agent answer exceeded the call's declared maxAnswerChars bound.",
        diagnostics: [],
        agent: "default",
      };
      const { dsl } = createWorkflowRuntime({
        runId,
        projectRoot: root,
        journal: createWorkflowJournalSink(root, runId),
        agentRunner: async () => legacy,
      });

      await expect(dsl.agent("work", {})).rejects.toThrow(/maxAnswerChars/u);

      const read = readWorkflowRunJournalState(root, runId);
      expect(read.diagnostics).toEqual([]);
      const end = read.lines.find((line) => line.kind === "agent_end");
      expect(end?.status).toBe("failed");
      expect(await retriesOn(end?.failureCause)).toBe(false);
      rmSync(root, { recursive: true, force: true });
      return end?.failureCause;
    },
  },

  "script-rejected": {
    what: "the runtime refuses a replayed answer the CURRENT script validator rejects",
    async produce() {
      // A recorded answer that the CURRENT validator refuses: the runtime fails the run
      // closed rather than re-asking, because a second prompt would miss at this ordinal.
      const replay: WorkflowReplayController = {
        beginAgentAttempt: () => ({ replayed: true, text: '{"count":1}' }),
        recordAgentAttempt: () => {},
        resolveValue: (_kind, produce) => produce(),
        counts: () => ({ replayedCalls: 1, freshCalls: 0 }),
      };
      const { dsl, getJournal } = createWorkflowRuntime({
        runId: "cause-script-rejected",
        agentRunner: async () => {
          throw new Error("a replayed call must not reach a child");
        },
        replay,
      });

      await expect(
        dsl.agent("count", {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["count"],
            properties: { count: { type: "integer" } },
          },
          validate: (value) => ((value as { count: number }).count === 3 ? [] : ["count: expected 3"]),
        }),
      ).rejects.toThrow(/count: expected 3/u);
      return getJournal().find((line) => line.kind === "agent_end")?.failureCause;
    },
  },

  unclassified: {
    what: "an unproven createSession throw is not guessed at as transport",
    async produce() {
      const executor = createAgentSdkSessionExecutor({
        createSession: async () => {
          // A bad model id and an option-assembly bug land in this same branch.
          throw new Error("model 'nope/nope' is not registered");
        },
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
      });

      const result = await executor.run(hostRequest(), new AbortController().signal);

      expect(result.status).toBe("failed");
      expect(await retriesOn(result.failureCause)).toBe(false);
      return result.failureCause;
    },
  },
};

describe("agent failure cause — the closed list, member by member", () => {
  it.each(AGENT_FAILURE_CAUSES.map((cause) => [cause, CAUSE_MATRIX[cause].what] as const))(
    "%s — %s",
    async (cause) => {
      // A member nobody produced is a member nobody can trust: either the site that
      // sets it is unreachable, or the enum grew without a case proving where it
      // comes from. Asserting the RETURNED cause is what makes this a production
      // claim rather than a declaration.
      await expect(CAUSE_MATRIX[cause].produce()).resolves.toBe(cause);
    },
    15_000,
  );

  it("keeps no producing case for a cause the list no longer declares", () => {
    expect(Object.keys(CAUSE_MATRIX).sort()).toEqual([...AGENT_FAILURE_CAUSES].sort());
  });
});
