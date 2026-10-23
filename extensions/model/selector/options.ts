/** Model/role choices and capability projections shared by the selector and apply path. */
import type { ModelLike, ThinkingLevel } from "../../_shared/host/pi-api.js";
import type { ModelRoleAssignment, ModelRolesState, ModelRoleSource } from "../../_shared/model/model-settings.js";

export type ModelRoleSupport = "active" | "fallback" | "dormant";

export const MODEL_ROLE_ACTIONS = [
  {
    role: "default",
    tag: "default",
    label: "Set as default",
    capability: "active · main/current model",
    narrowCapability: "active · current model",
    support: "active",
    appliesCurrentModel: true,
  },
  {
    role: "agent",
    tag: "agent",
    label: "Set as agent",
    capability: "active · model-less agents/workflows",
    narrowCapability: "active · model-less agents",
    support: "active",
    appliesCurrentModel: false,
  },
  {
    role: "task",
    tag: "task",
    label: "Set as task",
    capability: "active · explicit task role",
    narrowCapability: "active · task role",
    support: "active",
    appliesCurrentModel: false,
  },
  {
    role: "plan",
    tag: "plan",
    label: "Set as plan",
    capability: "dormant · beta prompt planning",
    narrowCapability: "dormant · beta",
    support: "dormant",
    appliesCurrentModel: false,
  },
  {
    role: "summary",
    tag: "summary",
    label: "Set as summary",
    capability: "dormant · resolver only",
    narrowCapability: "dormant · resolver",
    support: "dormant",
    appliesCurrentModel: false,
  },
  {
    role: "smol",
    tag: "smol",
    label: "Set as smol",
    capability: "fallback-only · summary resolver",
    narrowCapability: "fallback-only",
    support: "fallback",
    appliesCurrentModel: false,
  },
] as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface ModelRoleAction {
  role: string;
  tag: string;
  label: string;
  capability: string;
  narrowCapability: string;
  support: ModelRoleSupport;
  appliesCurrentModel: boolean;
}
export function modelRoleAction(role: string): ModelRoleAction {
  return (
    MODEL_ROLE_ACTIONS.find((action) => action.role === role) ?? {
      role,
      tag: role,
      label: `Set as ${role}`,
      capability: "active · explicit model role",
      narrowCapability: "active · explicit role",
      support: "active",
      appliesCurrentModel: false,
    }
  );
}

export interface ModelRoleSelection {
  model: ModelLike;
  action: ModelRoleAction;
  thinking: ThinkingLevel;
}

export interface ModelRoleReceipt {
  kind: "success" | "warning" | "error";
  text: string;
}

export interface AppliedModelRoleState {
  configExists?: boolean;
  currentSelector: string | undefined;
  currentThinking: ThinkingLevel | undefined;
  roleSummaries: RoleSummary[];
  receipt: ModelRoleReceipt;
}

export interface ModelRow {
  model: ModelLike;
  selector: string;
  label: string;
  provider: string;
  roleTags: string[];
  current: boolean;
  rank: number;
}

export interface RoleSummary {
  role: string;
  tag: string;
  source: ModelRoleSource;
  inherited: boolean;
  assignment?: ModelRoleAssignment;
}

export interface ModelEffortCapability {
  levels: ThinkingLevel[];
  source: "registry" | "legacy" | "unknown";
  known: boolean;
}

interface CapabilityModel extends ModelLike {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface ModelRoleSelectorOptions {
  rows: ModelRow[];
  roleSummaries: RoleSummary[];
  currentSelector: string | undefined;
  currentThinking: ThinkingLevel | undefined;
  applySelection(selection: ModelRoleSelection): Promise<AppliedModelRoleState>;
  done?: () => void;
  configPath?: string;
  configExists?: boolean;
}

/** Pi-compatible effort projection from registry capability metadata. */
export function modelEffortCapability(model: ModelLike | undefined): ModelEffortCapability {
  if (model === undefined) return { levels: ["off"], source: "unknown", known: false };

  const capability = model as CapabilityModel;
  if (typeof capability.reasoning === "boolean" || capability.thinkingLevelMap !== undefined) {
    if (capability.reasoning === false) return { levels: ["off"], source: "registry", known: true };
    const levels = THINKING_LEVELS.filter((level) => {
      const mapped = capability.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === "xhigh") return mapped !== undefined;
      return true;
    });
    return { levels: [...levels], source: "registry", known: true };
  }

  if (Array.isArray(capability.thinking)) {
    const advertised = capability.thinking.filter((level): level is ThinkingLevel =>
      (THINKING_LEVELS as readonly string[]).includes(level),
    );
    return {
      levels: [...new Set<ThinkingLevel>(["off", ...advertised])],
      source: "legacy",
      known: advertised.length > 0,
    };
  }

  return { levels: ["off"], source: "unknown", known: false };
}

export function effortLevelsForModel(model: ModelLike | undefined): ThinkingLevel[] {
  return [...modelEffortCapability(model).levels];
}

export function buildModelRows(
  models: ModelLike[],
  state: ModelRolesState,
  currentSelector: string | undefined,
): ModelRow[] {
  const rowsBySelector = new Map<string, ModelRow>();
  for (const [index, model] of models.entries()) {
    const selector = modelSelector(model);
    const roleTags = assignedRoleTags(selector, state);
    const current = currentSelector === selector;
    const row: ModelRow = {
      model,
      selector,
      label: modelLabel(model),
      provider: cleanSelectorPart(model.provider),
      roleTags,
      current,
      rank: modelRowRank(roleTags, current, index),
    };
    const existing = rowsBySelector.get(selector);
    rowsBySelector.set(selector, existing ? preferredDuplicateRow(existing, row) : row);
  }
  return [...rowsBySelector.values()].sort(
    (left, right) => left.rank - right.rank || left.label.localeCompare(right.label),
  );
}

export function roleSummaries(state: ModelRolesState): RoleSummary[] {
  const roles = new Set([...MODEL_ROLE_ACTIONS.map((action) => action.role), ...state.effective.keys()]);
  return [...roles].map((role) => {
    const action = modelRoleAction(role);
    const effective = state.effective.get(action.role);
    return {
      role: action.role,
      tag: action.tag,
      source: effective?.source ?? "unset",
      inherited: effective?.inherited ?? false,
      ...(effective?.assignment === undefined ? {} : { assignment: effective.assignment }),
    };
  });
}

export function modelSelector(model: ModelLike): string {
  const provider = cleanSelectorPart(model.provider);
  const id = cleanSelectorPart(model.id);
  if (!provider || !id) return "";
  return id.includes("/") ? id : `${provider}/${id}`;
}

function preferredDuplicateRow(left: ModelRow, right: ModelRow): ModelRow {
  const winner = right.label.length < left.label.length ? right : left;
  return {
    ...winner,
    current: left.current || right.current,
    roleTags: [...new Set([...left.roleTags, ...right.roleTags])],
    rank: Math.min(left.rank, right.rank),
  };
}

function assignedRoleTags(selector: string, state: ModelRolesState): string[] {
  return roleSummaries(state)
    .filter((item) => item.assignment?.model === selector)
    .map((item) => item.role);
}

export function modelRowRank(roleTags: string[], current: boolean, originalIndex: number): number {
  if (current) return -1;
  const firstRoleIndex = MODEL_ROLE_ACTIONS.findIndex((action) => roleTags.includes(action.tag));
  return firstRoleIndex >= 0
    ? firstRoleIndex
    : MODEL_ROLE_ACTIONS.length + (roleTags.length > 0 ? 0 : originalIndex + 1);
}

function modelLabel(model: ModelLike): string {
  const name = typeof model.name === "string" && model.name.trim() ? ` — ${model.name.trim()}` : "";
  return `${modelSelector(model)}${name}`;
}

function cleanSelectorPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
