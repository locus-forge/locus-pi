/**
 * Compatibility surface for stable workflow outputs and cross-run coordination.
 *
 * Four owners stand behind this name and change for different reasons:
 * `workflow-workspace.ts` resolves and proves locations,
 * `location-state/workflow-bound-directory.ts` binds a root `meta.outputDir` as the one workflow directory,
 * `location-state/workflow-location-lease.ts` owns writer fencing, and
 * `workflow-workspace-state.ts` owns atomic checkpoints and navigation. This
 * module adds no behavior; it re-exports those owners for existing callers.
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
  revalidateWorkflowPrimaryFile,
  WORKFLOW_OUTPUT_DIR_PATTERN,
  WORKFLOW_WORKSPACE_DIR_PATTERN,
  WORKFLOW_RUN_NAME_MAX_CHARS,
  WORKFLOW_RUN_NAME_PATTERN,
} from "./workflow-workspace.js";
export {
  isBoundWorkflowDirectory,
  resolveWorkflowBoundDirectory,
  resolveWorkflowFinalOutputDirectory,
} from "./location-state/workflow-bound-directory.js";
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
  acquireWorkflowLocationLeases,
  acquireWorkflowRootLease,
  assertWorkflowOutputLease,
  assertWorkflowRootLease,
  releaseWorkflowOutputLease,
  releaseWorkflowRootLease,
  WORKFLOW_OUTPUT_LEASE_FILE,
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowFinalOutputStateDir,
  workflowOutputStateDir,
} from "./location-state/workflow-location-lease.js";
export type { WorkflowOutputLease, WorkflowRootLease } from "./location-state/workflow-location-lease.js";

export {
  assertFreshWorkflowOutputNamespace,
  assertFreshWorkflowOutputNamespacePath,
  assertUniqueWorkflowItemKeys,
  assertWorkflowItemKey,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  WORKFLOW_OUTPUT_LOCK_FILE,
  writeWorkflowWorkspaceRunLink,
} from "./workflow-workspace-state.js";
export type { WorkflowCheckpointIdentity, WorkflowCompletedCheckpoint } from "./workflow-workspace-state.js";
