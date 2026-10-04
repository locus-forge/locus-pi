/** Child execution context, followed by the author's unchanged task. No file placement is injected. */
export const WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR = "\n\n---\n\n";

export function composeWorkflowChildTask(
  prompt: string,
  locations: { pwd?: string; projectRoot?: string } = {},
): string {
  if (locations.pwd === undefined && locations.projectRoot === undefined) return prompt;
  const note = [
    "## Workflow execution context",
    "",
    ...(locations.pwd === undefined ? [] : [`pwd (actual execution directory): ${locations.pwd}`]),
    ...(locations.projectRoot === undefined ? [] : [`project root (source context): ${locations.projectRoot}`]),
    "",
    "Relative tool paths resolve from pwd. Write assigned handoffs and results to the exact destinations in your task, then read back those same files. A requested destination does not change cwd or tool/context loading.",
    "Every file has one assigned writer; read it only after that writer completes. Replace only assigned files with complete writes. Do not search other folders or recreate a missing file from a returned answer.",
    "Keep disposable caches and scratch output in ordinary OS/tool temporary locations; write files needed after a temporary worktree expires to their assigned durable destinations before release.",
    "Never modify runtime-owned journals, transcripts, checkpoints, sessions or leases. Explicitly assigned workflow sources and user files are separate from native runtime records.",
  ].join("\n");
  return `${note}${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}${prompt}`;
}
