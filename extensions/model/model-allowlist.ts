import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { ExtensionContext, ModelLike } from "../_shared/host/pi-api.js";

const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh)$/u;

type EnabledModelsPolicy =
  { status: "not-configured" } | { status: "configured"; patterns: string[] } | { status: "invalid"; reason: string };

export interface ModelAllowlistDecision {
  allowed: boolean;
  enforced: boolean;
  selector?: string;
  reason?: string;
}

export function piAgentSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
}

export function canonicalModelSelector(model: ModelLike): string {
  const provider = model.provider.trim();
  const id = model.id.trim();
  if (provider === "" || id === "") return "";
  return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
}

export async function checkEnabledModel(
  ctx: Pick<ExtensionContext, "model">,
  settingsPath = piAgentSettingsPath(),
): Promise<ModelAllowlistDecision> {
  const policy = await readEnabledModelsPolicy(settingsPath);
  if (policy.status === "not-configured") return { allowed: true, enforced: false };

  const selector = ctx.model === undefined ? "" : canonicalModelSelector(ctx.model);
  if (policy.status === "invalid") {
    return { allowed: false, enforced: true, selector, reason: policy.reason };
  }
  if (selector === "" || ctx.model === undefined) {
    return {
      allowed: false,
      enforced: true,
      selector,
      reason: `model_not_enabled: active Pi model is unavailable; enabledModels is enforced by ${settingsPath}`,
    };
  }

  const candidates = [selector, ctx.model.id.trim()];
  const allowed = policy.patterns.some((rawPattern) => {
    const pattern = rawPattern.replace(THINKING_SUFFIX, "");
    return candidates.some((candidate) => minimatch(candidate, pattern));
  });
  if (allowed) return { allowed: true, enforced: true, selector };

  return {
    allowed: false,
    enforced: true,
    selector,
    reason: `model_not_enabled: ${selector} is outside enabledModels in ${settingsPath}`,
  };
}

async function readEnabledModelsPolicy(settingsPath: string): Promise<EnabledModelsPolicy> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "not-configured" };
    return { status: "invalid", reason: `model_allowlist_unreadable: ${settingsPath}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: `model_allowlist_invalid_json: ${settingsPath}` };
  }
  if (!isRecord(parsed) || !("enabledModels" in parsed)) return { status: "not-configured" };
  if (!Array.isArray(parsed.enabledModels) || !parsed.enabledModels.every(isNonEmptyString)) {
    return { status: "invalid", reason: `model_allowlist_invalid: enabledModels must be a non-empty string array` };
  }
  if (parsed.enabledModels.length === 0) {
    return { status: "invalid", reason: `model_allowlist_empty: enabledModels contains no allowed model` };
  }
  return { status: "configured", patterns: parsed.enabledModels };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
