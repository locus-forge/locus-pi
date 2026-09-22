import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createWorkflowTranscript,
  registerWorkflowTranscriptRenderers,
} from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import {
  persistCommandWorkflowTranscript,
  WORKFLOW_RESULT_CUSTOM_TYPE,
  WORKFLOW_RUN_CUSTOM_TYPE,
} from "../../../../extensions/workflows/command/receipts.js";
import { createHarness } from "../../../test-harness.js";

const primaryFilePath = "/repo/tmp/plan with spaces/workflow.mjs";
const workspaceDir = "/repo/tmp/plan with spaces";
const nextAction =
  "Review /repo/tmp/plan with spaces/workflow.mjs. Copy it to the target project's .locus-pi/workflows/<name>.workflow.mjs path, verify its meta.name, then run the saved name through the normal reviewed-workflow path.";

describe("workflow completion presentation", () => {
  it("ends the TUI on the exact result with primary path, grouped metadata, and gated next action", async () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-tui", "/repo/.pi/locus-pi/runs/run-plan-tui");
    const completion = transcript.finish({
      runId: "run-plan-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-plan-tui",
      ok: true,
      result: "workflow.mjs is ready for review.",
      resultTextPath: "/repo/.pi/locus-pi/runs/run-plan-tui/outputs/workflow-result.md",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: { relativePath: "workflow.mjs", absolutePath: primaryFilePath, sha256: "abc123", bytes: 42 },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-plan-tui/runtime/result.json" },
    });

    expect(completion.digest).not.toContain("workflow.mjs is ready for review.");
    expect(completion.digest).not.toContain("workspace reuse:");
    expect(completion.digest.indexOf("Files")).toBeLessThan(completion.digest.indexOf("Commands"));
    expect(completion.digest.indexOf("primary file:")).toBeLessThan(completion.digest.indexOf("workspace:"));
    expect(completion.digest).not.toContain("execute.workflow.mjs");
    expect(completion.digest).not.toContain("Next action");
    expect(completion.digest).not.toContain(nextAction);
    expect(completion.nextAction).toBe(nextAction);

    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages.map((entry) => entry.message.details?.eventKind)).toEqual([
      "workflow_end",
      "workflow_result",
    ]);
    expect(harness.sentMessages[1]?.message.details).toMatchObject({ primaryFilePath, nextAction });

    const renderer = harness.messageRenderers.get(WORKFLOW_RESULT_CUSTOM_TYPE)!;
    const rendered = renderer(
      harness.sentMessages[1]!.message,
      { expanded: true, outputPad: 0 },
      { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    )
      ?.render(220)
      .join("\n");
    expect(rendered).toContain(`Workflow result (${primaryFilePath})`);
    expect(rendered).toContain("Next action (after review and approval)");
    expect(rendered).toContain(".locus-pi/workflows/<name>.workflow.mjs");
  });

  it("draws run rules at the live card width while persisted headers stay semantic", async () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-responsive-rule", "/repo/.pi/locus-pi/runs/run-responsive-rule");
    const completion = transcript.finish({
      runId: "run-responsive-rule",
      runDir: "/repo/.pi/locus-pi/runs/run-responsive-rule",
      ok: true,
      result: "Plan ready.",
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-responsive-rule/runtime/result.json" },
    });

    expect(completion.digest).toMatch(/^workflow task\/plan · run #rule · finished /u);
    expect(completion.digest).not.toContain("──");
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    const message = harness.sentMessages[0]!.message;
    const renderer = harness.messageRenderers.get(WORKFLOW_RUN_CUSTOM_TYPE)!;
    for (const width of [48, 80, 180]) {
      const lines = renderer(message, { expanded: true, outputPad: 0 }, plainTheme())!.render(width);
      const rule = lines.find((line) => line.includes("workflow task/plan"));
      expect(rule).toBeDefined();
      expect(rule).toMatch(/^── workflow/u);
      expect(visibleWidth(rule!.trimEnd())).toBe(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  // The digest is plain by contract — it enters model context and the session
  // JSONL. Tone belongs to the card that draws it, and to nothing else.
  it("paints the finished card's group labels and status markers without touching the digest text", async () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-tone", "/repo/.pi/locus-pi/runs/run-plan-tone");
    const completion = transcript.finish({
      runId: "run-plan-tone",
      runDir: "/repo/.pi/locus-pi/runs/run-plan-tone",
      ok: true,
      result: "Planning complete.",
      resultTextPath: "/repo/.pi/locus-pi/runs/run-plan-tone/outputs/workflow-result.md",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: { relativePath: "workflow.mjs", absolutePath: primaryFilePath, sha256: "abc123", bytes: 42 },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-plan-tone/runtime/result.json" },
    });

    expect(completion.digest).toContain("\nFiles\n");
    expect(completion.digest).not.toMatch(/<(?:accent|success|error|warning)>/u);
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    const runMessage = harness.sentMessages.find(
      (entry) =>
        entry.message.customType === WORKFLOW_RUN_CUSTOM_TYPE && entry.message.details?.eventKind === "workflow_end",
    )!;
    const rendered = harness.messageRenderers.get(WORKFLOW_RUN_CUSTOM_TYPE)!(
      runMessage.message,
      { expanded: true, outputPad: 0 },
      {
        fg: (color, text) => `<${color}>${text}</${color}>`,
        bg: (_color, text) => text,
        bold: (text) => `*${text}*`,
      },
    )
      ?.render(220)
      .join("\n");

    expect(rendered).toContain("<accent>*Workflow finished*</accent>");
    expect(rendered).toContain("<accent>*Files*</accent>");
    expect(rendered).toContain("<accent>*Commands*</accent>");
    expect(rendered).toContain("<success>✓</success> workflow task/plan finished");
    // Only the marker is tinted — the sentence after it stays the digest's own text.
    expect(rendered).toContain("primary file: /repo/tmp/plan with spaces/workflow.mjs");
  });

  it("hands a completed task draft to task/plan as editable semantic input", () => {
    const harness = createHarness();
    const planningWorkspace = ".locus-pi/workspaces/20260819-120000-a1b2-task-draft";
    const transcript = createWorkflowTranscript(harness.ctx, "task/draft", "command");
    transcript.start("run-draft-tui", "/repo/.pi/locus-pi/runs/run-draft-tui");
    const completion = transcript.finish({
      runId: "run-draft-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-draft-tui",
      ok: true,
      result: "Task drafting is complete.",
      workspaceDir: `/repo/${planningWorkspace}`,
      workspaceDirRelative: planningWorkspace,
      primaryFile: {
        relativePath: "draft.md",
        absolutePath: `/repo/${planningWorkspace}/draft.md`,
        sha256: "abc123",
        bytes: 120,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-draft-tui/runtime/result.json" },
    });

    expect(completion.nextAction).toContain("/workflows run task/plan -- <complete accepted draft>");
    expect(completion.digest).not.toContain("Next action");
    expect(completion.digest).not.toContain("/workflows run task/plan -- <complete accepted draft>");
    expect(completion.nextAction).toContain("Copy and edit the complete draft");
  });

  it("hands a completed workflow source to the normal saved-workflow path", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "tool");
    const workspace = ".locus-pi/workspaces/airflow-builder";
    transcript.start("run-plan-named", "/repo/.locus-pi/runs/run-plan-named");
    const completion = transcript.finish({
      runId: "run-plan-named",
      runDir: "/repo/.locus-pi/runs/run-plan-named",
      ok: true,
      result: "Workflow source ready.",
      workspaceDir: `/repo/${workspace}`,
      workspaceDirRelative: workspace,
      primaryFile: {
        relativePath: "workflow.mjs",
        absolutePath: `/repo/${workspace}/workflow.mjs`,
        sha256: "abc123",
        bytes: 120,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.locus-pi/runs/run-plan-named/runtime/result.json" },
    });

    expect(completion.nextAction).toContain(".locus-pi/workflows/<name>.workflow.mjs");
    expect(completion.digest).not.toContain("Next action");
    expect(completion.nextAction).toContain("normal reviewed-workflow path");
  });

  it("keeps workflow_end last for non-interactive protocol callers", async () => {
    const harness = createHarness();
    harness.ctx.mode = "json";
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-json", "/tmp/run-plan-json");
    const completion = transcript.finish({
      runId: "run-plan-json",
      runDir: "/tmp/run-plan-json",
      ok: true,
      result: "Plan ready",
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-plan-json/runtime/result.json" },
    });

    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages.map((entry) => entry.message.details?.eventKind)).toEqual([
      "workflow_result",
      "workflow_end",
    ]);
    expect(harness.sentMessages.at(-1)?.message.customType).toBe(WORKFLOW_RUN_CUSTOM_TYPE);
  });
});

function plainTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}
