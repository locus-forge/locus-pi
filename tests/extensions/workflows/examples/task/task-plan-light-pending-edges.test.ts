import { describe, expect, it, vi } from "vitest";
import runPlanWorkflow from "../../../../../examples/workflows/task/plan-light.workflow.mjs";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";

const pendingEdge = "review findings -> queued correction; temporary named incomplete route";
const destination = "correction + final: replace pending findings edge and finish graph";

function runWithPendingEdge(unresolvedAtFinal = false) {
  const calls: { label: string; prompt: string }[] = [];
  const publishPrimaryFile = vi.fn(() => ({ relativePath: "workflow.mjs" }));
  const answers: Record<string, unknown[]> = {
    "workflow-design": ["Reviewed graph"],
    "workflow-design-review": ["Reviewed graph"],
    "workflow-source-seed": ["Seed report"],
    "workflow-source-seed-check": ["Seed passed"],
    "workflow-source-seed-route": ["passed"],
    "workflow-source-cut": unresolvedAtFinal ? [[]] : [[pendingEdge, destination], [destination], []],
    "workflow-source-queue-assessment": unresolvedAtFinal
      ? ["The queue is empty"]
      : ["Both edits remain", "Destination remains", "Whole graph complete"],
    "workflow-source-queue-route": unresolvedAtFinal ? ["complete"] : ["work", "work", "complete"],
    "workflow-source-queue-repair": unresolvedAtFinal ? [[]] : [[pendingEdge, destination], [destination], []],
    "workflow-source-queue-recheck": unresolvedAtFinal
      ? ["The queue is empty"]
      : ["Pending target retained", "Target replacement retained", "Whole graph complete"],
    "workflow-source-queue-recheck-route": unresolvedAtFinal ? ["complete"] : ["work", "work", "complete"],
    "workflow-source-slice": ["First edit", "Second edit"],
    "workflow-source-check": ["Mechanical pass", "Mechanical pass"],
    "workflow-source-check-route": ["passed", "passed"],
    "workflow-source-review": ["Pending edge is named and fails closed", "Real edge replaced the placeholder"],
    "workflow-source-review-route": ["accept", "accept"],
    "workflow-source-final-check": ["Mechanical pass"],
    "workflow-source-final-check-route": ["passed"],
    "workflow-source-final-review": [
      unresolvedAtFinal ? "Pending placeholder remains in whole graph" : "No pending placeholders remain",
    ],
    "workflow-source-final-route": [unresolvedAtFinal ? "design_mismatch" : "publish"],
  };
  const dsl = {
    phase: () => undefined,
    publishPrimaryFile,
    agent: async (prompt: string, options: { label: string }) => {
      calls.push({ label: options.label, prompt });
      const answer = answers[options.label]?.shift();
      if (answer === undefined) throw new Error(`No scripted answer for ${options.label}`);
      return answer;
    },
  };
  return {
    calls,
    publishPrimaryFile,
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted draft"),
  };
}

const boundedSource = [
  'export const meta = { name: "example", profile: "standard" };',
  'export default async function runWorkflow(dsl, input = "") {',
  '  let evidence = "";',
  "  for (let turn = 1; turn <= 3; turn += 1) {",
  '    const owner = await dsl.agent(`Work on this task: ${input}; prior evidence: ${evidence}`, { label: "owner" });',
  '    const route = await dsl.agent(`Classify: ${owner}`, { label: "route", choice: ["done", "continue"] });',
  '    if (route === "done") { evidence = owner; break; }',
  '    const review = await dsl.agent(`Review: ${owner}`, { label: "review" });',
  "    evidence = review;",
  '    if (turn === 3) { dsl.publishArtifact("bound.md", review); return { status: "incomplete" }; }',
  "  }",
  '  return await dsl.agent(`Final: ${evidence}`, { label: "final" });',
  "}",
].join("\n");

describe("task/plan-light pending source edges", () => {
  it("accepts a named future edge as intermediate work and carries it into the next slice", async () => {
    const fixture = runWithPendingEdge();
    await expect(fixture.run()).resolves.toMatchObject({ relativePath: "workflow.mjs" });

    const slices = fixture.calls.filter((call) => call.label === "workflow-source-slice");
    expect(slices).toHaveLength(2);
    expect(slices[0]?.prompt).toContain(pendingEdge);
    expect(slices[0]?.prompt).toContain(destination);
    expect(slices[0]?.prompt).toContain("do not implement the later node in this slice");
    expect(slices[1]?.prompt).toContain(destination);
    const firstReview = fixture.calls.find((call) => call.label === "workflow-source-review")?.prompt;
    expect(firstReview).toContain("Accept a named fail-closed placeholder");
    expect(firstReview).toContain(destination);
    expect(fixture.calls.find((call) => call.label === "workflow-source-final-review")?.prompt).toContain(
      "no pending fail-closed placeholders",
    );
    expect(fixture.publishPrimaryFile).toHaveBeenCalledOnce();
  });

  it("rejects an unresolved placeholder at the final whole-file gate", async () => {
    const fixture = runWithPendingEdge(true);
    await expect(fixture.run()).resolves.toMatchObject({ ok: false, reason: "design_mismatch" });
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });

  it("keeps the bounded counter, whole carry, and convergent node within checker grammar", () => {
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(boundedSource)).toEqual([]);
    const mutatedCount = boundedSource.replace(
      '  let evidence = "";',
      '  let evidence = "";\n  let extraCount = 0;\n  extraCount += 1;',
    );
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(mutatedCount)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WF_EXPRESSION" })]),
    );
    const duplicateNode = boundedSource.replace(
      '  return await dsl.agent(`Final: ${evidence}`, { label: "final" });',
      '  await dsl.agent("Another final path", { label: "final" });\n  return await dsl.agent(`Final: ${evidence}`, { label: "final" });',
    );
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(duplicateNode)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WF_AGENT_LABEL_DUPLICATE" })]),
    );
  });
});
