/** Project-wide failure pointers. Source journals/results remain authoritative. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  readSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { errorMessage } from "./error-text.js";
import { redactSecrets } from "./redaction.js";

export interface ProjectErrorFacts {
  ts: string;
  source: "workflow" | "agent";
  event: "agent_end" | "error" | "agent_result" | "catalog_error" | "workflow_result";
  message: string;
  status?: string | undefined;
  workflow?: string | undefined;
  runId?: string | undefined;
  agent?: string | undefined;
  displayName?: string | undefined;
  label?: string | undefined;
  title?: string | undefined;
  phase?: string | undefined;
  callId?: string | undefined;
  logicalCallId?: string | undefined;
  attempt?: number | undefined;
  cause?: string | undefined;
  sessionId?: string | undefined;
  parentSessionId?: string | undefined;
  replayed?: boolean | undefined;
  journalPath?: string | undefined;
  evidenceWarning?: string | undefined;
  resultPath?: string | undefined;
  transcriptPath?: string | undefined;
}

export interface ProjectErrorReceipt {
  path: string;
  /** Present only after the complete record was appended. */
  id?: string;
  warning?: string;
}

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;

export function projectErrorJournalPath(projectRoot: string): string {
  // Shared host storage cannot depend on a feature's workflow layout owner.
  return path.join(projectRoot, ".locus-pi", "logs", "errors.jsonl");
}

/** No error from this optional index may replace an execution failure. */
export function appendProjectError(projectRoot: string, facts: ProjectErrorFacts): ProjectErrorReceipt {
  const logPath = projectErrorJournalPath(projectRoot);
  const lockPath = `${logPath}.lock`;
  let lock: number | undefined;
  let file: number | undefined;
  let initialSize: number | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  let id: string | undefined;
  let warning: string | undefined;
  try {
    const record = {
      schema: "locus.error.v1",
      id: randomUUID(),
      ...facts,
      message: shortText(facts.message),
      ...(facts.title === undefined ? {} : { title: shortText(facts.title) }),
      ...(facts.label === undefined ? {} : { label: shortText(facts.label) }),
      ...(facts.displayName === undefined ? {} : { displayName: shortText(facts.displayName) }),
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("error pointer exceeds 32 KiB; inspect the original evidence");
    for (const dir of [path.dirname(path.dirname(logPath)), path.dirname(logPath)]) {
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (err) {
        if (!hasCode(err, "EEXIST")) throw err;
      }
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
        throw new Error(`unsafe log directory: ${dir}`);
    }
    // Error-only synchronous critical section, like the run-id claim lock. Bound contention;
    // never steal an unknown lock or change the original cancellation/timeout outcome.
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        lock = openSync(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        lockIdentity = fstatSync(lock);
        writeSync(lock, `${process.pid}\n`);
        break;
      } catch (err) {
        if (!hasCode(err, "EEXIST")) throw err;
        Atomics.wait(wait, 0, 0, 5);
      }
    }
    if (lock === undefined) throw new Error(`error index is busy; inspect lock ${lockPath} before removing it`);
    const previous = path.join(path.dirname(logPath), "errors.1.jsonl");
    const size = regularFileSize(logPath);
    regularFileSize(previous); // Refuse symlinks/hardlinks even before a rotation is due.
    if (size !== undefined && size + bytes.length > MAX_LOG_BYTES) renameSync(logPath, previous);
    file = openSync(logPath, constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    if (!fstatSync(file).isFile() || fstatSync(file).nlink !== 1)
      throw new Error("error index is not a private regular file");
    initialSize = fstatSync(file).size;
    if (initialSize > 0) {
      const tail = Buffer.alloc(1);
      readSync(file, tail, 0, 1, initialSize - 1);
      if (tail[0] !== 10) throw new Error("incomplete last record; preserve and repair the index before appending");
    }
    if (writeSync(file, bytes) !== bytes.length) throw new Error("incomplete error index write");
    id = record.id;
  } catch (err) {
    // A short/failed write must not poison the next complete JSONL record.
    if (file !== undefined && initialSize !== undefined) {
      try {
        ftruncateSync(file, initialSize);
      } catch {
        /* Original evidence remains the fallback. */
      }
    }
    warning = `Error index unavailable: ${errorMessage(err)}. Original failure and evidence remain authoritative.`;
  } finally {
    for (const descriptor of [file, lock]) {
      if (descriptor === undefined) continue;
      try {
        closeSync(descriptor);
      } catch (err) {
        warning ??= `Error index close failed: ${errorMessage(err)}`;
      }
    }
    if (lock !== undefined) {
      try {
        const current = lstatSync(lockPath);
        if (current.dev === lockIdentity?.dev && current.ino === lockIdentity?.ino) unlinkSync(lockPath);
      } catch (err) {
        warning ??= `Error index lock cleanup failed: ${errorMessage(err)}`;
      }
    }
  }
  return { path: logPath, ...(id === undefined ? {} : { id }), ...(warning === undefined ? {} : { warning }) };
}

function regularFileSize(file: string): number | undefined {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`unsafe log file: ${file}`);
    return stat.size;
  } catch (err) {
    if (hasCode(err, "ENOENT")) return undefined;
    throw err;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function shortText(value: string): string {
  const text = redactSecrets(value).text.replace(/[\r\n\t]+/gu, " ");
  return text.length <= 1000 ? text : `${text.slice(0, 999)}…`;
}
