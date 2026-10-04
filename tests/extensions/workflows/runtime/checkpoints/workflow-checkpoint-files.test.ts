/** Native completion checkpoints preserve orchestration, never ordinary file effects. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../../test-harness.js";
import { executor, project, writeWorkflow, CHILD, PARENT } from "../../../../fixtures/workflow-durable-project.js";

describe("native checkpoints and caller-owned files", () => {
  it("does not restore missing files or attest changed files when a completion checkpoint is reused", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const assignedFile = path.join(root, "reports", "alpha.md");
    let calls = 0;
    const run = (resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        workspaceDir: "state/native-child",
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor: executor(() => {
          calls += 1;
          mkdirSync(path.dirname(assignedFile), { recursive: true });
          writeFileSync(assignedFile, "assigned bytes\n");
          return "written";
        }),
      });
    const first = await run();
    expect(first.ok, first.error).toBe(true);
    unlinkSync(assignedFile);
    const missing = await run(first.runId);
    expect(missing.ok, missing.error).toBe(true);
    expect(missing.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
    expect(existsSync(assignedFile)).toBe(false);
    writeFileSync(assignedFile, "changed bytes\n");
    const changed = await run(missing.runId);
    expect(changed.ok, changed.error).toBe(true);
    expect(changed.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
    expect(calls).toBe(1);
    expect(readFileSync(assignedFile, "utf8")).toBe("changed bytes\n");
    expect(changed).not.toHaveProperty("primaryFile");
  });
});
