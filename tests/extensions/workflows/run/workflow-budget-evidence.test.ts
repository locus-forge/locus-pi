import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunDetailBlock } from "../../../../extensions/workflows/run/run-evidence.js";
import {
  readWorkflowRunResult,
  workflowPersistedResultInvalidity,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  WORKFLOW_BUDGET_AXES,
  workflowBudgetEnvelope,
} from "../../../../extensions/workflows/runtime/workflow-budget.js";
import {
  ensureWorkflowRunDir,
  workflowJournalFile,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";

/**
 * The applied-budget envelope, written and then actually read back.
 *
 * `result.json` has carried a complete `budget` object since budgets became
 * explicit-only, and the run detail block has had a "budget applied" line for it
 * — but no reader ever populated the field, so the line was dead code and a
 * headless operator was never told which axes were unbounded. These tests hold
 * the writer and the reader together: what `workflowBudgetEnvelope` produces is
 * exactly what comes back, and what comes back is what an operator reads.
 */

function project(): string {
  return mkdtempSync(path.join(tmpdir(), "workflow-budget-evidence-"));
}

/** One finished run on disk, with whatever `budget` value the case wants to store. */
function runWith(root: string, runId: string, budget: unknown): string {
  const runDir = ensureWorkflowRunDir(root, runId);
  writeFileSync(
    workflowJournalFile(runDir),
    `${JSON.stringify({ ts: "2026-09-12T10:00:00.000Z", runId, kind: "phase", phase: "work" })}\n`,
  );
  writeFileSync(
    workflowResultFile(runDir),
    JSON.stringify({ runId, ok: true, ...(budget === undefined ? {} : { budget }) }),
  );
  return runDir;
}

function detailText(root: string, runId: string): string {
  const block = buildRunDetailBlock(root, runId);
  return [...(block.body ?? []), ...(block.metadata ?? [])].join("\n");
}

describe("applied budget in persisted run evidence", () => {
  it("reads back the exact envelope the runner wrote", () => {
    const root = project();
    const written = workflowBudgetEnvelope({ concurrency: 4, totalAgents: 12 });
    runWith(root, "20260912-100000-budgetread", written);

    const persisted = readWorkflowRunResult(root, "20260912-100000-budgetread");

    expect(persisted?.budget).toEqual(written);
    expect(Object.keys(persisted!.budget!)).toEqual([...WORKFLOW_BUDGET_AXES]);
    expect(persisted?.budgetInvalid).toBeUndefined();
  });

  it("prints one budget applied line naming every axis, unbounded ones included", () => {
    const root = project();
    runWith(root, "20260912-100001-budgetline", workflowBudgetEnvelope({ concurrency: 4, runtimeMs: 60_000 }));

    const text = detailText(root, "20260912-100001-budgetline");

    expect(text).toContain("budget applied:");
    expect(text).toContain("concurrency=4");
    expect(text).toContain("runtimeMs=60000");
    // The one fact nothing else in the block states: these axes will stop nothing.
    expect(text).toContain("totalAgents=unbounded");
    expect(text).toContain("timeoutMs=unbounded");
    expect(text).toContain("toolCalls=unbounded");
    expect(text).toContain("turns=unbounded");
  });

  it("says nothing about a budget when the envelope predates the field", () => {
    const root = project();
    runWith(root, "20260912-100002-nobudget", undefined);

    const persisted = readWorkflowRunResult(root, "20260912-100002-nobudget");
    expect(persisted?.budget).toBeUndefined();
    expect(persisted?.budgetInvalid).toBeUndefined();
    expect(detailText(root, "20260912-100002-nobudget")).not.toContain("budget applied:");
  });

  it.each([
    ["an unknown axis", { ...workflowBudgetEnvelope({ concurrency: 4 }), answerChars: "unbounded" }],
    ["a missing axis", { concurrency: 4 }],
    ["a zero value", { ...workflowBudgetEnvelope({ concurrency: 4 }), concurrency: 0 }],
    ["a fractional value", { ...workflowBudgetEnvelope({ concurrency: 4 }), runtimeMs: 1.5 }],
    ["a foreign word", { ...workflowBudgetEnvelope({ concurrency: 4 }), turns: "infinite" }],
    ["a non-object", "unbounded"],
  ])("marks %s as malformed instead of rendering half a budget", (_label, budget) => {
    const root = project();
    const runId = "20260912-100003-badbudget";
    runWith(root, runId, budget);

    const persisted = readWorkflowRunResult(root, runId);

    expect(persisted?.budget).toBeUndefined();
    expect(persisted?.budgetInvalid).toMatch(/budget must name exactly the axes/u);
    expect(workflowPersistedResultInvalidity(persisted)).toMatch(/budget envelope is malformed/u);
    expect(detailText(root, runId)).not.toContain("budget applied:");
  });
});
