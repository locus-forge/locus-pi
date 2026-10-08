import { isRecord } from "../agent-live-store.js";
import type { AgentExecutionLedger } from "./agent-output-contract.js";
import { supportsObservedOutputVersion } from "./agent-output-contract.js";
/** Actual SDK lifecycle hooks for opt-in raw output. Legacy sessions never enter this owner. */
import type { SdkAgentSessionLike } from "../agent-sdk-host.js";
import type { AgentResponseAcceptance } from "./agent-output-contract.js";

const CHILD_BUDGET_PREVIOUS = Symbol("child-budget-previous-before-tool");

export class AgentObservedOutputError extends Error {
  readonly failureCause = "output-protocol-unknown" as const;
}

/** Bind actual tool-set readback/restriction and the selected output admission. */
export async function installAgentOutputAdmission(
  session: SdkAgentSessionLike,
  acceptance: AgentResponseAcceptance,
  hostVersion: string | undefined,
): Promise<() => void> {
  const active = session.getActiveToolNames?.();
  if (
    session.setActiveToolsByName === undefined ||
    active === undefined ||
    acceptance.toolNames.some((name) => !active.includes(name))
  )
    throw new Error(
      acceptance.observedReturn !== undefined
        ? "output-contract-unavailable: structured v4 needs a registered return tool and host tool-set readback/restriction"
        : "Transport cannot carry a choice result: same-session output acceptance requires the return tool to be " +
            "registered on the child session plus host tool-set readback (getActiveToolNames) and restriction " +
            "(setActiveToolsByName). This host provides neither, and there is no text fallback. " +
            "Use a plain text call on this transport, or run the choice call on a host that supports it.",
    );
  acceptance.bindToolRestriction(() => restrictAgentOutputTools(session, acceptance));
  return installObservedOutputAdmission(session, acceptance, hostVersion);
}

export function restrictAgentOutputTools(session: SdkAgentSessionLike, acceptance: AgentResponseAcceptance): void {
  session.setActiveToolsByName!([...acceptance.toolNames]);
  const names = session.getActiveToolNames!();
  if (names.length !== acceptance.toolNames.length || acceptance.toolNames.some((name) => !names.includes(name)))
    throw new Error("Child host did not enforce output-only tool restriction");
}

export async function installObservedOutputAdmission(
  session: SdkAgentSessionLike,
  acceptance: AgentResponseAcceptance,
  hostVersion: string | undefined,
): Promise<() => void> {
  const port = acceptance.observedReturn;
  if (port === undefined) return () => {};
  const agent = session.agent;
  const model = session.model as { provider?: unknown; api?: unknown } | undefined;
  if (
    !supportsObservedOutputVersion(hostVersion) ||
    agent === undefined ||
    !["onProviderStreamEvent", "finishTurn", "prepareRequest", "beforeToolCall"].every((key) => key in agent) ||
    ![agent.onProviderStreamEvent, agent.finishTurn, agent.prepareRequest, agent.beforeToolCall].every(
      (hook) => hook === undefined || typeof hook === "function",
    ) ||
    typeof session.abort !== "function" ||
    typeof session.getActiveToolNames !== "function" ||
    typeof session.setActiveToolsByName !== "function" ||
    model?.provider !== "openai-codex" ||
    model.api !== "openai-codex-responses"
  )
    throw new Error(
      "output-contract-unavailable: v4 requires Pi >=1.0.0, the openai-codex Responses route and actual raw/admission/cancellation capabilities",
    );
  const active = session.getActiveToolNames();
  if (!Array.isArray(active) || !active.every((name) => typeof name === "string"))
    throw new Error("Host active-tool readback unavailable");
  const sameTools = (names: string[]): boolean => {
    const readback = session.getActiveToolNames!();
    return (
      Array.isArray(readback) && readback.length === names.length && names.every((name) => readback.includes(name))
    );
  };
  try {
    session.setActiveToolsByName([...acceptance.toolNames]);
    if (!sameTools([...acceptance.toolNames])) throw new Error("Host cannot restrict return tools");
  } finally {
    session.setActiveToolsByName(active);
  }
  if (!sameTools(active)) throw new Error("Host cannot restore original active tools");
  const previous = {
    raw: agent.onProviderStreamEvent,
    prepare: agent.prepareRequest,
    finish: agent.finishTurn,
    before: agent.beforeToolCall,
  };
  const restore = (): void => {
    agent.onProviderStreamEvent = previous.raw;
    agent.prepareRequest = previous.prepare;
    agent.finishTurn = previous.finish;
    agent.beforeToolCall = previous.before;
  };
  const lost = (): never => {
    port.observationLost();
    throw new AgentObservedOutputError("Raw observer replaced or lost after dispatch");
  };
  const raw: NonNullable<typeof agent.onProviderStreamEvent> = async (event, model) => {
    // Caller sees original protocol before a previous callback can mutate the event.
    assertHooks();
    port.providerEvent(event, model);
    await previous.raw?.call(agent, event, model);
    assertHooks();
  };
  const prepare: NonNullable<typeof agent.prepareRequest> = async (context, signal) => {
    assertHooks();
    const inherited = await previous.prepare?.call(agent, context, signal);
    // A prior hook can change the effective model: inspect that actual upcoming request.
    port.beforeRequest(inherited === undefined ? context : { ...(context as object), ...(inherited as object) });
    return inherited;
  };
  const before: NonNullable<typeof agent.beforeToolCall> = async (context, signal) => {
    assertHooks();
    const decision = port.beforeTool(context);
    if (decision?.block === true) return decision;
    const inherited = await previous.before?.call(agent, context, signal);
    assertHooks();
    return inherited;
  };
  const finish: NonNullable<typeof agent.finishTurn> = async (context, signal) => {
    const inherited = await previous.finish?.call(agent, context, signal);
    assertHooks();
    return port.finishTurn(context) ?? inherited;
  };
  const assertHooks = (): void => {
    const actualBefore = agent.beforeToolCall as typeof agent.beforeToolCall & { [CHILD_BUDGET_PREVIOUS]?: unknown };
    if (
      agent.onProviderStreamEvent !== raw ||
      agent.prepareRequest !== prepare ||
      agent.finishTurn !== finish ||
      (actualBefore !== before && actualBefore?.[CHILD_BUDGET_PREVIOUS] !== before)
    )
      lost();
  };
  try {
    agent.onProviderStreamEvent = raw;
    agent.prepareRequest = prepare;
    agent.beforeToolCall = before;
    agent.finishTurn = finish;
    if (
      agent.onProviderStreamEvent !== raw ||
      agent.prepareRequest !== prepare ||
      agent.beforeToolCall !== before ||
      agent.finishTurn !== finish
    )
      throw new Error("Host lifecycle hooks cannot be installed");
    await port.initialize();
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

export function installChildBudgetAdmission(
  session: SdkAgentSessionLike,
  ledger: AgentExecutionLedger,
  budget: {
    maxToolCalls?: number;
    maxAssistantTurns?: number;
    trackToolCalls?: boolean;
    onToolBudgetReached: () => void;
    onTurnBudgetReached: () => void;
  },
): () => void {
  const agent = session.agent;
  if (agent === undefined || typeof agent !== "object") return () => {};
  if (budget.maxToolCalls === undefined && budget.maxAssistantTurns === undefined && budget.trackToolCalls !== true)
    return () => {};
  const previousBeforeToolCall = agent.beforeToolCall;
  const previousShouldStop = agent.shouldStopAfterTurn;
  const maxToolCalls = budget.maxToolCalls;
  const maxAssistantTurns = budget.maxAssistantTurns;
  if (maxToolCalls !== undefined || budget.trackToolCalls === true) {
    agent.beforeToolCall = async (context, abortSignal) => {
      const inherited =
        typeof previousBeforeToolCall === "function"
          ? await previousBeforeToolCall.call(agent, context, abortSignal)
          : undefined;
      if (inherited?.block === true) return inherited;
      if (maxToolCalls !== undefined && ledger.admittedToolCalls >= maxToolCalls) {
        budget.onToolBudgetReached();
        return {
          block: true,
          reason:
            `Child agent reached its ${String(maxToolCalls)} tool-call budget; ` +
            "this call was refused before it ran. Everything already produced is kept.",
          terminate: true,
        };
      }
      ledger.admittedToolCalls += 1;
      return inherited;
    };
  }
  if (maxToolCalls !== undefined || budget.trackToolCalls === true)
    Object.defineProperty(agent.beforeToolCall, CHILD_BUDGET_PREVIOUS, { value: previousBeforeToolCall });
  if (maxAssistantTurns !== undefined) {
    agent.shouldStopAfterTurn = async (context, abortSignal) => {
      const inherited =
        typeof previousShouldStop === "function" ? await previousShouldStop.call(agent, context, abortSignal) : false;
      if (inherited === true) return true;
      if (ledger.assistantTurns < maxAssistantTurns) return false;
      // Only when the loop WOULD continue. A final turn with no tool results ends on its
      // own, and calling this a turn-budget stop there would turn an ordinary completion
      // into a failure.
      const results = isRecord(context) ? context.toolResults : undefined;
      if (!Array.isArray(results) || results.length === 0) return false;
      budget.onTurnBudgetReached();
      return true;
    };
  }
  return () => {
    if (maxToolCalls !== undefined || budget.trackToolCalls === true) agent.beforeToolCall = previousBeforeToolCall;
    if (maxAssistantTurns !== undefined) agent.shouldStopAfterTurn = previousShouldStop;
  };
}
