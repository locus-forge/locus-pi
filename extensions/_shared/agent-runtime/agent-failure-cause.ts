/**
 * extensions/_shared/agent-runtime/agent-failure-cause.ts — the closed, machine-readable
 * origin of a child run that did not complete.
 *
 * `status` is a four-way split, not a cause: SDK-unavailable arrives as `blocked`,
 * operator cancellation as `cancelled`, and a turn timeout, a tool-call budget breach,
 * a provider error and any mid-turn throw all collapse into one `failed` plus an English
 * sentence. A caller that wants to tell those apart today has to match on that sentence —
 * the prose-scanning move `extensions/workflows/references/patterns.md` forbids, and one
 * that starts misbehaving the day someone rewords a message.
 *
 * So the cause is declared where it is KNOWN and carried, never re-derived downstream.
 * The list is closed on purpose: `unclassified` is the honest answer for a catch-all that
 * has not been separately shown to be transient, and for any result written before this
 * field existed. Nothing retries on `unclassified`.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF THE AGENT ENVELOPE
 *
 * `agent-runner.ts` is the envelope that first carries the cause and reads like its owner,
 * and it re-exports both symbols below for exactly that reason. It may not DEFINE them:
 * it imports `node:crypto`, while three modules need the closed list as a VALUE and one of
 * them — `extensions/workflows/runtime/workflow-runtime.ts`, the host-agnostic workflow
 * core — must not pull in anything that reaches for `node:`. This module therefore has no
 * imports at all, which is the property that keeps the workflow core host-agnostic while
 * still validating against one list rather than a second copy of it. Keep it that way: a
 * single import here would be enough to break the core's isolation.
 */
export const AGENT_FAILURE_CAUSES = [
  /** The host's own turn budget expired and the child was aborted mid-answer. TRANSPORT. */
  "host-turn-timeout",
  /** The per-call wall-clock fuse expired and the child was aborted. TRANSPORT. */
  "call-timeout",
  /** A stage declared `ask: true` but the parent session cannot mount an operator
   *  question (no UI / non-interactive mode). Fail-closed refusal declared by the
   *  workflow bridge, never an error string left in the child's context. TRANSPORT. */
  "ask-unavailable",
  /** The operator answered, but the workflow could not durably index that answer.
   *  The child is aborted before the answer can re-enter model context. Re-asking
   *  could duplicate one human decision, so this cause is never retried. */
  "ask-evidence-persistence",
  /** The agent SDK substrate is unavailable — there is no channel to re-ask on. */
  "sdk-unavailable",
  /** Operator or run-level cancellation. Re-asking would override the operator. */
  "cancelled",
  /** The child exhausted its tool-call budget. A fuse that re-arms is not a fuse. */
  "tool-call-budget",
  /** The provider ended the child's assistant turn with an error. */
  "provider-error",
  /** The child answered and the boundary could not parse its final text. */
  "unparseable-answer",
  /** Opt-in output submission exhausted; never a transport retry. */
  "output-contract-exhausted",
  // A second, different proposal is a protocol conflict, not a format fallback.
  "output-contract-conflict",
  /** Host cannot enforce the requested same-session output boundary. */
  "output-contract-unavailable",
  /** Cumulative assistant turns across output clarifications exceeded the declared cap. */
  "assistant-turn-budget",
  /** The run request was refused before any child existed (policy, no executor). */
  "run-policy-blocked",
  /** The requested catalog agent does not exist. An author error, not a transport one. */
  "unknown-agent",
  /** A workspace or worktree could not be allocated or resolved. */
  "workspace-allocation",
  /** The child completed with empty final text — a decomposition signal, not a dropped channel. */
  "empty-answer",
  /** HISTORICAL. The child answered past the call's declared `maxAnswerChars` bound.
   *  Nothing produces it any more — the runtime owns no answer-size policy — but the
   *  list stays closed over it so a journal or result written before that removal still
   *  validates and stays readable instead of degrading to `unclassified`. */
  "answer-too-long",
  /** A replayed answer the CURRENT workflow script validator rejects. */
  "script-rejected",
  /** Cause not separately identified. NEVER retried; promoting a cause out of here is
   *  its own evidenced change, not a widening of the default. */
  "unclassified",
] as const;

export type AgentFailureCause = (typeof AGENT_FAILURE_CAUSES)[number];
