/**
 * The bound workflow directory: a root `meta.outputDir` is the single directory
 * a run's agents share for handoffs and final files.
 *
 * This module owns the declared-output grammar, final-output resolution, and the
 * rules binding adds to admission: no launch-side directory selection, no
 * resume or continuation of a run recorded with another directory, and saved
 * children that reuse the root's proven binding instead of re-deriving it
 * through the launch `workspaceDir` grammar. `workflow-workspace.ts` owns
 * confinement and physical identity; `workflow-run-admission.ts` owns ordering.
 */

import path from "node:path";
import { WORKFLOW_ROOT_DIRNAME } from "../workflow-run-layout.js";
import {
  resolveConfinedWorkflowDirectory,
  resolveWorkflowOutputDirectoryForReuse,
  type WorkflowFinalOutputDirectory,
  type WorkflowOutputDirectory,
} from "../workflow-workspace.js";

const DECLARED_OUTPUT_COMPONENT = /^(?:\.?[A-Za-z0-9][A-Za-z0-9._-]{0,199})$/u;

/**
 * Resolve the user-visible final-output directory. Without a declaration it is
 * the exact `<workspace>/outputs` subtree. A root `meta.outputDir` declaration
 * is the bound workflow directory itself, so the runtime workspace must be that
 * same physical directory; any other workspace is a split contract and fails.
 */
export function resolveWorkflowFinalOutputDirectory(
  projectRoot: string,
  declaredOutputDir: string | undefined,
  workspace: WorkflowOutputDirectory,
): WorkflowFinalOutputDirectory {
  if (declaredOutputDir === undefined) {
    const output = resolveConfinedWorkflowDirectory(
      projectRoot,
      `${workspace.relativePath}/outputs`,
      "workflow outputDir",
    );
    return { ...output, source: "default" };
  }
  const output = resolveWorkflowBoundDirectory(projectRoot, declaredOutputDir);
  if (output.identity !== workspace.identity || output.physicalPath !== workspace.physicalPath) {
    throw new Error(
      `workflow meta.outputDir ${JSON.stringify(declaredOutputDir)} is the workflow directory; ` +
        `the runtime workspace ${JSON.stringify(workspace.relativePath)} must be the same directory`,
    );
  }
  return { ...output, source: "declared" };
}

/**
 * Resolve and create the directory a root `meta.outputDir` binds as its single
 * workflow directory. Only the declared-output grammar applies; the public
 * launch `workspaceDir` grammar never sees this path.
 */
export function resolveWorkflowBoundDirectory(projectRoot: string, declaredOutputDir: string): WorkflowOutputDirectory {
  return resolveConfinedWorkflowDirectory(
    projectRoot,
    assertWorkflowDeclaredOutputDirPath(declaredOutputDir),
    "workflow outputDir",
  );
}

/** True when a root `meta.outputDir` bound workspace and output to one directory. */
export function isBoundWorkflowDirectory(
  workspace: WorkflowOutputDirectory,
  output: WorkflowFinalOutputDirectory,
): boolean {
  return output.source === "declared" && output.identity === workspace.identity;
}

/** Strict root-metadata path grammar; `.local/...` is intentionally supported. */
export function assertWorkflowDeclaredOutputDirPath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error("workflow meta.outputDir must be one non-empty trimmed project-relative path");
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\")) {
    throw new Error("workflow meta.outputDir must be project-relative");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || !DECLARED_OUTPUT_COMPONENT.test(part))) {
    throw new Error(`workflow meta.outputDir contains an unsafe path component: ${JSON.stringify(value)}`);
  }
  if (parts[0] === WORKFLOW_ROOT_DIRNAME || parts[0] === ".git") {
    throw new Error(`workflow meta.outputDir uses a runtime-reserved root: ${JSON.stringify(parts[0])}`);
  }
  return value;
}

/** A bound root refuses any launch-side directory selection before a child starts. */
export function assertBoundWorkflowLaunchSelection(
  boundDirectory: string | undefined,
  launch: { workspaceDir?: string; runName?: string },
): void {
  if (boundDirectory === undefined || (launch.workspaceDir === undefined && launch.runName === undefined)) return;
  throw new Error(
    `workflow declares meta.outputDir ${JSON.stringify(boundDirectory)}, which is its workflow directory; ` +
      "workspaceDir and runName are not accepted for this workflow",
  );
}

/**
 * A bound root resumes only a run recorded in that same directory. A run
 * recorded with a separate workspace (before binding, or under another
 * declaration) is refused, not migrated; nothing is deleted.
 */
export function assertBoundWorkflowResumeSource(
  boundDirectory: string | undefined,
  sourceRunId: string,
  source: { workspace: { relativePath: string }; output: { relativePath: string } },
): void {
  if (boundDirectory === undefined || source.workspace.relativePath === boundDirectory) return;
  throw new Error(
    `Cannot resume workflow: source run ${sourceRunId} used workspace ${JSON.stringify(source.workspace.relativePath)} ` +
      `and output ${JSON.stringify(source.output.relativePath)}; meta.outputDir ${JSON.stringify(boundDirectory)} ` +
      "is now the single workflow directory. Start a fresh run.",
  );
}

/** A bound root continues an operator handoff only in that same directory. */
export function assertBoundWorkflowHandoffSource(
  boundDirectory: string | undefined,
  handoffWorkspace: { relativePath: string } | undefined,
): void {
  if (boundDirectory === undefined || handoffWorkspace === undefined) return;
  if (handoffWorkspace.relativePath === boundDirectory) return;
  throw new Error(
    `Cannot continue workflow: the handoff source used workspace ${JSON.stringify(handoffWorkspace.relativePath)}; ` +
      `meta.outputDir ${JSON.stringify(boundDirectory)} is now the single workflow directory. Start a fresh run.`,
  );
}

/** Re-prove an inherited bound directory by physical identity; unbound inheritance returns undefined. */
export function reuseInheritedBoundWorkflowDirectory(
  projectRoot: string,
  inherited: { workspace: WorkflowOutputDirectory; output: WorkflowFinalOutputDirectory } | undefined,
): WorkflowOutputDirectory | undefined {
  if (inherited === undefined || !isBoundWorkflowDirectory(inherited.workspace, inherited.output)) return undefined;
  const { relativePath, absolutePath, physicalPath, identity } = inherited.workspace;
  return resolveWorkflowOutputDirectoryForReuse(
    projectRoot,
    { relativePath, absolutePath, physicalPath, physicalIdentity: identity, explicit: false },
    { create: false },
  );
}
