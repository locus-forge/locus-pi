import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import { hasDismissibleCommandView } from "../../_shared/operator/command-ui.js";
import { fleetMenuState } from "../../_shared/agent-runtime/fleet-menu.js";
import { getProjectRoot, getSessionId, type ExtensionContext } from "../../_shared/host/pi-api.js";
import { workflowBackgroundRunRegistry } from "../../workflows/run/background-run-registry.js";
import { hasActiveAgentSessionViewer } from "./session-viewer.js";

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
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!isEscapeInput(data) || confirmationOpen) return undefined;
    const activeRows = activeAgentRows();
    const hasActiveWorkflow = workflowBackgroundRunRegistry().hasActiveSession(getProjectRoot(ctx), getSessionId(ctx));
    if (ctx.isIdle() || (activeRows.length === 0 && !hasActiveWorkflow)) return undefined;
    // These surfaces own Escape as "close/back". Let their component or the
    // shared transient-view listener consume it; closing a view never aborts.
    if (fleetMenuState.focused || hasActiveAgentSessionViewer() || hasDismissibleCommandView(ctx)) return undefined;
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

function isEscapeInput(data: string): boolean {
  return data === "escape" || data === "\u001b";
}
