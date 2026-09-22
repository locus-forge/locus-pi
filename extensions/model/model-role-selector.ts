import { truncateToWidth } from "@earendil-works/pi-tui";
import { errorMessage } from "../_shared/host/error-text.js";
import {
  isDown,
  isEnter,
  isEscape,
  isLeft,
  isPageDown,
  isPageUp,
  isRight,
  isUp,
} from "../_shared/operator/operator-keys.js";
import type { CustomUiComponent, CustomUiTui, ModelLike, ThinkingLevel } from "../_shared/host/pi-api.js";
import {
  renderOperatorBlock,
  styleActiveSelection,
  type OperatorBlock,
  type OperatorThemeLike,
} from "../_shared/operator/operator-ui.js";
import {
  formatAssignment,
  type ModelRoleAssignment,
  type ModelRolesState,
  type ModelRoleSource,
} from "../_shared/model/model-settings.js";

export type ModelRoleSupport = "active" | "fallback" | "dormant";

export const MODEL_ROLE_ACTIONS = [
  {
    role: "default",
    tag: "DEFAULT",
    label: "Set as DEFAULT",
    capability: "active · main/current model",
    narrowCapability: "active · current model",
    support: "active",
    appliesCurrentModel: true,
  },
  {
    role: "agent",
    tag: "AGENT",
    label: "Set as AGENT",
    capability: "active · model-less agents/workflows",
    narrowCapability: "active · model-less agents",
    support: "active",
    appliesCurrentModel: false,
  },
  {
    role: "task",
    tag: "TASK",
    label: "Set as TASK",
    capability: "active · explicit task role",
    narrowCapability: "active · task role",
    support: "active",
    appliesCurrentModel: false,
  },
  {
    role: "plan",
    tag: "PLAN",
    label: "Set as PLAN",
    capability: "dormant · beta prompt planning",
    narrowCapability: "dormant · beta",
    support: "dormant",
    appliesCurrentModel: false,
  },
  {
    role: "summary",
    tag: "SUMMARY",
    label: "Set as SUMMARY",
    capability: "dormant · resolver only",
    narrowCapability: "dormant · resolver",
    support: "dormant",
    appliesCurrentModel: false,
  },
  {
    role: "smol",
    tag: "SMOL",
    label: "Set as SMOL",
    capability: "fallback-only · summary resolver",
    narrowCapability: "fallback-only",
    support: "fallback",
    appliesCurrentModel: false,
  },
] as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type ModelRoleAction = (typeof MODEL_ROLE_ACTIONS)[number];

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
}

type SelectorStage = "models" | "roles" | "effort";

const ALL_PROVIDER_FILTER = "ALL";

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
  return MODEL_ROLE_ACTIONS.map((action) => {
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

export class ModelRoleSelectorComponent implements CustomUiComponent {
  readonly #tui: CustomUiTui;
  readonly #theme: OperatorThemeLike;
  #rows: ModelRow[];
  readonly #providers: string[];
  #roleSummaries: RoleSummary[];
  #currentSelector: string | undefined;
  #currentThinking: ThinkingLevel | undefined;
  readonly #applySelection: (selection: ModelRoleSelection) => Promise<AppliedModelRoleState>;
  #done: (() => void) | undefined;
  #stage: SelectorStage = "models";
  #activeProviderIndex = 0;
  #selectedIndex = 0;
  #roleIndex = 0;
  #effortIndex = 0;
  #selectedAction: ModelRoleAction | undefined;
  #applying = false;
  #receipt: ModelRoleReceipt | undefined;

  constructor(tui: CustomUiTui, theme: OperatorThemeLike, options: ModelRoleSelectorOptions) {
    this.#tui = tui;
    this.#theme = theme;
    this.#rows = options.rows;
    this.#roleSummaries = options.roleSummaries;
    this.#currentSelector = options.currentSelector;
    this.#currentThinking = options.currentThinking;
    this.#applySelection = options.applySelection;
    this.#done = options.done;
    this.#providers = [
      ALL_PROVIDER_FILTER,
      ...[...new Set(options.rows.map((row) => row.provider).filter(Boolean))].sort((left, right) =>
        left.localeCompare(right),
      ),
    ];
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return renderOperatorBlock(this.#operatorBlock(safeWidth), safeWidth, this.#theme);
  }

  async handleInput(data: string): Promise<void> {
    if (this.#applying) return;
    if (data === "q" || data === "Q") {
      this.#finish();
      return;
    }
    if (isEscape(data)) {
      if (this.#stage === "models") this.#finish();
      else this.#back();
      return;
    }
    if (isLeft(data)) {
      if (this.#stage !== "models") this.#back();
      return;
    }
    if (this.#stage === "models" && data === "\t") {
      this.#moveProvider(1);
      return;
    }
    if (this.#stage === "models" && isRight(data)) return;
    if (isDown(data)) {
      this.#moveFocus(1);
      return;
    }
    if (isUp(data)) {
      this.#moveFocus(-1);
      return;
    }
    if (this.#stage === "models" && isPageDown(data)) {
      this.#moveSelection(8);
      return;
    }
    if (this.#stage === "models" && isPageUp(data)) {
      this.#moveSelection(-8);
      return;
    }
    if (isEnter(data)) await this.#advance();
  }

  invalidate(): void {}

  #operatorBlock(width: number): OperatorBlock {
    const current = this.#currentSelector ?? "unset";
    const effort =
      this.#currentThinking === undefined
        ? ""
        : ` · effort ${semanticText(this.#theme, "success", this.#currentThinking, true)}`;
    const body = [
      this.#defaultRouteLine(),
      ...this.#routingLines(width),
      ...this.#stageBody(width),
      ...(this.#receipt === undefined ? [] : [receiptLine(this.#receipt)]),
      ...(this.#applying ? ["[WORKING] Applying model route…"] : []),
    ];
    // Tone tracks whether the route is settled, not how important the label is.
    const currentTone = this.#currentSelector === undefined ? "warning" : "success";
    return {
      type: "SELECT",
      subject: "Model roles",
      primary: `${semanticText(this.#theme, currentTone, "Current", true)} session model: ${semanticText(this.#theme, "accent", current, true)}${effort}`,
      badges: [{ text: this.#stage, tone: "accent" }],
      body,
      controls: [this.#controls()],
    };
  }

  #stageBody(width: number): string[] {
    if (this.#stage === "models") return this.#modelBody(width);
    if (this.#stage === "roles") return this.#roleBody(width);
    return this.#effortBody(width);
  }

  #modelBody(width: number): string[] {
    const rows = this.#visibleRows();
    const limit = visibleModelLimit(width);
    const start = windowStart(this.#selectedIndex, rows.length, limit);
    const end = Math.min(start + limit, rows.length);
    return [
      this.#filterLine(width),
      `Models ${rows.length === 0 ? "0" : `${start + 1}-${end}`} of ${rows.length}`,
      ...rows
        .slice(start, end)
        .map((row, offset) =>
          this.#modelRow(row, start + offset === this.#selectedIndex, this.#stage === "models", width),
        ),
    ];
  }

  #roleBody(width: number): string[] {
    const row = this.#selectedRow();
    if (row === undefined) return ["Action for: no selected model"];
    return [
      ...this.#modelBody(width),
      "",
      `Action for ${semanticText(this.#theme, "accent", row.selector, true)}:`,
      ...MODEL_ROLE_ACTIONS.map((action, index) => {
        const selected = index === this.#roleIndex;
        const marker = selected ? semanticText(this.#theme, "accent", ">", true) : " ";
        const capability = width < 60 ? action.narrowCapability : action.capability;
        const warning = selected && roleTone(action.tag) === "warning";
        const status = warning ? `${semanticText(this.#theme, "warning", `[${action.tag}]`, true)} ` : "";
        const label = selected
          ? styleActiveSelection(this.#theme, action.label)
          : semanticText(this.#theme, roleTone(action.tag), action.label);
        return truncateToWidth(
          `${marker} ${status}${label} · ${semanticText(this.#theme, "dim", capability)}`,
          Math.max(1, width - 4),
        );
      }),
    ];
  }

  #effortBody(width: number): string[] {
    const row = this.#selectedRow();
    const action = this.#selectedAction;
    if (row === undefined || action === undefined) return ["Selected route: none"];
    const capability = modelEffortCapability(row.model);
    return [
      `Action for ${semanticText(this.#theme, "accent", row.selector, true)}:`,
      `${semanticText(this.#theme, roleTone(action.tag), action.label, true)} · ${width < 60 ? action.narrowCapability : action.capability}`,
      `Effort capability: ${capability.known ? capability.source : "unknown; off only"}`,
      ...(capability.levels.length === 0
        ? ["[ERROR] Model advertises no supported effort levels."]
        : capability.levels.map((level, index) => {
            const selected = index === this.#effortIndex;
            const marker = selected ? semanticText(this.#theme, "accent", ">", true) : " ";
            const label = selected
              ? styleActiveSelection(this.#theme, level)
              : semanticText(this.#theme, "text", level);
            return `${marker} ${label}`;
          })),
    ];
  }

  #defaultRouteLine(): string {
    const summary = this.#roleSummaries.find((item) => item.role === "default");
    // Only an unset DEFAULT route still needs attention on this line.
    if (summary?.assignment === undefined)
      return `${semanticText(this.#theme, "warning", "DEFAULT", true)} route: unset`;
    const label = semanticText(this.#theme, "success", "DEFAULT", true);
    const inherited = summary.inherited ? " · inherited" : "";
    const assignment = semanticText(this.#theme, "success", formatAssignment(summary.assignment), true);
    return `${label} route: ${assignment} · ${summary.source}${inherited}`;
  }

  #routingLines(width: number): string[] {
    const assigned = this.#roleSummaries.filter((item) => item.role !== "default" && item.assignment !== undefined);
    if (assigned.length === 0) return ["Routing roles: none"];
    // Every row here is an existing assignment, so the whole line is settled.
    return [
      "Routing roles:",
      ...assigned.map((item) =>
        truncateToWidth(
          `  ${semanticText(this.#theme, "success", item.tag, true)}=${semanticText(this.#theme, "success", formatAssignment(item.assignment!), true)}`,
          Math.max(1, width - 4),
        ),
      ),
    ];
  }

  #filterLine(width: number): string {
    const active = this.#providers[this.#activeProviderIndex] ?? ALL_PROVIDER_FILTER;
    // Active provider is a horizontal choice, so it uses the shared selection
    // fill. Green remains reserved for assignments that are already settled.
    if (width < 60) {
      const selected = styleActiveSelection(this.#theme, `[${formatProvider(active)}]`);
      return `Models: ${selected} (${this.#activeProviderIndex + 1}/${this.#providers.length}, Tab)`;
    }
    const filters = this.#providers.map((provider, index) =>
      index === this.#activeProviderIndex
        ? styleActiveSelection(this.#theme, `[${formatProvider(provider)}]`)
        : semanticText(this.#theme, "dim", formatProvider(provider)),
    );
    return truncateToWidth(`Models: ${filters.join("  ")}  (Tab to cycle)`, Math.max(1, width - 4));
  }

  #modelRow(row: ModelRow, selected: boolean, focused: boolean, width: number): string {
    const markers = [row.current ? "CURRENT" : "", ...row.roleTags].filter(Boolean);
    const name = modelNameSuffix(row.model);
    const markerText =
      markers.length === 0
        ? ""
        : `${markers.map((marker) => semanticText(this.#theme, "success", `[${marker}]`, true)).join(" ")} `;
    if (selected && focused) {
      return truncateToWidth(
        `${semanticText(this.#theme, "accent", ">", true)} ${markerText}${styleActiveSelection(this.#theme, `${row.selector}${name}`)}`,
        Math.max(1, width - 4),
      );
    }
    // A role already pinned to this model is settled, never a warning.
    const assigned = row.current || row.roleTags.length > 0;
    const selector = semanticText(this.#theme, assigned ? "success" : "accent", row.selector, selected || assigned);
    return truncateToWidth(
      `  ${markerText}${selector}${name === "" ? "" : semanticText(this.#theme, "dim", name)}`,
      Math.max(1, width - 4),
    );
  }

  #controls(): string {
    if (this.#stage === "models") return "↑↓/jk models · Tab provider · Enter actions · q/Esc close";
    if (this.#stage === "roles") return "↑↓/jk actions · Enter effort · Esc/← models · q close";
    return "↑↓/jk effort · Enter apply · Esc/← actions · q close";
  }

  async #advance(): Promise<void> {
    if (this.#stage === "models") {
      if (this.#selectedRow() === undefined) return;
      this.#roleIndex = 0;
      this.#stage = "roles";
      this.#receipt = undefined;
      this.#requestRender();
      return;
    }
    if (this.#stage === "roles") {
      const row = this.#selectedRow();
      const action = MODEL_ROLE_ACTIONS[this.#roleIndex];
      if (row === undefined || action === undefined) return;
      this.#selectedAction = action;
      const levels = effortLevelsForModel(row.model);
      this.#effortIndex = preferredEffortIndex(
        levels,
        this.#roleSummaries,
        action,
        row,
        this.#currentSelector,
        this.#currentThinking,
      );
      this.#stage = "effort";
      this.#receipt = undefined;
      this.#requestRender();
      return;
    }
    await this.#applyCurrentSelection();
  }

  async #applyCurrentSelection(): Promise<void> {
    const row = this.#selectedRow();
    const action = this.#selectedAction;
    const levels = row === undefined ? [] : effortLevelsForModel(row.model);
    const thinking = levels[this.#effortIndex];
    if (row === undefined || action === undefined || thinking === undefined) return;

    this.#applying = true;
    this.#requestRender();
    try {
      const applied = await this.#applySelection({ model: row.model, action, thinking });
      this.#currentSelector = applied.currentSelector;
      this.#currentThinking = applied.currentThinking;
      this.#roleSummaries = applied.roleSummaries;
      this.#receipt = applied.receipt;
      this.#refreshRows();
      this.#restoreSelectedModel(row.selector);
      this.#stage = applied.receipt.kind === "error" ? "effort" : "models";
      if (this.#stage === "models") this.#selectedAction = undefined;
    } catch (error) {
      const message = errorMessage(error);
      this.#receipt = { kind: "error", text: `Apply failed: ${message}` };
      this.#stage = "effort";
    } finally {
      this.#applying = false;
      this.#requestRender();
    }
  }

  #refreshRows(): void {
    this.#rows = this.#rows
      .map((row, index) => {
        const roleTags = this.#roleSummaries
          .filter((role) => role.assignment?.model === row.selector)
          .map((role) => role.tag);
        const current = row.selector === this.#currentSelector;
        return { ...row, roleTags, current, rank: modelRowRank(roleTags, current, index) };
      })
      .sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label));
  }

  #restoreSelectedModel(selector: string): void {
    const index = this.#visibleRows().findIndex((row) => row.selector === selector);
    this.#selectedIndex = Math.max(0, index);
  }

  #back(): void {
    if (this.#stage === "effort") {
      this.#stage = "roles";
      this.#selectedAction = undefined;
    } else {
      this.#stage = "models";
    }
    this.#requestRender();
  }

  #moveFocus(delta: number): void {
    if (this.#stage === "models") this.#moveSelection(delta);
    else if (this.#stage === "roles") {
      this.#roleIndex = cycleIndex(this.#roleIndex, delta, MODEL_ROLE_ACTIONS.length);
      this.#requestRender();
    } else {
      const row = this.#selectedRow();
      const levels = row === undefined ? [] : effortLevelsForModel(row.model);
      this.#effortIndex = cycleIndex(this.#effortIndex, delta, levels.length);
      this.#requestRender();
    }
  }

  #moveProvider(delta: number): void {
    this.#activeProviderIndex = cycleIndex(this.#activeProviderIndex, delta, this.#providers.length);
    this.#selectedIndex = 0;
    this.#receipt = undefined;
    this.#requestRender();
  }

  #moveSelection(delta: number): void {
    const total = this.#visibleRows().length;
    if (total === 0) return;
    this.#selectedIndex = cycleIndex(this.#selectedIndex, delta, total);
    this.#requestRender();
  }

  #visibleRows(): ModelRow[] {
    const provider = this.#providers[this.#activeProviderIndex] ?? ALL_PROVIDER_FILTER;
    return provider === ALL_PROVIDER_FILTER ? this.#rows : this.#rows.filter((row) => row.provider === provider);
  }

  #selectedRow(): ModelRow | undefined {
    return this.#visibleRows()[this.#selectedIndex];
  }

  #finish(): void {
    const done = this.#done;
    this.#done = undefined;
    done?.();
  }

  #requestRender(): void {
    this.#tui.requestRender();
  }
}

export function createModelRoleSelectorTheme(theme: unknown): OperatorThemeLike {
  if (typeof theme !== "object" || theme === null) return {};
  const candidate = theme as Record<string, unknown>;
  const fg = typeof candidate.fg === "function" ? candidate.fg : undefined;
  const bold = typeof candidate.bold === "function" ? candidate.bold : undefined;
  const adapted: OperatorThemeLike = {};
  if (fg !== undefined)
    adapted.fg = (color: Parameters<NonNullable<OperatorThemeLike["fg"]>>[0], text: string) =>
      String(fg.call(candidate, color, text));
  if (bold !== undefined) adapted.bold = (text: string) => String(bold.call(candidate, text));
  return adapted;
}

type ModelSelectorTone = Parameters<NonNullable<OperatorThemeLike["fg"]>>[0];

function semanticText(theme: OperatorThemeLike, tone: ModelSelectorTone, text: string, bold = false): string {
  const colored = typeof theme.fg === "function" ? theme.fg(tone, text) : text;
  return bold && typeof theme.bold === "function" ? theme.bold(colored) : colored;
}

// Action tone only; assignments use success after they are saved.
function roleTone(tag: string): "warning" | "accent" {
  return tag === "CURRENT" || tag === "DEFAULT" || tag === "SMOL" ? "warning" : "accent";
}

function modelNameSuffix(model: ModelLike): string {
  return typeof model.name === "string" && model.name.trim() ? ` — ${model.name.trim()}` : "";
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
  return MODEL_ROLE_ACTIONS.filter((action) => state.effective.get(action.role)?.assignment?.model === selector).map(
    (action) => action.tag,
  );
}

function modelRowRank(roleTags: string[], current: boolean, originalIndex: number): number {
  if (current) return -1;
  const firstRoleIndex = MODEL_ROLE_ACTIONS.findIndex((action) => roleTags.includes(action.tag));
  return firstRoleIndex >= 0 ? firstRoleIndex : MODEL_ROLE_ACTIONS.length + originalIndex;
}

function modelLabel(model: ModelLike): string {
  const name = typeof model.name === "string" && model.name.trim() ? ` — ${model.name.trim()}` : "";
  return `${modelSelector(model)}${name}`;
}

function cleanSelectorPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function preferredEffortIndex(
  levels: readonly ThinkingLevel[],
  summaries: readonly RoleSummary[],
  action: ModelRoleAction,
  row: ModelRow,
  currentSelector: string | undefined,
  currentThinking: ThinkingLevel | undefined,
): number {
  const assigned = summaries.find((summary) => summary.role === action.role)?.assignment;
  const preferred =
    assigned?.model === row.selector
      ? assigned.thinking
      : action.appliesCurrentModel && currentSelector === row.selector
        ? currentThinking
        : "off";
  const index = preferred === undefined ? -1 : levels.indexOf(preferred);
  return Math.max(0, index);
}

function receiptLine(receipt: ModelRoleReceipt): string {
  const marker = receipt.kind === "success" ? "OK" : receipt.kind === "warning" ? "WARN" : "ERROR";
  return `[${marker}] ${receipt.text}`;
}

function formatProvider(provider: string): string {
  return provider.replace(/[-_]+/g, " ").toUpperCase();
}

function visibleModelLimit(width: number): number {
  if (width >= 100) return 8;
  if (width >= 60) return 6;
  return 4;
}

function windowStart(selected: number, total: number, limit: number): number {
  if (total <= limit) return 0;
  return Math.max(0, Math.min(selected - Math.floor(limit / 2), total - limit));
}

function cycleIndex(index: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (index + delta + total) % total;
}
