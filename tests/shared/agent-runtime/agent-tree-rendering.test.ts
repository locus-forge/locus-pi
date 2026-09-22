import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentLiveTranscript } from "../../../extensions/_shared/agent-runtime/agent-live-transcript.js";
import { AgentLivePanel, orderAgentLiveRows } from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { renderFleetMenuRows } from "../../../extensions/_shared/agent-runtime/fleet-menu.js";
import type { AgentLiveRow } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

function liveRow(id: string, label: string, over: Partial<AgentLiveRow> = {}): AgentLiveRow {
  return {
    id,
    label,
    title: label,
    status: "working",
    currentTools: [],
    stepCount: 0,
    isolated: false,
    noMcp: false,
    errors: [],
    eventLines: [],
    ...over,
  };
}

describe("agent live tree rendering", () => {
  it("draws recursive sibling rails through agent, message, tool, and child rows", () => {
    const group = liveRow("group", "parallel (2)", { groupKind: "parallel", groupTotal: 2 });
    const first = liveRow("first", "inspect auth", {
      parentRowId: group.id,
      displayName: "Curie",
      latestMessage: "Found stale middleware",
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm test -- auth.spec"}',
    });
    const grandchild = liveRow("grandchild", "verify fix", {
      parentRowId: first.id,
      displayName: "Hopper",
    });
    const second = liveRow("second", "write report", {
      parentRowId: group.id,
      displayName: "Turing",
      status: "done",
    });
    const standalone = liveRow("standalone", "standalone", {
      displayName: "Noether",
      status: "queued",
    });

    const lines = new AgentLivePanel().renderRows(
      [group, first, grandchild, second, standalone],
      Number.POSITIVE_INFINITY,
    );
    const line = (needle: string): string => lines.find((candidate) => candidate.includes(needle)) ?? "";

    expect(line("parallel (2)").startsWith("├─ ⠿")).toBe(true);
    expect(line("Curie").startsWith("│  ├─ ⠿")).toBe(true);
    expect(line("Found stale middleware").startsWith("│  │  ├─")).toBe(true);
    expect(line("bash · npm test").startsWith("│  │  ├─")).toBe(true);
    expect(line("Hopper").startsWith("│  │  └─ ⠿")).toBe(true);
    expect(line("Turing").startsWith("│  └─ ✓")).toBe(true);
    expect(line("Noether").startsWith("└─ ○")).toBe(true);
  });

  it("follows live text at narrow widths without cutting tree rails or the final report opening", () => {
    const transcript = new AgentLiveTranscript();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: `Report opening ${"界 ".repeat(400)}Read done` }],
    };
    const group = liveRow("stream-group", "group", { groupKind: "parallel" });
    const frame = (complete: boolean, width: number) => {
      const snapshot = transcript.ingest({ type: complete ? "message_end" : "message_update", message });
      const row = liveRow("stream-child", "child", {
        parentRowId: group.id,
        transcript: snapshot,
        latestMessage: snapshot.latestMessage,
      });
      return new AgentLivePanel().renderRows([group, row], width);
    };
    const streaming = frame(false, 32);
    expect(streaming.at(-1)).toMatch(/^   └ ….*Read done$/u);
    expect(streaming.every((line) => visibleWidth(line) <= 32)).toBe(true);
    const completed = frame(true, 32);
    expect(completed.at(-1)).toContain("Report opening");
    for (const width of [0, 1, 5]) {
      expect(frame(false, width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("keeps projected tree geometry when a surface renders one row at a time", () => {
    const group = liveRow("projected-group", "parallel (2)", { groupKind: "parallel", groupTotal: 2 });
    const first = liveRow("projected-first", "first", {
      parentRowId: group.id,
      displayName: "Curie",
    });
    const second = liveRow("projected-second", "second", {
      parentRowId: group.id,
      displayName: "Hopper",
    });
    const projected = orderAgentLiveRows([group, first, second]);
    const projectedFirst = projected.find((row) => row.id === first.id);
    expect(projectedFirst).toBeDefined();

    const rendered = new AgentLivePanel().renderRows([projectedFirst!], Number.POSITIVE_INFINITY);
    expect(rendered[0]?.startsWith("   ├─ ⠿")).toBe(true);
  });

  it("preserves the established singleton row and detail grammar", () => {
    const root = liveRow("singleton", "inspect auth", {
      displayName: "Curie",
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm test -- auth.spec"}',
    });
    const rendered = new AgentLivePanel().renderRows([root], Number.POSITIVE_INFINITY);

    expect(rendered[0]?.startsWith("⠿ Curie")).toBe(true);
    expect(rendered[0]).not.toContain("└─");
    expect(rendered[1]).toBe("   └ bash · npm test");
  });

  it("keeps full-tree rails when the focused /ps viewport hides siblings", () => {
    const group = liveRow("viewport-group", "parallel (4)", { groupKind: "parallel", groupTotal: 4 });
    const children = Array.from({ length: 4 }, (_unused, index) =>
      liveRow(`viewport-child-${index}`, `child ${index}`, {
        parentRowId: group.id,
        displayName: `Agent-${index}`,
      }),
    );

    const rendered = renderFleetMenuRows([group, ...children], 48, {
      focused: true,
      selectedRowId: children[1]!.id,
      maxRows: 2,
    });

    expect(rendered.some((line) => line.includes("parallel (4)"))).toBe(true);
    expect(rendered.some((line) => line.startsWith(">    ├─") && line.includes("Agent-1"))).toBe(true);
    expect(rendered.some((line) => line.includes("↑ 1 earlier"))).toBe(true);
    expect(rendered.some((line) => line.includes("↓ 1 later"))).toBe(true);
  });
});
