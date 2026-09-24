import { describe, expect, it } from "vitest";
import runDraftWorkflow from "../../../../../examples/workflows/task/draft.workflow.mjs";

describe("Package workflow: task/draft", () => {
  it("passes bounded graph selection and read-only recon to agents, then publishes one brief", async () => {
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
    expect(calls[0]?.prompt).toContain("This call is reconnaissance only.");
    expect(calls[0]?.prompt).toContain("Do not create or modify any file");
    expect(calls[0]?.prompt).toContain("later execution stage, not this call");
    expect(calls[1]?.prompt).toContain("Workflow direction:");
    expect(calls[1]?.prompt).toContain("Pattern:");
    expect(calls[1]?.prompt).toContain("Reflection/review:");
    expect(calls[1]?.prompt).toContain("Failure and bounds:");
    expect(calls[1]?.prompt).toContain("Prefer the smallest fixed graph for one bounded deliverable");
    expect(calls[1]?.prompt).toContain("even when implementation is substantive");
    expect(calls[1]?.prompt).toContain("Do not invent a slice queue for one known output.");
    expect(calls[1]?.prompt).toContain("only when accepted output or findings");
    expect(calls[1]?.prompt).toContain("a bounded review loop when review can demand correction");
    expect(calls[1]?.prompt).toContain("a fixed graph may contain that loop");
    expect(calls[1]?.prompt).toContain("never as the absence of a loop");
    expect(calls[1]?.prompt).toContain("bounded review loop with literal round and correction limits");
    expect(publications).toEqual([{ name: "draft.md", text: "Task:\nBuild one workflow." }]);
    expect(result).toEqual({ name: "draft.md", text: "Task:\nBuild one workflow." });
  });
});
