import { describe, expect, it, vi } from "vitest";
import runPlanWorkflow from "../../../../../examples/workflows/task/plan.workflow.mjs";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";

function runWithResidual(mechanical: "passed" | "failed", design: "accept" | "failed") {
  const calls: { label: string; prompt: string }[] = [];
  const publishPrimaryFile = vi.fn(() => ({ relativePath: "workflow.mjs" }));
  const answers: Record<string, unknown[]> = {
    "workflow-design": ["Design"],
    "workflow-design-review": ["Reviewed design"],
    "workflow-source-seed": ["Seed"],
    "workflow-source-seed-check": ["Seed passed"],
    "workflow-source-seed-route": ["passed"],
    "workflow-source-cut": [["state handoff slice"], []],
    "workflow-source-queue-assessment": ["One unmet slice", "Whole graph complete"],
    "workflow-source-queue-route": ["work", "complete"],
    "workflow-source-queue-repair": [["state handoff slice"], []],
    "workflow-source-queue-recheck": ["Slice remains", "Whole graph complete"],
    "workflow-source-queue-recheck-route": ["work", "complete"],
    "workflow-source-slice": ["Source edit"],
    "workflow-source-check": ["Mechanical pass"],
    "workflow-source-check-route": ["passed"],
    "workflow-source-review": ["State handoff needs correction"],
    "workflow-source-review-route": ["fix"],
    "workflow-source-design-fix": ["First design edit"],
    "workflow-source-design-fix-check": ["First mechanical pass"],
    "workflow-source-design-fix-route": ["passed"],
    "workflow-source-design-recheck": ["Correctable residual: correction still uses initial, not current state"],
    "workflow-source-design-recheck-route": ["fix"],
    "workflow-source-design-refix": ["Second targeted edit"],
    "workflow-source-design-refix-check": ["Second mechanical result"],
    "workflow-source-design-refix-check-route": [mechanical],
    "workflow-source-design-rerecheck": ["Final design result"],
    "workflow-source-design-rerecheck-route": [design],
    "workflow-source-final-check": ["Final mechanical pass"],
    "workflow-source-final-check-route": ["passed"],
    "workflow-source-final-review": ["Whole graph conforms"],
    "workflow-source-final-route": ["publish"],
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
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted brief"),
  };
}

describe("task/plan bounded design recheck repair", () => {
  it("accepts one targeted residual fix only after independent mechanical and design checks", async () => {
    const fixture = runWithResidual("passed", "accept");
    await expect(fixture.run()).resolves.toMatchObject({ relativePath: "workflow.mjs" });
    expect(fixture.calls.filter((call) => call.label === "workflow-source-design-refix")).toHaveLength(1);
    const refix = fixture.calls.find((call) => call.label === "workflow-source-design-refix")?.prompt;
    expect(refix).toContain("Correctable residual: correction still uses initial, not current state");
    expect(refix).toContain("state handoff slice");
    expect(refix).toContain("second and final semantic repair allowance");
    expect(fixture.calls.find((call) => call.label === "workflow-source-design-rerecheck")?.prompt).toContain(
      "latest whole state",
    );
    for (const label of ["workflow-source-seed", "workflow-source-slice", "workflow-source-design-refix"]) {
      const prompt = fixture.calls.find((call) => call.label === label)?.prompt;
      expect(prompt).toContain("A choice returns only its exact route token");
      expect(prompt).toContain("Carry the latest whole state and queue");
    }
    expect(fixture.publishPrimaryFile).toHaveBeenCalledOnce();
  });

  it("stops without publication when the second mechanical check fails", async () => {
    const fixture = runWithResidual("failed", "accept");
    await expect(fixture.run()).resolves.toMatchObject({
      ok: false,
      reason: "slice_repair_failed",
      diagnostics: "Second mechanical result",
    });
    expect(fixture.calls.some((call) => call.label === "workflow-source-design-rerecheck")).toBe(false);
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });

  it("stops without publication when the second design recheck fails", async () => {
    const fixture = runWithResidual("passed", "failed");
    await expect(fixture.run()).resolves.toMatchObject({
      ok: false,
      reason: "design_mismatch",
      diagnostics: "Final design result",
    });
    expect(fixture.calls.filter((call) => call.label === "workflow-source-design-refix")).toHaveLength(1);
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });
});

function carrySource(declaration: string, beforeLoop = "", extraInside = "") {
  return [
    'export const meta = { name: "carry", profile: "standard" };',
    'export default async function runWorkflow(dsl, input = "") {',
    '  const initialReport = await dsl.agent(`Initial: ${input}`, { label: "initial" });',
    declaration,
    beforeLoop,
    "  for (let turn = 1; turn <= 2; turn += 1) {",
    '    const report = await dsl.agent(`Work: ${initialReport}; latest: ${lastOutcome}`, { label: "work" });',
    "    lastOutcome = report;",
    extraInside,
    "  }",
    '  return await dsl.agent(`Final: ${initialReport}; latest: ${lastOutcome}`, { label: "final" });',
    "}",
  ].join("\n");
}

function failedMechanicalRepair() {
  const calls: { label: string; prompt: string }[] = [];
  const publishPrimaryFile = vi.fn();
  const answers: Record<string, unknown[]> = {
    "workflow-design": ["Design"],
    "workflow-design-review": ["Reviewed design"],
    "workflow-source-seed": ["Seed"],
    "workflow-source-seed-check": ["Seed passed"],
    "workflow-source-seed-route": ["passed"],
    "workflow-source-cut": [["state carry slice"]],
    "workflow-source-queue-assessment": ["Queue valid"],
    "workflow-source-queue-route": ["work"],
    "workflow-source-queue-repair": [["state carry slice"]],
    "workflow-source-queue-recheck": ["Queue valid"],
    "workflow-source-queue-recheck-route": ["work"],
    "workflow-source-slice": ["Source edited"],
    "workflow-source-check": ["WF_DATA_FLOW and WF_EXPRESSION at state assignment"],
    "workflow-source-check-route": ["fix"],
    "workflow-source-fix": ["Attempted repair"],
    "workflow-source-fix-check": ["WF_DATA_FLOW remains"],
    "workflow-source-fix-route": ["failed"],
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
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted brief"),
  };
}

describe("task/plan empty whole carry", () => {
  it("matches the real source checker for the v17 failure and its valid replacement", () => {
    const valid = carrySource(
      '  let lastOutcome = "";',
      "",
      '    const review = await dsl.agent(`Review: ${report}`, { label: "review" });\n    lastOutcome = review;',
    );
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(valid)).toEqual([]);

    for (const invalid of [
      carrySource("  let lastOutcome = initialReport;"),
      carrySource('  let lastOutcome = "";', "  lastOutcome = initialReport;"),
    ]) {
      const codes = orchestrationOnlyWorkflowSourceShapeDiagnostics(invalid).map((diagnostic) => diagnostic.code);
      expect(codes).toContain("WF_DATA_FLOW");
      expect(codes).toContain("WF_EXPRESSION");
    }
  });

  it("delivers the precise repair rule and keeps a failed independent recheck closed", async () => {
    const fixture = failedMechanicalRepair();
    await expect(fixture.run()).resolves.toMatchObject({
      ok: false,
      reason: "slice_repair_failed",
      diagnostics: "WF_DATA_FLOW remains",
    });
    for (const label of ["workflow-source-seed", "workflow-source-slice", "workflow-source-fix"]) {
      const prompt = fixture.calls.find((call) => call.label === label)?.prompt;
      expect(prompt).toContain('let lastOutcome = ""');
      expect(prompt).toContain("Never declare let lastOutcome = initialReport");
      expect(prompt).toContain("only inside the loop");
    }
    expect(fixture.calls.find((call) => call.label === "workflow-source-fix")?.prompt).toContain(
      "For WF_DATA_FLOW or WF_EXPRESSION on state/report assignments",
    );
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });
});

async function promptsThroughMechanicalFix() {
  const prompts = new Map<string, string>();
  const answers: Record<string, unknown[]> = {
    "workflow-design": ["Design"],
    "workflow-design-review": ["Reviewed design"],
    "workflow-source-seed": ["Seed"],
    "workflow-source-seed-check": ["Seed passed"],
    "workflow-source-seed-route": ["passed"],
    "workflow-source-cut": [["review loop slice"]],
    "workflow-source-queue-assessment": ["Queue valid"],
    "workflow-source-queue-route": ["work"],
    "workflow-source-queue-repair": [["review loop slice"]],
    "workflow-source-queue-recheck": ["Queue valid"],
    "workflow-source-queue-recheck-route": ["work"],
    "workflow-source-slice": ["Source edited"],
    "workflow-source-check": ["WF_EXPRESSION at branch join assignment"],
    "workflow-source-check-route": ["fix"],
    "workflow-source-fix": ["Attempted repair"],
    "workflow-source-fix-check": ["WF_DATA_FLOW remains"],
    "workflow-source-fix-route": ["failed"],
  };
  const dsl = {
    phase: () => undefined,
    publishPrimaryFile: () => undefined,
    agent: async (prompt: string, options: { label: string }) => {
      prompts.set(options.label, prompt);
      const answer = answers[options.label]?.shift();
      if (answer === undefined) throw new Error(`No scripted answer for ${options.label}`);
      return answer;
    },
  };
  const result = await runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted brief");
  return { prompts, result };
}

describe("task/plan bounded loops in any graph", () => {
  it("lets every stage treat a bounded loop as ordinary control flow judged by call bounds", async () => {
    const { prompts, result } = await promptsThroughMechanicalFix();
    expect(result).toMatchObject({ ok: false, reason: "slice_repair_failed" });

    for (const label of ["workflow-design", "workflow-design-review", "workflow-source-slice", "workflow-source-fix"]) {
      const prompt = prompts.get(label);
      expect(prompt).toContain("ordinary control flow in any graph, including a fixed graph");
      expect(prompt).toContain("never the absence of a loop");
      expect(prompt).toContain("immediately before the loop that assigns it");
      expect(prompt).toContain("product of its enclosing literal loop bounds");
      expect(prompt).not.toContain("In an adaptive graph");
    }

    expect(prompts.get("workflow-design")).toContain("label (rounds 1..R)");
    expect(prompts.get("workflow-design")).toContain("correct meaning unresolved");
    const review = prompts.get("workflow-design-review");
    expect(review).toContain("Reject a requirement the source contract cannot express");
    expect(review).toContain("Replace any requirement that forbids a loop with explicit bounds");
    expect(review).toContain("one literal counter and one literal bound per loop");
    expect(review).not.toContain("Require one bounded loop counter");
    expect(review).not.toContain("preserve simple fixed graphs");

    for (const label of ["workflow-source-seed", "workflow-source-seed-check"]) {
      expect(prompts.get(label)).not.toMatch(/adaptive (design|graph work)/);
    }
    expect(prompts.get("workflow-source-cut")).toContain(
      "Each reviewed loop with its literal bound is a graph identity",
    );
    expect(prompts.get("workflow-source-queue-assessment")).toContain("reviewed loops keep their literal bounds");
    expect(prompts.get("workflow-source-queue-repair")).toContain("graph identity, edge and loop bound");
    expect(prompts.get("workflow-source-queue-recheck")).toContain("branch or loop bound");

    const slice = prompts.get("workflow-source-slice");
    expect(slice).toContain("for (let round = 1; round <= 2; round += 1)");
    expect(slice).toContain(
      "rejects a carry assigned outside its nearest enclosing for loop, even when that code runs once",
    );
    expect(slice).toContain("Binding names are unique per file");
    expect(prompts.get("workflow-source-fix")).toContain("when a join of alternative reports has no loop yet");
  });
});
