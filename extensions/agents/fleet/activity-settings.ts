import { mkdir, readFile, open, rename, unlink, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Project-local UI preference, separate from Pi-owned settings and model-role configuration. */
export function activitySettingsPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "agents-ui.json");
}
async function read(path: string): Promise<Record<string, unknown>> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Refusing symlinked agents-ui settings.");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("agents-ui settings must be an object.");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export function validActivityLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20;
}
export async function loadActivityLimit(projectRoot: string): Promise<number> {
  const config = await read(activitySettingsPath(projectRoot));
  if (config.activityStrip === undefined) return 4;
  const strip = config.activityStrip;
  if (typeof strip !== "object" || strip === null || Array.isArray(strip))
    throw new Error("activityStrip must be an object.");
  const max = (strip as Record<string, unknown>).maxItems;
  if (max === undefined) return 4;
  if (!validActivityLimit(max)) throw new Error("activityStrip.maxItems must be 1–20.");
  return max;
}
export async function persistActivityLimit(projectRoot: string, maxItems: number): Promise<void> {
  if (!validActivityLimit(maxItems)) throw new Error("activityStrip.maxItems must be 1–20.");
  const path = activitySettingsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const handle = await open(lock, "wx"); // fail closed on a concurrent editor, never overwrite its lock
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const config = await read(path);
    const strip = config.activityStrip;
    if (strip !== undefined && (typeof strip !== "object" || strip === null || Array.isArray(strip)))
      throw new Error("activityStrip must be an object.");
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(
        `${JSON.stringify({ ...config, activityStrip: { ...(strip as object | undefined), maxItems } }, null, 2)}\n`,
      );
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
    await handle.close();
    await unlink(lock);
  }
}
