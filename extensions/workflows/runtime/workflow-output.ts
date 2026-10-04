/** Native workspace confinement, fencing, checkpoints and navigation facade. */
export {
  assertWorkflowWorkspaceDirPath,
  assertWorkflowPhysicalWorkspaceIdentity,
  assertWorkflowRunName,
  isLegacyWorkflowWorkspacePath,
  isWorkflowPathWithinRoot,
  resolveNamedWorkflowWorkspacePath,
  resolveWorkflowWorkspaceDirectory,
  resolveWorkflowWorkspaceDirectoryForReuse,
  resolveWorkflowWorkspaceDirectoryPath,
  resolveWorkflowWorkspacePhysicalIdentityWithoutCreation,
  WORKFLOW_WORKSPACE_DIR_PATTERN,
  WORKFLOW_RUN_NAME_MAX_CHARS,
  WORKFLOW_RUN_NAME_PATTERN,
} from "./workflow-workspace.js";
export type {
  WorkflowWorkspaceDirectory,
  WorkflowWorkspaceDirectoryPath,
  WorkflowPrimaryFileReference,
  WorkflowWorkspaceReuseBinding,
} from "./workflow-workspace.js";
export {
  acquireWorkflowRootLease,
  assertWorkflowRootLease,
  releaseWorkflowRootLease,
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowWorkspaceStateDir,
} from "./location-state/workflow-location-lease.js";
export type { WorkflowRootLease } from "./location-state/workflow-location-lease.js";
export {
  assertFreshWorkflowWorkspaceNamespace,
  assertFreshWorkflowWorkspaceNamespacePath,
  assertUniqueWorkflowItemKeys,
  assertWorkflowItemKey,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  writeWorkflowWorkspaceRunLink,
} from "./workflow-workspace-state.js";
export type { WorkflowCheckpointIdentity, WorkflowCompletedCheckpoint } from "./workflow-workspace-state.js";
