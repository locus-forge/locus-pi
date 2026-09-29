/** Exclusive workspace/output leases and serialized same-host reclaim. */

import { createHash, randomUUID } from "node:crypto";
import { renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { workflowRootDir } from "../workflow-run-layout.js";
import {
  ensureDirectoryWithoutSymlinks,
  isNodeError,
  type WorkflowFinalOutputDirectory,
  type WorkflowOutputDirectory,
} from "../workflow-workspace.js";
import { inspectLeaseOwner, leaseMayBeReclaimed, workflowLeaseOwnershipError } from "./workflow-lease-evidence.js";
import {
  assertWorkflowStatePath,
  fsyncDirectory,
  projectRelativeStatePath,
  readJson,
  stateFileRemovalCommand,
  writeNewDurableJson,
} from "./workflow-state-files.js";

const LEASE_SCHEMA = "locus-pi.workflow-location-lease.v2" as const;
export const WORKFLOW_WORKSPACE_LEASE_FILE = "lease.json";
export const WORKFLOW_OUTPUT_LEASE_FILE = "lease.json";
export const WORKFLOW_LEASE_RECLAIM_GUARD_FILE = "reclaim.json";
const LEASE_OWNER_READ_ATTEMPTS = 20;
const LEASE_OWNER_READ_RETRY_MS = 5;
// A reclaim can restart after a disappearing lease, a disappearing guard, or
// a normal acquirer winning the rename-to-create gap. Bound all three without
// turning transient contention into an unbounded main-thread wait.
const LEASE_ACQUISITION_ATTEMPTS = 6;
const LEASE_OWNER_READ_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface WorkflowLeaseRecord {
  schema: typeof LEASE_SCHEMA;
  kind: "workspace" | "output";
  rootRunId: string;
  relativePath: string;
  identity: string;
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

/** Independent final-output writer fence. It never stores state below outputDir. */
export interface WorkflowOutputLease {
  readonly projectRoot: string;
  readonly stateDir: string;
  readonly outputDir: string;
  readonly lockFile: string;
  readonly record: WorkflowLeaseRecord;
}

/** Atomically acquire exclusive ownership of one workflow workspace. */
export function acquireWorkflowRootLease(input: {
  projectRoot: string;
  output: WorkflowOutputDirectory;
  rootRunId: string;
  force?: boolean;
}): WorkflowRootLease {
  const acquired = acquireWorkflowLocationLease({
    projectRoot: input.projectRoot,
    location: input.output,
    rootRunId: input.rootRunId,
    kind: "workspace",
    force: input.force === true,
  });
  return { ...acquired, workspaceDir: input.output.absolutePath };
}

/** Atomically acquire exclusive ownership of one final output directory. */
export function acquireWorkflowOutputLease(input: {
  projectRoot: string;
  output: WorkflowFinalOutputDirectory;
  rootRunId: string;
  force?: boolean;
}): WorkflowOutputLease {
  const acquired = acquireWorkflowLocationLease({
    projectRoot: input.projectRoot,
    location: input.output,
    rootRunId: input.rootRunId,
    kind: "output",
    force: input.force === true,
  });
  return { ...acquired, outputDir: input.output.absolutePath };
}

/** Acquire both root fences or roll the first one back before reporting failure. */
export function acquireWorkflowLocationLeases(
  projectRoot: string,
  workspace: WorkflowOutputDirectory,
  output: WorkflowFinalOutputDirectory,
  rootRunId: string,
  force: boolean,
): [WorkflowRootLease, WorkflowOutputLease] {
  const rootLease = acquireWorkflowRootLease({ projectRoot, output: workspace, rootRunId, force });
  try {
    return [rootLease, acquireWorkflowOutputLease({ projectRoot, output, rootRunId, force })];
  } catch (error) {
    try {
      releaseWorkflowRootLease(rootLease);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "workflow output lease acquisition and root lease rollback failed",
      );
    }
    throw error;
  }
}

interface WorkflowLocationLeaseInput {
  projectRoot: string;
  stateDir: string;
  lockFile: string;
  location: WorkflowOutputDirectory;
  rootRunId: string;
  kind: "workspace" | "output";
  force: boolean;
  record: WorkflowLeaseRecord;
}

type WorkflowLocationLease = Omit<WorkflowRootLease, "workspaceDir">;

function acquireWorkflowLocationLease(input: {
  projectRoot: string;
  location: WorkflowOutputDirectory;
  rootRunId: string;
  kind: "workspace" | "output";
  force: boolean;
}): WorkflowLocationLease {
  const projectRoot = path.resolve(input.projectRoot);
  const stateDir =
    input.kind === "workspace"
      ? workflowOutputStateDir(projectRoot, input.location.identity)
      : workflowFinalOutputStateDir(projectRoot, input.location.identity);
  ensureDirectoryWithoutSymlinks(projectRoot, stateDir);
  assertWorkflowStatePath(projectRoot, stateDir, stateDir, "directory", true);
  const lockFile = path.join(
    stateDir,
    input.kind === "workspace" ? WORKFLOW_WORKSPACE_LEASE_FILE : WORKFLOW_OUTPUT_LEASE_FILE,
  );
  const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
  const record: WorkflowLeaseRecord = {
    schema: LEASE_SCHEMA,
    kind: input.kind,
    rootRunId: input.rootRunId,
    relativePath: input.location.relativePath,
    identity: input.location.identity,
    pid: process.pid,
    fencingToken: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < LEASE_ACQUISITION_ATTEMPTS; attempt += 1) {
    if (tryCreateLeaseFile(projectRoot, stateDir, lockFile, record)) {
      return { projectRoot, stateDir, lockFile, record };
    }
    const current = readLeaseRecordDuringAcquisition(projectRoot, stateDir, lockFile, "lease");
    if (current === undefined) continue;
    const owner = inspectLeaseOwner(projectRoot, current);
    if (!leaseMayBeReclaimed(input.force, owner)) {
      throw workflowLeaseOwnershipError(input, lockFile, current, owner);
    }
    const guarded = tryAcquireReclaimGuard({ ...input, projectRoot, stateDir, lockFile, guardFile, record });
    if (guarded === "retry") continue;
    return guarded;
  }
  throw new Error(
    `workflow ${input.kind} lease contention did not settle for ${JSON.stringify(input.location.relativePath)}.\n` +
      `Lease: ${projectRelativeStatePath(projectRoot, lockFile)}\n` +
      "Recovery: retry the launch; if contention persists, inspect only the named lease and its owner.",
  );
}

function tryCreateLeaseFile(
  projectRoot: string,
  stateDir: string,
  lockFile: string,
  record: WorkflowLeaseRecord,
): boolean {
  assertWorkflowStatePath(projectRoot, stateDir, lockFile, "file", false);
  try {
    writeNewDurableJson(lockFile, record, { syncParentDirectory: true });
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
}

function tryAcquireReclaimGuard(
  input: WorkflowLocationLeaseInput & { guardFile: string },
): WorkflowLocationLease | "retry" {
  const guardRecord: WorkflowLeaseRecord = {
    ...input.record,
    fencingToken: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  assertWorkflowStatePath(input.projectRoot, input.stateDir, input.guardFile, "file", false);
  try {
    writeNewDurableJson(input.guardFile, guardRecord, { syncParentDirectory: true });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const persisted = waitForReclaimGuard(input.projectRoot, input.stateDir, input.guardFile);
    if (persisted === undefined) return "retry";
    throw workflowReclaimGuardError(input.projectRoot, input.guardFile, persisted);
  }

  let outcome: WorkflowLocationLease | "retry";
  try {
    outcome = reclaimWorkflowLocationWhileGuarded(input);
  } catch (actionError) {
    try {
      removeOwnedStateFile(input.projectRoot, input.stateDir, input.guardFile, guardRecord, "reclaim guard", false);
    } catch (cleanupError) {
      throw new AggregateError(
        [actionError, cleanupError],
        `workflow ${input.kind} reclaim and guard cleanup both failed`,
      );
    }
    throw actionError;
  }

  try {
    removeOwnedStateFile(input.projectRoot, input.stateDir, input.guardFile, guardRecord, "reclaim guard", false);
  } catch (cleanupError) {
    if (outcome !== "retry") {
      try {
        removeOwnedStateFile(input.projectRoot, input.stateDir, input.lockFile, input.record, "lease", true);
      } catch (rollbackError) {
        throw new AggregateError(
          [cleanupError, rollbackError],
          `workflow ${input.kind} guard cleanup and lease rollback both failed`,
        );
      }
    }
    throw cleanupError;
  }
  return outcome;
}

function reclaimWorkflowLocationWhileGuarded(input: WorkflowLocationLeaseInput): WorkflowLocationLease | "retry" {
  const current = readLeaseRecordDuringAcquisition(input.projectRoot, input.stateDir, input.lockFile, "lease");
  if (current === undefined) return "retry";
  const owner = inspectLeaseOwner(input.projectRoot, current);
  if (!leaseMayBeReclaimed(input.force, owner)) {
    throw workflowLeaseOwnershipError(input, input.lockFile, current, owner);
  }

  const staleFile = `${input.lockFile}.stale-${randomUUID()}`;
  assertWorkflowStatePath(input.projectRoot, input.stateDir, input.lockFile, "file", true);
  assertWorkflowStatePath(input.projectRoot, input.stateDir, staleFile, "file", false);
  try {
    renameSync(input.lockFile, staleFile);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "retry";
    throw error;
  }

  let outcome: WorkflowLocationLease | "retry";
  try {
    if (!tryCreateLeaseFile(input.projectRoot, input.stateDir, input.lockFile, input.record)) {
      const winner = readLeaseRecordDuringAcquisition(input.projectRoot, input.stateDir, input.lockFile, "lease");
      if (winner === undefined) {
        outcome = "retry";
      } else {
        throw workflowLeaseOwnershipError(input, input.lockFile, winner, inspectLeaseOwner(input.projectRoot, winner));
      }
    } else {
      outcome = {
        projectRoot: input.projectRoot,
        stateDir: input.stateDir,
        lockFile: input.lockFile,
        record: input.record,
      };
    }
  } catch (actionError) {
    try {
      removeLeaseFile(input.projectRoot, input.stateDir, staleFile);
    } catch (staleCleanupError) {
      throw new AggregateError(
        [actionError, staleCleanupError],
        `workflow ${input.kind} reclaim and stale lease cleanup both failed`,
      );
    }
    throw actionError;
  }

  try {
    removeLeaseFile(input.projectRoot, input.stateDir, staleFile);
  } catch (staleCleanupError) {
    if (outcome !== "retry") {
      try {
        removeOwnedStateFile(input.projectRoot, input.stateDir, input.lockFile, input.record, "lease", true);
      } catch (rollbackError) {
        throw new AggregateError(
          [staleCleanupError, rollbackError],
          `workflow ${input.kind} stale lease cleanup and replacement rollback both failed`,
        );
      }
    }
    throw staleCleanupError;
  }
  return outcome;
}

function waitForReclaimGuard(
  projectRoot: string,
  stateDir: string,
  guardFile: string,
): WorkflowLeaseRecord | undefined {
  let current: WorkflowLeaseRecord | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_OWNER_READ_ATTEMPTS; attempt += 1) {
    if (!assertWorkflowStatePath(projectRoot, stateDir, guardFile, "file", false)) return undefined;
    try {
      current = readLeaseRecord(projectRoot, stateDir, guardFile, "reclaim guard");
      lastError = undefined;
    } catch (error) {
      current = undefined;
      lastError = error;
    }
    if (attempt + 1 < LEASE_OWNER_READ_ATTEMPTS) {
      Atomics.wait(LEASE_OWNER_READ_WAIT, 0, 0, LEASE_OWNER_READ_RETRY_MS);
    }
  }
  if (current !== undefined) return current;
  throw lastError;
}

function workflowReclaimGuardError(projectRoot: string, guardFile: string, current: WorkflowLeaseRecord): Error {
  const guardPath = projectRelativeStatePath(projectRoot, guardFile);
  const inspect =
    process.platform === "win32"
      ? `tasklist /FI \"PID eq ${current.pid}\"`
      : `ps -p ${current.pid} -o pid,stat,lstart,command`;
  const remove = stateFileRemovalCommand(guardPath);
  return new Error(
    `workflow ${current.kind} reclaim is already in progress for run ${current.rootRunId} ` +
      `(pid ${current.pid}, acquired ${current.acquiredAt}).\n` +
      `Guard: ${guardPath}\n` +
      `Recovery: inspect with ${inspect}. If that PID no longer owns this Pi run, from the project root remove only ` +
      `the guard with ${remove}, then retry.`,
  );
}

export function assertWorkflowRootLease(lease: WorkflowRootLease): void {
  assertWorkflowLocationLease(lease);
}

export function assertWorkflowOutputLease(lease: WorkflowOutputLease): void {
  assertWorkflowLocationLease(lease);
}

function assertWorkflowLocationLease(
  lease: Pick<WorkflowRootLease, "projectRoot" | "stateDir" | "lockFile" | "record">,
): void {
  const current = readLeaseRecord(lease.projectRoot, lease.stateDir, lease.lockFile);
  if (
    current.fencingToken !== lease.record.fencingToken ||
    current.rootRunId !== lease.record.rootRunId ||
    current.pid !== lease.record.pid
  ) {
    throw new Error(
      `workflow ${lease.record.kind} lease fencing token is stale for ${JSON.stringify(lease.record.relativePath)}`,
    );
  }
}

export function releaseWorkflowRootLease(lease: WorkflowRootLease): void {
  removeOwnedStateFile(lease.projectRoot, lease.stateDir, lease.lockFile, lease.record, "lease", true);
}

export function releaseWorkflowOutputLease(lease: WorkflowOutputLease): void {
  removeOwnedStateFile(lease.projectRoot, lease.stateDir, lease.lockFile, lease.record, "lease", true);
}

export function workflowOutputStateDir(projectRoot: string, canonicalOutputIdentity: string): string {
  const namespace = createHash("sha256").update(canonicalOutputIdentity).digest("hex");
  return path.join(workflowRootDir(path.resolve(projectRoot)), "workflow-state", "v1", namespace);
}

export function workflowFinalOutputStateDir(projectRoot: string, canonicalOutputIdentity: string): string {
  const namespace = createHash("sha256").update(canonicalOutputIdentity).digest("hex");
  return path.join(workflowRootDir(path.resolve(projectRoot)), "workflow-output-state", "v1", namespace);
}

function readLeaseRecord(
  projectRoot: string,
  stateDir: string,
  lockFile: string,
  stateLabel: "lease" | "reclaim guard" = "lease",
): WorkflowLeaseRecord {
  let value: unknown;
  try {
    assertWorkflowStatePath(projectRoot, stateDir, lockFile, "file", true);
    value = readJson(lockFile);
  } catch (error) {
    throw new Error(
      `workflow ${stateLabel} owner is unreadable at ${projectRelativeStatePath(projectRoot, lockFile)}; ` +
        `verify no writer is active before manual removal: ${String(error)}`,
    );
  }
  if (!isLeaseRecord(value)) {
    throw new Error(
      `workflow ${stateLabel} owner is unverifiable at ${projectRelativeStatePath(projectRoot, lockFile)}; ` +
        "verify no writer is active before removal",
    );
  }
  return value;
}

/** A new owner creates its lock before durable JSON is complete; tolerate only that bounded window. */
function readLeaseRecordDuringAcquisition(
  projectRoot: string,
  stateDir: string,
  lockFile: string,
  stateLabel: "lease" | "reclaim guard" = "lease",
): WorkflowLeaseRecord | undefined {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      return readLeaseRecord(projectRoot, stateDir, lockFile, stateLabel);
    } catch (error) {
      lastError = error;
      if (!assertWorkflowStatePath(projectRoot, stateDir, lockFile, "file", false)) return undefined;
      if (attempt + 1 < LEASE_OWNER_READ_ATTEMPTS) {
        Atomics.wait(LEASE_OWNER_READ_WAIT, 0, 0, LEASE_OWNER_READ_RETRY_MS);
      }
    }
  }
  throw lastError;
}

function removeLeaseFile(projectRoot: string, stateDir: string, lockFile: string): void {
  if (assertWorkflowStatePath(projectRoot, stateDir, lockFile, "file", false)) unlinkSync(lockFile);
}

function removeOwnedStateFile(
  projectRoot: string,
  stateDir: string,
  file: string,
  owned: WorkflowLeaseRecord,
  stateLabel: "lease" | "reclaim guard",
  mustExist: boolean,
): void {
  if (!assertWorkflowStatePath(projectRoot, stateDir, file, "file", false)) {
    if (mustExist) {
      throw new Error(`workflow ${stateLabel} is missing at ${projectRelativeStatePath(projectRoot, file)}`);
    }
    return;
  }
  const current = readLeaseRecord(projectRoot, stateDir, file, stateLabel);
  if (
    current.fencingToken !== owned.fencingToken ||
    current.rootRunId !== owned.rootRunId ||
    current.pid !== owned.pid
  ) {
    throw new Error(`workflow ${stateLabel} fencing token is stale at ${projectRelativeStatePath(projectRoot, file)}`);
  }
  unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function isLeaseRecord(value: unknown): value is WorkflowLeaseRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowLeaseRecord>;
  return (
    record.schema === LEASE_SCHEMA &&
    (record.kind === "workspace" || record.kind === "output") &&
    typeof record.rootRunId === "string" &&
    typeof record.relativePath === "string" &&
    typeof record.identity === "string" &&
    Number.isSafeInteger(record.pid) &&
    typeof record.fencingToken === "string" &&
    typeof record.acquiredAt === "string"
  );
}
