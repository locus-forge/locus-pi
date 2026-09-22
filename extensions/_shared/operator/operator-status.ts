import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../host/pi-api.js";

export const OPERATOR_STATUS_KEY = "locus";

export type OperatorStatusLane = "blocking" | "activity" | "route" | "secondary";

export interface OperatorStatusContribution {
  id: string;
  lane: OperatorStatusLane;
  priority: number;
  wide: string;
  compact: string;
  narrow: string;
  tone?: "accent" | "warning" | "success";
}

interface OperatorStatusRegistry {
  version: 1;
  byUi: WeakMap<object, Map<string, OperatorStatusContribution>>;
}

const OPERATOR_STATUS_REGISTRY_SYMBOL = Symbol.for("locus-pi.operator-status.v1");
const STATUS_SEPARATOR = " · ";
const ANSI_CONTROL_SEQUENCE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;

const LANE_RANK: Record<OperatorStatusLane, number> = {
  blocking: 0,
  activity: 1,
  route: 2,
  secondary: 3,
};

export function setOperatorStatus(
  ctx: ExtensionContext,
  contribution: OperatorStatusContribution,
  terminalWidth = process.stdout.columns ?? 80,
): void {
  const registry = getOperatorStatusRegistry();
  const contributions = registry.byUi.get(ctx.ui) ?? new Map<string, OperatorStatusContribution>();
  contributions.set(contribution.id, { ...contribution });
  registry.byUi.set(ctx.ui, contributions);
  publishOperatorStatus(ctx, contributions, terminalWidth);
}

export function clearOperatorStatus(
  ctx: ExtensionContext,
  id: string,
  terminalWidth = process.stdout.columns ?? 80,
): void {
  const registry = getOperatorStatusRegistry();
  const contributions = registry.byUi.get(ctx.ui);
  contributions?.delete(id);

  if (contributions === undefined || contributions.size === 0) {
    registry.byUi.delete(ctx.ui);
    ctx.ui.setStatus(OPERATOR_STATUS_KEY, undefined);
    return;
  }

  publishOperatorStatus(ctx, contributions, terminalWidth);
}

export function clearAllOperatorStatuses(ctx: ExtensionContext): void {
  getOperatorStatusRegistry().byUi.delete(ctx.ui);
  ctx.ui.setStatus(OPERATOR_STATUS_KEY, undefined);
}

export function renderOperatorStatus(
  contributions: readonly OperatorStatusContribution[],
  terminalWidth: number,
): string | undefined {
  const parts = statusParts(contributions, terminalWidth);
  return parts.length === 0 ? undefined : parts.map((part) => part.value).join(STATUS_SEPARATOR);
}

function statusParts(
  contributions: readonly OperatorStatusContribution[],
  terminalWidth: number,
): Array<{ value: string; tone?: OperatorStatusContribution["tone"] }> {
  const width = normalizedTerminalWidth(terminalWidth);
  if (width === 0) return [];

  const { budget, projection } = projectionForWidth(width);
  const effectiveBudget = Math.min(width, budget);
  const parts = [...contributions]
    .sort(compareContributions)
    .map((contribution) => ({
      value: stripTerminalControlSequences(contribution[projection]),
      tone: contribution.tone,
    }))
    .filter((part) => visibleWidth(part.value) > 0);

  if (parts.length === 0) return [];

  while (parts.length > 1 && visibleWidth(parts.map((part) => part.value).join(STATUS_SEPARATOR)) > effectiveBudget) {
    parts.pop();
  }

  if (parts.length === 1 && visibleWidth(parts[0]!.value) > effectiveBudget) {
    parts[0] = {
      ...parts[0]!,
      value: truncatePlainStatus(parts[0]!.value, effectiveBudget),
    };
  }
  return parts;
}

function truncatePlainStatus(value: string, maxWidth: number): string {
  // Pi's truncateToWidth() deliberately restores SGR state around its
  // ellipsis. That is correct for terminal rows, but status contributions are
  // host data and are also serialized by RPC. Keep this shared boundary plain
  // so JSON/plain consumers never receive embedded terminal control codes.
  const plain = stripTerminalControlSequences(value);
  if (visibleWidth(plain) <= maxWidth) return plain;

  const ellipsis = maxWidth >= 3 ? "..." : ".".repeat(maxWidth);
  const prefixWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
  return `${sliceByColumn(plain, 0, prefixWidth)}${ellipsis}`;
}

function stripTerminalControlSequences(value: string): string {
  return value.replace(ANSI_CONTROL_SEQUENCE, "");
}

function publishOperatorStatus(
  ctx: ExtensionContext,
  contributions: Map<string, OperatorStatusContribution>,
  terminalWidth: number,
): void {
  const parts = statusParts([...contributions.values()], terminalWidth);
  const rendered =
    parts.length === 0
      ? undefined
      : parts
          .map((part) =>
            part.tone !== undefined && ctx.mode === "tui" && ctx.ui.theme !== undefined
              ? ctx.ui.theme.fg(part.tone, part.value)
              : part.value,
          )
          .join(STATUS_SEPARATOR);
  ctx.ui.setStatus(OPERATOR_STATUS_KEY, rendered);
}

function compareContributions(left: OperatorStatusContribution, right: OperatorStatusContribution): number {
  const laneOrder = LANE_RANK[left.lane] - LANE_RANK[right.lane];
  if (laneOrder !== 0) return laneOrder;

  const priorityOrder = right.priority - left.priority;
  if (priorityOrder !== 0) return priorityOrder;

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function projectionForWidth(width: number): {
  budget: 48 | 28 | 16;
  projection: "wide" | "compact" | "narrow";
} {
  if (width >= 100) return { budget: 48, projection: "wide" };
  if (width >= 60) return { budget: 28, projection: "compact" };
  return { budget: 16, projection: "narrow" };
}

function normalizedTerminalWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.floor(width);
}

function getOperatorStatusRegistry(): OperatorStatusRegistry {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[OPERATOR_STATUS_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const created: OperatorStatusRegistry = {
      version: 1,
      byUi: new WeakMap<object, Map<string, OperatorStatusContribution>>(),
    };
    globalRecord[OPERATOR_STATUS_REGISTRY_SYMBOL] = created;
    return created;
  }

  if (!isOperatorStatusRegistry(existing)) {
    throw new Error("Incompatible global operator status registry at locus-pi.operator-status.v1");
  }
  return existing;
}

function isOperatorStatusRegistry(value: unknown): value is OperatorStatusRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OperatorStatusRegistry>;
  return candidate.version === 1 && candidate.byUi instanceof WeakMap;
}
