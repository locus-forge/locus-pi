import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentExecutor } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

/**
 * `timeoutMs` — the per-call bound the runtime owns so
 * a workflow script does not re-implement them. Both fail closed: neither ever
 * resolves to a partial or oversized answer.
 */

function runtimeWith(runId: string, answer: string) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      return {
        ok: true,
        status: "completed",
        summary: "done",
        text: answer,
        diagnostics: [],
        agent: request.agent,
      };
    },
  });
  return { ...runtime, requests };
}

function runtimeWithTurns(runId: string, maxTurns: number) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    defaultMaxTurns: maxTurns,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
    },
  });
  return { ...runtime, requests };
}

describe("per-call agent bounds", () => {
  it("passes timeoutMs to the child request so the bridge can arm the fuse", async () => {
    const { dsl, requests } = runtimeWith("agent-timeout-request", "fine");

    await expect(dsl.agent("work", { timeoutMs: 60_000 })).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(60_000);
  });

  it.each([
    [0, /timeoutMs must be a positive safe integer/u],
    [-1, /timeoutMs must be a positive safe integer/u],
    [1.5, /timeoutMs must be a positive safe integer/u],
  ])("rejects a timeoutMs that could never bound a real call (%s)", async (timeoutMs, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-timeout-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("work", { timeoutMs })).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("accepts a timeoutMs longer than one Node timer instead of refusing it", async () => {
    // 48 hours. The old policy ceiling rejected this because a single `setTimeout`
    // clamps above 2^31-1 ms; the fuse is a chain of representable waits now, so a
    // deliberately long deadline is honoured rather than turned into an authoring error.
    const { dsl, requests } = runtimeWith("agent-timeout-node-limit", "fine");

    await expect(dsl.agent("work", { timeoutMs: 48 * 60 * 60 * 1000 })).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(48 * 60 * 60 * 1000);
  });

  it("hands a long answer to the caller instead of refusing it", async () => {
    // The removed axis. A completed child's answer is never refused for its length:
    // that judged a result already paid for, and it truncated real discovery queues.
    const long = "0123456789".repeat(200_000);
    const { dsl, getJournal } = runtimeWith("agent-answer-long", long);

    await expect(dsl.agent("summarize")).resolves.toBe(long);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.status).toBe("completed");
  });

  it("refuses maxAnswerChars by name, with its replacement, instead of ignoring it", async () => {
    const { dsl, requests } = runtimeWith("agent-answer-removed-option", "fine");

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("summarize", { maxAnswerChars: 4 }),
    ).rejects.toThrow(/agent maxAnswerChars was removed.*output\.maxLength/su);
    // Refused at declaration time: an author who believed a bound applied must hear so
    // before a child is spent, never afterwards and never silently.
    expect(requests).toHaveLength(0);
  });

  it("refuses schemaMaxLength by name at the DSL boundary instead of dropping it", async () => {
    // It used to be dropped while the return contract was assembled: the call RAN, the
    // answer came back unbounded, and the author kept believing a ceiling applied. A
    // removed option has to be heard, and the only place that can happen is the public
    // boundary the author wrote it on.
    const { dsl, requests } = runtimeWith("agent-schema-max-length-removed", "fine");

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("summarize", {
        output: { type: "string" },
        schemaMaxLength: 1,
      }),
    ).rejects.toThrow(/agent schemaMaxLength was removed.*maxLength\/maxItems inside the schema/su);
    expect(requests).toHaveLength(0);
  });

  it("still refuses an empty answer: that is a decomposition signal, not a size", async () => {
    const { dsl } = runtimeWith("agent-answer-empty", "   ");
    await expect(dsl.agent("summarize")).rejects.toThrow(/Agent result text is empty/u);
  });

  it("aborts the child itself when the fuse expires, instead of abandoning it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-agent-bounds-"));
    const agents = path.join(root, ".agents", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      path.join(agents, "reviewer.md"),
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read, grep\n---\nReview carefully.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-timeout" });
    let childSawAbort = false;
    const createExecutor = (): AgentExecutor => ({
      // A child that never finishes on its own: only the fuse can end this call.
      async run(_request, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        childSawAbort = true;
        return {
          status: "cancelled" as const,
          agentName: "reviewer",
          reason: "aborted",
          text: "",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "timeout-run",
      createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "timeout-run", agentRunner: runner });

    await expect(dsl.agent("hang forever", { agent: "reviewer", timeoutMs: 25, label: "hang" })).rejects.toThrow(
      /exceeded its 25 ms timeout/u,
    );
    // The child was aborted, not left running with nobody to read its answer.
    expect(childSawAbort).toBe(true);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends[0]?.status).toBe("failed");
    expect(ends[0]?.failureCause).toBe("call-timeout");
    // And the run says in the operator's words WHY it stopped. A deadline the author
    // set is not a statement that the child answered badly, and the same wording is
    // used for every axis so one grep finds every budget stop in a run.
    const stop = getJournal().find((line) => line.message?.includes("stopped by budget"));
    expect(stop).toMatchObject({ kind: "log", source: "runtime" });
    expect(stop?.message).toContain("stopped by budget timeoutMs");
    expect(stop?.message).toContain("Data received so far is kept");
  });

  it("keeps two identical prompts on one recorded request", async () => {
    const first = runtimeWith("agent-answer-key-a", "0123456789");
    await first.dsl.agent("summarize");
    const second = runtimeWith("agent-answer-key-b", "0123456789");
    await second.dsl.agent("summarize");

    expect(second.requests[0]).toEqual(first.requests[0]);
  });
});

/**
 * The per-child axes a RUN may declare, and the single deadline that replaced two
 * racing ones. There are no package defaults here: every number in this block is
 * one a run or a call stated out loud.
 */
describe("run-declared per-child bounds", () => {
  it("applies a run-declared timeoutMs to a call that declares none", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "default-timeout",
      defaultTimeoutMs: 600_000,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(600_000);
  });

  it("lets an explicit per-call fuse narrow the run-declared one", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "narrowed-timeout",
      defaultTimeoutMs: 600_000,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work", { timeoutMs: 1_000 })).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(1_000);
  });

  it("arms no fuse at all when no default is configured, so old embedders are unchanged", async () => {
    const { dsl, requests } = runtimeWith("no-default-timeout", "fine");

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBeUndefined();
  });

  it("hands the host the declared fuse unchanged — one deadline, no derivation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-turn-budget-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Turn budget agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-turn-budget" });
    const factoryOptions: Array<{ childTimeoutMs?: number; cliRequestTimeoutMs?: number }> = [];
    const createExecutor = (o: { childTimeoutMs?: number }): AgentExecutor => {
      factoryOptions.push({ ...o });
      return {
        async run(request) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "fine",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      };
    };
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "turn-budget-run",
      createExecutor,
    });
    const { dsl } = createWorkflowRuntime({
      runId: "turn-budget-run",
      defaultTimeoutMs: 600_000,
      defaultMaxTurns: 20,
      agentRunner: runner,
    });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    // The divide-by-turns, add-a-margin, multiply-back round trip is gone. The host
    // receives exactly what the run declared, so the two clocks cannot disagree and
    // no product can overflow Node's maximum delay.
    expect(factoryOptions[0]?.childTimeoutMs).toBe(600_000);
    expect(factoryOptions[0]?.cliRequestTimeoutMs).toBe(600_000);
    rmSync(root, { recursive: true, force: true });
  });

  it("arms no host deadline when the call has no fuse: unbounded means unbounded", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-turn-budget-absent-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Turn budget agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-turn-budget-absent" });
    const factoryOptions: Array<{ childTimeoutMs?: number; cliRequestTimeoutMs?: number }> = [];
    const createExecutor = (o: { childTimeoutMs?: number }): AgentExecutor => {
      factoryOptions.push({ ...o });
      return {
        async run(request) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "fine",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      };
    };
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "turn-budget-absent",
      createExecutor,
    });
    const { dsl } = createWorkflowRuntime({ runId: "turn-budget-absent", agentRunner: runner });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(factoryOptions[0]?.childTimeoutMs).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("maxTurns as a budget axis", () => {
  it("carries a run-declared turn budget on a call that declares nothing", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "default-turns",
      defaultMaxTurns: 1000,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.maxTurns).toBe(1000);
  });

  it("carries no turn budget at all when neither the run nor the call declared one", async () => {
    const { dsl, requests } = runtimeWith("no-turns", "fine");

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.maxTurns).toBeUndefined();
  });

  it("lets a call declare its own turn budget above the former host ceiling", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "declared-turns",
      defaultMaxTurns: 1000,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work", { maxTurns: 1000 })).resolves.toBe("fine");
    await expect(dsl.agent("work", { maxTurns: 1 })).resolves.toBe("fine");
    expect(requests.map((request) => request.maxTurns)).toEqual([1000, 1]);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid maxTurns with zero child calls (%s)",
    async (value) => {
      let calls = 0;
      const { dsl } = createWorkflowRuntime({
        runId: "clamped-turns",
        defaultMaxTurns: 1000,
        agentRunner: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      });

      await expect(dsl.agent("work", { maxTurns: value })).rejects.toThrow(
        /agent maxTurns must be a positive safe integer/u,
      );
      expect(calls).toBe(0);
    },
  );

  it("reaches the child request, so the bridge stops choosing the turn budget", async () => {
    // The canonical-key consequence is proven in workflow-replay.test.ts, where a
    // recorded answer is or is not served; comparing request objects here would
    // pass whether or not `maxTurns` joined the key.
    const five = runtimeWithTurns("turns-five", 5);
    await five.dsl.agent("work");
    const two = runtimeWithTurns("turns-two", 2);
    await two.dsl.agent("work");

    expect(five.requests[0]?.maxTurns).toBe(5);
    expect(two.requests[0]?.maxTurns).toBe(2);
  });

  it("gives the host the same deadline whatever the declared turn count is", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-turns-sdk-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Turns agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-turns-sdk" });
    const factoryOptions: Array<{ childTimeoutMs?: number; cliRequestTimeoutMs?: number }> = [];
    const createExecutor = (o: { childTimeoutMs?: number }): AgentExecutor => {
      factoryOptions.push({ ...o });
      return {
        async run(request) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "fine",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      };
    };
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "turns-sdk-run",
      createExecutor,
    });
    const { dsl } = createWorkflowRuntime({
      runId: "turns-sdk-run",
      defaultTimeoutMs: 60_000,
      agentRunner: runner,
    });

    // Turn count and wall clock are separate axes. Multiplying one by the other was
    // what produced a deadline nobody declared and, at the old defaults, one Node
    // could not represent.
    await expect(dsl.agent("work", { maxTurns: 2 })).resolves.toBe("fine");
    await expect(dsl.agent("work", { maxTurns: 2000 })).resolves.toBe("fine");
    expect(factoryOptions.map((o) => o.childTimeoutMs)).toEqual([60_000, 60_000]);
    rmSync(root, { recursive: true, force: true });
  });
});
