/**
 * extensions/model/index.ts — Extension entrypoint.
 *
 * Registers `/model-roles` (./role-command.js) with its UI lifecycle taxonomy
 * and syncs the routing status lane (./operator-surface.js) at session start.
 * Pi owns the built-in `/model` and `/thinking` controls. Every Locus surface,
 * mutation, and evidence write lives in a submodule.
 */

import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { updateModelRoleStatus } from "./operator-surface.js";
import { runModelUi } from "./role-command.js";

export default function model(pi: ExtensionAPI): void {
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "model-roles",
      group: "model-roles",
      surfaces: ["overlay-selector", "transient-widget", "persistent-state", "status"],
      transientWidgets: ["model-roles"],
    },
    {
      description: "Select the current model and save Locus model role assignments.",
      async handler(_args, ctx) {
        await runModelUi(pi, ctx);
      },
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    await updateModelRoleStatus(ctx, undefined, pi);
  });
}
