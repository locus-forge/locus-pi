/**
 * extensions/model/role-command.ts — the `/model-roles` command: read what the
 * host registry actually offers, open the inline selector when Pi can host one,
 * and fall back to the typed read-only block (`operator-ui.ts`) when it cannot.
 * A superseded inline surface ends the command benignly rather than as a
 * failure. Applying a chosen route is `role-apply.ts`.
 */

import { loadModelRolesState } from "../_shared/model/model-settings.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator/operator-interaction.js";
import type { ExtensionAPI, ExtensionContext, ModelLike } from "../_shared/host/pi-api.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import {
  buildModelRows,
  createModelRoleSelectorTheme,
  modelSelector,
  ModelRoleSelectorComponent,
  roleSummaries,
} from "./model-role-selector.js";
import { notifyBenignInteractionEnd, publishModelRoleStatus } from "./operator-surface.js";
import { modelRoleFallbackBlock, type ModelRoleSessionFacts } from "./operator-ui.js";
import { applyModelRole } from "./role-apply.js";

export async function runModelUi(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const models = await availableModels(ctx);
  if (models.length === 0) {
    const state = await loadModelRolesState();
    const summaries = roleSummaries(state);
    publishModelRoleStatus(ctx, summaries);
    setOperatorWidget(
      ctx,
      "model-roles",
      modelRoleFallbackBlock(
        summaries,
        "No configured models are available; the selector was not opened.",
        sessionFacts(pi, ctx),
      ),
    );
    return;
  }

  await showModelRoleSelector(pi, ctx, models);
}

async function availableModels(ctx: ExtensionContext): Promise<ModelLike[]> {
  const registry = ctx.modelRegistry;
  if (!registry) return [];
  const models = await (registry.getAvailable?.() ?? registry.getAll?.() ?? []);
  return models.filter((model) => modelSelector(model) !== "");
}

async function showModelRoleSelector(pi: ExtensionAPI, ctx: ExtensionContext, models: ModelLike[]): Promise<void> {
  const state = await loadModelRolesState();
  const summaries = roleSummaries(state);
  if (ctx.mode !== "tui" || ctx.hasUI === false || !ctx.ui.custom) {
    publishModelRoleStatus(ctx, summaries);
    setOperatorWidget(
      ctx,
      "model-roles",
      modelRoleFallbackBlock(
        summaries,
        "Interactive model-role selection requires Pi custom UI; no route was changed.",
        sessionFacts(pi, ctx),
      ),
    );
    return;
  }
  const currentSelector = ctx.model ? modelSelector(ctx.model) : undefined;
  const rows = buildModelRows(models, state, currentSelector);
  if (rows.length === 0) return;
  publishModelRoleStatus(ctx, summaries);
  try {
    await requestInlineOperatorInteraction<void>(
      ctx,
      (tui, theme, _keybindings, done) =>
        new ModelRoleSelectorComponent(tui, createModelRoleSelectorTheme(theme), {
          rows,
          roleSummaries: summaries,
          currentSelector,
          currentThinking: pi.getThinkingLevel?.(),
          applySelection: (selection) => applyModelRole(pi, ctx, selection),
          done,
        }),
    );
  } catch (error) {
    // Pi shows one inline surface at a time, so a newer prompt taking the screen
    // is a normal outcome here, not a failed command: any role already applied
    // stays applied, and nothing further is claimed.
    if (!isStaleInlineOperatorInteractionError(error)) throw error;
    // A session Pi has already replaced may not accept a notification at all.
    notifyBenignInteractionEnd(
      ctx,
      isSupersededInlineOperatorInteractionError(error)
        ? "Model roles closed: another prompt took the screen. Reopen /model-roles when it is answered."
        : "Model roles did not open: this session's UI surface is no longer the one that asked. Reopen /model-roles.",
    );
  }
}

/** The two session facts the read-only fallback block reports verbatim. */
function sessionFacts(pi: ExtensionAPI, ctx: ExtensionContext): ModelRoleSessionFacts {
  return {
    selector: ctx.model ? modelSelector(ctx.model) : undefined,
    thinking: pi.getThinkingLevel?.(),
  };
}
