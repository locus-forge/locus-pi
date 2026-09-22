/**
 * workflow-journal-format.ts — the PERSISTED workflow journal event contract, and nothing
 * that stores it.
 *
 * This module owns what one `journal.ndjson` line IS: the sink a writer appends through,
 * the line shape, every payload type a line carries, and the strict codec that decides
 * whether a persisted line is readable. `workflow-runtime.ts` writes lines against these
 * types and re-exports them under their historical names; `workflow-journal.ts` owns the
 * storage half — run claim, append sink, journal reads, listing, queries and summary — and
 * imports the codec from here.
 *
 * It is deliberately the lower half of the split, the same shape as
 * `workflow-artifact-format.ts`: a format a viewer, a diagnostic and the writer can all
 * agree on without any of them owning the file. Nothing here opens, reads or writes bytes.
 *
 * Validation is NOT verification. `workflowJournalLineProblem` reports the first reason one
 * already-parsed JSON value cannot be a journal line for a given run; it never proves the
 * line describes something that happened.
 *
 * ---------------------------------------------------------------------------
 * The per-kind field matrix, as persisted today
 * ---------------------------------------------------------------------------
 * Every line carries `ts`, `runId` and `kind`. Beyond those three, each event kind has an
 * ALLOWED set (`WORKFLOW_JOURNAL_FIELDS_BY_KIND`, any other field is refused as unknown)
 * and a REQUIRED set (`WORKFLOW_JOURNAL_REQUIRED_FIELDS_BY_KIND`). The two tables below
 * are the contract; this summary exists so a reader can see it without unfolding both.
 *
 *   kind          required beyond ts/runId/kind
 *   ------------- -----------------------------------------------------------
 *   phase         phase
 *   log           message
 *   group_start   groupId, groupKind, groupTotal
 *   group_end     groupId, groupKind, groupTotal, groupCompleted, groupFailed, status
 *   agent_queued  callId
 *   agent_start   (nothing)
 *   agent_end     status
 *   error         message
 *
 * The gaps are LEGACY TOLERANCE, not oversight, and must stay exactly as wide as they are:
 *
 *   - `agent_start` requires nothing because the earliest journals wrote it without a
 *     `callId`; `agent_queued` requires `callId` because it was introduced after that.
 *   - An agent line with no `executionMode` is legacy and is accepted as long as `agent`
 *     is a non-empty string; `executionMode: "bare"` forbids `agent`, `"named"` requires it.
 *   - `schemaValidation.source` and `schemaValidation.coercion` are optional because lines
 *     predate both fields; `coercion` is no longer written at all and still parses.
 *   - `usage.costTotal` is optional — absent means the price is unknown, never zero.
 *   - `WorkflowRunSummary.hasJournal` is optional for the same reason.
 *   - `failureCause` absent means `unclassified`, never "it succeeded".
 *
 * And these are hard refusals, not tolerances:
 *
 *   - a field outside its kind's allowed set (cross-kind or unknown) refuses the line;
 *   - `attempt`, `attempts` and `logicalCallId` are a trio: present together or not at all,
 *     with `attempt <= attempts`;
 *   - `groupKeys` must name every group member exactly once (`length === groupTotal`, no
 *     duplicates);
 *   - `activeToolNames` cannot appear when `replayed` is true;
 *   - `choiceDecision` and `continuation` are valid only on their canonical runtime log
 *     line, and that canonical log line is refused without them.
 */

import { AGENT_FAILURE_CAUSES, type AgentFailureCause } from "../../_shared/agent-runtime/agent-failure-cause.js";
import {
  assertWorkflowRunId,
  isWorkflowArtifactDisplayName,
  WORKFLOW_SAFE_COMPONENT_PATTERN,
} from "./workflow-run-layout.js";
import type { AgentOutputAcceptance } from "../../_shared/agent-runtime/agent-runner.js";
import type { EvidenceEvaluation } from "../../_shared/agent-runtime/agent-evidence-evaluator.js";
import type { PermissionMode } from "../../_shared/agent-runtime/agents.js";
import type { WorkflowArtifactRef, WorkflowContinuationJournal } from "./workflow-artifacts.js";

const WORKFLOW_ARTIFACT_COMPONENT_REGEX = new RegExp(WORKFLOW_SAFE_COMPONENT_PATTERN, "u");

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/**
 * Workspace intent for one agent call. Declared here rather than shared with the host because
 * the DSL is its only author and the bridge below is its only reader: the host request carries
 * the resolved mode as journal metadata, never as a typed field.
 */
export type WorkspaceMode = "project" | "worktree" | "temporary-worktree";

/** The declared Fusion capability contract one agent line records as `capabilityMode`. */
export type WorkflowFusionMode = "tool-free" | "agent";

/** The machine-readable cause carried from the host through the bridge. Re-exported so a
 *  workflow-side caller never has to reach into the agent envelope for the same closed list. */
export type WorkflowAgentFailureCause = AgentFailureCause;

export interface WorkflowAgentChildTrace {
  path: string;
  format: "pi-session-jsonl";
  childSessionId: string;
  htmlPath?: string;
}

export interface WorkflowSchemaValidation {
  status: "valid" | "mismatch";
  /** 1-based loop position of the attempt this verdict describes. A replayed attempt
   *  occupies an ordinal and increments it, and contributes no `usage`. */
  attempts: number;
  /** Final validator/parser errors on mismatch; empty after a valid attempt. */
  errors: string[];
  /** Which authority rejected the answer. Present only on a mismatch, and only on a
   *  call that declared `validate` — a schema-only call has one possible authority,
   *  so naming it would change every existing journal line for no added information. */
  source?: "schema" | "script";
  /** HISTORICAL. How an exact-choice answer was read when it was not the quoted JSON string
   *  the text transport asked for: `bare-text` meant the child answered with the member itself,
   *  `wrapper-object` that it echoed the schema. Nothing writes this any more — a tool argument
   *  IS the value, so there is no dialect to read — and the field stays declared only so journals
   *  recorded before the text transport was deleted keep parsing under the current types. */
  coercion?: WorkflowChoiceCoercion;
}

export type WorkflowChoiceCoercion = "bare-text" | "wrapper-object";

/**
 * Token + cost projection for one model-backed child run, summed per run.
 *
 * `costTotal` is OPTIONAL and absent means UNKNOWN, not zero. The host reports
 * tokens but no price, and the field used to be a hardcoded `0` — a number that
 * reads as "this run was free" and would make any cost budget built on it report
 * "under budget" forever. Observed tokens are real and stay recorded; the price is
 * reported as unavailable until something can actually compute it.
 */
export interface WorkflowUsage {
  input: number;
  output: number;
  totalTokens: number;
  /** Absent when the host reports no price. Never synthesized as zero. */
  costTotal?: number;
}

// ---------------------------------------------------------------------------
// Run summary — the projection a resume line carries as `resumeSourceRunSummary`
// ---------------------------------------------------------------------------

export type WorkflowRunStatus = "running" | "completed" | "awaiting_operator" | "cancelled" | "failed" | "unknown";

export interface WorkflowRunSummary {
  runId: string;
  status: WorkflowRunStatus;
  phase: string | null; // last phase seen
  agentsStarted: number;
  agentsEnded: number;
  /** Agent calls served from a recorded run instead of a fresh child (T-109).
   *  A non-zero count means part of this run's evidence is not fresh. */
  agentsReplayed: number;
  /** Run-level token/cost budget summed from agent_end usage; null when no child reported usage. */
  usage: WorkflowUsage | null;
  errors: number;
  lastKind: string | null;
  lastTs: string | null; // ISO timestamp of the last journal line
  /** Whether at least one structurally valid journal line exists. Older persisted summaries may omit it. */
  hasJournal?: boolean;
  hasResult: boolean; // result.json present (run finished writing a result)
}

// ---------------------------------------------------------------------------
// The line, and the sink a writer appends it through
// ---------------------------------------------------------------------------

export interface WorkflowJournalSink {
  write(line: WorkflowJournalLine): void; // sync append; never throws into the DSL
}

export interface WorkflowChoiceDecision {
  value: string;
  source: "validated" | "fallback";
  returnVia: "text" | "tool";
  attempts?: number;
  reason?: "output-contract-exhausted";
}

export interface WorkflowJournalLine {
  /** Optional project error-index projection, supplied by the journal sink. */
  errorLogPath?: string;
  errorLogWarning?: string;
  journalWarning?: string;
  errorId?: string;
  outputAcceptance?: AgentOutputAcceptance;
  choiceDecision?: WorkflowChoiceDecision;
  ts: string;
  runId: string;
  kind: "phase" | "log" | "group_start" | "group_end" | "agent_queued" | "agent_start" | "agent_end" | "error";
  /** Provenance for log lines. Absent means legacy/unknown and must not be inferred. */
  source?: "script" | "runtime";
  phase?: string;
  message?: string;
  groupId?: string;
  groupKind?: "parallel" | "pipeline";
  groupLabel?: string;
  parentGroupId?: string;
  groupKeys?: readonly string[];
  groupTotal?: number;
  groupCompleted?: number;
  groupFailed?: number;
  /** Explicit child identity. Absent only on legacy journals where `agent` implied named. */
  executionMode?: "bare" | "named";
  agent?: string;
  /** Session-scoped petname captured for fresh agent_end evidence. */
  displayName?: string;
  /** Host-enforced read-only capability boundary for this child. */
  readOnly?: boolean;
  label?: string;
  title?: string;
  itemPath?: readonly string[];
  /** Runtime-owned stable identity for this concrete child attempt. */
  callId?: string;
  answerArtifact?: WorkflowArtifactRef;
  transcriptArtifact?: WorkflowArtifactRef;
  resultEnvelopeArtifact?: WorkflowArtifactRef;
  /** Opaque effective slot key on agent lines; readers compare the whole value and never parse it; absent = no rounds (REQ-009). */
  slotKey?: string;
  /** Loop round (≥1) on agent_end lines (REQ-009); the drill reads past rounds by (slotKey,round). */
  round?: number;
  status?: string;
  /** Machine-readable cause on a non-completed `agent_end`. Absent on old journals and on
   *  every completed call; a reader treats absence as `unclassified`. */
  failureCause?: WorkflowAgentFailureCause;
  /** 1-based PHYSICAL transport attempt within one logical agent() call. Present only on a
   *  call that declared `attempts > 1`, so every journal written before the option is
   *  byte-identical and absence still means "one attempt". */
  attempt?: number;
  /** The declared transport-attempt bound this attempt belongs to. */
  attempts?: number;
  /** Stable identity of the ONE logical `agent()` call this physical attempt belongs to.
   *  Travels with `attempt`/`attempts` and is the only field a reader may group attempts by:
   *  `callId` is per-attempt, and `parallel()` can run two calls that agree on agent, label,
   *  phase and group. */
  logicalCallId?: string;
  evidence?: EvidenceEvaluation;
  evidenceWarnings?: string[];
  /** Runtime-owned child session identity; never parsed from agent text. */
  childSessionId?: string;
  /** Persisted child transcript evidence; never exposed as the DSL return value. */
  childTrace?: WorkflowAgentChildTrace;
  /** Persisted child result artifact path; never exposed as the DSL return value. */
  resultArtifact?: string;
  schemaValidation?: WorkflowSchemaValidation;
  durationMs?: number;
  worktreePath?: string;
  workspaceHandle?: string;
  /** Resolved permission intent for agent_start/agent_end lines. Not a security boundary. */
  permissionMode?: PermissionMode;
  /** Resolved workspace intent for agent_start/agent_end lines. Not a security boundary. */
  workspaceMode?: WorkspaceMode;
  /** Token/cost usage for agent_end lines (present when the child reported usage). */
  usage?: WorkflowUsage;
  /**
   * Resolved model selector for agent live-row display. On `agent_start` this is
   * still an intent — the line is emitted before the bridge resolves anything — so
   * read `requestedModel` there for the honest name and `executedModel` on
   * `agent_end` for what actually ran.
   */
  model?: string;
  /**
   * The selector the call ASKED for, on `agent_start`. Named for what it is: this
   * line is written before any resolution happens, so it structurally cannot know
   * what executed and must not be read as if it did.
   */
  requestedModel?: string;
  /** The tier the call declared, on `agent_start`. A role name, never a provider selector. */
  modelRole?: string;
  /** The call refuses an unassigned declared role instead of inheriting the session model. */
  requireModelRole?: true;
  /**
   * What the child session reported it ran on, read back from the host.
   * `"unavailable"` when the peer exposes no model. Absent on journals written before
   * this field existed — absence is never evidence that a model ran.
   *
   * Carried by `agent_end`, and by the `error` lines emitted AFTER a child returned (a
   * script `validate` that threw, an artifact writer that failed). Never by a line
   * written before dispatch: `agent_start` structurally cannot know it, and a failure
   * that never reached a child has nothing to report.
   */
  executedModel?: string;
  /** With `executedModel`: a declared tier had no assignment and the child inherited the session model. */
  modelRoleFallback?: string;
  /** Child-session thinking/reasoning readback on terminal execution evidence. */
  thinking?: string;
  /** True on agent lines served from a recorded run instead of a fresh child.
   *  False on current terminal agent evidence means fresh execution. On terminal
   *  capability evidence, absence is legacy/unknown and never proves a child ran. */
  replayed?: boolean;
  /** Declared Fusion capability contract. Absent for ordinary agent calls. */
  capabilityMode?: WorkflowFusionMode;
  /** Exact pre-prompt host readback. Never synthesized for replayed calls. */
  activeToolNames?: string[];
  resumeFromRunId?: string;
  resumeSourceRunSummary?: WorkflowRunSummary | null;
  continuation?: WorkflowContinuationJournal;
}

// ---------------------------------------------------------------------------
// The strict line codec
// ---------------------------------------------------------------------------

/**
 * The FIRST reason one already-parsed JSON value cannot be a journal line for `expectedRunId`,
 * or `undefined` when it can. First, not all: the message names one field, so a reader reports
 * what to look at rather than a list to triage.
 */
export function workflowJournalLineProblem(value: unknown, expectedRunId: string): string | undefined {
  if (!isRecord(value)) return "Expected a JSON object.";
  if (typeof value.ts !== "string") return "Field ts must be a string.";
  if (value.runId !== expectedRunId) return `Field runId must equal ${JSON.stringify(expectedRunId)}.`;
  if (
    !isOneOf(value.kind, [
      "phase",
      "log",
      "group_start",
      "group_end",
      "agent_queued",
      "agent_start",
      "agent_end",
      "error",
    ])
  ) {
    return "Field kind is not a supported workflow journal event.";
  }

  const eventKind = value.kind;
  const allowedFields = new Set(["ts", "runId", "kind", ...WORKFLOW_JOURNAL_FIELDS_BY_KIND[eventKind]]);
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    return `Field ${unknownField} is not allowed for ${eventKind} events.`;
  }
  for (const requiredField of WORKFLOW_JOURNAL_REQUIRED_FIELDS_BY_KIND[eventKind]) {
    if (value[requiredField] === undefined) {
      return `Field ${requiredField} is required for ${eventKind} events.`;
    }
  }

  const stringProblem = optionalFieldsProblem(
    value,
    [
      "errorLogPath",
      "errorLogWarning",
      "journalWarning",
      "errorId",
      "phase",
      "message",
      "groupId",
      "groupLabel",
      "parentGroupId",
      "title",
      "executionMode",
      "agent",
      "displayName",
      "label",
      "callId",
      "logicalCallId",
      "slotKey",
      "status",
      "childSessionId",
      "resultArtifact",
      "worktreePath",
      "workspaceHandle",
      "model",
      "requestedModel",
      "modelRole",
      "executedModel",
      "modelRoleFallback",
      "thinking",
      "resumeFromRunId",
      "capabilityMode",
    ],
    "string",
  );
  if (stringProblem !== undefined) return stringProblem;
  if (value.executionMode !== undefined && !isOneOf(value.executionMode, ["bare", "named"])) {
    return "Field executionMode must be bare or named.";
  }
  if (value.executionMode === "bare" && value.agent !== undefined) {
    return "Field agent must be absent when executionMode is bare.";
  }
  if (value.executionMode === "named" && (typeof value.agent !== "string" || value.agent.trim() === "")) {
    return "Field agent must be a non-empty string when executionMode is named.";
  }
  if (
    (eventKind === "agent_queued" || eventKind === "agent_start" || eventKind === "agent_end") &&
    value.executionMode === undefined &&
    (typeof value.agent !== "string" || value.agent.trim() === "")
  ) {
    return `Field agent is required for legacy ${eventKind} events.`;
  }
  if (value.resumeFromRunId !== undefined && !isCanonicalWorkflowRunId(value.resumeFromRunId)) {
    return "Field resumeFromRunId must be a canonical workflow run id.";
  }

  const numberProblem = optionalFieldsProblem(
    value,
    ["groupTotal", "groupCompleted", "groupFailed", "round", "attempt", "attempts", "durationMs"],
    "finite number",
  );
  if (numberProblem !== undefined) return numberProblem;
  if (value.round !== undefined) {
    const round = value.round as number;
    if (!Number.isSafeInteger(round) || round < 1) return "Field round must be a positive safe integer.";
  }
  for (const field of ["attempt", "attempts"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 1)) {
      return `Field ${field} must be a positive safe integer.`;
    }
  }
  // The trio is only meaningful together: a lone ordinal has no bound to read it against,
  // an ordinal past its bound describes an attempt that could not have happened, and an
  // ordinal with no logical call named cannot be grouped with its siblings — a reader
  // falling back to (agent, label, phase, group) would merge two `parallel()` calls that
  // agree on all four and attribute one call's discarded attempt to the other.
  if ((value.attempt === undefined) !== (value.attempts === undefined)) {
    return "Fields attempt and attempts must be present together.";
  }
  if ((value.attempt === undefined) !== (value.logicalCallId === undefined)) {
    return "Fields attempt and logicalCallId must be present together.";
  }
  if (value.attempt !== undefined && (value.attempt as number) > (value.attempts as number)) {
    return "Field attempt must not exceed attempts.";
  }
  for (const field of ["groupTotal", "groupCompleted", "groupFailed", "durationMs"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (fieldValue as number) < 0) return `Field ${field} must not be negative.`;
  }
  for (const field of ["groupTotal", "groupCompleted", "groupFailed"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !Number.isSafeInteger(fieldValue)) {
      return `Field ${field} must be a non-negative safe integer.`;
    }
  }

  const booleanProblem = optionalFieldsProblem(value, ["readOnly", "replayed", "requireModelRole"], "boolean");
  if (booleanProblem !== undefined) return booleanProblem;
  if (value.source !== undefined && !isOneOf(value.source, ["script", "runtime"])) {
    return "Field source must be script or runtime.";
  }
  if (value.groupKind !== undefined && !isOneOf(value.groupKind, ["parallel", "pipeline"])) {
    return "Field groupKind must be parallel or pipeline.";
  }
  if (eventKind === "group_end" && !isOneOf(value.status, ["completed", "failed"])) {
    return "Field status must be completed or failed for group_end events.";
  }
  if (eventKind === "agent_end" && !isOneOf(value.status, ["completed", "failed", "cancelled", "blocked"])) {
    return "Field status is invalid for agent_end events.";
  }
  if (value.failureCause !== undefined && !isOneOf(value.failureCause, AGENT_FAILURE_CAUSE_NAMES)) {
    return "Field failureCause is invalid.";
  }
  if (
    value.permissionMode !== undefined &&
    !isOneOf(value.permissionMode, ["inherit-parent", "agent-defined", "restricted"])
  ) {
    return "Field permissionMode is invalid.";
  }
  if (
    value.workspaceMode !== undefined &&
    !isOneOf(value.workspaceMode, ["project", "worktree", "temporary-worktree"])
  ) {
    return "Field workspaceMode is invalid.";
  }
  if (value.evidenceWarnings !== undefined && !isStringArray(value.evidenceWarnings)) {
    return "Field evidenceWarnings must be an array of strings.";
  }
  for (const field of ["itemPath", "groupKeys"] as const) {
    const values = value[field];
    if (
      values !== undefined &&
      (!isStringArray(values) || values.some((entry) => entry.trim() === "" || /[\p{Cc}]/u.test(entry)))
    ) {
      return `Field ${field} must be an array of non-blank strings without control characters.`;
    }
  }
  if (
    Array.isArray(value.groupKeys) &&
    (value.groupKeys.length !== value.groupTotal || new Set(value.groupKeys).size !== value.groupKeys.length)
  ) {
    return "Field groupKeys must name every group member exactly once.";
  }
  if (value.activeToolNames !== undefined && !isStringArray(value.activeToolNames)) {
    return "Field activeToolNames must be an array of strings.";
  }
  if (value.replayed === true && value.activeToolNames !== undefined) {
    return "Field activeToolNames cannot be present when replayed is true.";
  }
  if (value.capabilityMode !== undefined && !isOneOf(value.capabilityMode, ["tool-free", "agent"])) {
    return "Field capabilityMode must be tool-free or agent.";
  }
  if (value.answerArtifact !== undefined && !isArtifactRef(value.answerArtifact))
    return "Field answerArtifact is invalid.";
  if (value.transcriptArtifact !== undefined && !isArtifactRef(value.transcriptArtifact)) {
    return "Field transcriptArtifact is invalid.";
  }
  if (value.resultEnvelopeArtifact !== undefined && !isArtifactRef(value.resultEnvelopeArtifact)) {
    return "Field resultEnvelopeArtifact is invalid.";
  }
  if (value.childTrace !== undefined && !isChildTrace(value.childTrace)) return "Field childTrace is invalid.";
  if (value.schemaValidation !== undefined && !isSchemaValidation(value.schemaValidation)) {
    return "Field schemaValidation is invalid.";
  }
  if (value.usage !== undefined && !isWorkflowUsage(value.usage)) return "Field usage is invalid.";
  if (value.evidence !== undefined && !isEvidenceEvaluation(value.evidence)) return "Field evidence is invalid.";
  if (
    value.resumeSourceRunSummary !== undefined &&
    value.resumeSourceRunSummary !== null &&
    !isWorkflowRunSummary(value.resumeSourceRunSummary)
  ) {
    return "Field resumeSourceRunSummary is invalid.";
  }
  if (value.outputAcceptance !== undefined) {
    const receipt = value.outputAcceptance;
    if (
      !isRecord(receipt) ||
      Object.keys(receipt).some((key) => !["source", "attempts", "toolName"].includes(key)) ||
      receipt.source !== "tool" ||
      receipt.toolName !== "workflow_return" ||
      !Number.isInteger(receipt.attempts) ||
      (receipt.attempts as number) < 1 ||
      (receipt.attempts as number) > 3
    )
      return "Field outputAcceptance is invalid.";
  }
  if (value.choiceDecision !== undefined) {
    const decision = value.choiceDecision;
    if (
      eventKind !== "log" ||
      value.source !== "runtime" ||
      value.message !== "[workflow:choice]" ||
      !isRecord(decision)
    )
      return "Field choiceDecision requires a canonical runtime choice log.";
    if (
      Object.keys(decision).some((key) => !["value", "source", "returnVia", "attempts", "reason"].includes(key)) ||
      typeof decision.value !== "string" ||
      decision.value.trim() === "" ||
      !["validated", "fallback"].includes(String(decision.source)) ||
      !["text", "tool"].includes(String(decision.returnVia))
    )
      return "Field choiceDecision is invalid.";
    if (
      decision.attempts !== undefined &&
      (!Number.isInteger(decision.attempts) || (decision.attempts as number) < 1 || (decision.attempts as number) > 3)
    )
      return "Choice attempts are invalid.";
    if (
      decision.source === "fallback" ? decision.reason !== "output-contract-exhausted" : decision.reason !== undefined
    )
      return "Choice source/reason disagree.";
  } else if (value.message === "[workflow:choice]" && value.source === "runtime")
    return "Canonical choice log requires choiceDecision.";
  if (value.continuation !== undefined) {
    if (eventKind !== "log" || value.source !== "runtime" || value.message !== "[workflow:continuation]") {
      return "Field continuation is only valid on the canonical runtime continuation log.";
    }
    const continuationProblem = workflowContinuationProblem(value.continuation, expectedRunId);
    if (continuationProblem !== undefined) return continuationProblem;
  } else if (eventKind === "log" && value.message === "[workflow:continuation]") {
    return "Canonical runtime continuation log requires field continuation.";
  }
  return undefined;
}

/**
 * The closed failure-cause list a persisted line is checked against.
 *
 * Read from the one declaration the runtime and the agent envelope also read, so the
 * reader cannot fall behind the writer: a cause added to the list is accepted here the
 * moment it exists, and a second hand-maintained copy can never reject a line the runtime
 * legitimately wrote.
 */
const AGENT_FAILURE_CAUSE_NAMES: readonly WorkflowAgentFailureCause[] = AGENT_FAILURE_CAUSES;

const WORKFLOW_JOURNAL_FIELDS_BY_KIND = {
  phase: ["phase", "groupId", "groupKind", "groupLabel"],
  log: [
    "source",
    "phase",
    "message",
    "resumeFromRunId",
    "resumeSourceRunSummary",
    "continuation",
    "choiceDecision",
    "label",
    "callId",
    "groupId",
    "groupKind",
    "groupLabel",
    "itemPath",
  ],
  group_start: ["phase", "groupId", "groupKind", "groupLabel", "groupTotal", "groupKeys", "parentGroupId"],
  group_end: [
    "phase",
    "message",
    "status",
    "groupId",
    "groupKind",
    "groupLabel",
    "groupTotal",
    "groupCompleted",
    "groupFailed",
    "durationMs",
  ],
  agent_queued: [
    "phase",
    "groupId",
    "groupKind",
    "groupLabel",
    "executionMode",
    "agent",
    "readOnly",
    "label",
    "title",
    "itemPath",
    "callId",
    "attempt",
    "attempts",
    "logicalCallId",
    "slotKey",
    "workspaceHandle",
    "permissionMode",
    "workspaceMode",
    "model",
    "requestedModel",
    "modelRole",
    "requireModelRole",
    "thinking",
    "replayed",
    "capabilityMode",
  ],
  agent_start: [
    "phase",
    "groupId",
    "groupKind",
    "groupLabel",
    "executionMode",
    "agent",
    "readOnly",
    "label",
    "title",
    "itemPath",
    "callId",
    "attempt",
    "attempts",
    "logicalCallId",
    "slotKey",
    "workspaceHandle",
    "permissionMode",
    "workspaceMode",
    "model",
    "requestedModel",
    "modelRole",
    "requireModelRole",
    "thinking",
    "replayed",
    "capabilityMode",
  ],
  agent_end: [
    "message",
    "errorLogPath",
    "errorLogWarning",
    "journalWarning",
    "errorId",
    "phase",
    "groupId",
    "groupKind",
    "groupLabel",
    "executionMode",
    "agent",
    "displayName",
    "readOnly",
    "label",
    "title",
    "itemPath",
    "callId",
    "attempt",
    "attempts",
    "logicalCallId",
    "answerArtifact",
    "transcriptArtifact",
    "resultEnvelopeArtifact",
    "slotKey",
    "round",
    "status",
    "failureCause",
    "evidence",
    "evidenceWarnings",
    "childSessionId",
    "childTrace",
    "resultArtifact",
    "schemaValidation",
    "outputAcceptance",
    "durationMs",
    "worktreePath",
    "workspaceHandle",
    "permissionMode",
    "workspaceMode",
    "usage",
    "model",
    "executedModel",
    "modelRoleFallback",
    "thinking",
    "replayed",
    "capabilityMode",
    "activeToolNames",
  ],
  error: [
    "errorLogPath",
    "errorLogWarning",
    "journalWarning",
    "errorId",
    "source",
    "phase",
    "message",
    "groupId",
    "groupKind",
    "groupLabel",
    "executionMode",
    "agent",
    "label",
    "title",
    "itemPath",
    "callId",
    // A failure that THREW never reaches an agent_end, so this line is the call's terminal
    // record and the only place its declared cause — and its place in a retry sequence —
    // can be read without parsing prose. The trio is validated as a trio for every kind,
    // so an ordinal here is still refused without its bound and its logical call.
    "failureCause",
    "attempt",
    "attempts",
    "logicalCallId",
    "durationMs",
    "model",
    "executedModel",
    "modelRoleFallback",
    "thinking",
    "replayed",
    "capabilityMode",
    "activeToolNames",
    // Post-child script/artifact failures use `error` as the sole terminal line.
    // The child already ran, so its usage belongs here just as it does on agent_end.
    "usage",
    "resumeFromRunId",
    "resumeSourceRunSummary",
  ],
} as const satisfies Record<WorkflowJournalLine["kind"], readonly string[]>;

const WORKFLOW_JOURNAL_REQUIRED_FIELDS_BY_KIND = {
  phase: ["phase"],
  log: ["message"],
  group_start: ["groupId", "groupKind", "groupTotal"],
  group_end: ["groupId", "groupKind", "groupTotal", "groupCompleted", "groupFailed", "status"],
  // callId was added after the first persisted journals. Keep those explicit
  // legacy rows readable, while still requiring an agent identity.
  agent_queued: ["callId"],
  agent_start: [],
  agent_end: ["status"],
  error: ["message"],
} as const satisfies Record<WorkflowJournalLine["kind"], readonly string[]>;

function optionalFieldsProblem(
  value: Record<string, unknown>,
  fields: readonly string[],
  expected: "string" | "boolean" | "finite number",
): string | undefined {
  for (const field of fields) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    const valid =
      expected === "string"
        ? typeof fieldValue === "string"
        : expected === "boolean"
          ? typeof fieldValue === "boolean"
          : typeof fieldValue === "number" && Number.isFinite(fieldValue);
    if (!valid) return `Field ${field} must be ${expected}.`;
  }
  return undefined;
}

/** A plain JSON object — not null, not an array. Exported so the storage half reads a
 *  persisted sidecar with the same predicate a journal line is read with. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The four-field artifact identity a line may carry, held to the same component and display
 *  name confinement the writer applies. Exported for the persisted-binding refs alongside it. */
export function isArtifactRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ["runId", "artifactId", "name", "sha256"].includes(key)) &&
    Object.keys(value).length === 4 &&
    typeof value.runId === "string" &&
    typeof value.artifactId === "string" &&
    typeof value.name === "string" &&
    typeof value.sha256 === "string" &&
    WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.runId) &&
    WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.artifactId) &&
    // `name` is the author's DISPLAY label and `artifactId` is the storage id: the
    // reader holds the name to the same confinement rule the writer applies and to no
    // alphabet or length policy, so a published `Design review.md` stays a readable
    // reference here instead of failing the validator that never wrote it.
    isWorkflowArtifactDisplayName(value.name) &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  );
}

function workflowContinuationProblem(value: unknown, currentRunId: string): string | undefined {
  if (!isRecord(value)) return "Field continuation must be an object.";
  if (!hasExactFields(value, ["originRunId", "artifacts"])) {
    return "Field continuation must contain only originRunId and artifacts.";
  }
  if (typeof value.originRunId !== "string" || !WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.originRunId)) {
    return "Field continuation.originRunId is invalid.";
  }
  // At least one pair, and no upper bound: the record describes what the origin run
  // produced, and a ninth complete pair is evidence, not an overflow.
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1) {
    return "Field continuation.artifacts must contain at least one pair.";
  }
  const identities = new Set<string>();
  for (const pair of value.artifacts) {
    if (!isRecord(pair) || !hasExactFields(pair, ["sourceRef", "consumedRef"])) {
      return "Each continuation artifact must contain only sourceRef and consumedRef.";
    }
    if (!isArtifactRef(pair.sourceRef) || !isArtifactRef(pair.consumedRef)) {
      return "Continuation artifact refs are invalid.";
    }
    const sourceRef = pair.sourceRef as WorkflowArtifactRef;
    const consumedRef = pair.consumedRef as WorkflowArtifactRef;
    if (sourceRef.runId !== value.originRunId) {
      return "Continuation sourceRef does not belong to originRunId.";
    }
    if (consumedRef.runId !== currentRunId) {
      return "Continuation consumedRef does not belong to the current run.";
    }
    if (consumedRef.name !== sourceRef.name || consumedRef.sha256 !== sourceRef.sha256) {
      return "Continuation consumedRef must preserve the sourceRef name and sha256.";
    }
    const identity = `${sourceRef.runId}\u001f${sourceRef.artifactId}`;
    if (identities.has(identity)) return "Continuation contains a duplicate source artifact identity.";
    identities.add(identity);
  }
  return undefined;
}

/** Exactly these keys and no others — the closed-set check a nested payload is held to. */
export function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isChildTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.format === "pi-session-jsonl" &&
    typeof value.childSessionId === "string"
  );
}

function isSchemaValidation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.status, ["valid", "mismatch"]) &&
    typeof value.attempts === "number" &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    isStringArray(value.errors) &&
    // Which authority rejected the answer. Absent on every line written before the
    // script-validation callback existed, and on every schema-only call since.
    (value.source === undefined || isOneOf(value.source, ["schema", "script"])) &&
    // How an exact-choice answer was read. Absent on every answer that validated as
    // written, and on every line written before the lenient readings existed.
    (value.coercion === undefined || isOneOf(value.coercion, ["bare-text", "wrapper-object"]))
  );
}

function isWorkflowUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  // `costTotal` is optional: absent means the price is unknown. A historical record
  // that carries the old hardcoded number is still valid, so both shapes read.
  if (value.costTotal !== undefined && !(typeof value.costTotal === "number" && Number.isFinite(value.costTotal)))
    return false;
  return [value.input, value.output, value.totalTokens].every(
    (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
  );
}

function isEvidenceEvaluation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.evidence, [
      "reasoning_only",
      "evidence_backed",
      "missing_expected_evidence",
      "claims_without_evidence",
    ]) &&
    isStringArray(value.warnings) &&
    isStringArray(value.missingRequiredTools) &&
    isStringArray(value.observedTools)
  );
}

function isWorkflowRunSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isCanonicalWorkflowRunId(value.runId) &&
    isOneOf(value.status, ["running", "completed", "awaiting_operator", "cancelled", "failed", "unknown"]) &&
    (value.phase === null || typeof value.phase === "string") &&
    [value.agentsStarted, value.agentsEnded, value.agentsReplayed, value.errors].every(
      (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
    ) &&
    (value.usage === null || isWorkflowUsage(value.usage)) &&
    (value.lastKind === null || typeof value.lastKind === "string") &&
    (value.lastTs === null || typeof value.lastTs === "string") &&
    (value.hasJournal === undefined || typeof value.hasJournal === "boolean") &&
    typeof value.hasResult === "boolean"
  );
}

function isCanonicalWorkflowRunId(value: unknown): value is string {
  try {
    assertWorkflowRunId(value);
    return true;
  } catch {
    return false;
  }
}
