/**
 * extensions/model/operator-ui.ts — pure OperatorBlock builders for the
 * read-only `/model-roles` fallback shown when the interactive selector cannot
 * open. No Pi handle, no ExtensionContext, no I/O — the callers pass in the
 * session facts they already read. Context-bound writes stay in
 * `operator-surface.ts`.
 */

import { formatAssignment } from "../_shared/model/model-settings.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import type { ThinkingLevel } from "../_shared/host/pi-api.js";
import type { RoleSummary } from "./model-role-selector.js";

/** The current session facts the read-only model-roles fallback reports. */
export interface ModelRoleSessionFacts {
  selector: string | undefined;
  thinking: ThinkingLevel | undefined;
}

export function modelRoleFallbackBlock(
  summaries: readonly RoleSummary[],
  primary: string,
  session: ModelRoleSessionFacts,
): OperatorBlock {
  const defaultRoute = summaries.find((summary) => summary.role === "default");
  const assigned = summaries.filter((summary) => summary.role !== "default" && summary.assignment !== undefined);
  return {
    type: "WARN",
    subject: "Model roles",
    primary,
    metadata: [
      `Current session model: ${session.selector ?? "unset"}`,
      `Current session effort: ${session.thinking ?? "unknown"}`,
      `DEFAULT route: ${defaultRoute?.assignment === undefined ? "unset" : formatAssignment(defaultRoute.assignment)}`,
      `Other routes: ${assigned.length === 0 ? "none" : assigned.map((summary) => `${summary.tag}=${formatAssignment(summary.assignment!)}`).join(" · ")}`,
      "storage: ~/.pi/agent/model-roles/config.json",
    ],
    hint: ["This fallback is read-only; routing state remains unchanged."],
    controls: ["Open /model-roles in an interactive Pi TUI to assign roles."],
  };
}
