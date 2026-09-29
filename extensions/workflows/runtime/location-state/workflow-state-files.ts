/** Symlink-safe, durable file primitives shared by workflow location state owners. */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isWorkflowPathWithinRoot } from "../workflow-workspace.js";

export type WorkflowStateLeafKind = "file" | "directory";

export class InvalidJsonContentError extends Error {}
class UnstableJsonReadError extends Error {}

/** Prove a state path's complete lexical and physical ancestor chain. */
export function assertWorkflowStatePath(
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

export function projectRelativeStatePath(projectRoot: string, file: string): string {
  const relative = path.relative(path.resolve(projectRoot), file).split(path.sep).join("/");
  return relative === "" || relative.startsWith("../") ? file : relative;
}

export function stateFileRemovalCommand(projectRelativePath: string): string {
  return process.platform === "win32"
    ? `del \"${projectRelativePath.split("/").join("\\")}\"`
    : `rm -- \"${projectRelativePath}\"`;
}

/** Create one durable JSON file; only a successful exclusive open owns cleanup. */
export function writeNewDurableJson(
  file: string,
  value: unknown,
  options: { syncParentDirectory?: boolean } = {},
): void {
  // Errors raised before this returns (for example EMFILE/ENFILE) must never
  // trigger cleanup of a path that may belong to another writer.
  const fd = openSync(file, "wx", 0o600);
  const errors: unknown[] = [];
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      closeSync(fd);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0 && options.syncParentDirectory) {
    try {
      fsyncDirectory(path.dirname(file));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return;
  try {
    unlinkSync(file);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, `failed to persist and clean up exclusively created JSON state at ${file}`);
}

export function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Descriptor-bound regular-file read: no symlink following and no torn JSON snapshots. */
export function readJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`JSON state path is not a regular file: ${file}`);
    if (!Number.isSafeInteger(before.size) || before.size > 1024 * 1024) {
      throw new Error(`JSON state file is too large: ${file}`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
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
