import { loadActivityLimit } from "./fleet/activity-settings.js";
import { activityStore } from "../_shared/agent-runtime/activity-store.js";
import { installCommandCenterEditor } from "./fleet/command-center-editor.js";
import { shutdownAgentCommands } from "./run/run-launcher.js";
import { AgentScreenController } from "./fleet/agent-screen-controller.js";
/**
 * extensions/agents/index.ts — Extension entrypoint.
 *
 * Registers the `spawn_agent` tool,
 * and the `/ps` and `/agent` commands, and owns the per-session wiring those
 * surfaces share: the session epoch a drill leases against, the fleet-menu
 * controller, and the fallback focus shortcut.
 */
import { agentLiveStore } from "../_shared/agent-runtime/agent-live-store.js";
import { FLEET_FOCUS_FALLBACK_SHORTCUT, fleetMenuState } from "../_shared/agent-runtime/fleet-menu.js";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "../_shared/host/pi-api.js";
import { getProjectRoot } from "../_shared/host/pi-api.js";
import { refreshAgents, refreshModelRoleHint } from "./catalog/catalog.js";
import { registerAgentCommands, warnOnPsCollision } from "./command/command-router.js";
import type { AgentSessionAuthority } from "./fleet/drill-command.js";
import { createAgentFleetMenuController } from "./fleet/fleet-menu-controller.js";
import { installAgentInterruptGuard } from "./fleet/interrupt-guard.js";
import { disposeAgentSessionViewers } from "./fleet/session-viewer.js";
import { registerAgentSpawnTools } from "./tool/task-tool.js";

/** Registers safe catalog commands and fail-closed agent execution tools. */
export default function agents(pi: ExtensionAPI): void {
  let agentSessionEpoch = 0;
  let screen = new AgentScreenController();
  let stopCenterBindings = () => {};
  const agentSessionAuthority: AgentSessionAuthority = {
    capture: () => agentSessionEpoch,
    isCurrent: (authority) => authority === agentSessionEpoch,
  };
  const fleetMenu = createAgentFleetMenuController(agentSessionAuthority);
  const fallbackFocusRegistered = registerFleetShortcut(pi, (ctx) =>
    agentLiveStore.retainSessions ? screen.open(ctx) : fleetMenu.open(ctx),
  );
  // A fresh/reloaded Pi session used to get a fresh module-local store. Preserve
  // that lifecycle now that the store is process-shared across package entrypoints.
  pi.on("session_start", async (_event, ctx) => {
    screen.close(true);
    screen = new AgentScreenController();
    stopCenterBindings();
    agentSessionEpoch += 1;
    disposeAgentSessionViewers();
    fleetMenu.invalidate();
    await shutdownAgentCommands();
    await agentLiveStore.shutdownAgents();
    agentLiveStore.reset();
    agentLiveStore.retainSessions = ctx.mode === "tui" && ctx.hasUI === true;
    installAgentInterruptGuard(ctx);
    fleetMenuState.setFallbackFocusAvailable(ctx.mode === "tui" && fallbackFocusRegistered);
    // Parent Pi owns bare Up/Down. Fleet entry is explicit via /ps or shift+down.
    fleetMenuState.setEmptyEditorFocusAvailable(false);
    warnOnPsCollision(pi, ctx);
    try {
      activityStore.setMaxItems(await loadActivityLimit(getProjectRoot(ctx)));
    } catch (error) {
      activityStore.setMaxItems(4);
      ctx.ui.notify(`Agent UI settings: ${String(error)}`, "warning");
    }
    activityStore.capture();
    stopCenterBindings = agentLiveStore.retainSessions
      ? installCommandCenterEditor(ctx, () => {
          void screen.open(ctx).catch((error) => ctx.ui.notify(String(error), "error"));
        })
      : () => {};
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopCenterBindings();
    screen.close(true);
    disposeAgentSessionViewers();
    fleetMenu.invalidate();
    try {
      await shutdownAgentCommands();
      await agentLiveStore.shutdownAgents();
    } catch (error) {
      ctx.ui.notify(`Agent shutdown failed: ${String(error)}`, "error");
    } finally {
      agentSessionEpoch += 1;
      disposeAgentSessionViewers();
      fleetMenu.invalidate();
    }
  });
  // The catalog the caller reads must be current at the moment it picks a name,
  // not at the moment it calls: refresh before the turn, exactly like the other
  // refreshAgents call sites do before a command or a tool body runs.
  pi.on("before_agent_start", async (_event, ctx) => {
    refreshAgents(getProjectRoot(ctx));
    await refreshModelRoleHint(getProjectRoot(ctx));
  });
  pi.registerCommand("exit", {
    description: "Exit main and stop every agent (inside an agent: exit only that agent).",
    handler: async (_args, ctx) => {
      screen.close();
      const command = ctx as ExtensionCommandContext;
      const mainActive = !ctx.isIdle();
      if (mainActive && (ctx.abort === undefined || command.waitForIdle === undefined)) {
        ctx.ui.notify("Cannot confirm main shutdown: abort/waitForIdle is unavailable.", "error");
        return;
      }
      // Pi's shutdown() only requests exit; it does not interrupt a streaming main.
      // Abort first, then join main and child cleanup before asking the host to exit.
      if (mainActive) ctx.abort?.();
      const settled = await Promise.allSettled([
        mainActive ? command.waitForIdle!() : Promise.resolve(),
        shutdownAgentCommands(),
        agentLiveStore.shutdownAgents(),
      ]);
      for (const result of settled) {
        if (result.status === "rejected") ctx.ui.notify(`Agent shutdown failed: ${String(result.reason)}`, "error");
      }
      ctx.shutdown?.();
    },
  });
  registerAgentSpawnTools(pi);
  registerAgentCommands(pi, {
    openFleetMenu: fleetMenu.open,
    agentSessionAuthority,
    openAgentScreen: (ctx, target) => screen.open(ctx, target),
  });
}

function registerFleetShortcut(pi: ExtensionAPI, handler: (ctx: ExtensionContext) => Promise<void>): boolean {
  const registerShortcut = pi.registerShortcut;
  if (registerShortcut === undefined) {
    return false;
  }
  try {
    registerShortcut.call(pi, FLEET_FOCUS_FALLBACK_SHORTCUT, {
      description: "Focus the agent fleet menu (fallback when the editor is not empty-editor aware)",
      handler,
    });
    return true;
  } catch {
    return false;
  }
}
