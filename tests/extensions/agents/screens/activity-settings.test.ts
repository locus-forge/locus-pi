import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  loadActivityLimit,
  persistActivityLimit,
  activitySettingsPath,
} from "../../../../extensions/agents/fleet/activity-settings.js";
it("persists limit across reload preserving unrelated user settings; refuses invalid/locked writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-settings-"));
  try {
    expect(await loadActivityLimit(root)).toBe(4);
    await mkdir(join(root, ".pi"));
    await writeFile(activitySettingsPath(root), JSON.stringify({ custom: "keep", activityStrip: { color: "keep" } }));
    await persistActivityLimit(root, 2);
    expect(await loadActivityLimit(root)).toBe(2);
    expect(JSON.parse(await readFile(activitySettingsPath(root), "utf8"))).toEqual({
      custom: "keep",
      activityStrip: { color: "keep", maxItems: 2 },
    });
    await expect(persistActivityLimit(root, 0)).rejects.toThrow();
    await writeFile(`${activitySettingsPath(root)}.lock`, "another editor");
    await expect(persistActivityLimit(root, 7)).rejects.toThrow();
    expect(await loadActivityLimit(root)).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
