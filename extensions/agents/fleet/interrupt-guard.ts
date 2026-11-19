import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import { registerEscapeWork } from "../../_shared/operator/command-ui.js";
import { getProjectRoot, getSessionId, type ExtensionContext } from "../../_shared/host/pi-api.js";
import { workflowBackgroundRunRegistry } from "../../workflows/run/background-run-registry.js";

/** Intercept Pi's global app.interrupt Escape only while a visible agent run is active. */
export function installAgentInterruptGuard(ctx: ExtensionContext): void {
  if (
    ctx.mode !== "tui" ||
    ctx.hasUI !== true ||
    typeof ctx.abort !== "function" ||
    typeof ctx.ui.onTerminalInput !== "function"
  )
    return;

  let confirmationOpen = false;
  const sessionId = getSessionId(ctx);
  registerEscapeWork(ctx, "agents", () => {
    const activeRows = activeAgentRows();
    const workflowBusy =
      workflowBackgroundRunRegistry().hasActiveSession(getProjectRoot(ctx), sessionId) ||
      activeRows.some((row) => row.workflowRunId !== undefined);
    if (workflowBusy || confirmationOpen) return { busy: true };
    if (activeRows.length === 0) return { busy: false };

    return {
      busy: true,
      confirmInterrupt() {
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
      },
    };
  });
}

function activeAgentRows() {
  return [...agentLiveStore.rows.values()].filter((row) => row.status === "working" || row.status === "queued");
}
