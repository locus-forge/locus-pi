/**
 * Fenced durable state for one workflow workspace.
 *
 * The workspace-local single-root lease, its fencing token, runtime backlinks,
 * and atomic completed-item checkpoints all live under a namespace keyed by the
 * physical workspace identity. That identity is computed only by
 * `workflow-workspace.ts`; this module consumes it and adds no path resolution
 * of its own.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertWorkflowRunId, workflowRunDir, workflowRootDir } from "./workflow-run-layout.js";
import {
  ensureDirectoryWithoutSymlinks,
  isNodeError,
  isWorkflowPathWithinRoot,
  resolveWorkflowOutputPhysicalIdentityWithoutCreation,
  type WorkflowOutputDirectory,
  type WorkflowOutputDirectoryPath,
  type WorkflowPrimaryFileReference,
} from "./workflow-workspace.js";

const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CHECKPOINT_SCHEMA = "locus-pi.workflow-checkpoint.v1" as const;
const LEASE_SCHEMA = "locus-pi.workflow-output-lease.v1" as const;
export const WORKFLOW_OUTPUT_LOCK_FILE = ".locus-pi-workflow.lock";
const LEASE_OWNER_READ_ATTEMPTS = 20;
const LEASE_OWNER_READ_RETRY_MS = 5;
const LEASE_OWNER_READ_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const WORKFLOW_WORKSPACE_RUNS_MARKER = "<!-- locus-pi:workflow-workspace-runs:v1 -->";
// Retained only to read and upgrade navigation written by earlier versions.
const LEGACY_WORKFLOW_WORKSPACE_RUNS_HEADER =
  `${WORKFLOW_WORKSPACE_RUNS_MARKER}\n# Связанные запуски workflow\n\n` +
  `Статусы и история находятся в папках групп; этот файл содержит только ссылки.\n\n`;

const WORKFLOW_WORKSPACE_RUNS_HEADER =
  `${WORKFLOW_WORKSPACE_RUNS_MARKER}\n# Linked workflow runs\n\n` +
  `Status and history are stored in group directories; this file contains links only.\n\n`;

class InvalidJsonContentError extends Error {}
class UnstableJsonReadError extends Error {}

export interface WorkflowCheckpointIdentity {
  parentScriptSha256: string;
  childScriptSha256: string;
  outputDir: string;
  itemKey: string;
}

export interface WorkflowCompletedCheckpoint extends WorkflowCheckpointIdentity {
  schema: typeof CHECKPOINT_SCHEMA;
  status: "completed";
  childRunId: string;
  completedAt: string;
  primaryFile?: WorkflowPrimaryFileReference;
}

interface WorkflowLeaseRecord {
  schema: typeof LEASE_SCHEMA;
  rootRunId: string;
  outputDir: string;
  pid: number;
  fencingToken: string;
  acquiredAt: string;
}

/** Opaque host-only context. Workflow source never receives this object. */
export interface WorkflowRootLease {
  readonly projectRoot: string;
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly lockFile: string;
  readonly record: WorkflowLeaseRecord;
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

/** Atomically acquire exclusive ownership of one workflow workspace. */
export function acquireWorkflowRootLease(input: {
  projectRoot: string;
  output: WorkflowOutputDirectory;
  rootRunId: string;
}): WorkflowRootLease {
  const projectRoot = path.resolve(input.projectRoot);
  const stateDir = workflowOutputStateDir(projectRoot, input.output.identity);
  ensureDirectoryWithoutSymlinks(projectRoot, stateDir);
  assertWorkflowStatePath(projectRoot, stateDir, stateDir, "directory", true);
  const workspaceDir = input.output.absolutePath;
  const lockFile = path.join(workspaceDir, WORKFLOW_OUTPUT_LOCK_FILE);
  const record: WorkflowLeaseRecord = {
    schema: LEASE_SCHEMA,
    rootRunId: input.rootRunId,
    outputDir: input.output.relativePath,
    pid: process.pid,
    fencingToken: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", false);
      try {
        writeNewDurableJson(lockFile, record, { syncParentDirectory: true });
      } catch (error) {
        // An owner may have won the create-to-write window. Leave its lock
        // intact so the outer EEXIST path can inspect it.
        if (!isNodeError(error, "EEXIST")) removeLeaseFile(projectRoot, workspaceDir, lockFile);
        throw error;
      }
      return { projectRoot, stateDir, workspaceDir, lockFile, record };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const current = readLeaseRecordDuringAcquisition(projectRoot, workspaceDir, lockFile);
      if (current === undefined) continue;
      const liveness = processLiveness(current.pid);
      if (liveness === "alive") {
        throw new Error(
          `workflow outputDir ${JSON.stringify(input.output.relativePath)} is owned by live run ${current.rootRunId} (pid ${current.pid}); stop that run or choose another outputDir`,
        );
      }
      if (liveness === "unverifiable") {
        throw new Error(
          `workflow outputDir ${JSON.stringify(input.output.relativePath)} has an unverifiable owner pid ${current.pid}; verify the process and remove ${lockFile} only after proving it stopped`,
        );
      }
      const staleFile = `${lockFile}.stale-${randomUUID()}`;
      assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", true);
      assertWorkflowStatePath(projectRoot, workspaceDir, staleFile, "file", false);
      try {
        renameSync(lockFile, staleFile);
      } catch (renameError) {
        if (isNodeError(renameError, "ENOENT")) continue;
        throw renameError;
      }
      removeLeaseFile(projectRoot, workspaceDir, staleFile);
    }
  }
  throw new Error(
    `workflow outputDir lease contention did not settle for ${JSON.stringify(input.output.relativePath)}`,
  );
}

export function assertWorkflowRootLease(lease: WorkflowRootLease): void {
  const current = readLeaseRecord(lease.projectRoot, lease.workspaceDir, lease.lockFile);
  if (
    current.fencingToken !== lease.record.fencingToken ||
    current.rootRunId !== lease.record.rootRunId ||
    current.pid !== lease.record.pid
  ) {
    throw new Error(`workflow output lease fencing token is stale for ${JSON.stringify(lease.record.outputDir)}`);
  }
}

export function releaseWorkflowRootLease(lease: WorkflowRootLease): void {
  assertWorkflowRootLease(lease);
  removeLeaseFile(lease.projectRoot, lease.workspaceDir, lease.lockFile);
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
    outputDir: input.outputDir,
    itemKey: input.itemKey,
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

export function workflowOutputStateDir(projectRoot: string, canonicalOutputIdentity: string): string {
  const namespace = createHash("sha256").update(canonicalOutputIdentity).digest("hex");
  return path.join(workflowRootDir(path.resolve(projectRoot)), "workflow-state", "v1", namespace);
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
      "choose a new --run-name or --output-dir, or resume the original run",
  );
}

function checkpointFile(lease: WorkflowRootLease, identity: WorkflowCheckpointIdentity): string {
  assertWorkflowItemKey(identity.itemKey);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([identity.parentScriptSha256, identity.childScriptSha256, identity.outputDir, identity.itemKey]),
    )
    .digest("hex");
  return path.join(lease.stateDir, "checkpoints", `${digest}.json`);
}

type WorkflowStateLeafKind = "file" | "directory";

/** Prove a state path's complete lexical and physical ancestor chain. */
function assertWorkflowStatePath(
  projectRoot: string,
  stateDir: string,
  target: string,
  leafKind: WorkflowStateLeafKind,
  mustExist: boolean,
): boolean {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalStateDir = path.resolve(stateDir);
  const lexicalFile = path.resolve(target);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalStateDir)) {
    throw new Error("workflow state directory escapes the project root");
  }
  if (!isWorkflowPathWithinRoot(lexicalStateDir, lexicalFile)) {
    throw new Error("workflow state path escapes the leased state directory");
  }

  const rootStat = lstatSync(lexicalRoot, { throwIfNoEntry: false });
  if (rootStat === undefined) {
    throw new Error("workflow state project root is not a regular directory");
  }
  const physicalRoot = realpathSync(lexicalRoot);
  const physicalRootStat = lstatSync(physicalRoot, { throwIfNoEntry: false });
  if (physicalRootStat === undefined || physicalRootStat.isSymbolicLink() || !physicalRootStat.isDirectory()) {
    throw new Error("workflow state project root is not a regular directory");
  }
  const relative = path.relative(lexicalRoot, lexicalFile);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 0) throw new Error("workflow state path must name a leaf");

  let current = lexicalRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const isLeaf = index === parts.length - 1;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (mustExist) throw new Error(`workflow state path is missing: ${current}`);
      return false;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`workflow state path contains a symlink: ${current}`);
    }
    const leafIsWrongType = leafKind === "file" ? !stat.isFile() : !stat.isDirectory();
    if (isLeaf ? leafIsWrongType : !stat.isDirectory()) {
      throw new Error(
        isLeaf
          ? `workflow state path is not a regular ${leafKind}: ${current}`
          : `workflow state path ancestor is not a directory: ${current}`,
      );
    }
    const physicalCurrent = realpathSync(current);
    if (!isWorkflowPathWithinRoot(physicalRoot, physicalCurrent)) {
      throw new Error(`workflow state path escapes the physical project root: ${current}`);
    }
  }
  return true;
}

/**
 * Prove the checkpoint path remains inside the leased project/state namespace.
 * `readJson()` protects the leaf descriptor; this proof protects every path
 * component before any existence probe, open, or quarantine rename.
 */
function assertCheckpointPath(lease: WorkflowRootLease, file: string, mustExist: boolean): boolean {
  return assertWorkflowStatePath(lease.projectRoot, lease.stateDir, file, "file", mustExist);
}

function readLeaseRecord(projectRoot: string, workspaceDir: string, lockFile: string): WorkflowLeaseRecord {
  let value: unknown;
  try {
    assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", true);
    value = readJson(lockFile);
  } catch (error) {
    throw new Error(
      `workflow output lease owner is unreadable at ${lockFile}; verify no writer is active before manual removal: ${String(error)}`,
    );
  }
  if (!isLeaseRecord(value)) {
    throw new Error(
      `workflow output lease owner is unverifiable at ${lockFile}; verify no writer is active before removal`,
    );
  }
  return value;
}

/** A new owner creates its lock before durable JSON is complete; tolerate only that bounded window. */
function readLeaseRecordDuringAcquisition(
  projectRoot: string,
  workspaceDir: string,
  lockFile: string,
): WorkflowLeaseRecord | undefined {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      return readLeaseRecord(projectRoot, workspaceDir, lockFile);
    } catch (error) {
      lastError = error;
      if (!assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", false)) return undefined;
      if (attempt + 1 < LEASE_OWNER_READ_ATTEMPTS) {
        Atomics.wait(LEASE_OWNER_READ_WAIT, 0, 0, LEASE_OWNER_READ_RETRY_MS);
      }
    }
  }
  throw lastError;
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

function processLiveness(pid: number): "alive" | "dead" | "unverifiable" {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unverifiable";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return "dead";
    return "unverifiable";
  }
}

function removeLeaseFile(projectRoot: string, workspaceDir: string, lockFile: string): void {
  if (assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", false)) unlinkSync(lockFile);
}

function writeNewDurableJson(file: string, value: unknown, options: { syncParentDirectory?: boolean } = {}): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (options.syncParentDirectory) fsyncDirectory(path.dirname(file));
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

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`JSON state path is not a regular file: ${file}`);
    if (before.size > 1024 * 1024) throw new InvalidJsonContentError(`JSON state file exceeds 1 MiB: ${file}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) {
        throw new UnstableJsonReadError(`JSON state file changed during read: ${file}`);
      }
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new UnstableJsonReadError(`JSON state file changed during read: ${file}`);
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new InvalidJsonContentError(
        `JSON state file contains invalid JSON: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

function isLeaseRecord(value: unknown): value is WorkflowLeaseRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowLeaseRecord>;
  return (
    record.schema === LEASE_SCHEMA &&
    typeof record.rootRunId === "string" &&
    typeof record.outputDir === "string" &&
    Number.isSafeInteger(record.pid) &&
    typeof record.fencingToken === "string" &&
    typeof record.acquiredAt === "string"
  );
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
    typeof record.outputDir === "string" &&
    typeof record.itemKey === "string" &&
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
    checkpoint.outputDir === identity.outputDir &&
    checkpoint.itemKey === identity.itemKey
  );
}
