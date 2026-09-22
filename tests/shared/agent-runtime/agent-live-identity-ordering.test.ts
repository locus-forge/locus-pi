import { describe, expect, it } from "vitest";
import {
  agentLiveShortId,
  formatAgentIdentity,
  formatDuration,
  orderAgentLiveRows,
} from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import type { AgentLiveRow } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

function makeRow(id: string, over: Partial<AgentLiveRow> = {}): AgentLiveRow {
  const base: AgentLiveRow = {
    id,
    label: id,
    status: "queued",
    currentTools: [],
    stepCount: 0,
    isolated: false,
    noMcp: false,
    errors: [],
    eventLines: [],
  };
  return { ...base, ...over };
}

describe("agent identity (T-188 W3)", () => {
  it("prefers the child-session id and shows the last 6 alphanumerics", () => {
    const row = makeRow("run:reviewer:1", {
      agentName: "reviewer",
      childSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(agentLiveShortId(row)).toBe("440000");
    expect(formatAgentIdentity(row)).toBe("reviewer#440000");
  });

  it("falls back to the row id when no child session exists yet", () => {
    const row = makeRow("workflow-run-abc123", { agentName: "explore" });
    expect(agentLiveShortId(row)).toBe("abc123");
    expect(formatAgentIdentity(row)).toBe("explore#abc123");
  });

  it("keeps a short id intact and defaults the actor name", () => {
    expect(agentLiveShortId(makeRow("xy"))).toBe("xy");
    expect(formatAgentIdentity(makeRow("xy"))).toBe("agent#xy");
  });
});

describe("row ordering invariant (T-188 W4)", () => {
  it("preserves insertion order and never sorts by status (done stays in place)", () => {
    const rows = [
      makeRow("a", { status: "done" }),
      makeRow("b", { status: "working" }),
      makeRow("c", { status: "queued" }),
    ];
    expect(orderAgentLiveRows(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a row in place when it transitions to done", () => {
    const before = [
      makeRow("a", { status: "working" }),
      makeRow("b", { status: "working" }),
      makeRow("c", { status: "working" }),
    ];
    const beforeOrder = orderAgentLiveRows(before).map((r) => r.id);
    const after = [before[0]!, makeRow("b", { status: "done" }), before[2]!];
    expect(orderAgentLiveRows(after).map((r) => r.id)).toEqual(beforeOrder);
  });

  it("nests children under their parent while roots keep insertion order", () => {
    const rows = [makeRow("p"), makeRow("u"), makeRow("c", { parentRowId: "p" })];
    expect(orderAgentLiveRows(rows).map((r) => r.id)).toEqual(["p", "c", "u"]);
  });
});

describe("duration tiers (T-188 W7)", () => {
  it("hides sub-second as <1s and renders s → m → h tiers", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(90000)).toBe("1m30s");
    expect(formatDuration(125000)).toBe("2m5s");
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(3660000)).toBe("1h1m");
  });
});
