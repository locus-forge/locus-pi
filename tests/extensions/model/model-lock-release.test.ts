import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockMock = vi.hoisted(() => ({ failRelease: false }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (lockMock.failRelease && String(path).endsWith(".lock")) {
        const error = new Error("simulated EACCES while releasing lock") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return actual.unlink(path);
    },
  };
});

import { getModelRolesConfigPath, setModelRoleSetting } from "../../../extensions/_shared/model/model-settings.js";
import { applyModelRole } from "../../../extensions/model/role-apply.js";
import { MODEL_ROLE_ACTIONS } from "../../../extensions/model/model-role-selector.js";
import { createHarness } from "../../test-harness.js";

describe("model-role lock release reporting", () => {
  const originalHome = process.env.PI_MODEL_ROLES_HOME;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-model-lock-release-"));
    process.env.PI_MODEL_ROLES_HOME = join(root, "home");
    lockMock.failRelease = true;
  });

  afterEach(async () => {
    lockMock.failRelease = false;
    if (originalHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });

  it("reports a saved route separately from its failed lock cleanup", async () => {
    const outcome = await setModelRoleSetting("agent", { model: "test/fast", thinking: "low" });
    const configPath = getModelRolesConfigPath();

    expect(outcome).toMatchObject({
      rolePersisted: true,
      lockReleaseError: expect.stringContaining(`Could not release model-role config lock ${configPath}.lock`),
    });
    expect(outcome.lockReleaseError).toContain("remove this lock file before the next change");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ roles: { agent: "test/fast:low" } });
    expect(await readFile(`${configPath}.lock`, "utf8")).toContain(`"pid":${process.pid}`);
  });

  it("shows partial success in the operator receipt without claiming the route was not saved", async () => {
    const projectRoot = join(root, "project");
    const harness = createHarness(projectRoot, {
      models: [{ provider: "test", id: "fast", name: "Test Fast", reasoning: true }],
    });

    const result = await applyModelRole(harness.pi, harness.ctx, {
      model: { provider: "test", id: "fast", name: "Test Fast", reasoning: true },
      action: MODEL_ROLE_ACTIONS[1],
      thinking: "low",
    });

    expect(result.receipt.kind).toBe("warning");
    expect(result.receipt.text).toContain("AGENT → test/fast:low saved.");
    expect(result.receipt.text).toContain("Could not release model-role config lock");
    expect(result.receipt.text).not.toContain("route was not saved");
    expect(harness.entries.at(0)).toMatchObject({
      type: "model-roles",
      data: { role: "agent", assignment: "test/fast:low", rolePersisted: true },
    });
  });

  it("keeps the operation error primary when cleanup also fails", async () => {
    const configPath = getModelRolesConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{invalid json\n", "utf8");

    await expect(setModelRoleSetting("agent", { model: "test/fast" })).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(`${configPath}.lock`, "utf8")).toContain(`"pid":${process.pid}`);
  });
});
