import { afterEach, describe, expect, it } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import workflows from "../../../../extensions/workflows/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { ExtensionCommandContext } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness, emit } from "../../../test-harness.js";

afterEach(() => {
  agentLiveStore.reset();
});

describe("agent observer command", () => {
  it("shows an honest empty observer state", async () => {
    const h = createHarness();
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("agents")).toBe("Agent observer: no live rows");
    expect(h.notifications).toEqual([]);
    expect(h.statuses.has("agents")).toBe(false);
    expect(h.widgetOptions.get("agents")).toEqual({ placement: "belowEditor" });
  });

  it("summarizes a running row with counts, active tools, and recent events", async () => {
    const h = createHarness();
    agentLiveStore.begin({
      id: "row-working",
      agentName: "reviewer",
      label: "Working row",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch("row-working", {
      status: "working",
      startedAt: 1000,
      elapsedMs: 42,
      currentTools: ["read", "yield"],
      stepCount: 3,
      eventLines: ["event type=tool_call tool=read", "event type=tool_result tool=read", "event type=turn_end"],
    });
    agentLiveStore.begin({
      id: "row-queued",
      agentName: "reviewer",
      label: "Queued row",
      isolated: false,
      noMcp: false,
    });
    agents(h.pi);

    await h.commands.get("agent")!.handler("summary", h.ctx as ExtensionCommandContext);

    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toContain("Agent observer: 2 rows total");
    expect(h.notifications).toEqual([]);
    expect(widget).toContain("queued=1 waiting");
    expect(widget).toContain("working=1 running");
    expect(widget).toContain("showing 2 current/recent rows");
    expect(widget).toContain('label="Working row"');
    // T-188 W3: actor carries the `agentName#<shortId>` identity.
    expect(widget).toContain("agent=reviewer#");
    expect(widget).toContain("status=working (running)");
    expect(widget).toContain("tools=read,yield");
    // T-188 W7: sub-second elapsed is hidden as `<1s` (was `42ms`).
    expect(widget).toContain("elapsed=<1s");
    expect(widget).toContain("steps=3(events)");
    expect(widget).toContain("events: event type=tool_call tool=read | event type=tool_result tool=read");
    expect(widget.split(/\r?\n/)).toHaveLength(8);
    expect(widget.split(/\r?\n/).every((line) => line.length <= 80)).toBe(true);
  });

  it("keeps done and error rows terminal instead of stale-running", async () => {
    const h = createHarness();
    agentLiveStore.begin({
      id: "row-done",
      agentName: "reviewer",
      label: "Done row",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch("row-done", {
      status: "done",
      startedAt: 2000,
      elapsedMs: 99,
      currentTools: ["read"],
      stepCount: 8,
      eventLines: ["event type=agent_end", "event type=agent_end"],
    });
    agentLiveStore.begin({
      id: "row-error",
      label: "Error row",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch("row-error", {
      status: "error",
      startedAt: 3000,
      elapsedMs: 77,
      currentTools: ["write"],
      stepCount: 5,
      eventLines: ["event type=error reason=boom"],
    });
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);

    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toContain("status=done (terminal, not running)");
    expect(widget).toContain("status=error (terminal, not running)");
    expect(widget).not.toContain("status=done (running)");
    expect(widget).not.toContain("status=error (running)");
    expect(widget).not.toContain("tools=read");
    expect(widget).not.toContain("tools=write");
  });

  it("collapses duplicate event lines deterministically and keeps the digest bounded", async () => {
    const h = createHarness();
    agentLiveStore.begin({
      id: "row-noise",
      agentName: "reviewer",
      label: "Noise row",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch("row-noise", {
      status: "working",
      startedAt: 4000,
      elapsedMs: 9,
      currentTools: ["read"],
      stepCount: 1,
      eventLines: [
        "event type=before_invalidate",
        "event type=tool_call tool=read",
        "event type=tool_call tool=read",
        "event type=tool_result tool=read",
        "event type=tool_result tool=read",
        "event type=turn_end",
      ],
    });
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);

    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toContain("events: event type=tool_call tool=read x2 | event type=tool_result");
    expect(widget).not.toContain("before_invalidate");
    expect(widget).toContain("elapsed=<1s");
    expect(widget.split(/\r?\n/).every((line) => line.length <= 80)).toBe(true);
  });

  it("clears transient agent widgets and status on the next unrelated input", async () => {
    const h = createHarness();
    agents(h.pi);

    for (const command of ["list", "inspect reviewer", "observe", "summary"]) {
      await h.commands.get("agent")!.handler(command, h.ctx as ExtensionCommandContext);
      expect(h.widgets.get("agents")).not.toBe("");
      h.ctx.ui.setStatus("agents", "stale agent status");

      await emit(h, "input", { text: "/model-roles" });

      expect(h.widgetPayloads.get("agents")).toBeUndefined();
      expect(h.widgets.get("agents")).toBe("");
      expect(h.statuses.has("agents")).toBe(false);
    }
  });

  it("lets another command clear stale agent widgets when slash input cleanup is skipped", async () => {
    const h = createHarness();
    delete h.ctx.ui.custom;
    agents(h.pi);
    workflows(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    h.ctx.ui.setStatus("agents", "stale agent status");

    await h.commands.get("workflows")!.handler("status", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("workflows")).toContain("[VIEW] Workflow runs");
    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(h.widgets.get("agents")).toBe("");
    expect(h.statuses.has("agents")).toBe(false);
  });

  it("keeps a transient agent widget for related /agent input so the command can replace it", async () => {
    const h = createHarness();
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);
    await emit(h, "input", { text: "/agent list" });

    expect(h.widgets.get("agents")).toBe("Agent observer: no live rows");
    expect(h.widgetPayloads.get("agents")).not.toBeUndefined();
  });
});
