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
  assertWorkflowWorkspaceDirPath,
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
  resolveWorkflowWorkspaceDirectory,
  resolveWorkflowWorkspaceDirectoryForReuse,
  resolveWorkflowWorkspaceDirectoryPath,
  resolveWorkflowWorkspacePhysicalIdentityWithoutCreation,
  resolveWorkflowFinalOutputDirectory,
  revalidateWorkflowPrimaryFile,
  WORKFLOW_OUTPUT_DIR_PATTERN,
  WORKFLOW_WORKSPACE_DIR_PATTERN,
  WORKFLOW_RUN_NAME_MAX_CHARS,
  WORKFLOW_RUN_NAME_PATTERN,
} from "./workflow-workspace.js";
export type {
  WorkflowOutputDirectory,
  WorkflowOutputDirectoryPath,
  WorkflowFinalOutputDirectory,
  WorkflowOutputSource,
  WorkflowWorkspaceDirectory,
  WorkflowWorkspaceDirectoryPath,
  WorkflowPrimaryFileReference,
  WorkflowWorkspaceReuseBinding,
} from "./workflow-workspace.js";

export {
  acquireWorkflowOutputLease,
  acquireWorkflowRootLease,
  assertFreshWorkflowOutputNamespace,
  assertFreshWorkflowOutputNamespacePath,
  assertUniqueWorkflowItemKeys,
  assertWorkflowItemKey,
  assertWorkflowOutputLease,
  assertWorkflowRootLease,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  releaseWorkflowOutputLease,
  releaseWorkflowRootLease,
  WORKFLOW_OUTPUT_LEASE_FILE,
  WORKFLOW_OUTPUT_LOCK_FILE,
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowFinalOutputStateDir,
  workflowOutputStateDir,
  writeWorkflowWorkspaceRunLink,
} from "./workflow-workspace-state.js";
export type {
  WorkflowCheckpointIdentity,
  WorkflowCompletedCheckpoint,
  WorkflowOutputLease,
  WorkflowRootLease,
} from "./workflow-workspace-state.js";
