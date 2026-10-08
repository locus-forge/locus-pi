import { describe, expect, it } from "vitest";
import {
  composeWorkflowChildTask,
  WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR,
} from "../../../../../extensions/workflows/runtime/location-state/workflow-child-task.js";

describe("workflow child execution context", () => {
  it("labels actual cwd separately from projectRoot without rebasing assigned files", () => {
    const prompt = "Write /reports/review.md; read that exact file back.";
    const task = composeWorkflowChildTask(prompt, { pwd: "/project/nested", projectRoot: "/project" });
    expect(task).toContain("pwd (actual execution directory): /project/nested");
    expect(task).toContain("project root (source context): /project");
    expect(task).toContain("Relative tool paths resolve from pwd");
    expect(task).toContain("exact destinations in your task");
    expect(task).not.toContain("workflow workspace (handoffs");
    expect(task).not.toContain("workflow output (final");
    expect(task.split(WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR)[1]).toBe(prompt);
  });

  it("leaves an unconfigured embedding's authored prompt byte-for-byte unchanged", () => {
    const prompt = "  Exact input\nWrite /outside/answer.md.\n";
    expect(composeWorkflowChildTask(prompt)).toBe(prompt);
  });

  it.each([
    { pwd: "/project/nested" },
    { projectRoot: "/project" },
    { pwd: "/project/nested", projectRoot: "/project" },
  ])("preserves original Task bytes even with whitespace, Unicode and an embedded separator: %o", (locations) => {
    const prompt = `  Original Task: preserve data once, then reload.\r\nπ 日本\n${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}Do not reinterpret.\n`;
    const task = composeWorkflowChildTask(prompt, locations);
    expect(Buffer.from(task.slice(-prompt.length))).toEqual(Buffer.from(prompt));
    expect(task.slice(0, -prompt.length)).toMatch(/\n\n---\n\n$/u);
  });

  it("scopes exact-file coordination without requiring an implementation's internal file inventory", () => {
    const prompt = "Implement under /product; choose its module layout. Write findings to /reports/findings.md.";
    const task = composeWorkflowChildTask(prompt, { pwd: "/product", projectRoot: "/product" });
    expect(task).toContain("shared handoffs and Task-required output files");
    expect(task).toContain("assigned writers save and read back those same files");
    expect(task).toContain("Consumers read it only after that writer completes");
    expect(task).toContain("never search other folders for a missing assigned file");
    expect(task).toContain("or recreate it from a returned answer");
    expect(task).toContain("choose/create/edit internal product files there without an exhaustive filename list");
    expect(task).not.toContain("Every file has one assigned writer");
    expect(task).not.toContain("Replace only assigned files");
    expect(task).toContain("Preserve unrelated files and all other task/host restrictions");
    expect(task).toContain("project-root label alone grants no write permission");
    expect(task).toContain("Never modify runtime-owned journals, transcripts, checkpoints, sessions or leases");
    expect(task.endsWith(prompt)).toBe(true);
  });

  it.each([
    "Implement only /product/index.html. No other product files; report to /reports/implementation.md.",
    "Review /product read-only. Write only /reports/findings.md; do not modify product files.",
  ])("keeps narrower output and reviewer boundaries binding: %s", (prompt) => {
    const task = composeWorkflowChildTask(prompt, { pwd: "/product", projectRoot: "/product" });
    expect(task).toContain("If your task assigns you implementation work in a product root");
    expect(task).toContain(
      "does not override Task-required filenames, narrower write boundaries, or read-only reviewer roles",
    );
    expect(task.endsWith(prompt)).toBe(true);
  });
});
