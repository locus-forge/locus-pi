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
    "Relative tool paths resolve from pwd. Use the exact destinations in your task for shared handoffs and Task-required output files; their assigned writers save and read back those same files. A requested destination does not change cwd or tool/context loading.",
    "Each shared handoff or required output has one assigned writer. Consumers read it only after that writer completes. Replace only your assigned handoff/output files with complete writes; never search other folders for a missing assigned file or recreate it from a returned answer.",
    "If your task assigns you implementation work in a product root, you may inspect and choose/create/edit internal product files there without an exhaustive filename list. This does not override Task-required filenames, narrower write boundaries, or read-only reviewer roles. Preserve unrelated files and all other task/host restrictions. The project-root label alone grants no write permission.",
    "Keep disposable caches and scratch output in ordinary OS/tool temporary locations; write files needed after a temporary worktree expires to their assigned durable destinations before release.",
    "Never modify runtime-owned journals, transcripts, checkpoints, sessions or leases. Explicitly assigned workflow sources and user files are separate from native runtime records.",
  ].join("\n");
  return `${note}${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}${prompt}`;
}
