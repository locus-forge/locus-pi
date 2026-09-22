import { describe, expect, it, vi } from "vitest";
import {
  workflowBackgroundRunRegistry,
  type WorkflowBackgroundRunContext,
} from "../../../../extensions/workflows/run/background-run-registry.js";
import workflows from "../../../../extensions/workflows/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  type WorkflowProgressComponent,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { createHarness, emit } from "../../../test-harness.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await Promise.resolve();
}

describe("workflow background run registry", () => {
  it("owns one observed terminal promise and reports idempotent stopping honestly", async () => {
    const registry = workflowBackgroundRunRegistry();
    const lease = registry.startSession(`/tmp/background-${Date.now()}`, "session-one");
    const gate = deferred<string>();
    let context: WorkflowBackgroundRunContext | undefined;
    const launched = registry.launch(lease, async (run) => {
      context = run;
      run.setRunId("run-owned");
      return gate.promise;
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw new Error("expected launch");
    await waitFor(() => context !== undefined);

    expect(registry.launch(lease, async () => "conflict")).toMatchObject({ ok: false, reason: "active-run" });
    expect(registry.stop(lease, "run-owned")).toMatchObject({ status: "requested" });
    expect(context?.signal.aborted).toBe(true);
    expect(context?.signal.reason).toEqual({ kind: "operator_stop" });
    expect(registry.stop(lease, "last")).toMatchObject({ status: "already-requested" });

    gate.resolve("durable settlement");
    await expect(launched.run.terminal).resolves.toEqual({ status: "fulfilled", value: "durable settlement" });
    expect(registry.stop(lease, "run-owned")).toMatchObject({
      status: "settled",
      run: { state: "settled", stopRequested: true },
    });
  });

  it("keeps stable-session ownership across reload until an abort-ignoring predecessor settles", async () => {
    const registry = workflowBackgroundRunRegistry();
    const projectRoot = `/tmp/background-reload-${Date.now()}`;
    const oldLease = registry.startSession(projectRoot, "session-reload");
    const gate = deferred<never>();
    let oldContext: WorkflowBackgroundRunContext | undefined;
    const oldRun = registry.launch(oldLease, async (context) => {
      oldContext = context;
      return gate.promise;
    });
    expect(oldRun.ok).toBe(true);
    if (!oldRun.ok) throw new Error("expected launch");
    await waitFor(() => oldContext !== undefined);

    registry.shutdown(oldLease);
    expect(registry.isCurrent(oldLease)).toBe(false);
    expect(oldContext?.signal.aborted).toBe(true);
    expect(oldContext?.signal.reason).toEqual({ kind: "session_shutdown" });
    expect(oldContext?.isCurrent()).toBe(false);

    const replacementLease = registry.startSession(projectRoot, "session-reload");
    expect(registry.launch(replacementLease, async () => "overlap")).toMatchObject({
      ok: false,
      reason: "active-run",
    });

    gate.reject(new Error("old run rejected after shutdown"));
    await expect(oldRun.run.terminal).resolves.toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: "old run rejected after shutdown" }),
    });

    const replacement = registry.launch(replacementLease, async () => "replacement complete");
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error("expected replacement launch after predecessor settlement");
    await expect(replacement.run.terminal).resolves.toEqual({ status: "fulfilled", value: "replacement complete" });
  });

  it("tracks tool runs without occupying the slash slot and stops either origin through one authority", async () => {
    const registry = workflowBackgroundRunRegistry();
    const lease = registry.startSession(`/tmp/background-tool-${Date.now()}`, "session-tool");
    const toolGate = deferred<string>();
    const commandGate = deferred<string>();
    let toolContext: WorkflowBackgroundRunContext | undefined;
    let commandContext: WorkflowBackgroundRunContext | undefined;
    const toolRun = registry.attach(lease, new AbortController().signal, async (context) => {
      toolContext = context;
      context.setRunId("tool-run");
      return toolGate.promise;
    });
    expect(toolRun.ok).toBe(true);
    const commandRun = registry.launch(lease, async (context) => {
      commandContext = context;
      context.setRunId("command-run");
      return commandGate.promise;
    });
    expect(commandRun.ok).toBe(true);
    if (!toolRun.ok || !commandRun.ok) throw new Error("expected both origins to launch");
    await waitFor(() => toolContext !== undefined && commandContext !== undefined);

    expect(registry.active(lease)).toMatchObject({ runId: "command-run" });
    expect(registry.stop(lease, "tool-run")).toMatchObject({ status: "requested", run: { runId: "tool-run" } });
    expect(toolContext?.signal.reason).toEqual({ kind: "operator_stop" });
    expect(commandContext?.signal.aborted).toBe(false);

    registry.shutdown(lease);
    expect(commandContext?.signal.reason).toEqual({ kind: "session_shutdown" });
    toolGate.resolve("tool settled");
    commandGate.resolve("command settled");
    await Promise.all([toolRun.run.terminal, commandRun.run.terminal]);
  });

  it("makes stop last prefer live work over a newer settled record", async () => {
    const registry = workflowBackgroundRunRegistry();
    const lease = registry.startSession(`/tmp/background-live-last-${Date.now()}`, "session-live-last");
    const liveGate = deferred<string>();
    let liveContext: WorkflowBackgroundRunContext | undefined;
    const live = registry.attach(lease, new AbortController().signal, async (context) => {
      liveContext = context;
      context.setRunId("older-live");
      return liveGate.promise;
    });
    const settled = registry.attach(lease, new AbortController().signal, async (context) => {
      context.setRunId("newer-settled");
      return "done";
    });
    expect(live.ok && settled.ok).toBe(true);
    if (!live.ok || !settled.ok) throw new Error("expected attached runs");
    await settled.run.terminal;
    await waitFor(() => liveContext !== undefined);

    expect(registry.stop(lease, "last")).toMatchObject({
      status: "requested",
      run: { runId: "older-live" },
    });
    expect(liveContext?.signal.reason).toEqual({ kind: "operator_stop" });
    liveGate.resolve("settled");
    await live.run.terminal;
  });

  it("bounds settled history and retired sessions without pruning active ownership or lying about last", async () => {
    const registry = workflowBackgroundRunRegistry();
    const prefix = `/tmp/background-churn-${Date.now()}-`;
    const activeLease = registry.startSession(`${prefix}active`, "protected");
    const activeGate = deferred<string>();
    const active = registry.launch(activeLease, async (context) => {
      context.setRunId("protected-active");
      return activeGate.promise;
    });
    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error("expected protected active launch");

    let newestRoot = "";
    let newestSession = "";
    for (let index = 0; index < 45; index += 1) {
      newestRoot = `${prefix}${index}`;
      newestSession = `settled-${index}`;
      const lease = registry.startSession(newestRoot, newestSession);
      const settled = registry.launch(lease, async (context) => {
        context.setRunId(`settled-run-${index}`);
        return index;
      });
      expect(settled.ok).toBe(true);
      if (!settled.ok) throw new Error(`expected churn launch ${index}`);
      await settled.run.terminal;
      registry.shutdown(lease);
    }

    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("locus-pi.workflow-background-runs.v1")
    ] as {
      sessions: Map<string, unknown>;
      runs: Map<string, { lease: { projectRoot: string }; state: string }>;
    };
    expect([...state.sessions.keys()].filter((key) => key.startsWith(prefix))).toEqual([
      `${prefix}active\u0000protected`,
    ]);
    expect(
      [...state.runs.values()].filter(
        (record) => record.lease.projectRoot.startsWith(prefix) && record.state === "settled",
      ),
    ).toHaveLength(40);

    expect(registry.launch(activeLease, async () => "overlap")).toMatchObject({
      ok: false,
      reason: "active-run",
    });
    expect(registry.stop(activeLease, "last")).toMatchObject({
      status: "requested",
      run: { runId: "protected-active", state: "stopping" },
    });
    expect(registry.launch(activeLease, async () => "still-overlap")).toMatchObject({
      ok: false,
      reason: "active-run",
    });

    const newestLease = registry.startSession(newestRoot, newestSession);
    expect(registry.stop(newestLease, "last")).toMatchObject({
      status: "settled",
      run: { runId: "settled-run-44", state: "settled" },
    });

    activeGate.resolve("protected settled");
    await active.run.terminal;
    const successor = registry.launch(activeLease, async () => "successor");
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error("expected launch after protected settlement");
    await expect(successor.run.terminal).resolves.toEqual({ status: "fulfilled", value: "successor" });
  });
});

describe("workflow slash background lifecycle", () => {
  it("uses the runtime session manager identity across a reload while its predecessor remains pending", async () => {
    const root = `/tmp/workflow-runtime-session-${Date.now()}`;
    const sessionId = `manager-session-${Date.now()}`;
    const first = createHarness(root, { sessionId });
    first.ctx.cwd = root;
    delete first.ctx.session;
    workflows(first.pi);
    const predecessorGate = deferred<runner.RunWorkflowScriptResult>();
    const successorGate = deferred<runner.RunWorkflowScriptResult>();
    const requests: Array<Parameters<typeof runner.runWorkflowScript>[0]> = [];
    let replacement: ReturnType<typeof createHarness> | undefined;
    type RegistryRecord = {
      lease: { projectRoot: string; sessionId: string };
      runId?: string;
      state: string;
      terminal: Promise<{ status: string; value?: runner.RunWorkflowScriptResult; error?: unknown }>;
    };
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("locus-pi.workflow-background-runs.v1")
    ] as { runs: Map<string, RegistryRecord> };
    const sessionRecords = (): RegistryRecord[] =>
      [...state.runs.values()].filter(
        (record) => record.lease.projectRoot === root && record.lease.sessionId === sessionId,
      );
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      const predecessor = requests.length === 1;
      request.onRunStart?.({
        runId: predecessor ? "runtime-shaped-pending" : "runtime-shaped-successor",
        runDir: predecessor ? "/tmp/runtime-shaped-pending" : "/tmp/runtime-shaped-successor",
      });
      return predecessor ? predecessorGate.promise : successorGate.promise;
    });
    try {
      expect(first.ctx.sessionManager?.getSessionId?.()).toBe(sessionId);
      await expect(emit(first, "session_start")).resolves.toBeDefined();
      await first.commands.get("workflows")!.handler("run live-smoke", first.ctx);
      await waitFor(() => requests.length === 1);
      expect(spy).toHaveBeenCalledTimes(1);

      expect(sessionRecords()).toEqual([expect.objectContaining({ state: "running" })]);

      const predecessorShutdown = emit(first, "session_shutdown", { reason: "reload" });
      expect(requests[0]?.signal.aborted).toBe(true);

      replacement = createHarness(root, { sessionId });
      replacement.ctx.cwd = root;
      delete replacement.ctx.session;
      workflows(replacement.pi);
      await expect(emit(replacement, "session_start")).resolves.toBeDefined();
      await replacement.commands.get("workflows")!.handler("run live-smoke", replacement.ctx);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(replacement.widgets.get("workflows")).toContain("still running or stopping");
      expect(sessionRecords().filter((record) => record.state !== "settled")).toHaveLength(1);

      const predecessorRecord = sessionRecords().find((record) => record.runId === "runtime-shaped-pending");
      if (predecessorRecord === undefined) throw new Error("Expected detached predecessor registry record.");
      predecessorGate.resolve({
        runId: "runtime-shaped-pending",
        runDir: "/tmp/runtime-shaped-pending",
        ok: false,
        result: null,
        error: "settled after reload conflict proof",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/runtime-shaped-pending/result.json" },
      });
      await expect(predecessorRecord.terminal).resolves.toMatchObject({
        status: "fulfilled",
        value: { runId: "runtime-shaped-pending" },
      });
      await predecessorShutdown;
      expect(predecessorRecord.state).toBe("settled");

      await replacement.commands.get("workflows")!.handler("run live-smoke", replacement.ctx);
      await waitFor(() => requests.length === 2);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(requests[1]?.signal.aborted).toBe(false);
      const successorRecord = sessionRecords().find((record) => record.runId === "runtime-shaped-successor");
      if (successorRecord === undefined) throw new Error("Expected replacement successor registry record.");
      expect(successorRecord.state).toBe("running");

      successorGate.resolve({
        runId: "runtime-shaped-successor",
        runDir: "/tmp/runtime-shaped-successor",
        ok: true,
        result: { summary: "replacement workflow completed" },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/runtime-shaped-successor/result.json" },
      });
      await expect(successorRecord.terminal).resolves.toMatchObject({
        status: "fulfilled",
        value: { runId: "runtime-shaped-successor", ok: true },
      });
      expect(successorRecord.state).toBe("settled");
      await emit(replacement, "session_shutdown", { reason: "test cleanup" });
    } finally {
      predecessorGate.resolve({
        runId: "runtime-shaped-pending",
        runDir: "/tmp/runtime-shaped-pending",
        ok: false,
        result: null,
        error: "settled after reload conflict proof",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/runtime-shaped-pending/result.json" },
      });
      successorGate.resolve({
        runId: "runtime-shaped-successor",
        runDir: "/tmp/runtime-shaped-successor",
        ok: false,
        result: null,
        error: "successor settled during failure cleanup",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/runtime-shaped-successor/result.json" },
      });
      await emit(first, "session_shutdown", { reason: "failure cleanup" });
      if (replacement !== undefined) await emit(replacement, "session_shutdown", { reason: "failure cleanup" });
      await Promise.all(sessionRecords().map((record) => record.terminal));
      spy.mockRestore();
    }
  });

  it("exposes explicit whole-run stop and keeps repeated stop requests idempotent", async () => {
    const harness = createHarness(`/tmp/workflow-stop-${Date.now()}`);
    workflows(harness.pi);
    const gate = deferred<runner.RunWorkflowScriptResult>();
    let signal: AbortSignal | undefined;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      signal = request.signal;
      request.onRunStart?.({ runId: "run-stop", runDir: "/tmp/run-stop" });
      return gate.promise;
    });
    try {
      await harness.commands.get("workflows")!.handler("run live-smoke", harness.ctx);
      await waitFor(() => signal !== undefined);

      await harness.commands.get("workflows")!.handler("stop last", harness.ctx);
      expect(signal?.aborted).toBe(true);
      expect(harness.widgets.get("workflows")).toContain("Stop requested for workflow run-stop");
      expect(harness.widgets.get("workflows")).toContain("Settlement is still pending");

      await harness.commands.get("workflows")!.handler("stop run-stop", harness.ctx);
      expect(harness.widgets.get("workflows")).toContain("already stopping");
      expect(harness.widgets.get("workflows")).toContain("Settlement is still pending");

      gate.resolve({
        runId: "run-stop",
        runDir: "/tmp/run-stop",
        ok: false,
        result: null,
        error: "cancelled",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-stop/result.json" },
      });
      await waitFor(() => harness.sentMessages.length === 1);
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      await harness.commands.get("workflows")!.handler("stop run-stop", harness.ctx);
      expect(harness.widgets.get("workflows")).toContain("has already settled");
      expect(harness.widgets.get("workflows")).toContain("no stop signal was sent");
    } finally {
      spy.mockRestore();
    }
  });

  it("stops a tool-launched workflow through the same /workflows stop command", async () => {
    const harness = createHarness(`/tmp/workflow-tool-stop-${Date.now()}`);
    workflows(harness.pi);
    const gate = deferred<runner.RunWorkflowScriptResult>();
    let request: Parameters<typeof runner.runWorkflowScript>[0] | undefined;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (candidate) => {
      request = candidate;
      candidate.onRunStart?.({ runId: "tool-run-stop", runDir: "/tmp/tool-run-stop" });
      return gate.promise;
    });
    try {
      const toolResult = harness.tools
        .get("workflow")!
        .execute("tool-call", { name: "live-smoke" }, new AbortController().signal, () => void 0, harness.ctx);
      await waitFor(() => request !== undefined);

      await harness.commands.get("workflows")!.handler("stop tool-run-stop", harness.ctx);

      expect(request?.signal.aborted).toBe(true);
      expect(request?.signal.reason).toEqual({ kind: "operator_stop" });
      expect(harness.widgets.get("workflows")).toContain("Stop requested for workflow tool-run-stop");
      gate.resolve({
        runId: "tool-run-stop",
        runDir: "/tmp/tool-run-stop",
        ok: false,
        disposition: { status: "cancelled", reason: "operator_stop" },
        result: null,
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/tool-run-stop/result.json" },
      });
      await expect(toolResult).resolves.toMatchObject({ isError: true });
    } finally {
      gate.resolve({
        runId: "tool-run-stop",
        runDir: "/tmp/tool-run-stop",
        ok: false,
        result: null,
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/tool-run-stop/result.json" },
      });
      spy.mockRestore();
    }
  });

  it("returns the editor before settlement, rejects a concurrent run, and suppresses delayed post-shutdown writes", async () => {
    const root = `/tmp/workflow-command-${Date.now()}`;
    const harness = createHarness(root);
    harness.ctx.hasUI = true;
    workflows(harness.pi);
    const runnerGate = deferred<runner.RunWorkflowScriptResult>();
    let request: Parameters<typeof runner.runWorkflowScript>[0] | undefined;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (candidate) => {
      request = candidate;
      candidate.onRunStart?.({ runId: "run-delayed", runDir: "/tmp/run-delayed" });
      return runnerGate.promise;
    });
    try {
      await harness.commands.get("workflows")!.handler("run live-smoke", harness.ctx);
      await waitFor(() => request !== undefined);
      expect(spy).toHaveBeenCalledTimes(1);

      await harness.commands.get("workflows")!.handler("run live-smoke again", harness.ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(harness.widgets.get("workflows")).toContain("settling workflow callbacks");

      const widgetSpy = vi.spyOn(harness.ctx.ui, "setWidget");
      const statusSpy = vi.spyOn(harness.ctx.ui, "setStatus");
      const notifySpy = vi.spyOn(harness.ctx.ui, "notify");
      const sendSpy = vi.fn();
      harness.pi.sendMessage = sendSpy;
      const shutdown = emit(harness, "session_shutdown", { reason: "reload" });
      expect(request?.signal.aborted).toBe(true);
      widgetSpy.mockClear();
      statusSpy.mockClear();
      notifySpy.mockClear();
      sendSpy.mockClear();

      request?.onEvent?.({ ts: "late", runId: "run-delayed", kind: "phase", phase: "late phase" });
      runnerGate.resolve({
        runId: "run-delayed",
        runDir: "/tmp/run-delayed",
        ok: true,
        result: { summary: "settled after shutdown" },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-delayed/result.json" },
      });
      await shutdown;
      await waitFor(() => spy.mock.results[0]?.type === "return");
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();

      expect(widgetSpy).not.toHaveBeenCalled();
      expect(statusSpy).not.toHaveBeenCalled();
      expect(notifySpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("disposes the session-owned progress listener immediately even when the runner ignores abort", async () => {
    const harness = createHarness(`/tmp/workflow-panel-shutdown-${Date.now()}`);
    harness.ctx.hasUI = true;
    workflows(harness.pi);
    const runnerGate = deferred<runner.RunWorkflowScriptResult>();
    let request: Parameters<typeof runner.runWorkflowScript>[0] | undefined;
    const before = agentLiveStore.emitter.listenerCount("change");
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (candidate) => {
      request = candidate;
      candidate.onRunStart?.({ runId: "run-panel-shutdown", runDir: "/tmp/run-panel-shutdown" });
      return runnerGate.promise;
    });
    try {
      await harness.commands.get("workflows")!.handler("run live-smoke", harness.ctx);
      await waitFor(() => request !== undefined);
      expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);

      const requestRender = vi.fn();
      const factory = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY) as (
        tui: { requestRender(): void; terminal: { rows: number; columns: number } },
        theme: unknown,
      ) => WorkflowProgressComponent;
      factory({ requestRender, terminal: { rows: 30, columns: 120 } }, {});
      request?.onEvent?.({
        ts: "before-shutdown",
        runId: "run-panel-shutdown",
        kind: "agent_start",
        agent: "reviewer",
        label: "still running",
      });
      requestRender.mockClear();

      const shutdown = emit(harness, "session_shutdown", { reason: "reload" });
      expect(request?.signal.aborted).toBe(true);
      expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);

      const row = [...agentLiveStore.rows.values()].find((candidate) => candidate.label.includes("still running"));
      expect(row).toBeDefined();
      if (row !== undefined) agentLiveStore.patch(row.id, { label: "mutated after shutdown" });
      expect(requestRender).not.toHaveBeenCalled();

      runnerGate.resolve({
        runId: "run-panel-shutdown",
        runDir: "/tmp/run-panel-shutdown",
        ok: false,
        result: null,
        error: "settled after shutdown",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-panel-shutdown/result.json" },
      });
      await shutdown;
      await waitFor(() => spy.mock.results[0]?.type === "return");
      expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    } finally {
      spy.mockRestore();
      agentLiveStore.reset();
    }
  });
});
