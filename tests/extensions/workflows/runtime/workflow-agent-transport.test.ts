import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_FAILURE_CAUSES,
  type AgentExecutor,
  type AgentFailureCause,
  type AgentRunRequest,
} from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
  AgentSdkUnavailableError,
  createAgentSdkSessionExecutor,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  createWorkflowAgentRunner,
  WorkflowAgentUnavailableError,
} from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { workflowRunArtifactsDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  WorkflowRunDeadlineError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import type { WorkflowReplayController } from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { createHarness } from "../../../test-harness.js";
import {
  bridgeProject,
  completed,
  hostRequest,
  retriesOn,
  runAcceptanceHost,
  runtimeOver,
  scriptedRuntime,
  tmpReportsDir,
} from "../../../fixtures/agent-runtime/agent-failure-probes.js";

/**
 * T-130 — how the machine-readable failure cause travels, once it has been produced.
 *
 * Producing each member of the closed list is a separate, self-contained claim and
 * lives in `workflow-agent-failure-causes.test.ts`; the shared host's own extra
 * classification calls live in `tests/shared/agent-runtime/agent-failure-cause-host.test.ts`.
 * What is left here is the transport: the bridge adaptation around ONE call (identity,
 * cancellation precedence, the fail-closed sdk-unavailable throw, what is NOT read as a
 * cause), the runtime's readback of a cause it did not produce, the cumulative
 * assistant-turn ledger, the retry allowlist, and the bounded transport retry itself.
 *
 * The fakes are shared with those suites through `tests/fixtures/agent-runtime/agent-failure-probes.ts`
 * so a change to the fake child cannot make one suite prove something the others do not.
 */

describe("agent failure cause — bridge", () => {
  it("round-trips the live execution petname through persisted agent_end evidence", async () => {
    const root = bridgeProject();
    const harness = createHarness(root, { sessionId: "transport-petname" });
    const rowId = "workflow:transport-petname:call-0001";
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (options): AgentExecutor => ({
        async run(request) {
          const execution = agentLiveStore.beginExecution({
            id: rowId,
            agentName: request.agent?.name ?? "sub-agent",
            label: "default (identity proof)",
            isolated: false,
            noMcp: false,
          });
          options.onLiveExecution?.(execution);
          return {
            status: "completed",
            ...(request.agent?.name === undefined ? {} : { agentName: request.agent.name }),
            reason: "done",
            text: "done",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const runId = "transport-petname";
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      agentRunner: runner,
      journal: createWorkflowJournalSink(root, runId),
    });
    await expect(dsl.agent("work", { agent: "default", label: "identity proof" })).resolves.toBe("done");
    const displayName = agentLiveStore.rows.get(rowId)?.displayName;
    expect(displayName).toBeDefined();
    const persisted = readWorkflowRunJournalState(root, runId);
    expect(persisted.diagnostics).toEqual([]);
    expect(persisted.lines.find((line) => line.kind === "agent_end")).toMatchObject({
      agent: "default",
      displayName,
      status: "completed",
    });
    expect(readWorkflowRunSummary(root, runId)).toMatchObject({ agentsEnded: 1, lastKind: "agent_end" });
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps an earlier run cancellation when the call deadline passes during executor unwind", async () => {
    const root = bridgeProject();
    const harness = createHarness(root, { sessionId: "transport-run-cancel-first" });
    const controller = new AbortController();
    let children = 0;
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: controller.signal,
      createExecutor: (): AgentExecutor => ({
        async run(request, signal) {
          children += 1;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          // Cross the still-armed call deadline while the host unwinds the earlier
          // run cancellation. The later timer must not acquire ownership.
          await new Promise<void>((resolve) => setTimeout(resolve, 35));
          return {
            status: "cancelled" as const,
            failureCause: "cancelled" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "run cancelled by operator",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    const runId = "transport-run-cancel-first";
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      agentRunner: runner,
      journal: createWorkflowJournalSink(root, runId),
    });

    const pending = dsl.agent("work", {
      agent: "default",
      attempts: 2,
      timeoutMs: 20,
    });
    setTimeout(() => controller.abort({ kind: "operator_stop" }), 5);

    await expect(pending).rejects.toThrow(/run cancelled by operator/u);
    expect(children).toBe(1);

    const journal = readWorkflowRunJournalState(root, runId);
    expect(journal.diagnostics).toEqual([]);
    const end = journal.lines.find((line) => line.kind === "agent_end");
    expect(end).toMatchObject({
      status: "cancelled",
      failureCause: "cancelled",
      attempt: 1,
      attempts: 2,
    });
    expect(end?.resultArtifact).toBeDefined();
    const wrapper = JSON.parse(readFileSync(end!.resultArtifact!, "utf8")) as { content: string };
    const envelope = JSON.parse(wrapper.content) as {
      status: string;
      failureCause?: AgentFailureCause;
    };
    expect(envelope.status).toBe("cancelled");
    expect(envelope.failureCause).toBe("cancelled");
    expect(await retriesOn(envelope.failureCause)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("carries sdk-unavailable from the real host through the bridge into the run journal", async () => {
    // The one cause that never becomes a result. The bridge fails the whole run closed —
    // a run whose children cannot be spawned must end, not be re-asked — so it THROWS
    // before the result mapping, and there is no `agent_end` to carry a class. Without the
    // cause on the throw, the only terminal record of the call is an English sentence, and
    // "the cause travels end to end" would be true of thirteen members and false of this
    // one. Every layer here is real: the host executor, the bridge, the runtime, and the
    // journal validator a reader loads the file back through.
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-unavailable-"));
    const runId = "20260729-130000-abcd";
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unavailable" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: () =>
        createAgentSdkSessionExecutor({
          createSession: async () => {
            throw new AgentSdkUnavailableError("no substrate here");
          },
          reportsDir: tmpReportsDir(),
          now: () => "fixed",
        }),
    });
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: runner,
    });

    // Fail-closed behaviour preserved: the call throws, it is not downgraded to a result.
    await expect(dsl.agent("work", {})).rejects.toThrow(/Pi SDK host/u);

    const read = readWorkflowRunJournalState(root, runId);
    expect(read.diagnostics).toEqual([]);
    const errors = read.lines.filter((line) => line.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.failureCause).toBe("sdk-unavailable");
    expect(errors[0]?.callId).toBe("call-0001");
    // No agent_end: the call never produced a result to end with, which is exactly why the
    // error line has to carry the class.
    expect(read.lines.filter((line) => line.kind === "agent_end")).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails the run closed on the typed sdk-unavailable cause with no diagnostic prose at all", async () => {
    // The real host always happens to append its English token beside the cause, so a
    // bridge that branched on that substring passed every end-to-end test while the typed
    // channel sat unread. Here the cause arrives ALONE: re-wording or dropping the
    // diagnostic must not change whether the run ends.
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unavailable-typed" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          return {
            status: "blocked",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "no substrate here",
            failureCause: "sdk-unavailable",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const thrown = await runner({ prompt: "work", agent: "default" }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(WorkflowAgentUnavailableError);
    expect((thrown as WorkflowAgentUnavailableError).failureCause).toBe("sdk-unavailable");
    expect((thrown as Error).message).toContain("no substrate here");
  });

  it("does not read the diagnostic token as a cause, and the run still fails closed", async () => {
    // The converse pin: prose alone no longer decides. A blocked result that carries the
    // token but no typed cause is `unclassified` — so it is never re-asked, and it is
    // never `ok`, which is what keeps the run failing closed rather than reading a blocked
    // call as an answer.
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unavailable-prose" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          return {
            status: "blocked",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "no substrate here",
            diagnostics: [AGENT_SDK_UNAVAILABLE_DIAGNOSTIC],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const result = await runner({ prompt: "work", agent: "default" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    // No declared cause at all: absence is what makes it unclassified, and unclassified
    // never retries.
    expect(result.failureCause).toBeUndefined();
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("puts no cause on an ordinary throw, rather than guessing one", async () => {
    // The gate on the cause carried by a throw is the closed list, not "any error with a
    // failureCause property": an unrelated error must never write a journal line the
    // reader refuses.
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-thrown-"));
    const runId = "20260729-131000-abcd";
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async () => {
        throw Object.assign(new Error("host substrate is gone"), { failureCause: "made-up-cause" });
      },
    });

    await expect(dsl.agent("work", {})).rejects.toThrow(/host substrate is gone/u);

    const read = readWorkflowRunJournalState(root, runId);
    expect(read.diagnostics).toEqual([]);
    expect(read.lines.filter((line) => line.kind === "error").at(0)?.failureCause).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("agent failure cause — runtime", () => {
  it("names the transport as the reason a shaped call could not be carried", async () => {
    // No `answer-too-long` case exists any more: nothing produces that cause. This is the
    // capability refusal that replaced the text fallback — a host that completed the child
    // without a workflow_return receipt cannot carry a shaped result at all.
    const { dsl, getJournal } = runtimeOver("transport-no-receipt", [completed('{"count":3}')]);

    await expect(dsl.agent("count", { schema: { type: "object", properties: {} } })).rejects.toThrow(
      /Transport cannot carry a shaped result/u,
    );
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.failureCause).toBe("output-contract-unavailable");
  });

  it("reads a result written before the field existed as unclassified, never as retryable", async () => {
    // Exactly the shape an older bridge produced: a failed result and no cause at all.
    const legacy: WorkflowAgentResult = {
      ok: false,
      status: "failed",
      summary: "Child agent turn exceeded the 5000ms budget and was aborted.",
      diagnostics: [],
      agent: "default",
    };

    expect(legacy.failureCause).toBeUndefined();
    // The prose says "timeout"; with no declared cause the runtime still refuses to retry.
    expect(await retriesOn(legacy.failureCause)).toBe(false);

    const { dsl, getJournal } = runtimeOver("transport-legacy", [legacy]);
    await expect(dsl.agent("work")).rejects.toThrow(/budget and was aborted/u);
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.status).toBe("failed");
    expect(end?.failureCause).toBe("unclassified");
  });

  it("puts no cause on a completed call", async () => {
    const { dsl, getJournal } = runtimeOver("transport-completed", [completed("fine")]);

    await expect(dsl.agent("work")).resolves.toBe("fine");
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.status).toBe("completed");
    expect(end?.failureCause).toBeUndefined();
  });
});

describe("same-session output acceptance — the cumulative turn ledger", () => {
  // The four causes the return contract owns are produced in the cause matrix; what is
  // left here is the ledger those causes are counted on, over the same real controller.
  it.each([
    { maxTurns: 20, cycles: 21, status: "failed" },
    { maxTurns: 1000, cycles: 25, status: "completed" },
    { maxTurns: 1000, cycles: 1000, status: "completed" },
    { maxTurns: 1000, cycles: 1001, status: "failed" },
  ])("counts ordinary work before the first tool return ($maxTurns/$cycles)", async ({ maxTurns, cycles, status }) => {
    const { result, prompts } = await runAcceptanceHost({
      submissions: [["complete review"]],
      maxTurns,
      workTurns: [cycles],
    });
    expect(result.status).toBe(status);
    expect(prompts()).toBe(1);
    if (status === "failed") expect(result.failureCause).toBe("assistant-turn-budget");
  });

  it.each([20, 21])("keeps work and clarification on one cumulative turn ledger (%s)", async (maxTurns) => {
    const { result, prompts } = await runAcceptanceHost({
      submissions: [[], ["complete review"]],
      maxTurns,
      workTurns: [20, 1],
      maxAttempts: 3,
    });
    expect(result.status).toBe(maxTurns === 20 ? "failed" : "completed");
    expect(prompts()).toBe(maxTurns === 20 ? 1 : 2);
    if (maxTurns === 20) expect(result.failureCause).toBe("assistant-turn-budget");
  });
});

describe("agent failure cause — the list is closed and covered", () => {
  it("keeps the transport allowlist to the two causes the child never answered on", async () => {
    const transport: AgentFailureCause[] = [];
    for (const cause of AGENT_FAILURE_CAUSES) if (await retriesOn(cause)) transport.push(cause);
    expect(transport).toEqual(["host-turn-timeout", "call-timeout"]);
    // And the absent-cause case, which is not a member of the list at all.
    expect(await retriesOn(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2 — the bounded transport retry
// ---------------------------------------------------------------------------

/** A transport failure the runtime is allowed to re-ask. */
function transportFailure(cause: "host-turn-timeout" | "call-timeout" = "host-turn-timeout"): WorkflowAgentResult {
  return {
    ok: false,
    status: "failed",
    failureCause: cause,
    summary: "Child agent turn exceeded the 5000ms budget and was aborted.",
    diagnostics: [],
    agent: "default",
  };
}

/** A project-workspace call with an explicit transport retry budget. */
const RETRYABLE_CALL = { attempts: 2 } as const;

describe("agent attempts — declaration", () => {
  it.each([0, 1.5, -1])("refuses attempts=%s before any child starts", async (attempts) => {
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: `attempts-invalid-${String(attempts)}`,
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("work", { ...RETRYABLE_CALL, attempts })).rejects.toThrow(
      /agent attempts must be a positive safe integer/u,
    );
    // Refused, not clamped, and nothing was spawned to find that out.
    expect(children).toBe(0);
  });

  it("accepts an explicitly requested retry count with no ceiling", async () => {
    // The former ceiling of three existed because the deleted text-repair loop MULTIPLIED
    // it. With one physical child per attempt, the run's own invocation budget bounds it.
    const { dsl, requests } = scriptedRuntime("attempts-ceiling", [completed("fine")]);

    await expect(dsl.agent("work", { attempts: 7 })).resolves.toBe("fine");
    expect(requests).toHaveLength(1);
  });

  it("refuses a worktree call, spawning nothing", async () => {
    let children = 0;
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "attempts-worktree",
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("edit", { attempts: 2, workspaceMode: "worktree" })).rejects.toThrow(
      /refused for a worktree workspace call/u,
    );
    expect(children).toBe(0);
    expect(getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(0);
  });

  it("refuses a workspace-handle call, spawning nothing", async () => {
    const workspaceEvidence = {
      handle: "ws-1",
      id: "ws",
      path: "/tmp/ws",
      head: "abc",
      sourceRef: "HEAD",
      originalRepoRoot: "/repo",
      originalHead: "abc",
    };
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "attempts-handle",
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
      workspaceManager: {
        allocate: () => "ws-1",
        resolve: () => workspaceEvidence,
        evidence: () => [workspaceEvidence],
      },
    });

    await expect(dsl.agent("edit", { attempts: 2, workspaceHandle: "ws-1" })).rejects.toThrow(
      /refused for a call bound to a workspace handle/u,
    );
    expect(children).toBe(0);
  });

  it("allows an explicitly requested retry for a full-tool project call", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-project-writer", [transportFailure(), completed("second")]);

    await expect(dsl.agent("fix the bug", { attempts: 2 })).resolves.toBe("second");
    expect(requests).toHaveLength(2);
  });

  it("ignores legacy per-call tool lists instead of creating a second tool policy", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-tools-ignored", [transportFailure(), completed("second")]);

    await expect(dsl.agent("read the file", { attempts: 2, tools: ["read", "grep"] })).resolves.toBe("second");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.tools?.join(",") === "*")).toBe(true);
  });
});

describe("agent attempts — retry behaviour", () => {
  it("re-runs the identical request after a transport failure and returns the second answer", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("attempts-retry-then-succeed", [
      transportFailure(),
      completed("second answer"),
    ]);

    await expect(dsl.agent("summarize", RETRYABLE_CALL)).resolves.toBe("second answer");
    expect(requests).toHaveLength(2);
    // Identical prompt: a transport retry re-sends the request, it does not repair it.
    expect(requests[0]?.prompt).toBe(requests[1]?.prompt);
    // D5: each physical attempt is a real agent call with its own identity.
    expect(requests.map((request) => request.callId)).toEqual(["call-0001", "call-0002"]);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.map((line) => [line.callId, line.status, line.failureCause])).toEqual([
      ["call-0001", "failed", "host-turn-timeout"],
      ["call-0002", "completed", undefined],
    ]);
  });

  it("gives two interleaved parallel calls their own logical identity", async () => {
    // `parallel()` may run two calls that agree on agent, phase and group, and their physical
    // attempts then interleave. Their labels differ because two CONCURRENT calls sharing one
    // (phase, label) are refused since T-192 W6 — but the journal's grouping key must not
    // depend on an author having chosen distinct labels: the unlabelled pair below agrees on
    // every descriptive field there is. So each logical call carries its own identity and
    // every attempt of it repeats that identity. Without it a reader grouping the journal by
    // the descriptive fields attributes one call's discarded attempt to the other.
    let started = 0;
    let releaseFirstRound: (() => void) | undefined;
    const bothFirstAttemptsStarted = new Promise<void>((resolve) => {
      releaseFirstRound = resolve;
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "attempts-parallel-interleaved",
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        started += 1;
        if (started <= 2) {
          // Hold both first attempts open until each has begun, so the two calls provably
          // interleave rather than running one after the other.
          if (started === 2) releaseFirstRound?.();
          await bothFirstAttemptsStarted;
          return transportFailure();
        }
        return completed(`answer for ${request.callId ?? "?"}`);
      },
    });

    await dsl.parallel([
      () => dsl.agent("advise A", { ...RETRYABLE_CALL, label: "advise a", phase: "advise" }),
      () => dsl.agent("advise B", { ...RETRYABLE_CALL, label: "advise b", phase: "advise" }),
    ]);

    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(4);
    // The first two ends are the two DIFFERENT calls' first attempts — the interleaving.
    expect(ends[0]?.attempt).toBe(1);
    expect(ends[1]?.attempt).toBe(1);
    expect(ends[0]?.logicalCallId).not.toBe(ends[1]?.logicalCallId);
    const byLogicalCall = new Map<string, string[]>();
    for (const line of ends) {
      const key = line.logicalCallId ?? "none";
      byLogicalCall.set(key, [...(byLogicalCall.get(key) ?? []), line.callId ?? "none"]);
    }
    // Two logical calls, two physical attempts each, four distinct children in total.
    expect([...byLogicalCall.values()].map((callIds) => callIds.length)).toEqual([2, 2]);
    expect(new Set([...byLogicalCall.values()].flat()).size).toBe(4);
  });

  it("runs three mapped members from one labelled callsite with distinct runtime slots", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "slot-guard-mapped-three",
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return completed(`answer(${request.prompt})`);
      },
    });

    await expect(
      dsl.parallel(
        ["one", "two", "three"].map(
          (item) => () => dsl.agent(`classify ${item}`, { label: "classify-candidate", phase: "classify" }),
        ),
      ),
    ).resolves.toEqual(["answer(classify one)", "answer(classify two)", "answer(classify three)"]);

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => [request.phase, request.label])).toEqual([
      ["classify", "classify-candidate"],
      ["classify", "classify-candidate"],
      ["classify", "classify-candidate"],
    ]);
    expect(new Set(requests.map((request) => request.workflowSlot?.key)).size).toBe(3);
    expect(requests.map((request) => request.workflowSlot?.rowOccurrence)).toEqual([
      { groupId: "parallel-1", memberIndex: 0 },
      { groupId: "parallel-1", memberIndex: 1 },
      { groupId: "parallel-1", memberIndex: 2 },
    ]);
    const starts = getJournal().filter((line) => line.kind === "agent_start");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((line) => line.slotKey)).size).toBe(3);
  });

  it("refuses duplicate callsites inside one mapped member before a second child", async () => {
    // The slot is the live row. Two branches holding it at once would write one row between
    // them, so the second is refused even though sibling members get their own occurrence.
    let started = 0;
    let releaseFirst: (() => void) | undefined;
    // The first branch stays in flight until the refusal has been journalled, so the two
    // calls provably overlap rather than running one after the other.
    const secondWasRefused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "slot-guard-refuses",
      onEvent(line) {
        if (line.kind === "error" && line.message?.includes("slot is already running") === true) releaseFirst?.();
      },
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        started += 1;
        await secondWasRefused;
        return completed(`answer for ${request.callId ?? "?"}`);
      },
    });

    await expect(
      dsl.parallel([
        () =>
          Promise.all([
            dsl.agent("advise A", { label: "advise", phase: "advise" }),
            dsl.agent("advise B", { label: "advise", phase: "advise" }),
          ]),
      ]),
    ).rejects.toThrow(/phase "advise", label "advise"/u);

    // One child ran, and the journal carries exactly one agent_start for the slot: the
    // refused call left no live row to collide with the survivor.
    expect(started).toBe(1);
    const starts = getJournal().filter((line) => line.kind === "agent_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.label).toBe("advise");
  });

  it("still refuses duplicate callsites outside a mapped context", async () => {
    let started = 0;
    let releaseFirst: (() => void) | undefined;
    const secondWasRefused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "slot-guard-refuses-root",
      onEvent(line) {
        if (line.kind === "error" && line.message?.includes("slot is already running") === true) releaseFirst?.();
      },
      agentRunner: async (): Promise<WorkflowAgentResult> => {
        started += 1;
        await secondWasRefused;
        return completed("answer");
      },
    });

    await expect(
      Promise.all([
        dsl.agent("advise A", { label: "advise", phase: "advise" }),
        dsl.agent("advise B", { label: "advise", phase: "advise" }),
      ]),
    ).rejects.toThrow(/phase "advise", label "advise"/u);
    expect(started).toBe(1);
    expect(getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(1);
  });

  it("frees the slot for the next round, so a loop re-enters it", async () => {
    // Sequential re-entry is what a slot is FOR: the same (phase,label) called twice in a
    // row is one row and two rounds, not a conflict.
    const { dsl, requests, getJournal } = scriptedRuntime("slot-guard-sequential", [
      completed("first"),
      completed("second"),
    ]);

    await expect(dsl.agent("verify", { label: "verify", phase: "verify" })).resolves.toBe("first");
    await expect(dsl.agent("verify", { label: "verify", phase: "verify" })).resolves.toBe("second");

    expect(requests).toHaveLength(2);
    expect(getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(2);
  });

  it("frees the slot after a failure, so the same slot can be retried later", async () => {
    // Released in `finally`, so exhaustion, a thrown host failure and an abort all leave the
    // slot free. A claim that survived its call would refuse the recovery attempt.
    const { dsl } = scriptedRuntime("slot-guard-after-failure", [
      transportFailure(),
      transportFailure(),
      completed("recovered"),
    ]);

    await expect(dsl.agent("summarize", { ...RETRYABLE_CALL, label: "summary", phase: "wrap" })).rejects.toThrow(
      /budget and was aborted/u,
    );
    await expect(dsl.agent("summarize", { label: "summary", phase: "wrap" })).resolves.toBe("recovered");
  });

  it("releases one mapped member slot after throw, cancellation and transport exhaustion", async () => {
    let call = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "slot-guard-mapped-release",
      agentRunner: async (): Promise<WorkflowAgentResult> => {
        call += 1;
        if (call === 1) throw new Error("host threw");
        if (call === 2) {
          return { ok: false, status: "cancelled", failureCause: "cancelled", summary: "aborted", diagnostics: [] };
        }
        if (call === 3 || call === 4) return transportFailure();
        return completed("recovered");
      },
    });

    await expect(
      dsl.parallel([
        async () => {
          await expect(dsl.agent("work", { label: "worker", phase: "map" })).rejects.toThrow("host threw");
          await expect(dsl.agent("work", { label: "worker", phase: "map" })).rejects.toThrow("aborted");
          await expect(dsl.agent("work", { ...RETRYABLE_CALL, label: "worker", phase: "map" })).rejects.toThrow(
            /budget and was aborted/u,
          );
          return dsl.agent("work", { label: "worker", phase: "map" });
        },
      ]),
    ).resolves.toEqual(["recovered"]);
    expect(call).toBe(5);
  });

  it("releases the slot when the run deadline refuses the call", async () => {
    let nowIndex = 0;
    const times = [0, 10, 10];
    const { dsl } = createWorkflowRuntime({
      runId: "slot-guard-deadline-release",
      runtimeMs: 5,
      nowMs: () => times[Math.min(nowIndex++, times.length - 1)]!,
      agentRunner: async () => {
        throw new Error("deadline must stop before child start");
      },
    });

    await expect(dsl.agent("work", { label: "worker", phase: "map" })).rejects.toBeInstanceOf(WorkflowRunDeadlineError);
    await expect(dsl.agent("work", { label: "worker", phase: "map" })).rejects.toBeInstanceOf(WorkflowRunDeadlineError);
  });

  it("leaves the retries of ONE call alone — a transport retry is not a concurrent call", async () => {
    // The claim wraps the logical call, not each physical attempt; a guard around the
    // attempt would refuse the call's own second try.
    const { dsl, requests } = scriptedRuntime("slot-guard-retry", [transportFailure(), completed("second answer")]);

    await expect(dsl.agent("summarize", { ...RETRYABLE_CALL, label: "summary", phase: "wrap" })).resolves.toBe(
      "second answer",
    );
    expect(requests).toHaveLength(2);
  });

  it("lets two unlabelled calls run at once — no label, no slot to share", async () => {
    // The guard's boundary, not a hole in it: an unlabelled call anchors no live row, so
    // there is nothing for a second one to overwrite.
    let concurrent = 0;
    let peak = 0;
    let releaseBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const { dsl } = createWorkflowRuntime({
      runId: "slot-guard-unlabelled",
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        if (concurrent === 2) releaseBoth?.();
        await bothStarted;
        concurrent -= 1;
        return completed(`answer for ${request.callId ?? "?"}`);
      },
    });

    await expect(
      dsl.parallel([
        () => dsl.agent("advise A", { phase: "advise" }),
        () => dsl.agent("advise B", { phase: "advise" }),
      ]),
    ).resolves.toHaveLength(2);
    expect(peak).toBe(2);
  });

  it("writes a journal a reader accepts, retry line included", async () => {
    // Every line the retry path emits is persisted and read back by the same validator the
    // run viewer uses. A field the journal does not allow for its kind would surface here as
    // a structural diagnostic rather than in a live run three weeks later.
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-journal-"));
    const runId = "20260729-120000-abcd";
    let index = 0;
    const results: WorkflowAgentResult[] = [transportFailure(), completed("second answer")];
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async (): Promise<WorkflowAgentResult> => results[Math.min(index++, results.length - 1)]!,
    });

    await expect(dsl.agent("summarize", { ...RETRYABLE_CALL, label: "summary" })).resolves.toBe("second answer");

    const read = readWorkflowRunJournalState(root, runId);
    expect(read.diagnostics).toEqual([]);
    const retryLines = read.lines.filter((line) => line.message?.startsWith("[workflow:retry]") === true);
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]?.message).toContain("host-turn-timeout");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed on exhaustion, naming the LAST cause", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("attempts-exhausted", [
      transportFailure("host-turn-timeout"),
      transportFailure("call-timeout"),
    ]);

    await expect(dsl.agent("summarize", { attempts: 2 })).rejects.toThrow(/budget and was aborted/u);
    expect(requests).toHaveLength(2);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.at(-1)?.failureCause).toBe("call-timeout");
  });

  it.each([
    ["sdk-unavailable"],
    ["cancelled"],
    ["tool-call-budget"],
    ["provider-error"],
    ["unparseable-answer"],
    ["run-policy-blocked"],
    ["unknown-agent"],
    ["workspace-allocation"],
    ["empty-answer"],
    ["answer-too-long"],
    ["script-rejected"],
    ["unclassified"],
  ] as const)("spends no attempt on a %s failure", async (cause) => {
    const { dsl, requests } = scriptedRuntime(`attempts-never-retry-${cause}`, [
      {
        ok: false,
        status: "failed",
        failureCause: cause,
        summary: `failed: ${cause}`,
        diagnostics: [],
        agent: "default",
      },
      completed("must not be reached"),
    ]);

    await expect(dsl.agent("summarize", { attempts: 3 })).rejects.toThrow(new RegExp(cause, "u"));
    expect(requests).toHaveLength(1);
  });

  it("spends no attempt on a result written before the cause field existed", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-legacy", [
      {
        ok: false,
        status: "failed",
        summary: "Child agent turn exceeded its budget.",
        diagnostics: [],
        agent: "default",
      },
      completed("must not be reached"),
    ]);

    await expect(dsl.agent("summarize", { attempts: 3 })).rejects.toThrow(/exceeded its budget/u);
    expect(requests).toHaveLength(1);
  });

  it("never retries a THROWN failure — a throw carries no classified cause", async () => {
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "attempts-thrown",
      agentRunner: async () => {
        children += 1;
        throw new Error("host substrate is gone");
      },
    });

    await expect(dsl.agent("summarize", RETRYABLE_CALL)).rejects.toThrow(/host substrate is gone/u);
    expect(children).toBe(1);
  });

  it("charges every discarded attempt to the run invocation cap", async () => {
    const { dsl, requests } = scriptedRuntime(
      "attempts-cap",
      [transportFailure(), transportFailure(), completed("never reached")],
      { maxTotalAgentInvocations: 2 },
    );

    await expect(dsl.agent("summarize", { attempts: 3 })).rejects.toThrow(
      /exceeded maxTotalAgentInvocations cap of 2/u,
    );
    // Two children ran and both were counted; the third breached the cap before running.
    expect(requests).toHaveLength(2);
  });
});

describe("agent attempts — replay", () => {
  /** A replay controller that records real ordinals so the count can be asserted. */
  function recordingReplay() {
    const begun: string[] = [];
    const recorded: Array<{ ok: boolean }> = [];
    const controller: WorkflowReplayController = {
      beginAgentAttempt: (call) => {
        begun.push(call.canonicalRequest);
        return { replayed: false, reason: "no-record" };
      },
      recordAgentAttempt: (_call, outcome) => {
        recorded.push({ ok: outcome.ok });
      },
      resolveValue: (_kind, produce) => produce(),
      counts: () => ({ replayedCalls: 0, freshCalls: begun.length }),
    };
    return { controller, begun, recorded };
  }

  it("opens ONE replay ordinal per logical call, however many children it took", async () => {
    const { controller, begun, recorded } = recordingReplay();
    const { dsl, requests } = scriptedRuntime(
      "attempts-one-ordinal",
      [transportFailure(), completed("first"), transportFailure(), completed("second")],
      { replay: controller },
    );

    await expect(dsl.agent("stage-1", RETRYABLE_CALL)).resolves.toBe("first");
    await expect(dsl.agent("stage-2", RETRYABLE_CALL)).resolves.toBe("second");

    // Four physical children, two script-level calls, two ordinals. A per-attempt ordinal
    // would shift every later call on resume and trip the divergence latch.
    expect(requests).toHaveLength(4);
    expect(begun).toHaveLength(2);
    expect(recorded).toEqual([{ ok: true }, { ok: true }]);
  });

  it("keeps attempts out of the recorded request so an old recording still replays", async () => {
    const withoutAttempts = recordingReplay();
    const plain = scriptedRuntime("attempts-key-plain", [completed("x")], { replay: withoutAttempts.controller });
    await plain.dsl.agent("summarize", {});

    const withAttempts = recordingReplay();
    const retrying = scriptedRuntime("attempts-key-retry", [completed("x")], { replay: withAttempts.controller });
    await retrying.dsl.agent("summarize", { attempts: 3 });

    expect(withAttempts.begun[0]).toBe(withoutAttempts.begun[0]);
  });
});

describe("agent attempts — one shaped call is one physical child", () => {
  const COUNT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["count"],
    properties: { count: { type: "integer" } },
  };

  /** A host that carries a shaped result on every completed answer. */
  function shapedCompleted(text: string): WorkflowAgentResult {
    return {
      ...completed(text),
      outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
    };
  }

  it("no longer multiplies: a transport retry then ONE accepted shaped answer", async () => {
    // The deleted product. `attempts` used to multiply SCHEMA_MAX_ATTEMPTS, so one script
    // call could cost `attempts x 3` children, each charged to the run's cap. With the
    // shape accepted in-session, a shaped call costs exactly its transport attempts.
    const { controller, begun } = (() => {
      const begunKeys: string[] = [];
      const ctrl: WorkflowReplayController = {
        beginAgentAttempt: (call) => {
          begunKeys.push(call.canonicalRequest);
          return { replayed: false, reason: "no-record" };
        },
        recordAgentAttempt: () => {},
        resolveValue: (_kind, produce) => produce(),
        counts: () => ({ replayedCalls: 0, freshCalls: begunKeys.length }),
      };
      return { controller: ctrl, begun: begunKeys };
    })();

    const sequence: WorkflowAgentResult[] = [
      transportFailure(), // physical attempt 1 — the child never answered
      shapedCompleted('{"count":3}'), // physical attempt 2 — accepted in its own session
    ];
    const { dsl, requests, getJournal } = scriptedRuntime("attempts-grid", sequence, { replay: controller });

    await expect(dsl.agent("count them", { attempts: 2, schema: COUNT_SCHEMA })).resolves.toEqual({ count: 3 });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.callId)).toEqual(["call-0001", "call-0002"]);
    // ONE replay ordinal: the two physical attempts are one logical call, sending the
    // identical prompt, because there is no per-shape-attempt prompt any more.
    expect(begun).toHaveLength(1);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.map((line) => line.status)).toEqual(["failed", "completed"]);
  });

  it("ends the run on transport exhaustion rather than accepting a later answer", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-exhaustion-precedence", [
      transportFailure(),
      transportFailure(),
      shapedCompleted('{"count":3}'),
    ]);

    // The child never answered, so there is nothing to accept.
    await expect(dsl.agent("count them", { attempts: 2, schema: COUNT_SCHEMA })).rejects.toThrow(
      /budget and was aborted/u,
    );
    expect(requests).toHaveLength(2);
  });

  it("reads the option only in the logical call, and keeps the deleted loop deleted", () => {
    // A transport retry that leaked into a shape budget would re-ask a child that ANSWERED,
    // the one thing the retry must never do. Call, physical attempt and shaped output are
    // separate owners now, so this pins the read to the call module by NAME across all five.
    const modules = ["workflow-agent-call.ts", "workflow-agent-attempt.ts", "workflow-agent-contract.ts", "workflow-runtime.ts", "workflow-agent-output.ts"]; // prettier-ignore
    const sourceOf = (name: string): string =>
      readFileSync(path.join(process.cwd(), "extensions", "workflows", "runtime", name), "utf8");
    const logicalStart = sourceOf(modules[0]!)
      .split("\n")
      .findIndex((line) => line.includes("async function runAgentAttempt("));
    expect(logicalStart, "expected the logical call to own runAgentAttempt").toBeGreaterThanOrEqual(0);
    expect(sourceOf("workflow-agent-attempt.ts")).toContain("async function runPhysicalAgentAttempt(");

    // Read exactly once across every module of the agent call, inside the logical call.
    const optionRead = /\bopts\??\.attempts\b/u;
    const reads = modules.flatMap((name) =>
      sourceOf(name)
        .split("\n")
        .flatMap((line, index) => (optionRead.test(line) ? [{ name, index }] : [])),
    );
    expect(reads).toEqual([{ name: modules[0], index: expect.any(Number) as number }]);
    expect(reads[0]!.index).toBeGreaterThan(logicalStart);

    // The legacy text transport is gone from the runtime, not merely unused: a dormant
    // second structured path is a path something will quietly fall back to. Checked across
    // all four modules, so the split cannot be where one of them comes back.
    for (const removed of [
      "SCHEMA_MAX_ATTEMPTS =",
      "function checkAgentSchema",
      "function coerceExactChoiceAnswer",
      "function withSchemaContract",
      "function parseJsonFromText",
      "function stripJsonFences",
      // `schemaMaxLength` is deliberately NOT in this list any more: the runtime names it
      // to refuse it, which is the opposite of implementing it. The behaviour is pinned
      // in `workflow-agent-bounds.test.ts` ("refuses schemaMaxLength by name at the DSL
      // boundary"), where a source-string absence could never have shown that the option
      // was silently dropped instead.
    ]) {
      for (const name of modules) {
        expect(sourceOf(name), `${removed} must stay deleted from ${name}`).not.toContain(removed);
      }
    }
  });
});

describe("agent attempts — a real call-timeout on an artifact-backed child", () => {
  /**
   * The retry loop only ever sees a RETURNED result. Anything that throws inside a physical
   * attempt bypasses it, and evidence adoption throws by design when a fresh child reports a
   * session id without a persisted result envelope.
   *
   * So the whole `attempts` option hung on one field survival: the bridge's per-call fuse
   * built its own failure literal and dropped `boundary.resultArtifact`, which made adoption
   * throw on exactly the failure class `attempts` exists to absorb. Every earlier test drove
   * the bridge alone, declared no retry and adopted no evidence, so all of them passed while
   * the real path could not retry once.
   *
   * This case is deliberately end to end — real workflow script, real bridge, real evidence
   * adoption, real journal, real report — because every layer in that list is where the
   * regression hid.
   */
  it.each([
    {
      caseName: "the host reports cancellation",
      firstResult: {
        status: "cancelled" as const,
        reason: "aborted",
        failureCause: "cancelled" as const,
      },
    },
    {
      caseName: "the child completes after the fuse fired",
      firstResult: {
        status: "completed" as const,
        reason: "late answer",
        text: "late answer",
      },
    },
  ])("retries $caseName and persists one final timeout outcome", async ({ firstResult }) => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-timeout-e2e-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "fused.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("answer", {',
        '    artifact: "review.md",',
        '    label: "scout",',
        '    phase: "review",',
        "    attempts: 2,",
        "    timeoutMs: 30,",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "transport-timeout-e2e" });
    let child = 0;
    const createExecutor = (options: { reportsDir?: string }): AgentExecutor => ({
      async run(request: AgentRunRequest, signal: AbortSignal) {
        child += 1;
        const childId = `child-${String(child)}`;
        expect(options.reportsDir).toBeDefined();
        mkdirSync(options.reportsDir!, { recursive: true });
        const tracePath = path.join(options.reportsDir!, `${childId}.jsonl`);
        writeFileSync(tracePath, `${JSON.stringify({ type: "session", id: childId })}\n`, "utf8");
        const childEvidence = {
          childSession: { id: childId, createdAt: "now", metadata: {} },
          childTrace: { path: tracePath, format: "pi-session-jsonl" as const, childSessionId: childId },
        };
        // First child hangs until the CALL fuse aborts it — a real timeout, not a
        // hand-written `failureCause`. It still exported a transcript and still had its
        // envelope written, exactly like a real aborted child.
        if (child === 1) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            ...firstResult,
            agentName: request.agent?.name ?? "sub-agent",
            diagnostics: [],
            lifecycleEntryIds: [],
            ...childEvidence,
          };
        }
        return {
          status: "completed" as const,
          agentName: request.agent?.name ?? "sub-agent",
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
          ...childEvidence,
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "fused",
      createExecutor,
    });

    // The run reached its answer, which it cannot do if adoption threw past the retry loop.
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(child).toBe(2);

    // The discarded attempt's evidence was ADOPTED, not lost: transcript and result envelope
    // for call-0001 are both in the run's own artifact index.
    const artifactsDir = workflowRunArtifactsDir(result.runDir);
    const index = JSON.parse(readFileSync(path.join(artifactsDir, "index.json"), "utf8")) as {
      artifacts: { kind: string; callId?: string; relativePath: string }[];
    };
    const firstAttempt = index.artifacts.filter((entry) => entry.callId === "call-0001");
    expect(firstAttempt.map((entry) => entry.kind).sort()).toEqual(["result", "transcript"]);

    // The DURABLE per-call record carries the machine-readable cause, and it is the FINAL
    // one: the host saw a cancellation, the bridge's own fuse owns the classification.
    const readEnvelope = (callId: string): { version: string; status: string; failureCause?: string } => {
      const record = index.artifacts.find((entry) => entry.callId === callId && entry.kind === "result");
      expect(record, `no result envelope adopted for ${callId}`).toBeDefined();
      const wrapper = JSON.parse(readFileSync(path.join(artifactsDir, record!.relativePath), "utf8")) as {
        content: string;
      };
      return JSON.parse(wrapper.content) as { version: string; status: string; failureCause?: string };
    };
    const persisted = readEnvelope("call-0001");
    expect(persisted.version).toBe("locus.agent.run-result.v2");
    expect(persisted.status).toBe("failed");
    expect(persisted.failureCause).toBe("call-timeout");
    // A completed attempt has no cause to persist, and must not invent one.
    expect(readEnvelope("call-0002").failureCause).toBeUndefined();

    // The journal agrees with the envelope, rather than the two disagreeing about one call.
    const journal = readWorkflowRunJournalState(root, result.runId);
    expect(journal.diagnostics).toEqual([]);
    expect(
      journal.lines
        .filter((line) => line.kind === "agent_end")
        .map((line) => [line.callId, line.attempt, line.attempts, line.status, line.failureCause]),
    ).toEqual([
      ["call-0001", 1, 2, "failed", "call-timeout"],
      ["call-0002", 2, 2, "completed", undefined],
    ]);

    rmSync(root, { recursive: true, force: true });
  });
});
