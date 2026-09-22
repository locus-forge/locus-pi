/**
 * extensions/model/operator-ui.ts — pure OperatorBlock builders for this
 * extension: the typed result of every `/effort` outcome and the read-only
 * `/model-roles` fallback shown when the interactive selector cannot open.
 * No Pi handle, no ExtensionContext, no I/O — the callers pass in the session
 * facts they already read. Context-bound writes stay in `operator-surface.ts`.
 */

import { formatAssignment } from "../_shared/model/model-settings.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import type { ThinkingLevel } from "../_shared/host/pi-api.js";
import type { RoleSummary } from "./model-role-selector.js";

export type EffortCommandOutcome =
  | { kind: "unknown"; requested: string; supported: readonly ThinkingLevel[] }
  | { kind: "unsupported"; requested: ThinkingLevel; model: string; supported: readonly ThinkingLevel[] }
  | {
      kind: "selector-unavailable";
      mode: string;
      current: ThinkingLevel | undefined;
      supported: readonly ThinkingLevel[];
    }
  | { kind: "unavailable"; operation: "control" | "verification"; supported: readonly ThinkingLevel[] }
  | { kind: "clamped"; requested: ThinkingLevel; actual: ThinkingLevel; supported: readonly ThinkingLevel[] }
  | {
      kind: "unchanged";
      level: ThinkingLevel;
      supported: readonly ThinkingLevel[];
      capability: "registry" | "legacy" | "unknown";
    }
  | {
      kind: "changed";
      level: ThinkingLevel;
      supported: readonly ThinkingLevel[];
      capability: "registry" | "legacy" | "unknown";
    };

export function buildEffortOperatorBlock(outcome: EffortCommandOutcome): OperatorBlock {
  const supported = outcome.supported.join(", ") || "none";

  switch (outcome.kind) {
    case "unknown":
      return {
        type: "ERROR",
        subject: "Thinking effort",
        primary: `Unknown effort level: ${outcome.requested}.`,
        body: ["Current session effort was not changed."],
        metadata: [`Supported: ${supported}`],
        controls: ["Use: /effort <level>", "Choose interactively: /effort"],
      };
    case "unsupported":
      return {
        type: "ERROR",
        subject: "Thinking effort",
        primary: `${outcome.model} does not support ${outcome.requested}.`,
        body: ["Current session effort was not changed."],
        metadata: [`Supported: ${supported}`],
        controls: ["Choose a supported level: /effort"],
      };
    case "selector-unavailable":
      return {
        type: "WARN",
        subject: "Thinking effort",
        primary: `Interactive effort selection is unavailable in ${outcome.mode} mode.`,
        metadata: [`Current: ${outcome.current ?? "unknown"}`, `Supported: ${supported}`, "Scope: current Pi session"],
        controls: ["Use an explicit level: /effort <level>"],
      };
    case "unavailable":
      return {
        type: "ERROR",
        subject: "Thinking effort",
        primary:
          outcome.operation === "control"
            ? "Pi host does not expose thinking-level control."
            : "Pi host does not expose thinking-level verification.",
        body: ["Effort was not changed because the result could not be verified."],
        metadata: [`Supported: ${supported}`],
        controls: ["Update or reconfigure the Pi host, then retry /effort."],
      };
    case "clamped":
      return {
        type: "WARN",
        subject: "Thinking effort",
        primary: `Pi kept ${outcome.actual}; ${outcome.requested} was not accepted.`,
        metadata: [
          `Requested: ${outcome.requested}`,
          `Actual: ${outcome.actual}`,
          `Supported: ${supported}`,
          "Scope: current Pi session",
        ],
        controls: ["Choose another level: /effort"],
      };
    case "unchanged":
      return {
        type: "VIEW",
        subject: "Thinking effort",
        primary: `Current session effort remains ${outcome.level}.`,
        metadata: [`Supported: ${supported}`, `Capability: ${outcome.capability}`, "Scope: current Pi session"],
        controls: ["Choose another level: /effort"],
      };
    case "changed":
      return {
        type: "CHANGE",
        subject: "Thinking effort",
        primary: `Current session effort is now ${outcome.level}.`,
        metadata: [`Supported: ${supported}`, `Capability: ${outcome.capability}`, "Scope: current Pi session"],
        controls: ["Choose another level: /effort"],
      };
  }
}

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
