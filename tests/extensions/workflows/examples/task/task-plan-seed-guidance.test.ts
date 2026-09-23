import { describe, expect, it } from "vitest";
import runPlanWorkflow from "../../../../../examples/workflows/task/plan.workflow.mjs";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";

const validSeed = [
  'export const meta = { name: "build", profile: "standard" };',
  'export default async function runWorkflow(dsl, input = "") {',
  '  await dsl.agent(`Write the reviewed primary output product/index.html from this task: ${input}`, { label: "produce-primary" });',
  '  dsl.publishArtifact("diagnostic.md", "Remaining reviewed routes need source slices.");',
  '  return { ok: false, status: "incomplete-seed" };',
  "}",
].join("\n");

describe("task/plan seed guidance", () => {
  it("has a checker-valid primary-output starter route and rejects the v14 input fallback", () => {
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(validSeed)).toEqual([]);

    const transformedInput = validSeed
      .replace("  await dsl.agent(", '  const task = input || "fallback";\n  await dsl.agent(')
      .replace("${input}", "${task}");
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(transformedInput)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WF_DATA_FLOW" })]),
    );
  });

  it("delivers the primary route and opaque input contract to seed creation and repair", async () => {
    const calls: { label: string; prompt: string }[] = [];
    const answers: Record<string, string> = {
      "workflow-design": "Reviewed task design",
      "workflow-design-review": "Reviewed task design",
      "workflow-source-seed": "Seed missing primary route",
      "workflow-source-seed-check": "Seed gate failed: no primary route",
      "workflow-source-seed-route": "failed",
      "workflow-source-seed-fix": "Fixed seed still invalid",
      "workflow-source-seed-fix-check": "Seed gate failed: WF_DATA_FLOW",
      "workflow-source-seed-fix-route": "failed",
    };
    const dsl = {
      phase: () => undefined,
      agent: async (prompt: string, options: { label: string }) => {
        calls.push({ label: options.label, prompt });
        return answers[options.label];
      },
    };

    await expect(
      runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted draft"),
    ).resolves.toMatchObject({ ok: false, reason: "seed_failed" });

    const seed = calls.find((call) => call.label === "workflow-source-seed")?.prompt;
    const fix = calls.find((call) => call.label === "workflow-source-seed-fix")?.prompt;
    for (const prompt of [seed, fix]) {
      expect(prompt).toContain("agent explicitly directed to produce the reviewed primary output");
      expect(prompt).toContain("input ||");
      expect(prompt).toContain("Pass semantic input whole");
    }
  });
});
