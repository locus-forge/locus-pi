/**
 * extensions/model/index.ts — Extension entrypoint.
 *
 * Registers `/model-roles` (./role-command.js) and `/effort` (./effort-command.js)
 * with their UI lifecycle taxonomy, and syncs the routing status lane
 * (./operator-surface.js) at session start. Every surface, mutation, and
 * evidence write lives in a submodule.
 */

import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { getCommandText } from "../_shared/host/pi-api.js";
import { runEffortCommand } from "./effort-command.js";
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

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "effort",
      group: "effort",
      surfaces: ["overlay-selector", "transient-widget"],
      transientWidgets: ["effort"],
    },
    {
      description: "Usage: /effort [off|minimal|low|medium|high|xhigh]. Set the current model's thinking effort.",
      async handler(args, ctx) {
        await runEffortCommand(pi, ctx, getCommandText(args));
      },
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    await updateModelRoleStatus(ctx, undefined, pi);
  });
}
