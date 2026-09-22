import { afterEach, describe, expect, it } from "vitest";
import { PetnameRegistry, SCIENTIST_NAMES, petname } from "../../../extensions/_shared/agent-runtime/agent-names.js";
import {
  AgentLivePanel,
  formatAgentFinishedEventLine,
  formatAgentLiveRowLine,
  formatAgentStartedEventLine,
  formatDurationCoarse,
  formatModelBadge,
  formatTokenCount,
  statusMeta,
} from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { agentLiveStore, type AgentLiveRow } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

// T-191 (agent-fleet-visibility slice 1): the new fleet row grammar, petnames,
// title, model badge, token counter, and transcript event lines. Each `it` maps
// to an acceptance example in the spec's Requirements table (REQ-001..006/011).

function makeRow(over: Partial<AgentLiveRow> = {}): AgentLiveRow {
  return {
    id: "run:reviewer:1",
    label: "Review this",
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

afterEach(() => {
  agentLiveStore.reset();
});

describe("petnames (REQ-002)", () => {
  it("has a non-trivial dictionary of unique, row-width-safe surnames", () => {
    expect(SCIENTIST_NAMES.length).toBeGreaterThanOrEqual(200);
    expect(new Set(SCIENTIST_NAMES).size).toBe(SCIENTIST_NAMES.length);
    expect(SCIENTIST_NAMES.every((name) => name.length <= 12)).toBe(true);
  });

  it("is deterministic: the same uuid always maps to the same name", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(petname(uuid)).toBe(petname(uuid));
    expect(SCIENTIST_NAMES).toContain(petname(uuid));
  });

  it("gives different uuids different names", () => {
    expect(petname("abc")).not.toBe(petname("def"));
  });

  it("suffixes a session collision with -2 (unique within a session)", () => {
    // Find a second id that hashes to the same base surname as `seed`, then prove
    // the registry disambiguates it deterministically (dictionary-order-independent).
    const seed = "seed-collision-a";
    const base = petname(seed);
    let colliding: string | undefined;
    for (let i = 0; i < 20_000 && colliding === undefined; i += 1) {
      const candidate = `probe-${i}`;
      if (candidate !== seed && petname(candidate) === base) colliding = candidate;
    }
    expect(colliding).toBeDefined();

    const registry = new PetnameRegistry();
    expect(registry.assign(seed)).toBe(base);
    expect(registry.assign(colliding!)).toBe(`${base}-2`);
    // Idempotent per id.
    expect(registry.assign(seed)).toBe(base);
  });

  it("releases a retired id so collision suffix state stays bounded", () => {
    const seed = "seed-release-a";
    const base = petname(seed);
    const collisions: string[] = [];
    for (let i = 0; i < 50_000 && collisions.length < 2; i += 1) {
      const candidate = `release-probe-${i}`;
      if (petname(candidate) === base) collisions.push(candidate);
    }
    expect(collisions).toHaveLength(2);

    const registry = new PetnameRegistry();
    expect(registry.assign(seed)).toBe(base);
    expect(registry.assign(collisions[0]!)).toBe(`${base}-2`);
    expect(registry.release(collisions[0]!)).toBe(true);
    expect(registry.release(collisions[0]!)).toBe(false);
    expect(registry.assign(collisions[1]!)).toBe(`${base}-2`);
  });

  it("assigns a stable petname to a live row and skips group summary rows", () => {
    const row = agentLiveStore.begin({
      id: "run:reviewer:1",
      agentName: "reviewer",
      label: "Review",
      isolated: false,
      noMcp: false,
    });
    expect(row.displayName).toBe(petname("run:reviewer:1"));
    // Re-begin keeps the same name.
    expect(
      agentLiveStore.begin({
        id: "run:reviewer:1",
        agentName: "reviewer",
        label: "Review",
        isolated: false,
        noMcp: false,
      }).displayName,
    ).toBe(row.displayName);

    const group = agentLiveStore.begin({
      id: "grp:1",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      isolated: false,
      noMcp: false,
    });
    expect(group.displayName).toBeUndefined();
  });
});

describe("model badge (REQ-005)", () => {
  it("strips the provider prefix and renders effort as a bare word", () => {
    expect(formatModelBadge({ model: "anthropic/claude-fable-5", thinking: "medium" })).toBe("claude-fable-5 medium");
    expect(formatModelBadge({ model: "test/strong", thinking: "high" })).toBe("strong high");
  });

  it("renders model or effort alone, and empty when neither is set", () => {
    expect(formatModelBadge({ model: "anthropic/claude-fable-5" })).toBe("claude-fable-5");
    expect(formatModelBadge({ thinking: "low" })).toBe("low");
    expect(formatModelBadge({})).toBe("");
  });
});

describe("token counter (REQ-006)", () => {
  it("humanizes token totals (999 / 12.4k / 1.3M)", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(12_400)).toBe("12.4k");
    expect(formatTokenCount(1_260_000)).toBe("1.3M");
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1000)).toBe("1k");
  });

  it("wires cumulative usage into tokenCount and shows separate input/output counters", () => {
    agentLiveStore.begin({
      id: "run:reviewer:1",
      agentName: "reviewer",
      label: "Review",
      isolated: false,
      noMcp: false,
    });
    // getSessionStats().tokens is cumulative; total includes cache and must NOT be used.
    const updated = agentLiveStore.applySessionStats("run:reviewer:1", {
      sessionId: "sdk-child",
      toolCalls: 1,
      toolResults: 1,
      tokens: { input: 9100, output: 3300, total: 20000, cacheRead: 7600 },
    });
    expect(updated?.tokenCount).toEqual({ input: 9100, output: 3300 });
    expect(formatAgentLiveRowLine(updated!)).toContain("↑9.1k ↓3.3k");
  });

  it("omits the token field entirely when there is no usage (never 0)", () => {
    const row = agentLiveStore.begin({
      id: "run:reviewer:1",
      agentName: "reviewer",
      label: "Review",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.applySessionStats("run:reviewer:1", { sessionId: "sdk-child", toolCalls: 0, toolResults: 0 });
    const refreshed = agentLiveStore.rows.get(row.id)!;
    expect(refreshed.tokenCount).toBeUndefined();
    expect(formatAgentLiveRowLine(refreshed)).not.toContain("↓");
  });
});

describe("fleet row grammar (REQ-001)", () => {
  const row = makeRow({
    displayName: "Anscombe",
    agentName: "reviewer",
    title: "review auth middleware",
    status: "working",
    model: "anthropic/claude-fable-5",
    thinking: "medium",
    elapsedMs: 12_000,
    tokenCount: { input: 1200, output: 600 },
    currentTools: ["bash"],
    currentToolArgs: '{"command":"npm test -- sums.spec"}',
    stepCount: 3,
    turnCount: 2,
    childSessionId: "550e8400-e29b-41d4-a716-446655440000",
  });
  const line = formatAgentLiveRowLine(row, statusMeta("working", 0));

  it("matches the <icon> <name>  <title>  ·  <model> <effort>  ·  <elapsed>  ·  ↑<in> ↓<out> grammar", () => {
    expect(line).toMatch(
      /^⠿ Anscombe\s+review auth middleware\s+·\s+claude-fable-5 medium\s+·\s+12s\s+·\s+↑1\.2k ↓600$/,
    );
  });

  it("drops [Working], on task, activity=, args={, /effort=, steps=, and the #hash tail", () => {
    expect(line).not.toContain("[Working]");
    expect(line).not.toContain("on task");
    expect(line).not.toContain("activity=");
    expect(line).not.toContain("args={");
    expect(line).not.toContain("/effort=");
    expect(line).not.toContain("steps=");
    expect(line).not.toContain("childSession=");
    expect(line).not.toMatch(/#[a-f0-9]{6}/);
  });

  it("falls back to the label as the title and unwraps an `agentName (label)` form", () => {
    const workflowRow = makeRow({
      displayName: "Bessel",
      agentName: "reviewer",
      label: "reviewer (review-step)",
      model: "test/fast",
      thinking: "low",
      elapsedMs: 3000,
    });
    const workflowLine = formatAgentLiveRowLine(workflowRow, statusMeta("working", 0));
    expect(workflowLine).toContain("review-step");
    expect(workflowLine).not.toContain("reviewer (review-step)");
    expect(workflowLine).not.toContain("on task");
  });

  it("shows latest substantive assistant text without promoting tool args or stdout", () => {
    const live = agentLiveStore.begin({
      id: "latest-row",
      agentName: "reviewer",
      label: "review source",
      title: "initial assignment",
    });
    agentLiveStore.feedSessionEvent(live.id, {
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "secret command" },
    });
    agentLiveStore.feedSessionEvent(live.id, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Found the root cause" }] },
    });
    const line = new AgentLivePanel().renderRows([agentLiveStore.rows.get(live.id)!], 120).join("\n");

    expect(line).toContain("Found the root cause");
    expect(line.split("\n").slice(0, 2).join("\n")).not.toContain("secret command");
  });

  it("truncates the title first on a narrow width, keeping the right-hand meta intact", () => {
    // Width chosen to fit icon+name+meta but not the full title, so the title is
    // the sacrifice while model/elapsed/tokens on the right survive (REQ-001).
    const narrow = formatAgentLiveRowLine(row, statusMeta("working", 0), 64);
    expect(narrow.length).toBeLessThanOrEqual(64);
    expect(narrow).toContain("↑1.2k ↓600");
    expect(narrow).toContain("12s");
    expect(narrow).toContain("claude-fable-5 medium");
    expect(narrow).toContain("rev");
    expect(narrow).not.toContain("review auth middleware");
  });
});

describe("calm rendering (render-profile)", () => {
  it("coarsens only the LIVE elapsed reading; a recorded duration stays exact", () => {
    const live = makeRow({
      displayName: "Curie",
      status: "working",
      startedAt: Date.now() - 25_400,
    });
    expect(formatAgentLiveRowLine(live, statusMeta("working", 0), Number.POSITIVE_INFINITY, { calm: true })).toContain(
      "20s",
    );
    const recorded = makeRow({ displayName: "Curie", status: "done", elapsedMs: 25_400 });
    expect(formatAgentLiveRowLine(recorded, statusMeta("done", 0), Number.POSITIVE_INFINITY, { calm: true })).toContain(
      "25s",
    );
  });

  it("holds the coarse text still inside a bucket so idle frames stay byte-identical", () => {
    const base = Date.now();
    const early = makeRow({ displayName: "Bohr", status: "working", startedAt: base - 21_000 });
    const later = makeRow({ displayName: "Bohr", status: "working", startedAt: base - 28_000 });
    const renderCalm = (row: AgentLiveRow) =>
      formatAgentLiveRowLine(row, statusMeta("working", 0), Number.POSITIVE_INFINITY, { calm: true });
    expect(renderCalm(early)).toBe(renderCalm(later)); // 21s and 28s share the 20s bucket
  });

  it("formatDurationCoarse buckets: <10s, tens of seconds, whole minutes, hours", () => {
    expect(formatDurationCoarse(undefined)).toBe("");
    expect(formatDurationCoarse(0)).toBe("<10s");
    expect(formatDurationCoarse(9_999)).toBe("<10s");
    expect(formatDurationCoarse(10_000)).toBe("10s");
    expect(formatDurationCoarse(59_999)).toBe("50s");
    expect(formatDurationCoarse(60_000)).toBe("1m");
    expect(formatDurationCoarse(119_999)).toBe("1m");
    expect(formatDurationCoarse(61 * 60_000)).toBe("1h1m");
    expect(formatDurationCoarse(120 * 60_000)).toBe("2h");
  });
});

describe("transcript event lines (REQ-011)", () => {
  it("formats the started line: ● agent <Name> started — <title> (<model> <effort>)", () => {
    const row = makeRow({
      displayName: "Anscombe",
      title: "sum batch 1",
      model: "anthropic/claude-fable-5",
      thinking: "medium",
    });
    expect(formatAgentStartedEventLine(row)).toBe("● agent Anscombe started — sum batch 1 (claude-fable-5 medium)");
  });

  it("formats the finished line with separate input/output tokens", () => {
    const row = makeRow({
      displayName: "Anscombe",
      status: "done",
      elapsedMs: 72_000,
      tokenCount: { input: 2600, output: 1600 },
      finalAnswer: "1225\ntrailing detail",
    });
    expect(formatAgentFinishedEventLine(row)).toBe("✓ agent Anscombe finished · 1m12s · ↑2.6k ↓1.6k — 1225");
  });

  it("uses the ✗ error variant with the error message as the tail", () => {
    const row = makeRow({
      displayName: "Bessel",
      status: "error",
      elapsedMs: 5000,
      errors: ["boom: it failed", "second"],
      finalAnswer: "n/a",
    });
    expect(formatAgentFinishedEventLine(row)).toBe("✗ agent Bessel failed · 5s — boom: it failed");
  });

  it("uses a distinct cancelled marker and never a success check", () => {
    const row = makeRow({
      displayName: "Comte",
      status: "cancelled",
      elapsedMs: 60_000,
      finalAnswer: "Agent run was cancelled.",
    });
    expect(formatAgentFinishedEventLine(row)).toBe("⊘ agent Comte cancelled · 1m — Agent run was cancelled.");
    expect(formatAgentFinishedEventLine(row)).not.toContain("✓");
  });
});
