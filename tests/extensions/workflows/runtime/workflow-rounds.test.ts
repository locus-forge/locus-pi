/**
 * workflow-rounds.test.ts — REQ-009 (T-193): workflow loop rounds.
 *
 * A workflow loop that re-invokes agent() with the same (phase,label) shows ONE stable
 * live row whose round increments (badge `r<N>` from r2), the journal records each round's
 * (slotKey, round, usage), the drill reads past rounds from the journal, and an OLD journal
 * without round fields degrades to "no rounds" without throwing. Ordering is never disturbed
 * by a round increment (T-188 W4 invariant).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSdkSessionExecutor,
  type AgentSdkSessionExecutorOptions,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveRow,
} from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { AgentExecutor } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  ensureWorkflowRunDir,
  workflowJournalFile,
  workflowRunDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  createWorkflowRuntime,
  workflowSlotKey,
  type WorkflowAgentRequest,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  listWorkflowRoundsForSlot,
  readWorkflowRoundBody,
  readWorkflowSlotPhase,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { applyWorkflowJournalLineToAgentLiveStore } from "../../../../extensions/workflows/runtime/workflow-live.js";
import {
  formatAgentLiveRowLine,
  formatRoundBadge,
  orderAgentLiveRows,
} from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";

afterEach(() => {
  agentLiveStore.reset();
});

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A minimal SDK child session that completes its turn synchronously and reports tokens. */
function fakeSession(tokens: { input: number; output: number }): SdkAgentSessionLike {
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  return {
    sessionId: "sdk-child",
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "sdk-child", toolCalls: 1, toolResults: 1, tokens };
    },
    getLastAssistantText() {
      return "done";
    },
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(mkdtempSync(path.join(tmpdir(), "rounds-export-")), "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose() {},
    async abort() {},
  };
}

function tempProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-rounds-"));
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "reviewer.md"),
    "---\nname: reviewer\ndescription: Project reviewer\ntools: read, grep\n---\nReview carefully.\n",
    "utf8",
  );
  return root;
}

function makeRow(id: string, over: Partial<AgentLiveRow> = {}): AgentLiveRow {
  return {
    id,
    label: id,
    status: "working",
    currentTools: [],
    stepCount: 0,
    isolated: false,
    noMcp: false,
    errors: [],
    eventLines: [],
    ...over,
  };
}

// ── W1: store slot dedupe + per-round reset ──────────────────────────────────

describe("REQ-009 W1 — store slot dedupe", () => {
  it("reuses ONE row and increments round, resetting per-round transient on a new round", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "slot", agentName: "reviewer", label: "verify", slotKey: "s", round: 1 });
    agentLiveStore.patch("slot", {
      status: "working",
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm test"}',
      currentToolStartMs: 1000,
      tokenCount: { input: 10, output: 5 },
      elapsedMs: 5000,
    });

    // Round 2: same id, higher round → one row, transient cleared, round bumped.
    agentLiveStore.begin({ id: "slot", agentName: "reviewer", label: "verify", slotKey: "s", round: 2 });
    const row = agentLiveStore.rows.get("slot");

    expect(agentLiveStore.rows.size).toBe(1);
    expect(row?.round).toBe(2);
    expect(row?.slotKey).toBe("s");
    expect(row?.currentTools).toEqual([]);
    expect(row?.currentToolArgs).toBeUndefined();
    expect(row?.currentToolStartMs).toBeUndefined();
    expect(row?.tokenCount).toBeUndefined();
    expect(row?.elapsedMs).toBeUndefined();
  });

  it("bridge: two same-(phase,label) agent() calls reuse one row with round=2", async () => {
    agentLiveStore.reset();
    const root = tempProject();
    const { createHarness } = await import("../../../test-harness.js");
    const h = createHarness(root, { sessionId: "wf-parent" });
    const createExecutor = (opts: {
      live?: AgentSdkSessionExecutorOptions["live"];
      onLiveExecution?: (execution: AgentLiveExecutionHandle) => void;
    }): AgentExecutor =>
      createAgentSdkSessionExecutor({
        createSession: async () => ({ session: fakeSession({ input: 100, output: 40 }) }),
        childTimeoutMs: 5000,
        ...(opts.live !== undefined ? { live: opts.live } : {}),
        ...(opts.onLiveExecution !== undefined ? { onLiveExecution: opts.onLiveExecution } : {}),
      });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "rounds-run",
      createExecutor,
    });
    const runtime = createWorkflowRuntime({ runId: "rounds-run", agentRunner: runner });

    await runtime.dsl.agent("verify the fix", { agent: "reviewer", label: "verify fix", phase: "verify" });
    await runtime.dsl.agent("verify the fix", { agent: "reviewer", label: "verify fix", phase: "verify" });

    // One stable executor row for the slot — NOT a new row per iteration.
    const childRows = [...agentLiveStore.rows.values()].filter((r) => r.id.startsWith("workflow-agent:"));
    expect(childRows).toHaveLength(1);
    const slotRow = childRows[0]!;
    expect(slotRow.id).toBe("workflow-agent:rounds-run:named:reviewer:verify fix:verify");
    expect(slotRow.round).toBe(2);
    expect(slotRow.slotKey).toBe(workflowSlotKey({ phase: "verify", label: "verify fix" }));

    // Journal records both rounds with usage projected from child tokens.
    const ends = runtime.getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.map((line) => line.round)).toEqual([1, 2]);
    expect(ends.every((line) => line.slotKey === workflowSlotKey({ phase: "verify", label: "verify fix" }))).toBe(true);
    // No `costTotal`: the host reports tokens and no price, and an absent field says
    // "unknown" where a hardcoded 0 said "this run was free".
    expect(ends[1]?.usage).toEqual({ input: 100, output: 40, totalTokens: 140 });
  });

  it("bridge: three mapped members keep one authored label but use three live rows", async () => {
    const root = tempProject();
    const { createHarness } = await import("../../../test-harness.js");
    const h = createHarness(root, { sessionId: "wf-parent-mapped" });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "mapped-live-rows",
      createExecutor: (opts) =>
        createAgentSdkSessionExecutor({
          createSession: async () => ({ session: fakeSession({ input: 100, output: 40 }) }),
          childTimeoutMs: 5000,
          ...(opts.live !== undefined ? { live: opts.live } : {}),
          ...(opts.onLiveExecution !== undefined ? { onLiveExecution: opts.onLiveExecution } : {}),
        }),
    });
    const runtime = createWorkflowRuntime({ runId: "mapped-live-rows", agentRunner: runner });

    await expect(
      runtime.dsl.parallel(
        ["a", "b", "c"].map(
          (item) => () =>
            runtime.dsl.agent(`verify ${item}`, { agent: "reviewer", label: "verify mapped", phase: "verify" }),
        ),
      ),
    ).resolves.toEqual(["done", "done", "done"]);

    const childRows = [...agentLiveStore.rows.values()].filter((row) =>
      row.id.startsWith("workflow-agent:mapped-live-rows:"),
    );
    expect(childRows).toHaveLength(3);
    expect(childRows.every((row) => row.label === "verify mapped")).toBe(true);
    expect(childRows.map((row) => row.round)).toEqual([1, 1, 1]);
    expect(new Set(childRows.map((row) => row.slotKey)).size).toBe(3);
    expect(new Set(childRows.map((row) => row.id)).size).toBe(3);

    const starts = runtime.getJournal().filter((line) => line.kind === "agent_start");
    const ends = runtime.getJournal().filter((line) => line.kind === "agent_end");
    expect(new Set(starts.map((line) => line.slotKey)).size).toBe(3);
    expect(new Set(ends.map((line) => line.slotKey)).size).toBe(3);
    expect(ends.map((line) => line.round)).toEqual([1, 1, 1]);
  });

  it("bridge: duplicate callsites in one mapped member cannot replace its first live row", async () => {
    const root = tempProject();
    const { createHarness } = await import("../../../test-harness.js");
    const h = createHarness(root, { sessionId: "wf-parent-duplicate" });
    let releaseFirst: (() => void) | undefined;
    const conflictObserved = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceChildStart: (() => void) | undefined;
    const childStarted = new Promise<void>((resolve) => {
      announceChildStart = resolve;
    });
    let childStarts = 0;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "mapped-duplicate-live-row",
      createExecutor: (opts) => ({
        async run(request) {
          childStarts += 1;
          announceChildStart?.();
          if (opts.live?.rowId === undefined) throw new Error("Expected stable workflow slot row.");
          const execution = agentLiveStore.beginExecution({
            id: opts.live.rowId,
            agentName: request.agent?.name ?? "sub-agent",
            label: opts.live.label ?? request.agent?.name ?? "sub-agent",
            ...(opts.live.slotKey === undefined ? {} : { slotKey: opts.live.slotKey }),
            ...(opts.live.round === undefined ? {} : { round: opts.live.round }),
          });
          opts.onLiveExecution?.(execution);
          await conflictObserved;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "done",
            text: "done",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    const runtime = createWorkflowRuntime({
      runId: "mapped-duplicate-live-row",
      agentRunner: runner,
      onEvent(line) {
        if (line.kind === "error" && line.message?.includes("slot is already running") === true) releaseFirst?.();
      },
    });

    await expect(
      runtime.dsl.parallel([
        async () => {
          const first = runtime.dsl.agent("first", { agent: "reviewer", label: "same", phase: "verify" });
          await childStarted;
          return Promise.all([
            first,
            runtime.dsl.agent("second", { agent: "reviewer", label: "same", phase: "verify" }),
          ]);
        },
      ]),
    ).rejects.toThrow(/phase "verify", label "same"/u);

    expect(childStarts).toBe(1);
    expect(runtime.getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(1);
    const childRows = [...agentLiveStore.rows.values()].filter((row) =>
      row.id.startsWith("workflow-agent:mapped-duplicate-live-row:"),
    );
    expect(childRows).toHaveLength(1);
    expect(childRows[0]).toMatchObject({ label: "same", round: 1 });
  });

  it("omits usage when a later execution replaces the call's stable slot before boundary mapping", async () => {
    const root = tempProject();
    const { createHarness } = await import("../../../test-harness.js");
    const h = createHarness(root, { sessionId: "wf-parent" });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "usage-overlap",
      createExecutor: (opts) => ({
        async run(request) {
          const live = opts.live;
          if (live?.rowId === undefined) throw new Error("Expected stable workflow slot row.");
          const execution = agentLiveStore.beginExecution({
            id: live.rowId,
            agentName: request.agent?.name ?? "sub-agent",
            label: live.label ?? request.agent?.name ?? "sub-agent",
            ...(live.slotKey !== undefined ? { slotKey: live.slotKey } : {}),
            ...(live.round !== undefined ? { round: live.round } : {}),
          });
          opts.onLiveExecution?.(execution);
          agentLiveStore.applyExecutionStats(execution, {
            sessionId: "stale-a",
            toolCalls: 1,
            toolResults: 1,
            tokens: { input: 11, output: 7 },
          });
          const replacement = agentLiveStore.beginExecution({
            id: live.rowId,
            agentName: request.agent?.name ?? "sub-agent",
            label: "replacement B",
            ...(live.slotKey !== undefined ? { slotKey: live.slotKey } : {}),
            round: (live.round ?? 1) + 1,
          });
          agentLiveStore.applyExecutionStats(replacement, {
            sessionId: "current-b",
            toolCalls: 2,
            toolResults: 2,
            tokens: { input: 900, output: 400 },
          });
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "A completed after replacement",
            text: "A completed after replacement",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const result = await runner({
      agent: "reviewer",
      prompt: "verify",
      label: "verify fix",
      phase: "verify",
    });

    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
    expect([...agentLiveStore.rows.values()].find((row) => row.id.startsWith("workflow-agent:"))?.tokenCount).toEqual({
      input: 900,
      output: 400,
    });
  });
});

// ── W2: journal fields + read helpers + backward compatibility ───────────────

describe("REQ-009 W2 — journal round records", () => {
  it("stamps slotKey on agent_start and slotKey/round/usage on agent_end (from the bridge result)", async () => {
    const runtime = createWorkflowRuntime({
      runId: "wf-rounds",
      now: () => "2026-01-01T00:00:00.000Z",
      agentRunner: async (req: WorkflowAgentRequest) => ({
        ok: true,
        status: "completed" as const,
        summary: "done",
        text: "done",
        diagnostics: [],
        agent: req.agent,
        slotKey: workflowSlotKey({ phase: req.phase, label: req.label }),
        round: 2,
        usage: { input: 100, output: 40, totalTokens: 140, costTotal: 0 },
      }),
    });

    await runtime.dsl.agent("verify", { agent: "reviewer", label: "verify fix", phase: "verify" });

    const slotKey = workflowSlotKey({ phase: "verify", label: "verify fix" });
    const start = runtime.getJournal().find((line) => line.kind === "agent_start");
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    expect(start?.slotKey).toBe(slotKey);
    expect(start?.round).toBeUndefined(); // round is a completion attribute (agent_end only)
    expect(end?.slotKey).toBe(slotKey);
    expect(end?.round).toBe(2);
    expect(end?.usage).toEqual({ input: 100, output: 40, totalTokens: 140, costTotal: 0 });
  });

  it("reads completed rounds and a past-round body from a run journal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-rounds-read-"));
    const runId = "20260709-000000-abcd";
    const slotKey = workflowSlotKey({ phase: "verify", label: "verify fix" });
    const runDir = ensureWorkflowRunDir(root, runId);
    const lines = [
      { ts: "1", runId, kind: "agent_start", agent: "reviewer", label: "verify fix", phase: "verify", slotKey },
      {
        ts: "2",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
        slotKey,
        round: 1,
        status: "completed",
        durationMs: 1200,
        model: "test/strong",
        thinking: "high",
        usage: { input: 30, output: 12, totalTokens: 42, costTotal: 0 },
      },
      {
        ts: "3",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
        slotKey,
        round: 2,
        status: "completed",
        durationMs: 900,
        usage: { input: 50, output: 20, totalTokens: 70, costTotal: 0 },
      },
    ];
    writeFileSync(workflowJournalFile(runDir), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    expect(listWorkflowRoundsForSlot(root, runId, slotKey)).toEqual([1, 2]);
    const body1 = readWorkflowRoundBody(root, runId, slotKey, 1);
    expect(body1?.join("\n")).toContain("round 1 — reviewer completed");
    expect(body1?.join("\n")).toContain("test/strong high");
    expect(body1?.join("\n")).toContain("tokens in 30 / out 12");
    expect(readWorkflowRoundBody(root, runId, slotKey, 3)).toBeUndefined(); // unknown round
    // The drill heading's stage segment: the phase is on the start line, not on any live row.
    expect(readWorkflowSlotPhase(root, runId, slotKey)).toBe("verify");
    expect(readWorkflowSlotPhase(root, runId, "no-such-slot")).toBeUndefined();
  });

  it("treats an OLD journal without round fields as no-rounds and never throws (backward compat)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-rounds-old-"));
    const runId = "20260101-000000-old0";
    const runDir = ensureWorkflowRunDir(root, runId);
    // Pre-T-193 journal: agent lines carry NO slotKey/round/usage.
    const oldLines = [
      { ts: "1", runId, kind: "agent_start", agent: "reviewer", label: "verify fix", phase: "verify" },
      {
        ts: "2",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
        status: "completed",
        durationMs: 1000,
      },
    ];
    writeFileSync(workflowJournalFile(runDir), oldLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    expect(() => listWorkflowRoundsForSlot(root, runId, "verifyverify fix")).not.toThrow();
    expect(listWorkflowRoundsForSlot(root, runId, "verifyverify fix")).toEqual([]);
    expect(readWorkflowRoundBody(root, runId, "verifyverify fix", 1)).toBeUndefined();
    // An old journal files no slotKey, so no stage can be claimed for one either.
    expect(readWorkflowSlotPhase(root, runId, "verifyverify fix")).toBeUndefined();

    // Applying old lines to the store must not throw and must leave round unset.
    agentLiveStore.reset();
    expect(() => {
      applyWorkflowJournalLineToAgentLiveStore({
        ts: "1",
        runId,
        kind: "agent_start",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
      });
      applyWorkflowJournalLineToAgentLiveStore({
        ts: "2",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
        status: "completed",
      });
    }).not.toThrow();
    const row = [...agentLiveStore.rows.values()][0];
    expect(row?.round).toBeUndefined();
  });
});

// ── W4: round badge + ordering invariant ─────────────────────────────────────

describe("REQ-009 W4 — round badge and ordering invariant", () => {
  it("renders the `r<N>` badge only from r2, after model+effort and before elapsed", () => {
    expect(formatRoundBadge({ round: 1 })).toBeUndefined(); // r1 implicit
    expect(formatRoundBadge({ round: 2 })).toBe("r2");
    expect(formatRoundBadge({})).toBeUndefined();

    const common = {
      displayName: "Curie",
      title: "verify fix",
      model: "anthropic/claude-fable-5",
      thinking: "medium",
      elapsedMs: 38000,
    };
    const r1 = formatAgentLiveRowLine(makeRow("row", { ...common, round: 1 }));
    expect(r1).not.toMatch(/·\s*r\d/); // no round badge at r1
    expect(r1).toContain("38s");

    const r3 = formatAgentLiveRowLine(
      makeRow("row", { ...common, round: 3, tokenCount: { input: 3900, output: 1200 } }),
    );
    expect(r3).toContain("r3");
    // Placement: after model+effort, before elapsed (grammar `<model> <effort> [· r<N>] · <elapsed>`).
    expect(r3.indexOf("claude-fable-5")).toBeLessThan(r3.indexOf("r3"));
    expect(r3.indexOf("r3")).toBeLessThan(r3.indexOf("38s"));
  });

  it("a round increment reuses the row and does NOT re-sort or move it (T-188 W4)", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "a", label: "a", slotKey: "sa", round: 1 });
    agentLiveStore.begin({ id: "b", label: "b", slotKey: "sb", round: 1 });
    agentLiveStore.begin({ id: "c", label: "c", slotKey: "sc", round: 1 });
    const before = [...agentLiveStore.rows.keys()];

    // Bump the MIDDLE row's round — the classic "does the row jump?" case.
    agentLiveStore.begin({ id: "b", label: "b", slotKey: "sb", round: 2 });

    expect([...agentLiveStore.rows.keys()]).toEqual(before); // b stayed in place
    expect(agentLiveStore.rows.size).toBe(3); // reused, not duplicated
    expect(agentLiveStore.rows.get("b")?.round).toBe(2);
    expect(orderAgentLiveRows([...agentLiveStore.rows.values()]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("orderAgentLiveRows never sorts by round (pure)", () => {
    const rows = [makeRow("a", { round: 1 }), makeRow("b", { round: 9 }), makeRow("c", { round: 2 })];
    expect(orderAgentLiveRows(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
