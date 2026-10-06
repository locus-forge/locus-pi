/** V4 live terminal evidence and immutable replay provenance validation. */
import type { AgentStructuredReceipt, AgentFailureCause } from "../../../_shared/agent-runtime/agent-runner.js";
import {
  immutableJSON,
  canonicalWorkflowJSON,
  WORKFLOW_RAW_OBSERVER_REVISION,
  type WorkflowStructuredContract,
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
      spent.toolCalls < 1 ||
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
      if (proposal !== undefined) throw new Error("Raw generation followed accepted output");
      responses.add(turn.responseId);
      const mixed = turn.workTools && turn.calls.length > 0;
      if (mixed) counted++;
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
        if (mixed && call.validation !== "rejected") throw new Error("Mixed batch cannot supply accepted output");
        if (call.validation === "rejected" && proposal === undefined) {
          if (!mixed) counted++;
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
    receipt.version !== 4 ||
    receipt.validation !== "accepted" ||
    receipt.sourceIdentity !== sourceIdentity ||
    canonicalWorkflowJSON(receipt.contract) !== canonicalWorkflowJSON(contract) ||
    receipt.observerRevision !== WORKFLOW_RAW_OBSERVER_REVISION
  )
    throw new Error("replay-contract-failure: structured receipt/source identity mismatch");
  return receipt;
}

/** A terminal frame confirms exactly the finalized tool items already observed. */
export function verifyWorkflowRawTerminal(
  output: unknown,
  observed: ReadonlyMap<string, { name: string; callId: string; arguments?: string }>,
): { reason: string; failureCause: AgentFailureCause } | undefined {
  const unknown = (reason: string) => ({ reason, failureCause: "output-protocol-unknown" as const });
  if (!Array.isArray(output)) return unknown("Raw terminal output unavailable");
  const seen = new Set<string>();
  for (const entry of output) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return unknown("Malformed raw terminal output item");
    const item = entry as Record<string, unknown>;
    if (item.type === "function_call") {
      const identity = typeof item.id === "string" ? observed.get(item.id) : undefined;
      if (
        identity === undefined ||
        seen.has(item.id as string) ||
        identity.name !== item.name ||
        identity.callId !== item.call_id ||
        identity.arguments === undefined ||
        identity.arguments !== item.arguments
      )
        return unknown("Terminal tool does not match finalized raw evidence");
      seen.add(item.id as string);
    }
    if (
      item.type === "message" &&
      Array.isArray(item.content) &&
      item.content.some((part) => part !== null && typeof part === "object" && part.type === "refusal")
    )
      return { reason: "Provider refused structured output", failureCause: "output-refused" };
  }
  if (seen.size !== observed.size) return unknown("Terminal output omitted observed tool evidence");
  return undefined;
}
