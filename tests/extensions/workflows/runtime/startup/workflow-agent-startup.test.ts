import { performance } from "node:perf_hooks";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  AGENT_STARTUP_STAGES,
  agentStartupMarkProblem,
} from "../../../../../extensions/_shared/agent-runtime/session/startup-format.js";
import { workflowStartupTimeoutMs } from "../../../../../extensions/_shared/agent-runtime/session/startup.js";
import {
  createAgentSdkSessionExecutor,
  type CreateAgentSessionFactory,
  type SdkAgentSessionLike,
  type SdkAgentSessionEventLike,
} from "../../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { createWorkflowAgentRunner } from "../../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import type {
  WorkflowAgentResult,
  WorkflowAgentRunner,
} from "../../../../../extensions/workflows/runtime/workflow-agent-contract.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
} from "../../../../../extensions/workflows/runtime/workflow-journal.js";
import * as modelSettings from "../../../../../extensions/_shared/model/model-settings.js";
import {
  workflowJournalLineProblem,
  type WorkflowJournalLine,
} from "../../../../../extensions/workflows/runtime/workflow-journal-format.js";
import { createHarness } from "../../../../test-harness.js";

const sdk = vi.hoisted(() => ({
  resourceGate: undefined as Promise<void> | undefined,
  createGate: undefined as Promise<void> | undefined,
  session: undefined as SdkAgentSessionLike | undefined,
  supplied: undefined as Record<string, unknown> | undefined,
  creates: 0,
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: undefined,
  SessionManager: { create: () => ({}) },
  DefaultResourceLoader: class {
    async reload() {
      await sdk.resourceGate;
    }
  },
  async createAgentSession(options: Record<string, unknown>) {
    sdk.creates++;
    sdk.supplied = options;
    await sdk.createGate;
    return { session: sdk.session };
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "locus-startup-"));
  sdk.resourceGate = undefined;
  sdk.createGate = undefined;
  sdk.supplied = undefined;
  sdk.creates = 0;
  agentLiveStore.reset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubEnv("LOCUS_PI_WORKFLOW_STARTUP_TIMEOUT_MS", "1000");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  agentLiveStore.reset();
  rmSync(root, { recursive: true, force: true });
});

function stack(
  responseGate?: Promise<void>,
  rawResponse = false,
  hooks: {
    onEvent?: (line: WorkflowJournalLine) => void;
    createSession?: CreateAgentSessionFactory;
    signal?: AbortSignal;
  } = {},
) {
  const model = getModel("openai", "gpt-4o-mini");
  let emit: (event: SdkAgentSessionEventLike) => void = () => {};
  const onResponse = vi.fn();
  const onProviderStreamEvent = vi.fn();
  const stream = vi.fn(async (_model, _context, options) => {
    await responseGate;
    if (rawResponse) await options?.onProviderStreamEvent?.({ type: "response.created" }, model);
    else await options?.onResponse?.({ status: 200, headers: {} }, model);
    return createAssistantMessageEventStream();
  });
  const prompt = vi.fn(async () => {
    emit({ type: "agent_start" });
    await sdk.session!.agent!.streamFunction!(model, normalizeContext({ messages: [] }), {
      onResponse,
      onProviderStreamEvent,
      timeoutMs: 42,
      maxRetries: 0,
    });
    emit({ type: "agent_end" });
  });
  const dispose = vi.fn();
  sdk.session = {
    sessionId: "startup-child",
    model,
    agent: { streamFunction: stream },
    subscribe(listener) {
      emit = listener;
      return () => {
        emit = () => {};
      };
    },
    prompt,
    getSessionStats: () => ({ sessionId: "startup-child", toolCalls: 0, toolResults: 0 }),
    getLastAssistantText: () => "same answer",
    exportToJsonl: (dir) => {
      const file = path.join(dir!, "child.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "startup-child" }) + "\n");
      return file;
    },
    dispose,
    abort: async () => {},
  };
  const h = createHarness(root, { sessionId: "startup-parent" });
  const createSession = hooks.createSession;
  const runner = createWorkflowAgentRunner({
    pi: h.pi,
    ctx: h.ctx,
    signal: hooks.signal ?? new AbortController().signal,
    ...(createSession === undefined
      ? {}
      : {
          createExecutor: ({ live, ...options }) =>
            createAgentSdkSessionExecutor({ ...options, ...(live === undefined ? {} : { live }), createSession }),
        }),
  });
  const sink = createWorkflowJournalSink(root, "startup-run");
  let result: WorkflowAgentResult | undefined;
  const reached = new Map<string, ReturnType<typeof deferred>>();
  const observedRunner: WorkflowAgentRunner = async (req, onStartup, epoch) => {
    result = await runner(
      req,
      (mark) => {
        onStartup?.(mark);
        reached.get(mark.stage)?.resolve();
      },
      epoch,
    );
    return result;
  };
  const runtime = createWorkflowRuntime({
    runId: "startup-run",
    journal: sink,
    maxConcurrentAgents: 1,
    ...(hooks.onEvent === undefined ? {} : { onEvent: hooks.onEvent }),
    agentRunner: Object.assign(
      observedRunner,
      runner.captureStartupEpoch === undefined ? {} : { captureStartupEpoch: runner.captureStartupEpoch },
    ),
  });
  return {
    ...runtime,
    prompt,
    dispose,
    onResponse,
    onProviderStreamEvent,
    stream,
    result: () => result!,
    stage: (name: string) => {
      const gate = deferred();
      reached.set(name, gate);
      return gate.promise;
    },
  };
}

describe("workflow startup timing without any provider calls", () => {
  it.each([false, true])("writes all marks and preserves answer/hooks/options (raw response: %s)", async (raw) => {
    const s = stack(undefined, raw);
    await expect(s.dsl.agent("work")).resolves.toBe("same answer");
    const marks = s.result().startup!;
    expect(marks.map((mark) => mark.stage)).toEqual(AGENT_STARTUP_STAGES);
    for (const mark of marks) expect(agentStartupMarkProblem(mark)).toBeUndefined();
    expect(marks[0]).toMatchObject({ wallMs: 0, cpuUserMs: 0, cpuSystemMs: 0, eventLoopDelayMs: 0 });
    for (let i = 1; i < marks.length; i++) expect(marks[i]!.elapsedMs).toBeGreaterThanOrEqual(marks[i - 1]!.elapsedMs);
    expect(sdk.supplied).not.toHaveProperty("startup");
    const envelope = JSON.parse(JSON.parse(readFileSync(s.result().resultArtifact!, "utf8")).content);
    expect(envelope.startup).toEqual(marks);
    const lines = s.getJournal();
    expect(lines.filter((line) => line.startup).map((line) => line.startup)).toEqual(marks);
    expect(lines.findIndex((line) => line.kind === "agent_start")).toBeLessThan(
      lines.findIndex((line) => line.startup !== undefined),
    );
    for (const line of lines) expect(workflowJournalLineProblem(line, "startup-run")).toBeUndefined();
    const persisted = readWorkflowRunJournalState(root, "startup-run");
    expect(persisted.diagnostics).toEqual([]);
    expect(persisted.lines.filter((line) => line.startup).map((line) => line.startup)).toEqual(marks);
    expect(s.stream.mock.lastCall?.[2]).toMatchObject({ timeoutMs: 42, maxRetries: 0 });
    expect(s.onResponse).toHaveBeenCalledTimes(raw ? 0 : 1);
    expect(s.onProviderStreamEvent).toHaveBeenCalledTimes(raw ? 1 : 0);
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it.each(["resources_load_start", "create_session_start"])(
    "fails a stalled %s, retains the last stage and prevents a late model request",
    async (stage) => {
      const gate = deferred();
      if (stage === "resources_load_start") sdk.resourceGate = gate.promise;
      else sdk.createGate = gate.promise;
      const s = stack();
      const reached = s.stage(stage);
      const pending = s.dsl.agent("work", { attempts: 2, timeoutMs: 10_000 }).catch((error) => error);
      await reached;
      await vi.advanceTimersByTimeAsync(1001);
      const error = await pending;
      expect(error.result).toMatchObject({ failureCause: "startup-timeout", status: "failed" });
      expect(error.message).toContain(`last completed stage: ${stage}`);
      expect(s.result().startup!.at(-1)?.stage).toBe(stage);
      const envelope = JSON.parse(JSON.parse(readFileSync(s.result().resultArtifact!, "utf8")).content);
      expect(envelope).toMatchObject({ failureCause: "startup-timeout", startup: s.result().startup });
      expect(s.getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(1);
      const count = s.getJournal().length;
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prompt).not.toHaveBeenCalled();
      expect(s.getJournal()).toHaveLength(count);
      expect(s.dispose).toHaveBeenCalledTimes(stage === "create_session_start" ? 1 : 0);
      expect(sdk.creates).toBe(stage === "create_session_start" ? 1 : 0);
    },
  );

  it("stops the startup deadline at session readiness while retaining the first delayed provider response", async () => {
    const gate = deferred();
    const s = stack(gate.promise);
    const sent = s.stage("first_provider_request");
    const pending = s.dsl.agent("work");
    await sent;
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.result()).toBeUndefined();
    gate.resolve();
    await expect(pending).resolves.toBe("same answer");
    expect(s.result().startup!.at(-1)?.stage).toBe("first_provider_response");
  });

  it("preserves a shorter overall call timeout during session creation", async () => {
    const gate = deferred();
    sdk.createGate = gate.promise;
    const s = stack();
    const reached = s.stage("create_session_start");
    const pending = s.dsl.agent("work", { timeoutMs: 100 }).catch((error) => error);
    await reached;
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).result.failureCause).toBe("call-timeout");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prompt).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it("also bounds model resolution before the runner exists", async () => {
    const entered = deferred();
    const h = createHarness(root);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      resolveModel: () => {
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const marks: string[] = [];
    const pending = runner({ prompt: "work", model: "fixture/model" }, (mark) => marks.push(mark.stage));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;
    expect(result.failureCause).toBe("startup-timeout");
    expect(result.summary).toContain("model_resolve_start");
    expect(result.startup!.map((mark) => mark.stage)).toEqual(marks);
    expect(sdk.creates).toBe(0);
  });

  it.each(["model_roles_load_start", "model_resolve_start"])(
    "cancels a stalled %s immediately and clears every timer",
    async (stage) => {
      const entered = deferred();
      const h = createHarness(root);
      const controller = new AbortController();
      if (stage === "model_roles_load_start") {
        vi.spyOn(modelSettings, "loadModelRolesState").mockImplementation(() => {
          entered.resolve();
          return new Promise<never>(() => {});
        });
      }
      const runner = createWorkflowAgentRunner({
        pi: h.pi,
        ctx: h.ctx,
        signal: controller.signal,
        resolveModel: () => {
          entered.resolve();
          return new Promise<never>(() => {});
        },
      });
      const pending = runner({ prompt: "work", model: "fixture/model" });
      await entered.promise;
      controller.abort(new Error("operator cancelled"));
      const result = await pending;
      expect(result).toMatchObject({ status: "cancelled", failureCause: "cancelled" });
      expect(result.startup!.at(-1)?.stage).toBe(stage);
      expect(sdk.creates).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["deadline", "abort"])(
    "disposes an already-resolved session exactly once when %s wins before assignment",
    async (stop) => {
      const controller = new AbortController();
      if (stop === "deadline") vi.stubEnv("LOCUS_PI_WORKFLOW_STARTUP_TIMEOUT_MS", "100");
      const s = stack(undefined, false, {
        signal: controller.signal,
        createSession: () => {
          if (stop === "deadline") {
            const started = performance.now();
            while (performance.now() - started < 150) {
              /* Synchronous factory overrun before any promise continuation. */
            }
          } else controller.abort();
          return Promise.resolve({ session: sdk.session! });
        },
      });
      const error = await s.dsl.agent("work").catch((error) => error);
      expect(error.result.failureCause).toBe(stop === "deadline" ? "startup-timeout" : "cancelled");
      await vi.advanceTimersByTimeAsync(0);
      expect(s.dispose).toHaveBeenCalledOnce();
      expect(s.prompt).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("includes synchronous admission handling in elapsed time, process CPU and event-loop delay without reordering the journal", async () => {
    let clock = 0;
    let user = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(process, "cpuUsage").mockImplementation(() => ({ user, system: 0 }));
    const s = stack(undefined, false, {
      onEvent: (line) => {
        if (line.kind === "agent_start") {
          clock += 50;
          user += 5000;
        }
      },
    });
    await expect(s.dsl.agent("work")).resolves.toBe("same answer");
    expect(s.result().startup![1]).toMatchObject({
      stage: "model_roles_load_start",
      elapsedMs: 50,
      wallMs: 50,
      cpuUserMs: 5,
      eventLoopDelayMs: 40,
    });
    const lines = s.getJournal();
    expect(lines.findIndex((line) => line.kind === "agent_start")).toBeLessThan(
      lines.findIndex((line) => line.startup !== undefined),
    );
  });

  it("refuses an admission handler that consumed the startup limit before roles or session creation", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const s = stack(undefined, false, {
      onEvent: (line) => {
        if (line.kind === "agent_start") clock += 1500;
      },
    });
    const error = await s.dsl.agent("work").catch((error) => error);
    expect(error.result.failureCause).toBe("startup-timeout");
    expect(error.message).toContain("last completed stage: agent_start");
    expect(sdk.creates).toBe(0);
    expect(s.prompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("excludes queue time from the snapshot passed to the next admitted child", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const gate = deferred();
    const s = stack(gate.promise);
    const sent = s.stage("first_provider_request");
    const first = s.dsl.agent("first");
    await sent;
    const second = s.dsl.agent("second");
    expect(s.getJournal().filter((line) => line.kind === "agent_queued")).toHaveLength(2);
    expect(s.getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(1);
    clock = 2000;
    gate.resolve();
    await expect(first).resolves.toBe("same answer");
    await expect(second).resolves.toBe("same answer");
    expect(s.result().startup!.every((mark) => mark.elapsedMs === 0)).toBe(true);
    const queue = s.getJournal().filter((line) => line.kind === "agent_queued");
    expect(queue).toHaveLength(2);
  });

  it("keeps the 120-second default and rejects invalid environment settings", () => {
    expect(workflowStartupTimeoutMs({})).toBe(120_000);
    expect(workflowStartupTimeoutMs({ LOCUS_PI_WORKFLOW_STARTUP_TIMEOUT_MS: "3500" })).toBe(3500);
    for (const value of ["", "0", "-1", "1.5", "Infinity", "9007199254740992"]) {
      expect(() => workflowStartupTimeoutMs({ LOCUS_PI_WORKFLOW_STARTUP_TIMEOUT_MS: value })).toThrow(
        /positive safe integer/,
      );
    }
  });
});
