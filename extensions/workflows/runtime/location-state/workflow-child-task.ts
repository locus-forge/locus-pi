/**
 * The child task as a workflow agent receives it: one filesystem-locations note,
 * a fixed separator, then the author's prompt. This module owns only that text;
 * `workflow-agent-bridge.ts` decides which locations a call has.
 */

/**
 * Rule between this run's working-directory note and the workflow's own prompt.
 *
 * A stable, single boundary: the note never contains it, so the FIRST occurrence
 * in a composed child task always marks where the author's prompt begins.
 */
export const WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR = "\n\n---\n\n";

/**
 * The child task as the model receives it: this run's working-directory note,
 * then the workflow's own prompt.
 *
 * The note goes FIRST so the choice contract a choice call appends stays the last
 * thing the child reads. Without a configured
 * directory the author's prompt travels alone.
 *
 * Every workflow child receives the full tool surface. When a run workspace is
 * configured, say plainly where files belong so write/edit/bash work without an
 * author-maintained tool list.
 */
export function composeWorkflowChildTask(
  prompt: string,
  workflowWorkspaceDir: string | undefined,
  locations: { pwd?: string; projectRoot?: string } = {},
  workflowOutputDir?: string,
): string {
  if (
    (workflowWorkspaceDir === undefined || workflowWorkspaceDir.trim() === "") &&
    locations.projectRoot === undefined
  ) {
    return prompt;
  }
  if (workflowWorkspaceDir !== undefined && workflowOutputDir === workflowWorkspaceDir) {
    return `${boundWorkflowDirectoryNote(workflowWorkspaceDir, locations)}${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}${prompt}`;
  }
  const note = [
    "## Workflow filesystem locations",
    "",
    ...(workflowWorkspaceDir === undefined
      ? []
      : [`workflow workspace (handoffs and intermediate files): ${workflowWorkspaceDir}`]),
    ...(workflowOutputDir === undefined ? [] : [`workflow output (final deliverables): ${workflowOutputDir}`]),
    ...(locations.pwd === undefined ? [] : [`pwd (code workspace): ${locations.pwd}`]),
    ...(locations.projectRoot === undefined ? [] : [`project root (source context): ${locations.projectRoot}`]),
    "",
    `Use pwd for code work. Durable handoffs, review evidence, and explicit resume inputs belong in the workflow workspace above.${workflowOutputDir === undefined ? "" : " Final deliverables belong in workflow output."} A task artifact folder (.tasks/<task>/artifacts/<stage>/) remains authoritative when the authored prompt selects one.`,
    "Keep disposable environments, dependency caches, test basetemp, transient renderer output, and staging in ordinary OS/tool temporary or cache locations, never beside evidence; promote anything needed for review or resume before its temporary or cache location expires.",
    "Files already in the workflow workspace are another owner's state: read them and replace only assigned files, idempotently.",
    "Never modify runtime-owned state or leases beneath .locus-pi. An instruction to write no other artifact means create or modify no other file; it never authorizes cleanup.",
    "This is placement guidance only. An authored prompt that explicitly requests another placement remains authoritative.",
    "Workflow files keep their exact names; runtime records references and does not reconstruct their content.",
  ].join("\n");
  return `${note}${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}${prompt}`;
}

/** A root meta.outputDir is the one directory every agent of the run shares. */
function boundWorkflowDirectoryNote(
  workflowDirectory: string,
  locations: { pwd?: string; projectRoot?: string },
): string {
  return [
    "## Workflow filesystem locations",
    "",
    `workflow directory (handoffs under artifacts/, final files): ${workflowDirectory}`,
    ...(locations.pwd === undefined ? [] : [`pwd (code workspace): ${locations.pwd}`]),
    ...(locations.projectRoot === undefined ? [] : [`project root (source context): ${locations.projectRoot}`]),
    "",
    "Relative handoff paths named in this task (for example artifacts/scope/scope.md) resolve against the workflow directory above, never against pwd or project root.",
    "Use pwd for code work. Handoffs for other agents belong beneath artifacts/ in the workflow directory; final deliverables belong in the workflow directory itself.",
    "Keep disposable environments, dependency caches, test basetemp, transient renderer output, and staging in ordinary OS/tool temporary or cache locations, never beside evidence; promote anything needed for review or resume before its temporary or cache location expires.",
    "Files already in the workflow directory may belong to another agent or an earlier run: read them, and replace only your assigned files, each with one complete write.",
    "Never modify runtime-owned state or leases beneath .locus-pi. An instruction to write no other artifact means create or modify no other file; it never authorizes cleanup.",
    "This is placement guidance only. An authored prompt that explicitly requests another placement remains authoritative.",
    "Workflow files keep their exact names; runtime records references and does not reconstruct their content.",
  ].join("\n");
}
