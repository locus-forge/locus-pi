import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModelRolesConfigPath, setModelRoleSetting } from "../../../extensions/_shared/model/model-settings.js";

const execFileAsync = promisify(execFile);

describe("global model-role persistence", () => {
  const originalHome = process.env.PI_MODEL_ROLES_HOME;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-model-persistence-"));
    process.env.PI_MODEL_ROLES_HOME = join(root, "home");
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });

  it("preserves object-form routes when it updates the global config", async () => {
    const configPath = getModelRolesConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ version: 1, roles: { smol: { model: "test/strong", thinking: "xhigh" } } }, null, 2)}\n`,
      "utf8",
    );

    await setModelRoleSetting("agent", { model: "test/fast", thinking: "low" });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      roles: { agent: "test/fast:low", smol: { model: "test/strong", thinking: "xhigh" } },
    });
  });

  it("serializes updates from separate processes and leaves no lock or temporary file", async () => {
    await Promise.all([
      writeRoleInChild(process.env.PI_MODEL_ROLES_HOME!, "smol", "test/fast", "low"),
      writeRoleInChild(process.env.PI_MODEL_ROLES_HOME!, "agent", "test/strong", "high"),
    ]);

    const configPath = getModelRolesConfigPath();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      roles: { smol: "test/fast:low", agent: "test/strong:high" },
    });
    expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
  });

  it("never steals or releases a pre-existing lock", async () => {
    const lockPath = `${getModelRolesConfigPath()}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '{"owner":"other-process"}\n', "utf8");

    await expect(setModelRoleSetting("agent", { model: "test/fast" })).rejects.toThrow(
      "Timed out waiting for model-role config lock",
    );
    expect(await readFile(lockPath, "utf8")).toBe('{"owner":"other-process"}\n');
  });
});

async function writeRoleInChild(home: string, role: string, model: string, thinking: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "extensions", "_shared", "model", "model-settings.ts")).href;
  const script = [
    `const { setModelRoleSetting } = await import(${JSON.stringify(moduleUrl)});`,
    `await setModelRoleSetting(${JSON.stringify(role)}, { model: ${JSON.stringify(model)}, thinking: ${JSON.stringify(thinking)} });`,
  ].join("\n");
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, PI_MODEL_ROLES_HOME: home },
  });
}
