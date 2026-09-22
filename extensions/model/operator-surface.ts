/**
 * extensions/model/operator-surface.ts — the ctx-bound reads and writes behind
 * the `model.roles` status lane: loading the effective role state, publishing
 * (or clearing) the bounded `locus` routing contribution, and the best-effort
 * notification a benignly replaced selector leaves behind. Pure block
 * construction stays in `operator-ui.ts`.
 */

import { loadModelRolesState } from "../_shared/model/model-settings.js";
import {
  clearOperatorStatus,
  setOperatorStatus,
  type OperatorStatusContribution,
} from "../_shared/operator/operator-status.js";
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { modelSelector, roleSummaries, type AppliedModelRoleState, type RoleSummary } from "./model-role-selector.js";

export type CurrentModelRoleState = Omit<AppliedModelRoleState, "receipt">;

export async function updateModelRoleStatus(
  ctx: ExtensionContext,
  fallbackCurrentSelector?: string,
  pi?: ExtensionAPI,
): Promise<CurrentModelRoleState> {
  const appliedState = await currentModelRoleState(pi, ctx, fallbackCurrentSelector);
  publishModelRoleStatus(ctx, appliedState.roleSummaries);
  return appliedState;
}

export async function currentModelRoleState(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionContext,
  fallbackCurrentSelector: string | undefined,
): Promise<CurrentModelRoleState> {
  const state = await loadModelRolesState();
  return {
    currentSelector: ctx.model ? modelSelector(ctx.model) : fallbackCurrentSelector,
    currentThinking: pi?.getThinkingLevel?.(),
    roleSummaries: roleSummaries(state),
  };
}

export function publishModelRoleStatus(ctx: ExtensionContext, summaries: readonly RoleSummary[]): void {
  // Remove the pre-T-203 private status key. All Locus contributors now share
  // the bounded `locus` registry without replacing the host footer.
  ctx.ui.setStatus("model-roles", undefined);
  const contribution = modelRoleStatusContribution(summaries);
  if (contribution === undefined) clearOperatorStatus(ctx, "model.roles");
  else setOperatorStatus(ctx, contribution);
}

export function modelRoleStatusContribution(summaries: readonly RoleSummary[]): OperatorStatusContribution | undefined {
  const assigned = summaries.filter((summary) => summary.assignment !== undefined);
  if (assigned.length === 0) return undefined;
  const first = assigned.slice(0, 2);
  const overflow = assigned.length - first.length;
  const suffix = overflow > 0 ? ` +${overflow}` : "";
  const wide = first.map((summary) => `${summary.tag}=${shortModelName(summary.assignment!.model)}`).join(" ");
  const compact = first
    .map((summary) => `${statusRoleAbbreviation(summary.tag)}:${shortModelName(summary.assignment!.model)}`)
    .join(" ");
  return {
    id: "model.roles",
    lane: "route",
    priority: 60,
    wide: `routes ${wide}${suffix}`,
    compact: `routes ${compact}${suffix}`,
    narrow: `routes ${assigned.length}`,
  };
}

/** Notify best-effort: a replaced session has nobody left to tell. */
export function notifyBenignInteractionEnd(ctx: ExtensionContext, message: string): void {
  try {
    ctx.ui.notify(message, "info");
  } catch {
    // Nothing to recover: the surface this would describe is already gone.
  }
}

function shortModelName(selector: string): string {
  const parts = selector.split("/");
  return parts.at(-1) ?? selector;
}

function statusRoleAbbreviation(tag: string): string {
  return (
    ({ DEFAULT: "D", AGENT: "A", TASK: "T", PLAN: "P", SUMMARY: "S", SMOL: "M" } as Record<string, string>)[tag] ??
    tag.slice(0, 1)
  );
}
