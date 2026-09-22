import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
} from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

const PRODUCER_EXECUTION_KEY = Symbol.for("locus-pi.test.shared-store-producer-execution");
const CONSUMER_EXECUTION_KEY = Symbol.for("locus-pi.test.shared-store-consumer-execution");

export default function sharedStoreConsumer(pi: ExtensionAPI): void {
  pi.registerCommand("test-consume-shared-row", {
    handler: async (_args, ctx) => {
      const execution = (globalThis as unknown as Record<symbol, unknown>)[PRODUCER_EXECUTION_KEY] as
        AgentLiveExecutionHandle | undefined;
      const sameExecution =
        execution !== undefined && agentLiveStore.captureExecutionAuthority("two-entrypoint-row") === execution;
      const cancellation = agentLiveStore.captureCancellationAuthority("two-entrypoint-row");
      const cancelled = cancellation !== undefined && agentLiveStore.cancelWithAuthority(cancellation);
      const input =
        execution === undefined
          ? { ok: false as const }
          : await agentLiveStore.sendInputForExecution(execution, "forward");
      ctx.ui.setWidget("shared-store-proof", [
        sameExecution && cancelled && input.ok
          ? "shared execution, cancellation, and input authority"
          : "shared authority missing",
      ]);
    },
  });
  pi.registerCommand("test-consumer-produce-shared-row", {
    handler: (_args, ctx) => {
      const execution = agentLiveStore.beginExecution({
        id: "consumer-entrypoint-row",
        agentName: "reviewer",
        label: "row from consumer entrypoint",
      });
      (globalThis as unknown as Record<symbol, unknown>)[CONSUMER_EXECUTION_KEY] = execution;
      agentLiveStore.registerCancelForExecution(execution, () => {
        ctx.ui.setWidget("shared-store-reverse-cancel", ["consumer cancellation reached"]);
      });
      agentLiveStore.registerInputForExecution(execution, async (text) => {
        ctx.ui.setWidget("shared-store-reverse-input", [`consumer input reached: ${text}`]);
      });
    },
  });
}
