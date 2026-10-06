import { verifyWorkflowStructuredReceipt, verifyWorkflowRawTerminal } from "./receipt.js";
import { supportsObservedOutputVersion } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";
/** V4 proposal/terminal owner. One instance belongs to one logical call across physical attempts. */
import type {
  AgentResponseAcceptance,
  AgentExecutionLedger,
  AgentStructuredReceipt,
  AgentFailureCause,
} from "../../../_shared/agent-runtime/agent-runner.js";
import type { ReadOnlyAgentCustomTool } from "../../../_shared/agent-runtime/agent-read-only-policy.js";
import {
  canonicalWorkflowJSON,
  immutableJSON,
  compileWorkflowSchema,
  runWorkflowValueValidator,
  WORKFLOW_RAW_OBSERVER_REVISION,
  type WorkflowJSONValue,
  type WorkflowStructuredContract,
  type WorkflowSchemaValidator,
  type WorkflowValueValidator,
} from "./schema.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
interface RawTurn {
  workTools: boolean;
  attemptsBefore: number;
  rejectedBatch?: string;
  responseId: string;
  terminal?: "completed";
  calls: Map<string, string>;
  items: Map<string, { name: string; callId: string; arguments?: string }>;
}
export interface WorkflowStructuredSourceIdentity {
  sha256: string;
  covered: boolean;
  inputSha256?: string;
}
export interface WorkflowStructuredCall {
  contract: WorkflowStructuredContract;
  controller(): { tool: ReadOnlyAgentCustomTool; acceptance: AgentResponseAcceptance };
  configure(limits: {
    maxTurns?: number | undefined;
    maxToolCalls?: number | undefined;
    timeoutMs?: number | undefined;
  }): void;
  canRetry(): boolean;
  remainingTimeout(): number | undefined;
  replay(receipt: AgentStructuredReceipt, text: string): Promise<WorkflowJSONValue>;
  sourceIdentity: string | "unavailable";
  inputIdentity: string | "unavailable";
}

export function createWorkflowStructuredCall(
  contract: WorkflowStructuredContract,
  validate?: WorkflowValueValidator,
  identity?: WorkflowStructuredSourceIdentity,
  replayHostVersion?: () => Promise<string | undefined>,
): WorkflowStructuredCall {
  const ledger: AgentExecutionLedger = { toolCalls: 0, admittedToolCalls: 0, assistantTurns: 0, toolNames: new Set() };
  const sourceIdentity =
    identity?.covered === true && /^[a-f0-9]{64}$/u.test(identity.sha256) ? identity.sha256 : "unavailable";
  const inputIdentity =
    identity?.covered === true && /^[a-f0-9]{64}$/u.test(identity.inputSha256 ?? "")
      ? identity!.inputSha256!
      : "unavailable";
  const turns: RawTurn[] = [];
  const hostCalls = new Map<string, string>();
  const calls = new Map<
    string,
    {
      raw: string;
      validation: "accepted" | "rejected" | "duplicate";
      error?: string;
      canonical?: string;
      value?: WorkflowJSONValue;
    }
  >();
  let turn: RawTurn | undefined;
  let schema: WorkflowSchemaValidator | undefined;
  let schemaSha256 = "";
  let attempts = 0;
  let accepted: { canonical: string; value: WorkflowJSONValue; executed: boolean } | undefined;
  let failed: { reason: string; failureCause: AgentFailureCause } | undefined;
  let lastError = "workflow_return was not called";
  let restrict: (() => void) | undefined;
  let limits: { maxTurns?: number | undefined; maxToolCalls?: number | undefined; timeoutMs?: number | undefined } = {};
  let configured = false;
  let startedAt = 0;
  const fail = (reason: string, failureCause: AgentFailureCause): void => {
    failed ??= { reason, failureCause };
  };
  const exhaust = (): void => {
    if (accepted === undefined && attempts >= contract.maxAttempts)
      fail(`Output contract exhausted after ${attempts} submissions: ${lastError}`, "output-contract-exhausted");
  };
  async function initialize(): Promise<void> {
    schema ??= await compileWorkflowSchema(contract);
    if (schemaSha256 === "") {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalWorkflowJSON(contract.schema)),
      );
      schemaSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
  function finalized(callId: string, name: string, raw: unknown): void {
    if (name !== "workflow_return") {
      if (turn !== undefined) turn.workTools = true;
      return;
    }
    restrict?.();
    if (typeof raw !== "string" || callId === "") {
      fail("Raw finalized return arguments/call identity unavailable", "output-protocol-unknown");
      return;
    }
    const prior = calls.get(callId);
    if (prior !== undefined) {
      if (!turn?.calls.has(callId)) fail("Call identity reused across raw responses", "output-protocol-unknown");
      if (prior.raw !== raw) fail("Conflicting raw arguments for one call id", "output-contract-conflict");
      return;
    }
    turn?.calls.set(callId, raw);
    if (failed !== undefined) {
      if (accepted === undefined) attempts++;
      calls.set(callId, { raw, validation: "rejected", error: failed.reason });
      return;
    }
    let value: WorkflowJSONValue | undefined;
    let canonical: string | undefined;
    let error: string | undefined;
    try {
      const parsed = record(JSON.parse(raw));
      if (parsed === undefined || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "value"))
        throw new Error("Provide exactly {value: JSONValue}");
      value = immutableJSON(parsed.value);
      canonical = canonicalWorkflowJSON(value);
    } catch (reason) {
      error = `Invalid raw workflow_return: ${String(reason)}`;
    }
    if (accepted !== undefined) {
      if (error !== undefined || canonical !== accepted.canonical)
        fail("Conflicting workflow_return after an accepted value", "output-contract-conflict");
      calls.set(callId, {
        raw,
        validation: "duplicate",
        ...(error === undefined ? {} : { error }),
        ...(canonical === undefined ? {} : { canonical }),
        ...(value === undefined ? {} : { value }),
      });
      return;
    }
    attempts++;
    if (attempts > contract.maxAttempts) {
      fail("Return submission exceeded its allowance", "output-contract-exhausted");
      return;
    }
    if (error === undefined) {
      let errors = schema!.errors(value!);
      if (errors.length === 0) {
        try {
          errors = runWorkflowValueValidator(value!, validate);
        } catch (reason) {
          fail(String(reason), "author-validation-error");
          error = String(reason);
        }
      }
      if (errors.length > 0)
        error = errors
          .slice(0, 20)
          .map((entry) => entry.slice(0, 500))
          .join("; ");
    }
    calls.set(callId, {
      raw,
      validation: error === undefined ? "accepted" : "rejected",
      ...(error === undefined ? {} : { error }),
      ...(canonical === undefined ? {} : { canonical }),
      ...(value === undefined ? {} : { value }),
    });
    if (error === undefined) accepted = { canonical: canonical!, value: value!, executed: false };
    else {
      lastError = error;
      exhaust();
    }
  }
  function finalizedItem(item: Record<string, unknown>): void {
    const identity = typeof item.id === "string" ? turn?.items.get(item.id) : undefined;
    if (
      identity === undefined ||
      identity.name !== item.name ||
      identity.callId !== item.call_id ||
      typeof item.arguments !== "string"
    ) {
      fail("Finalized tool lacks matching observed identity/arguments", "output-protocol-unknown");
      return;
    }
    if (identity.arguments !== undefined && identity.arguments !== item.arguments) {
      fail("Conflicting finalized tool arguments", "output-contract-conflict");
      return;
    }
    identity.arguments = item.arguments;
    finalized(identity.callId, identity.name, item.arguments);
  }
  function reconcileTerminal(output: unknown): void {
    if (turn === undefined) return;
    const mismatch = verifyWorkflowRawTerminal(output, turn.items);
    if (mismatch !== undefined) fail(mismatch.reason, mismatch.failureCause);
    if (turn.workTools && turn.calls.size > 0 && failed === undefined) {
      // Submission is a whole-batch boundary. No sibling may execute, in either order.
      turn.rejectedBatch = "workflow_return must be the only tool in its submission batch";
      accepted = undefined;
      attempts = turn.attemptsBefore + 1;
      for (const id of turn.calls.keys()) {
        const proposal = calls.get(id)!;
        proposal.validation = "rejected";
        proposal.error = turn.rejectedBatch;
      }
      lastError = turn.rejectedBatch;
      exhaust();
    }
  }
  function bindHostCall(item: Record<string, unknown>): void {
    if (typeof item.id !== "string" || typeof item.call_id !== "string" || item.id === "" || item.call_id === "") {
      fail("Raw tool item identity unavailable", "output-protocol-unknown");
      return;
    }
    // Pi Codex Responses v1 constructs this exact host id; never split or infer it from prose.
    const hostId = `${item.call_id}|${item.id}`;
    if (hostCalls.has(hostId) && hostCalls.get(hostId) !== item.call_id)
      fail("Ambiguous host call identity", "output-protocol-unknown");
    hostCalls.set(hostId, item.call_id);
  }
  function providerEvent(event: unknown): void {
    const data = record(event);
    if (data === undefined || turn === undefined) {
      fail("Raw observer event without request", "output-protocol-unknown");
      return;
    }
    const type = data.type;
    const response = record(data.response);
    if (type === "response.created") {
      if (
        typeof response?.id !== "string" ||
        response.id === "" ||
        turn.responseId !== "" ||
        turns.some((prior) => prior !== turn && prior.responseId === response.id)
      ) {
        fail("Ambiguous raw response identity", "output-protocol-unknown");
        return;
      }
      turn.responseId = response.id;
    }
    if (typeof type === "string" && (type.startsWith("response.refusal.") || type === "response.output_text.refusal"))
      fail("Provider refused structured output", "output-refused");
    const item = record(data.item);
    if (
      type === "response.output_item.added" &&
      item?.type === "function_call" &&
      typeof item.id === "string" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      const prior = turn.items.get(item.id);
      if (prior !== undefined && (prior.callId !== item.call_id || prior.name !== item.name))
        fail("Raw tool item identity changed", "output-protocol-unknown");
      if (prior === undefined) turn.items.set(item.id, { name: item.name, callId: item.call_id });
      bindHostCall(item);
    }
    if (type === "response.function_call_arguments.done") {
      const identity = typeof data.item_id === "string" ? turn.items.get(data.item_id) : undefined;
      if (identity === undefined) fail("Finalized arguments lack observed call identity", "output-protocol-unknown");
      else
        finalizedItem({ id: data.item_id, name: identity.name, call_id: identity.callId, arguments: data.arguments });
    }
    if (type === "response.output_item.done" && item?.type === "function_call") {
      finalizedItem(item);
    }
    if (type === "response.incomplete" || response?.status === "incomplete")
      fail("Provider output incomplete", "output-incomplete");
    if (type === "response.failed" || type === "error" || response?.status === "failed")
      fail("Provider raw error", "provider-error");
    if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      if (turn.responseId === "" || response?.id !== turn.responseId || response?.status !== "completed") {
        if (failed === undefined) fail("Unknown raw terminal response", "output-protocol-unknown");
      } else {
        reconcileTerminal(response.output);
        turn.terminal = "completed";
      }
    }
  }
  const acceptance: AgentResponseAcceptance = {
    executionLedger: ledger,
    toolNames: ["workflow_return"],
    bindToolRestriction: (callback) => {
      restrict = callback;
    },
    observedReturn: {
      observationLost: () => fail("Raw observer replaced or lost after dispatch", "output-protocol-unknown"),
      initialize,
      beforeRequest(context) {
        const model = record(record(context)?.model);
        if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses")
          fail("Structured route changed or unavailable", "output-contract-unavailable");
        if (turn !== undefined && turn.terminal === undefined)
          fail("Prior raw terminal observation unavailable", "output-protocol-unknown");
        exhaust();
        if (failed !== undefined || accepted !== undefined)
          throw new Error(failed?.reason ?? "Accepted output permits no new generation");
        if (limits.maxTurns !== undefined && ledger.assistantTurns >= limits.maxTurns) {
          fail("Cumulative assistant-turn budget exhausted", "assistant-turn-budget");
          throw new Error(failed!.reason);
        }
        if (ledger.deadline !== undefined && Date.now() >= ledger.deadline)
          throw new Error("Cumulative structured call deadline exhausted");
        ledger.assistantTurns++;
        turn = { workTools: false, attemptsBefore: attempts, responseId: "", calls: new Map(), items: new Map() };
        turns.push(turn);
      },
      providerEvent,
      beforeTool(context) {
        if (failed !== undefined) return { block: true, terminate: true, reason: failed.reason };
        if (turn?.rejectedBatch !== undefined) return { block: true, terminate: true, reason: turn.rejectedBatch };
        const data = record(context);
        const toolCall = record(data?.toolCall);
        if (
          toolCall?.name === "workflow_return" &&
          (typeof toolCall.id !== "string" || !calls.has(hostCalls.get(toolCall.id) ?? ""))
        ) {
          fail("Host tool lacks raw finalized return observation", "output-protocol-unknown");
          return { block: true, terminate: true, reason: failed!.reason };
        }
        if (turn?.terminal !== "completed")
          return { block: true, terminate: true, reason: "No completed raw response" };
        if (attempts > 0 && toolCall?.name !== "workflow_return")
          return { block: true, terminate: true, reason: "Only workflow_return permitted after submission" };
        return undefined;
      },
      finishTurn() {
        if (turn?.terminal !== "completed")
          fail("Raw terminal observation lost or disconnected", "output-protocol-unknown");
        if (
          turn?.calls.size === 0 &&
          (!turn.workTools || attempts > 0) &&
          failed === undefined &&
          accepted === undefined
        ) {
          attempts++;
          lastError = "workflow_return was not called";
        }
        exhaust();
        if (failed === undefined && accepted === undefined && attempts === 0 && turn?.workTools === true)
          return undefined;
        // End each output turn normally: the host's bounded acceptance loop supplies feedback.
        return { action: "end" };
      },
    },
    inspect() {
      if (accepted !== undefined && ledger.deadline !== undefined && Date.now() >= ledger.deadline)
        fail("Structured logical deadline exhausted", "call-timeout");
      if (accepted !== undefined && !accepted.executed)
        fail("Host did not execute the accepted raw return", "output-protocol-unknown");
      if (failed !== undefined) return { status: "failed", ...failed };
      if (turn === undefined || turn.terminal !== "completed")
        return {
          status: "failed",
          reason: "Raw terminal observation unavailable",
          failureCause: "output-protocol-unknown",
        };
      if (accepted === undefined)
        return {
          status: "retry",
          prompt: `${lastError}. Correct workflow_return only using existing evidence; do not repeat external effects.`,
        };
      const receipt = immutableJSON({
        version: 4,
        contract,
        schemaSha256,
        sourceIdentity,
        inputIdentity,
        observerRevision: WORKFLOW_RAW_OBSERVER_REVISION,
        value: accepted.value,
        allowances: {
          outputAttempts: contract.maxAttempts,
          assistantTurns: limits.maxTurns ?? "unbounded",
          toolCalls: limits.maxToolCalls ?? "unbounded",
          timeoutMs: limits.timeoutMs ?? "unbounded",
        },
        spent: {
          outputAttempts: attempts,
          assistantTurns: ledger.assistantTurns,
          toolCalls: ledger.admittedToolCalls,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        },
        rawTurns: turns.map((turn) => ({
          responseId: turn.responseId,
          terminal: turn.terminal!,
          workTools: turn.workTools,
          calls: [...turn.calls].map(([callId, args]) => ({
            callId,
            arguments: args,
            validation: calls.get(callId)!.validation,
          })),
        })),
        validation: "accepted",
        customValidation: validate === undefined ? "absent" : "accepted",
      }) as unknown as AgentStructuredReceipt;
      return {
        status: "accepted",
        text: accepted.canonical,
        attempts,
        toolName: "workflow_return",
        structuredReceipt: receipt,
      };
    },
  };
  const tool: ReadOnlyAgentCustomTool = {
    name: "workflow_return",
    label: "Return checked workflow data",
    description: `Return exactly {value: JSONValue} satisfying ${JSON.stringify(contract.schema)}. ${contract.maxAttempts} submissions total, including missing or host-rejected returns. Research before submitting; after submitting use only workflow_return.`,
    parameters: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
    execute(callId, _normalized, signal) {
      const proposal = calls.get(hostCalls.get(callId) ?? "");
      const reason = signal.aborted ? "Cancelled; no output committed" : (failed?.reason ?? proposal?.error);
      if (proposal === undefined || reason !== undefined)
        return {
          content: [{ type: "text", text: reason ?? "Raw return observation unavailable" }],
          isError: true,
          terminate: true,
        };
      if (accepted !== undefined) accepted.executed = true;
      return {
        terminate: true,
        content: [
          {
            type: "text",
            text: "Value accepted provisionally; whole child completion and storage are required.",
          },
        ],
      };
    },
  };
  return {
    contract,
    sourceIdentity,
    inputIdentity,
    controller: () => ({ tool, acceptance }),
    configure(value) {
      if (!configured) {
        configured = true;
        limits = { ...value };
        startedAt = Date.now();
        if (value.timeoutMs !== undefined) ledger.deadline = startedAt + value.timeoutMs;
      }
    },
    canRetry: () =>
      turns.length === 0 &&
      accepted === undefined &&
      failed === undefined &&
      (ledger.deadline === undefined || Date.now() < ledger.deadline),
    remainingTimeout: () => (ledger.deadline === undefined ? undefined : Math.max(0, ledger.deadline - Date.now())),
    async replay(receipt, text) {
      receipt = verifyWorkflowStructuredReceipt(receipt, text, {
        contract,
        limits,
        sourceIdentity,
        inputIdentity,
        customValidation: validate === undefined ? "absent" : "accepted",
      });
      if (replayHostVersion === undefined || !supportsObservedOutputVersion(await replayHostVersion()))
        throw new Error("output-contract-unavailable: v4 replay requires a verified Pi >=1.0.0 host");
      await initialize();
      try {
        const value = immutableJSON(receipt.value);
        if (
          receipt.schemaSha256 !== schemaSha256 ||
          text !== canonicalWorkflowJSON(value) ||
          schema!.errors(value).length !== 0 ||
          runWorkflowValueValidator(value, validate).length !== 0
        )
          throw new Error("structured value failed revalidation");
        return value;
      } catch (error) {
        throw new Error(`replay-contract-failure: ${String(error)}`);
      }
    },
  };
}
