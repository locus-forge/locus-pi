import type { AgentStructuredReceipt } from "../../_shared/agent-runtime/agent-runner.js";
import { immutableJSON } from "./structured-results/schema.js";
/** Recorded-call store: admission identities, immutable receipts and strict-prefix replay.
 * Log v4 records launch order; only verified serial recovery may reuse legacy v3.
 * Ordinary misses may run fresh; structured/recovery and retired-native calls fail closed.
 * No lookup invents acceptance. Filesystem and poison-marker ownership stay here.
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
      /** Omitted only for an unreadable retired-native row; never accepted as a request identity. */
      key?: string;
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

/** Persisted replay outcome. Reused evidence and a reusable new record are independent. */
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
  /** Current first divergent call's label; never inferred from historical evidence. */
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

/** Pure-runtime port for one-time admission/settlement and strict-prefix value replay. */
export interface WorkflowReplayController {
  /** Claim exactly once per logical call; even a refused lookup advances the ordinal. */
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

/** Recognizable retirement is negative evidence even when the rest of a row is damaged. */
function retiredNativeReplay(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const receipt = row.structuredReceipt;
  return (
    row.rcv === 5 || (receipt !== null && typeof receipt === "object" && "version" in receipt && receipt.version === 5)
  );
}
function retiredNativeMarker(value: unknown): WorkflowReplayAgentEntry {
  const row = value as Record<string, unknown>;
  if (
    (row.v !== 3 && row.v !== WORKFLOW_REPLAY_SCHEMA_VERSION) ||
    row.kind !== "agent" ||
    typeof row.seq !== "number" ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 0
  )
    throw new Error("replay-contract-failure: historical native v5 position is unproven");
  return Object.freeze({ v: row.v, seq: row.seq, kind: "agent", rcv: 5, ok: false });
}

/**
 * Damaged ordinary rows reduce the proven prefix. Readable kind/seq poisons that
 * ordinal and its suffix; otherwise no later physical row is trusted.
 * Retired-native metadata survives as negative evidence, never acceptance;
 * an unproven retired position refuses intake rather than inventing an ordinal.
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
    const retired = retiredNativeReplay(parsed) ? retiredNativeMarker(parsed) : undefined;
    let entry: WorkflowReplayEntry | undefined;
    try {
      entry = parseReplayEntry(parsed);
    } catch {
      entry = undefined;
    }
    if (entry !== undefined) entries.push(retired !== undefined && !retiredNativeReplay(entry) ? retired : entry);
    else {
      if (retired !== undefined) entries.push(retired);
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
  return entries.filter((entry) => retiredNativeReplay(entry) || entry.seq < (invalidFrom.get(entry.kind) ?? Infinity));
}

export interface CreateWorkflowReplayControllerOptions {
  /** Only for a journal-verified, non-overlapping serial prefix (including v3).
   *  Crash recovery must not duplicate that confirmed prefix on mismatch. */
  requireRecordedPrefix?: boolean;
  /** Run directory of the run being executed now; its record is written here. */
  runDir: string;
  /** Recorded entries from the resume source. Omit to record without replaying. */
  recorded?: readonly WorkflowReplayEntry[];
  /** Repaired source requires matching named nodes as well as request identity. */
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
      if (retiredNativeReplay(entry)) {
        if (entry.v === 3)
          throw new Error("replay-contract-failure: historical native v5 admission order is unproven in log v3");
        return retiredNativeMarker(entry);
      }
      if (entry.kind !== "agent") return entry;
      if (entry.rcv !== 4 && entry.rcv !== 5 && (!entry.ok || entry.structuredReceipt === undefined)) return entry;
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
        const prior = agents.get(entry.seq);
        agents.set(
          entry.seq,
          retiredNativeReplay(entry)
            ? entry
            : retiredNativeReplay(prior)
              ? prior
              : agents.has(entry.seq)
                ? undefined
                : entry,
        );
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
    const structured = call.returnContractVersion === 4 || call.returnContractVersion === 5;
    if (this.#strictRefusal !== undefined) throw new Error(this.#strictRefusal);
    const entry = this.#recordedAgents.get(ordinal);
    if (retiredNativeReplay(entry)) {
      this.#refusePrefix(ordinal, call.node, "return-contract-changed");
      throw new Error("replay-contract-failure: historical native v5 output requires an explicit new run");
    }
    const miss = (reason: WorkflowReplayMissReason): WorkflowReplayAgentLookup => {
      this.#refusePrefix(ordinal, call.node, reason);
      if (structured)
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
      if (structured) throw new Error(`replay-contract-failure: v${call.returnContractVersion} prefix diverged`);
      this.#freshCalls += 1;
      return { replayed: false, reason: "diverged" };
    }

    if (entry === undefined)
      return miss(ordinal < this.#recordedAgentExtent ? "recorded-sequence-invalid" : "no-record");
    // Only interrupted recovery confirms serial v3 launch order against its journal.
    if (entry.v !== WORKFLOW_REPLAY_SCHEMA_VERSION && !this.#requireRecordedPrefix)
      return miss("invocation-identity-unproven");
    // Name changed source before key; unchanged source keeps admission ordinal identity.
    if (this.#sourceScriptChanged) {
      if (entry.node === undefined || call.node === undefined) return miss("unnamed-node");
      if (entry.node !== call.node) return miss("node-mismatch");
    }
    if (structured && entry.rcv !== call.returnContractVersion) return miss("return-contract-changed");
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
    // Invalid node metadata poisons the row; never silently reinterpret it as absent.
    if (record.node !== undefined && typeof record.node !== "string") return undefined;
    const node = record.node === undefined ? {} : { node: record.node };
    // Unknown contract-version types cannot collapse into the legacy plain-text reading.
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
