import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import workflows from "../../../../extensions/workflows/index.js";
import {
  announceCommandWorkflowStart,
  persistCommandWorkflowTranscript,
  WORKFLOW_RUN_CUSTOM_TYPE,
} from "../../../../extensions/workflows/command/receipts.js";
import { createWorkflowTranscript } from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import { createHarness, emit, type Harness } from "../../../test-harness.js";

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[1]>;

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-receipts-"));
  roots.push(root);
  const h = createHarness(root, options);
  delete h.ctx.ui.custom;
  workflows(h.pi);
  return h;
}

async function run(h: Harness, command: string): Promise<void> {
  await h.commands.get("workflows")!.handler(command, h.ctx);
}

function expectLastRejection(h: Harness, code: string, target: string): void {
  expect(h.sentMessages.at(-1)).toMatchObject({
    message: {
      customType: WORKFLOW_RUN_CUSTOM_TYPE,
      display: true,
      details: { eventKind: "workflow_rejected", code, target },
    },
    options: { triggerTurn: false },
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("workflow command receipts", () => {
  it.each([
    ["run alpha --resume", "missing_resume_id", "alpha"],
    ["run alpha --output-dir", "missing_output_dir", "alpha"],
    ["run task/draft --run-name", "missing_run_name", "task/draft"],
    ["run definitely-missing", "workflow_not_found", "definitely-missing"],
  ] as const)("persists a typed pre-start rejection for %s", async (command, code, target) => {
    const h = harness();

    await run(h, command);

    expectLastRejection(h, code, target);
  });

  it("does not steer a typed rejection into a busy Pi response", async () => {
    const h = harness({ isStreaming: true });

    await run(h, "run live-smoke");

    expect(h.sentMessages).toEqual([]);
    expect(h.widgets.get("workflows")).toContain("Pi is busy streaming");
  });

  it("persists a typed rejection when another workflow owns the session", async () => {
    const gate = deferred();
    const runScript = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async () => {
      await gate.promise;
      return {
        runId: "busy-owner",
        runDir: "/tmp/busy-owner",
        ok: true,
        result: null,
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/busy-owner/runtime/result.json" },
      };
    });
    const h = harness();
    try {
      await run(h, "run live-smoke");
      await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(1));

      await run(h, "run task/plan");

      expectLastRejection(h, "workflow_run_busy", "task/plan");
    } finally {
      gate.resolve();
    }
  });

  it("persists a typed rejection after the extension session shuts down", async () => {
    const h = harness();
    await emit(h, "session_start");
    await emit(h, "session_shutdown");

    await run(h, "run live-smoke");

    expectLastRejection(h, "session_stale", "live-smoke");
  });

  it("persists a typed rejection when the runner fails before publishing a run identity", async () => {
    vi.spyOn(runner, "runWorkflowScript").mockRejectedValue(new Error("runner rejected before identity"));
    const h = harness({ mode: "print" });

    await run(h, "run live-smoke");

    expectLastRejection(h, "runner_prestart_failed", "live-smoke");
  });

  it.each(["busy", "unreadable"] as const)(
    "does not steer a late pre-identity runner failure when the host is %s",
    async (hostState) => {
      const gate = deferred();
      vi.spyOn(runner, "runWorkflowScript").mockImplementation(async () => {
        await gate.promise;
        throw new Error("late runner rejection");
      });
      const h = harness();
      await run(h, "run live-smoke");
      if (hostState === "busy") h.setStreaming(true);
      else
        h.ctx.isIdle = () => {
          throw new Error("idle state unavailable");
        };

      gate.resolve();
      await vi.waitFor(() => expect(h.widgets.get("workflows")).toContain("late runner rejection"));

      expect(h.sentMessages).toEqual([]);
      expect(h.customMessageDeliveries).toEqual([]);
    },
  );

  it("publishes absolute durable paths in the typed start receipt", () => {
    const h = harness();
    const runDir = "/repo/.pi/locus-pi/runs/run-paths";
    const announcement = createWorkflowTranscript(h.ctx, "live-smoke", "command").start("run-paths", runDir)!;

    expect(announceCommandWorkflowStart(h.pi, h.ctx, announcement)).toBe(true);
    expect(h.sentMessages.at(-1)?.message.details).toEqual({
      eventKind: "workflow_start",
      runId: "run-paths",
      runDir,
      journalPath: path.join(runDir, "runtime", "journal.ndjson"),
      resultPath: path.join(runDir, "runtime", "result.json"),
    });
  });

  it("degrades a start receipt safely when the host idle probe throws", () => {
    const h = harness();
    const announcement = createWorkflowTranscript(h.ctx, "live-smoke", "command").start(
      "run-unreadable",
      "/repo/.pi/locus-pi/runs/run-unreadable",
    )!;
    h.ctx.isIdle = () => {
      throw new Error("idle state unavailable");
    };

    expect(announceCommandWorkflowStart(h.pi, h.ctx, announcement)).toBe(false);
    expect(h.sentMessages).toEqual([]);
  });

  it("owns an async start-send rejection without an unhandled promise", async () => {
    const h = harness();
    const announcement = createWorkflowTranscript(h.ctx, "live-smoke", "command").start(
      "run-async-start-failure",
      "/repo/.pi/locus-pi/runs/run-async-start-failure",
    )!;
    h.pi.sendMessage = vi.fn(() => Promise.reject(new Error("async start send failed"))) as never;

    expect(announceCommandWorkflowStart(h.pi, h.ctx, announcement)).toBe(true);
    await vi.waitFor(() => expect(h.notifications.at(-1)).toContain("start receipt was not published"));
  });

  it("publishes a terminal receipt without waitForIdle in one-shot JSON mode", async () => {
    const h = harness({ mode: "json" });
    delete h.ctx.waitForIdle;
    const transcript = createWorkflowTranscript(h.ctx, "headless", "command");
    transcript.start("run-headless-idle", "/tmp/run-headless-idle");
    const completion = transcript.finish({
      runId: "run-headless-idle",
      runDir: "/tmp/run-headless-idle",
      ok: true,
      result: "done",
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-headless-idle/runtime/result.json" },
    });

    expect(await persistCommandWorkflowTranscript(h.pi, h.ctx, completion)).toBe(true);
    expect(h.sentMessages.at(-1)?.message.details).toMatchObject({
      eventKind: "workflow_end",
      resultPersisted: true,
    });
    expect(h.waitForIdleCalls).toBe(0);
  });

  it("rejects an attached JSON command when its terminal receipt cannot be published", async () => {
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-rpc-send-failure", runDir: "/tmp/run-rpc-send-failure" });
      return {
        runId: "run-rpc-send-failure",
        runDir: "/tmp/run-rpc-send-failure",
        ok: true,
        result: null,
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-rpc-send-failure/runtime/result.json" },
      };
    });
    const h = harness({ mode: "json" });
    const sendMessage = h.pi.sendMessage!.bind(h.pi);
    h.pi.sendMessage = vi.fn((message, options) => {
      if (message.details?.eventKind === "workflow_end") throw new Error("terminal send failed");
      return sendMessage(message, options);
    });

    await expect(run(h, "run live-smoke")).rejects.toThrow("Workflow terminal receipt was not published");
    expect(h.sentMessages.at(0)?.message.details).toMatchObject({ eventKind: "workflow_start" });
  });

  it("marks the canonical result path unpersisted after a post-identity runner escape", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "broken", "command");
    const completion = transcript.fail(new Error("runner escaped"), "run-escaped", "/tmp/run-escaped");

    expect(completion).toMatchObject({
      workflowStatus: "failed",
      resultPath: "/tmp/run-escaped/runtime/result.json",
      resultPersisted: false,
    });
  });
});
