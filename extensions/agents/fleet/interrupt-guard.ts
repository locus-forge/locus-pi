import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import { isEscapePress, routeFocusedEscape } from "../../_shared/operator/command-ui.js";
import { getProjectRoot, getSessionId, type ExtensionContext } from "../../_shared/host/pi-api.js";
import { workflowBackgroundRunRegistry } from "../../workflows/run/background-run-registry.js";

const guardByUi = new WeakMap<object, () => void>();

/** Intercept Pi's global app.interrupt Escape only while a visible agent run is active. */
export function installAgentInterruptGuard(ctx: ExtensionContext): void {
  guardByUi.get(ctx.ui)?.();
  guardByUi.delete(ctx.ui);
  if (
    ctx.mode !== "tui" ||
    ctx.hasUI !== true ||
    typeof ctx.abort !== "function" ||
    typeof ctx.ui.onTerminalInput !== "function"
  )
    return;

  let confirmationOpen = false;
  const sessionId = getSessionId(ctx);
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (guardByUi.get(ctx.ui) !== unsubscribe || getSessionId(ctx) !== sessionId || !isEscapePress(data))
      return undefined;
    const activeRows = activeAgentRows();
    const hasActiveWorkflow = workflowBackgroundRunRegistry().hasActiveSession(getProjectRoot(ctx), sessionId);
    if (ctx.isIdle() || (activeRows.length === 0 && !hasActiveWorkflow)) return undefined;
    if (routeFocusedEscape(ctx)) return { consume: true };
    if (confirmationOpen) return { consume: true };
    // Workflow cancellation is command-only. Consume the host interrupt key so
    // inspecting or returning from a workflow surface cannot abort its turn.
    if (hasActiveWorkflow || activeRows.some((row) => row.workflowRunId !== undefined)) return { consume: true };

    confirmationOpen = true;
    const activeCount = activeRows.length;
    void ctx.ui
      .confirm(
        "Interrupt agent operation?",
        `This will request cancellation for ${activeCount} active agent${activeCount === 1 ? "" : "s"}. Continue?`,
      )
      .then((confirmed) => {
        confirmationOpen = false;
        if (!confirmed) {
          ctx.ui.notify("Agent operation continues.", "info");
          return;
        }
        for (const row of activeRows) agentLiveStore.cancel(row.id);
        ctx.abort?.();
        ctx.ui.notify("Agent cancellation requested.", "warning");
      })
      .catch(() => {
        confirmationOpen = false;
        ctx.ui.notify("Agent operation continues; confirmation could not be opened.", "warning");
      });
    return { consume: true };
  });
  guardByUi.set(ctx.ui, unsubscribe);
}

function activeAgentRows() {
  return [...agentLiveStore.rows.values()].filter((row) => row.status === "working" || row.status === "queued");
}
