import type { AgentStructuredReceipt } from "../../_shared/agent-runtime/agent-runner.js";
import { immutableJSON } from "./structured-results/schema.js";
/**
 * Recorded-call store for --resume: payloads, request hashes, admission receipts,
 * value cursors and one strict-prefix divergence latch. The journal retains only
 * replay markers; this sidecar keeps full answers out of bounded live/status views.
 *
 * Replay-log v4 allocates agent identity before awaited work and settles it once,
 * independent of completion order or transport retries. Normal v3 reuse is unproven;
 * only separately verified, non-overlapping serial crash recovery may reuse it.
 * Missing, ambiguous or changed positions stop prefix reuse. Ordinary callers can
 * run fresh after a miss; structured-return v4/v5 and confirmed recovery fail closed
 * instead of repeating effects. No lookup invents an answer or upgrades old evidence.
 *
 * Request identity and, for repaired source, named node identity must still match.
 * Filesystem access stays here; the pure runtime receives WorkflowReplayController.
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
/** v4 allocates agent seq at admission, not completion. v3 remains readable evidence. */
export const WORKFLOW_REPLAY_SCHEMA_VERSION = 4 as const;
type WorkflowReplaySchemaVersion = 3 | typeof WORKFLOW_REPLAY_SCHEMA_VERSION;

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

/** Agent seq is admission order in v4; historical v3 seq was completion order. */
export type WorkflowReplayEntry =
  | {
      v: WorkflowReplaySchemaVersion;
      seq: number;
      kind: "agent";
      node?: string;
      key: string;
      /** Return-contract version of choice/structured calls, separate from log v.
       *  Absent for plain text and old records predating contract v2. */
      rcv?: number;
      ok: true;
      text: string;
      structuredReceipt?: AgentStructuredReceipt;
    }
  | {
      v: WorkflowReplaySchemaVersion;
      seq: number;
      kind: "agent";
      node?: string;
      key: string;
      rcv?: number;
      ok: false;
    }
  | { v: WorkflowReplaySchemaVersion; seq: number; kind: WorkflowReplayValueKind; value: number };

/** Implicit return-contract version of records predating rcv. These versions are
 * separate from the replay-log schema: v1 had legacy answer/clarification bounds,
 * v2 removed those bounds, v3 is exact choice, and v4 requires a structured receipt.
 * A named contract mismatch never upgrades an old answer to a new acceptance. */
export const WORKFLOW_RETURN_CONTRACT_V1 = 1 as const;

export type WorkflowReplayAgentEntry = Extract<WorkflowReplayEntry, { kind: "agent" }>;

/** Why one agent attempt was not served from the record. Never a silent miss. */
export type WorkflowReplayMissReason =
  | "no-record"
  | "invocation-identity-unproven"
  | "recorded-sequence-invalid"
  | "unnamed-node"
  | "node-mismatch"
  | "return-contract-changed"
  | "key-mismatch"
  | "recorded-failure"
  | "side-effecting-call"
  | "diverged";

export type WorkflowReplayAgentLookup =
  | { replayed: true; text: string; structuredReceipt?: AgentStructuredReceipt }
  | { replayed: false; reason: WorkflowReplayMissReason };

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
  /** Settle the exact admission receipt once, preserving structured evidence. */
  recordAgentAttempt(
    receipt: WorkflowReplayAgentLookup,
    outcome: { ok: true; text: string; structuredReceipt?: AgentStructuredReceipt } | { ok: false },
  ): void;
  /** Replay a recorded value, or produce and record a fresh one. */
  resolveValue(kind: WorkflowReplayValueKind, produce: () => number): number;
  counts(): WorkflowReplayCounts;
}

export function workflowReplayFile(runDir: string): string {
  return path.join(workflowRunRuntimeDir(runDir), WORKFLOW_REPLAY_FILE);
}

/**
 * Read one run's recorded calls. Best-effort in the same sense as the journal
 * reader: damaged rows reduce the proven prefix rather than throwing. A malformed
 * row with a readable kind/seq poisons that ordinal and its suffix; otherwise no
 * later physical row is trusted. The controller preserves every remaining seq gap.
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
  const invalidFrom = new Map<WorkflowReplayEntry["kind"], number>();
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break;
    }
    const entry = parseReplayEntry(parsed);
    if (entry !== undefined) entries.push(entry);
    else {
      if (typeof parsed !== "object" || parsed === null) break;
      const row = parsed as Record<string, unknown>;
      // Old unsupported schemas are not reinterpreted, including their sequences.
      if (row.v !== 3 && row.v !== WORKFLOW_REPLAY_SCHEMA_VERSION) continue;
      if (
        (row.kind !== "agent" && row.kind !== "clock" && row.kind !== "random") ||
        typeof row.seq !== "number" ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 0
      )
        break;
      invalidFrom.set(row.kind, Math.min(invalidFrom.get(row.kind) ?? Infinity, row.seq));
    }
  }
  return entries.filter((entry) => entry.seq < (invalidFrom.get(entry.kind) ?? Infinity));
}

export interface CreateWorkflowReplayControllerOptions {
  /** Only for a journal-verified, non-overlapping serial prefix (including v3).
   *  Crash recovery must not duplicate that confirmed prefix on mismatch. */
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
  readonly #recordedAgents: ReadonlyMap<number, WorkflowReplayAgentEntry | undefined>;
  readonly #recordedValues = new Map<WorkflowReplayValueKind, Map<number, number | undefined>>();
  readonly #admissions = new WeakMap<WorkflowReplayAgentLookup, { seq: number; call: WorkflowReplayAgentCall }>();
  readonly #recordedAgentExtent: number;
  readonly #replayEnabled: boolean;
  readonly #sourceScriptChanged: boolean;
  readonly #requireRecordedPrefix: boolean;
  #readCursor = 0;
  readonly #valueCursors = new Map<WorkflowReplayValueKind, number>();
  #diverged = false;
  #strictRefusal: string | undefined;
  #divergedAtCall: number | undefined;
  #divergedAtNode: string | undefined;
  #replayedCalls = 0;
  #freshCalls = 0;
  #directoryEnsured = false;

  constructor(options: CreateWorkflowReplayControllerOptions) {
    this.#runDir = options.runDir;
    this.#recordPath = workflowReplayFile(options.runDir);
    const recorded = (options.recorded ?? []).map((entry) => {
      if (entry.kind !== "agent" || (entry.rcv !== 4 && entry.rcv !== 5)) return entry;
      try {
        return immutableJSON(entry) as unknown as WorkflowReplayEntry;
      } catch (error) {
        throw new Error(`replay-contract-failure: invalid structured record: ${String(error)}`);
      }
    });
    this.#replayEnabled = options.recorded !== undefined;
    this.#sourceScriptChanged = options.sourceScriptChanged === true;
    this.#requireRecordedPrefix = options.requireRecordedPrefix === true;
    const agents = new Map<number, WorkflowReplayAgentEntry | undefined>();
    let extent = 0;
    for (const entry of recorded) {
      if (entry.kind === "agent") {
        // Never compact a missing slot or choose a winner for a duplicate identity.
        agents.set(entry.seq, agents.has(entry.seq) ? undefined : entry);
        extent = Math.max(extent, entry.seq + 1);
      } else {
        const bucket = this.#recordedValues.get(entry.kind) ?? new Map<number, number | undefined>();
        bucket.set(entry.seq, bucket.has(entry.seq) ? undefined : entry.value);
        this.#recordedValues.set(entry.kind, bucket);
      }
    }
    this.#recordedAgents = agents;
    this.#recordedAgentExtent = extent;
  }

  beginAgentAttempt(call: WorkflowReplayAgentCall & { replayable: boolean }): WorkflowReplayAgentLookup {
    const ordinal = this.#readCursor;
    this.#readCursor += 1;
    const receipt = Object.freeze(this.#lookupAgent(call, ordinal));
    this.#admissions.set(receipt, { seq: ordinal, call: { ...call } });
    return receipt;
  }

  #lookupAgent(call: WorkflowReplayAgentCall & { replayable: boolean }, ordinal: number): WorkflowReplayAgentLookup {
    if (this.#strictRefusal !== undefined) throw new Error(this.#strictRefusal);
    const miss = (reason: WorkflowReplayMissReason): WorkflowReplayAgentLookup => {
      this.#refusePrefix(ordinal, call.node, reason);
      if (call.returnContractVersion === 4 || call.returnContractVersion === 5)
        throw new Error(`replay-contract-failure: v${call.returnContractVersion} prefix unavailable (${reason})`);
      if (this.#strictRefusal !== undefined) throw new Error(this.#strictRefusal);
      this.#freshCalls += 1;
      return { replayed: false, reason };
    };
    if (!this.#replayEnabled) {
      this.#freshCalls += 1;
      return { replayed: false, reason: "no-record" };
    }
    if (this.#diverged) {
      if (call.returnContractVersion === 4 || call.returnContractVersion === 5)
        throw new Error(`replay-contract-failure: v${call.returnContractVersion} prefix diverged`);
      this.#freshCalls += 1;
      return { replayed: false, reason: "diverged" };
    }

    const entry = this.#recordedAgents.get(ordinal);
    if (entry === undefined)
      return miss(ordinal < this.#recordedAgentExtent ? "recorded-sequence-invalid" : "no-record");
    // Only interrupted recovery has independently confirmed non-overlapping serial
    // execution against its journal. Normal resume cannot infer launch order from v3.
    if (entry.v !== WORKFLOW_REPLAY_SCHEMA_VERSION && !this.#requireRecordedPrefix)
      return miss("invocation-identity-unproven");
    // Name before key when the source changed. On unchanged bytes the admission
    // ordinal remains authoritative, even for an unlabelled call.
    if (this.#sourceScriptChanged) {
      if (entry.node === undefined || call.node === undefined) return miss("unnamed-node");
      if (entry.node !== call.node) return miss("node-mismatch");
    }
    if (entry.key !== hashCanonicalRequest(call.canonicalRequest)) {
      // A choice whose record predates the current contract (no `rcv`, or an older one)
      // cannot match by construction. Name that boundary rather than blaming the script.
      const recorded = entry.rcv ?? WORKFLOW_RETURN_CONTRACT_V1;
      return call.returnContractVersion !== undefined && recorded < call.returnContractVersion
        ? miss("return-contract-changed")
        : miss("key-mismatch");
    }
    if (!entry.ok) return miss("recorded-failure");
    if (!call.replayable) return miss("side-effecting-call");

    this.#replayedCalls += 1;
    return {
      replayed: true,
      text: entry.text,
      ...(entry.structuredReceipt === undefined ? {} : { structuredReceipt: entry.structuredReceipt }),
    };
  }

  recordAgentAttempt(
    receipt: WorkflowReplayAgentLookup,
    outcome: { ok: true; text: string; structuredReceipt?: AgentStructuredReceipt } | { ok: false },
  ): void {
    const admission = this.#admissions.get(receipt);
    if (admission === undefined) throw new Error("Replay receipt is foreign or already settled");
    this.#admissions.delete(receipt);
    const { seq, call } = admission;
    if (receipt.replayed && !outcome.ok) {
      this.#replayedCalls -= 1;
      this.#refusePrefix(seq, call.node, "recorded-failure");
    }
    const key = hashCanonicalRequest(call.canonicalRequest);
    const node = call.node === undefined ? {} : { node: call.node };
    const rcv = call.returnContractVersion === undefined ? {} : { rcv: call.returnContractVersion };
    this.#append(
      outcome.ok
        ? {
            v: WORKFLOW_REPLAY_SCHEMA_VERSION,
            seq,
            kind: "agent",
            ...node,
            key,
            ...rcv,
            ok: true,
            text: outcome.text,
            ...(outcome.structuredReceipt === undefined ? {} : { structuredReceipt: outcome.structuredReceipt }),
          }
        : { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind: "agent", ...node, key, ...rcv, ok: false },
    );
  }

  resolveValue(kind: WorkflowReplayValueKind, produce: () => number): number {
    if (this.#strictRefusal !== undefined) throw new Error(this.#strictRefusal);
    const ordinal = this.#valueCursors.get(kind) ?? 0;
    this.#valueCursors.set(kind, ordinal + 1);
    const recorded = this.#replayEnabled && !this.#diverged ? this.#recordedValues.get(kind)?.get(ordinal) : undefined;
    if (this.#replayEnabled && !this.#diverged && recorded === undefined) {
      this.#refusePrefix(this.#readCursor, undefined, "recorded-sequence-invalid");
      if (this.#strictRefusal !== undefined) throw new Error(this.#strictRefusal);
    }
    const value = recorded ?? produce();
    this.#append({ v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq: ordinal, kind, value });
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

  /** Every known refusal closes reuse before throwing or returning to trusted callers. */
  #refusePrefix(ordinal: number, node: string | undefined, reason: WorkflowReplayMissReason): void {
    this.#diverged = true;
    if (this.#divergedAtCall === undefined || ordinal < this.#divergedAtCall) {
      this.#divergedAtCall = ordinal;
      this.#divergedAtNode = node;
    }
    if (this.#requireRecordedPrefix && ordinal < this.#recordedAgentExtent)
      this.#strictRefusal ??= `Interrupted recovery refused prefix divergence at call ${ordinal}: ${reason}`;
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
  if (record.v !== 3 && record.v !== WORKFLOW_REPLAY_SCHEMA_VERSION) return undefined;
  if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 0) return undefined;
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
            v: record.v,
            seq: record.seq,
            kind: "agent",
            ...node,
            key: record.key,
            ...rcv,
            ok: true,
            text: record.text,
            ...(record.structuredReceipt === undefined
              ? {}
              : { structuredReceipt: immutableJSON(record.structuredReceipt) as unknown as AgentStructuredReceipt }),
          }
        : undefined;
    }
    if (record.ok === false) {
      return {
        v: record.v,
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
  return { v: record.v, seq: record.seq, kind: record.kind, value: record.value };
}
