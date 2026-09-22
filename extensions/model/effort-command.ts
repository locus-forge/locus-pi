/**
 * extensions/model/effort-command.ts — the `/effort` pipeline: parse the
 * requested level (or offer Pi's own selector), validate it against the current
 * model's advertised capability, mutate the session thinking level only through
 * a host that can also verify it, and present the single typed outcome.
 * The block wording itself lives in `operator-ui.ts`.
 */

import type { ExtensionAPI, ExtensionContext, ThinkingLevel } from "../_shared/host/pi-api.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import { effortLevelsForModel, modelEffortCapability, modelSelector, THINKING_LEVELS } from "./model-role-selector.js";
import { buildEffortOperatorBlock, type EffortCommandOutcome } from "./operator-ui.js";

export async function runEffortCommand(pi: ExtensionAPI, ctx: ExtensionContext, raw: string): Promise<void> {
  const current = pi.getThinkingLevel?.();
  const levels = effortLevelsForModel(ctx.model);
  const capability = modelEffortCapability(ctx.model);
  const requested = raw.trim().toLowerCase();

  let target: ThinkingLevel | undefined;
  if (requested !== "") {
    if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
      presentEffortOutcome(ctx, { kind: "unknown", requested, supported: levels });
      return;
    }
    target = requested as ThinkingLevel;
    if (!levels.includes(target)) {
      presentEffortOutcome(ctx, {
        kind: "unsupported",
        requested: target,
        model: ctx.model ? modelSelector(ctx.model) : "Current model",
        supported: levels,
      });
      return;
    }
  } else {
    if (ctx.mode !== "tui" || ctx.hasUI === false) {
      presentEffortOutcome(ctx, {
        kind: "selector-unavailable",
        mode: ctx.mode ?? "noninteractive",
        current,
        supported: levels,
      });
      return;
    }
    const selectorLevels =
      current !== undefined && levels.includes(current)
        ? [current, ...levels.filter((level) => level !== current)]
        : levels;
    const choice = await ctx.ui.select(
      `[SELECT] Thinking effort · current ${current ?? "unknown"} · ${ctx.model ? modelSelector(ctx.model) : "model unset"}`,
      selectorLevels,
    );
    if (typeof choice !== "string" && choice?.cancelled === true) return;
    const value = typeof choice === "string" ? choice : choice?.value;
    if (!value) return;
    target = value as ThinkingLevel;
  }

  if (target === current) {
    presentEffortOutcome(ctx, {
      kind: "unchanged",
      level: current,
      supported: levels,
      capability: capability.known ? capability.source : "unknown",
    });
    return;
  }

  if (!pi.setThinkingLevel) {
    presentEffortOutcome(ctx, { kind: "unavailable", operation: "control", supported: levels });
    return;
  }
  if (!pi.getThinkingLevel) {
    presentEffortOutcome(ctx, { kind: "unavailable", operation: "verification", supported: levels });
    return;
  }
  pi.setThinkingLevel(target);
  const after = pi.getThinkingLevel();
  if (after !== target) {
    presentEffortOutcome(ctx, { kind: "clamped", requested: target, actual: after, supported: levels });
    return;
  }
  presentEffortOutcome(ctx, {
    kind: "changed",
    level: after,
    supported: levels,
    capability: capability.known ? capability.source : "unknown",
  });
}

function presentEffortOutcome(ctx: ExtensionContext, outcome: EffortCommandOutcome): void {
  setOperatorWidget(ctx, "effort", buildEffortOperatorBlock(outcome), {
    fallbackWidth: 80,
  });
}
