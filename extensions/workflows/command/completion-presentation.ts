import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CustomUiComponent, ExtensionAPI, ThemeLike } from "../../_shared/host/pi-api.js";
import { WORKFLOW_RESULT_CUSTOM_TYPE, WORKFLOW_RUN_CUSTOM_TYPE } from "./receipts.js";
import type { RunWorkflowScriptResult } from "../runtime/workflow-runner.js";
import { WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT } from "../runtime/workflow-run-layout.js";

export interface WorkflowCompletionPresentation {
  generatedRunCommand?: string;
  nextAction?: string;
}

/** Package-specific human continuation, derived from existing run evidence. */
export function workflowCompletionPresentation(
  res: RunWorkflowScriptResult,
  safeTarget: string,
): WorkflowCompletionPresentation {
  const ref = packageTaskRef(res, safeTarget);
  if (ref === undefined || res.workspaceDir === undefined || res.workspaceDir === "") return {};
  const primaryFile = res.primaryFile?.absolutePath;
  if (primaryFile === undefined || primaryFile === "") return {};
  if (ref === "task/draft") {
    return {
      nextAction: `Review ${primaryFile}. Copy and edit the complete draft when needed, then pass that accepted text directly: /workflows run task/plan -- <complete accepted draft>.`,
    };
  }
  return {
    nextAction: `Review ${primaryFile}. Copy it to the target project's ${WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT}/<name>.workflow.mjs path, verify its meta.name, then run the saved name through the normal reviewed-workflow path.`,
  };
}

/** Replace Pi's raw custom-message fallback with distinct operator cards. */
export function registerWorkflowTranscriptRenderers(pi: ExtensionAPI): void {
  if (pi.registerMessageRenderer === undefined) return;
  pi.registerMessageRenderer(WORKFLOW_RUN_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    if (typeof message.content !== "string") return undefined;
    const title = workflowRunTitle(message.details?.eventKind);
    // Only the run card gets digest tone: its content is the digest, whose line
    // vocabulary is known. The result card below carries the workflow's own prose,
    // where a leading `✓` is the agent's sentence and not a status marker.
    return workflowTranscriptCard(title, message.content, outputPad, theme, undefined, true);
  });
  pi.registerMessageRenderer(WORKFLOW_RESULT_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    if (typeof message.content !== "string") return undefined;
    const savedPath = detailText(message.details?.primaryFilePath) ?? detailText(message.details?.resultTextPath);
    const nextAction = detailText(message.details?.nextAction);
    return workflowTranscriptCard(
      savedPath === undefined ? "Workflow result" : `Workflow result (${savedPath})`,
      message.content,
      outputPad,
      theme,
      nextAction === undefined ? undefined : { title: "Next action (after review and approval)", text: nextAction },
    );
  });
}

function workflowRunTitle(eventKind: unknown): string {
  if (eventKind === "workflow_start") return "Workflow started";
  if (eventKind === "workflow_rejected") return "Workflow rejected";
  if (eventKind === "workflow_end") return "Workflow finished";
  return "Workflow run";
}

/** Group labels the digest writes on a line of their own (`appendTranscriptGroup`). */
const WORKFLOW_DIGEST_GROUP_TONES = new Map<string, string>([
  ["Files", "accent"],
  ["Commands", "accent"],
  ["Failure", "error"],
]);

/**
 * The digest's status markers, each taking the tone its status already carries in
 * the live panel (`workflowProgressDonePresentation`), so one glyph never means
 * two different things across two surfaces.
 */
const WORKFLOW_DIGEST_MARKER_TONES = new Map<string, string>([
  ["✓", "success"],
  ["✗", "error"],
  ["◐", "warning"],
  ["⊘", "warning"],
  ["■", "warning"],
  ["↻", "accent"],
  ["●", "accent"],
]);

/**
 * Tone for the digest, added HERE and nowhere else. The digest string itself is
 * plain by contract — it enters model context and the session JSONL, where colour
 * is forbidden (workflow-transcript.ts) — so the card paints a copy at render
 * time. Structure only: a group label gains weight, a status marker gains its
 * status colour, and not one character of the text changes.
 */
function paintWorkflowDigest(digest: string, theme: ThemeLike): string {
  return digest
    .split("\n")
    .map((line) => paintWorkflowDigestLine(line, theme))
    .join("\n");
}

function paintWorkflowDigestLine(line: string, theme: ThemeLike): string {
  const groupTone = WORKFLOW_DIGEST_GROUP_TONES.get(line);
  if (groupTone !== undefined) return theme.fg(groupTone, theme.bold(line));
  const marker = line.slice(0, 1);
  const markerTone = WORKFLOW_DIGEST_MARKER_TONES.get(marker);
  if (markerTone === undefined || !line.startsWith(`${marker} `)) return line;
  return `${theme.fg(markerTone, marker)}${line.slice(1)}`;
}

function workflowTranscriptCard(
  title: string,
  content: string,
  outputPad: number,
  theme: ThemeLike,
  footer?: { title: string; text: string },
  decorateDigest = false,
): CustomUiComponent {
  return new WorkflowTranscriptCard(title, content, outputPad, theme, footer, decorateDigest);
}

class WorkflowTranscriptCard implements CustomUiComponent {
  constructor(
    private readonly title: string,
    private readonly content: string,
    private readonly outputPad: number,
    private readonly theme: ThemeLike,
    private readonly footer: { title: string; text: string } | undefined,
    private readonly decorateDigest: boolean,
  ) {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const contentWidth = Math.max(1, safeWidth - Math.max(0, this.outputPad) * 2);
    const content = this.decorateDigest
      ? paintWorkflowDigest(renderWorkflowRunRules(this.content, contentWidth), this.theme)
      : this.content;
    const footerText =
      this.footer === undefined
        ? ""
        : `\n\n${this.theme.fg("accent", this.theme.bold(this.footer.title))}\n${this.footer.text}`;
    const box = new Box(this.outputPad, 1, (text) => this.theme.bg("customMessageBg", text));
    box.addChild(new Text(`${this.theme.fg("accent", this.theme.bold(this.title))}\n${content}${footerText}`, 0, 0));
    return box.render(safeWidth);
  }

  invalidate(): void {
    // Stateless projection: width-specific rules are rebuilt on every render.
  }
}

function renderWorkflowRunRules(digest: string, width: number): string {
  return digest
    .split("\n")
    .map((line) => (line.startsWith("workflow ") ? workflowRunRule(line, width) : line))
    .join("\n");
}

function workflowRunRule(header: string, width: number): string {
  const prefix = `── ${header} `;
  const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix)));
  return truncateToWidth(`${prefix}${fill}`, width);
}

function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

function packageTaskRef(res: RunWorkflowScriptResult, safeTarget: string): "task/draft" | "task/plan" | undefined {
  const ref = res.target !== undefined ? (res.target.source === "package" ? res.target.ref : undefined) : safeTarget;
  return ref === "task/draft" || ref === "task/plan" ? ref : undefined;
}
