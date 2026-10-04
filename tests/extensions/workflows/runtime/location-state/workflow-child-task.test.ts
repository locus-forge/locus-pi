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
});
