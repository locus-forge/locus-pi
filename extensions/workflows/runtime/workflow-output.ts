/**
 * Compatibility surface for stable workflow outputs and cross-run coordination.
 *
 * Two owners stand behind this name and change for different reasons:
 * `workflow-workspace.ts` resolves where a workspace is and proves what its
 * files are, and `workflow-workspace-state.ts` owns the fenced lease and the
 * atomic checkpoints keyed by that workspace identity. This module adds no
 * behavior; it re-exports both owners under the names existing callers already
 * import. Import the owning module directly in new code.
 */

export {
  assertWorkflowOutputDirPath,
  assertWorkflowPhysicalWorkspaceIdentity,
  assertWorkflowRunName,
  ensureWorkflowWorkspaceFile,
  isLegacyWorkflowWorkspacePath,
  isWorkflowPathWithinRoot,
  referenceWorkflowPrimaryFile,
  resolveNamedWorkflowWorkspacePath,
  resolveWorkflowOutputDirectory,
  resolveWorkflowOutputDirectoryForReuse,
  resolveWorkflowOutputDirectoryPath,
  revalidateWorkflowPrimaryFile,
  WORKFLOW_OUTPUT_DIR_PATTERN,
  WORKFLOW_RUN_NAME_MAX_CHARS,
  WORKFLOW_RUN_NAME_PATTERN,
} from "./workflow-workspace.js";
export type {
  WorkflowOutputDirectory,
  WorkflowOutputDirectoryPath,
  WorkflowPrimaryFileReference,
  WorkflowWorkspaceReuseBinding,
} from "./workflow-workspace.js";

export {
  acquireWorkflowRootLease,
  assertFreshWorkflowOutputNamespace,
  assertFreshWorkflowOutputNamespacePath,
  assertUniqueWorkflowItemKeys,
  assertWorkflowItemKey,
  assertWorkflowRootLease,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  releaseWorkflowRootLease,
  WORKFLOW_OUTPUT_LOCK_FILE,
  workflowOutputStateDir,
  writeWorkflowWorkspaceRunLink,
} from "./workflow-workspace-state.js";
export type {
  WorkflowCheckpointIdentity,
  WorkflowCompletedCheckpoint,
  WorkflowRootLease,
} from "./workflow-workspace-state.js";
