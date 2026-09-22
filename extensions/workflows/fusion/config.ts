/**
 * Project-local operator configuration for the direct Fusion surface.
 *
 * The Workflow DSL remains call-site configured. This file owns only the
 * reusable `/fusion` + `fusion` tool defaults for one project. Runtime state
 * lives under `.pi/`, so it is neither committed nor packed as user data.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { workflowRootDir } from "../runtime/workflow-run-layout.js";
import type { ExtensionContext, ModelLike } from "../../_shared/host/pi-api.js";
import { getProjectRoot } from "../../_shared/host/pi-api.js";
import {
  WORKFLOW_FUSION_MIN_MEMBERS,
  type WorkflowFusionMember,
  type WorkflowFusionMode,
} from "../runtime/workflow-fusion.js";

export const FUSION_TOOL_NAME = "fusion";
export const FUSION_CONFIG_VERSION = 2;
export const FUSION_CONFIG_UPGRADED_MESSAGE =
  "Fusion configuration was upgraded and left disabled; run /fusion enable after reviewing the selected mode.";

export interface FusionConfig {
  version: typeof FUSION_CONFIG_VERSION;
  enabled: boolean;
  mode: WorkflowFusionMode;
  members: string[];
  judge?: string;
}

export interface AvailableFusionModel {
  selector: string;
  label: string;
}

export interface ValidatedFusionConfig {
  enabled: boolean;
  mode: WorkflowFusionMode;
  members: WorkflowFusionMember[];
  judge: { model: string; label: string };
}

export function defaultFusionConfig(): FusionConfig {
  return { version: FUSION_CONFIG_VERSION, enabled: false, mode: "tool-free", members: [] };
}

export function fusionConfigPath(projectRoot: string): string {
  return path.join(workflowRootDir(projectRoot), "fusion", "config.json");
}

export async function loadFusionConfig(ctx: ExtensionContext): Promise<FusionConfig> {
  try {
    const raw = await readFile(fusionConfigPath(getProjectRoot(ctx)), "utf8");
    const parsed = parseFusionConfig(JSON.parse(raw) as unknown);
    if (parsed === undefined) throw incompatibleFusionConfigError();
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return defaultFusionConfig();
    throw error;
  }
}

export async function saveFusionConfig(ctx: ExtensionContext, config: FusionConfig): Promise<void> {
  const normalized = normalizeStoredFusionConfig(config);
  const configPath = fusionConfigPath(getProjectRoot(ctx));
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Explicit configuration may replace ambiguous v1 intent, but never execute or preserve it. */
export async function loadFusionConfigForConfigure(
  ctx: ExtensionContext,
): Promise<{ config: FusionConfig; upgraded: boolean }> {
  try {
    const raw = await readFile(fusionConfigPath(getProjectRoot(ctx)), "utf8");
    const value = JSON.parse(raw) as unknown;
    const parsed = parseFusionConfig(value);
    if (parsed !== undefined) return { config: parsed, upgraded: false };
    if (isRecord(value) && value.version === 1) return { config: defaultFusionConfig(), upgraded: true };
    throw incompatibleFusionConfigError();
  } catch (error) {
    if (isNotFound(error)) return { config: defaultFusionConfig(), upgraded: false };
    throw error;
  }
}

export async function availableFusionModels(ctx: ExtensionContext): Promise<AvailableFusionModel[]> {
  const registry = ctx.modelRegistry;
  if (registry === undefined) return [];
  const models = await (registry.getAvailable?.() ?? registry.getAll?.() ?? []);
  const bySelector = new Map<string, AvailableFusionModel>();
  for (const model of models) {
    const selector = concreteModelSelector(model);
    if (selector === undefined || bySelector.has(selector)) continue;
    const displayName = typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : model.id;
    bySelector.set(selector, { selector, label: `${displayName} · ${selector}` });
  }
  return [...bySelector.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function validateFusionConfig(
  config: FusionConfig,
  available: readonly AvailableFusionModel[],
): ValidatedFusionConfig {
  if (config.members.length < WORKFLOW_FUSION_MIN_MEMBERS) {
    throw new Error(
      `Fusion requires at least ${WORKFLOW_FUSION_MIN_MEMBERS} member models; configured ${config.members.length}.`,
    );
  }
  const memberSet = new Set(config.members);
  if (memberSet.size !== config.members.length) throw new Error("Fusion member models must be unique.");
  const judge = config.judge?.trim();
  if (judge === undefined || judge === "") throw new Error("Fusion judge model is not configured.");
  if (memberSet.has(judge)) throw new Error("Fusion judge must be different from every member model.");

  const availableSet = new Set(available.map((model) => model.selector));
  if (availableSet.size === 0) throw new Error("Pi exposes no configured models to Fusion.");
  const unavailable = [...config.members, judge].filter((selector) => !availableSet.has(selector));
  if (unavailable.length > 0) {
    throw new Error(`Fusion model(s) are not currently available: ${unavailable.join(", ")}.`);
  }

  return {
    enabled: config.enabled,
    mode: config.mode,
    members: config.members.map((model, index) => ({
      label: `member-${String(index + 1).padStart(2, "0")}`,
      model,
    })),
    judge: { model: judge, label: "judge" },
  };
}

export function parseFusionSetArgs(input: string): Pick<FusionConfig, "mode" | "members" | "judge"> {
  const tokens = input.trim().split(/\s+/u).filter(Boolean);
  let membersText: string | undefined;
  let judge: string | undefined;
  let mode: WorkflowFusionMode | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--members") {
      membersText = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token === "--judge") {
      judge = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token === "--mode") {
      const value = tokens[index + 1];
      if (value !== "tool-free" && value !== "agent") {
        throw new Error('Fusion mode must be "tool-free" or "agent".');
      }
      mode = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown /fusion set argument: ${token}`);
  }
  if (mode === undefined || membersText === undefined || judge === undefined) {
    throw new Error("Usage: /fusion set --mode tool-free|agent --members provider/id,provider/id --judge provider/id");
  }
  const members = membersText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return { mode, members, judge: judge.trim() };
}

function parseFusionConfig(value: unknown): FusionConfig | undefined {
  if (
    !isRecord(value) ||
    value.version !== FUSION_CONFIG_VERSION ||
    typeof value.enabled !== "boolean" ||
    (value.mode !== "tool-free" && value.mode !== "agent")
  ) {
    return undefined;
  }
  if (!Array.isArray(value.members) || !value.members.every((entry) => typeof entry === "string")) return undefined;
  if (value.judge !== undefined && typeof value.judge !== "string") return undefined;
  return normalizeStoredFusionConfig({
    version: FUSION_CONFIG_VERSION,
    enabled: value.enabled,
    mode: value.mode,
    members: value.members,
    ...(value.judge === undefined ? {} : { judge: value.judge }),
  });
}

function normalizeStoredFusionConfig(config: FusionConfig): FusionConfig {
  const members = config.members.map((value) => value.trim()).filter(Boolean);
  const judge = config.judge?.trim();
  return {
    version: FUSION_CONFIG_VERSION,
    enabled: config.enabled,
    mode: config.mode,
    members,
    ...(judge === undefined || judge === "" ? {} : { judge }),
  };
}

function concreteModelSelector(model: ModelLike): string | undefined {
  const provider = model.provider.trim();
  const id = model.id.trim();
  return provider === "" || id === "" ? undefined : `${provider}/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function incompatibleFusionConfigError(): Error {
  return new Error(
    "Fusion config is incompatible with version 2. Run /fusion configure or /fusion set with an explicit --mode to replace it; the replacement will remain disabled until reviewed.",
  );
}
