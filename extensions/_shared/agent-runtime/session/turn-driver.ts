import type { SdkAgentSessionLike } from "../agent-sdk-host.js";
import {
  agentLiveStore,
  eventTypeName,
  eventToolName,
  isRecord,
  type AgentLiveExecutionHandle,
} from "../agent-live-store.js";
import { installChildBudgetAdmission } from "../output-acceptance/agent-output-admission.js";
import { scheduleLongTimeout } from "../../runtime/long-timer.js";

type ChildTurnSettlement = "completed" | "not_dispatched" | "aborted" | "timed_out" | "tool_limit" | "turn_limit";
export interface ChildTurnLedger {
  deadline?: number;
  toolCalls: number;
  /**
   * Tool calls ADMITTED by the pre-dispatch hook, counted independently of the event
   * stream. `tool_execution_start` is emitted before the hook runs, so an event count
   * includes the call this host is about to refuse; admission is the number that decides
   * whether the next tool may run at all.
   */
  admittedToolCalls: number;
  assistantTurns: number;
  toolNames: Set<string>;
}
const SDK_TOOL_EVIDENCE_EVENT_TYPES = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface ChildTurnObservation {
  settlement: ChildTurnSettlement;
  recordedToolNames: string[];
  /**
   * Whether the child was actually dispatched: it emitted at least one event. A `prompt()`
   * that REJECTS (no credentials, no route) leaves by exception instead. This flag covers
   * what returns normally — an abort or timeout that wins while nothing has arrived, or a
   * prompt absorbed before dispatch. Nothing ran then, so no model may be recorded as executed.
   */
  promptAccepted: boolean;
}

/**
 * Prompt the child and wait for its `agent_end`, racing against the abort signal and a
 * wall-clock timeout so neither a hung `prompt()` nor a missing `agent_end` can pin the
 * tool forever.
 */
export async function driveChildTurn(
  session: SdkAgentSessionLike,
  kickoff: string,
  signal: AbortSignal,
  turnBudgetMs: number | undefined,
  maxToolCalls: number | undefined,
  execution: AgentLiveExecutionHandle,
  ledger: ChildTurnLedger = { toolCalls: 0, admittedToolCalls: 0, assistantTurns: 0, toolNames: new Set() },
  maxAssistantTurns?: number,
  observedOutput = false,
  acceptSteering = true,
): Promise<ChildTurnObservation> {
  if (signal.aborted) return { settlement: "aborted", recordedToolNames: [...ledger.toolNames], promptAccepted: false };
  // Subscribe BEFORE prompting so a fast agent_end is never missed.
  let resolveEnd: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  // The SDK invokes this listener on its OWN synchronous, detached emit path
  // (agent loop -> _handleAgentEvent -> _emit), NOT on a promise we await. A throw
  // here would escape every try/catch below and surface as an uncaught exception
  // that kills the host process. So the whole body is guarded: a malformed or late
  // event degrades to a recorded diagnostic, never a crash.
  const recordedToolNames = ledger.toolNames;
  // Set the moment the transport takes the turn — see ChildTurnObservation.
  let promptAccepted = false;
  let resolveToolLimit: () => void = () => {};
  const toolLimited = new Promise<"tool_limit">((resolve) => {
    resolveToolLimit = () => resolve("tool_limit");
  });
  let resolveTurnLimit: () => void = () => {};
  const turnLimited = new Promise<"turn_limit">((resolve) => {
    resolveTurnLimit = () => resolve("turn_limit");
  });
  // Admission BEFORE dispatch. The event counters below stay as they are — they are the
  // evidence, and the settlement they resolve is unchanged — but on their own they only
  // learn about the over-budget action once the child has already taken it. These hooks
  // refuse the next one instead: the (N+1)-th tool never executes, and the turn after the
  // last declared one is never generated. The named budget stop and everything received
  // so far are untouched either way.
  const restoreAdmission = installChildBudgetAdmission(session, ledger, {
    ...(observedOutput ? { trackToolCalls: true } : {}),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(maxAssistantTurns === undefined ? {} : { maxAssistantTurns }),
    onToolBudgetReached: () => resolveToolLimit(),
    onTurnBudgetReached: () => resolveTurnLimit(),
  });
  const unsubscribe = session.subscribe((event) => {
    try {
      // An event from the child is proof it is live, even if `prompt()` has not
      // settled yet: a host whose prompt promise only resolves at turn end would
      // otherwise look like a turn that never started.
      promptAccepted = true;
      const toolName = sdkToolEventName(event);
      if (toolName !== undefined) recordedToolNames.add(toolName);
      if (eventTypeName(event) === "tool_execution_start") {
        ledger.toolCalls += 1;
        if (maxToolCalls !== undefined && ledger.toolCalls > maxToolCalls) resolveToolLimit();
      }
      if (eventTypeName(event) === "turn_start" && !observedOutput) {
        ledger.assistantTurns += 1;
        if (maxAssistantTurns !== undefined && ledger.assistantTurns > maxAssistantTurns) resolveTurnLimit();
      }
      agentLiveStore.feedExecutionEvent(execution, event);
      // Pi emits `agent_end` after each model cycle, including a cycle followed
      // by queued steering input. The SDK prompt still owns the live run until
      // it settles, so keep the row active here; the terminal result path below
      // applies the genuine final status after prompt() returns.
      if (eventTypeName(event) === "agent_end" && session.isStreaming === true) {
        agentLiveStore.patchExecution(execution, { status: "working" });
      }
      if (isRecord(event) && event.type === "agent_end" && event.willRetry !== true) resolveEnd();
    } catch {
      // A malformed/late event must not crash the host from the SDK's emit path.
      // The genuine failure is still surfaced through the turn's timeout/abort and
      // the failedResult mapping; this guard only prevents an out-of-band throw.
    }
  });
  const unregisterInput =
    acceptSteering && "isStreaming" in session
      ? agentLiveStore.registerInputForExecution(
          execution,
          async (text) => {
            if (session.isStreaming !== true) throw new Error("Agent turn is no longer accepting input.");
            await session.prompt(text, {
              source: "locus-pi-agent-viewer",
              streamingBehavior: "steer",
            });
          },
          () => session.isStreaming === true,
        )
      : () => {};

  let cancelTimer: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // No budget, no timer: an undeclared wall clock is unbounded, never a
    // zero-delay abort. A budget above Node's maximum delay is a chain of
    // representable waits, never a clamp to one millisecond.
    const timedOut = new Promise<"timed_out">((resolve) => {
      if (turnBudgetMs !== undefined) {
        cancelTimer = scheduleLongTimeout(turnBudgetMs, () => resolve("timed_out"), "childTimeoutMs");
      }
    });
    // Pi settles prompt() only after the whole agent run. Settling with no child event means an
    // input handler or extension command absorbed the prompt, and agent_end will never come.
    const completed = (async (): Promise<"completed" | "not_dispatched"> => {
      await session.prompt(kickoff, { source: "locus-pi-agent-sdk-host" });
      if (!promptAccepted) return "not_dispatched";
      await ended;
      return "completed";
    })();
    const settlement = await Promise.race([completed, aborted, timedOut, toolLimited, turnLimited]);
    return { settlement, recordedToolNames: [...recordedToolNames].sort(), promptAccepted };
  } finally {
    unregisterInput();
    unsubscribe();
    restoreAdmission();
    cancelTimer?.();
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function sdkToolEventName(event: unknown): string | undefined {
  if (!SDK_TOOL_EVIDENCE_EVENT_TYPES.has(eventTypeName(event))) return undefined;
  return eventToolName(event)?.trim() || undefined;
}
