import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { errorMessage } from "../../operator/operator-ui.js";

export interface FileIdentity {
  device: string;
  inode: string;
  born: string;
  changed: string;
}

export type SkillEntry =
  | { kind: "directory" | "other"; identity: FileIdentity }
  | { kind: "file" | "link"; identity: FileIdentity; value: string };

function identity(stat: BigIntStats): FileIdentity {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    born: String(stat.birthtimeNs),
    changed: String(stat.ctimeNs),
  };
}

export function sameObject(a: FileIdentity, b: FileIdentity): boolean {
  return a.inode !== "0" && a.inode === b.inode && a.device === b.device && a.born === b.born;
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return sameObject(a, b) && a.changed === b.changed;
}

function requireIdentity(id: FileIdentity, destination: string): FileIdentity {
  if (id.inode === "0") throw new Error(`Cannot verify filesystem identity: ${destination}`);
  return id;
}

export function readSkillEntry(file: string, readContents = true): SkillEntry | undefined {
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  const snapshot = identity(stat);
  if (stat.isSymbolicLink()) return { kind: "link", identity: snapshot, value: readlinkSync(file) };
  if (stat.isFile())
    return {
      kind: "file",
      identity: snapshot,
      value: readContents ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file)) : "",
    };
  return { kind: stat.isDirectory() ? "directory" : "other", identity: snapshot };
}

function sameEntry(expected: SkillEntry | undefined, actual: SkillEntry | undefined, published: boolean): boolean {
  if (!expected || !actual) return expected === actual;
  const compareIdentity = published ? sameObject : sameIdentity;
  return (
    expected.kind === actual.kind &&
    compareIdentity(expected.identity, actual.identity) &&
    (!("value" in expected) || ("value" in actual && expected.value === actual.value))
  );
}

export type SkillMutationBoundary = "before-guard" | "after-guard" | "before-readback";

interface SkillMutationHooks {
  _testAtBoundary?: (boundary: SkillMutationBoundary, file: string) => void;
  _testAfterMutation?: (file: string) => void;
}

export interface SkillUndoIssue {
  path: string;
  reason: string;
}

/** Local, synchronous writer. The final identity check and pathname syscall are separate. */
export class SkillTreeTransaction {
  readonly issues: SkillUndoIssue[] = [];
  private readonly createdDirectories: { path: string; identity: FileIdentity }[] = [];

  constructor(
    private readonly directories: Map<string, FileIdentity | undefined>,
    private readonly hooks: SkillMutationHooks,
  ) {}

  get createdDirectory(): boolean {
    return this.createdDirectories.length > 0;
  }

  prepare(): void {
    for (const [dir, expected] of this.directories) {
      this.requireDirectories(path.dirname(dir));
      if (expected !== undefined) {
        this.requireDirectory(dir, expected);
        continue;
      }
      mkdirSync(dir);
      try {
        const created = readSkillEntry(dir, false);
        if (created?.kind !== "directory" || created.identity.inode === "0") {
          throw new Error(`Cannot verify created directory: ${dir}`);
        }
        this.directories.set(dir, created.identity);
        this.createdDirectories.push({ path: dir, identity: created.identity });
      } catch (error) {
        this.issues.push({ path: dir, reason: errorMessage(error) });
        throw error;
      }
    }
  }

  requireEntry(file: string, entry: SkillEntry | undefined): void {
    try {
      this.verifyEntry(file, entry);
    } catch (error) {
      this.recordIssue(file, error);
      throw error;
    }
  }

  write(
    file: string,
    previous: SkillEntry | undefined,
    kind: "file" | "link",
    value: string,
    authorize: () => void,
    restoring = false,
  ): SkillEntry {
    this.requireDirectories(path.dirname(file));
    const temporary =
      kind === "file" ? `${file}.${process.pid}-${Date.now()}` : `${file}.locus-pi-${process.pid}-${Date.now()}`;
    let staged: SkillEntry | undefined;
    let created = false;
    let published = false;
    let verified = false;
    try {
      if (kind === "file") {
        const descriptor = openSync(temporary, "wx", 0o600);
        created = true;
        try {
          const opened = requireIdentity(identity(fstatSync(descriptor, { bigint: true })), temporary);
          staged = { kind, identity: opened, value: "" };
          writeFileSync(descriptor, value, "utf8");
          staged = { kind, identity: identity(fstatSync(descriptor, { bigint: true })), value };
        } finally {
          closeSync(descriptor);
        }
      } else {
        symlinkSync(value, temporary, "dir");
        created = true;
        const entry = readSkillEntry(temporary);
        if (entry?.kind !== "link" || entry.value !== value)
          throw new Error(`Cannot verify staging link: ${temporary}`);
        staged = { ...entry, identity: requireIdentity(entry.identity, temporary) };
      }

      this.guard(file, previous, authorize, restoring);
      this.requireEntry(temporary, staged);
      if (!restoring) this.hooks._testAtBoundary?.("after-guard", file);
      if (kind === "file" && !previous) {
        linkSync(temporary, file);
        published = true;
        this.cleanStage(temporary, staged, true);
        created = false;
      } else {
        renameSync(temporary, file);
        published = true;
      }
      if (!restoring) this.hooks._testAtBoundary?.("before-readback", file);
      const after = this.verifyEntry(file, staged, { published: true });
      verified = true;
      return after!;
    } finally {
      if (published && !verified)
        this.issues.push({ path: file, reason: "Publication identity could not be verified." });
      if (created) this.cleanStage(temporary, staged);
    }
  }

  remove(file: string, previous: SkillEntry, authorize: () => void, restoring = false): void {
    this.guard(file, previous, authorize, restoring);
    if (!restoring) this.hooks._testAtBoundary?.("after-guard", file);
    let unlinked = false;
    try {
      unlinkSync(file);
      unlinked = true;
      if (!restoring) this.hooks._testAtBoundary?.("before-readback", file);
      this.verifyEntry(file, undefined);
    } catch (error) {
      if (!restoring && (unlinked || (error as NodeJS.ErrnoException).code === "ENOENT")) {
        this.recordIssue(file, error);
      }
      throw error;
    }
  }

  afterMutation(file: string): void {
    this.hooks._testAfterMutation?.(file);
  }

  cleanupDirectories(): void {
    for (const dir of this.createdDirectories.reverse()) {
      this.attempt(dir.path, () => {
        this.requireDirectories(path.dirname(dir.path));
        if (!readSkillEntry(dir.path, false)) return;
        this.requireDirectory(dir.path, dir.identity);
        rmdirSync(dir.path);
      });
    }
  }

  attempt(file: string, undo: () => void): void {
    try {
      undo();
    } catch (error) {
      this.recordIssue(file, error);
    }
  }

  private recordIssue(file: string, error: unknown): void {
    const reason = errorMessage(error);
    if (!this.issues.some((issue) => issue.path === file && issue.reason === reason)) {
      this.issues.push({ path: file, reason });
    }
  }

  private verifyEntry(
    file: string,
    expected: SkillEntry | undefined,
    { published = false, allowVacant = false } = {},
  ): SkillEntry | undefined {
    this.requireDirectories(path.dirname(file));
    const actual = readSkillEntry(file, expected?.kind === "file");
    if (allowVacant && !actual) return undefined;
    if (!sameEntry(expected, actual, published)) {
      throw new Error(`Entry changed since it was inspected: ${file}`);
    }
    return actual;
  }

  private guard(file: string, previous: SkillEntry | undefined, authorize: () => void, restoring: boolean): void {
    if (!restoring) this.hooks._testAtBoundary?.("before-guard", file);
    authorize();
    if (restoring) this.verifyEntry(file, previous);
    else this.requireEntry(file, previous);
  }

  private requireDirectories(parent: string): void {
    for (const [dir, expected] of this.directories) {
      const relative = path.relative(dir, parent);
      if (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        this.requireDirectory(dir, expected);
      }
    }
  }

  private requireDirectory(dir: string, expected: FileIdentity | undefined): void {
    const actual = readSkillEntry(dir, false);
    if (actual?.kind !== "directory" || !expected || !sameObject(expected, actual.identity)) {
      throw new Error(`Destination directory changed: ${dir}`);
    }
  }

  private cleanStage(temporary: string, expected: SkillEntry | undefined, published = false): void {
    this.attempt(temporary, () => {
      // Linking changes ctime. The stage must still match type, object identity and content.
      if (this.verifyEntry(temporary, expected, { allowVacant: true, published })) unlinkSync(temporary);
    });
  }
}
