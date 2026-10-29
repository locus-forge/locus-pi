import { agentLiveStore, type AgentLiveExecutionHandle } from "../agent-live-store.js";

export interface RetainedSession {
  dispose(): void;
  abort?(): Promise<void>;
  getLastAssistantText(): string | undefined;
}

export class AgentSessionUnsettledError extends Error {}

/** A settled assignment may leave an idle agent; its accepted result is never edited. */
export function retainAgentSession(
  execution: AgentLiveExecutionHandle,
  session: RetainedSession,
  run: (text: string, signal: AbortSignal) => Promise<void>,
): void {
  let exited = false;
  let pending: Promise<void> | undefined;
  let unavailable = false;
  let controller: AbortController | undefined;
  let unregisterLifetime = () => {};
  const unregisterInput = agentLiveStore.registerInputForExecution(
    execution,
    async (text) => {
      if (exited || unavailable || pending !== undefined) throw new Error("Agent is busy or exited.");
      controller = new AbortController();
      agentLiveStore.patchExecution(execution, { status: "working" });
      pending = (async () => {
        try {
          await run(text, controller!.signal);
          if (!exited)
            agentLiveStore.patchExecution(execution, {
              status: controller!.signal.aborted ? "cancelled" : "done",
              ...(session.getLastAssistantText() === undefined ? {} : { finalAnswer: session.getLastAssistantText()! }),
            });
        } catch (error) {
          if (error instanceof AgentSessionUnsettledError) unavailable = true;
          if (!exited) agentLiveStore.patchExecution(execution, { status: "error", errors: [String(error)] });
          throw error;
        } finally {
          pending = undefined;
          controller = undefined;
        }
      })();
      await pending;
    },
    () => !exited && !unavailable && pending === undefined,
  );
  const unregisterCancel = agentLiveStore.registerCancelForExecution(execution, () => controller?.abort());
  unregisterLifetime = agentLiveStore.registerAgentLifetime(execution, async () => {
    if (exited) return;
    exited = true;
    unregisterInput();
    unregisterCancel();
    unregisterLifetime();
    controller?.abort();
    try {
      await pending;
    } finally {
      session.dispose();
    }
    if (unavailable)
      throw new AgentSessionUnsettledError("Agent session disposed; abort settlement remained unconfirmed.");
  });
}
