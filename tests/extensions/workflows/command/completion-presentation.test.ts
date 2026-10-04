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

const workspaceDir = "/repo/tmp/plan with spaces";
const nextAction =
  "Open the exact assigned source file, verify its current bytes and source checks, then copy it to .locus-pi/workflows/<name>/<name>.workflow.mjs and run the saved name. Do not infer a path from returned prose.";

describe("workflow completion presentation", () => {
  it("ends the TUI on exact result prose without attesting or inferring a user file", async () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-tui", "/repo/.pi/locus-pi/runs/run-plan-tui");
    const completion = transcript.finish({
      runId: "run-plan-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-plan-tui",
      ok: true,
      result: "workflow.mjs is ready for review at /unverified/prose/workflow.mjs.",
      resultTextPath: "/repo/.pi/locus-pi/runs/run-plan-tui/outputs/workflow-result.md",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-plan-tui/runtime/result.json" },
    });

    expect(completion.digest).not.toContain("workflow.mjs is ready for review.");
    expect(completion.digest).not.toContain("workspace reuse:");
    expect(completion.digest.indexOf("Files")).toBeLessThan(completion.digest.indexOf("Commands"));
    expect(completion.digest).not.toContain("primary file:");
    expect(completion.digest).not.toContain("execute.workflow.mjs");
    expect(completion.digest).not.toContain("Next action");
    expect(completion.digest).not.toContain(nextAction);
    expect(completion.nextAction).toBe(nextAction);

    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages.map((entry) => entry.message.details?.eventKind)).toEqual([
      "workflow_end",
      "workflow_result",
    ]);
    expect(harness.sentMessages[1]?.message.details).toMatchObject({ nextAction });
    expect(harness.sentMessages[1]?.message.details).not.toHaveProperty("primaryFilePath");
    expect(harness.sentMessages[0]?.message.details).not.toHaveProperty("primaryFilePath");
    expect(completion.nextAction).not.toContain("/unverified/prose/workflow.mjs");
    expect(completion.nextAction).not.toContain(workspaceDir);

    const renderer = harness.messageRenderers.get(WORKFLOW_RESULT_CUSTOM_TYPE)!;
    const rendered = renderer(
      harness.sentMessages[1]!.message,
      { expanded: true, outputPad: 0 },
      { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    )
      ?.render(220)
      .join("\n");
    expect(rendered).toContain("Workflow result");
    expect(rendered).toContain("Next action (after review and approval)");
    expect(rendered).toContain(".locus-pi/workflows/<name>/<name>.workflow.mjs");
  });

  it("renders a historical primary-file receipt without replacing its persisted path", () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const primaryFilePath = "/repo/legacy output/workflow.mjs";
    const message = {
      customType: WORKFLOW_RESULT_CUSTOM_TYPE,
      content: "Historical source ready.",
      details: {
        eventKind: "workflow_result",
        primaryFilePath,
        resultTextPath: "/repo/legacy-run/outputs/workflow-result.md",
      },
    };
    const original = JSON.stringify(message);
    const rendered = harness.messageRenderers.get(WORKFLOW_RESULT_CUSTOM_TYPE)!(
      message,
      { expanded: true, outputPad: 0 },
      plainTheme(),
    )!
      .render(220)
      .join("\n");

    expect(rendered).toContain(`Workflow result (${primaryFilePath})`);
    expect(rendered).toContain("Historical source ready.");
    expect(JSON.stringify(message)).toBe(original);
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
    expect(rendered).not.toContain("primary file:");
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
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-draft-tui/runtime/result.json" },
    });

    expect(completion.nextAction).toContain("/workflows run task/plan");
    expect(completion.digest).not.toContain("Next action");
    expect(completion.digest).not.toContain("/workflows run task/plan");
    expect(completion.nextAction).toContain("accepted bytes and explicit destination instructions");
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
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.locus-pi/runs/run-plan-named/runtime/result.json" },
    });

    expect(completion.nextAction).toContain(".locus-pi/workflows/<name>/<name>.workflow.mjs");
    expect(completion.digest).not.toContain("Next action");
    expect(completion.nextAction).toContain("run the saved name");
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
