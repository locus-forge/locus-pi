import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ThinkingLevel } from "../_shared/host/pi-api.js";
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
    { command: "clean", surfaces: ["persistent-state"] },
    {
      description: "Start an empty session with the current model and thinking level.",
      handler: (_args, ctx) => startCleanSession(ctx),
    },
  );

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new") await restoreCleanSelection(pi, ctx);
    await updateModelRoleStatus(ctx, undefined, pi);
  });
}

const entryType = "locus-pi.clean-selection";

interface CleanSelection {
  provider: string;
  id: string;
  thinking: ThinkingLevel;
}

async function startCleanSession(ctx: ExtensionCommandContext): Promise<void> {
  const { model, thinkingLevel: thinking } = ctx;
  if (!ctx.newSession || !model || !thinking) {
    ctx.ui.notify("/clean needs an active model, thinking level and Pi session controls.", "error");
    return;
  }
  const { provider, id } = model;
  await ctx.newSession({
    setup(manager) {
      manager.appendCustomEntry(entryType, { provider, id, thinking } satisfies CleanSelection);
    },
    withSession(fresh) {
      if (fresh.model?.provider !== provider || fresh.model.id !== id || fresh.thinkingLevel !== thinking) {
        fresh.ui.notify(
          `/clean opened a new session but could not restore ${provider}/${id} at ${thinking}. Check /model and /thinking.`,
          "error",
        );
        return;
      }
      fresh.ui.notify(`New session started with ${provider}/${id} at ${thinking}.`, "info");
    },
  });
}

async function restoreCleanSelection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // Pi invalidates the outgoing API. Only the new extension instance can change the live model.
  const entries = await ctx.sessionManager?.getEntries();
  const entry = entries?.find((entry) => entry.type === "custom" && entry.customType === entryType);
  if (!entry) return;
  const { provider, id, thinking } = entry.data as CleanSelection;
  if (ctx.model?.provider !== provider || ctx.model.id !== id) {
    const model = await ctx.modelRegistry?.find?.(provider, id);
    if (!model || !(await pi.setModel?.(model))) return;
  }
  pi.setThinkingLevel?.(thinking);
}
