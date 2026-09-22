/**
 * workflow-journal.ts — runId generation, file-backed journal persistence,
 * and read-side projections over resolved workflow execution directories.
 *
 * Owns journal persistence and read-side run discovery while workflow-runtime.ts
 * stays filesystem-free. Canonical path derivation lives in workflow-run-layout.ts.
 */

import { appendProjectError, projectErrorJournalPath } from "../../_shared/host/error-journal.js";
import path from "node:path";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
// The event contract this module stores — the line shape and the strict codec that decides
// whether a persisted line is readable — is owned by `workflow-journal-format.ts`. This
// module owns only the storage half: the run claim, the append sink, journal reads, run
// listing, queries and the summary projection.
import {
  workflowJournalLineProblem,
  type WorkflowJournalLine,
  type WorkflowJournalSink,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowUsage,
} from "./workflow-journal-format.js";
export type { WorkflowRunStatus, WorkflowRunSummary } from "./workflow-journal-format.js";
// The persisted `runtime/result.json` envelope — the tolerant readback and the
// invalid markers it projects — is owned by `workflow-result.ts`, next to the
// writer that produces those bytes. The summary projection below reads it, and
// the names stay re-exported here so existing importers keep one door.
import {
  projectWorkflowDisposition,
  readWorkflowRunResult,
  workflowPersistedResultInvalidity,
  workflowResultFile,
} from "./workflow-result.js";
export {
  readWorkflowRunResult,
  readWorkflowRunResultText,
  workflowPersistedResultInvalidity,
} from "./workflow-result.js";
export type { WorkflowRunResultEnvelope, WorkflowRunResultText } from "./workflow-result.js";
// The persisted source snapshot is verified by its own reader; re-exported for
// the same reason.
export { readWorkflowRunScriptSnapshot } from "./workflow-run-snapshot.js";
export type { WorkflowRunScriptSnapshot } from "./workflow-run-snapshot.js";

import {
  assertWorkflowRunId,
  ensureWorkflowRunDir,
  ensureWorkflowDirectoryNoSymlink,
  appendWorkflowRunTextFile,
  listWorkflowRunDirectories,
  findWorkflowRunDir,
  resolveWorkflowRunDir,
  type WorkflowRunLocation,
  readWorkflowRunTextFile,
  workflowRunFileExists,
  writeWorkflowRunFile,
  workflowJournalFile,
  workflowLegacyRunMigrationMessage,
  workflowRunDir,
  workflowRunsRootDir,
  type WorkflowRunDirectory,
} from "./workflow-run-layout.js";

export { workflowJournalFile, workflowRunsRootDir } from "./workflow-run-layout.js";

// ---------------------------------------------------------------------------
// runId
// ---------------------------------------------------------------------------

/** e.g. "20260614-031200-ab12" — filesystem-safe timestamp + short random hex. */
export function newWorkflowRunId(now?: () => Date): string {
  const d = now !== undefined ? now() : new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const datePart = String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  const timePart = pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${datePart}-${timePart}-${rand}`;
}

const WORKFLOW_RUN_ID_MINT_ATTEMPTS = 5;

export interface ClaimedWorkflowRun {
  runId: string;
  runDir: string;
  journal: WorkflowJournalFileSink;
  firstLine: WorkflowJournalLine;
}

/**
 * Mint a fresh runId, reserve its execution directory, then initialize readable evidence.
 *
 * The id is a second-resolution timestamp plus a 16-bit random suffix, so two
 * runs starting in the same second can draw the same id (observed on an
 * immediate resume after a short run). The project lock serializes global
 * discovery, exclusive directory creation reserves the id, and journal
 * initialization makes that reservation readable. Only a NEWLY minted id is
 * retried after collision; an id supplied for resume is never re-minted.
 */
export function claimNewWorkflowRun(
  projectRoot: string,
  firstLine: (runId: string) => WorkflowJournalLine,
  now?: () => Date,
  location?: WorkflowRunLocation,
  workflow?: string,
): ClaimedWorkflowRun {
  const runsRoot = workflowRunsRootDir(realpathSync(projectRoot));
  ensureWorkflowDirectoryNoSymlink(realpathSync(projectRoot), runsRoot);
  const lockPath = path.join(runsRoot, ".run-claim.lock");
  let descriptor: number | undefined;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let contention = 0; contention < 200; contention += 1) {
    try {
      descriptor = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      break;
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
      Atomics.wait(wait, 0, 0, 5);
    }
  }
  if (descriptor === undefined) {
    throw new Error(
      `Workflow run claim is locked: ${lockPath}; verify the owner has stopped before removing an interrupted claim lock.`,
    );
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    return claimRunUnderLock(projectRoot, firstLine, now, location, workflow);
  } finally {
    const owned = fstatSync(descriptor);
    closeSync(descriptor);
    const current = lstatSync(lockPath, { throwIfNoEntry: false });
    if (current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath);
  }
}

function claimRunUnderLock(
  projectRoot: string,
  firstLine: (runId: string) => WorkflowJournalLine,
  now: (() => Date) | undefined,
  location: WorkflowRunLocation | undefined,
  workflow: string | undefined,
): ClaimedWorkflowRun {
  let lastError: unknown;
  if (
    location !== undefined &&
    resolveWorkflowRunDir(projectRoot, location.storageRootRunId) !==
      workflowRunDir(projectRoot, location.storageRootRunId)
  ) {
    throw new Error("Workflow storage root must identify a top-level run group.");
  }
  const claimed = new Set(listWorkflowRunDirectories(projectRoot).map((entry) => entry.runId));
  for (let attempt = 0; attempt < WORKFLOW_RUN_ID_MINT_ATTEMPTS; attempt += 1) {
    const runId = newWorkflowRunId(now);
    if (claimed.has(runId)) {
      lastError = new Error(`Workflow run id already exists: ${runId}`);
      continue;
    }
    const runDir = workflowRunDir(projectRoot, runId, location);
    const parent = path.dirname(runDir);
    const physicalRoot = realpathSync(projectRoot);
    ensureWorkflowDirectoryNoSymlink(
      physicalRoot,
      path.join(physicalRoot, path.relative(path.resolve(projectRoot), parent)),
    );
    const journal = createWorkflowJournalSink(projectRoot, runId, location, workflow);
    const line = firstLine(runId);
    try {
      mkdirSync(runDir);
      journal.initialize(line);
      return { runId, runDir, journal, firstLine: line };
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Could not claim a unique workflow run id after ${WORKFLOW_RUN_ID_MINT_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
  );
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

// ---------------------------------------------------------------------------
// File-backed journal sink
// ---------------------------------------------------------------------------

export interface WorkflowJournalFileSink extends WorkflowJournalSink {
  /** Create the safe run root and write the first line. Throws on any failure. */
  initialize(firstLine: WorkflowJournalLine): void;
}

export function createWorkflowJournalSink(
  projectRoot: string,
  runId: string,
  location?: WorkflowRunLocation,
  workflow?: string,
): WorkflowJournalFileSink {
  const runDir = workflowRunDir(projectRoot, runId, location);
  const journalPath = workflowJournalFile(runDir);
  let initialized = false;

  function initialize(firstLine: WorkflowJournalLine): void {
    if (initialized) throw new Error("Workflow journal is already initialized.");
    ensureWorkflowRunDir(projectRoot, runId, location);
    writeWorkflowRunFile(runDir, journalPath, JSON.stringify(firstLine) + "\n", { exclusive: true });
    initialized = true;
  }

  return {
    initialize,
    write(line: WorkflowJournalLine): void {
      const failed =
        line.kind === "error" ||
        (line.kind === "agent_end" && ["failed", "blocked", "cancelled"].includes(line.status ?? ""));
      if (failed) line.errorLogPath = projectErrorJournalPath(projectRoot);
      try {
        if (!initialized) initialize(line);
        else appendWorkflowRunTextFile(runDir, journalPath, JSON.stringify(line) + "\n");
      } catch (error) {
        // Keep the best-effort boundary, but do not claim a persisted source event.
        if (failed) line.journalWarning = `Source journal write failed (${journalPath}): ${errorMessage(error)}`;
      }
      if (failed) {
        const receipt = appendProjectError(projectRoot, {
          ts: line.ts,
          source: "workflow",
          event: line.kind === "error" ? "error" : "agent_end",
          message: line.message ?? "No failure message was recorded.",
          workflow,
          runId: line.runId,
          status: line.status,
          agent: line.agent,
          displayName: line.displayName,
          label: line.label,
          title: line.title,
          phase: line.phase,
          callId: line.callId,
          logicalCallId: line.logicalCallId,
          attempt: line.attempt,
          cause: line.failureCause,
          sessionId: line.childSessionId,
          replayed: line.replayed,
          journalPath: line.journalWarning === undefined ? journalPath : undefined,
          evidenceWarning: line.journalWarning,
          resultPath: line.resultArtifact,
          transcriptPath: line.childTrace?.path,
        });
        line.errorLogPath = receipt.path;
        if (receipt.id !== undefined) line.errorId = receipt.id;
        if (receipt.warning !== undefined) line.errorLogWarning = receipt.warning;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Read side — status / progress views over persisted runs
// ---------------------------------------------------------------------------

export interface WorkflowJournalDiagnostic {
  kind: "json" | "structure" | "io";
  lineNumber: number | null;
  message: string;
}

export interface WorkflowJournalRead {
  lines: WorkflowJournalLine[];
  diagnostics: WorkflowJournalDiagnostic[];
}

export interface WorkflowRunListEntry extends WorkflowRunDirectory {
  startedAt: number;
  claimedAt: number;
  /** True when persisted timestamps cannot order this entry against another run. */
  chronologyTied: boolean;
}

/** Every supported execution newest-timestamp-first, resolved once for multi-row readers. */
export function listWorkflowRuns(projectRoot: string): WorkflowRunListEntry[] {
  try {
    const directories = listWorkflowRunDirectories(projectRoot);
    const counts = new Map<string, number>();
    for (const { runId } of directories) counts.set(runId, (counts.get(runId) ?? 0) + 1);
    const ordered = directories
      .flatMap((directory) => {
        const { runId, runDir } = directory;
        if (counts.get(runId) !== 1) return [];
        try {
          const startedAt = workflowRunStartedAt(runId, runDir);
          const claimed = statSync(runDir);
          return startedAt === undefined
            ? []
            : [
                {
                  ...directory,
                  startedAt,
                  claimedAt: Math.trunc(claimed.birthtimeMs || claimed.ctimeMs),
                  chronologyTied: false,
                },
              ];
        } catch {
          return [];
        }
      })
      .sort(
        (left, right) =>
          right.startedAt - left.startedAt ||
          right.claimedAt - left.claimedAt ||
          // A full timestamp tie has no chronology. This final key is only a
          // deterministic presentation order; selectors refuse the tie below.
          left.runDir.localeCompare(right.runDir),
      );
    return ordered.map((entry, index) => ({
      ...entry,
      chronologyTied:
        sameWorkflowRunChronology(entry, ordered[index - 1]) || sameWorkflowRunChronology(entry, ordered[index + 1]),
    }));
  } catch {
    return [];
  }
}

function sameWorkflowRunChronology(
  left: Pick<WorkflowRunListEntry, "startedAt" | "claimedAt">,
  right: Pick<WorkflowRunListEntry, "startedAt" | "claimedAt"> | undefined,
): boolean {
  return right !== undefined && left.startedAt === right.startedAt && left.claimedAt === right.claimedAt;
}

/** Compatibility history projection: includes roots, attempts, and saved children. */
export function listWorkflowRunIds(projectRoot: string): string[] {
  return listWorkflowRuns(projectRoot).map((entry) => entry.runId);
}

/** Root executions are stoppable/selectable; saved children remain exact-ID history only. */
export function listWorkflowRootRunIds(projectRoot: string): string[] {
  return listWorkflowRuns(projectRoot)
    .filter((entry) => entry.kind !== "child")
    .map((entry) => entry.runId);
}

function workflowRunStartedAt(runId: string, runDir: string): number | undefined {
  const journalPath = workflowJournalFile(runDir);
  const resultPath = workflowResultFile(runDir);
  if (!workflowRunFileExists(runDir, journalPath) && !workflowRunFileExists(runDir, resultPath)) return undefined;

  for (const line of readWorkflowRunJournalStateAt(runId, runDir).lines) {
    const parsed = parseWorkflowTimestamp(line.ts);
    if (parsed !== undefined) return parsed;
  }

  try {
    const parsed: unknown = JSON.parse(readWorkflowRunTextFile(runDir, resultPath));
    const journal = (parsed as { journal?: unknown }).journal;
    if (Array.isArray(journal)) {
      for (const line of journal) {
        const timestamp = parseWorkflowTimestamp((line as { ts?: unknown } | null)?.ts);
        if (timestamp !== undefined) return timestamp;
      }
    }
  } catch {
    // A malformed result does not establish run chronology.
  }

  const canonical = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|$)/u.exec(runId);
  if (canonical !== null) {
    const parsed = Date.parse(
      `${canonical[1]}-${canonical[2]}-${canonical[3]}T${canonical[4]}:${canonical[5]}:${canonical[6]}Z`,
    );
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseWorkflowTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a run's journal without letting corrupt rows masquerade as complete evidence.
 * Valid rows remain available to compatibility callers; diagnostics retain every
 * JSON, structural, or read failure for status/viewer surfaces.
 */
export function readWorkflowRunJournalState(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowJournalRead {
  try {
    return readWorkflowRunJournalStateAt(runId, resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, runId));
  } catch (error) {
    return {
      lines: [],
      diagnostics: isMissingFileError(error)
        ? []
        : [{ kind: "io", lineNumber: null, message: `Journal could not be read: ${errorMessage(error)}.` }],
    };
  }
}

function readWorkflowRunJournalStateAt(runId: string, runDir: string): WorkflowJournalRead {
  let raw: string;
  try {
    raw = readWorkflowRunTextFile(runDir, workflowJournalFile(runDir));
  } catch (error) {
    return {
      lines: [],
      diagnostics: isMissingFileError(error)
        ? []
        : [{ kind: "io", lineNumber: null, message: `Journal could not be read: ${errorMessage(error)}.` }],
    };
  }
  const lines: WorkflowJournalLine[] = [];
  const diagnostics: WorkflowJournalDiagnostic[] = [];
  for (const [index, row] of raw.split("\n").entries()) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      diagnostics.push({ kind: "json", lineNumber: index + 1, message: "Invalid JSON." });
      continue;
    }
    const problem = workflowJournalLineProblem(parsed, runId);
    if (problem !== undefined) {
      diagnostics.push({ kind: "structure", lineNumber: index + 1, message: problem });
      continue;
    }
    lines.push(parsed as WorkflowJournalLine);
  }
  return { lines, diagnostics };
}

/** Compatibility projection for callers that only process valid journal events. */
export function readWorkflowRunJournal(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowJournalLine[] {
  return readWorkflowRunJournalState(projectRoot, runId, resolvedRunDir).lines;
}

/**
 * Turn whatever the operator typed into one persisted run id.
 *
 * The chat digest and the live panel head a run with its short suffix
 * (`run #98cc`), so that is usually what an operator has in front of them, while
 * the run list and detail widgets print full ids. Both resolve here, `last` is the
 * newest run, and a full id still resolves exactly. An ambiguous short suffix is refused rather than
 * guessed, because opening the wrong run's evidence is worse than being asked
 * for the full id.
 */
export type WorkflowRunIdResolution =
  | { status: "resolved"; runId: string }
  | { status: "legacy"; runId: string; message: string }
  | { status: "not-found" }
  | { status: "ambiguous"; matched: number; candidates: string[] };

export function resolveWorkflowRunId(projectRoot: string, selector: string): WorkflowRunIdResolution {
  const wanted = selector.trim();
  const special = wanted === "" || wanted === "last" || wanted === "latest";
  let fullSelector: string | undefined;
  if (!special) {
    try {
      fullSelector = assertWorkflowRunId(wanted);
    } catch {
      // A short selector has its own deliberately smaller grammar below.
    }
  }
  const shortSelector = special ? null : /^#?([a-zA-Z0-9]+)$/u.exec(wanted);
  if (!special && fullSelector === undefined && shortSelector === null) return { status: "not-found" };
  if (fullSelector !== undefined) findWorkflowRunDir(projectRoot, fullSelector);

  const runs = listWorkflowRuns(projectRoot);
  const runIds = runs.map((entry) => entry.runId);
  if (wanted === "" || wanted === "last" || wanted === "latest") {
    const roots = runs.filter((entry) => entry.kind !== "child");
    const newest = roots[0];
    if (newest === undefined) return { status: "not-found" };
    const tied = roots.filter((entry) => sameWorkflowRunChronology(entry, newest));
    return tied.length === 1
      ? { status: "resolved", runId: newest.runId }
      : { status: "ambiguous", matched: tied.length, candidates: tied.slice(0, 5).map((entry) => entry.runId) };
  }
  if (fullSelector !== undefined && runIds.includes(fullSelector)) {
    return { status: "resolved", runId: fullSelector };
  }
  const legacyMessage =
    fullSelector === undefined ? undefined : workflowLegacyRunMigrationMessage(projectRoot, fullSelector);
  if (legacyMessage !== undefined) return { status: "legacy", runId: fullSelector!, message: legacyMessage };
  if (shortSelector === null) return { status: "not-found" };
  const needle = shortSelector[1]!.toLowerCase();
  const matches = runIds.filter((runId) =>
    runId
      .replace(/[^a-zA-Z0-9]/gu, "")
      .toLowerCase()
      .endsWith(needle),
  );
  if (matches.length === 1) return { status: "resolved", runId: matches[0]! };
  if (matches.length > 1) {
    // The count is the real number of matches; the list is what fits in one
    // message. Reporting the truncated length as the count would read as
    // exhaustive while quietly dropping runs.
    return { status: "ambiguous", matched: matches.length, candidates: matches.slice(0, 5) };
  }
  return { status: "not-found" };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

/**
 * Completed rounds recorded for a slot (REQ-009), ascending, de-duplicated. Rounds live on
 * `agent_end` lines carrying `(slotKey, round)`; an in-flight round (agent_start only) is
 * absent here and shown from the live store instead. An OLD journal without these fields
 * yields `[]` — the drill then hides the rounds submenu. Never throws.
 */
export function listWorkflowRoundsForSlot(projectRoot: string, runId: string, slotKey: string): number[] {
  const rounds = new Set<number>();
  for (const line of readWorkflowRunJournal(projectRoot, runId)) {
    if (line.slotKey === slotKey && typeof line.round === "number") rounds.add(line.round);
  }
  return [...rounds].sort((a, b) => a - b);
}

/**
 * The declared phase a slot ran in, read from the `agent_start` line that recorded it.
 *
 * The drill heading needs the stage name, and no live row carries it: the group row is
 * labelled `<groupKind> (<total>)`, the anchor row repeats its child's own label, and the
 * bridge gives a child no title. The phase IS persisted, on every `agent_start` line beside
 * its `slotKey`, so the run journal is where a heading can read it without decomposing the
 * slot key string. Rounds of one slot share a phase — the phase is part of the key — so the
 * first matching line answers for all of them. Returns undefined for an OLD journal, an
 * unknown slot, or a call that declared no phase. Never throws.
 */
export function readWorkflowSlotPhase(projectRoot: string, runId: string, slotKey: string): string | undefined {
  for (const line of readWorkflowRunJournal(projectRoot, runId)) {
    if (line.kind !== "agent_start" || line.slotKey !== slotKey) continue;
    if (typeof line.phase === "string" && line.phase.trim() !== "") return line.phase;
  }
  return undefined;
}

/**
 * Lazily read a past round's body for the drill submenu (REQ-009): a compact summary of the
 * `agent_end` record for `(slotKey, round)` — the journal is what persists across the run, so a
 * past round shows its recorded status/model/duration/tokens, not a re-hydrated transcript.
 * Returns undefined when no matching record exists (old journal / unknown round). Never throws.
 */
export function readWorkflowRoundBody(
  projectRoot: string,
  runId: string,
  slotKey: string,
  round: number,
): string[] | undefined {
  const end = readWorkflowRunJournal(projectRoot, runId).find(
    (line) => line.kind === "agent_end" && line.slotKey === slotKey && line.round === round,
  );
  if (end === undefined) return undefined;
  const body = [`round ${round} — ${end.agent ?? "agent"}${end.status !== undefined ? ` ${end.status}` : ""}`];
  const meta = [
    ...(end.phase !== undefined ? [`phase ${end.phase}`] : []),
    ...(end.model !== undefined ? [`${end.model}${end.thinking !== undefined ? ` ${end.thinking}` : ""}`] : []),
    ...(end.durationMs !== undefined ? [`${end.durationMs}ms`] : []),
  ];
  if (meta.length > 0) body.push(meta.join(" · "));
  if (end.usage !== undefined) body.push(`tokens in ${end.usage.input} / out ${end.usage.output}`);
  if (end.label !== undefined) body.push(`label: ${end.label}`);
  body.push(`(from run journal — round record ${round})`);
  return body;
}

/** Summarize one valid run id. Corrupt or missing persisted evidence never throws. */
export function readWorkflowRunSummary(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowRunSummary {
  assertWorkflowRunId(runId);
  const runDir = resolvedRunDir ?? findWorkflowRunDir(projectRoot, runId);
  const hasResult = runDir !== undefined && workflowRunFileExists(runDir, workflowResultFile(runDir));
  const lines = runDir === undefined ? [] : readWorkflowRunJournal(projectRoot, runId, runDir);

  let phase: string | null = null;
  let agentsStarted = 0;
  let agentsEnded = 0;
  let agentsReplayed = 0;
  let errors = 0;
  let sawCancellation = false;
  let usageInput = 0;
  let usageOutput = 0;
  let usageTotal = 0;
  let usageCost = 0;
  /** Latched false by the first usage line without a price: an unknown summand
   *  makes the SUM unknown, and a partial total would read as the whole. */
  let sawCost = true;
  let sawUsage = false;
  for (const line of lines) {
    if (line.kind === "phase" && line.groupId === undefined && typeof line.phase === "string") phase = line.phase;
    else if (line.kind === "agent_start") agentsStarted += 1;
    else if (line.kind === "agent_end") {
      agentsEnded += 1;
      // Only an explicit marker counts. Replay is never inferred from a missing
      // duration, a zero token count, or any other side effect of not running.
      if (line.replayed === true) agentsReplayed += 1;
    } else if (line.kind === "error") errors += 1;
    else if (
      line.kind === "log" &&
      line.source === "runtime" &&
      typeof line.message === "string" &&
      line.message.startsWith("[workflow:cancelled]")
    ) {
      sawCancellation = true;
    }
    // A child normally reports usage on agent_end. When script validation or
    // artifact adoption throws after the child answered, `error` is the sole
    // terminal line and carries the same spend instead.
    if ((line.kind === "agent_end" || line.kind === "error") && line.usage !== undefined) {
      sawUsage = true;
      usageInput += line.usage.input;
      usageOutput += line.usage.output;
      usageTotal += line.usage.totalTokens;
      // A priced line contributes; an unpriced one makes the SUM unknown rather than
      // smaller. Adding zero for an unknown price would report a total that is
      // arithmetically wrong and reads as authoritative.
      if (line.usage.costTotal === undefined) sawCost = false;
      else if (sawCost) usageCost += line.usage.costTotal;
    }
  }
  const usage: WorkflowUsage | null = sawUsage
    ? {
        input: usageInput,
        output: usageOutput,
        totalTokens: usageTotal,
        ...(sawCost ? { costTotal: usageCost } : {}),
      }
    : null;
  const last = lines.length > 0 ? lines[lines.length - 1] : undefined;

  let status: WorkflowRunStatus;
  if (hasResult) {
    const persisted = readWorkflowRunResult(projectRoot, runId, runDir);
    status =
      persisted === null
        ? "unknown"
        : workflowPersistedResultInvalidity(persisted) !== undefined
          ? "unknown"
          : projectWorkflowDisposition({
              ok: persisted.ok === true,
              result: persisted.result,
              ...(persisted.error !== undefined ? { error: persisted.error } : {}),
              ...(persisted.disposition !== undefined ? { disposition: persisted.disposition } : {}),
            }).status;
  } else if (lines.length === 0) {
    status = "unknown";
  } else if (sawCancellation) {
    status = "cancelled";
  } else if (errors > 0) {
    status = "failed";
  } else {
    status = "running";
  }

  return {
    runId,
    status,
    phase,
    agentsStarted,
    agentsEnded,
    agentsReplayed,
    usage,
    errors,
    lastKind: last?.kind ?? null,
    lastTs: last?.ts ?? null,
    hasJournal: lines.length > 0,
    hasResult,
  };
}
