import type { AgentResponseAcceptance } from "../../_shared/agent-runtime/agent-runner.js";
import type { ReadOnlyAgentCustomTool } from "../../_shared/agent-runtime/agent-read-only-policy.js";
import { assertSupportedAgentSchema, isRecord, validateAgainstSchema } from "./workflow-schema.js";

/**
 * The same-session acceptance contract for every shaped `agent()` call.
 *
 * Version 2 removed the runtime's own size policy: there is no default answer
 * ceiling, no derived canonical-JSON allowance, and no upper bound on the
 * clarification budget. What remains is the CONSUMER's contract — a declared
 * type, a declared membership, a declared `output.maxLength` the author chose —
 * plus one visible default of a single same-session clarification turn.
 *
 * The version travels into the canonical request and therefore into the replay
 * key, which is exactly the point: a v1 record cannot be silently reused under a
 * v2 contract, and `workflow-replay.ts` names that boundary instead of blaming
 * the author's script for a `key-mismatch`.
 */
export const WORKFLOW_RETURN_CONTRACT_VERSION = 2 as const;

/**
 * Same-session correction turns the runtime allows after the first submission,
 * when the author declared no `repair` block.
 *
 * One, and deliberately visible rather than implicit: a clarification turn reuses
 * the evidence the child already has, so it is not a second generation of the work
 * and not a size policy. Zero would mean a single mistyped JSON argument throws away
 * a completed child; more than one without the author asking would be a hidden loop.
 */
export const DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS = 1;

/** Explicit output boundary, independent of semantic review and transport retries. */
export interface WorkflowStringOutput {
  type: "string";
  singleLine?: boolean;
  /** A real consumer contract (a one-line heading, an external identifier), never a
   *  guessed output budget. Absent means the runtime imposes no length at all. */
  maxLength?: number;
}
export interface WorkflowOutputRepair {
  /** Includes the first submission or missing-submission turn. Does not start a fresh child. */
  maxAttempts: number;
  clarification?: string;
}

/** Cross-field rules the schema subset cannot declare, checked inside the child's own
 *  session so a violation is correctable rather than fatal. Pure and synchronous. */
export type WorkflowReturnValidate = (value: unknown) => readonly string[];

export interface WorkflowReturnContract {
  version: typeof WORKFLOW_RETURN_CONTRACT_VERSION;
  choices?: readonly string[];
  /** Supported JSON-schema subset for a shaped value; handoffs arrive already desugared
   *  to a string array carrying only the author's declared bounds. */
  schema?: Record<string, unknown>;
  singleLine: boolean;
  /** Present only when the author declared one. There is no package default. */
  maxLength?: number;
  maxAttempts: number;
  clarification?: string;
}

/** Options this contract REFUSES by name, with the reason and the replacement. Silently
 *  dropping a bound its author believed was applied is the failure mode this prevents. */
const REMOVED_RETURN_CONTRACT_INPUTS: Readonly<Record<string, string>> = Object.freeze({
  schemaMaxLength:
    "schemaMaxLength was removed: the runtime no longer derives a canonical-JSON ceiling for a shaped value",
});

export function normalizeWorkflowReturnContract(input: {
  output?: WorkflowStringOutput;
  choices?: readonly string[];
  schema?: unknown;
  repair?: WorkflowOutputRepair;
}): WorkflowReturnContract {
  for (const [key, message] of Object.entries(REMOVED_RETURN_CONTRACT_INPUTS)) {
    if ((input as Record<string, unknown>)[key] !== undefined) throw new Error(message);
  }
  if ([input.output, input.choices, input.schema].filter((part) => part !== undefined).length !== 1)
    throw new Error("a shaped agent call requires exactly one choice, string output or schema contract");
  if (input.schema !== undefined) {
    if (!isRecord(input.schema)) throw new Error("agent schema must be a JSON-schema object");
    assertSupportedAgentSchema(input.schema);
  }
  if (
    input.output !== undefined &&
    (!isRecord(input.output) ||
      input.output.type !== "string" ||
      Object.keys(input.output).some((key) => !["type", "singleLine", "maxLength"].includes(key)))
  ) {
    throw new Error("output requires a closed string contract: type, singleLine, maxLength");
  }
  if (input.output?.singleLine !== undefined && typeof input.output.singleLine !== "boolean")
    throw new Error("output.singleLine must be boolean");
  // Declared-only. An author who names a length owns it as a consumer requirement; the
  // runtime adds none of its own and imposes no upper bound on the one the author names.
  const maxLength = input.output?.maxLength;
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1))
    throw new Error("output.maxLength must be a positive safe integer when declared");
  if (
    input.repair !== undefined &&
    (!isRecord(input.repair) ||
      !Object.hasOwn(input.repair, "maxAttempts") ||
      Object.keys(input.repair).some((key) => !["maxAttempts", "clarification"].includes(key)))
  ) {
    throw new Error("repair requires maxAttempts and optional clarification");
  }
  const maxAttempts = input.repair?.maxAttempts ?? DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS + 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new Error("repair.maxAttempts must be a positive safe integer, including the initial answer");
  const clarification = input.repair?.clarification;
  if (clarification !== undefined && (typeof clarification !== "string" || clarification.trim() === ""))
    throw new Error("repair.clarification must be nonblank text");
  return Object.freeze({
    version: WORKFLOW_RETURN_CONTRACT_VERSION,
    ...(input.choices === undefined ? {} : { choices: Object.freeze([...input.choices]) }),
    ...(input.schema === undefined ? {} : { schema: input.schema as Record<string, unknown> }),
    singleLine: input.output?.singleLine ?? false,
    ...(maxLength === undefined ? {} : { maxLength }),
    maxAttempts,
    ...(clarification === undefined ? {} : { clarification }),
  });
}

/** How many same-session correction turns this contract allows after the first submission. */
export function workflowReturnClarificationTurns(contract: WorkflowReturnContract): number {
  return contract.maxAttempts - 1;
}

export function workflowReturnValueError(value: unknown, contract: WorkflowReturnContract): string | undefined {
  if (contract.schema !== undefined) {
    // Shape only. A shaped value carries no runtime length policy: an author bound lives
    // inside the schema (`maxLength`/`maxItems`), where it is the consumer's contract and
    // is fed back to the child as a correctable violation rather than a post-hoc refusal.
    const shape = validateAgainstSchema(value, contract.schema);
    return shape.ok ? undefined : shape.errors.join("; ");
  }
  if (typeof value !== "string" || value.trim() === "") return "value must be a nonblank string";
  if (contract.maxLength !== undefined && value.length > contract.maxLength)
    return `value exceeds the declared maxLength of ${contract.maxLength} characters`;
  if (contract.singleLine && /[\r\n\u2028\u2029]/u.test(value)) return "value must contain one line only";
  if (contract.choices !== undefined && !contract.choices.includes(value))
    return `value must exactly match one of ${JSON.stringify(contract.choices)}`;
  return undefined;
}

/**
 * A validate() return is author data crossing into runtime-owned surfaces, so it is
 * checked like any other untrusted value: the LIST is checked for type, never for size.
 * The full list reaches the child, because a truncated list hides a violation the child
 * is being asked to fix.
 */
export function assertWorkflowReturnValidationErrors(returned: unknown): readonly string[] {
  if (isRecord(returned) && typeof returned.then === "function") {
    throw new Error("agent validate must return an array of strings, not a Promise");
  }
  if (!Array.isArray(returned)) throw new Error("agent validate must return an array of strings");
  for (const [index, error] of returned.entries()) {
    if (typeof error !== "string") throw new Error("agent validate must return an array of strings");
    if (error === "") throw new Error(`agent validate error at index ${index} must be a non-empty string`);
  }
  return returned as readonly string[];
}

export function workflowReturnInstructions(contract: WorkflowReturnContract): string {
  const clarifications = workflowReturnClarificationTurns(contract);
  return (
    `Return the value using workflow_return({ value: ... }), not by formatting a final message. The host validates this contract: ${JSON.stringify(contract)}. ` +
    `The contract states no answer size; return the complete value. After the first submission you get ${String(clarifications)} same-session ` +
    "correction turn(s) (maxAttempts counts the first submission), which exist to fix the FORM of the value you already found. " +
    "Do all research before submitting. After submitting, use only workflow_return to correct the answer; do not repeat file writes or other " +
    "external effects. Finish the turn normally after acceptance." +
    (contract.schema === undefined
      ? ""
      : " For a schema or handoffs contract, pass the JSON value itself (object or array) as value, not a string that contains JSON.")
  );
}

/** Syntax guidance only: the agent keeps its content and still has to satisfy the schema. */
function workflowReturnCorrectionExample(contract: WorkflowReturnContract, value: unknown): string {
  const type = contract.schema?.type;
  if (type !== "array" && type !== "object") return "";
  if (type === "array" ? Array.isArray(value) : isRecord(value)) return "";
  const example = type === "array" ? '{"value":[]}' : '{"value":{}}';
  return (
    ` Raw ${type} tool-argument syntax: ${example}. This shows the container only; ` +
    "fill it with your existing schema-matching content. Pass value directly, without JSON.stringify or wrapping the JSON in quotes."
  );
}
/** The accepted proposal becomes authoritative ONLY after the enclosing child completes successfully. */
export function createWorkflowReturnController(
  contract: WorkflowReturnContract,
  /** Author cross-field rules, checked here so a violation is correctable in THIS session. */
  validate?: WorkflowReturnValidate,
): {
  tool: ReadOnlyAgentCustomTool;
  acceptance: AgentResponseAcceptance;
} {
  let attempts = 0;
  let accepted: unknown;
  let failure: string | undefined;
  let lastError = "workflow_return was not called";
  let correctionExample = "";
  let narrowTools: (() => void) | undefined;
  const reject = (reason: string): void => {
    lastError = reason;
    if (attempts >= contract.maxAttempts) failure = `Output contract exhausted after ${attempts} attempts: ${reason}`;
  };
  /**
   * `undefined` = accepted; a string = a violation the child is asked to correct here.
   *
   * The author validator runs BEST-EFFORT at this point: its purpose in-session is to turn
   * a cross-field violation into a correction the child can make while it still holds its
   * evidence. A validator that throws, or returns something that is not an error list, is
   * an AUTHOR bug rather than a model failure, so it is not reported to the child at all —
   * the value is accepted here and the boundary's own re-check (which also covers replayed
   * answers) raises the author's exception and ends the run closed. Blaming the model for
   * a script defect would launder that defect into a repair loop.
   */
  const valueError = (value: unknown): string | undefined => {
    const shape = workflowReturnValueError(value, contract);
    if (shape !== undefined || validate === undefined) return shape;
    let errors: readonly string[];
    try {
      errors = assertWorkflowReturnValidationErrors(validate(value));
    } catch {
      return undefined;
    }
    return errors.length === 0 ? undefined : errors.join("; ");
  };
  const tool: ReadOnlyAgentCustomTool = {
    name: "workflow_return",
    label: "Return workflow value",
    description: workflowReturnInstructions(contract),
    // Value validation belongs to execute, so invalid values receive feedback in THIS session.
    parameters: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
    execute(_toolCallId, input, signal) {
      if (signal.aborted)
        return { content: [{ type: "text", text: "Workflow call cancelled; no value accepted." }], isError: true };
      // Changes apply to the next model turn. Already-dispatched effects are not rolled back.
      narrowTools?.();
      if (failure !== undefined) return { content: [{ type: "text", text: failure }], isError: true };
      const shapeError =
        !isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "value")
          ? "Provide exactly { value: ... }"
          : undefined;
      const value = isRecord(input) ? input.value : undefined;
      const error = shapeError ?? valueError(value);
      if (accepted !== undefined) {
        if (error === undefined && JSON.stringify(value) === JSON.stringify(accepted))
          return { content: [{ type: "text", text: "Identical proposal already accepted. Finish normally." }] };
        failure = "Conflicting workflow_return after an accepted proposal";
        return { content: [{ type: "text", text: failure }], isError: true };
      }
      attempts += 1;
      if (error !== undefined) {
        reject(error);
        correctionExample = workflowReturnCorrectionExample(contract, value);
        return {
          content: [
            {
              type: "text",
              text: failure ?? `${error}. Correct workflow_return only; do not redo the task.${correctionExample}`,
            },
          ],
          isError: true,
        };
      }
      accepted = value;
      return {
        content: [
          {
            type: "text",
            text: "Proposal accepted. Finish normally; success is committed only after this child completes.",
          },
        ],
        details: { accepted: true, attempts },
      };
    },
  };
  const acceptance: AgentResponseAcceptance = {
    toolNames: ["workflow_return"],
    bindToolRestriction(restrict) {
      narrowTools = restrict;
    },
    inspect() {
      if (failure !== undefined)
        return {
          status: "failed",
          reason: failure,
          failureCause: accepted === undefined ? "output-contract-exhausted" : "output-contract-conflict",
        };
      if (accepted !== undefined)
        return { status: "accepted", text: JSON.stringify(accepted), attempts, toolName: "workflow_return" };
      // An invalid tool call has already spent an attempt. A turn with no call spends one here.
      if (lastError === "workflow_return was not called") attempts += 1;
      reject(lastError);
      if (failure !== undefined)
        return {
          status: "failed",
          reason: failure,
          failureCause: accepted === undefined ? "output-contract-exhausted" : "output-contract-conflict",
        };
      const prompt = `${lastError}. Call workflow_return with the corrected value only. Reuse your existing evidence; do not perform the task again. ${contract.clarification ?? ""}${correctionExample}`;
      lastError = "workflow_return was not called";
      return { status: "retry", prompt };
    },
  };
  return { tool, acceptance };
}
