import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import runPlanWorkflow from "../../../../../examples/workflows/task/plan.workflow.mjs";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../../test-harness.js";

type Call = { label: string; prompt: string; choice: string[] | undefined };

function planRun(routes: string[]) {
  const calls: Call[] = [];
  const phases: string[] = [];
  const answers: Record<string, string[]> = {
    "workflow-author": ["author report: fixed graph, checks passed"],
    "workflow-review": ["review 1: revise, missing failure exit", "review 2: revise, stale path", "review 3: revise"],
    "workflow-review-route": [...routes],
    "workflow-revise": ["revision 1: added failure exit", "revision 2: fixed path"],
  };
  const publishPrimaryFile = vi.fn((relativePath: string) => ({ relativePath }));
  const dsl = {
    phase: (title: string) => void phases.push(title),
    publishPrimaryFile,
    agent: async (prompt: string, options: { label: string; choice?: string[] }) => {
      calls.push({ label: options.label, prompt, choice: options.choice });
      const answer = answers[options.label]?.shift();
      if (answer === undefined) throw new Error(`No scripted answer for ${options.label}`);
      return answer;
    },
  };
  return {
    calls,
    phases,
    publishPrimaryFile,
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted draft text"),
    labels: () => calls.map((call) => call.label),
  };
}

describe("Package workflow: task/plan", () => {
  it("publishes after one author call and an accepted first review", async () => {
    const fixture = planRun(["accept"]);

    await expect(fixture.run()).resolves.toEqual({ relativePath: "workflow.mjs" });
    expect(fixture.labels()).toEqual(["workflow-author", "workflow-review", "workflow-review-route"]);
    expect(fixture.phases).toEqual(["author", "review", "publish"]);
    expect(fixture.publishPrimaryFile).toHaveBeenCalledWith("workflow.mjs");

    const [author, review, route] = fixture.calls;
    expect(author?.prompt).toContain("Accepted draft text");
    expect(author?.prompt).toContain("locus-pi-workflow-create");
    expect(author?.prompt).toContain('"## New task/plan run"');
    expect(author?.prompt).toContain("The graph plans stages, not product steps");
    expect(author?.prompt).toContain("never retype an absolute");
    expect(review?.prompt).toContain("author report: fixed graph, checks passed");
    expect(review?.prompt).toContain("Style preferences are not findings");
    expect(route?.choice).toEqual(["accept", "revise"]);
    for (const call of fixture.calls.filter((entry) => entry.choice === undefined))
      expect(call.prompt).toContain("Never write source bytes into the log");
  });

  it("revises with the whole review and re-reviews the revision", async () => {
    const fixture = planRun(["revise", "accept"]);

    await expect(fixture.run()).resolves.toEqual({ relativePath: "workflow.mjs" });
    expect(fixture.labels()).toEqual([
      "workflow-author",
      "workflow-review",
      "workflow-review-route",
      "workflow-revise",
      "workflow-review",
      "workflow-review-route",
    ]);
    const revise = fixture.calls.find((call) => call.label === "workflow-revise");
    expect(revise?.prompt).toContain("review 1: revise, missing failure exit");
    const secondReview = fixture.calls.filter((call) => call.label === "workflow-review")[1];
    expect(secondReview?.prompt).toContain("revision 1: added failure exit");
    expect(secondReview?.prompt).toContain("review 1: revise, missing failure exit");
  });

  it("fails closed after three reviews and two revisions without publishing", async () => {
    const fixture = planRun(["revise", "revise", "revise"]);

    await expect(fixture.run()).resolves.toEqual({
      ok: false,
      status: "failed",
      stage: "review",
      reason: "review_exhausted",
      source: "workflow.mjs",
      diagnostics: "review 3: revise",
    });
    expect(fixture.labels().filter((label) => label === "workflow-review")).toHaveLength(3);
    expect(fixture.labels().filter((label) => label === "workflow-revise")).toHaveLength(2);
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });
});

describe("Package workflow: task/plan-light admission", () => {
  // task/plan's blank-input admission lives in workflow-input.test.ts; both names share one rule.
  it("refuses blank input before any child starts", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "task-plan-light-admission-"));
    try {
      const harness = createHarness(root, { sessionId: "task-plan-light-required-input" });
      const run = vi.fn(async () => {
        throw new Error("must not run");
      });
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "task/plan-light",
        createExecutor: () => ({ run }),
        input: " \n ",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "task/plan-light requires the complete accepted draft as non-empty semantic input; no agent was started and no workflow.mjs was published.",
      );
      expect(run).not.toHaveBeenCalled();
      expect(result.primaryFile).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
