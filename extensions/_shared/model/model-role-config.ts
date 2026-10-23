/** Selected model-role file, structural validation and atomic persistence. */
import { randomUUID } from "node:crypto";
import { mkdir, open, lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "../host/pi-api.js";

const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_TIMEOUT_MS = 2_000;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}
export interface ModelRoleAssignment {
  model: string;
  thinking?: ThinkingLevel;
}
export type ModelRoleValue = string | ModelRoleAssignment | null;
export interface ModelRolesConfig {
  version?: 1;
  roles?: Record<string, ModelRoleValue>;
  cycleOrder?: string[];
}
export interface ModelRolePersistenceOutcome {
  rolePersisted: true;
  lockReleaseError?: string;
}
export interface ModelRoleConfigFile {
  path: string;
  source: "user" | "project";
  exists: boolean;
  config: ModelRolesConfig;
}

export function getModelRolesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_MODEL_ROLES_HOME ?? join(homedir(), ".pi", "agent"), "model-roles", "config.json");
}

export async function loadModelRoleConfig(projectRoot?: string): Promise<ModelRoleConfigFile> {
  if (projectRoot !== undefined) {
    const path = await canonicalConfigPath(resolve(projectRoot, ".pi", "model-roles", "config.json"));
    const config = await readConfig(path);
    if (config !== undefined) return { path, source: "project", exists: true, config };
  }
  const path = await canonicalConfigPath(getModelRolesConfigPath());
  const config = await readConfig(path);
  return { path, source: "user", exists: config !== undefined, config: config ?? {} };
}

/** Resolve existing parents too, so creating a missing file does not change its identity. */
async function canonicalConfigPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNotFound(error))
      throw new Error(`Cannot resolve model-roles config ${path}: ${describeError(error)}`, { cause: error });
    return join(await canonicalConfigPath(dirname(path)), basename(path));
  }
}

export async function persistModelRole(
  path: string,
  role: string,
  value: string,
): Promise<ModelRolePersistenceOutcome> {
  validateRoleName(role);
  const outcome = await withConfigLock(path, async () => {
    const config = (await readConfig(path)) ?? {};
    await writeConfig(path, { ...config, version: 1, roles: { ...config.roles, [role]: value } });
  });
  return {
    rolePersisted: true,
    ...(outcome.lockReleaseError === undefined ? {} : { lockReleaseError: outcome.lockReleaseError }),
  };
}

export function validateRoleName(role: string): void {
  if (
    !role ||
    role !== role.trim() ||
    /[\/\x00-\x1f\x7f]/.test(role) ||
    /:(off|minimal|low|medium|high|xhigh)$/.test(role)
  ) {
    throw new Error(
      `Invalid model role name ${JSON.stringify(role)}: use a nonblank name without slashes, control characters or a reserved thinking suffix.`,
    );
  }
}

async function readConfig(path: string): Promise<ModelRolesConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      try {
        await lstat(path);
      } catch (missing) {
        if (isNotFound(missing)) return undefined;
        throw missing;
      }
    }
    throw new Error(`Cannot read model-roles config ${path}: ${describeError(error)}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || (parsed.version !== undefined && parsed.version !== 1))
      throw new Error("Expected a version 1 configuration object");
    if (parsed.roles !== undefined) {
      if (!isObject(parsed.roles)) throw new Error("roles must be an object");
      for (const [role, value] of Object.entries(parsed.roles)) {
        validateRoleName(role);
        if (
          value !== null &&
          typeof value !== "string" &&
          !(
            isObject(value) &&
            typeof value.model === "string" &&
            (value.thinking === undefined || isThinkingLevel(value.thinking))
          )
        )
          throw new Error(`Invalid assignment for role ${JSON.stringify(role)}`);
      }
    }
    if (parsed.cycleOrder !== undefined) {
      if (!Array.isArray(parsed.cycleOrder) || !parsed.cycleOrder.every((x) => typeof x === "string"))
        throw new Error("cycleOrder must be an array of role names");
      parsed.cycleOrder.forEach(validateRoleName);
    }
    return parsed as ModelRolesConfig;
  } catch (error) {
    const message = `Invalid model-roles config ${path}: ${describeError(error)}`;
    if (error instanceof SyntaxError) throw new SyntaxError(message, { cause: error });
    throw new Error(message, { cause: error });
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeConfig(path: string, value: ModelRolesConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

interface ConfigLockOutcome<T> {
  value: T;
  lockReleaseError?: string;
}

async function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<ConfigLockOutcome<T>> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  while (true) {
    let lockCreated = false;
    try {
      const handle = await open(lockPath, "wx");
      lockCreated = true;
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (lockCreated) await unlink(lockPath).catch(() => undefined);
      if (!isCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for model-role config lock: ${lockPath}. ` +
            "If no Pi process is changing model roles, remove this lock file and retry.",
        );
      }
      await delay(CONFIG_LOCK_RETRY_MS);
    }
  }
  let value: T;
  try {
    value = await operation();
  } catch (operationError) {
    // The write error is the primary failure. A secondary cleanup error must
    // never replace it; the surviving lock makes the next attempt fail closed.
    await unlink(lockPath).catch(() => undefined);
    throw operationError;
  }
  try {
    await unlink(lockPath);
    return { value };
  } catch (error) {
    return {
      value,
      lockReleaseError:
        `Could not release model-role config lock ${lockPath}: ${describeError(error)}. ` +
        "If no Pi process is changing model roles, remove this lock file before the next change.",
    };
  }
}

function isNotFound(error: unknown): boolean {
  return isCode(error, "ENOENT");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
