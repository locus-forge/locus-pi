import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { composeWorkflowChildTask } from "../../../../../extensions/workflows/runtime/location-state/workflow-child-task.js";

describe("bound workflow directory child task note", () => {
  it("names one bound workflow directory and resolves relative handoff paths against it", () => {
    const directory = "/projects/main/.local/airflow-review";
    const task = composeWorkflowChildTask(
      "write artifacts/scope/scope.md",
      directory,
      { pwd: "/projects/main", projectRoot: "/projects/main" },
      directory,
    );

    assert.match(task, /^## Workflow filesystem locations/u);
    assert.equal(task.split(directory).length - 1, 1);
    assert.match(
      task,
      /workflow directory \(handoffs under artifacts\/, final files\): \/projects\/main\/\.local\/airflow-review/u,
    );
    assert.doesNotMatch(task, /workflow workspace \(/u);
    assert.doesNotMatch(task, /workflow output \(/u);
    assert.match(
      task,
      /Relative handoff paths named in this task \(for example artifacts\/scope\/scope\.md\) resolve against the workflow directory above, never against pwd or project root\./u,
    );
    assert.match(task, /replace only your assigned files, each with one complete write/u);
    assert.match(task, /Never modify runtime-owned state or leases beneath \.locus-pi/u);
    assert.ok(task.endsWith("write artifacts/scope/scope.md"));
  });

  it("keeps two named locations when output is separate from the workspace", () => {
    const task = composeWorkflowChildTask(
      "draft",
      "/p/.locus-pi/workspaces/run",
      {},
      "/p/.locus-pi/workspaces/run/outputs",
    );
    assert.match(task, /workflow workspace \(handoffs and intermediate files\): \/p\/\.locus-pi\/workspaces\/run$/mu);
    assert.match(task, /workflow output \(final deliverables\): \/p\/\.locus-pi\/workspaces\/run\/outputs$/mu);
    assert.doesNotMatch(task, /workflow directory \(/u);
  });
});
