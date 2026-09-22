import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { fleetMenuState, fleetViewedRowId } from "../../../extensions/_shared/agent-runtime/fleet-menu.js";

/**
 * The peer entrypoint of `fleet-menu-producer.ts`. It never creates a live row of its own: its
 * whole job is to observe, and then mutate, state the OTHER entrypoint established — which is
 * only possible when both module instances share one `fleetMenuState`.
 */

/** Change events this entrypoint's own listener received, including ones the peer caused. */
let observedChanges = 0;

export default function fleetMenuConsumer(pi: ExtensionAPI): void {
  pi.registerCommand("test-fleet-consumer-listen", {
    handler: (_args, ctx) => {
      fleetMenuState.emitter.on("change", () => {
        observedChanges += 1;
      });
      ctx.ui.setWidget("fleet-consumer-listen", [`focused=${fleetMenuState.focused}`, `changes=${observedChanges}`]);
    },
  });

  pi.registerCommand("test-fleet-consumer-observe", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("fleet-consumer-observe", [
        `focused=${fleetMenuState.focused}`,
        `selected=${fleetMenuState.selectedRowId}`,
        `visible=${fleetMenuState.visibleRows().length}`,
        `fallbackFocus=${fleetMenuState.fallbackFocusAvailable}`,
        `changes=${observedChanges}`,
      ]);
    },
  });

  /**
   * The close sequence `extensions/agents/fleet/fleet-menu-controller.ts` runs on exit, performed here
   * by the entrypoint that did NOT open the menu. On a shared state object this releases the
   * producer's focus; on two copies the producer stays focused forever.
   */
  pi.registerCommand("test-fleet-consumer-release", {
    handler: (_args, ctx) => {
      fleetMenuState.setFocused(false);
      fleetMenuState.setVisibleRows([]);
      ctx.ui.setWidget("fleet-consumer-release", [
        `focused=${fleetMenuState.focused}`,
        `visible=${fleetMenuState.visibleRows().length}`,
      ]);
    },
  });

  pi.registerCommand("test-fleet-consumer-viewed-row", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("fleet-consumer-viewed-row", [`viewed=${fleetViewedRowId()}`]);
    },
  });
}
