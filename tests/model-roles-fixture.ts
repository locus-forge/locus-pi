import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getModelRolesConfigPath } from "../extensions/_shared/model/model-settings.js";

const originalModelRolesHome = process.env.PI_MODEL_ROLES_HOME;

export function writeGlobalModelRoles(root: string, roles: Record<string, string>): void {
  process.env.PI_MODEL_ROLES_HOME = path.join(root, ".pi-user");
  const configPath = getModelRolesConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ version: 1, roles }, null, 2)}\n`, "utf8");
}

export function restoreGlobalModelRolesHome(): void {
  if (originalModelRolesHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
  else process.env.PI_MODEL_ROLES_HOME = originalModelRolesHome;
}
