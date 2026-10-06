import { NativeWorkflowResponse, sameNativeWorkflowRoute } from "./native-response.js";
import type { AgentNativeRoute } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";
import {
  verifyWorkflowStructuredReceipt,
  verifyWorkflowRawTerminal,
  verifyWorkflowRawToolItem,
  workflowRawRefusal,
  createWorkflowStructuredReceipt,
  workflowStructuredSourceIdentities,
  revalidateWorkflowStructuredValue,
  type WorkflowStructuredRawTurn,
} from "./receipt.js";
import { supportsObservedOutputVersion } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";
/** V4 proposal/terminal owner. One instance belongs to one logical call across physical attempts. */
import type {
  AgentResponseAcceptance,
  AgentExecutionLedger,
  AgentFailureCause,
} from "../../../_shared/agent-runtime/agent-runner.js";
import type { ReadOnlyAgentCustomTool } from "../../../_shared/agent-runtime/agent-read-only-policy.js";
import {
  compileWorkflowSchema,
  workflowStructuredSchemaDigest,
  decodeWorkflowProposal,
  validateWorkflowProposal,
  WORKFLOW_RAW_OBSERVER_REVISION,
  type WorkflowJSONValue,
  type WorkflowStructuredContract,
  type WorkflowValueValidator,
  type WorkflowSchemaValidator,
} from "./schema.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
import type { WorkflowStructuredCall, WorkflowStructuredSourceIdentity } from "../workflow-agent-contract.js";
export type { WorkflowStructuredCall, WorkflowStructuredSourceIdentity } from "../workflow-agent-contract.js";

export function createWorkflowStructuredCall(
  contract: WorkflowStructuredContract,
  validate?: WorkflowValueValidator,
  identity?: WorkflowStructuredSourceIdentity,
  replayHostVersion?: () => Promise<string | undefined>,
  replayRoute?: () => Promise<AgentNativeRoute>,
): WorkflowStructuredCall {
  const native = contract.version === 5;
  const nativeResponse = native ? new NativeWorkflowResponse(contract.schema) : undefined;
  const ledger: AgentExecutionLedger = { toolCalls: 0, admittedToolCalls: 0, assistantTurns: 0, toolNames: new Set() };
  const { sourceIdentity, inputIdentity } = workflowStructuredSourceIdentities(identity);
  const turns: WorkflowStructuredRawTurn[] = [];
  const hostCalls = new Map<string, string>();
  const calls = new Map<string, { raw: string } & ReturnType<typeof propose>>();
  let turn: WorkflowStructuredRawTurn | undefined;
  let schema: WorkflowSchemaValidator | undefined;
  let schemaSha256 = "";
  let attempts = 0;
  let accepted: { canonical: string; value: WorkflowJSONValue; executed: boolean } | undefined;
  let failed: { reason: string; failureCause: AgentFailureCause } | undefined;
  let lastError = native ? "Native output was not provided" : "workflow_return was not called";
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
    if (schemaSha256 === "") schemaSha256 = await workflowStructuredSchemaDigest(contract.schema);
    await nativeResponse?.initialize();
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
    const proposal = propose(raw);
    calls.set(callId, { raw, ...proposal });
  }
  function propose(raw: string) {
    let value: WorkflowJSONValue | undefined;
    let canonical: string | undefined;
    let error: string | undefined;
    try {
      ({ value, canonical } = decodeWorkflowProposal(raw));
    } catch (reason) {
      error = `Invalid raw ${native ? "native output" : "workflow_return"}: ${String(reason)}`;
    }
    if (accepted !== undefined) {
      if (error !== undefined || canonical !== accepted.canonical)
        fail("Conflicting output after an accepted value", "output-contract-conflict");
      return {
        validation: "duplicate" as const,
        ...(error === undefined ? {} : { error }),
      };
    }
    attempts++;
    if (attempts > contract.maxAttempts) fail("Return submission exceeded its allowance", "output-contract-exhausted");
    if (error === undefined && failed === undefined) {
      try {
        error = validateWorkflowProposal(value!, schema!, validate);
      } catch (reason) {
        fail(String(reason), "author-validation-error");
        error = String(reason);
      }
    }
    if (failed !== undefined) error ??= failed.reason;
    if (error === undefined) accepted = { canonical: canonical!, value: value!, executed: false };
    else {
      lastError = error;
      exhaust();
    }
    return {
      validation: error === undefined ? ("accepted" as const) : ("rejected" as const),
      ...(error === undefined ? {} : { error }),
    };
  }
  function finalizedItem(item: Record<string, unknown>, finalItem = false): void {
    const proof = verifyWorkflowRawToolItem(item, turn!, turns, finalItem);
    if ("failureCause" in proof) fail(proof.reason, proof.failureCause);
    else {
      Object.assign(proof.identity, proof.evidence);
      if (proof.identity.name !== "workflow_return") turn!.workTools = true;
    }
  }
  function reconcileTerminal(output: unknown): void {
    if (turn === undefined) return;
    const mismatch = verifyWorkflowRawTerminal(output, turn.items);
    if (mismatch !== undefined) fail(mismatch.reason, mismatch.failureCause);
    if (failed !== undefined || turn.terminal === "completed") return;
    const returns = [...turn.items.values()].filter((item) => item.name === "workflow_return");
    if (turn.workTools && returns.length > 0) {
      // Classify the whole batch before validating any return or dispatching siblings.
      restrict?.();
      turn.rejectedBatch = "workflow_return must be the only tool in its submission batch";
      attempts++;
      for (const item of returns) {
        turn.calls.set(item.callId, item.arguments!);
        calls.set(item.callId, { raw: item.arguments!, validation: "rejected", error: turn.rejectedBatch });
      }
      lastError = turn.rejectedBatch;
      exhaust();
    } else {
      for (const item of returns) finalized(item.callId, item.name, item.arguments);
    }
  }
  function observeAddedTool(item: Record<string, unknown>): void {
    if (
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.call_id !== "string" ||
      item.call_id === "" ||
      typeof item.name !== "string" ||
      item.name === ""
    ) {
      fail("Raw executable tool identity unavailable", "output-protocol-unknown");
      return;
    }
    // Pi's exact host id and the raw call id must each identify one executable item.
    const hostId = `${item.call_id}|${item.id}`;
    if (turn!.items.has(item.id) || hostCalls.has(hostId) || [...hostCalls.values()].includes(item.call_id)) {
      fail("Repeated or ambiguous executable tool identity", "output-protocol-unknown");
      return;
    }
    turn!.items.set(item.id, { name: item.name, callId: item.call_id });
    hostCalls.set(hostId, item.call_id);
  }
  function providerEvent(event: unknown, model: unknown): void {
    nativeResponse?.route(model);
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
    const nativeFailure = nativeResponse?.capture(data, turn.responseId);
    if (nativeFailure !== undefined) fail(nativeFailure.reason, nativeFailure.failureCause);
    if (type === "response.output_item.added" && item?.type === "function_call") observeAddedTool(item);
    if (type === "response.function_call_arguments.done") {
      const identity = typeof data.item_id === "string" ? turn.items.get(data.item_id) : undefined;
      if (identity === undefined) fail("Finalized arguments lack observed call identity", "output-protocol-unknown");
      else if (!native)
        finalizedItem({ id: data.item_id, name: identity.name, call_id: identity.callId, arguments: data.arguments });
    }
    if (type === "response.output_item.done" && item?.type === "function_call") {
      if (!native) finalizedItem(item, true);
      else turn.workTools = true;
    }
    if (type === "response.incomplete" || response?.status === "incomplete")
      fail("Provider output incomplete", "output-incomplete");
    if (type === "response.failed" || type === "error" || response?.status === "failed")
      fail("Provider raw error", "provider-error");
    if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      if (turn.responseId === "" || response?.id !== turn.responseId || response?.status !== "completed") {
        if (failed === undefined) fail("Unknown raw terminal response", "output-protocol-unknown");
      } else {
        const output = response.output;
        if (!native) reconcileTerminal(output);
        else if (workflowRawRefusal(output)) fail("Provider refused structured output", "output-refused");
        if (turn.terminal === "completed") return;
        turn.terminal = "completed";
        if (native) completeNative(output);
      }
    }
  }
  function completeNative(output: unknown): void {
    const observed = turn!.native!;
    if (observed.payload === undefined) fail("Native payload observation unavailable", "output-protocol-unknown");
    if (failed !== undefined) return;
    if (turn!.workTools && attempts === 0) {
      observed.validation = "research";
      return;
    }
    restrict?.();
    try {
      const message = turn!.workTools ? undefined : nativeResponse!.final(output);
      observed.validation = "rejected";
      if (message === undefined) {
        attempts++;
        lastError = turn!.workTools
          ? "Work tools are forbidden after native submission"
          : "Native output was not provided";
        exhaust();
      } else {
        observed.output = message;
        if (propose(message.text).validation === "accepted") observed.validation = "accepted";
      }
    } catch (error) {
      fail(String(error), "output-protocol-unknown");
    }
  }

  const acceptance: AgentResponseAcceptance = {
    executionLedger: ledger,
    toolNames: native ? [] : ["workflow_return"],
    bindToolRestriction: (callback) => {
      restrict = callback;
    },
    observedReturn: {
      ...(native
        ? {
            native: {
              route(model: unknown) {
                nativeResponse!.route(model);
              },
              payload(payload: unknown, model: unknown) {
                if (turn === undefined) throw new Error("output-contract-unavailable: native payload lacks request");
                try {
                  const formatted = nativeResponse!.payload(payload, model, attempts > 0);
                  turn.native!.payload = formatted.observation;
                  return formatted.value;
                } catch (error) {
                  fail(String(error), "output-contract-unavailable");
                  throw error;
                }
              },
              sessionEvent(event: unknown) {
                nativeResponse!.sessionEvent(event, turn?.responseId ?? "");
              },
            },
          }
        : {}),
      observationLost: () => fail("Raw observer replaced or lost after dispatch", "output-protocol-unknown"),
      initialize,
      beforeRequest(context) {
        const model = record(record(context)?.model);
        if (native) nativeResponse!.route(model);
        else if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses")
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
        turn = {
          workTools: false,
          responseId: "",
          calls: new Map(),
          items: new Map(),
          ...(native ? { native: {} } : {}),
        };
        turns.push(turn);
      },
      providerEvent,
      beforeTool(context) {
        if (failed !== undefined) return { block: true, terminate: true, reason: failed.reason };
        if (turn?.rejectedBatch !== undefined) return { block: true, terminate: true, reason: turn.rejectedBatch };
        const data = record(context);
        const toolCall = record(data?.toolCall);
        if (
          !native &&
          toolCall?.name === "workflow_return" &&
          (typeof toolCall.id !== "string" || !calls.has(hostCalls.get(toolCall.id) ?? ""))
        ) {
          fail("Host tool lacks raw finalized return observation", "output-protocol-unknown");
          return { block: true, terminate: true, reason: failed!.reason };
        }
        if (turn?.terminal !== "completed")
          return { block: true, terminate: true, reason: "No completed raw response" };
        if (attempts > 0 && (native || toolCall?.name !== "workflow_return"))
          return {
            block: true,
            terminate: true,
            reason: native
              ? "Work tools are forbidden after native submission"
              : "Only workflow_return permitted after submission",
          };
        return undefined;
      },
      finishTurn(context) {
        try {
          nativeResponse?.finish(context, turn?.responseId ?? "");
        } catch (error) {
          fail(String(error), "output-protocol-unknown");
        }
        if (turn?.terminal !== "completed")
          fail("Raw terminal observation lost or disconnected", "output-protocol-unknown");
        if (
          !native &&
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
      if (nativeResponse !== undefined) {
        try {
          nativeResponse.assertHistory();
        } catch (error) {
          fail(String(error), "output-protocol-unknown");
        }
      }
      if (accepted !== undefined && ledger.deadline !== undefined && Date.now() >= ledger.deadline)
        fail("Structured logical deadline exhausted", "call-timeout");
      if (!native && accepted !== undefined && !accepted.executed)
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
          prompt: `${lastError}. Correct ${native ? "the native {value: JSONValue} answer" : "workflow_return"} only using existing evidence; do not repeat external effects.`,
        };
      const receipt = createWorkflowStructuredReceipt({
        contract,
        schemaSha256,
        sourceIdentity,
        inputIdentity,
        value: accepted.value,
        limits,
        ledger,
        attempts,
        callValidation: (callId) => calls.get(callId)!.validation,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        turns,
        customValidation: validate === undefined ? "absent" : "accepted",
      });
      return {
        status: "accepted",
        text: accepted.canonical,
        attempts,
        ...(native ? {} : { toolName: "workflow_return" }),
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
    controller: () => ({ ...(native ? {} : { tool }), acceptance }),
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
        throw new Error(`output-contract-unavailable: v${contract.version} replay requires a verified Pi >=1.0.0 host`);
      await initialize();
      if (native) {
        if (replayRoute === undefined) throw new Error("replay-contract-failure: fresh native route unavailable");
        const current = await replayRoute();
        if (
          receipt.version !== 5 ||
          receipt.rawTurns.some(
            (turn) =>
              !sameNativeWorkflowRoute(current, turn.payload.route) ||
              turn.payload.wireSchemaSha256 !== nativeResponse!.wireSchemaSha256,
          )
        )
          throw new Error("replay-contract-failure: native route or wire schema changed");
      }
      return revalidateWorkflowStructuredValue(receipt, text, schemaSha256, schema!, validate);
    },
  };
}
