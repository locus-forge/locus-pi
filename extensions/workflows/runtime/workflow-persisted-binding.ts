/** Canonical read-side contract for persisted workflow target/script binding. */

import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkflowExecutionSource, WorkflowIdentityCoverage } from "./workflow-script-identity.js";
import {
  parseWorkflowTargetIdentity,
  workflowSavedNameParts,
  type WorkflowTargetIdentity,
} from "./workflow-saved-name.js";
import { isWorkflowPathWithinRoot } from "./workflow-output.js";
import { projectWorkflowDisposition } from "./workflow-outcome.js";
import {
  assertWorkflowRunId,
  readWorkflowRunFile,
  WORKFLOW_ROOT_DIRNAME,
  WORKFLOW_SAVED_SOURCE_DIRNAME,
  resolveWorkflowRunDir,
  workflowRunRuntimeDir,
} from "./workflow-run-layout.js";

const WORKFLOW_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");

export interface PersistedWorkflowScriptIdentity {
  schemaVersion: 1 | 2;
  identityPolicy: "legacy-unversioned" | "static-node-only-v1";
  sourcePath: string;
  snapshotPath: string;
  scriptSha256: string;
  identityCoverage: WorkflowIdentityCoverage;
  executionSource: WorkflowExecutionSource;
  nodeVersion: string;
  platform: string;
  arch: string;
  builtinImports: string[];
  unboundDependencies: string[];
}

export interface WorkflowPersistedBindingRead {
  target?: WorkflowTargetIdentity;
  targetPath?: string;
  targetInvalid?: string;
  scriptIdentity?: PersistedWorkflowScriptIdentity;
  scriptIdentityInvalid?: string;
  dispositionInvalid?: string;
}

/** Parse only fields shared by result, snapshot, handoff, and artifact readers. */
export function parseWorkflowPersistedBinding(
  record: Record<string, unknown>,
  projectRoot: string,
  runId: string,
  options: { verifySnapshot?: boolean; runDir?: string } = {},
): WorkflowPersistedBindingRead {
  let target: WorkflowTargetIdentity | undefined;
  let targetPath: string | undefined;
  let targetInvalid: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, "target")) {
    try {
      target = parseWorkflowTargetIdentity(record.target);
      validatePersistedScriptPathRef(target, projectRoot);
      const rawPath = (record.target as Record<string, unknown>).path;
      if (rawPath !== undefined) {
        if (typeof rawPath !== "string" || rawPath === "") throw new Error("Workflow target path is invalid.");
        targetPath = validatePersistedWorkflowPath(rawPath, projectRoot, target, "target.path");
      }
    } catch (error) {
      targetInvalid = errorMessage(error);
    }
  }

  let scriptIdentity: PersistedWorkflowScriptIdentity | undefined;
  let scriptIdentityInvalid: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, "scriptIdentity")) {
    try {
      scriptIdentity = parsePersistedWorkflowScriptIdentity(record.scriptIdentity);
    } catch (error) {
      scriptIdentityInvalid = errorMessage(error);
    }
  }
  if (
    scriptIdentity !== undefined &&
    scriptIdentity.schemaVersion === 2 &&
    (target === undefined || targetInvalid !== undefined)
  ) {
    scriptIdentityInvalid =
      target === undefined
        ? "v2 workflow script identity requires a persisted target."
        : "v2 workflow script identity requires a valid persisted target.";
    scriptIdentity = undefined;
  }
  if (scriptIdentity !== undefined && target !== undefined && targetInvalid === undefined) {
    try {
      const sourcePath = validatePersistedWorkflowPath(
        scriptIdentity.sourcePath,
        projectRoot,
        target,
        "scriptIdentity.sourcePath",
      );
      if (targetPath !== undefined && !samePhysicalPath(targetPath, sourcePath)) {
        throw new Error("target.path does not identify the same workflow source as scriptIdentity.sourcePath");
      }
    } catch (error) {
      scriptIdentityInvalid = errorMessage(error);
      scriptIdentity = undefined;
    }
  }
  if (scriptIdentity !== undefined && scriptIdentityInvalid === undefined) {
    try {
      validatePersistedSnapshotBinding(
        scriptIdentity,
        projectRoot,
        runId,
        options.verifySnapshot === true,
        options.runDir,
      );
    } catch (error) {
      scriptIdentityInvalid = errorMessage(error);
      scriptIdentity = undefined;
    }
  }

  const dispositionInvalid = parsePersistedDisposition(record);
  return {
    ...(target === undefined ? {} : { target }),
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(targetInvalid === undefined ? {} : { targetInvalid }),
    ...(scriptIdentity === undefined ? {} : { scriptIdentity }),
    ...(scriptIdentityInvalid === undefined ? {} : { scriptIdentityInvalid }),
    ...(dispositionInvalid === undefined ? {} : { dispositionInvalid }),
  };
}

function validatePersistedScriptPathRef(target: WorkflowTargetIdentity, projectRoot: string): void {
  if (target.kind !== "scriptPath") return;
  if (target.source !== "project") throw new Error("Workflow scriptPath target must use project source.");
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalPath = path.resolve(projectRoot, target.ref);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalPath)) {
    throw new Error("Workflow scriptPath target escapes the project root.");
  }
  validatePersistedWorkflowPath(lexicalPath, projectRoot, target, "target scriptPath ref");
}

/** Strictly verify a retained snapshot before a consumer authorizes replay. */
export function verifyWorkflowPersistedSnapshot(
  projectRoot: string,
  runId: string,
  identity: PersistedWorkflowScriptIdentity,
): void {
  validatePersistedSnapshotBinding(identity, projectRoot, runId, true);
}

/** Require a retained identity's snapshot to be the exact run-owned hash path. */
function validatePersistedSnapshotBinding(
  identity: PersistedWorkflowScriptIdentity,
  projectRoot: string,
  runId: string,
  verifySnapshot: boolean,
  resolvedRunDir?: string,
): void {
  const safeRunId = assertWorkflowRunId(runId);
  const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, safeRunId);
  const expectedPath = path.join(workflowRunRuntimeDir(runDir), `script-${identity.scriptSha256}.workflow.mjs`);
  if (identity.snapshotPath !== expectedPath) {
    throw new Error("Workflow script identity snapshotPath does not match its exact run-owned hash path.");
  }
  if (!verifySnapshot) return;
  let bytes: Buffer;
  try {
    bytes = readWorkflowRunFile(runDir, expectedPath);
  } catch (error) {
    throw new Error(`Workflow script identity snapshot is unavailable: ${errorMessage(error)}.`);
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== identity.scriptSha256) {
    throw new Error(
      `Workflow script identity snapshot hash mismatch: expected ${identity.scriptSha256}, got ${actualSha256}.`,
    );
  }
}

function parsePersistedDisposition(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, "disposition")) return undefined;
  if (typeof record.ok !== "boolean") return "persisted disposition requires a boolean ok field";
  const projected = projectWorkflowDisposition({
    ok: record.ok,
    result: record.result,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    disposition: record.disposition,
  });
  return projected.status === "unknown" ? "persisted disposition is malformed or does not match ok" : undefined;
}

function parsePersistedWorkflowScriptIdentity(value: unknown): PersistedWorkflowScriptIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workflow script identity must be an object.");
  }
  const identity = value as Record<string, unknown>;
  const has = (field: string): boolean => Object.prototype.hasOwnProperty.call(identity, field);
  const exact = (allowed: readonly string[]): void => {
    const unknown = Object.keys(identity).find((field) => !allowed.includes(field));
    if (unknown !== undefined) throw new Error(`Workflow script identity field ${unknown} is not allowed.`);
  };
  if (typeof identity.sourcePath !== "string" || identity.sourcePath === "") {
    throw new Error("Workflow script identity sourcePath is invalid.");
  }
  if (typeof identity.snapshotPath !== "string" || identity.snapshotPath === "") {
    throw new Error("Workflow script identity snapshotPath is invalid.");
  }
  if (typeof identity.scriptSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.scriptSha256)) {
    throw new Error("Workflow script identity scriptSha256 is invalid.");
  }
  if (identity.schemaVersion === 2) {
    exact([
      "schemaVersion",
      "identityPolicy",
      "sourcePath",
      "snapshotPath",
      "scriptSha256",
      "identityCoverage",
      "executionSource",
      "nodeVersion",
      "platform",
      "arch",
      "builtinImports",
      "unboundDependencies",
    ]);
    if (identity.identityPolicy !== "static-node-only-v1")
      throw new Error("Workflow script identity policy is unsupported.");
    if (identity.identityCoverage !== "self-contained-static" && identity.identityCoverage !== "entry-only") {
      throw new Error("Workflow script identity coverage is invalid.");
    }
    if (identity.executionSource !== "snapshot" && identity.executionSource !== "source") {
      throw new Error("Workflow script identity execution source is invalid.");
    }
    for (const field of ["nodeVersion", "platform", "arch"] as const) {
      if (typeof identity[field] !== "string" || identity[field] === "") {
        throw new Error(`Workflow script identity ${field} is invalid.`);
      }
    }
    const builtinImports = parsePersistedStringArray(identity.builtinImports);
    const unboundDependencies = parsePersistedStringArray(identity.unboundDependencies);
    if (builtinImports === undefined || unboundDependencies === undefined) {
      throw new Error("Workflow script identity dependency lists are invalid.");
    }
    if (!isSortedUniqueStrings(builtinImports) || builtinImports.some((specifier) => !specifier.startsWith("node:"))) {
      throw new Error("Workflow script identity builtin imports are invalid.");
    }
    if (!isSortedUniqueStrings(unboundDependencies))
      throw new Error("Workflow script identity dependencies are invalid.");
    if (
      (identity.identityCoverage === "self-contained-static" &&
        (identity.executionSource !== "snapshot" || unboundDependencies.length !== 0)) ||
      (identity.identityCoverage === "entry-only" && identity.executionSource !== "source")
    ) {
      throw new Error("Workflow script identity coverage and execution source are inconsistent.");
    }
    return {
      schemaVersion: 2,
      identityPolicy: identity.identityPolicy,
      sourcePath: identity.sourcePath as string,
      snapshotPath: identity.snapshotPath as string,
      scriptSha256: identity.scriptSha256 as string,
      identityCoverage: identity.identityCoverage,
      executionSource: identity.executionSource,
      nodeVersion: identity.nodeVersion as string,
      platform: identity.platform as string,
      arch: identity.arch as string,
      builtinImports,
      unboundDependencies,
    };
  }
  if (
    has("schemaVersion") ||
    [
      "identityPolicy",
      "identityCoverage",
      "executionSource",
      "nodeVersion",
      "platform",
      "arch",
      "builtinImports",
      "unboundDependencies",
    ].some(has)
  ) {
    throw new Error("Workflow script identity schema version is unsupported or incomplete.");
  }
  exact(["sourcePath", "snapshotPath", "scriptSha256"]);
  return {
    schemaVersion: 1,
    identityPolicy: "legacy-unversioned",
    sourcePath: identity.sourcePath,
    snapshotPath: identity.snapshotPath,
    scriptSha256: identity.scriptSha256,
    identityCoverage: "entry-only-legacy",
    executionSource: "source",
    nodeVersion: "unknown",
    platform: "unknown",
    arch: "unknown",
    builtinImports: [],
    unboundDependencies: [],
  };
}

function validatePersistedWorkflowPath(
  value: string,
  projectRoot: string,
  target: WorkflowTargetIdentity,
  label: string,
): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  const root =
    target.source === "personal"
      ? path.join(os.homedir(), WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME)
      : target.source === "package"
        ? WORKFLOW_PACKAGE_ROOT
        : path.resolve(projectRoot);
  const lexicalRoot = path.resolve(root);
  const lexicalPath = path.resolve(value);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalPath))
    throw new Error(`${label} escapes its ${target.source} workflow root.`);
  try {
    const physicalRoot = realpathSync(lexicalRoot);
    if (target.source === "personal" && !isWorkflowPathWithinRoot(realpathSync(os.homedir()), physicalRoot)) {
      throw new Error("Personal workflow root escapes the physical home directory.");
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  let stat;
  try {
    stat = lstatSync(lexicalPath, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(`${label} is unavailable: ${errorMessage(error)}.`);
  }
  const basename = path.basename(lexicalPath);
  if (target.kind === "name") {
    validatePersistedNamedWorkflowLayout(lexicalPath, lexicalRoot, target, projectRoot, label, stat !== undefined);
  } else {
    if (target.source !== "project") throw new Error("Workflow scriptPath target must use project source.");
    if (basename !== path.basename(target.ref))
      throw new Error(`${label} basename does not match persisted scriptPath ref.`);
    const expected = path.isAbsolute(target.ref) ? path.resolve(target.ref) : path.resolve(projectRoot, target.ref);
    const expectedPhysical = tryRealpath(expected);
    const actualPhysical = tryRealpath(lexicalPath);
    if (
      path.resolve(expected) !== lexicalPath &&
      (expectedPhysical === undefined || actualPhysical !== expectedPhysical)
    ) {
      throw new Error(`${label} does not match persisted scriptPath ref.`);
    }
  }
  if (stat === undefined) return lexicalPath;
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`${label} must identify a regular file.`);
  const physicalRoot = realpathSync(lexicalRoot);
  const physicalPath = realpathSync(lexicalPath);
  if (!statSync(physicalPath).isFile()) throw new Error(`${label} must identify a regular file.`);
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalPath)) {
    throw new Error(`${label} escapes its ${target.source} workflow root through a symlink.`);
  }
  if (target.source === "personal" && !isWorkflowPathWithinRoot(realpathSync(os.homedir()), physicalRoot)) {
    throw new Error("Personal workflow root escapes the physical home directory.");
  }
  if (target.source === "package") validatePackageInventoryPath(lexicalRoot, lexicalPath, label);
  return lexicalPath;
}

function validatePersistedNamedWorkflowLayout(
  lexicalPath: string,
  lexicalRoot: string,
  target: WorkflowTargetIdentity,
  projectRoot: string,
  label: string,
  sourceExists: boolean,
): void {
  const { root, child } = workflowSavedNameParts(target.ref);
  const filename = `${child ?? root}.workflow.mjs`;
  if (path.basename(lexicalPath) !== filename) {
    throw new Error(`${label} basename does not match persisted workflow name.`);
  }
  const folderTail = [root, filename];
  const legacyTail = child === undefined ? [filename] : undefined;
  if (target.source === "project") {
    const relative = path.relative(path.resolve(projectRoot), lexicalPath);
    const parts = relative.split(path.sep).filter(Boolean);
    const matches = parts.some(
      (part, index) =>
        part === WORKFLOW_ROOT_DIRNAME &&
        parts[index + 1] === WORKFLOW_SAVED_SOURCE_DIRNAME &&
        (samePathParts(parts.slice(index + 2), folderTail) ||
          (legacyTail !== undefined && samePathParts(parts.slice(index + 2), legacyTail))),
    );
    if (!matches) throw new Error(`${label} is not under the persisted workflow source root.`);
    return;
  }
  if (!sourceExists) return;
  const relativeParts = path.relative(lexicalRoot, lexicalPath).split(path.sep).filter(Boolean);
  const acceptsLegacy = target.source === "personal" && legacyTail !== undefined;
  if (!samePathParts(relativeParts, folderTail) && !(acceptsLegacy && samePathParts(relativeParts, legacyTail))) {
    throw new Error(`${label} is outside the ${target.source} workflow inventory.`);
  }
}

function samePathParts(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

function validatePackageInventoryPath(root: string, filePath: string, label: string): void {
  let current = path.resolve(root);
  const parts = path.relative(current, filePath).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} uses a symlinked Package inventory entry.`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} uses a non-inventory Package directory.`);
    }
  }
}

/**
 * Bind an existing persisted source to the same executable inventory shape as
 * the live resolver. Missing paths intentionally return before this check so
 * removed historical runs remain readable; current consumers must resolve a
 * present source through the live target binding before execution.
 */
function samePhysicalPath(left: string, right: string): boolean {
  const leftPhysical = tryRealpath(left);
  const rightPhysical = tryRealpath(right);
  return leftPhysical === undefined || rightPhysical === undefined
    ? path.resolve(left) === path.resolve(right)
    : leftPhysical === rightPhysical;
}

function parsePersistedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) return undefined;
  return [...value] as string[];
}

function isSortedUniqueStrings(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) if (values[index - 1]! >= values[index]!) return false;
  return true;
}

function tryRealpath(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
