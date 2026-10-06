import { WORKFLOW_NATIVE_WIRE_REVISION, nativeWorkflowRoute } from "./native-response.js";
/** Immutable structured replay provenance, identities and cumulative ledger validation. */
import type { AgentStructuredReceipt, AgentExecutionLedger } from "../../../_shared/agent-runtime/agent-runner.js";
import {
  immutableJSON,
  decodeWorkflowProposal,
  runWorkflowValueValidator,
  type WorkflowSchemaValidator,
  type WorkflowValueValidator,
  canonicalWorkflowJSON,
  WORKFLOW_RAW_OBSERVER_REVISION,
  type WorkflowStructuredContract,
  type WorkflowJSONValue,
} from "./schema.js";

export function verifyWorkflowStructuredReceipt(
  receipt: AgentStructuredReceipt,
  text: string,
  expected: {
    contract: WorkflowStructuredContract;
    limits: { maxTurns?: number | undefined; maxToolCalls?: number | undefined; timeoutMs?: number | undefined };
    sourceIdentity: string;
    inputIdentity: string;
    customValidation: "accepted" | "absent";
  },
): AgentStructuredReceipt {
  const { contract, limits, sourceIdentity, inputIdentity, customValidation } = expected;
  try {
    // Disk/caller input gets a detached immutable snapshot before either consumer sees it.
    receipt = immutableJSON(receipt) as unknown as AgentStructuredReceipt;
    const allowance = receipt.allowances;
    const spent = receipt.spent;
    if (
      allowance === undefined ||
      spent === undefined ||
      receipt.customValidation !== customValidation ||
      allowance.outputAttempts !== contract.maxAttempts ||
      allowance.assistantTurns !== (limits.maxTurns ?? "unbounded") ||
      allowance.toolCalls !== (limits.maxToolCalls ?? "unbounded") ||
      allowance.timeoutMs !== (limits.timeoutMs ?? "unbounded") ||
      !Number.isSafeInteger(spent.outputAttempts) ||
      spent.outputAttempts < 1 ||
      spent.outputAttempts > contract.maxAttempts ||
      !Number.isSafeInteger(spent.assistantTurns) ||
      spent.assistantTurns < 1 ||
      !Number.isSafeInteger(spent.toolCalls) ||
      spent.toolCalls < (contract.version === 5 ? 0 : 1) ||
      typeof spent.elapsedMs !== "number" ||
      !Number.isFinite(spent.elapsedMs) ||
      spent.elapsedMs < 0 ||
      (limits.maxTurns !== undefined && spent.assistantTurns > limits.maxTurns) ||
      (limits.maxToolCalls !== undefined && spent.toolCalls > limits.maxToolCalls) ||
      (limits.timeoutMs !== undefined && spent.elapsedMs > limits.timeoutMs) ||
      !Array.isArray(receipt.rawTurns) ||
      receipt.rawTurns.length !== spent.assistantTurns
    )
      throw new Error("Invalid allowance/spent ledger");
    const responses = new Set<string>();
    const ids = new Set<string>();
    let counted = 0;
    let proposal: string | undefined;
    if (receipt.version === 5) {
      for (const turn of receipt.rawTurns) {
        if (
          turn.terminal !== "completed" ||
          typeof turn.responseId !== "string" ||
          turn.responseId === "" ||
          responses.has(turn.responseId) ||
          typeof turn.workTools !== "boolean" ||
          Object.hasOwn(turn, "calls") ||
          turn.payload?.wireRevision !== WORKFLOW_NATIVE_WIRE_REVISION ||
          !/^[a-f0-9]{64}$/u.test(turn.payload.wireSchemaSha256)
        )
          throw new Error("Invalid native terminal/payload provenance");
        nativeWorkflowRoute({ ...turn.payload.route, id: turn.payload.route.model });
        responses.add(turn.responseId);
        if (turn.validation === "research") {
          if (counted > 0 || !turn.workTools || turn.output !== undefined)
            throw new Error("Invalid native research turn");
          continue;
        }
        counted++;
        if (proposal !== undefined || !["accepted", "rejected"].includes(turn.validation))
          throw new Error("Invalid native output sequence");
        if (turn.output !== undefined) {
          const output = turn.output;
          if (
            typeof output.messageId !== "string" ||
            output.messageId === "" ||
            ids.has(output.messageId) ||
            typeof output.text !== "string" ||
            (Object.hasOwn(output, "phase") && output.phase !== null && output.phase !== "final_answer")
          )
            throw new Error("Invalid native final message");
          ids.add(output.messageId);
        }
        if (turn.validation === "accepted") {
          if (turn.workTools || turn.output === undefined) throw new Error("Invalid native accepted output");
          proposal = decodeWorkflowProposal(turn.output.text).canonical;
        }
      }
    } else
      for (const turn of receipt.rawTurns) {
        if (
          turn.terminal !== "completed" ||
          typeof turn.responseId !== "string" ||
          turn.responseId === "" ||
          responses.has(turn.responseId) ||
          typeof turn.workTools !== "boolean" ||
          !Array.isArray(turn.calls)
        )
          throw new Error("Invalid raw terminal provenance");
        responses.add(turn.responseId);
        if (turn.calls.length === 0 && (!turn.workTools || counted > 0)) counted++;
        for (const call of turn.calls) {
          if (
            typeof call.callId !== "string" ||
            call.callId === "" ||
            ids.has(call.callId) ||
            typeof call.arguments !== "string"
          )
            throw new Error("Invalid raw call identity");
          ids.add(call.callId);
          if (call.validation === "rejected" && proposal === undefined) {
            counted++;
            continue;
          }
          const raw = JSON.parse(call.arguments) as unknown;
          if (
            raw === null ||
            typeof raw !== "object" ||
            Array.isArray(raw) ||
            Object.keys(raw).length !== 1 ||
            !Object.hasOwn(raw, "value")
          )
            throw new Error("Invalid accepted raw envelope");
          const canonical = canonicalWorkflowJSON((raw as { value: unknown }).value);
          if (call.validation === "accepted" && proposal === undefined) {
            proposal = canonical;
            counted++;
          } else if (call.validation !== "duplicate" || canonical !== proposal)
            throw new Error("Invalid accepted raw proposal sequence");
        }
      }
    if (proposal !== text || counted !== spent.outputAttempts) throw new Error("Raw proposal/ledger mismatch");
  } catch (error) {
    throw new Error(`replay-contract-failure: ${String(error)}`);
  }
  if (
    sourceIdentity === "unavailable" ||
    inputIdentity === "unavailable" ||
    receipt.inputIdentity !== inputIdentity ||
    receipt.version !== contract.version ||
    receipt.validation !== "accepted" ||
    receipt.sourceIdentity !== sourceIdentity ||
    canonicalWorkflowJSON(receipt.contract) !== canonicalWorkflowJSON(contract) ||
    receipt.observerRevision !==
      (contract.version === 5 ? WORKFLOW_NATIVE_WIRE_REVISION : WORKFLOW_RAW_OBSERVER_REVISION)
  )
    throw new Error("replay-contract-failure: structured receipt/source identity mismatch");
  return receipt;
}

import type {
  AgentNativeMessage,
  AgentNativeTurn,
} from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";
export interface WorkflowStructuredRawTurn {
  workTools: boolean;
  responseId: string;
  terminal?: "completed";
  calls: Map<string, string>;
  items: Map<string, { name: string; callId: string }>;
  native?: {
    payload?: AgentNativeTurn["payload"];
    output?: AgentNativeMessage;
    validation?: AgentNativeTurn["validation"];
  };
}
/** The one serialized provenance projection. Runtime maps never escape into disk/journal values. */
export function createWorkflowStructuredReceipt(input: {
  contract: WorkflowStructuredContract;
  schemaSha256: string;
  sourceIdentity: string;
  inputIdentity: string;
  value: WorkflowJSONValue;
  limits: { maxTurns?: number | undefined; maxToolCalls?: number | undefined; timeoutMs?: number | undefined };
  ledger: AgentExecutionLedger;
  attempts: number;
  elapsedMs: number;
  turns: readonly WorkflowStructuredRawTurn[];
  customValidation: "accepted" | "absent";
  callValidation(callId: string): "accepted" | "rejected" | "duplicate";
}): AgentStructuredReceipt {
  return immutableJSON({
    version: input.contract.version,
    contract: input.contract,
    schemaSha256: input.schemaSha256,
    sourceIdentity: input.sourceIdentity,
    inputIdentity: input.inputIdentity,
    observerRevision: input.contract.version === 5 ? WORKFLOW_NATIVE_WIRE_REVISION : WORKFLOW_RAW_OBSERVER_REVISION,
    value: input.value,
    allowances: {
      outputAttempts: input.contract.maxAttempts,
      assistantTurns: input.limits.maxTurns ?? "unbounded",
      toolCalls: input.limits.maxToolCalls ?? "unbounded",
      timeoutMs: input.limits.timeoutMs ?? "unbounded",
    },
    spent: {
      outputAttempts: input.attempts,
      assistantTurns: input.ledger.assistantTurns,
      toolCalls: input.ledger.admittedToolCalls,
      elapsedMs: input.elapsedMs,
    },
    rawTurns:
      input.contract.version === 5
        ? input.turns.map((turn) => ({
            responseId: turn.responseId,
            terminal: turn.terminal!,
            workTools: turn.workTools,
            ...turn.native,
          }))
        : input.turns.map((turn) => ({
            responseId: turn.responseId,
            terminal: turn.terminal!,
            workTools: turn.workTools,
            calls: [...turn.calls].map(([callId, args]) => ({
              callId,
              arguments: args,
              validation: input.callValidation(callId),
            })),
          })),
    validation: "accepted",
    customValidation: input.customValidation,
  }) as unknown as AgentStructuredReceipt;
}

export function workflowStructuredSourceIdentities(identity?: {
  sha256: string;
  covered: boolean;
  inputSha256?: string;
}) {
  return {
    sourceIdentity:
      identity?.covered === true && /^[a-f0-9]{64}$/u.test(identity.sha256) ? identity.sha256 : "unavailable",
    inputIdentity:
      identity?.covered === true && /^[a-f0-9]{64}$/u.test(identity.inputSha256 ?? "")
        ? identity!.inputSha256!
        : "unavailable",
  };
}

/** Revalidation belongs beside persisted provenance checks, using the same canonical validator. */
export function revalidateWorkflowStructuredValue(
  receipt: AgentStructuredReceipt,
  text: string,
  schemaSha256: string,
  schema: WorkflowSchemaValidator,
  validate?: WorkflowValueValidator,
): WorkflowJSONValue {
  try {
    const value = immutableJSON(receipt.value);
    if (
      receipt.schemaSha256 !== schemaSha256 ||
      text !== canonicalWorkflowJSON(value) ||
      schema.errors(value).length !== 0 ||
      runWorkflowValueValidator(value, validate).length !== 0
    )
      throw new Error("structured value failed revalidation");
    return value;
  } catch (error) {
    throw new Error(`replay-contract-failure: ${String(error)}`);
  }
}
