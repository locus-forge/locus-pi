import type { ExtensionAPI, ExtensionContext, ModelLike, ThinkingLevel } from "../host/pi-api.js";
import type { ModelRoleAssignment } from "./model-settings.js";
import { parseModelSelector } from "./model-settings.js";

export interface LiveModelDisplay {
  model?: string;
  thinking?: ThinkingLevel;
}

/**
 * Which model to show for one child run.
 *
 * The precedence mirrors the EXECUTOR's precedence exactly — host readback, then the
 * per-call selector, then the resolved role assignment, then the parent session model
 * — because a row that shows a different model from the one the child was routed to
 * is a lie in the place an operator is most likely to read it. Two consequences worth
 * stating: a readback always wins (it is the only value that observed anything), and
 * a resolved role assignment now outranks `ctx.model`, which it did not before the
 * assignment actually reached the child.
 */
export function resolveLiveModelDisplay(input: {
  pi?: Pick<ExtensionAPI, "getThinkingLevel">;
  ctx?: Pick<ExtensionContext, "model">;
  /** Host readback: what the child session reported it ran on. Outranks every request-side value. */
  executedModel?: string | undefined;
  requestedModel?: string | undefined;
  assignment?: ModelRoleAssignment | undefined;
}): LiveModelDisplay | undefined {
  const requested = input.requestedModel === undefined ? undefined : parseModelSelector(input.requestedModel);
  const currentModel = modelSelectorFromModel(input.ctx?.model);
  const currentThinking = input.pi?.getThinkingLevel?.();
  const model = input.executedModel ?? requested?.model ?? input.assignment?.model ?? currentModel;
  const thinking = requested?.thinking ?? currentThinking ?? input.assignment?.thinking;
  if (model === undefined && thinking === undefined) return undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

export function modelSelectorFromModel(model: unknown): string | undefined {
  if (!isModelLike(model)) return undefined;
  const provider = cleanSelectorPart(model.provider);
  const id = cleanSelectorPart(model.id);
  if (id === "") return undefined;
  if (id.includes("/")) return id;
  return provider === "" ? id : `${provider}/${id}`;
}

function isModelLike(value: unknown): value is ModelLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const model = value as { provider?: unknown; id?: unknown };
  return typeof model.provider === "string" && typeof model.id === "string";
}

function cleanSelectorPart(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}
