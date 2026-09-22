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
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { getProjectRoot } from "../_shared/host/pi-api.js";
import { refreshAgents } from "./catalog/catalog.js";
import { registerAgentCommands, warnOnPsCollision } from "./command/command-router.js";
import type { AgentSessionAuthority } from "./fleet/drill-command.js";
import { createAgentFleetMenuController } from "./fleet/fleet-menu-controller.js";
import { installAgentInterruptGuard } from "./fleet/interrupt-guard.js";
import { disposeAgentSessionViewers } from "./fleet/session-viewer.js";
import { registerAgentSpawnTools } from "./tool/task-tool.js";

/** Registers safe catalog commands and fail-closed agent execution tools. */
export default function agents(pi: ExtensionAPI): void {
  let agentSessionEpoch = 0;
  const agentSessionAuthority: AgentSessionAuthority = {
    capture: () => agentSessionEpoch,
    isCurrent: (authority) => authority === agentSessionEpoch,
  };
  const fleetMenu = createAgentFleetMenuController(agentSessionAuthority);
  const fallbackFocusRegistered = registerFleetShortcut(pi, fleetMenu.open);
  // A fresh/reloaded Pi session used to get a fresh module-local store. Preserve
  // that lifecycle now that the store is process-shared across package entrypoints.
  pi.on("session_start", (_event, ctx) => {
    agentSessionEpoch += 1;
    disposeAgentSessionViewers();
    fleetMenu.invalidate();
    agentLiveStore.reset();
    installAgentInterruptGuard(ctx);
    fleetMenuState.setFallbackFocusAvailable(ctx.mode === "tui" && fallbackFocusRegistered);
    // Parent Pi owns bare Up/Down. Fleet entry is explicit via /ps or shift+down.
    fleetMenuState.setEmptyEditorFocusAvailable(false);
    warnOnPsCollision(pi, ctx);
  });
  pi.on("session_shutdown", () => {
    agentSessionEpoch += 1;
    disposeAgentSessionViewers();
    fleetMenu.invalidate();
  });
  // The catalog the caller reads must be current at the moment it picks a name,
  // not at the moment it calls: refresh before the turn, exactly like the other
  // refreshAgents call sites do before a command or a tool body runs.
  pi.on("before_agent_start", (_event, ctx) => {
    refreshAgents(getProjectRoot(ctx));
  });
  registerAgentSpawnTools(pi);
  registerAgentCommands(pi, { openFleetMenu: fleetMenu.open, agentSessionAuthority });
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
