import type { AgentResponseAcceptance } from "../../_shared/agent-runtime/agent-runner.js";
import type { ReadOnlyAgentCustomTool } from "../../_shared/agent-runtime/agent-read-only-policy.js";

/**
 * The same-session acceptance contract for an `agent({ choice })` call — the ONLY
 * model-return contract a workflow agent has.
 *
 * Version 3 removed every general shaped result: no schema, no handoff list, no string
 * output contract, no author repair block and no author validator. What remains is one
 * declared set of exact strings the child picks from, plus one visible package default
 * of a single same-session correction turn.
 *
 * The version travels into the canonical request and therefore into the replay key,
 * which is exactly the point: a v2 record cannot be silently reused under the v3
 * contract, and `workflow-replay.ts` names that boundary instead of blaming the
 * author's script for a `key-mismatch`.
 */
export const WORKFLOW_RETURN_CONTRACT_VERSION = 3 as const;

/**
 * Same-session correction turns the runtime allows after the first submission.
 *
 * One, and deliberately visible rather than implicit: a correction turn reuses the
 * evidence the child already has, so it is not a second generation of the work. Zero
 * would mean a single mistyped argument throws away a completed child; more than one
 * would be a hidden loop. There is no author override: the package owns this bound.
 */
export const DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS = 1;

export interface WorkflowReturnContract {
  version: typeof WORKFLOW_RETURN_CONTRACT_VERSION;
  choices: readonly string[];
  /** Submissions this contract accepts, counting the first. Always the package default. */
  maxAttempts: number;
}

export function normalizeWorkflowReturnContract(input: { choices: readonly string[] }): WorkflowReturnContract {
  const extra = Object.keys(input).filter((key) => key !== "choices");
  if (extra.length > 0)
    throw new Error(`a workflow return contract carries only choices; unsupported field(s): ${extra.join(", ")}`);
  const { choices } = input;
  if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string" || choice.trim() === ""))
    throw new Error("a workflow return contract requires an array of non-empty choice strings");
  return Object.freeze({
    version: WORKFLOW_RETURN_CONTRACT_VERSION,
    choices: Object.freeze([...choices]),
    maxAttempts: DEFAULT_WORKFLOW_RETURN_CLARIFICATIONS + 1,
  });
}

/** How many same-session correction turns this contract allows after the first submission. */
export function workflowReturnClarificationTurns(contract: WorkflowReturnContract): number {
  return contract.maxAttempts - 1;
}

/** Exact membership: one declared string, nothing else — no array, object or free text. */
export function workflowReturnValueError(value: unknown, contract: WorkflowReturnContract): string | undefined {
  if (typeof value !== "string") return `value must be one exact declared string, not ${describeValueType(value)}`;
  if (!contract.choices.includes(value)) return `value must exactly match one of ${JSON.stringify(contract.choices)}`;
  return undefined;
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

export function workflowReturnInstructions(contract: WorkflowReturnContract): string {
  const clarifications = workflowReturnClarificationTurns(contract);
  return (
    "Return your choice using workflow_return({ value: ... }), not by formatting a final message. " +
    `value must be exactly one of these declared strings: ${contract.choices.map((choice) => JSON.stringify(choice)).join(", ")}. ` +
    `Valid tool arguments are ${contract.choices.map((choice) => JSON.stringify({ value: choice })).join(" or ")}; ` +
    "these argument shapes do not recommend a branch, so select the member supported by your evidence. " +
    "Do not wrap the choice in an object, list, explanation, prefix or Markdown. " +
    `After the first submission you get ${String(clarifications)} same-session correction turn(s) to fix the form of the choice. ` +
    "Do all research before submitting. After submitting, use only workflow_return to correct the choice; do not repeat file " +
    "writes or other external effects. Finish the turn normally after acceptance."
  );
}

/** The accepted proposal becomes authoritative ONLY after the enclosing child completes successfully. */
export function createWorkflowReturnController(contract: WorkflowReturnContract): {
  tool: ReadOnlyAgentCustomTool;
  acceptance: AgentResponseAcceptance;
} {
  let attempts = 0;
  let accepted: string | undefined;
  let failure: string | undefined;
  let lastError = "workflow_return was not called";
  let narrowTools: (() => void) | undefined;
  const correction = " Submit one exact declared string as value, without an object, list or explanatory text.";
  const reject = (reason: string): void => {
    lastError = reason;
    if (attempts >= contract.maxAttempts) failure = `Output contract exhausted after ${attempts} attempts: ${reason}`;
  };
  const tool: ReadOnlyAgentCustomTool = {
    name: "workflow_return",
    label: "Return workflow choice",
    description: workflowReturnInstructions(contract),
    // Membership is checked in execute, not in the parameter schema: the host validates
    // parameters before execute runs, and a rejection there would neither spend a
    // correction attempt nor reach the child as this contract's own feedback.
    parameters: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
    execute(_toolCallId, input, signal) {
      if (signal.aborted)
        return { content: [{ type: "text", text: "Workflow call cancelled; no value accepted." }], isError: true };
      // Changes apply to the next model turn. Already-dispatched effects are not rolled back.
      narrowTools?.();
      if (failure !== undefined) return { content: [{ type: "text", text: failure }], isError: true };
      const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
      const value = record === undefined ? undefined : (record as Record<string, unknown>).value;
      const error =
        record === undefined || Object.keys(record).length !== 1 || !Object.hasOwn(record, "value")
          ? "Provide exactly { value: ... }"
          : workflowReturnValueError(value, contract);
      if (accepted !== undefined) {
        if (error === undefined && value === accepted)
          return { content: [{ type: "text", text: "Identical choice already accepted. Finish normally." }] };
        failure = "Conflicting workflow_return after an accepted choice";
        return { content: [{ type: "text", text: failure }], isError: true };
      }
      attempts += 1;
      if (error !== undefined) {
        reject(error);
        return {
          content: [
            {
              type: "text",
              text: failure ?? `${error}. Correct workflow_return only; do not redo the task.${correction}`,
            },
          ],
          isError: true,
        };
      }
      accepted = value as string;
      return {
        content: [
          {
            type: "text",
            text: "Choice accepted. Finish normally; success is committed only after this child completes.",
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
        return { status: "failed", reason: failure, failureCause: "output-contract-exhausted" };
      const prompt = `${lastError}. Call workflow_return with the corrected choice only. Reuse your existing evidence; do not perform the task again.${correction}`;
      lastError = "workflow_return was not called";
      return { status: "retry", prompt };
    },
  };
  return { tool, acceptance };
}
