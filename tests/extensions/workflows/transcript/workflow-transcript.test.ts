import { describe, expect, it } from "vitest";
import { createWorkflowTranscript } from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import {
  announceCommandWorkflowStart,
  persistCommandWorkflowTranscript,
  WORKFLOW_RESULT_CUSTOM_TYPE,
  WORKFLOW_RUN_CUSTOM_TYPE,
} from "../../../../extensions/workflows/command/receipts.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { compactWorkflowParentRows } from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveRowId,
} from "../../../../extensions/workflows/runtime/workflow-live.js";
import type { RunWorkflowScriptResult } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

describe("workflow persistent transcript", () => {
  it("persists an already-idle command digest without waiting or starting a model turn", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "/private/path/demo.workflow.mjs", "command");
    transcript.start("run-1", "/tmp/run-1");
    const completion = transcript.finish({
      runId: "run-1",
      runDir: "/tmp/run-1",
      ok: true,
      result: { summary: "done" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-1/result.json" },
    });

    expect(harness.sentMessages).toEqual([]);
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.content).toEqual(
      expect.stringContaining("workflow demo.workflow.mjs · run #run1 · finished"),
    );
    expect(harness.sentMessages[0]?.message.content).toEqual(
      expect.stringContaining("✓ workflow demo.workflow.mjs finished · done"),
    );
    for (const entry of harness.sentMessages) {
      expect(entry.message).toMatchObject({ customType: WORKFLOW_RUN_CUSTOM_TYPE, display: true });
      expect(String(entry.message.content).length).toBeLessThanOrEqual(4096);
      expect(entry.options).toEqual({ triggerTurn: false });
      expect(entry.options).not.toHaveProperty("deliverAs");
    }
    expect(harness.waitForIdleCalls).toBe(0);
    expect(harness.customMessageDeliveries).toEqual(["append"]);
    expect(harness.notifications).toEqual([]);
  });

  it("separates the reusable workflow workspace from unique run evidence", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "plan", "tool");
    transcript.start("20260806-020358-988a", "/repo/.pi/locus-pi/runs/20260806-020358-988a");
    const completion = transcript.finish({
      runId: "20260806-020358-988a",
      runDir: "/repo/.pi/locus-pi/runs/20260806-020358-988a",
      ok: true,
      result: "Plan ready",
      workspaceDir: "/repo/tmp/checkout-fix",
      workspaceDirRelative: "tmp/checkout-fix",
      primaryFile: {
        relativePath: "plan.md",
        absolutePath: "/repo/tmp/checkout-fix/plan.md",
        sha256: "abc123",
        bytes: 42,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/20260806-020358-988a/runtime/result.json" },
    });

    expect(completion.digest).toContain("workspace: /repo/tmp/checkout-fix");
    expect(completion.digest).not.toContain("workspace reuse:");
    expect(completion.digest).toContain("primary file: /repo/tmp/checkout-fix/plan.md");
    expect(completion.digest).toContain("journal: /repo/.pi/locus-pi/runs/20260806-020358-988a/runtime/journal.ndjson");
  });

  it("persists exactly one final command failure in one workflow_end digest", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "broken", "command");
    const errorLine: WorkflowJournalLine = { ts: "t", runId: "run-2", kind: "error", message: "same failure" };
    transcript.start("run-2", "/tmp/run-2");
    transcript.event(errorLine);
    const failedRun: RunWorkflowScriptResult = {
      runId: "run-2",
      runDir: "/tmp/run-2",
      ok: false,
      result: null,
      error: "same failure",
      journal: [errorLine],
      resultPersistence: { ok: true, path: "/tmp/run-2/result.json" },
    };
    const firstCompletion = transcript.finish(failedRun);
    expect(transcript.finish(failedRun)).toBe(firstCompletion);
    await persistCommandWorkflowTranscript(harness.pi, harness.ctx, firstCompletion);

    const failures = harness.sentMessages.filter((entry) => String(entry.message.content).includes("same failure"));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message.details).toMatchObject({ eventKind: "workflow_end", runId: "run-2" });
    expect(String(failures[0]?.message.content)).toContain("failed");
  });

  it("queues exact prose before the bounded terminal receipt for protocol callers", async () => {
    const harness = createHarness(process.cwd(), { mode: "json" });
    const transcript = createWorkflowTranscript(harness.ctx, "plan", "command");
    transcript.start("20260731-215554-ea90", "/tmp/run-ea90");
    const exactResult = `# Implementation Plan\n\n${"Full result line. ".repeat(400)}\nUNTRUNCATED_RESULT_SENTINEL`;
    const resultTextPath = "/tmp/run-ea90/outputs/workflow-result.md";
    const completion = transcript.finish({
      runId: "20260731-215554-ea90",
      runDir: "/tmp/run-ea90",
      ok: true,
      result: exactResult,
      resultTextPath,
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-ea90/runtime/result.json" },
    });

    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages).toHaveLength(2);
    expect(harness.sentMessages[0]?.message).toMatchObject({
      customType: WORKFLOW_RESULT_CUSTOM_TYPE,
      display: true,
      details: {
        eventKind: "workflow_result",
        runId: "20260731-215554-ea90",
        resultTextPath,
      },
    });
    expect(harness.sentMessages[0]?.message.content).toBe(exactResult);
    expect(harness.sentMessages[1]?.message).toMatchObject({
      customType: WORKFLOW_RUN_CUSTOM_TYPE,
      display: true,
      details: { eventKind: "workflow_end", runId: "20260731-215554-ea90", resultPersisted: true },
    });
    expect(harness.sentMessages[1]?.message.content).not.toContain("UNTRUNCATED_RESULT_SENTINEL");
    expect(String(harness.sentMessages[0]?.message.content).length).toBeGreaterThan(4096);
    expect(harness.sentMessages.map((entry) => entry.options)).toEqual([
      { triggerTurn: false },
      { triggerTurn: false },
    ]);
    expect(harness.customMessageDeliveries).toEqual(["append", "append"]);
    expect(harness.waitForIdleCalls).toBe(0);
  });

  it("renders waiting and operator cancellation as distinct terminal outcomes", () => {
    const awaiting = createWorkflowTranscript(createHarness().ctx, "review", "tool");
    awaiting.start("awaiting-run", "/tmp/awaiting-run");
    const awaitingCompletion = awaiting.finish({
      runId: "awaiting-run",
      runDir: "/tmp/awaiting-run",
      ok: true,
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
      result: { mode: "prepared" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/awaiting-run/result.json" },
    });
    expect(awaitingCompletion.digest).toContain("◐ workflow review awaiting operator");
    expect(awaitingCompletion.digest).toContain("review clarification required");
    expect(awaitingCompletion.digest).not.toContain("finished");

    const cancelled = createWorkflowTranscript(createHarness().ctx, "review", "tool");
    cancelled.start("cancelled-run", "/tmp/cancelled-run");
    const cancelledCompletion = cancelled.finish({
      runId: "cancelled-run",
      runDir: "/tmp/cancelled-run",
      ok: false,
      disposition: { status: "cancelled", reason: "operator_stop" },
      result: null,
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/cancelled-run/result.json" },
    });
    expect(cancelledCompletion.digest).toContain("⊘ workflow review cancelled");
    expect(cancelledCompletion.digest).toContain("cancelled by operator");
    expect(cancelledCompletion.digest).not.toContain("completed");
  });

  it("preserves semantic failure summary and unresolved row ids without a technical error", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "semantic-stop", "tool");
    transcript.start("semantic-failure", "/tmp/semantic-failure");
    const intermediateError: WorkflowJournalLine = {
      ts: "t",
      runId: "semantic-failure",
      kind: "error",
      message: "intermediate child error",
    };
    transcript.event(intermediateError);

    const completion = transcript.finish({
      runId: "semantic-failure",
      runDir: "/tmp/semantic-failure",
      ok: false,
      result: {
        ok: false,
        summary: "Acceptance remains open",
        unresolvedRows: ["R-GIT", "R-CODE"],
      },
      journal: [intermediateError],
      resultPersistence: { ok: true, path: "/tmp/semantic-failure/result.json" },
    });

    expect(completion.digest).toContain("✗ workflow semantic-stop failed");
    expect(completion.digest).toContain("Acceptance remains open");
    expect(completion.digest).toContain("R-CODE, R-GIT");
    expect(completion.digest).not.toContain("unknown error");
    expect(completion.digest).toContain("Execution failures (1");
    expect(completion.digest).toContain("intermediate child error");
    expect(completion.digest.split("\n")[1]).toContain("Acceptance remains open");
  });

  it("uses a journal error only as fallback when no final semantic diagnostic exists", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "fallback-stop", "tool");
    transcript.start("fallback-failure", "/tmp/fallback-failure");
    transcript.event({ ts: "t", runId: "fallback-failure", kind: "error", message: "host bridge failed" });

    const completion = transcript.finish({
      runId: "fallback-failure",
      runDir: "/tmp/fallback-failure",
      ok: false,
      result: null,
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/fallback-failure/result.json" },
    });

    expect(completion.digest).toContain("host bridge failed");
  });

  it("uses a journal error as fallback when the script returns only ok:false", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "live-smoke", "tool");
    transcript.start("agent-auth-failure", "/tmp/agent-auth-failure");
    transcript.event({
      ts: "t",
      runId: "agent-auth-failure",
      kind: "error",
      label: "classify",
      message: "Workflow agent bridge: request auth failed: No API key found",
    });

    const completion = transcript.finish({
      runId: "agent-auth-failure",
      runDir: "/tmp/agent-auth-failure",
      ok: false,
      result: { ok: false },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/agent-auth-failure/result.json" },
    });

    expect(completion.digest).toContain("Workflow agent bridge: request auth failed: No API key found");
    expect(completion.digest).not.toContain("Workflow execution failed");
  });

  it("records result-persistence failure once as the terminal workflow verdict", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "persistence-warning", "command");
    transcript.start("run-persistence-warning", "/tmp/run-persistence-warning");

    const completion = transcript.finish({
      runId: "run-persistence-warning",
      runDir: "/tmp/run-persistence-warning",
      ok: false,
      error: "Workflow result was not persisted: blocked",
      result: { summary: "execution completed" },
      journal: [],
      resultPersistence: {
        ok: false,
        path: "/blocked/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED",
        message: "Workflow result was not persisted: blocked",
      },
    });

    expect(harness.notifications).toEqual([]);
    expect(completion.digest).toContain("✗ workflow persistence-warning failed");
    expect(completion.digest).toContain("Workflow result was not persisted: blocked");
    expect(completion.digest).not.toContain("finished");
  });

  it("says where the unabridged result text is and which command opens it", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "review", "command");
    transcript.start("20260726-212752-98cc", "/tmp/run-98cc");
    const longResult = `# Code Review\n\n## Reviewed scope\n\n${"Detail line that runs well past the digest line cap. ".repeat(8)}`;

    const completion = transcript.finish({
      runId: "20260726-212752-98cc",
      runDir: "/tmp/run-98cc",
      ok: true,
      result: longResult,
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-98cc/result.json" },
      resultTextPath: "/tmp/run-98cc/result.md",
    });

    // The verdict line itself stays bounded — it enters model context.
    for (const line of completion.digest.split("\n")) expect(line.length).toBeLessThanOrEqual(160);
    expect(completion.digest).toContain("full result: /tmp/run-98cc/result.md");
    expect(completion.digest).toContain("read full result: /workflows result 98cc");
    expect(completion.digest).toContain("journal: /tmp/run-98cc/runtime/journal.ndjson");
  });

  it("names the command that prints the reason when a run fails with a structured result and no text", () => {
    // The shape a `plan` round cap produced in a live run: `{ok:false}` with the
    // defects in `unresolvedRows` and no prose result at all. The digest caps its
    // verdict line at 160 characters, so the operator saw a sentence fragment
    // ending in "..." and, below it, only a journal path — no way to read why.
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "plan", "command");
    transcript.start("20260730-162453-000e", "/tmp/run-000e");

    const completion = transcript.finish({
      runId: "20260730-162453-000e",
      runDir: "/tmp/run-000e",
      ok: false,
      result: {
        ok: false,
        stoppedBy: "round-cap",
        summary: "plan was not accepted within 4 drafting round(s)",
        unresolvedRows: [`S1: ${"the find command pattern is not properly executed and may miss files. ".repeat(4)}`],
      },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-000e/result.json" },
    });

    for (const line of completion.digest.split("\n")) expect(line.length).toBeLessThanOrEqual(160);
    expect(completion.digest).toContain("read full reason: /workflows status 000e");
    // `/workflows result` refuses a non-prose result, so it must not be offered here.
    expect(completion.digest).not.toContain("/workflows result");
    expect(completion.digest).toContain("journal: /tmp/run-000e/runtime/journal.ndjson");
  });

  it("buffers a bounded tool digest without calling sendMessage and always retains workflow_end", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "bounded", "tool");
    agentLiveStore.reset();
    try {
      transcript.start("run-bounded", "/tmp/run-bounded");
      for (let index = 0; index < 40; index += 1) {
        const line: WorkflowJournalLine = {
          ts: `t${index}`,
          runId: "run-bounded",
          kind: "agent_start",
          agent: `agent-${index}-${"x".repeat(200)}`,
        };
        applyWorkflowJournalLineToAgentLiveStore(line);
        transcript.event(line);
      }
      transcript.event({ ts: "te", runId: "run-bounded", kind: "error", message: "intermediate journal failure" });
      const completion = transcript.finish({
        runId: "run-bounded",
        runDir: "/tmp/run-bounded",
        ok: false,
        result: null,
        error: "final failure",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-bounded/result.json" },
      });

      expect(harness.sentMessages).toEqual([]);
      // 22 bounded body lines plus grouped file and recovery-command metadata.
      expect(completion).toMatchObject({ eventKind: "workflow_end", lineCount: 25 });
      expect(completion.digest).toContain("read full reason: /workflows status");
      expect(completion.digest.match(/final failure/g)).toHaveLength(1);
      expect(completion.digest).not.toContain("intermediate journal failure");
      expect(
        completion.digest
          .split("\n")
          .slice(1)
          .every((line) => line.length <= 160),
      ).toBe(true);
      expect(completion.digest.length).toBeLessThanOrEqual(4096);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("uses stable agent plus label for cancelled lifecycle instead of a second parent-row petname", () => {
    const harness = createHarness();
    agentLiveStore.reset();
    try {
      const start: WorkflowJournalLine = {
        ts: "t1",
        runId: "run-cancelled",
        kind: "agent_start",
        agent: "reviewer",
        label: "sleep 60",
      };
      const end: WorkflowJournalLine = {
        ...start,
        ts: "t2",
        kind: "agent_end",
        status: "cancelled",
        durationMs: 60_000,
      };
      applyWorkflowJournalLineToAgentLiveStore(start);
      const parent = agentLiveStore.rows.get(workflowAgentLiveRowId(start))!;
      const child = agentLiveStore.begin({
        parentRowId: parent.id,
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "cancelled" });
      const parentPetname = parent.displayName;
      const childPetname = child.displayName;
      if (parentPetname === undefined || childPetname === undefined) throw new Error("expected canonical petnames");

      const visible = compactWorkflowParentRows([...agentLiveStore.rows.values()]);
      expect(visible.map((row) => row.id)).toEqual([child.id]);
      expect(visible[0]?.displayName).toBe(child.displayName);

      const transcript = createWorkflowTranscript(harness.ctx, "cancel-smoke", "tool");
      transcript.start("run-cancelled", "/tmp/run-cancelled");
      transcript.event(start);
      transcript.event(end);
      const completion = transcript.finish({
        runId: "run-cancelled",
        runDir: "/tmp/run-cancelled",
        ok: true,
        result: { summary: "child status reviewer cancelled" },
        journal: [start, end],
        resultPersistence: { ok: true, path: "/tmp/run-cancelled/result.json" },
      });

      expect(completion.digest).toContain("⊘ agent reviewer cancelled · 1m — sleep 60");
      expect(completion.digest).not.toContain("● agent reviewer started");
      expect(completion.digest).not.toContain("✓ agent");
      expect(completion.digest).not.toContain(parentPetname);
      expect(completion.digest).not.toContain(childPetname);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("never sends when waitForIdle is unavailable and reports the missing persistence barrier", async () => {
    const harness = createHarness(process.cwd(), { isStreaming: true });
    delete harness.ctx.waitForIdle;
    const transcript = createWorkflowTranscript(harness.ctx, "fallback", "command");
    transcript.start("run-3", "/tmp/run-3");
    transcript.event({
      ts: "t",
      runId: "run-3",
      kind: "agent_end",
      agent: "reviewer",
      status: "completed",
      evidenceWarnings: ["weak proof"],
    });
    const completion = transcript.finish({
      runId: "run-3",
      runDir: "/tmp/run-3",
      ok: true,
      result: { summary: "done" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-3/result.json" },
    });
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(false);

    expect(harness.sentMessages).toEqual([]);
    expect(harness.notificationEvents).toContainEqual({ message: "⚠ agent evidence · weak proof", level: "warning" });
    expect(harness.notificationEvents).toContainEqual({
      message: "Workflow transcript was not persisted: ctx.waitForIdle is unavailable.",
      level: "warning",
    });
  });

  it("suppresses a delayed idle continuation after its session lease becomes stale", async () => {
    const harness = createHarness(process.cwd(), { isStreaming: true });
    const transcript = createWorkflowTranscript(harness.ctx, "reload-safe", "command");
    transcript.start("run-reload-safe", "/tmp/run-reload-safe");
    const completion = transcript.finish({
      runId: "run-reload-safe",
      runDir: "/tmp/run-reload-safe",
      ok: true,
      result: { summary: "done" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-reload-safe/result.json" },
    });
    let current = true;
    const pending = persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion, () => current);
    for (let attempt = 0; attempt < 20 && harness.waitForIdleCalls === 0; attempt += 1) await Promise.resolve();

    expect(harness.waitForIdleCalls).toBe(1);
    current = false;
    harness.setStreaming(false);

    expect(await pending).toBe(false);
    expect(harness.sentMessages).toEqual([]);
    expect(harness.notificationEvents).toEqual([]);
  });

  it("opens a run with one idle-checked boundary banner and keeps a busy session unsteered", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "review", "command");
    const announcement = transcript.start("20260726-183012-a6aa", "/repo/.pi/locus-pi/runs/20260726-183012-a6aa");

    expect(announcement).toMatchObject({ eventKind: "workflow_start", runId: "20260726-183012-a6aa" });
    expect(announcement?.text).toContain("workflow review · run #a6aa · started");
    expect(announcement?.text).not.toContain("──");
    expect(announcement?.text).toContain("runDir: /repo/.pi/locus-pi/runs/20260726-183012-a6aa");
    expect(announceCommandWorkflowStart(harness.pi, harness.ctx, announcement!)).toBe(true);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message).toMatchObject({
      customType: WORKFLOW_RUN_CUSTOM_TYPE,
      display: true,
      details: { eventKind: "workflow_start", runId: "20260726-183012-a6aa" },
    });
    expect(harness.customMessageDeliveries).toEqual(["append"]);

    // A second start is not a second boundary.
    expect(transcript.start("20260726-183012-a6aa", "/repo/.pi/locus-pi/runs/20260726-183012-a6aa")).toBeUndefined();

    const busy = createHarness(process.cwd(), { isStreaming: true });
    const busyTranscript = createWorkflowTranscript(busy.ctx, "review", "command");
    const busyAnnouncement = busyTranscript.start("20260726-183500-b2c4", "/tmp/b2c4");
    expect(announceCommandWorkflowStart(busy.pi, busy.ctx, busyAnnouncement!)).toBe(false);
    expect(busy.sentMessages).toEqual([]);
    expect(busy.customMessageDeliveries).toEqual([]);
  });

  it("keeps one row per agent: the started row becomes the finished row", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "review", "tool");
    transcript.start("20260726-183012-a6aa", "/tmp/a6aa");
    transcript.event({ ts: "t0", runId: "r", kind: "phase", phase: "clarify" });
    transcript.event({
      ts: "t1",
      runId: "r",
      kind: "agent_start",
      agent: "default",
      label: "decide clarification",
      callId: "call-1",
    });
    const agentEnd: WorkflowJournalLine = {
      ts: "t2",
      runId: "r",
      kind: "agent_end",
      agent: "default",
      displayName: "Jenner",
      label: "decide clarification",
      callId: "call-1",
      status: "completed",
      durationMs: 45_000,
      childTrace: {
        path: "/tmp/a6aa/runtime/artifacts/transcripts/call-0001/agent-sdk-default-decide-clarification-jenner.jsonl",
        htmlPath:
          "/tmp/a6aa/runtime/artifacts/transcripts/call-0001/agent-sdk-default-decide-clarification-jenner.html",
        format: "pi-session-jsonl",
        childSessionId: "child-1",
      },
    };
    transcript.event(agentEnd);
    const completion = transcript.finish({
      runId: "20260726-183012-a6aa",
      runDir: "/tmp/a6aa",
      ok: true,
      result: { summary: "done" },
      journal: [agentEnd],
      resultPersistence: { ok: true, path: "/tmp/a6aa/result.json" },
    });

    expect(completion.digest).toContain("✓ agent default (Jenner) finished · 45s — decide clarification");
    expect(completion.digest).not.toContain("● agent default started");
    expect(completion.digest.match(/agent default/g)).toHaveLength(1);
    expect(completion.digest).toContain("agent transcripts: /tmp/a6aa/runtime/artifacts/transcripts");
    expect(completion.digest).not.toContain("agent-sdk-default-decide-clarification-jenner.jsonl");
  });

  it("never folds an agent without an end event into a clean run", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "review", "tool");
    transcript.start("20260726-183012-a6aa", "/tmp/a6aa");
    transcript.event({ ts: "t1", runId: "r", kind: "agent_start", agent: "reviewer", callId: "call-9" });
    const completion = transcript.finish({
      runId: "20260726-183012-a6aa",
      runDir: "/tmp/a6aa",
      ok: true,
      result: { summary: "done" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/a6aa/result.json" },
    });

    expect(completion.digest).toContain("■ agent reviewer started — no end recorded (evidence missing)");
  });

  it("renders the operator gate as its own block naming the stage, the tool, and the questions", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "review", "tool");
    transcript.start("20260726-183012-a6aa", "/tmp/a6aa");
    transcript.event({ ts: "t0", runId: "r", kind: "phase", phase: "clarify" });
    const completion = transcript.finish({
      runId: "20260726-183012-a6aa",
      runDir: "/tmp/a6aa",
      ok: true,
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
      result: { mode: "prepared" },
      journal: [],
      operatorHandoff: {
        version: 1,
        handoffId: "handoff-a6aa",
        originRunId: "20260726-183012-a6aa",
        title: "review clarification",
        questions: [{ kind: "text", id: "q1", prompt: "Which commit should this review cover?" }],
        continuationArtifactRefs: [],
        target: { kind: "name", ref: "review" },
        scriptIdentity: { path: "review.workflow.mjs", sha256: "a".repeat(64) },
      } as never,
      resultPersistence: { ok: true, path: "/tmp/a6aa/result.json" },
    });

    expect(completion.digest).toContain("◐ WAITING FOR OPERATOR — review clarification");
    expect(completion.digest).toContain('   asked during stage "clarify" · via awaitOperator');
    expect(completion.digest).toContain("   Q1: Which commit should this review cover?");
    expect(completion.digest).toContain("   answer: pending — reply in Pi to continue (handoff #a6aa)");
    // The terminal verdict stays exactly what downstream readers already pin.
    expect(completion.digest).toContain("◐ workflow review awaiting operator");
  });

  it("declares the run it continues, the answer that unblocked it, and replayed evidence", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "review", "tool", {
      input: "b09e8e8 — feat(workflows): schema uniqueness",
    });
    transcript.start("20260726-183412-b2c4", "/tmp/b2c4");
    transcript.event({
      ts: "t1",
      runId: "r",
      kind: "agent_end",
      agent: "default",
      label: "decide clarification",
      callId: "call-1",
      status: "completed",
      durationMs: 45_000,
      replayed: true,
      resumeFromRunId: "20260726-183012-a6aa",
    });
    const completion = transcript.finish({
      runId: "20260726-183412-b2c4",
      runDir: "/tmp/b2c4",
      ok: true,
      result: { summary: "done" },
      journal: [
        {
          ts: "t1",
          runId: "20260726-183412-b2c4",
          kind: "agent_end",
          agent: "default",
          status: "completed",
          replayed: true,
        },
      ],
      resumeFromRunId: "20260726-183012-a6aa",
      continuation: { originRunId: "20260726-183012-a6aa", artifacts: [] },
      resultPersistence: { ok: true, path: "/tmp/b2c4/result.json" },
    });

    expect(completion.digest).toContain(
      '↳ continues run #a6aa · operator answered: "b09e8e8 — feat(workflows): schema uniqueness"',
    );
    expect(completion.digest).toContain("↻ agent default replayed from run #a6aa · 45s — decide clarification");
    expect(completion.digest).toContain("1 replayed from run #a6aa");
    expect(completion.digest).not.toContain("✓ agent default finished");
  });
});
