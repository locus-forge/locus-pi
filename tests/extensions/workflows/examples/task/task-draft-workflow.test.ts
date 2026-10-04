import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { temporaryValue } from "../../../../fixtures/scripted-agent-runtime.js";
import { describe, expect, it } from "vitest";
import runDraftWorkflow from "../../../../../examples/workflows/task/draft.workflow.mjs";

describe("Package workflow: task/draft", () => {
  it("writes the assigned editable draft and preserves bounded graph selection and read-only recon", async () => {
    await temporaryValue(async (root) => {
      const draftPath = path.join(root, "assigned-draft.md");
      const wholeInput = `Build a reviewed migration workflow. Exact draft.md destination: ${draftPath}`;
      const calls: Array<{ prompt: string; options: { label: string } }> = [];
      const phases: string[] = [];
      const publications: Array<{ name: string; text: string }> = [];
      const dsl = {
        agent: async (prompt: string, options: { label: string }) => {
          calls.push({ prompt, options });
          expect(prompt).toContain(wholeInput);
          if (options.label === "draft-context") return "Confirmed project evidence.";
          if (options.label === "task-draft-file-route")
            return existsSync(draftPath) && readFileSync(draftPath, "utf8") === "Task:\nBuild one workflow."
              ? "written"
              : "failed";
          writeFileSync(draftPath, "Task:\nBuild one workflow.");
          return "Task:\nBuild one workflow.";
        },
        phase: (name: string) => phases.push(name),
        publishPrimaryArtifact: (name: string, text: string) => {
          publications.push({ name, text });
          return { name, text };
        },
      };

      const result = await runDraftWorkflow(dsl as unknown as Parameters<typeof runDraftWorkflow>[0], wholeInput);

      expect(phases).toEqual(["recon", "draft", "publish"]);
      expect(calls.map((call) => call.options.label)).toEqual(["draft-context", "task-draft", "task-draft-file-route"]);
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
      expect(calls[1]?.prompt).toContain("Give each loop");
      expect(calls[1]?.prompt).toContain("a finite round limit");
      expect(calls[1]?.prompt).toContain("Do not cap the total number of agent calls");
      expect(calls[1]?.prompt).toContain("the plan stage adds the routing calls the source needs");
      expect(calls[1]?.prompt).toContain("a review loop with a finite round limit");
      expect(calls[1]?.prompt).toContain("a finite limit for each loop or list");
      expect(calls[1]?.prompt).not.toContain("call limits");
      expect(publications).toEqual([]);
      expect(readFileSync(draftPath, "utf8")).toBe("Task:\nBuild one workflow.");
      expect(result).toBe("Task:\nBuild one workflow.");
    });
  });
  it.each(["missing assignment", "missing file"])(
    "returns explicit non-success for %s without reconstruction",
    async (scenario) => {
      const calls: string[] = [];
      const dsl = {
        phase: () => undefined,
        agent: async (_prompt: string, options: { label: string }) => {
          calls.push(options.label);
          return options.label === "task-draft-file-route"
            ? "failed"
            : "Complete returned prose cannot substitute for a file.";
        },
      };
      const result = await runDraftWorkflow(dsl as unknown as Parameters<typeof runDraftWorkflow>[0], scenario);
      expect(result).toEqual({ ok: false, status: "failed", reason: "draft_file_unavailable" });
      expect(calls).toEqual(["draft-context", "task-draft", "task-draft-file-route"]);
    },
  );
});
