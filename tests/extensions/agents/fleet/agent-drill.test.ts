import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import agents from "../../../../extensions/agents/index.js";
import { ScrollableTextOverlay } from "../../../../extensions/agents/fleet/drill-overlay.js";
import * as sessionViewer from "../../../../extensions/agents/fleet/session-viewer.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { SupersededInlineOperatorInteractionError } from "../../../../extensions/_shared/operator/operator-interaction.js";
import type { ExtensionCommandContext } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness, emit } from "../../../test-harness.js";

afterEach(() => {
  agentLiveStore.reset();
});

function registerRow(id: string, status: "queued" | "working" | "done" | "error", agentName = "reviewer"): void {
  agentLiveStore.begin({ id, agentName, label: `${agentName} ${id}`, isolated: false, noMcp: false });
  agentLiveStore.patch(id, { status });
}

describe("agent drill command and inline interaction", () => {
  it("warns when Pi namespaces a /ps collision and names /agent ps fallback", async () => {
    const h = createHarness();
    h.pi.getCommands = () => [
      { name: "ps:1", source: "extension" },
      { name: "ps:2", source: "extension" },
    ];
    agents(h.pi);
    await emit(h, "session_start");

    expect(h.notifications).toContain(
      "Multiple /ps commands are loaded (ps:1, ps:2). Use /agent ps as the stable Locus fallback.",
    );
  });

  it("registers /ps as primary direct viewer navigation with /agent ps compatibility", async () => {
    const row = agentLiveStore.begin({ id: "ps-row", agentName: "reviewer", label: "Review" });
    const primary = createHarness();
    primary.ctx.hasUI = true;
    primary.customInputQueue.push("escape");
    agents(primary.pi);

    await primary.commands.get("ps")!.handler(row.id, primary.ctx as ExtensionCommandContext);
    expect(primary.customOptions).toEqual([{ overlay: false }]);

    const compatibility = createHarness();
    compatibility.ctx.hasUI = true;
    compatibility.customInputQueue.push("escape");
    agents(compatibility.pi);
    await compatibility.commands.get("agent")!.handler(`ps ${row.id}`, compatibility.ctx as ExtensionCommandContext);
    expect(compatibility.customRenderFrames[0]?.[0]).toContain(row.displayName);
  });

  it.each([
    ["/ps", (h: ReturnType<typeof createHarness>, id: string) => h.commands.get("ps")!.handler(id, h.ctx)],
    [
      "/agent ps",
      (h: ReturnType<typeof createHarness>, id: string) => h.commands.get("agent")!.handler(`ps ${id}`, h.ctx),
    ],
    [
      "/agent drill",
      (h: ReturnType<typeof createHarness>, id: string) => h.commands.get("agent")!.handler(`drill ${id}`, h.ctx),
    ],
  ])("drops delayed %s viewer capability after session replacement reuses the row id", async (_name, invoke) => {
    type CapabilityResult = Awaited<ReturnType<typeof sessionViewer.loadAgentViewerCapability>>;
    let resolveCapability!: (result: CapabilityResult) => void;
    const capability = new Promise<CapabilityResult>((resolve) => {
      resolveCapability = resolve;
    });
    const capabilitySpy = vi
      .spyOn(sessionViewer, "loadAgentViewerCapability")
      .mockImplementation(async () => capability);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    registerRow("reused-direct-row", "working");
    const beforeListeners = agentLiveStore.emitter.listenerCount("change");
    const notificationsBefore = [...h.notifications];
    try {
      const opening = invoke(h, "reused-direct-row");
      await vi.waitFor(() => expect(capabilitySpy).toHaveBeenCalledOnce());
      await emit(h, "session_start");
      registerRow("reused-direct-row", "working");
      resolveCapability({ ok: true, capability: {} as never });
      await opening;

      expect(h.customComponents).toHaveLength(0);
      expect(h.customOptions).toHaveLength(0);
      expect(agentLiveStore.emitter.listenerCount("change")).toBe(beforeListeners);
      expect(h.notifications).toEqual(notificationsBefore);
    } finally {
      capabilitySpy.mockRestore();
    }
  });

  it("drops delayed focused Enter after reload without creating an old viewer or disturbing the replacement", async () => {
    type CapabilityResult = Awaited<ReturnType<typeof sessionViewer.loadAgentViewerCapability>>;
    let resolveCapability!: (result: CapabilityResult) => void;
    const capability = new Promise<CapabilityResult>((resolve) => {
      resolveCapability = resolve;
    });
    const capabilitySpy = vi
      .spyOn(sessionViewer, "loadAgentViewerCapability")
      .mockImplementation(async () => capability);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    registerRow("reused-focused-row", "working");
    const beforeListeners = agentLiveStore.emitter.listenerCount("change");
    const notificationsBefore = [...h.notifications];
    h.customInputQueue.push("enter");
    try {
      const opening = h.commands.get("ps")!.handler("", h.ctx);
      await vi.waitFor(() => expect(capabilitySpy).toHaveBeenCalledOnce());
      await emit(h, "session_start");
      registerRow("reused-focused-row", "working");
      resolveCapability({ ok: true, capability: {} as never });
      await opening;

      expect(h.customComponents).toHaveLength(1);
      expect(h.customOptions).toEqual([{ overlay: false }]);
      expect(agentLiveStore.emitter.listenerCount("change")).toBe(beforeListeners);
      expect(h.notifications).toEqual(notificationsBefore);
      expect(agentLiveStore.rows.has("reused-focused-row")).toBe(true);
    } finally {
      capabilitySpy.mockRestore();
    }
  });

  it("does not claim fallback delivery when the host has no UI", async () => {
    registerRow("row-1", "working");
    const h = createHarness();
    h.ctx.hasUI = false;
    agents(h.pi);

    await h.commands.get("agent")!.handler("drill row-1", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("agents") ?? "").toBe("");
  });

  it("falls back to the agents widget when custom UI is unavailable", async () => {
    registerRow("row-1", "working");
    const h = createHarness();
    h.ctx.hasUI = true;
    delete h.ctx.ui.custom;
    agents(h.pi);

    await h.commands.get("agent")!.handler("drill row-1", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("agents")).toContain("[WARN]");
    expect(h.widgets.get("agents")).toContain("This Pi TUI host does not expose custom UI.");
  });

  it("rejects a duplicate agent name as ambiguous instead of choosing by status", async () => {
    registerRow("done-row", "done");
    registerRow("queued-row", "queued");
    registerRow("working-row", "working");
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("agent")!.handler("drill reviewer", h.ctx as ExtensionCommandContext);

    expect(h.customOptions).toEqual([]);
    expect(h.widgets.get("agents")).toContain("Agent drill target is ambiguous: reviewer");
    expect(h.widgets.get("agents")).toContain("done-row");
    expect(h.widgets.get("agents")).toContain("queued-row");
    expect(h.widgets.get("agents")).toContain("working-row");
  });

  it("resolves a completed row by short id, child-session fragment, and label, with identity in the header (T-188 W5/W3)", async () => {
    agentLiveStore.begin({
      id: "run:reviewer:1",
      agentName: "reviewer",
      label: "review the diff",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch("run:reviewer:1", { status: "done", childSessionId: "550e8400-e29b-41d4-a716-446655440000" });

    // The 6-char short id shown in the row actor (`reviewer#440000`) is drillable.
    const byShortId = createHarness();
    byShortId.ctx.hasUI = true;
    byShortId.customInputQueue.push("escape");
    agents(byShortId.pi);
    await byShortId.commands.get("agent")!.handler("drill 440000", byShortId.ctx as ExtensionCommandContext);
    const shortFrame = byShortId.customRenderFrames[0] ?? [];
    expect(shortFrame[0]).toContain(
      `[agent ${agentLiveStore.rows.get("run:reviewer:1")?.displayName}] started work · review the diff`,
    );
    expect(shortFrame.join("\n")).toContain("Agent completed without assistant output.");

    // A child-session id fragment resolves the same completed row.
    const byChild = createHarness();
    byChild.ctx.hasUI = true;
    byChild.customInputQueue.push("escape");
    agents(byChild.pi);
    await byChild.commands.get("agent")!.handler("drill 550e8400", byChild.ctx as ExtensionCommandContext);
    expect(byChild.customRenderFrames[0]?.[0]).toContain("review the diff");

    // A label fragment resolves it too.
    const byLabel = createHarness();
    byLabel.ctx.hasUI = true;
    byLabel.customInputQueue.push("escape");
    agents(byLabel.pi);
    await byLabel.commands.get("agent")!.handler("drill diff", byLabel.ctx as ExtensionCommandContext);
    expect(byLabel.customRenderFrames[0]?.[0]).toContain("review the diff");

    // Case-normalized petname is exact and still resolves one row.
    const byPetname = createHarness();
    byPetname.ctx.hasUI = true;
    byPetname.customInputQueue.push("escape");
    agents(byPetname.pi);
    const petname = agentLiveStore.rows.get("run:reviewer:1")!.displayName!;
    await byPetname.commands
      .get("agent")!
      .handler(`drill ${petname.toLocaleLowerCase()}`, byPetname.ctx as ExtensionCommandContext);
    expect(byPetname.customRenderFrames[0]?.[0]).toContain("review the diff");
  });

  it("reports ambiguous label and uuid fragments with candidates, while exact row id wins", async () => {
    const first = agentLiveStore.begin({ id: "row-collision-a", agentName: "reviewer", label: "review shared target" });
    const second = agentLiveStore.begin({
      id: "row-collision-b",
      agentName: "reviewer",
      label: "review shared target",
    });
    agentLiveStore.patch(first.id, { status: "done", childSessionId: "550e8400-aaaa-1111" });
    agentLiveStore.patch(second.id, { status: "working", childSessionId: "550e8400-bbbb-2222" });
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("agent")!.handler("drill shared", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("agents")).toContain("Agent drill target is ambiguous: shared");
    expect(h.widgets.get("agents")).toContain(first.id);
    expect(h.widgets.get("agents")).toContain(second.id);

    await h.commands.get("agent")!.handler("drill 550e8400", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("agents")).toContain("Agent drill target is ambiguous: 550e8400");

    h.customInputQueue.push("escape");
    await h.commands.get("agent")!.handler(`drill ${first.id}`, h.ctx as ExtensionCommandContext);
    expect(h.customRenderFrames.at(-1)?.[0]).toContain(first.displayName);
  });

  it("reports missing targets, unknown targets, and unknown flags without opening custom UI", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("agent")!.handler("drill", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("agents")).toContain("[WARN]");
    expect(h.widgets.get("agents")).toContain("A row id, agent, or last target is required.");
    expect(h.widgets.get("agents")).toContain("/agent drill <row-id|agent|last>");

    await h.commands.get("agent")!.handler("drill missing", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("agents")).toContain("[ERROR]");
    expect(h.widgets.get("agents")).toContain("Agent drill target not found: missing");

    await h.commands.get("agent")!.handler("drill --force", h.ctx as ExtensionCommandContext);
    expect(h.widgets.get("agents")).toContain("Unknown /agent drill flag: --force");
    expect(h.customOptions).toEqual([]);
  });

  it("(ScrollableTextOverlay) renders a static supplier body, scrolls, and closes without truncating", async () => {
    const lines = Array.from({ length: 40 }, (_unused, index) => `line ${index}`);
    const done = vi.fn();
    const requestRender = vi.fn();
    const overlay = new ScrollableTextOverlay("Agent catalog", () => lines, { requestRender }, done);

    const first = overlay.render(80);
    expect(first[0]).toMatch(/^╭─+╮$/);
    expect(first[1]).toContain("Agent catalog");
    expect(first.at(-2)).toContain("1-18/40");
    expect(first.join("\n")).toContain("line 0");
    expect(first.join("\n")).not.toContain("not shown");

    await overlay.handleInput("end");
    expect(requestRender).toHaveBeenCalled();
    const last = overlay.render(80);
    expect(last.join("\n")).toContain("line 39");
    expect(last.at(-2)).toContain("/40");

    expect(overlay.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);

    await overlay.handleInput("q");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("frames title, body, and footer without exceeding normal or narrow widths", () => {
    const overlay = new ScrollableTextOverlay(
      "Agent 🧪 catalog",
      () => ["wide body 世界", "second"],
      { requestRender: vi.fn() },
      () => {},
    );

    for (const width of [1, 2, 3, 4, 5, 8, 40]) {
      const frame = overlay.render(width);
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(frame[0]).toContain("╭");
      expect(frame.at(-1)).toContain("╰");
    }
    expect(overlay.render(40).join("\n")).toContain("Agent 🧪 catalog");
    expect(overlay.render(40).join("\n")).toContain("q/esc close · ↑/k ↓/j scroll");
    // Content sits inside a one-cell gutter, matching every other framed surface.
    expect(overlay.render(40)[1]).toMatch(/^│ \S/u);
  });

  it("(ScrollableTextOverlay) hands the live content width to a width-aware supplier", () => {
    const widths: number[] = [];
    const overlay = new ScrollableTextOverlay(
      "Agent catalog",
      (width) => {
        widths.push(width);
        return [`rendered at ${width}`];
      },
      { requestRender: vi.fn() },
      () => {},
    );

    expect(overlay.render(120).join("\n")).toContain("rendered at 116");
    expect(widths).toContain(116);
  });

  it("(ScrollableTextOverlay) leaves the frame to a supplier that draws its own", () => {
    const supplied = ["╭── block ──╮", "│ body     │", "╰──────────╯"];
    const overlay = new ScrollableTextOverlay(
      "Agent catalog",
      (width) => {
        expect(width).toBe(40);
        return supplied;
      },
      { requestRender: vi.fn() },
      () => {},
      { ownsFrame: false },
    );

    const rendered = overlay.render(40);
    expect(rendered.slice(0, 3).map((line) => line.trimEnd())).toEqual(supplied);
    expect(rendered.at(-1)).toContain("q/esc close");
    expect(rendered.every((line) => visibleWidth(line) === 40)).toBe(true);
  });
});

describe("/ps never fails silently", () => {
  it("says so when there is nothing to show", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("ps")!.handler("", h.ctx as ExtensionCommandContext);

    expect(h.customComponents).toHaveLength(0);
    expect(h.notifications).toContain("/ps found no live agent rows.");
  });

  it("falls back to the bounded catalog and says why when the scroll surface loses the screen", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    // Pi shows one inline surface at a time: this models the newer prompt that
    // takes the screen while /agent list is opening.
    h.ctx.ui.custom = async () => {
      throw new SupersededInlineOperatorInteractionError();
    };
    agents(h.pi);

    await h.commands.get("agent")!.handler("list", h.ctx as ExtensionCommandContext);

    // Neither surface may end blank: the operator gets the catalog either way.
    expect(h.widgets.get("agents") ?? "").toContain("Agent catalog");
    expect(h.notifications.some((message) => message.startsWith("Agent catalog closed:"))).toBe(true);
  });
});

describe("re-run agent identity", () => {
  it("resolves a plain agent name to its newest workflow run, not a retained earlier one", async () => {
    const older = agentLiveStore.begin({
      id: "workflow-agent:20260726-183012-a6aa:default",
      agentName: "default",
      label: "decide clarification",
      workflowRunId: "20260726-183012-a6aa",
    });
    agentLiveStore.patch(older.id, { status: "done" });
    const newer = agentLiveStore.begin({
      id: "workflow-agent:20260726-183412-b2c4:default",
      agentName: "default",
      label: "decide clarification",
      workflowRunId: "20260726-183412-b2c4",
    });
    agentLiveStore.patch(newer.id, { status: "working" });

    const h = createHarness();
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    agents(h.pi);
    await h.commands.get("ps")!.handler("default", h.ctx as ExtensionCommandContext);

    const frame = h.customRenderFrames[0]?.join("\n") ?? "";
    expect(frame).toContain(newer.displayName!);
    expect(frame).not.toContain(older.displayName!);
    expect(h.widgets.get("agents") ?? "").not.toContain("ambiguous");
  });
});
