import {
  normalizeWorkflowStructuredContract,
  immutableJSON,
  type WorkflowJSONValue,
} from "./structured-results/schema.js";
import { createWorkflowStructuredCall, type WorkflowStructuredSourceIdentity } from "./structured-results/return.js";
/**
 * workflow-agent-output.ts — the RESULT-MODE owner of one `agent()` call.
 *
 * This module dispatches plain text, exact choice v3, and opt-in structured v4.
 * Structured declarations are normalized once before the logical call; committed values come only
 * from the child's immutable receipt. Each protocol owner supplies same-session
 * acceptance without parsing narrative text or creating a second logical call.
 *
 * The declaration side is pure and exported as plain functions; the acceptance side needs
 * the run's journal fan-out and the logical call, so it is a small factory over named
 * ports rather than a context bag. It never owns an SDK session: it hands one prompt to
 * the injected `runAgentAttempt` and reads the outcome that comes back.
 *
 * Direction: `workflow-runtime.ts` -> here -> `workflow-agent-contract.ts` /
 * `workflow-return.ts`. This module never imports the composition root. Pure
 * host-agnostic: no fs / process / network, so rule 7 of
 * `scripts/check-extension-layers.ts` holds it inside the DSL core's value closure.
 */

import {
  DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS,
  normalizeWorkflowReturnContract,
  workflowReturnClarificationTurns,
  workflowReturnInstructions,
  workflowReturnValueError,
} from "./workflow-return.js";
import {
  SchemaValidationError,
  WorkflowAgentExecutionError,
  WORKFLOW_RETURN_CONTRACT,
  WORKFLOW_STRUCTURED_CALL,
  type WorkflowAgentStructuredOptions,
  type AgentAttemptOutcome,
  type AgentSchemaCheck,
  type WorkflowAgentAnyOptions,
  type WorkflowAgentChoiceOptions,
  type WorkflowInternalAgentOptions,
} from "./workflow-agent-contract.js";
import type { WorkflowGroupBranchView } from "./workflow-groups.js";
import type { WorkflowChoiceDecision, WorkflowJournalLine } from "./workflow-journal-format.js";

// ---------------------------------------------------------------------------
// Declaration checks (pure)
// ---------------------------------------------------------------------------

/** The file/text-first replacement every removed shaped-result option points to. */
const FILE_TEXT_MIGRATION =
  "have the agent write at the exact caller-assigned file destination in its prompt and return readable text, pass caller-owned work units through items(), " +
  "or branch on choice: [...] when workflow source needs one exact token";

/**
 * Options this runtime REMOVED, named at declaration time with their replacement.
 *
 * Refused before the replay lookup and before any child exists, so a fresh run and a
 * resumed run whose source still declares one fail with the same sentence, and an old
 * shaped receipt is never reinterpreted under the reduced contract. Ignoring an option
 * would leave its author believing a model-produced value is still being checked.
 *
 * A declaration is the key, not its value: `{ ...legacy, output: undefined }` still
 * declares `output`, so presence is tested with `Object.hasOwn` rather than `!== undefined`.
 */
const REMOVED_AGENT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  handoffs: `agent handoffs was removed: an agent no longer returns a runtime list. Instead, ${FILE_TEXT_MIGRATION}`,
  output:
    "agent output was removed: a plain agent(prompt) call already returns the exact full text. " +
    "Drop the option, or use choice: [...] when workflow source needs one exact token",
  returnVia:
    "agent returnVia was removed: a choice call always returns through workflow_return and a plain call returns exact text. " +
    "Drop the option",
  maxAnswerChars:
    "agent maxAnswerChars was removed: the runtime no longer rejects an answer for its size. " +
    "State a length requirement in the prompt instead",
  schemaMaxLength:
    "agent schemaMaxLength was removed: use schema string minLength/maxLength in trusted v4 source instead. Drop the legacy option",
});

/** Both source-check profiles retain their existing grammar; v4 is trusted-runtime-only. */
export const REMOVED_AGENT_OPTION_NAMES: readonly string[] = Object.freeze([
  ...Object.keys(REMOVED_AGENT_OPTIONS),
  "schema",
  "validate",
  "repair",
]);

export function assertNoRemovedAgentOptions(opts: unknown, scope = "agent"): void {
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) return;
  if (scope !== "agent")
    for (const key of ["schema", "validate", "repair"])
      if (Object.hasOwn(opts, key)) throw new Error(`${scope}: agent ${key} was removed from Fusion limits`);
  for (const [key, message] of Object.entries(REMOVED_AGENT_OPTIONS)) {
    if (Object.hasOwn(opts, key)) throw new Error(scope === "agent" ? message : `${scope}: ${message}`);
  }
}

/**
 * A routing contract needs at least two branches to be a decision. What stays is what the
 * CONSUMER needs: a non-blank, unambiguous set whose membership can be checked, because a
 * choice must name a branch that exists.
 */
const MIN_AGENT_CHOICES = 2;

export function normalizeAgentChoices(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("agent choice must be an array of strings");
  if (value.length < MIN_AGENT_CHOICES) {
    throw new Error(`agent choice must contain at least ${MIN_AGENT_CHOICES} values`);
  }
  const seen = new Set<string>();
  for (const [index, member] of value.entries()) {
    if (typeof member !== "string" || member.trim() === "") {
      throw new Error(`agent choice value at index ${index} must be a non-empty string`);
    }
    if (seen.has(member)) throw new Error(`agent choice contains duplicate value ${JSON.stringify(member)}`);
    seen.add(member);
  }
  return value as readonly string[];
}

export function normalizeAgentChoiceFallback(value: unknown, choices: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("agent choiceFallback must be a string");
  if (!choices.includes(value)) throw new Error("agent choiceFallback must be one of the declared choices");
  return value;
}

// ---------------------------------------------------------------------------
// The acceptance side
// ---------------------------------------------------------------------------

/** The narrow ports the choice path needs. Each is a named capability the composition
 *  root already owns; none of them is an SDK session. */
export interface WorkflowAgentOutputDeps {
  readonly runId: string;
  readonly structuredReplayHostVersion?: () => Promise<string | undefined>;
  readonly structuredSourceIdentity?: WorkflowStructuredSourceIdentity;
  readonly now: () => string;
  /** The runtime's one journal fan-out (mirror + sink + progress callback). */
  readonly emit: (line: WorkflowJournalLine) => void;
  /** Branch phase when a branch is running, the run phase otherwise. */
  readonly currentPhase: () => string | undefined;
  /** Read-only branch identity, for the item path a choice decision is journalled under. */
  readonly branchContext: () => WorkflowGroupBranchView | undefined;
  /** Group correlation fields for any journal line emitted inside a group. */
  readonly activeGroupFields: () => Pick<WorkflowJournalLine, "groupId" | "groupKind" | "groupLabel">;
  /** ONE logical call. The choice path drives it exactly once and reads its outcome. */
  readonly runAgentAttempt: (
    prompt: string,
    opts: WorkflowInternalAgentOptions | undefined,
    checkSchema?: (text: string) => AgentSchemaCheck,
  ) => Promise<AgentAttemptOutcome>;
}

export interface WorkflowAgentOutput {
  /** Which result mode one `agent()` declaration takes, and every refusal that fires first. */
  dispatchWorkflowAgentShape(opts: WorkflowAgentAnyOptions | undefined): "plain" | "choice" | "structured";
  /** THE choice path: one child session, one acceptance, one exact declared string. */
  runChoiceAgent(prompt: string, opts: WorkflowAgentChoiceOptions): Promise<string>;
  runStructuredAgent(prompt: string, opts: WorkflowAgentStructuredOptions): Promise<WorkflowJSONValue>;
}

export function createWorkflowAgentOutput(deps: WorkflowAgentOutputDeps): WorkflowAgentOutput {
  const { runId, emit, runAgentAttempt } = deps;
  const nowFn = deps.now;
  const currentPhase = deps.currentPhase;

  /**
   * Declaration dispatch for one `agent()` call: removed options first, then the
   * `result: "report"` exclusivity, then the mode itself. Everything here runs before the
   * logical call opens, so a refusal costs neither a replay ordinal nor an invocation.
   */
  function dispatchWorkflowAgentShape(opts: WorkflowAgentAnyOptions | undefined): "plain" | "choice" | "structured" {
    assertNoRemovedAgentOptions(opts);
    if (opts !== undefined && Object.hasOwn(opts, "schema")) {
      for (const key of ["choice", "choiceFallback", "result"] as const)
        if (Object.hasOwn(opts, key)) throw new Error(`agent schema cannot be combined with ${key}`);
      if (Object.hasOwn(opts, "validate") && typeof opts.validate !== "function")
        throw new Error("agent validate must be a synchronous function");
      return "structured";
    }
    if (opts !== undefined)
      for (const key of ["validate", "repair"] as const)
        if (Object.hasOwn(opts, key)) throw new Error(`agent ${key} requires schema`);
    if (opts?.result !== undefined) {
      if (opts.result !== "report") throw new Error("agent result must be report when supplied");
      for (const key of ["choice", "choiceFallback"] as const) {
        if (opts[key] !== undefined) throw new Error(`agent result: report cannot be combined with ${key}`);
      }
    }
    if (opts?.choice !== undefined) return "choice";
    if (opts?.choiceFallback !== undefined) throw new Error("agent choiceFallback requires choice");
    return "plain";
  }

  /** The choice DECISION projection, journalled on the canonical runtime log line. */
  function recordChoiceDecision(
    opts: WorkflowAgentChoiceOptions,
    decision: WorkflowChoiceDecision,
    callId?: string,
  ): void {
    const context = deps.branchContext();
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:choice]",
      choiceDecision: decision,
      ...(opts.label === undefined ? {} : { label: opts.label }),
      ...(callId === undefined ? {} : { callId }),
      ...(currentPhase() === undefined ? {} : { phase: currentPhase()! }),
      ...deps.activeGroupFields(),
      ...(context?.hasBusinessKeys ? { itemPath: [...context.memberPath] } : {}),
    });
  }

  /**
   * THE choice path: one child session, one acceptance, no second dialect.
   *
   * The declared members become a choice-only return contract. It is stated in the prompt
   * and enforced by the `workflow_return` tool INSIDE the child's session, so a rejected
   * proposal comes back to the agent that produced it, with its evidence still in context.
   * `choiceFallback` is spent only when that bounded correction is exhausted — never on a
   * cancellation, provider failure or budget stop.
   */
  async function runChoiceAgent(prompt: string, opts: WorkflowAgentChoiceOptions): Promise<string> {
    const choices = normalizeAgentChoices(opts.choice);
    const fallback = normalizeAgentChoiceFallback(opts.choiceFallback, choices);
    const contract = normalizeWorkflowReturnContract({ choices });
    // The correction allowance is a real execution decision, so it is in the journal as
    // well as in the contract the child is shown: a default nobody can see is a hidden policy.
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        `[workflow:return] ${opts.label ?? "agent"}: contract v${String(contract.version)}, ` +
        `${String(workflowReturnClarificationTurns(contract))} same-session clarification turn(s) ` +
        `(package default ${String(DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS)})`,
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
    try {
      const outcome = await runAgentAttempt(
        `${prompt}\n\n${workflowReturnInstructions(contract)}`,
        { ...opts, [WORKFLOW_RETURN_CONTRACT]: contract },
        (text) => {
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            return {
              validation: { status: "mismatch", attempts: 1, errors: ["accepted output is not canonical JSON"] },
            };
          }
          const error = workflowReturnValueError(value, contract);
          if (error !== undefined) return { validation: { status: "mismatch", attempts: 1, errors: [error] } };
          return { value, validation: { status: "valid", attempts: 1, errors: [] } };
        },
      );
      // Accepted ONLY from the confirmed receipt the logical call carries back in
      // `schemaCheck`: an answer that never reached `workflow_return` has no verdict here
      // and fails closed. Nothing in this module reads the child's final text.
      if (outcome.schemaCheck?.validation.status !== "valid" || typeof outcome.schemaCheck.value !== "string")
        throw new SchemaValidationError(outcome.schemaCheck?.validation.errors ?? ["missing output validation"], 1);
      const value = outcome.schemaCheck.value;
      recordChoiceDecision(
        opts,
        {
          value,
          source: "validated",
          returnVia: "tool",
          ...(outcome.outputAcceptance === undefined ? {} : { attempts: outcome.outputAcceptance.attempts }),
        },
        outcome.callId,
      );
      return value;
    } catch (error) {
      // Cancellation, provider/auth failures and budgets NEVER become a classifier decision.
      if (
        fallback === undefined ||
        !(error instanceof WorkflowAgentExecutionError) ||
        error.result.failureCause !== "output-contract-exhausted"
      )
        throw error;
      recordChoiceDecision(opts, {
        value: fallback,
        source: "fallback",
        returnVia: "tool",
        attempts: contract.maxAttempts,
        reason: "output-contract-exhausted",
      });
      return fallback;
    }
  }

  async function runStructuredAgent(prompt: string, opts: WorkflowAgentStructuredOptions): Promise<WorkflowJSONValue> {
    const contract = normalizeWorkflowStructuredContract(opts.schema, opts.repair);
    const call = createWorkflowStructuredCall(
      contract,
      opts.validate,
      deps.structuredSourceIdentity,
      deps.structuredReplayHostVersion,
    );
    const outcome = await runAgentAttempt(prompt, {
      ...opts,
      [WORKFLOW_RETURN_CONTRACT]: contract,
      [WORKFLOW_STRUCTURED_CALL]: call,
    });
    if (outcome.outputAcceptance?.structuredReceipt === undefined)
      throw new Error("output-contract-unavailable: no committed v4 receipt");
    return immutableJSON(outcome.outputAcceptance.structuredReceipt.value);
  }
  return { dispatchWorkflowAgentShape, runChoiceAgent, runStructuredAgent };
}
