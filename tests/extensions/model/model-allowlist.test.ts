import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import model from "../../../extensions/model/index.js";
import { canonicalModelSelector, checkEnabledModel } from "../../../extensions/model/model-allowlist.js";
import { createHarness, emit } from "../../test-harness.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("enabledModels hard gate", () => {
  it("uses provider/model even when the model id contains slashes", () => {
    expect(canonicalModelSelector({ provider: "openrouter", id: "stealth/ox-alpha" })).toBe(
      "openrouter/stealth/ox-alpha",
    );
    expect(canonicalModelSelector({ provider: "openai-codex", id: "openai-codex/gpt-5.6-sol" })).toBe(
      "openai-codex/gpt-5.6-sol",
    );
  });

  it("allows exact, bare-id, glob, and effort-qualified enabledModels entries", async () => {
    const settings = await settingsFile(["openrouter/stealth/*", "gpt-5.6-sol:high"]);

    await expect(
      checkEnabledModel({ model: { provider: "openrouter", id: "stealth/ox-alpha" } }, settings),
    ).resolves.toMatchObject({ allowed: true, enforced: true });
    await expect(
      checkEnabledModel({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } }, settings),
    ).resolves.toMatchObject({ allowed: true, enforced: true });
  });

  it("blocks an explicit catalog model outside enabledModels before agent processing", async () => {
    const agentDir = await agentSettingsDir(["openai-codex/gpt-5.6-sol"]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const harness = createHarness(undefined, {
      models: [{ provider: "openrouter", id: "anthropic/claude-fable-5" }],
    });
    harness.ctx.model = { provider: "openrouter", id: "anthropic/claude-fable-5" };
    model(harness.pi);

    const results = await emit(harness, "input", { text: "review", source: "interactive" });

    expect(results).toContainEqual({ action: "handled" });
    expect(harness.notifications).toContain(
      `model_not_enabled: openrouter/anthropic/claude-fable-5 is outside enabledModels in ${join(agentDir, "settings.json")}`,
    );
  });

  it("fails closed when configured enabledModels is empty or invalid", async () => {
    const empty = await settingsFile([]);
    const invalidRoot = await tempRoot();
    const invalid = join(invalidRoot, "settings.json");
    await writeFile(invalid, "{not-json", "utf8");
    const ctx = { model: { provider: "openai-codex", id: "gpt-5.6-sol" } };

    await expect(checkEnabledModel(ctx, empty)).resolves.toMatchObject({
      allowed: false,
      reason: "model_allowlist_empty: enabledModels contains no allowed model",
    });
    await expect(checkEnabledModel(ctx, invalid)).resolves.toMatchObject({
      allowed: false,
      reason: `model_allowlist_invalid_json: ${invalid}`,
    });
  });

  it("does not invent a policy when enabledModels is absent", async () => {
    const root = await tempRoot();
    const settings = join(root, "settings.json");
    await writeFile(settings, JSON.stringify({ defaultModel: "test/fast" }), "utf8");

    await expect(checkEnabledModel({ model: { provider: "test", id: "fast" } }, settings)).resolves.toEqual({
      allowed: true,
      enforced: false,
    });
  });
});

async function settingsFile(enabledModels: string[]): Promise<string> {
  const root = await tempRoot();
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify({ enabledModels }), "utf8");
  return path;
}

async function agentSettingsDir(enabledModels: string[]): Promise<string> {
  const root = await tempRoot();
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels }), "utf8");
  return agentDir;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-model-allowlist-"));
  roots.push(root);
  return root;
}
