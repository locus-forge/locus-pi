import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import agents from "../../extensions/agents/index.js";
import model from "../../extensions/model/index.js";
import workflows from "../../extensions/workflows/index.js";
import type { ExtensionCommandContext } from "../../extensions/_shared/host/pi-api.js";
import { pinTransientUiKey, unpinTransientUiKey } from "../../extensions/_shared/operator/command-ui.js";
import { createHarness, emit } from "../test-harness.js";

describe("command UI lifecycle", () => {
  it("dismisses the latest passive VIEW with Escape and leaves no raw listener behind", async () => {
    const h = createHarness();
    delete h.ctx.ui.custom;
    workflows(h.pi);

    // A TUI with custom UI owns the persisted evidence viewer. Removing that
    // capability exercises the bounded passive status fallback and its raw
    // editor-level transient dismissal.
    await h.commands.get("workflows")!.handler("status", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow runs");
    expect(h.terminalInputHandlers.size).toBe(1);

    const result = [...h.terminalInputHandlers][0]?.("\x1b");

    expect(result).toEqual({ consume: true });
    expect(h.widgetPayloads.get("workflows")).toBeUndefined();
    expect(h.widgets.get("workflows")).toBe("");
    expect(h.terminalInputHandlers.size).toBe(0);
  });

  it("installs the passive lifecycle immediately when the workflow custom viewer fails", async () => {
    const h = createHarness();
    h.ctx.ui.custom = (async () => {
      throw new Error("viewer setup failed");
    }) as NonNullable<typeof h.ctx.ui.custom>;
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("status", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow runs");
    expect(h.widgets.get("workflows")).toContain("Interactive evidence viewer failed: viewer setup failed.");
    expect(h.widgets.get("workflows")).toContain("evidence is shown instead.");
    expect(h.widgets.get("workflows")).not.toContain("Recovery: /workflows status");
    expect(h.terminalInputHandlers.size).toBe(1);
  });

  it("clears transient widgets and statuses when an unrelated slash command is entered", async () => {
    const h = createHarness();
    agents(h.pi);
    model(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    h.ctx.ui.setStatus("agents", "stale agent status");

    await emit(h, "input", { text: "/model-roles" });

    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(h.widgets.get("agents")).toBe("");
    expect(h.statuses.has("agents")).toBe(false);
  });

  it("keeps related transient UI on input so the command handler can replace it", async () => {
    const h = createHarness();
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    await emit(h, "input", { text: "/agent list" });

    expect(h.widgets.get("agents")).toBe("Agent observer: no live rows");
    expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
  });

  it("keeps a pinned live progress widget alive when a chat message is submitted", async () => {
    const h = createHarness();
    agents(h.pi);

    // A live task/spawn_agent run installs the "agents" progress widget and pins it.
    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
    pinTransientUiKey(h.pi, "agents");

    try {
      // A plain chat line normally clears transient command UI; a pinned key survives.
      await emit(h, "input", { text: "just a chat message" });
      expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
      expect(h.widgets.get("agents")).toBe("Agent observer: no live rows");
    } finally {
      unpinTransientUiKey(h.pi, "agents");
    }

    // Once unpinned, the next chat message clears it (no regression to lifecycle UX).
    await emit(h, "input", { text: "another chat message" });
    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(h.widgets.get("agents")).toBe("");
  });

  it("does not clear explicitly persistent command status surfaces", async () => {
    const h = createHarness();
    model(h.pi);
    agents(h.pi);

    h.ctx.ui.setStatus("model-roles", "Model roles: DEFAULT=test/fast");

    await h.commands.get("agent")!.handler("list", h.ctx as ExtensionCommandContext);

    expect(h.statuses.get("model-roles")).toBe("Model roles: DEFAULT=test/fast");
  });

  it("shares cleanup, pinning, and owner callbacks across fresh entrypoint module caches without leaking UI scopes", async () => {
    const alphaPath = path.resolve("tests/fixtures/extensions/command-ui-alpha.ts");
    const betaPath = path.resolve("tests/fixtures/extensions/command-ui-beta.ts");
    const emptyAgentDir = mkdtempSync(path.join(tmpdir(), "locus-pi-empty-agent-dir-"));

    try {
      const loaded = await discoverAndLoadExtensions([alphaPath, betaPath], process.cwd(), emptyAgentDir);
      expect(loaded.errors).toEqual([]);
      const alpha = loaded.extensions.find((extension) => extension.resolvedPath === alphaPath);
      const beta = loaded.extensions.find((extension) => extension.resolvedPath === betaPath);
      const showAlpha = alpha?.commands.get("test-alpha-view")?.handler as unknown as
        ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
      const showBeta = beta?.commands.get("test-beta-view")?.handler as unknown as
        ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
      const betaInput = beta?.handlers.get("input")?.[0] as unknown as
        ((event: { type: "input"; text: string }, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
      const h = createHarness();

      expect(showAlpha).toBeDefined();
      expect(showBeta).toBeDefined();
      expect(betaInput).toBeDefined();
      await showAlpha?.("", h.ctx);
      expect(h.widgets.get("fixture-alpha")).toBe("alpha view");
      expect(h.statuses.get("fixture-alpha-route")).toBe("alpha persistent route");

      await betaInput?.({ type: "input", text: "/test-alpha-view" }, h.ctx);
      expect(h.widgets.get("fixture-alpha")).toBe("alpha view");

      const widgetWrites: Array<{ key: string; cleared: boolean }> = [];
      const setWidget = h.ctx.ui.setWidget.bind(h.ctx.ui);
      h.ctx.ui.setWidget = (key, content, options) => {
        widgetWrites.push({ key, cleared: content === undefined });
        setWidget(key, content, options);
      };
      await showBeta?.("", h.ctx);

      const alphaClear = widgetWrites.findIndex((write) => write.key === "fixture-alpha" && write.cleared);
      const betaRender = widgetWrites.findIndex((write) => write.key === "fixture-beta" && !write.cleared);
      expect(alphaClear).toBeGreaterThanOrEqual(0);
      expect(betaRender).toBeGreaterThan(alphaClear);
      expect(h.widgetPayloads.get("fixture-alpha")).toBeUndefined();
      expect(h.statuses.has("fixture-alpha")).toBe(false);
      expect(h.statuses.get("fixture-alpha-cleanup")).toBe("alpha owner cleanup ran");
      expect(h.statuses.get("fixture-alpha-route")).toBe("alpha persistent route");
      expect(h.widgets.get("fixture-beta")).toBe("beta view");

      await showAlpha?.("pin", h.ctx);
      await showBeta?.("", h.ctx);
      expect(h.widgets.get("fixture-alpha")).toBe("alpha view");
      expect(h.statuses.get("fixture-alpha")).toBe("alpha transient status");
      expect(h.statuses.has("fixture-alpha-cleanup")).toBe(false);
      expect(h.statuses.get("fixture-alpha-route")).toBe("alpha persistent route");

      await showAlpha?.("unpin", h.ctx);
      await showBeta?.("", h.ctx);
      expect(h.widgetPayloads.get("fixture-alpha")).toBeUndefined();
      expect(h.statuses.get("fixture-alpha-cleanup")).toBe("alpha owner cleanup ran");

      const isolatedAlpha = createHarness();
      const isolatedBeta = createHarness();
      await showAlpha?.("", isolatedAlpha.ctx);
      await showBeta?.("", isolatedBeta.ctx);
      expect(isolatedAlpha.widgets.get("fixture-alpha")).toBe("alpha view");
      expect(isolatedBeta.widgets.get("fixture-beta")).toBe("beta view");
    } finally {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    }
  });
});
