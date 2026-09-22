/**
 * workflow-agent-output.ts — the SHAPED-OUTPUT owner of one `agent()` call.
 *
 * Everything that turns a `choice` / `handoffs` / `schema` / `output` / `validate`
 * declaration into a request, and everything that decides whether a shaped answer was
 * ACCEPTED, lives here. That is one concern with one rule behind it: a shaped value is
 * accepted from the confirmed `workflow_return` receipt of the child's own session and
 * from nothing else. There is no text parsing here, no second acceptance dialect, and no
 * repair session — the same-session clarification loop is owned by `workflow-return.ts`,
 * which this module reaches only to build the contract the child is shown.
 *
 * The declaration side is pure and exported as plain functions; the acceptance side needs
 * the run's journal fan-out and the logical call, so it is a small factory over named
 * ports rather than a context bag. It never owns an SDK session: it hands one prompt to
 * the injected `runAgentAttempt` and reads the outcome that comes back.
 *
 * Direction: `workflow-runtime.ts` -> here -> `workflow-agent-contract.ts` /
 * `workflow-return.ts` / `workflow-schema.ts`. This module never imports the composition
 * root. Pure host-agnostic: no fs / process / network, so rule 7 of
 * `scripts/check-extension-layers.ts` holds it inside the DSL core's value closure.
 */

import {
  DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS,
  assertWorkflowReturnValidationErrors,
  normalizeWorkflowReturnContract,
  workflowReturnClarificationTurns,
  workflowReturnInstructions,
  workflowReturnValueError,
  type WorkflowReturnValidate,
} from "./workflow-return.js";
import { isRecord } from "./workflow-schema.js";
import {
  SchemaValidationError,
  WorkflowAgentExecutionError,
  WORKFLOW_RETURN_CONTRACT,
  WORKFLOW_RETURN_VALIDATE,
  type AgentAttemptOutcome,
  type AgentSchemaCheck,
  type WorkflowAgentAnyOptions,
  type WorkflowAgentHandoffBounds,
  type WorkflowAgentSchemaOptions,
  type WorkflowInternalAgentOptions,
} from "./workflow-agent-contract.js";
import type { WorkflowGroupBranchView } from "./workflow-groups.js";
import type { WorkflowChoiceDecision, WorkflowJournalLine } from "./workflow-journal-format.js";

// ---------------------------------------------------------------------------
// Declaration checks (pure)
// ---------------------------------------------------------------------------

/**
 * Options this runtime REMOVED, named at declaration time with their replacement.
 *
 * Ignoring one would leave an author believing a bound is applied; the whole point of
 * removing the runtime's size policy is that a size decision now has a visible owner.
 * A `maxAnswerChars` author wanted a CONSUMER contract — express it as `output.maxLength`
 * on a shaped call, or as `maxLength`/`maxItems` inside the schema, where the child is
 * told about the violation and can correct it.
 */
const REMOVED_AGENT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  maxAnswerChars:
    "agent maxAnswerChars was removed: the runtime no longer rejects an answer for its size. " +
    "Declare a real consumer contract instead — output.maxLength for a string return, or maxLength/maxItems inside a schema",
  // Silently dropped while assembling the return contract until this refusal existed, so
  // an author who wrote it read a bound into a call that had none.
  schemaMaxLength:
    "agent schemaMaxLength was removed: the runtime no longer clamps a shaped answer to a package number. " +
    "Declare the consumer contract instead — maxLength/maxItems inside the schema itself, or output.maxLength for a string return",
});

export function assertNoRemovedAgentOptions(opts: unknown, scope = "agent"): void {
  if (!isRecord(opts)) return;
  for (const [key, message] of Object.entries(REMOVED_AGENT_OPTIONS)) {
    if (opts[key] !== undefined) throw new Error(scope === "agent" ? message : `${scope}: ${message}`);
  }
}

/**
 * Declaration checks for a shaped call, now the only shaped path.
 *
 * `validate` is no longer refused: it runs inside the child's own session beside the
 * schema check, so a cross-field violation is a correctable clarification instead of a
 * fresh child that has forgotten everything. Transport `attempts` is no longer refused
 * either — a same-session clarification is not a physical retry, so the two no longer
 * multiply; the ordinary worktree refusal below still applies.
 */
export function assertWorkflowToolReturnOptions(options: WorkflowAgentAnyOptions): void {
  const { schema, validate, handoffs, choice, output } = options as {
    schema?: unknown;
    validate?: unknown;
    handoffs?: unknown;
    choice?: unknown;
    output?: unknown;
  };
  if (validate !== undefined && typeof validate !== "function") throw new Error("agent validate must be a function");
  if (validate !== undefined && schema === undefined && handoffs === undefined)
    throw new Error("agent validate requires a schema or handoffs");
  // Named pairwise, before the contract's generic "exactly one shape" message, so an author
  // who combined two shapes reads WHICH two rather than a count.
  if (schema !== undefined && handoffs !== undefined) throw new Error("agent handoffs cannot be combined with schema");
  if (choice !== undefined && handoffs !== undefined) throw new Error("agent choice cannot be combined with handoffs");
  if (choice !== undefined && schema !== undefined) throw new Error("agent choice cannot be combined with schema");
  if (output !== undefined && (choice !== undefined || schema !== undefined || handoffs !== undefined))
    throw new Error("agent output is a string-only contract and cannot be combined with choice, schema or handoffs");
}

/**
 * A routing contract needs at least two branches to be a decision. Everything else the
 * old bound said — at most 32 members, at most 200 characters each — was a size policy
 * over an `enum` the provider has no practical trouble carrying, so it is gone. What
 * stays is what the CONSUMER needs: a non-blank, unambiguous set whose membership can
 * be checked, because a choice must name a branch that exists.
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

/**
 * Handoff bounds after the size policy was removed.
 *
 * `maxItems` is now OPTIONAL and has no ceiling: a discovery stage cannot know in
 * advance how many work units exist, and refusing the 101st one is a refusal to accept
 * work that was already done. `maxItemChars` is gone entirely — a complete brief is
 * exactly as long as it needs to be, and the 8 000-character default is what truncated
 * real queues. `minItems` stays, because "at least one unit or this stage failed" is a
 * statement about the WORK, not about its size.
 *
 * Uniqueness-after-trim is gone too: two items whose text happens to match after
 * trimming are not proof of duplicated work, and deduplicating author data silently
 * loses a unit. Blank items are still refused — an empty string is not a work unit.
 */
export function normalizeAgentHandoffs(value: unknown): WorkflowAgentHandoffBounds {
  if (!isRecord(value)) throw new Error("agent handoffs must be an object");
  for (const key of Object.keys(value)) {
    if (key === "maxItemChars")
      throw new Error(
        "agent handoffs maxItemChars was removed: a complete handoff is accepted at any length. " +
          "Declare a real consumer bound with a schema if the next stage genuinely needs one",
      );
    if (!["minItems", "maxItems"].includes(key)) throw new Error(`agent handoffs has no option ${key}`);
  }
  const minItems = value.minItems ?? 0;
  const maxItems = value.maxItems;
  if (!Number.isSafeInteger(minItems) || (minItems as number) < 0) {
    throw new Error("agent handoffs minItems must be a non-negative safe integer");
  }
  if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || (maxItems as number) < 1)) {
    throw new Error("agent handoffs maxItems must be a positive safe integer when declared");
  }
  if (maxItems !== undefined && (minItems as number) > (maxItems as number)) {
    throw new Error("agent handoffs minItems cannot exceed maxItems");
  }
  return {
    minItems: minItems as number,
    ...(maxItems === undefined ? {} : { maxItems: maxItems as number }),
  };
}

/** The one array shape handoffs desugar to. It carries the author's declared bounds and
 *  nothing the runtime invented. */
export function handoffsSchema(bounds: WorkflowAgentHandoffBounds): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "string", minLength: 1, nonBlank: true },
    minItems: bounds.minItems ?? 0,
    ...(bounds.maxItems === undefined ? {} : { maxItems: bounds.maxItems }),
  };
}

// ---------------------------------------------------------------------------
// The acceptance side
// ---------------------------------------------------------------------------

/** The narrow ports the shaped path needs. Each is a named capability the composition
 *  root already owns; none of them is an SDK session. */
export interface WorkflowAgentOutputDeps {
  readonly runId: string;
  readonly now: () => string;
  /** The runtime's one journal fan-out (mirror + sink + progress callback). */
  readonly emit: (line: WorkflowJournalLine) => void;
  /** Branch phase when a branch is running, the run phase otherwise. */
  readonly currentPhase: () => string | undefined;
  /** Read-only branch identity, for the item path a choice decision is journalled under. */
  readonly branchContext: () => WorkflowGroupBranchView | undefined;
  /** Group correlation fields for any journal line emitted inside a group. */
  readonly activeGroupFields: () => Pick<WorkflowJournalLine, "groupId" | "groupKind" | "groupLabel">;
  /** Runs a script-declared `validate` behind the runtime's re-entrancy latch: a validator
   *  that called back into the DSL would open a second execution inside an acceptance. */
  readonly runScriptValidate: <T>(run: () => T) => T;
  /** ONE logical call. The shaped path drives it exactly once and reads its outcome. */
  readonly runAgentAttempt: (
    prompt: string,
    opts: WorkflowInternalAgentOptions | undefined,
    checkSchema?: (text: string) => AgentSchemaCheck,
  ) => Promise<AgentAttemptOutcome>;
}

export interface WorkflowAgentOutput {
  /** Which path one `agent()` declaration takes, and every refusal that fires first. */
  dispatchWorkflowAgentShape(opts: WorkflowAgentAnyOptions | undefined): "plain" | "shaped";
  /** THE structured path: one child session, one acceptance, no second dialect. */
  runShapedAgent(prompt: string, opts: WorkflowAgentAnyOptions): Promise<unknown>;
}

export function createWorkflowAgentOutput(deps: WorkflowAgentOutputDeps): WorkflowAgentOutput {
  const { runId, emit, runAgentAttempt } = deps;
  const nowFn = deps.now;
  const currentPhase = deps.currentPhase;

  /**
   * The one place `returnVia` is still read.
   *
   * `"tool"` describes what every shaped call now does, so it is accepted and reported as
   * redundant for one release rather than failing an existing source. `"text"` named the
   * deleted transport: accepting it would silently give the author the tool path under a
   * name that promises text parsing, so it is refused by name.
   */
  function assertWorkflowReturnVia(returnVia: unknown): void {
    if (returnVia === undefined) return;
    if (returnVia === "text")
      throw new Error(
        'agent returnVia: "text" was removed: structured results are accepted in the child\'s own session through workflow_return. ' +
          "Drop the option; a plain agent(prompt) call still returns the exact full text",
      );
    if (returnVia !== "tool") throw new Error("agent returnVia must be tool when supplied");
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        '[workflow:deprecated] agent returnVia: "tool" is redundant and ignored: every shaped call uses same-session ' +
        "workflow_return acceptance. Remove the option.",
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
  }

  /**
   * Declaration dispatch for one `agent()` call, in the order the refusals have always
   * fired: removed options, then the `result: "report"` exclusivity, then `returnVia`,
   * then the shape itself. A `plain` verdict means the call carries no output contract at
   * all, which is exactly why `validate` is refused there — it would have nothing to check
   * against and nowhere in the child's session to be checked.
   */
  function dispatchWorkflowAgentShape(opts: WorkflowAgentAnyOptions | undefined): "plain" | "shaped" {
    assertNoRemovedAgentOptions(opts);
    if (opts?.result !== undefined) {
      if (opts.result !== "report") throw new Error("agent result must be report when supplied");
      for (const key of [
        "choice",
        "choiceFallback",
        "handoffs",
        "schema",
        "validate",
        "returnVia",
        "output",
        "repair",
      ] as const) {
        if (opts[key] !== undefined) throw new Error(`agent result: report cannot be combined with ${key}`);
      }
    }
    assertWorkflowReturnVia(opts?.returnVia);
    const shaped =
      opts !== undefined &&
      (opts.choice !== undefined ||
        opts.handoffs !== undefined ||
        opts.schema !== undefined ||
        opts.output !== undefined ||
        opts.repair !== undefined);
    if (opts?.choice === undefined && opts?.choiceFallback !== undefined)
      throw new Error("agent choiceFallback requires choice");
    if (shaped) return "shaped";
    if (opts?.validate !== undefined) throw new Error("agent validate requires a schema or handoffs");
    return "plain";
  }

  /** The choice DECISION projection, journalled on the canonical runtime log line. */
  function recordChoiceDecision(
    opts: WorkflowAgentAnyOptions | undefined,
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
      ...(opts?.label === undefined ? {} : { label: opts.label }),
      ...(callId === undefined ? {} : { callId }),
      ...(currentPhase() === undefined ? {} : { phase: currentPhase()! }),
      ...deps.activeGroupFields(),
      ...(context?.hasBusinessKeys ? { itemPath: [...context.memberPath] } : {}),
    });
  }

  /**
   * THE structured path: one child session, one acceptance, no second dialect.
   *
   * Everything shaped desugars here. `choice` becomes a string enum, `handoffs` becomes an
   * array-of-strings schema carrying only the author's declared bounds, `output` stays a
   * string contract, `schema` passes through. The contract is stated in the prompt and
   * enforced by the `workflow_return` tool INSIDE the child's session, so a rejected value
   * comes back to the agent that produced it, with its evidence still in context.
   *
   * `validate` travels beside the request rather than inside the contract, because the
   * contract is JSON — it is deliberately absent from `canonicalAgentRequest`, so an
   * author editing a validator body does not silently rewrite every replay key; the
   * VERSION of the contract is what marks the boundary.
   */
  async function runShapedAgent(prompt: string, opts: WorkflowAgentAnyOptions): Promise<unknown> {
    assertWorkflowToolReturnOptions(opts);
    const choices = opts.choice === undefined ? undefined : normalizeAgentChoices(opts.choice);
    const fallback = choices === undefined ? undefined : normalizeAgentChoiceFallback(opts.choiceFallback, choices);
    const bounds = opts.handoffs === undefined ? undefined : normalizeAgentHandoffs(opts.handoffs);
    const schema =
      bounds !== undefined
        ? handoffsSchema(bounds)
        : choices !== undefined
          ? undefined
          : (opts as WorkflowAgentSchemaOptions).schema;
    const contract = normalizeWorkflowReturnContract({
      ...(choices === undefined ? {} : { choices }),
      ...(opts.output === undefined ? {} : { output: opts.output }),
      ...(schema === undefined ? {} : { schema }),
      ...(opts.repair === undefined ? {} : { repair: opts.repair }),
    });
    // The clarification allowance is a real execution decision, so it is in the journal
    // as well as in the contract the child is shown: a default nobody can see is a hidden
    // policy, which is exactly what this change set exists to remove.
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        `[workflow:return] ${opts.label ?? "agent"}: contract v${String(contract.version)}, ` +
        `${String(workflowReturnClarificationTurns(contract))} same-session clarification turn(s) ` +
        `(${opts.repair === undefined ? `package default ${String(DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS)}` : "declared"})`,
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
    const declaredValidate = (opts as WorkflowAgentSchemaOptions).validate;
    // Re-entrancy guard, same as the old text path: a validator that calls back into the
    // DSL would open a second execution inside an acceptance decision.
    const validate: WorkflowReturnValidate | undefined =
      declaredValidate === undefined
        ? undefined
        : (value) => deps.runScriptValidate(() => assertWorkflowReturnValidationErrors(declaredValidate(value)));
    try {
      const outcome = await runAgentAttempt(
        `${prompt}\n\n${workflowReturnInstructions(contract)}`,
        {
          ...opts,
          [WORKFLOW_RETURN_CONTRACT]: contract,
          ...(validate === undefined ? {} : { [WORKFLOW_RETURN_VALIDATE]: validate }),
        },
        (text) => {
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            return {
              validation: { status: "mismatch", attempts: 1, errors: ["accepted output is not canonical JSON"] },
            };
          }
          // `source` names the rejecting authority, and is recorded only when two
          // authorities could have rejected: a schema-only call has exactly one.
          const authority = validate === undefined ? {} : { source: "schema" as const };
          const error = workflowReturnValueError(value, contract);
          if (error !== undefined)
            return { validation: { status: "mismatch", attempts: 1, errors: [error], ...authority } };
          // Re-checked here so a REPLAYED answer is held to the current validator too; the
          // `script` authority is what makes that a named `script-rejected` failure rather
          // than a shape mismatch that would re-ask at an ordinal the record cannot serve.
          if (validate !== undefined) {
            const errors = validate(value);
            if (errors.length > 0)
              return { validation: { status: "mismatch", attempts: 1, errors: [...errors], source: "script" } };
          }
          return { value, validation: { status: "valid", attempts: 1, errors: [] } };
        },
      );
      // Accepted ONLY from the confirmed receipt the logical call carries back in
      // `schemaCheck`: an answer that never reached `workflow_return` has no verdict here
      // and fails closed. Nothing in this module reads the child's final text.
      if (
        outcome.schemaCheck?.validation.status !== "valid" ||
        (contract.schema === undefined && typeof outcome.schemaCheck.value !== "string")
      )
        throw new SchemaValidationError(outcome.schemaCheck?.validation.errors ?? ["missing output validation"], 1);
      const value: unknown = outcome.schemaCheck.value;
      if (choices !== undefined)
        recordChoiceDecision(
          opts,
          {
            value: value as string,
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

  return { dispatchWorkflowAgentShape, runShapedAgent };
}
