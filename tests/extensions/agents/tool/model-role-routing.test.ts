import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThinkingFixture, strong, nonReasoning } from "./thinking-fixture.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../../../model-roles-fixture.js";
import { emit, runTool, renderToolResult } from "../../../test-harness.js";
import { formatModelBadge } from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";

const roots: string[] = [];
afterEach(() => {
  restoreGlobalModelRolesHome();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function projectRoles(root: string, roles: Record<string, string>) {
  const dir = path.join(root, ".pi", "model-roles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, roles }));
}

describe("spawn_agent model-role selection", () => {
  it.each([undefined, "reviewer"])(
    "uses project role over user and profile for %s, with real SDK readback",
    async (agent) => {
      const f = await createThinkingFixture(roots, { profileModel: "openai/gpt-4o-mini" });
      f.h.ctx.model = nonReasoning;
      writeGlobalModelRoles(f.root, { "tier-s": "openai/gpt-4o-mini:off" });
      projectRoles(f.root, { "tier-s": "openai/gpt-5.2:high" });
      const result = await runTool(f.h, "spawn_agent", {
        ...(agent === undefined ? {} : { agent }),
        modelRole: "tier-s",
        requireModelRole: true,
        task: "Return READY",
      });
      expect(result.isError).not.toBe(true);
      expect(f.captured[0]).toMatchObject({ model: strong, thinkingLevel: "high" });
      const { row, result: receipt } = f.readback();
      expect(row).toMatchObject({
        modelRole: "tier-s",
        model: "openai/gpt-5.2",
        thinking: "high",
        modelConfirmed: true,
      });
      expect(formatModelBadge(row)).toBe("tier-s (openai/gpt-5.2, high)");
      expect(receipt).toMatchObject({
        executedModel: "openai/gpt-5.2",
        modelRole: { role: "tier-s", source: "project" },
      });
      const card = renderToolResult(f.h.tools.get("spawn_agent")!, result, f.h.ctx).render(120).join("\n");
      expect(card).toContain("tier-s (openai/gpt-5.2, high)");
      expect(result.details).toMatchObject({
        modelRole: "tier-s",
        model: "openai/gpt-5.2",
        thinking: "high",
        modelConfirmed: true,
      });
    },
  );
  it("routes /agent run profiles through the project file", async () => {
    const f = await createThinkingFixture(roots, { profileModel: "tier-s" });
    writeGlobalModelRoles(f.root, { "tier-s": "openai/gpt-4o-mini:off" });
    projectRoles(f.root, { "tier-s": "openai/gpt-5.2:high" });
    await f.h.commands.get("agent")!.handler("run reviewer Return READY", f.h.ctx);
    expect(f.captured[0]).toMatchObject({ model: strong, thinkingLevel: "high" });
    expect(f.readback().row).toMatchObject({ modelRole: "tier-s", modelConfirmed: true });
  });
  it.each(["high", undefined])(
    "announces only after dispatch with the available session effort %s",
    async (thinking) => {
      const f = await createThinkingFixture(roots);
      f.h.pi.setThinkingLevel?.("low");
      projectRoles(f.root, { "tier-s": `openai/gpt-5.2${thinking === undefined ? "" : `:${thinking}`}` });
      const started: string[] = [];
      await f.h.tools.get("spawn_agent")!.execute(
        "requested-role",
        { task: "Return READY", modelRole: "tier-s" },
        new AbortController().signal,
        (update) => {
          started.push(...(update.content ?? []).filter((c) => c.type === "text").map((c) => c.text));
          const row = [...f.agentLiveStore.rows.values()].at(-1)!;
          expect(row.thinking).toBe(thinking ?? "low");
          expect(row.modelConfirmed).not.toBe(true);
        },
        f.h.ctx,
      );
      expect(started.join("\n")).toContain(`tier-s (openai/gpt-5.2, ${thinking ?? "low"}; requested)`);
    },
  );
  it("publishes configured literal choices before the turn and refreshes after editing", async () => {
    const f = await createThinkingFixture(roots);
    writeGlobalModelRoles(f.root, { userOnly: "openai/gpt-5.2" });
    projectRoles(f.root, { "tier-s": "openai/gpt-5.2:high", MyReviewer: "openai/gpt-5.2:low" });
    const description = () =>
      (f.h.tools.get("spawn_agent")!.parameters as unknown as { properties: { modelRole: { description: string } } })
        .properties.modelRole.description;
    await emit(f.h, "before_agent_start", { systemPrompt: "BASE" });
    expect(description()).toContain('"tier-s", "MyReviewer"');
    expect(description()).toContain("model-roles/config.json");
    expect(description()).not.toContain("userOnly");
    projectRoles(f.root, { replacement: "openai/gpt-5.2" });
    await emit(f.h, "before_agent_start", { systemPrompt: "BASE" });
    expect(description()).toContain('"replacement"');
    expect(description()).not.toContain('"tier-s"');
  });
  it.each([
    { modelRole: "missing", requireModelRole: true },
    { requireModelRole: true },
    { modelRole: "openai/gpt-5.2" },
  ])("refuses invalid explicit selection before SDK creation: %j", async (selection) => {
    const f = await createThinkingFixture(roots);
    projectRoles(f.root, {});
    const result = await runTool(f.h, "spawn_agent", { task: "Return READY", ...selection });
    expect(result.isError).toBe(true);
    expect(f.captured).toHaveLength(0);
    expect(f.stream).not.toHaveBeenCalled();
  });
  it("records parent fallback without claiming an assigned role", async () => {
    const f = await createThinkingFixture(roots);
    projectRoles(f.root, {});
    f.h.pi.setThinkingLevel?.("high");
    await runTool(f.h, "spawn_agent", { task: "Return READY", modelRole: "missing" });
    const { row, result } = f.readback();
    expect(row.modelRole).toBe("missing");
    expect(formatModelBadge(row)).toContain("parent fallback");
    expect(result.modelRoleFallback).toContain("parent session model");
  });
  it("preserves a role suffix override and reports the SDK's actual supported effort", async () => {
    const f = await createThinkingFixture(roots);
    projectRoles(f.root, { "tier-c": "openai/gpt-4o-mini:high" });
    await runTool(f.h, "spawn_agent", { task: "Return READY", modelRole: "tier-c:xhigh" });
    expect(f.captured[0]?.thinkingLevel).toBe("xhigh");
    expect(f.readback().row).toMatchObject({ modelRole: "tier-c", thinking: "off", modelConfirmed: true });
  });
});
