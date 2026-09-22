import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type {
  RunWorkflowScriptOptions,
  RunWorkflowScriptResult,
} from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createWorkflowCommandLauncher } from "../../../../extensions/workflows/launch/workflow-command-launcher.js";
import { createHarness } from "../../../test-harness.js";

function completedResult(runId: string): RunWorkflowScriptResult {
  return {
    runId,
    runDir: `/tmp/${runId}`,
    ok: true,
    result: { summary: "done" },
    disposition: { status: "completed" },
    journal: [],
    resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
  };
}

describe("workflow command launcher", () => {
  it.each(["command", "tool"] as const)("shutdown cancels and drains a %s run before host exit", async (kind) => {
    const harness = createHarness();
    let signal!: AbortSignal;
    let persist!: () => void;
    const persistence = new Promise<void>((resolve) => {
      persist = resolve;
    });
    const observer = {
      onRunStart: vi.fn(),
      onEvent: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
      onFinally: vi.fn(),
      onRejected: vi.fn(),
    };
    const execute = async (abort: AbortSignal) => {
      signal = abort;
      await new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }));
      await persistence;
      return completedResult("shutdown-run");
    };
    const launcher = createWorkflowCommandLauncher({
      pi: harness.pi,
      runScript: (options) => execute(options.signal!),
      createObserver: () => observer,
      onTerminal: vi.fn(),
    });
    launcher.startSession(harness.ctx);
    if (kind === "command") launcher.launch({ ctx: harness.ctx, scriptRef: "hold" });
    else launcher.attach(harness.ctx, new AbortController().signal, (background) => execute(background.signal));
    await vi.waitFor(() => expect(signal).toBeDefined());
    let exited = false;
    const shutdown = launcher.shutdown().then(() => {
      exited = true;
    });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(exited).toBe(false);
    expect(launcher.launch({ ctx: harness.ctx, scriptRef: "late" })).toEqual({ status: "stale" });
    persist();
    await shutdown;
    expect(exited).toBe(true);
    expect(observer.onResult).not.toHaveBeenCalled();
  });

  it("routes ordinary and continuation requests through one runner and observer lifecycle", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    const terminals: string[] = [];
    let nextRun = 0;
    let launcher: ReturnType<typeof createWorkflowCommandLauncher>;
    const runScript = vi.fn(async (options: RunWorkflowScriptOptions) => {
      const runId = `launcher-run-${++nextRun}`;
      options.onRunStart?.({ runId, runDir: `/tmp/${runId}` });
      return completedResult(runId);
    });
    launcher = createWorkflowCommandLauncher({
      pi: harness.pi,
      runScript,
      createObserver(request) {
        return {
          onRunStart({ runId, runDir }) {
            observed.push(`start:${request.scriptRef}:${runId}:${runDir}`);
          },
          onEvent: () => {},
          onResult(result) {
            observed.push(`result:${request.scriptRef}:${result.runId}`);
            observed.push(`settled:${request.scriptRef}:${String(launcher.hasActiveCommandRun())}`);
          },
          onError(error) {
            observed.push(`error:${String(error)}`);
          },
          onFinally() {
            observed.push(`finally:${request.scriptRef}`);
          },
          onRejected() {
            observed.push(`rejected:${request.scriptRef}`);
          },
        };
      },
      onTerminal: (request) => terminals.push(request.scriptRef),
    });
    launcher.startSession(harness.ctx);

    expect(launcher.launch({ ctx: harness.ctx, scriptRef: "ordinary" })).toEqual({ status: "started" });
    await vi.waitFor(() => expect(terminals).toEqual(["ordinary"]));
    expect(
      launcher.launch({
        ctx: harness.ctx,
        scriptRef: "continued",
        input: "answer",
        outputDir: "tmp/reviews/review-1",
        continuation: { originRunId: "source-run", artifactRefs: [] },
      }),
    ).toEqual({ status: "started" });
    await vi.waitFor(() => expect(terminals).toEqual(["ordinary", "continued"]));

    const scriptPathRef = "extensions/workflows/examples/task/plan.workflow.mjs";
    expect(
      launcher.launch({
        ctx: harness.ctx,
        scriptRef: scriptPathRef,
        target: { kind: "scriptPath", ref: scriptPathRef, source: "project", path: path.resolve(scriptPathRef) },
      }),
    ).toEqual({ status: "started" });
    await vi.waitFor(() => expect(terminals).toEqual(["ordinary", "continued", scriptPathRef]));

    expect(runScript).toHaveBeenCalledTimes(3);
    expect(runScript.mock.calls[0]?.[0]).toMatchObject({ name: "ordinary" });
    expect(runScript.mock.calls[1]?.[0]).toMatchObject({
      name: "continued",
      input: "answer",
      outputDir: "tmp/reviews/review-1",
      continuation: { originRunId: "source-run", artifactRefs: [] },
    });
    expect(runScript.mock.calls[2]?.[0]).toMatchObject({ scriptPath: scriptPathRef });
    expect(runScript.mock.calls[2]?.[0]).toMatchObject({
      targetBinding: { kind: "scriptPath", ref: scriptPathRef, source: "project", path: path.resolve(scriptPathRef) },
    });
    expect(observed).toEqual([
      "start:ordinary:launcher-run-1:/tmp/launcher-run-1",
      "result:ordinary:launcher-run-1",
      "settled:ordinary:true",
      "finally:ordinary",
      "start:continued:launcher-run-2:/tmp/launcher-run-2",
      "result:continued:launcher-run-2",
      "settled:continued:true",
      "finally:continued",
      `start:${scriptPathRef}:launcher-run-3:/tmp/launcher-run-3`,
      `result:${scriptPathRef}:launcher-run-3`,
      `settled:${scriptPathRef}:true`,
      `finally:${scriptPathRef}`,
    ]);
  });

  it("keeps the command slot busy until terminal callbacks drain", async () => {
    const harness = createHarness();
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const launcher = createWorkflowCommandLauncher({
      pi: harness.pi,
      runScript: async (options) => {
        options.onRunStart?.({ runId: "first-run", runDir: "/tmp/first-run" });
        return completedResult("first-run");
      },
      createObserver: () => ({
        onRunStart() {},
        onEvent() {},
        async onResult() {
          await resultGate;
        },
        onError() {},
        onFinally() {},
        onRejected() {},
      }),
      onTerminal() {},
    });
    launcher.startSession(harness.ctx);

    expect(launcher.launch({ ctx: harness.ctx, scriptRef: "first" })).toEqual({ status: "started" });
    await vi.waitFor(() => expect(launcher.hasActiveCommandRun()).toBe(true));
    expect(launcher.launch({ ctx: harness.ctx, scriptRef: "second" })).toEqual({
      status: "busy",
      owner: "settling workflow callbacks",
    });

    releaseResult();
    await launcher.awaitActive();
    expect(launcher.hasActiveCommandRun()).toBe(false);
  });

  it("owns detached observer callback failures and releases the command slot", async () => {
    const harness = createHarness();
    const unhandled = vi.fn();
    const onTerminal = vi.fn();
    process.on("unhandledRejection", unhandled);
    const launcher = createWorkflowCommandLauncher({
      pi: harness.pi,
      runScript: async (options) => {
        options.onRunStart?.({ runId: "callback-error", runDir: "/tmp/callback-error" });
        return completedResult("callback-error");
      },
      createObserver: () => ({
        onRunStart() {},
        onEvent() {},
        onResult() {
          throw new Error("observer failed");
        },
        onError() {},
        onFinally() {},
        onRejected() {},
      }),
      onTerminal,
    });
    launcher.startSession(harness.ctx);

    try {
      expect(launcher.launch({ ctx: harness.ctx, scriptRef: "first" })).toEqual({ status: "started" });
      await vi.waitFor(() => expect(harness.notifications.at(-1)).toContain("observer failed"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(launcher.awaitActive()).rejects.toThrow("observer failed");
      expect(launcher.hasActiveCommandRun()).toBe(false);
      expect(onTerminal).not.toHaveBeenCalled();
      expect(launcher.launch({ ctx: harness.ctx, scriptRef: "second" })).toEqual({ status: "started" });
      await expect(launcher.awaitActive()).rejects.toThrow("observer failed");
      expect(onTerminal).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
