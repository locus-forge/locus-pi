/**
 * workflow-run-snapshot.ts — read back the immutable workflow source snapshot
 * that ONE exact persisted run recorded, and nothing else.
 *
 * This reader answers a single question: can the bytes this run actually
 * executed still be produced, proven against the identity the run persisted?
 * It never consults the current workflow resolver, never re-reads the live
 * source file, and never creates or repairs anything on disk. A run whose
 * snapshot is gone reads as `missing` — it does NOT fall back to whatever the
 * source path holds today, because today's bytes are not evidence of what ran.
 *
 * `workflow-script-identity.ts` stays the owner of scanning a SOURCE file and
 * minting an identity; this module only verifies a PERSISTED one, and borrows
 * `sha256WorkflowBytes` from that owner rather than restating the digest.
 *
 * READ-STATE MATRIX (states, and the precedence they are decided in)
 *
 * `ready` is reached only by falling through every check below, in this order.
 * The first matching row wins; a later row never downgrades an earlier verdict.
 *
 *   1. invalid    — the requested runId is not a canonical run id.
 *   2. invalid    — the run's evidence root or result path is not a regular
 *                   canonical path (symlinked ancestor, unresolvable run dir).
 *   3. legacy     — no readable persisted result at all.
 *   4. invalid    — the persisted runId is malformed or names ANOTHER run,
 *                   i.e. a result envelope copied in from elsewhere.
 *   5. legacy     — the envelope predates run binding (no persisted runId).
 *   6. invalid    — any present-but-malformed persisted metadata, exactly as
 *                   `workflowPersistedResultInvalidity` ranks it (this is where
 *                   a wrong workspace physical identity or an unsupported
 *                   physical-identity schema version lands).
 *   7. invalid    — a `scriptIdentity` key is present but did not parse;
 *      legacy     — no `scriptIdentity` key at all (predates snapshots).
 *   8. legacy     — identity schemaVersion is not 2: entry identity only, so
 *                   there is no trusted executed snapshot to verify.
 *   9. invalid    — the recorded snapshot path is outside this run's own
 *                   runtime directory, or is not the hash-derived filename.
 *  10. missing    — the recorded snapshot file is absent;
 *      invalid    — probing that path itself failed.
 *  11. tampered   — the snapshot is present but its bytes no longer hash to the
 *                   persisted `scriptSha256`.
 *  12. invalid    — the snapshot verified but the run persisted no valid target.
 *  13. unreadable — reading or hashing the snapshot threw.
 *  14. ready      — exact path, exact filename, exact hash, exact target.
 *
 * A removed WORKSPACE does not appear here: it is not this file's concern, and
 * a run whose workspace is gone still reads as historical evidence through
 * `workflow-result.ts`. Whether such a run may be RESUMED is an admission
 * decision owned elsewhere; this reader never answers it.
 */

import path from "node:path";
import {
  assertWorkflowRunId,
  readWorkflowRunFile,
  readWorkflowRunTextFile,
  resolveWorkflowRunDir,
  workflowRunFileExists,
  workflowRunRuntimeDir,
} from "./workflow-run-layout.js";
import {
  readWorkflowRunResult,
  workflowPersistedResultInvalidity,
  workflowResultFile,
  type WorkflowRunResultEnvelope,
} from "./workflow-result.js";
import { sha256WorkflowBytes, type WorkflowIdentityCoverage } from "./workflow-script-identity.js";

export type WorkflowRunScriptSnapshot =
  | {
      kind: "ready";
      runId: string;
      target: NonNullable<WorkflowRunResultEnvelope["target"]>;
      path: string;
      sha256: string;
      identityCoverage: WorkflowIdentityCoverage;
      source: string;
    }
  | {
      kind: "legacy" | "missing" | "unreadable" | "invalid" | "tampered";
      runId: string;
      target?: WorkflowRunResultEnvelope["target"];
      path?: string;
      sha256?: string;
      identityCoverage?: WorkflowIdentityCoverage;
      message: string;
    };

/**
 * Read only the immutable source snapshot recorded by one exact persisted run.
 * This boundary never consults the current workflow resolver or another file.
 */
export function readWorkflowRunScriptSnapshot(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowRunScriptSnapshot {
  try {
    assertWorkflowRunId(runId);
  } catch (error) {
    return snapshotUnavailable("invalid", runId, `${errorMessage(error)}.`);
  }

  let runDir: string;
  try {
    runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, runId);
    workflowRunFileExists(runDir, workflowResultFile(runDir));
  } catch (error) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} evidence root is not a regular canonical path: ${errorMessage(error)}.`,
    );
  }

  const result = readWorkflowRunResult(projectRoot, runId, runDir);
  if (result === null) {
    return snapshotUnavailable("legacy", runId, `Run ${runId} has no readable persisted result identity.`);
  }
  if (result.runIdInvalid !== undefined) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} has malformed persisted result binding (${result.runIdInvalid}).`,
      result.target,
    );
  }
  if (result.runUnbound !== undefined) {
    return snapshotUnavailable("legacy", runId, `Run ${runId} predates persisted result run binding.`, result.target);
  }
  const invalidity = workflowPersistedResultInvalidity(result);
  if (invalidity !== undefined) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} has malformed persisted workflow metadata (${invalidity}).`,
      result.target,
    );
  }
  const identity = result.scriptIdentity;
  if (identity === undefined) {
    if (persistedResultHasScriptIdentity(runDir)) {
      return snapshotUnavailable(
        "invalid",
        runId,
        `Run ${runId} has malformed persisted workflow snapshot identity.`,
        result.target,
      );
    }
    return snapshotUnavailable(
      "legacy",
      runId,
      `Run ${runId} predates retained workflow source snapshots.`,
      result.target,
    );
  }
  const details = {
    target: result.target,
    path: identity.snapshotPath,
    sha256: identity.scriptSha256,
    identityCoverage: identity.identityCoverage,
  };
  if (identity.schemaVersion !== 2) {
    return snapshotUnavailable(
      "legacy",
      runId,
      `Run ${runId} has legacy entry identity but no trusted executed snapshot.`,
      result.target,
      details,
    );
  }

  const lexicalRunDir = path.resolve(runDir);
  const lexicalRuntimeDir = workflowRunRuntimeDir(lexicalRunDir);
  const expectedName = `script-${identity.scriptSha256}.workflow.mjs`;
  const lexicalSnapshot = path.resolve(identity.snapshotPath);
  if (
    path.dirname(lexicalSnapshot) !== lexicalRuntimeDir ||
    path.basename(lexicalSnapshot) !== expectedName ||
    identity.snapshotPath !== path.join(lexicalRuntimeDir, expectedName)
  ) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} records a snapshot outside its exact run directory or with the wrong hash-derived filename.`,
      result.target,
      details,
    );
  }

  try {
    if (!workflowRunFileExists(lexicalRunDir, lexicalSnapshot)) {
      return snapshotUnavailable(
        "missing",
        runId,
        `Run ${runId} snapshot is missing: ${lexicalSnapshot}.`,
        result.target,
        details,
      );
    }
  } catch (error) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} snapshot path is invalid: ${errorMessage(error)}.`,
      result.target,
      details,
    );
  }

  try {
    const sourceBytes = readWorkflowRunFile(lexicalRunDir, lexicalSnapshot);
    const actualSha256 = sha256WorkflowBytes(sourceBytes);
    if (actualSha256 !== identity.scriptSha256) {
      return snapshotUnavailable(
        "tampered",
        runId,
        `Run ${runId} snapshot hash mismatch: expected ${identity.scriptSha256}, got ${actualSha256}.`,
        result.target,
        details,
      );
    }
    if (result.target === undefined) {
      return snapshotUnavailable(
        "invalid",
        runId,
        `Run ${runId} has snapshot identity but no valid persisted workflow target.`,
        undefined,
        details,
      );
    }
    return {
      kind: "ready",
      runId,
      target: result.target,
      path: lexicalSnapshot,
      sha256: identity.scriptSha256,
      identityCoverage: identity.identityCoverage,
      source: sourceBytes.toString("utf8"),
    };
  } catch (error) {
    return snapshotUnavailable(
      "unreadable",
      runId,
      `Run ${runId} snapshot could not be read: ${errorMessage(error)}.`,
      result.target,
      details,
    );
  }
}

function persistedResultHasScriptIdentity(runDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readWorkflowRunTextFile(runDir, workflowResultFile(runDir)));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "scriptIdentity")
    );
  } catch {
    return false;
  }
}

function snapshotUnavailable(
  kind: Exclude<WorkflowRunScriptSnapshot["kind"], "ready">,
  runId: string,
  message: string,
  target?: WorkflowRunResultEnvelope["target"],
  details: { path?: string; sha256?: string; identityCoverage?: WorkflowIdentityCoverage } = {},
): WorkflowRunScriptSnapshot {
  return {
    kind,
    runId,
    ...(target !== undefined ? { target } : {}),
    ...(details.path !== undefined ? { path: details.path } : {}),
    ...(details.sha256 !== undefined ? { sha256: details.sha256 } : {}),
    ...(details.identityCoverage !== undefined ? { identityCoverage: details.identityCoverage } : {}),
    message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
