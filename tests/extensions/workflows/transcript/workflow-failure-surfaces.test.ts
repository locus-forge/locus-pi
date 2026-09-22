import { describe, expect, it, vi } from "vitest";
import type { WorkflowFailureDiagnostic } from "../../../../extensions/workflows/runtime/workflow-failure.js";
import type { RunWorkflowScriptResult } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { WorkflowProgressComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
import { createWorkflowTranscript } from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import { createHarness } from "../../../test-harness.js";

const diagnostic: WorkflowFailureDiagnostic = {
  origin: "script",
  message: "review inventory returned neither a coverage entry nor the declaration",
  stage: "inventory-changes",
  workflow: "review",
  scriptPath: "extensions/workflows/examples/review/review.workflow.mjs",
  evidencePath: ".pi/locus-pi/runs/run-1/artifacts/answers/call-0003-inventory.md.md",
  journalPath: ".pi/locus-pi/runs/run-1/journal.ndjson",
  repairRequest:
    'Fix the "review" workflow: its script rejected the run at stage "inventory-changes" — review inventory ' +
    "returned neither a coverage entry nor the declaration. " +
    "Script: extensions/workflows/examples/review/review.workflow.mjs. " +
    "Failure evidence: .pi/locus-pi/runs/run-1/artifacts/answers/call-0003-inventory.md.md. " +
    "Run journal: .pi/locus-pi/runs/run-1/journal.ndjson.",
};

describe("workflow failure surfaces", () => {
  it("shows where a failed run broke in the live widget without a clipped repair request", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
    const component = new WorkflowProgressComponent(tui, {}, "review", "run-1", { scope: "workflow" });

    component.finish({
      ok: false,
      error: diagnostic.message,
      result: null,
      disposition: { status: "failed" },
      runDir: ".pi/locus-pi/runs/run-1",
      failureDiagnostic: diagnostic,
    });

    const text = component.render(120).join("\n");
    expect(text).toContain("✗ review inventory returned neither a coverage entry nor the declaration");
    expect(text).toContain(
      "stage: inventory-changes · script: extensions/workflows/examples/review/review.workflow.mjs",
    );
    expect(text).toContain("evidence: .pi/locus-pi/runs/run-1/artifacts/answers/call-0003-inventory.md.md");
    expect(text).toContain("journal: .pi/locus-pi/runs/run-1/journal.ndjson");
    // A width-clamped widget cannot carry a copyable request; the transcript does.
    expect(text).not.toContain("copy:");
    expect(component.render(120).every((line) => line.length <= 120)).toBe(true);
  });

  it("leaves the copyable repair request in the persisted workflow_end digest", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "review", "command");
    const failed: RunWorkflowScriptResult = {
      runId: "run-1",
      runDir: "/tmp/run-1",
      ok: false,
      result: null,
      error: diagnostic.message,
      failureDiagnostic: diagnostic,
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-1/result.json" },
    };
    transcript.start("run-1", "/tmp/run-1");

    const digest = transcript.finish(failed).digest;

    expect(digest).toContain("✗ workflow review failed");
    expect(digest).toContain(`copy: ${diagnostic.repairRequest}`);
    expect(digest).toContain("stage: inventory-changes");
  });
});
