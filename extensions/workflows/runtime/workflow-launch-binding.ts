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
  type WorkflowFinalOutputDirectory,
  type WorkflowOutputDirectory,
} from "./workflow-output.js";
import { parseWorkflowPersistedBinding } from "./workflow-persisted-binding.js";

export const WORKFLOW_LAUNCH_BINDING_SCHEMA = "locus-pi.workflow-launch-binding.v2" as const;
const WORKFLOW_LAUNCH_BINDING_FILENAME = "launch-binding.json";
const WORKFLOW_LAUNCH_BINDING_TEMP_FILENAME = "launch-binding.json.tmp";

export interface WorkflowLaunchBinding {
  schema: typeof WORKFLOW_LAUNCH_BINDING_SCHEMA;
  runId: string;
  /** New root launches bind exact recovery inputs; old bindings remain readable, not crash-resumable. */
  recoveryInputSha256?: string;
  /**
   * Original root run id of this launch lineage: a fresh launch records its own
   * run id, every resume copies the source value unchanged. Optional under the
   * same schema so bindings written before it existed stay readable.
   */
  rootLineageId?: string;
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
  output: {
    absolutePath: string;
    relativePath: string;
    physicalPath: string;
    physicalIdentity: string;
    physicalIdentitySchemaVersion: 1;
    source: "declared" | "default";
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
  workspace: WorkflowOutputDirectory;
  workspaceExplicit: boolean;
  output: WorkflowFinalOutputDirectory;
  semanticInput: WorkflowLaunchBinding["semanticInput"];
}): WorkflowLaunchBinding {
  const location = ({ absolutePath, relativePath, physicalPath, identity }: WorkflowOutputDirectory) => ({
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
    output: { ...location(input.output), source: input.output.source },
    semanticInput: input.semanticInput,
  };
}

/**
 * The original root run id a launch continues. A fresh launch starts its own
 * lineage; resume and workspace-reusing handoff continuation copy the source
 * binding's value unchanged. A source binding written before the field existed
 * (or unreadable) anchors the lineage at the source run itself, which can only
 * cost checkpoint reuse, never reuse another lineage's work.
 */
export function readWorkflowRootLineageId(
  projectRoot: string,
  runId: string,
  sourceRunId: string | undefined,
  sourceBinding?: WorkflowLaunchBinding,
): string {
  if (sourceRunId === undefined) return runId;
  return (sourceBinding ?? readWorkflowLaunchBinding(projectRoot, sourceRunId))?.rootLineageId ?? sourceRunId;
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
    outputDir: binding.output.absolutePath,
    outputDirRelative: binding.output.relativePath,
    outputPhysicalIdentity: binding.output.physicalIdentity,
    outputPhysicalIdentitySchemaVersion: 1,
    outputSource: binding.output.source,
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
    result.outputDir === binding.output.absolutePath &&
    result.outputDirRelative === binding.output.relativePath &&
    result.outputPhysicalIdentity === binding.output.physicalIdentity &&
    result.outputPhysicalIdentitySchemaVersion === 1 &&
    result.outputSource === binding.output.source &&
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
      "output",
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
  if (!isOutput(value.output, projectRoot)) {
    throw new Error("workflow launch binding output is invalid");
  }
  if (!isSemanticInput(value.semanticInput)) {
    throw new Error("workflow launch binding semantic identity is invalid");
  }
  if (
    value.recoveryInputSha256 !== undefined &&
    (typeof value.recoveryInputSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.recoveryInputSha256))
  )
    throw new Error("workflow recovery input identity is invalid");
  if (value.rootLineageId !== undefined) assertWorkflowRunId(value.rootLineageId);
  return {
    schema: WORKFLOW_LAUNCH_BINDING_SCHEMA,
    ...(value.recoveryInputSha256 === undefined ? {} : { recoveryInputSha256: value.recoveryInputSha256 as string }),
    ...(value.rootLineageId === undefined ? {} : { rootLineageId: value.rootLineageId as string }),
    runId,
    target: parsed.target,
    scriptIdentity: parsed.scriptIdentity as WorkflowScriptIdentity,
    workspace: value.workspace,
    output: value.output,
    semanticInput: value.semanticInput,
  };
}

function isOutput(value: unknown, projectRoot: string): value is WorkflowLaunchBinding["output"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "absolutePath",
      "relativePath",
      "physicalPath",
      "physicalIdentity",
      "physicalIdentitySchemaVersion",
      "source",
    ])
  )
    return false;
  if (value.source !== "declared" && value.source !== "default") return false;
  const { source: _source, ...workspaceShape } = value;
  return isWorkspace({ ...workspaceShape, explicit: false }, projectRoot);
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
