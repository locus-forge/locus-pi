/**
 * Checkpoints and navigation written under an already fenced workflow workspace.
 *
 * `location-state/workflow-location-lease.ts` owns the lease protocol. This
 * module consumes its opaque lease, then owns runtime backlinks and atomic
 * completed-item checkpoints keyed by the physical workspace identity.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertWorkflowRunId, workflowRunDir } from "./workflow-run-layout.js";
import {
  ensureDirectoryWithoutSymlinks,
  isNodeError,
  isWorkflowPathWithinRoot,
  resolveWorkflowOutputPhysicalIdentityWithoutCreation,
  type WorkflowOutputDirectory,
  type WorkflowOutputDirectoryPath,
  type WorkflowPrimaryFileReference,
} from "./workflow-workspace.js";
import {
  assertWorkflowRootLease,
  workflowOutputStateDir,
  type WorkflowRootLease,
} from "./location-state/workflow-location-lease.js";
import {
  assertWorkflowStatePath,
  fsyncDirectory,
  InvalidJsonContentError,
  readJson,
  writeNewDurableJson,
} from "./location-state/workflow-state-files.js";

const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CHECKPOINT_SCHEMA = "locus-pi.workflow-checkpoint.v2" as const;
/** @deprecated Runtime locks no longer live in workspace or output directories. */
export const WORKFLOW_OUTPUT_LOCK_FILE = ".locus-pi-workflow.lock";
const WORKFLOW_WORKSPACE_RUNS_MARKER = "<!-- locus-pi:workflow-workspace-runs:v1 -->";
// Retained only to read and upgrade navigation written by earlier versions.
const LEGACY_WORKFLOW_WORKSPACE_RUNS_HEADER =
  `${WORKFLOW_WORKSPACE_RUNS_MARKER}\n# Связанные запуски workflow\n\n` +
  `Статусы и история находятся в папках групп; этот файл содержит только ссылки.\n\n`;

const WORKFLOW_WORKSPACE_RUNS_HEADER =
  `${WORKFLOW_WORKSPACE_RUNS_MARKER}\n# Linked workflow runs\n\n` +
  `Status and history are stored in group directories; this file contains links only.\n\n`;

export interface WorkflowCheckpointIdentity {
  parentScriptSha256: string;
  childScriptSha256: string;
  workspaceIdentity: string;
  outputIdentity: string;
  itemKey: string;
  /**
   * Launch lineage of a bound root (`meta.outputDir`). Unbound identities omit it,
   * so their checkpoint file names and records are exactly the earlier v2 ones.
   */
  rootLineageId?: string;
}

export interface WorkflowCompletedCheckpoint extends WorkflowCheckpointIdentity {
  schema: typeof CHECKPOINT_SCHEMA;
  status: "completed";
  childRunId: string;
  completedAt: string;
  primaryFile?: WorkflowPrimaryFileReference;
}

export function assertWorkflowItemKey(key: string): string {
  if (typeof key !== "string" || !ITEM_KEY.test(key)) {
    throw new Error(
      "workflow child key must be 1-200 characters using letters, numbers, dot, underscore, colon, or hyphen",
    );
  }
  return key;
}

export function assertUniqueWorkflowItemKeys(keys: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const key of keys) {
    assertWorkflowItemKey(key);
    if (seen.has(key)) throw new Error(`workflow child key is duplicated: ${JSON.stringify(key)}`);
    seen.add(key);
  }
  return Object.freeze([...keys]);
}

/** Runtime-owned atomic backlinks. Never replace a pre-existing user document. */
export function writeWorkflowWorkspaceRunLink(
  lease: WorkflowRootLease,
  groupDir: string,
  storageRootRunId: string,
): void {
  assertWorkflowRootLease(lease);
  const file = path.join(lease.workspaceDir, ".workflow-runs.md");
  const href = path.relative(lease.workspaceDir, groupDir).split(path.sep).map(encodeURIComponent).join("/");
  const line = `- [Group ${assertWorkflowRunId(storageRootRunId)}](${href}/README.md).\n`;
  const exists = assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, file, "file", false);
  const original = exists ? readFileSync(file, "utf8") : WORKFLOW_WORKSPACE_RUNS_HEADER;
  const previous = original.startsWith(LEGACY_WORKFLOW_WORKSPACE_RUNS_HEADER)
    ? WORKFLOW_WORKSPACE_RUNS_HEADER +
      original.slice(LEGACY_WORKFLOW_WORKSPACE_RUNS_HEADER.length).replace(/^- \[Группа /gmu, "- [Group ")
    : original;
  if (exists && !previous.startsWith(WORKFLOW_WORKSPACE_RUNS_MARKER + "\n")) {
    throw new Error(`Reserved workflow workspace file already exists: ${file}`);
  }
  if (!validWorkflowWorkspaceRunLinks(previous, lease.projectRoot, lease.workspaceDir)) {
    throw Object.assign(new Error(`Workflow backlink file requires recovery before it can be updated: ${file}`), {
      code: "WORKFLOW_NAVIGATION_RECOVERY_REQUIRED",
    });
  }
  const updated = previous.split("\n").includes(line.trimEnd()) ? previous : previous + line;
  if (updated === original) return;
  assertWorkflowRootLease(lease);
  replaceWorkflowWorkspaceTextFile(lease, file, updated);
}

function validWorkflowWorkspaceRunLinks(text: string, projectRoot: string, workspaceDir: string): boolean {
  if (!text.startsWith(WORKFLOW_WORKSPACE_RUNS_HEADER) || !text.endsWith("\n")) return false;
  const links = text.slice(WORKFLOW_WORKSPACE_RUNS_HEADER.length).split("\n").filter(Boolean);
  const groups = new Set<string>();
  for (const link of links) {
    const match = /^- \[Group ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\]\(([^\r\n()]+)\/README\.md\)\.$/u.exec(link);
    if (match === null || groups.has(match[1]!)) return false;
    const groupId = match[1]!;
    const expectedHref = path
      .relative(workspaceDir, workflowRunDir(projectRoot, groupId))
      .split(path.sep)
      .map(encodeURIComponent)
      .join("/");
    if (match[2] !== expectedHref) return false;
    groups.add(groupId);
  }
  return true;
}

function replaceWorkflowWorkspaceTextFile(lease: WorkflowRootLease, file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, temporary, "file", false);
  let created = false;
  try {
    writeNewDurableText(temporary, text);
    created = true;
    assertWorkflowRootLease(lease);
    assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, temporary, "file", true);
    assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, file, "file", false);
    renameSync(temporary, file);
    created = false;
    fsyncDirectory(path.dirname(file));
  } finally {
    if (created && assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, temporary, "file", false)) {
      unlinkSync(temporary);
    }
  }
}

export function readWorkflowCompletedCheckpoint(
  lease: WorkflowRootLease,
  identity: WorkflowCheckpointIdentity,
): WorkflowCompletedCheckpoint | undefined {
  assertWorkflowRootLease(lease);
  const file = checkpointFile(lease, identity);
  if (!assertCheckpointPath(lease, file, false)) return undefined;
  let value: unknown;
  try {
    value = readJson(file);
  } catch (error) {
    if (!(error instanceof InvalidJsonContentError)) throw error;
    quarantineWorkflowCheckpoint(lease, file);
    return undefined;
  }
  if (!isCompletedCheckpoint(value) || !sameCheckpointIdentity(value, identity)) {
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { schema?: unknown }).schema === "locus-pi.workflow-checkpoint.v1"
    ) {
      throw new Error("legacy single-location workflow checkpoint cannot be reused after workspace/output separation");
    }
    quarantineWorkflowCheckpoint(lease, file);
    return undefined;
  }
  assertWorkflowRootLease(lease);
  return value;
}

export function commitWorkflowCompletedCheckpoint(
  lease: WorkflowRootLease,
  input: WorkflowCheckpointIdentity & {
    childRunId: string;
    primaryFile?: WorkflowPrimaryFileReference;
  },
): WorkflowCompletedCheckpoint {
  assertWorkflowRootLease(lease);
  const childRunId = assertWorkflowRunId(input.childRunId);
  const record: WorkflowCompletedCheckpoint = {
    schema: CHECKPOINT_SCHEMA,
    status: "completed",
    parentScriptSha256: input.parentScriptSha256,
    childScriptSha256: input.childScriptSha256,
    workspaceIdentity: input.workspaceIdentity,
    outputIdentity: input.outputIdentity,
    itemKey: input.itemKey,
    ...(input.rootLineageId === undefined ? {} : { rootLineageId: input.rootLineageId }),
    childRunId,
    completedAt: new Date().toISOString(),
    ...(input.primaryFile === undefined ? {} : { primaryFile: input.primaryFile }),
  };
  const file = checkpointFile(lease, input);
  ensureDirectoryWithoutSymlinks(lease.projectRoot, path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  assertCheckpointPath(lease, temporary, false);
  writeNewDurableJson(temporary, record);
  assertWorkflowRootLease(lease);
  assertCheckpointPath(lease, temporary, true);
  assertCheckpointPath(lease, file, false);
  renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
  return record;
}

/**
 * Fresh semantic targets must not inherit any prior durable state in a named
 * namespace. This is intentionally opt-in: ordinary workflows retain their
 * historical default/retry behavior, while an owner can reject unsafe fresh
 * reuse before acquiring a lease or reading checkpoints.
 */
export function assertFreshWorkflowOutputNamespace(input: {
  projectRoot: string;
  output: WorkflowOutputDirectory;
}): void {
  assertFreshWorkflowOutputNamespaceIdentity({
    projectRoot: input.projectRoot,
    relativePath: input.output.relativePath,
    identity: input.output.identity,
  });
}

/** Check fresh-owner durable state from a lexical candidate without creating it. */
export function assertFreshWorkflowOutputNamespacePath(input: {
  projectRoot: string;
  output: WorkflowOutputDirectoryPath;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const identity = resolveWorkflowOutputPhysicalIdentityWithoutCreation(projectRoot, input.output.absolutePath);
  assertFreshWorkflowOutputNamespaceIdentity({
    projectRoot,
    relativePath: input.output.relativePath,
    identity,
  });
}

function assertFreshWorkflowOutputNamespaceIdentity(input: {
  projectRoot: string;
  relativePath: string;
  identity: string;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const stateDir = workflowOutputStateDir(projectRoot, input.identity);
  const state = lstatSync(stateDir, { throwIfNoEntry: false });
  if (state === undefined) return;
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`workflow outputDir state namespace is not a regular directory: ${stateDir}`);
  }
  const physicalRoot = realpathSync(projectRoot);
  const physicalState = realpathSync(stateDir);
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalState)) {
    throw new Error(`workflow outputDir state namespace escapes the project root: ${stateDir}`);
  }
  throw new Error(
    `workflow workspace ${JSON.stringify(input.relativePath)} already has durable post-code-review state; ` +
      "choose a new --run-name or --workspace-dir, or resume the original run",
  );
}

function checkpointFile(lease: WorkflowRootLease, identity: WorkflowCheckpointIdentity): string {
  assertWorkflowItemKey(identity.itemKey);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        identity.parentScriptSha256,
        identity.childScriptSha256,
        identity.workspaceIdentity,
        identity.outputIdentity,
        identity.itemKey,
        ...(identity.rootLineageId === undefined ? [] : [identity.rootLineageId]),
      ]),
    )
    .digest("hex");
  return path.join(lease.stateDir, "checkpoints", `${digest}.json`);
}

/**
 * Prove the checkpoint path remains inside the leased project/state namespace.
 * `readJson()` protects the leaf descriptor; this proof protects every path
 * component before any existence probe, open, or quarantine rename.
 */
function assertCheckpointPath(lease: WorkflowRootLease, file: string, mustExist: boolean): boolean {
  return assertWorkflowStatePath(lease.projectRoot, lease.stateDir, file, "file", mustExist);
}

function quarantineWorkflowCheckpoint(lease: WorkflowRootLease, file: string): void {
  assertWorkflowRootLease(lease);
  assertCheckpointPath(lease, file, true);
  const stale = `${file}.stale-${randomUUID()}`;
  assertCheckpointPath(lease, stale, false);
  try {
    renameSync(file, stale);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  fsyncDirectory(path.dirname(file));
}

function writeNewDurableText(file: string, text: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isCompletedCheckpoint(value: unknown): value is WorkflowCompletedCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowCompletedCheckpoint>;
  let childRunId: string;
  try {
    childRunId = assertWorkflowRunId(record.childRunId);
  } catch {
    return false;
  }
  return (
    record.schema === CHECKPOINT_SCHEMA &&
    record.status === "completed" &&
    typeof record.parentScriptSha256 === "string" &&
    typeof record.childScriptSha256 === "string" &&
    typeof record.workspaceIdentity === "string" &&
    typeof record.outputIdentity === "string" &&
    typeof record.itemKey === "string" &&
    (record.rootLineageId === undefined || typeof record.rootLineageId === "string") &&
    record.childRunId === childRunId &&
    typeof record.completedAt === "string" &&
    (record.primaryFile === undefined || isPrimaryFileReference(record.primaryFile))
  );
}

function isPrimaryFileReference(value: unknown): value is WorkflowPrimaryFileReference {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowPrimaryFileReference>;
  return (
    typeof record.relativePath === "string" &&
    typeof record.absolutePath === "string" &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.sha256) &&
    Number.isSafeInteger(record.bytes) &&
    (record.bytes ?? 0) > 0
  );
}

function sameCheckpointIdentity(
  checkpoint: WorkflowCompletedCheckpoint,
  identity: WorkflowCheckpointIdentity,
): boolean {
  return (
    checkpoint.parentScriptSha256 === identity.parentScriptSha256 &&
    checkpoint.childScriptSha256 === identity.childScriptSha256 &&
    checkpoint.workspaceIdentity === identity.workspaceIdentity &&
    checkpoint.outputIdentity === identity.outputIdentity &&
    checkpoint.itemKey === identity.itemKey &&
    checkpoint.rootLineageId === identity.rootLineageId
  );
}
