import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { acquireFleetViewedRow, fleetMenuState } from "../../../extensions/_shared/agent-runtime/fleet-menu.js";

/**
 * One of the two separately registered entrypoints behind
 * `tests/extensions/agents/fleet/fleet-menu-entrypoints.test.ts`. Pi loads each entrypoint with the
 * module cache disabled, so this file holds its OWN instance of `fleet-menu.ts`; every
 * assertion in that test is about whether the two instances resolve to one shared state
 * object and one shared emitter.
 */

const PRODUCER_ROW_ID = "fleet-producer-row";
/** Change events this entrypoint's own listener received, including ones the peer caused. */
let observedChanges = 0;

export default function fleetMenuProducer(pi: ExtensionAPI): void {
  pi.registerCommand("test-fleet-producer-listen", {
    handler: (_args, ctx) => {
      fleetMenuState.emitter.on("change", () => {
        observedChanges += 1;
      });
      ctx.ui.setWidget("fleet-producer-listen", [`focused=${fleetMenuState.focused}`, `changes=${observedChanges}`]);
    },
  });

  pi.registerCommand("test-fleet-producer-focus", {
    handler: (_args, ctx) => {
      agentLiveStore.beginExecution({
        id: PRODUCER_ROW_ID,
        agentName: "reviewer",
        label: "row from producer entrypoint",
      });
      const rows = [...agentLiveStore.rows.values()];
      fleetMenuState.setVisibleRows(rows);
      fleetMenuState.setFallbackFocusAvailable(true);
      fleetMenuState.setFocused(true);
      ctx.ui.setWidget("fleet-producer-focus", [
        `focused=${fleetMenuState.focused}`,
        `selected=${fleetMenuState.selectedRowId}`,
      ]);
    },
  });

  pi.registerCommand("test-fleet-producer-observe", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("fleet-producer-observe", [
        `focused=${fleetMenuState.focused}`,
        `selected=${fleetMenuState.selectedRowId}`,
        `visible=${fleetMenuState.visibleRows().length}`,
        `fallbackFocus=${fleetMenuState.fallbackFocusAvailable}`,
        `changes=${observedChanges}`,
      ]);
    },
  });

  pi.registerCommand("test-fleet-producer-view-row", {
    handler: (_args, ctx) => {
      acquireFleetViewedRow(PRODUCER_ROW_ID);
      ctx.ui.setWidget("fleet-producer-view-row", ["viewed=fleet-producer-row"]);
    },
  });
}
