import { applyModelRole } from "../../../extensions/model/role-apply.js";
import { modelRoleAction } from "../../../extensions/model/selector/options.js";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import model from "../../../extensions/model/index.js";
import {
  getModelRolesConfigPath,
  loadModelRolesState,
  setModelRoleSetting,
} from "../../../extensions/_shared/model/model-settings.js";
import {
  buildModelRows,
  roleSummaries,
  ModelRoleSelectorComponent,
} from "../../../extensions/model/model-role-selector.js";
import { resolveWorkflowTier } from "../../../extensions/workflows/runtime/workflow-agent-model.js";
import { createHarness } from "../../test-harness.js";

let root: string;
let projectFile: string;
const fast = { provider: "test", id: "fast", reasoning: true };
const strong = { provider: "test", id: "strong", reasoning: true };
async function write(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "project-model-roles-")));
  projectFile = join(root, ".pi", "model-roles", "config.json");
  vi.stubEnv("PI_MODEL_ROLES_HOME", join(root, "user"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("selected model-role file", () => {
  it("uses the user path for a missing configuration and reloads assignments", async () => {
    const empty = await loadModelRolesState(root);
    expect(empty).toMatchObject({ path: getModelRolesConfigPath(), source: "user", exists: false });
    await setModelRoleSetting("tier-s", { model: "test/strong", thinking: "high" }, empty.path);
    const state = await loadModelRolesState(root);
    expect(state).toMatchObject({ path: await realpath(empty.path), source: "user", exists: true });
    expect(state.effective.get("tier-s")?.assignment).toEqual({ model: "test/strong", thinking: "high" });
  });
  it("replaces all user assignments with the project file, including an empty project", async () => {
    await write(getModelRolesConfigPath(), { roles: { "tier-s": "test/fast", userOnly: "test/fast" } });
    await write(projectFile, { roles: { "tier-s": "test/strong:high", MyReviewer: "test/strong:low" } });
    const state = await loadModelRolesState(root);
    expect(state).toMatchObject({ source: "project", path: await realpath(projectFile) });
    expect(state.effective.has("userOnly")).toBe(false);
    expect(state.effective.get("MyReviewer")?.source).toBe("project");
    await setModelRoleSetting("MyReviewer", { model: "test/fast" }, state.path);
    expect(JSON.parse(await readFile(projectFile, "utf8")).roles.MyReviewer).toBe("test/fast");
    expect(JSON.parse(await readFile(getModelRolesConfigPath(), "utf8")).roles.userOnly).toBe("test/fast");
    await write(projectFile, { roles: {} });
    expect((await loadModelRolesState(root)).effective.get("tier-s")?.assignment).toBeUndefined();
  });
  it.each([
    "broken-json",
    { roles: [] },
    { roles: { "tier-s:high": "test/strong" } },
    { roles: { "bad/role": "test/fast" } },
    { roles: { "tier-s": { model: "test/strong", thinking: "banana" } } },
    { roles: { "tier-s": { model: "test/strong", thinking: "" } } },
    { roles: { "tier-s": { model: "test/strong", thinking: null } } },
    { version: 2 },
  ])("refuses invalid project input without reading user assignments: %j", async (value) => {
    await write(getModelRolesConfigPath(), { roles: { "tier-s": "test/fast" } });
    await write(projectFile, value);
    if (value === "broken-json") await writeFile(projectFile, "{broken");
    await expect(loadModelRolesState(root)).rejects.toThrow(projectFile);
  });
  it("refuses an unreadable project path instead of falling back", async () => {
    await mkdir(projectFile, { recursive: true });
    await expect(loadModelRolesState(root)).rejects.toThrow(projectFile);
  });
  it("reports a dangling project file link instead of loading the user file", async () => {
    await write(getModelRolesConfigPath(), { roles: { "tier-s": "test/fast" } });
    await mkdir(dirname(projectFile), { recursive: true });
    await symlink(join(root, "missing.json"), projectFile);
    await expect(loadModelRolesState(root)).rejects.toThrow(projectFile);
  });
  it("refuses a stale selector source before changing the session or either file", async () => {
    const state = await loadModelRolesState(root);
    await write(projectFile, { roles: {} });
    const h = createHarness(root, { models: [fast] });
    const result = await applyModelRole(
      h.pi,
      h.ctx,
      { model: fast, action: modelRoleAction("default"), thinking: "off" },
      state.path,
    );
    expect(result.receipt).toMatchObject({ kind: "error", text: expect.stringContaining("source changed") });
    expect(h.selectedModel).toBeUndefined();
    expect(JSON.parse(await readFile(projectFile, "utf8"))).toEqual({ roles: {} });
  });
  it("resolves workflow declarations from the selected project assignment", async () => {
    await write(getModelRolesConfigPath(), { roles: { "tier-s": "test/fast" } });
    await write(projectFile, { roles: { "tier-s": "test/strong:high" } });
    const resolveModelFn = vi.fn(async (selector: string) => ({
      ok: true as const,
      selector: "test/strong",
      provider: "test",
      id: "strong",
      model: strong,
      thinking: "high" as const,
    }));
    const tier = await resolveWorkflowTier({
      req: { prompt: "Review", modelRole: "tier-s", requireModelRole: true },
      agent: undefined,
      modelRoles: await loadModelRolesState(root),
      resolveModelFn,
    });
    expect(resolveModelFn).toHaveBeenCalledWith("test/strong:high");
    expect(tier).toMatchObject({
      kind: "resolved",
      model: strong,
      thinking: "high",
      roleResolution: { role: "tier-s", source: "project", configPath: await realpath(projectFile) },
    });
  });
});

describe("dynamic model-role selector", () => {
  it("loads literal custom names and saves to the displayed project file", async () => {
    await write(getModelRolesConfigPath(), { roles: { MyReviewer: "test/strong:low" } });
    await write(projectFile, { roles: { MyReviewer: "test/strong:high" } });
    const state = await loadModelRolesState(root);
    const h = createHarness(root, { models: [fast, strong] });
    model(h.pi);
    const roleIndex = roleSummaries(state).findIndex((x) => x.role === "MyReviewer");
    // The assigned strong model sorts first; choose the other model, then the custom role.
    h.customInputQueue.push("\x1b[B", "\r", ...Array(roleIndex).fill("\x1b[B"), "\r", "\r", "q");
    await h.commands.get("model-roles")!.handler("", h.ctx);
    const frames = h.customRenderFrames.flat().join("\n");
    expect(frames).toContain("Set as MyReviewer");
    expect(frames).not.toContain("MYREVIEWER");
    expect(frames).toContain("File:");
    expect(frames).toContain("model-roles/config.json");
    expect(JSON.parse(await readFile(projectFile, "utf8")).roles.MyReviewer).toBe("test/fast:off");
    expect(JSON.parse(await readFile(getModelRolesConfigPath(), "utf8")).roles.MyReviewer).toBe("test/strong:low");
    expect(h.selectedModel).toBeUndefined();
  });
  it("keeps arbitrary role lists navigable and wraps the complete source path", async () => {
    const roles = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`custom-${i}`, "test/fast"]));
    await write(projectFile, { roles });
    const state = await loadModelRolesState(root);
    const path = "/" + "long-directory/".repeat(12) + "model-roles/config.json";
    const applySelection = vi.fn();
    const component = new ModelRoleSelectorComponent(
      { requestRender() {} },
      {},
      {
        rows: buildModelRows([fast], state, undefined),
        roleSummaries: roleSummaries(state),
        currentSelector: undefined,
        currentThinking: undefined,
        configPath: path,
        applySelection,
      },
    );
    await component.handleInput("\r");
    const target = roleSummaries(state).findIndex((x) => x.role === "custom-29");
    for (let i = 0; i < target; i++) await component.handleInput("\x1b[B");
    const lines = component.render(48);
    expect(lines.join("\n")).toContain("Set as custom-29");
    expect(lines.filter((x) => x.includes("Set as"))).toHaveLength(8);
    expect(lines.every((x) => visibleWidth(x) <= 48)).toBe(true);
    expect(lines.map((x) => x.replace(/^│\s?/, "").replace(/\s*│$/, "")).join("")).toContain(path);
    await component.handleInput("q");
    expect(applySelection).not.toHaveBeenCalled();
  });
});
