import { describe, expect, it } from "vitest";
import runDraftWorkflow from "../../../../../extensions/workflows/examples/task/draft.workflow.mjs";

describe("Package workflow: task/draft", () => {
  it("publishes one editable brief with patterns and bounded reflection", async () => {
    const calls: Array<{ prompt: string; options: { label: string } }> = [];
    const phases: string[] = [];
    const publications: Array<{ name: string; text: string }> = [];
    const dsl = {
      agent: async (prompt: string, options: { label: string }) => {
        calls.push({ prompt, options });
        return options.label === "draft-context" ? "Confirmed project evidence." : "Task:\nBuild one workflow.";
      },
      phase: (name: string) => phases.push(name),
      publishPrimaryArtifact: (name: string, text: string) => {
        publications.push({ name, text });
        return { name, text };
      },
    };

    const result = await runDraftWorkflow(
      dsl as unknown as Parameters<typeof runDraftWorkflow>[0],
      "Build a reviewed migration workflow.",
    );

    expect(phases).toEqual(["recon", "draft", "publish"]);
    expect(calls.map((call) => call.options.label)).toEqual(["draft-context", "task-draft"]);
    expect(calls[1]?.prompt).toContain("Workflow direction:");
    expect(calls[1]?.prompt).toContain("Pattern:");
    expect(calls[1]?.prompt).toContain("Reflection/review:");
    expect(calls[1]?.prompt).toContain("Failure and bounds:");
    expect(publications).toEqual([{ name: "draft.md", text: "Task:\nBuild one workflow." }]);
    expect(result).toEqual({ name: "draft.md", text: "Task:\nBuild one workflow." });
  });
});
