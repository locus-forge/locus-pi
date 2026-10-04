/**
 * Host-owned launch binding for resume, interrupted recovery and handoff admission.
 *
 * `runtime/result.json` is a mutable presentation envelope. This sidecar is
 * written atomically from validated runtime values and is the authority for
 * source/workspace/input identity. New root runs also carry an exact recovery-input fingerprint.
 */

import path from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  assertWorkflowRunId,
  readWorkflowRunFile,
  renameWorkflowRunFile,
  resolveWorkflowRunDir,
  workflowRunRuntimeFile,
  workflowRunFileExists,
  writeWorkflowRunFile,
} from "./workflow-run-layout.js";
import type { WorkflowScriptIdentity } from "./workflow-script-identity.js";
import type { WorkflowRunResultEnvelope } from "./workflow-journal.js";
import {
  assertWorkflowPhysicalWorkspaceIdentity,
  isWorkflowPathWithinRoot,
  type WorkflowWorkspaceDirectory,
} from "./workflow-output.js";
import { parseWorkflowPersistedBinding } from "./workflow-persisted-binding.js";

export const WORKFLOW_LAUNCH_BINDING_SCHEMA = "locus-pi.workflow-launch-binding.v3" as const;
const WORKFLOW_LAUNCH_BINDING_FILENAME = "launch-binding.json";
const WORKFLOW_LAUNCH_BINDING_TEMP_FILENAME = "launch-binding.json.tmp";

export interface WorkflowLaunchBinding {
  schema: typeof WORKFLOW_LAUNCH_BINDING_SCHEMA;
  runId: string;
  /** Exact launch inputs required for conservative interruption recovery. */
  recoveryInputSha256: string;
  /** Fresh roots start a lineage; every continuation preserves it. */
  rootLineageId: string;
  target: {
    kind: "name" | "scriptPath";
    ref: string;
    source: "project" | "personal" | "package";
  };
  scriptIdentity: WorkflowScriptIdentity;
  workspace: {
    absolutePath: string;
    relativePath: string;
    physicalPath: string;
    physicalIdentity: string;
    physicalIdentitySchemaVersion: 1;
    explicit: boolean;
  };
  semanticInput: {
    present: boolean;
    sha256: string;
  };
}

export function workflowLaunchBindingFile(runDir: string): string {
  return workflowRunRuntimeFile(runDir, WORKFLOW_LAUNCH_BINDING_FILENAME);
}

export function workflowLaunchBindingExists(projectRoot: string, runId: string, resolvedRunDir?: string): boolean {
  const safeRunId = assertWorkflowRunId(runId);
  const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, safeRunId);
  return workflowRunFileExists(runDir, workflowLaunchBindingFile(runDir));
}

/** Assemble the binding from launch values admission has already validated. */
export function createWorkflowLaunchBinding(input: {
  runId: string;
  rootLineageId: string;
  recoveryInputSha256: string;
  target: WorkflowLaunchBinding["target"];
  scriptIdentity: WorkflowScriptIdentity;
  workspace: WorkflowWorkspaceDirectory;
  workspaceExplicit: boolean;
  semanticInput: WorkflowLaunchBinding["semanticInput"];
}): WorkflowLaunchBinding {
  const location = ({ absolutePath, relativePath, physicalPath, identity }: WorkflowWorkspaceDirectory) => ({
    absolutePath,
    relativePath,
    physicalPath,
    physicalIdentity: identity,
    physicalIdentitySchemaVersion: 1 as const,
  });
  return {
    schema: WORKFLOW_LAUNCH_BINDING_SCHEMA,
    runId: input.runId,
    rootLineageId: input.rootLineageId,
    recoveryInputSha256: input.recoveryInputSha256,
    target: input.target,
    scriptIdentity: input.scriptIdentity,
    workspace: { ...location(input.workspace), explicit: input.workspaceExplicit },
    semanticInput: input.semanticInput,
  };
}

/** Preserve only a current-format source lineage; legacy runs require a fresh launch. */
export function readWorkflowRootLineageId(
  projectRoot: string,
  runId: string,
  sourceRunId: string | undefined,
  sourceBinding?: WorkflowLaunchBinding,
): string {
  if (sourceRunId === undefined) return runId;
  const binding = sourceBinding ?? readWorkflowLaunchBinding(projectRoot, sourceRunId);
  if (binding === null) throw new Error(workflowExecutionMigrationMessage(sourceRunId));
  return binding.rootLineageId;
}

export function workflowExecutionMigrationMessage(runId: string): string {
  return `Workflow run ${runId} has no valid host launch binding (output-free v3 required); incompatible or unverifiable execution cannot resume, recover or continue. Start a fresh migrated run with exact file destinations in prompts. Retained evidence remains readable.`;
}

/** Write once, atomically, after all launch values passed runtime validation. */
export function writeWorkflowLaunchBinding(runDir: string, binding: WorkflowLaunchBinding): void {
  assertWorkflowRunId(binding.runId);
  const payload = `${JSON.stringify(binding)}\n`;
  const temporary = workflowRunRuntimeFile(runDir, WORKFLOW_LAUNCH_BINDING_TEMP_FILENAME);
  const destination = workflowLaunchBindingFile(runDir);
  if (workflowRunFileExists(runDir, destination)) {
    throw new Error("Workflow launch binding already exists and is immutable.");
  }
  writeWorkflowRunFile(runDir, temporary, payload, { durable: true, exclusive: true });
  renameWorkflowRunFile(runDir, temporary, destination);
}

/** Best-effort read; malformed or missing bindings are unusable authority. */
export function readWorkflowLaunchBinding(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowLaunchBinding | null {
  try {
    const safeRunId = assertWorkflowRunId(runId);
    const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, safeRunId);
    const record: unknown = JSON.parse(readWorkflowRunFile(runDir, workflowLaunchBindingFile(runDir)).toString("utf8"));
    return parseWorkflowLaunchBinding(record, safeRunId, projectRoot, runDir);
  } catch {
    return null;
  }
}

/** The result envelope an owner resume reads, with every host-owned fact taken from the binding. */
export function projectWorkflowLaunchBindingOntoResult(
  result: WorkflowRunResultEnvelope,
  binding: WorkflowLaunchBinding,
): WorkflowRunResultEnvelope {
  return {
    ...result,
    target: binding.target,
    scriptIdentity: binding.scriptIdentity,
    workspaceDir: binding.workspace.absolutePath,
    workspaceDirRelative: binding.workspace.relativePath,
    workspacePhysicalIdentity: binding.workspace.physicalIdentity,
    workspacePhysicalIdentitySchemaVersion: 1,
    workspaceDirExplicit: binding.workspace.explicit,
    semanticInputPresent: binding.semanticInput.present,
    semanticInputSha256: binding.semanticInput.sha256,
  };
}

/** Verify mutable result projections still match host-owned launch facts. */
export function workflowLaunchBindingMatchesResult(
  binding: WorkflowLaunchBinding,
  result: WorkflowRunResultEnvelope | null,
): boolean {
  if (result === null || result === undefined || result.runId !== binding.runId) return false;
  return (
    JSON.stringify(result.target) === JSON.stringify(binding.target) &&
    JSON.stringify(result.scriptIdentity) === JSON.stringify(binding.scriptIdentity) &&
    result.workspaceDir === binding.workspace.absolutePath &&
    result.workspaceDirRelative === binding.workspace.relativePath &&
    result.workspacePhysicalIdentity === binding.workspace.physicalIdentity &&
    result.workspacePhysicalIdentitySchemaVersion === 1 &&
    result.workspaceDirExplicit === binding.workspace.explicit &&
    result.outputDir === undefined &&
    result.outputDirRelative === undefined &&
    result.outputPhysicalIdentity === undefined &&
    result.outputPhysicalIdentitySchemaVersion === undefined &&
    result.outputSource === undefined &&
    result.primaryFile === undefined &&
    result.semanticInputPresent === binding.semanticInput.present &&
    result.semanticInputSha256 === binding.semanticInput.sha256
  );
}

function parseWorkflowLaunchBinding(
  value: unknown,
  runId: string,
  projectRoot: string,
  runDir: string,
): WorkflowLaunchBinding {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schema",
      "runId",
      "target",
      "scriptIdentity",
      "workspace",
      "semanticInput",
      "recoveryInputSha256",
      "rootLineageId",
    ]) ||
    value.schema !== WORKFLOW_LAUNCH_BINDING_SCHEMA ||
    value.runId !== runId
  ) {
    throw new Error("workflow launch binding schema or run id is invalid");
  }
  if (!isRecord(value.target) || !hasOnlyKeys(value.target, ["kind", "ref", "source"])) {
    throw new Error("workflow launch binding target is invalid");
  }
  const parsed = parseWorkflowPersistedBinding(
    { target: value.target, scriptIdentity: value.scriptIdentity },
    projectRoot,
    runId,
    { verifySnapshot: true, runDir },
  );
  if (parsed.targetInvalid !== undefined || parsed.target === undefined) {
    throw new Error("workflow launch binding target is invalid");
  }
  if (
    parsed.scriptIdentityInvalid !== undefined ||
    parsed.scriptIdentity === undefined ||
    parsed.scriptIdentity.schemaVersion !== 2
  ) {
    throw new Error("workflow launch binding script identity is invalid");
  }
  if (!isWorkspace(value.workspace, projectRoot)) {
    throw new Error("workflow launch binding workspace is invalid");
  }
  if (!isSemanticInput(value.semanticInput)) {
    throw new Error("workflow launch binding semantic identity is invalid");
  }
  if (typeof value.recoveryInputSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.recoveryInputSha256))
    throw new Error("workflow recovery input identity is invalid");
  assertWorkflowRunId(value.rootLineageId);
  return {
    schema: WORKFLOW_LAUNCH_BINDING_SCHEMA,
    recoveryInputSha256: value.recoveryInputSha256 as string,
    rootLineageId: value.rootLineageId as string,
    runId,
    target: parsed.target,
    scriptIdentity: parsed.scriptIdentity as WorkflowScriptIdentity,
    workspace: value.workspace,
    semanticInput: value.semanticInput,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspace(value: unknown, projectRoot: string): value is WorkflowLaunchBinding["workspace"] {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "absolutePath",
      "relativePath",
      "physicalPath",
      "physicalIdentity",
      "physicalIdentitySchemaVersion",
      "explicit",
    ])
  ) {
    return false;
  }
  if (
    typeof value.absolutePath !== "string" ||
    !path.isAbsolute(value.absolutePath) ||
    typeof value.relativePath !== "string" ||
    value.relativePath === "" ||
    typeof value.physicalPath !== "string" ||
    !path.isAbsolute(value.physicalPath) ||
    typeof value.physicalIdentity !== "string" ||
    value.physicalIdentity === "" ||
    value.physicalIdentitySchemaVersion !== 1 ||
    typeof value.explicit !== "boolean"
  ) {
    return false;
  }
  const root = path.resolve(projectRoot);
  const physicalRoot = realpathSync(root);
  const absolute = path.resolve(value.absolutePath);
  let relative: string;
  let physicalIdentity: string;
  try {
    relative = assertWorkflowPhysicalWorkspaceIdentity(value.relativePath);
    physicalIdentity = assertWorkflowPhysicalWorkspaceIdentity(value.physicalIdentity);
  } catch {
    return false;
  }
  const lexicalFromRelative = path.resolve(root, relative);
  if (!isWorkflowPathWithinRoot(root, absolute) || absolute !== lexicalFromRelative) return false;
  const physical = path.resolve(value.physicalPath);
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  let actualPhysical: string;
  try {
    actualPhysical = realpathSync(absolute);
  } catch {
    return false;
  }
  return (
    isWorkflowPathWithinRoot(physicalRoot, physical) &&
    physical === path.resolve(physicalRoot, physicalIdentity) &&
    physical === actualPhysical &&
    statSync(actualPhysical).isDirectory()
  );
}

function isSemanticInput(value: unknown): value is WorkflowLaunchBinding["semanticInput"] {
  if (!isRecord(value) || !hasOnlyKeys(value, ["present", "sha256"])) return false;
  return typeof value.present === "boolean" && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
