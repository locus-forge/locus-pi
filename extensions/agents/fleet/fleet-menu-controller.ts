/**
 * extensions/agents/fleet/fleet-menu-controller.ts — the interactive fleet (`/ps` with no
 * target). Owns the per-session ownership epoch that keeps a late menu result from
 * acting on a reloaded session, and the open → select → drill → back → select loop.
 */
import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import {
  FleetFocusComponent,
  fleetMenuState,
  isFleetRowStoppable,
  selectFleetMenuRows,
} from "../../_shared/agent-runtime/fleet-menu.js";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../../_shared/operator/operator-interaction.js";
import type { ExtensionCommandContext, ExtensionContext } from "../../_shared/host/pi-api.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import { coerceTheme } from "../../_shared/host/render-profile.js";
import { executeAgentDrillCommand, type AgentSessionAuthority } from "./drill-command.js";
import { AGENTS_WIDGET_KEY, notifyActiveAgentsContinue, notifyInteractionEnded } from "../operator/operator-surface.js";

export interface AgentFleetMenuController {
  /** Open the fleet for this session, replacing any menu an earlier open still owns. */
  open(ctx: ExtensionContext): Promise<void>;
  /** Drop ownership of any open menu — a session start/shutdown must not leave one live. */
  invalidate(): void;
}

export function createAgentFleetMenuController(agentSessionAuthority: AgentSessionAuthority): AgentFleetMenuController {
  const fleetFocusComponents = new Set<FleetFocusComponent>();
  let fleetMenuEpoch = 0;
  let currentFleetMenuOwner: symbol | undefined;
  const invalidateFleetMenuOwnership = (): void => {
    fleetMenuEpoch += 1;
    currentFleetMenuOwner = undefined;
    // `close()`, not `dispose()`: a session reset that only disposed the live
    // menu left Pi holding a dead surface in its single editor slot and the
    // `/ps` handler awaiting a promise nobody could settle — which stopped Pi's
    // input loop from dispatching any later command for the rest of the session.
    for (const component of fleetFocusComponents) component.close();
    fleetFocusComponents.clear();
    fleetMenuState.setFocused(false);
    fleetMenuState.setVisibleRows([]);
  };
  const open = async (ctx: ExtensionContext): Promise<void> => {
    invalidateFleetMenuOwnership();
    const owner = Symbol("fleet-menu-owner");
    const epoch = fleetMenuEpoch;
    currentFleetMenuOwner = owner;
    const release = (): boolean => {
      if (currentFleetMenuOwner !== owner || fleetMenuEpoch !== epoch) return false;
      currentFleetMenuOwner = undefined;
      return true;
    };
    const finish = (): void => {
      if (!release()) return;
      fleetMenuState.setFocused(false);
      fleetMenuState.setVisibleRows([]);
    };
    const ownership = {
      isCurrent: () => currentFleetMenuOwner === owner && fleetMenuEpoch === epoch,
      finish,
    };
    try {
      let initialRowId: string | undefined;
      for (;;) {
        const outcome = await openFleetMenu(ctx, fleetFocusComponents, ownership, agentSessionAuthority, initialRowId);
        if (outcome === undefined) return;
        // The drill released ownership before it opened (the agent screen must
        // own the passive panel alone), so the loop reclaims it here. A reload
        // or a competing `/ps` moved the epoch on: that session is gone and the
        // operator gets no menu back.
        if (fleetMenuEpoch !== epoch) return;
        currentFleetMenuOwner = owner;
        initialRowId = outcome.drilledRowId;
      }
    } finally {
      finish();
    }
  };
  return { open, invalidate: invalidateFleetMenuOwnership };
}

/** What the caller must do next: nothing, or reopen the menu on the row just drilled. */
interface FleetMenuOutcome {
  drilledRowId: string;
}

async function openFleetMenu(
  ctx: ExtensionContext,
  fleetFocusComponents: Set<FleetFocusComponent>,
  ownership: { isCurrent(): boolean; finish(): void },
  agentSessionAuthority: AgentSessionAuthority,
  initialRowId?: string,
): Promise<FleetMenuOutcome | undefined> {
  if (ctx.mode !== "tui") {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent fleet focus",
      primary: `Interactive focus is unavailable in ${ctx.mode ?? "unknown"} mode.`,
      metadata: ["Passive agent rows remain available."],
      controls: ["Inspect: /agent observe · Drill: /agent drill <row-id|agent|last>"],
    });
    return;
  }
  if (ctx.hasUI !== true || ctx.ui.custom === undefined) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent fleet focus",
      primary: "This Pi TUI host does not expose custom UI.",
      metadata: ["Passive agent rows remain available."],
      controls: ["Inspect: /agent observe · Drill: /agent drill <row-id|agent|last>"],
    });
    return;
  }
  const rows = () => [...agentLiveStore.rows.values()];
  const initialRows = selectFleetMenuRows(rows());
  if (initialRows.length === 0) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "VIEW",
      subject: "Agent fleet",
      primary: "No live agent rows.",
      controls: ["Catalog: /agent list"],
    });
    // A widget alone is easy to miss under a live workflow panel, and an
    // operator who sees nothing at all reads it as a broken command.
    ctx.ui.notify("/ps found no live agent rows.", "warning");
    return;
  }
  fleetMenuState.beginFocus(rows(), initialRowId);
  fleetMenuState.setFocused(true);
  let component: FleetFocusComponent | undefined;
  const disposeComponent = (): void => {
    if (component === undefined) return;
    component.dispose();
    fleetFocusComponents.delete(component);
  };
  let action: { kind: "close" } | { kind: "drill"; rowId: string } | { kind: "stop"; rowId: string };
  try {
    try {
      action = await requestInlineOperatorInteraction(ctx, (tui, theme, keybindings, done) => {
        if (component !== undefined) {
          disposeComponent();
        }
        component = new FleetFocusComponent(rows, keybindings, tui, done, coerceTheme(theme));
        fleetFocusComponents.add(component);
        return component;
      });
    } catch (error) {
      if (isStaleInlineOperatorInteractionError(error)) {
        notifyInteractionEnded(ctx, error, "Agent fleet");
        return;
      }
      throw error;
    }
    disposeComponent();
    if (!ownership.isCurrent()) return;
    if (action.kind === "stop") {
      const cancellationAuthority = agentLiveStore.captureCancellationAuthority(action.rowId);
      const row = agentLiveStore.rows.get(action.rowId);
      if (!isFleetRowStoppable(row) || cancellationAuthority === undefined) {
        ctx.ui.notify(`Agent ${action.rowId} is no longer stoppable.`, "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Stop agent?",
        `Stop ${row.displayName ?? row.agentName ?? row.id} — ${row.title ?? row.label}?`,
      );
      if (!ownership.isCurrent()) return;
      if (!confirmed) {
        ctx.ui.notify("Agent continues running.", "info");
        return;
      }
      const currentRow = agentLiveStore.rows.get(action.rowId);
      if (!isFleetRowStoppable(currentRow) || !agentLiveStore.isCancellationAuthorityCurrent(cancellationAuthority)) {
        ctx.ui.notify(`Agent ${action.rowId} is no longer stoppable.`, "warning");
        return;
      }
      if (agentLiveStore.cancelWithAuthority(cancellationAuthority))
        ctx.ui.notify("Agent cancellation requested.", "warning");
      else ctx.ui.notify(`Agent ${action.rowId} is no longer stoppable.`, "warning");
      return;
    }
    if (action.kind === "close") {
      notifyActiveAgentsContinue(ctx, "Agent menu closed.");
      return;
    }
    if (action.kind === "drill") {
      // Ownership is dropped before the agent screen opens: its passive panel
      // must show the viewed agent alone, and dropping ownership is what clears
      // the fleet cursor — so the row to come back to travels in the outcome.
      ownership.finish();
      const closed = await executeAgentDrillCommand(
        ctx as ExtensionCommandContext,
        { target: action.rowId },
        agentSessionAuthority,
      );
      // Only a step back out of the agent screen comes back here. `q` leaves the
      // agent surface for the editor, and a screen that closed itself because its
      // row retired was never a request for the fleet — reopening either would
      // put a surface on screen the operator did not ask for, and with no live
      // rows left it would also raise "/ps found no live agent rows".
      return closed === "back" ? { drilledRowId: action.rowId } : undefined;
    }
  } finally {
    disposeComponent();
  }
}
