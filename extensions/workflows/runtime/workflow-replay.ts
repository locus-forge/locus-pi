/**
 * workflow-replay.ts — recorded-call store for `--resume`.
 *
 * A resumed run does not re-spawn a child whose exact request already ran: it
 * returns the recorded answer. This module owns the whole mechanism — the
 * `replay.ndjson` record inside the existing run directory, the call key, the
 * read cursors, and the ONE latch that makes replay a strict prefix.
 *
 * Two invariants shape everything here:
 *
 *   1. FAIL CLOSED. An entry that cannot be resolved — missing, keyed for a
 *      different request, named for a different node, recorded as a failure, or
 *      positioned after a divergence — is reported as a MISS, and the caller
 *      runs the real child. No branch of this module can invent an answer.
 *   2. STRICT PREFIX. ANY miss sets `#diverged`, and every later lookup misses
 *      too, including lookups whose own key would have matched. The rule is one
 *      rule for every miss reason because a fresh call CHANGES THE WORLD: the
 *      next recorded answer was produced after this call behaved differently,
 *      so reusing it would be a silent lie about what the run observed. The two
 *      exceptions latch nothing because there is nothing to latch: replay is
 *      switched off entirely, or the latch is already set.
 *
 * Repairing the source between two runs is expected, not a defect: the runner
 * reports `sourceScriptChanged` instead of refusing, and the recorded node name
 * becomes the readable identity of the completed prefix. It is not the safety
 * boundary — the canonical request key already carries `phase` and `label`, so
 * a call whose key matches on an unbroken prefix cannot carry a different name.
 * Safety rests on that strict prefix plus the unique-literal-label rule the
 * strict source checker enforces for generated workflows.
 *
 * Why a sidecar instead of `journal.ndjson`: the journal deliberately records no
 * prompt and no child text (see `WorkflowJournalLine`). Putting them there would
 * push unbounded model output into `/workflows status`, the bounded transcript
 * digest, and the live panel. The journal keeps the `replayed` MARKER; this file
 * keeps the payload, in the same run directory beside `result.json`.
 *
 * Filesystem surface only — the pure runtime talks to `WorkflowReplayController`.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { resolveWorkflowRunDir } from "./workflow-run-layout.js";
import {
  appendWorkflowRunTextFile,
  ensureWorkflowDirectoryNoSymlink,
  readWorkflowRunTextFile,
  workflowRunRuntimeDir,
} from "./workflow-run-layout.js";

export const WORKFLOW_REPLAY_FILE = "replay.ndjson";
/**
 * v3: explicit `bare | named` execution identity entered the canonical request,
 * so old package-role records are readable but never resumed as clean children.
 *
 * The bump is what makes the migration honest rather than merely safe. Leaving the
 * version at 1 is equally fail-closed — a changed key diverges and the call
 * re-executes — but the operator would be told `key-mismatch`, which everywhere else
 * means "your script changed". Dropping v1 lines instead makes the log read as empty
 * and the refusal reason becomes `no-recorded-calls`, which is true.
 */
export const WORKFLOW_REPLAY_SCHEMA_VERSION = 3 as const;

/** Recorded nondeterministic value kinds, one cursor each. */
export type WorkflowReplayValueKind = "clock" | "random";

/** Why a requested replay did not happen. Every value is operator-facing text. */
export type WorkflowReplayRefusalReason =
  | "source-run-unusable"
  | "target-changed"
  | "identity-coverage-unproven"
  | "replay-unsafe-script"
  | "no-recorded-calls";

/** Why this run wrote no replay record a later resume could use. */
export type WorkflowReplayNotRecordedReason = "identity-coverage-unproven" | "replay-unsafe-script";

/**
 * Readable identity of one agent call: `[phase, label, occurrence]`, absent when
 * the author gave the call no label. The field is optional and the schema
 * version stays 3 on purpose — a record written before this field existed still
 * replays byte-identical bytes exactly as it did, and only a repaired source
 * makes the missing name matter.
 */
export type WorkflowReplayEntry =
  | {
      v: typeof WORKFLOW_REPLAY_SCHEMA_VERSION;
      seq: number;
      kind: "agent";
      node?: string;
      key: string;
      /** Return-contract version of a SHAPED call; absent for a plain-text call and for
       *  every record written before contract v2 existed. See WORKFLOW_RETURN_CONTRACT_V1. */
      rcv?: number;
      ok: true;
      text: string;
    }
  | {
      v: typeof WORKFLOW_REPLAY_SCHEMA_VERSION;
      seq: number;
      kind: "agent";
      node?: string;
      key: string;
      rcv?: number;
      ok: false;
    }
  | { v: typeof WORKFLOW_REPLAY_SCHEMA_VERSION; seq: number; kind: WorkflowReplayValueKind; value: number };

/**
 * The shaped-return contract version a record written before this release used.
 *
 * v1 stated a default answer ceiling, a derived canonical-JSON allowance and a bounded
 * clarification budget; v2 states none of them. That text is part of the prompt and
 * therefore of the request key, so EVERY recorded shaped call diverges under v2 — which is
 * correct and must stay correct: recomputing an old key would claim the old child answered
 * a contract it was never shown.
 *
 * What would NOT be correct is reporting it as `key-mismatch`, which everywhere else means
 * "your script changed" and would send an operator looking for an edit that does not exist.
 * A record is therefore still fully readable, and the miss is named for what happened.
 */
export const WORKFLOW_RETURN_CONTRACT_V1 = 1 as const;

export type WorkflowReplayAgentEntry = Extract<WorkflowReplayEntry, { kind: "agent" }>;

/** Why one agent attempt was not served from the record. Never a silent miss. */
export type WorkflowReplayMissReason =
  | "no-record"
  | "unnamed-node"
  | "node-mismatch"
  | "return-contract-changed"
  | "key-mismatch"
  | "recorded-failure"
  | "side-effecting-call"
  | "diverged";

export type WorkflowReplayAgentLookup =
  { replayed: true; text: string } | { replayed: false; reason: WorkflowReplayMissReason };

/**
 * What one run did about replay, persisted verbatim into `result.json`.
 *
 * Two independent booleans on purpose: `replayed` answers "did this run reuse
 * recorded evidence" (the honesty question), `recorded` answers "can a later
 * resume reuse THIS run" (the capability question). A run can be neither, one,
 * or both, and collapsing them into a single status word loses a real case.
 */
export interface WorkflowReplayEnvelope {
  replayed: boolean;
  recorded: boolean;
  sourceRunId?: string;
  /** Present exactly when a resume was requested and replay did not happen. */
  refusedReason?: WorkflowReplayRefusalReason;
  /** Present exactly when `recorded` is false. */
  notRecordedReason?: WorkflowReplayNotRecordedReason;
  replayedCalls: number;
  freshCalls: number;
  divergedAtCall?: number;
  /** Node name of the first fresh call, when that call carried a label. */
  divergedAtNode?: string;
}

export interface WorkflowReplayCounts {
  replayedCalls: number;
  freshCalls: number;
  /** 0-based ordinal of the first agent attempt that broke the prefix, if any. */
  divergedAtCall?: number;
  /**
   * Name of the CURRENT first fresh call, absent when that call has no label.
   * The current call is the only available source: on `no-record` and
   * `unnamed-node` there is no recorded name at all, and those are exactly the
   * paths a repair-and-continue resume takes.
   */
  divergedAtNode?: string;
}

/** One agent call as the runtime sees it, named where the author named it. */
export interface WorkflowReplayAgentCall {
  /** `[phase, label, occurrence]`; absent for a call without a label. */
  node?: string;
  canonicalRequest: string;
  /** Shaped-return contract version of THIS call; absent for a plain-text call. */
  returnContractVersion?: number;
}

/**
 * The seam the pure runtime receives. It hides the file, the hashing, the
 * cursors, and the latch; the runtime only supplies a canonical request string
 * and says whether the call is safe to serve from a record.
 */
export interface WorkflowReplayController {
  /**
   * Claim the next recorded agent attempt. ALWAYS advances the read cursor, so
   * the caller must invoke it exactly once per attempt, even when it will not
   * use the answer.
   */
  beginAgentAttempt(call: WorkflowReplayAgentCall & { replayable: boolean }): WorkflowReplayAgentLookup;
  /** Record this run's own outcome for the attempt just begun. */
  recordAgentAttempt(call: WorkflowReplayAgentCall, outcome: { ok: true; text: string } | { ok: false }): void;
  /** Replay a recorded value, or produce and record a fresh one. */
  resolveValue(kind: WorkflowReplayValueKind, produce: () => number): number;
  counts(): WorkflowReplayCounts;
}

export function workflowReplayFile(runDir: string): string {
  return path.join(workflowRunRuntimeDir(runDir), WORKFLOW_REPLAY_FILE);
}

/**
 * Read one run's recorded calls. Best-effort in the same sense as the journal
 * reader: a malformed or partially written line is skipped rather than thrown,
 * because a truncated record must degrade into "fewer replayable calls", never
 * into a failed resume.
 */
export function readWorkflowReplayLog(projectRoot: string, runId: string): WorkflowReplayEntry[] {
  let raw: string;
  try {
    const runDir = resolveWorkflowRunDir(projectRoot, runId);
    raw = readWorkflowRunTextFile(runDir, workflowReplayFile(runDir));
  } catch {
    return [];
  }
  const entries: WorkflowReplayEntry[] = [];
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = parseReplayEntry(parsed);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

export interface CreateWorkflowReplayControllerOptions {
  /** Crash recovery must not duplicate an already-confirmed prefix on mismatch. */
  requireRecordedPrefix?: boolean;
  /** Run directory of the run being executed now; its record is written here. */
  runDir: string;
  /** Recorded entries from the resume source. Omit to record without replaying. */
  recorded?: readonly WorkflowReplayEntry[];
  /**
   * The root script bytes differ from the recorded run's. Repair is the expected
   * reason, so replay continues — but the node name stops being decoration and
   * becomes required: a call the author never named cannot be located in a
   * program that changed underneath it.
   */
  sourceScriptChanged?: boolean;
}

export function createWorkflowReplayController(
  options: CreateWorkflowReplayControllerOptions,
): WorkflowReplayController {
  return new FileBackedWorkflowReplayController(options);
}

class FileBackedWorkflowReplayController implements WorkflowReplayController {
  readonly #runDir: string;
  readonly #recordPath: string;
  readonly #recordedAgents: readonly WorkflowReplayAgentEntry[];
  readonly #recordedValues: ReadonlyMap<WorkflowReplayValueKind, readonly number[]>;
  readonly #replayEnabled: boolean;
  readonly #sourceScriptChanged: boolean;
  readonly #requireRecordedPrefix: boolean;
  #readCursor = 0;
  #writeCursor = 0;
  readonly #valueCursors = new Map<WorkflowReplayValueKind, number>();
  readonly #valueWriteCursors = new Map<WorkflowReplayValueKind, number>();
  #diverged = false;
  #divergedAtCall: number | undefined;
  #divergedAtNode: string | undefined;
  #replayedCalls = 0;
  #freshCalls = 0;
  #directoryEnsured = false;

  constructor(options: CreateWorkflowReplayControllerOptions) {
    this.#runDir = options.runDir;
    this.#recordPath = workflowReplayFile(options.runDir);
    const recorded = options.recorded ?? [];
    this.#replayEnabled = options.recorded !== undefined;
    this.#sourceScriptChanged = options.sourceScriptChanged === true;
    this.#requireRecordedPrefix = options.requireRecordedPrefix === true;
    this.#recordedAgents = recorded.filter((entry): entry is WorkflowReplayAgentEntry => entry.kind === "agent");
    const values = new Map<WorkflowReplayValueKind, number[]>();
    for (const entry of recorded) {
      if (entry.kind === "agent") continue;
      const bucket = values.get(entry.kind);
      if (bucket === undefined) values.set(entry.kind, [entry.value]);
      else bucket.push(entry.value);
    }
    this.#recordedValues = values;
  }

  beginAgentAttempt(call: WorkflowReplayAgentCall & { replayable: boolean }): WorkflowReplayAgentLookup {
    const ordinal = this.#readCursor;
    this.#readCursor += 1;
    // Every miss below latches, so the latch is set here once rather than at six
    // return sites. The two paths that return before this helper are the two
    // that must NOT latch: replay is switched off, and the latch already holds.
    const miss = (reason: WorkflowReplayMissReason): WorkflowReplayAgentLookup => {
      if (this.#requireRecordedPrefix && ordinal < this.#recordedAgents.length)
        throw new Error(`Interrupted recovery refused prefix divergence at call ${ordinal}: ${reason}`);
      this.#freshCalls += 1;
      if (!this.#diverged) {
        this.#diverged = true;
        this.#divergedAtCall = ordinal;
        this.#divergedAtNode = call.node;
      }
      return { replayed: false, reason };
    };
    if (!this.#replayEnabled) {
      this.#freshCalls += 1;
      return { replayed: false, reason: "no-record" };
    }
    if (this.#diverged) {
      this.#freshCalls += 1;
      return { replayed: false, reason: "diverged" };
    }

    const entry = this.#recordedAgents[ordinal];
    if (entry === undefined) return miss("no-record");
    // Name before key, and only when the bytes moved. On unchanged bytes the
    // position is still a legitimate name, so a record written before this field
    // existed keeps replaying exactly as it did.
    if (this.#sourceScriptChanged) {
      if (entry.node === undefined || call.node === undefined) return miss("unnamed-node");
      if (entry.node !== call.node) return miss("node-mismatch");
    }
    if (entry.key !== hashCanonicalRequest(call.canonicalRequest)) {
      // A shaped call whose record predates contract v2 (no `rcv`, or an older one) cannot
      // match by construction. Name that boundary rather than blaming the author's script.
      const recorded = entry.rcv ?? WORKFLOW_RETURN_CONTRACT_V1;
      return call.returnContractVersion !== undefined && recorded < call.returnContractVersion
        ? miss("return-contract-changed")
        : miss("key-mismatch");
    }
    if (!entry.ok) return miss("recorded-failure");
    if (!call.replayable) return miss("side-effecting-call");

    this.#replayedCalls += 1;
    return { replayed: true, text: entry.text };
  }

  recordAgentAttempt(call: WorkflowReplayAgentCall, outcome: { ok: true; text: string } | { ok: false }): void {
    const seq = this.#writeCursor;
    this.#writeCursor += 1;
    const key = hashCanonicalRequest(call.canonicalRequest);
    const node = call.node === undefined ? {} : { node: call.node };
    const rcv = call.returnContractVersion === undefined ? {} : { rcv: call.returnContractVersion };
    this.#append(
      outcome.ok
        ? { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind: "agent", ...node, key, ...rcv, ok: true, text: outcome.text }
        : { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind: "agent", ...node, key, ...rcv, ok: false },
    );
  }

  // TODO(iteration-2026-07-21): value entries have no integrity key. An agent
  // entry fails closed on a request-hash mismatch; a `clock`/`random` entry is
  // matched by per-kind array POSITION only, and `readWorkflowReplayLog` skips
  // malformed lines silently — so one truncated value line shifts every later
  // `dsl.now()`/`dsl.random()` by one and replays a WRONG value with no
  // divergence signal. The recorded `seq` is parsed and then never used; keying
  // or ordinal-checking against it is the obvious fix. Deferred: deterministic
  // replay is out of scope this iteration (MVP = one working chain of agents).
  // See `.locus/reviews/2026-07-21-workflow-dsl/reconciliation-1.md` (A5, S3).
  resolveValue(kind: WorkflowReplayValueKind, produce: () => number): number {
    const ordinal = this.#valueCursors.get(kind) ?? 0;
    this.#valueCursors.set(kind, ordinal + 1);
    const recorded = this.#replayEnabled && !this.#diverged ? this.#recordedValues.get(kind)?.[ordinal] : undefined;
    const value = recorded ?? produce();
    const seq = this.#valueWriteCursors.get(kind) ?? 0;
    this.#valueWriteCursors.set(kind, seq + 1);
    this.#append({ v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind, value });
    return value;
  }

  counts(): WorkflowReplayCounts {
    return {
      replayedCalls: this.#replayedCalls,
      freshCalls: this.#freshCalls,
      ...(this.#divergedAtCall !== undefined ? { divergedAtCall: this.#divergedAtCall } : {}),
      ...(this.#divergedAtNode !== undefined ? { divergedAtNode: this.#divergedAtNode } : {}),
    };
  }

  #append(entry: WorkflowReplayEntry): void {
    try {
      if (!this.#directoryEnsured) {
        ensureWorkflowDirectoryNoSymlink(this.#runDir, workflowRunRuntimeDir(this.#runDir));
        this.#directoryEnsured = true;
      }
      appendWorkflowRunTextFile(this.#runDir, this.#recordPath, `${JSON.stringify(entry)}\n`);
    } catch {
      // A record that cannot be written costs a future resume, never this run.
      // Same discipline as the journal sink: never throw into the DSL.
    }
  }
}

/**
 * Stable identity of one child request. The canonical string already carries the
 * prompt and every resolved option; hashing keeps the record line bounded and
 * keeps prompt bytes out of the comparison path.
 */
export function hashCanonicalRequest(canonicalRequest: string): string {
  return createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
}

function parseReplayEntry(value: unknown): WorkflowReplayEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== WORKFLOW_REPLAY_SCHEMA_VERSION) return undefined;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) return undefined;
  if (record.kind === "agent") {
    if (typeof record.key !== "string" || !/^[a-f0-9]{64}$/u.test(record.key)) return undefined;
    // Optional, but not lax: a `node` of the wrong type is a malformed line, and
    // silently dropping just the field would turn it into a legacy-shaped entry
    // that replays under a repaired source. Absent stays absent; wrong is a
    // skipped line, exactly as a wrong `key` is.
    if (record.node !== undefined && typeof record.node !== "string") return undefined;
    const node = record.node === undefined ? {} : { node: record.node };
    // Same discipline as `node`: absent means "v1 or plain text" and stays absent; a wrong
    // TYPE is a malformed line, because a contract version that cannot be read cannot be
    // compared and would silently collapse into the legacy reading.
    if (record.rcv !== undefined && (typeof record.rcv !== "number" || !Number.isInteger(record.rcv))) return undefined;
    const rcv = record.rcv === undefined ? {} : { rcv: record.rcv as number };
    if (record.ok === true) {
      return typeof record.text === "string"
        ? {
            v: WORKFLOW_REPLAY_SCHEMA_VERSION,
            seq: record.seq,
            kind: "agent",
            ...node,
            key: record.key,
            ...rcv,
            ok: true,
            text: record.text,
          }
        : undefined;
    }
    if (record.ok === false) {
      return {
        v: WORKFLOW_REPLAY_SCHEMA_VERSION,
        seq: record.seq,
        kind: "agent",
        ...node,
        key: record.key,
        ...rcv,
        ok: false,
      };
    }
    return undefined;
  }
  if (record.kind !== "clock" && record.kind !== "random") return undefined;
  if (typeof record.value !== "number" || !Number.isFinite(record.value)) return undefined;
  return { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq: record.seq, kind: record.kind, value: record.value };
}
