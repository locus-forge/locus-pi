import { describe, expect, it } from "vitest";
import {
  AgentLivePanel,
  formatToolActivity,
  toolActivityGist,
} from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import type { AgentLiveRow } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

// T-196 (agent-fleet-visibility slice — REQ-004 tool-activity action sub-line).
// Every case here maps 1:1 to the REQ-004 acceptance column in
// docs/specs/agent-fleet-visibility/README.md: `└ <verb> · <gist>[ · <t-elapsed>]`,
// gist = command-head / basename / host / truncate, timer only past 5s, «thinking»
// (no active tool) → no sub-line, and the output never leaks raw JSON / wrappers.

function toolRow(over: Partial<AgentLiveRow> = {}): AgentLiveRow {
  return {
    id: "row:1",
    label: "task",
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

describe("tool-activity gist heuristic (REQ-004 W1)", () => {
  it("shell command → command-head (binary + non-flag subcommand)", () => {
    expect(toolActivityGist('{"command":"npm test -- sums.spec"}')).toBe("npm test");
    expect(toolActivityGist('{"command":"git commit -m \\"wip\\""}')).toBe("git commit");
  });

  it('python3 -c "…" → python3 (the -c flag is dropped, not a subcommand)', () => {
    expect(toolActivityGist('{"command":"python3 -c \\"print(1)\\""}')).toBe("python3");
  });

  it('strips a /bin/zsh -lc "…" wrapper before taking the command-head', () => {
    expect(toolActivityGist('{"command":"/bin/zsh -lc \\"npm test -- sums.spec\\""}')).toBe("npm test");
    expect(toolActivityGist('{"command":"/bin/sh -c \\"git status\\""}')).toBe("git status");
  });

  it("path / file_path → basename", () => {
    expect(toolActivityGist('{"path":"src/app.ts"}')).toBe("app.ts");
    expect(toolActivityGist('{"file_path":"/repo/pkg/index.tsx"}')).toBe("index.tsx");
  });

  it("url → host", () => {
    expect(toolActivityGist('{"url":"https://api.example.com/v1/models?x=1"}')).toBe("api.example.com");
  });

  it("pattern / query / prompt / task → truncated to ≤24 columns", () => {
    expect(toolActivityGist('{"query":"short"}')).toBe("short");
    expect(toolActivityGist(`{"pattern":"${"a".repeat(50)}"}`).length).toBeLessThanOrEqual(24);
  });

  it("honors the OMP priority-key order (command before path)", () => {
    expect(toolActivityGist('{"path":"a/b.ts","command":"ls -la"}')).toBe("ls");
  });

  it('never echoes raw JSON / arg-soup: unknown key or brace-string → ""', () => {
    expect(toolActivityGist('{"file":"README.md"}')).toBe(""); // `file` is NOT a priority key
    expect(toolActivityGist("{not valid json at all")).toBe("");
    expect(toolActivityGist(undefined)).toBe("");
  });
});

describe("tool-activity action content composer (REQ-004 W3)", () => {
  it("bash · npm test — verb + command-head gist (no arg-soup, no wrapper)", () => {
    const activity = formatToolActivity(
      toolRow({ currentTools: ["bash"], currentToolArgs: '{"command":"npm test -- sums.spec"}' }),
      0,
    );
    expect(activity).toBe("bash · npm test");
    expect(activity).not.toContain("{");
    expect(activity).not.toContain("/bin/zsh -lc");
  });

  it('bash · python3 — python3 -c "print(1)" collapses to the binary', () => {
    expect(
      formatToolActivity(
        toolRow({ currentTools: ["bash"], currentToolArgs: '{"command":"python3 -c \\"print(1)\\""}' }),
        0,
      ),
    ).toBe("bash · python3");
  });

  it("read · app.ts — path basename", () => {
    expect(formatToolActivity(toolRow({ currentTools: ["read"], currentToolArgs: '{"path":"src/app.ts"}' }), 0)).toBe(
      "read · app.ts",
    );
  });

  it("fetch · <host> — url host", () => {
    expect(
      formatToolActivity(
        toolRow({ currentTools: ["fetch"], currentToolArgs: '{"url":"https://api.example.com/v1/x"}' }),
        0,
      ),
    ).toBe("fetch · api.example.com");
  });

  it("adds the · <t-elapsed> timer only past 5s: 3s → none, 8s → · 8s", () => {
    const row = toolRow({
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm test -- sums.spec"}',
      currentToolStartMs: 1000,
    });
    expect(formatToolActivity(row, 1000 + 3000)).toBe("bash · npm test"); // 3s ≤ 5s → no timer
    expect(formatToolActivity(row, 1000 + 8000)).toBe("bash · npm test · 8s"); // 8s > 5s → timer
  });

  it("calm rendering drops the timer even past the 5s threshold", () => {
    const row = toolRow({
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm test -- sums.spec"}',
      currentToolStartMs: 1000,
    });
    // The timer is the only sub-line part whose text changes every second with
    // no state transition behind it — calm frames must hold still without it.
    expect(formatToolActivity(row, 1000 + 8000, { showElapsed: false })).toBe("bash · npm test");
    expect(formatToolActivity(row, 1000 + 8000, { showElapsed: true })).toBe("bash · npm test · 8s");
  });

  it("threshold is strict (> 5s): exactly 5s shows no timer, 5.001s does", () => {
    const row = toolRow({ currentTools: ["bash"], currentToolArgs: '{"command":"npm test"}', currentToolStartMs: 0 });
    expect(formatToolActivity(row, 5000)).toBe("bash · npm test");
    expect(formatToolActivity(row, 5001)).toBe("bash · npm test · 5s");
  });

  it("kind (a): status working with NO active tool → no sub-line", () => {
    expect(formatToolActivity(toolRow({ status: "working", currentTools: [] }), 0)).toBeUndefined();
  });

  it("degrades to verb-only when the gist is not extractable (unknown key)", () => {
    expect(formatToolActivity(toolRow({ currentTools: ["read"], currentToolArgs: '{"file":"README.md"}' }), 0)).toBe(
      "read",
    );
  });
});

describe("tool-activity sub-line rendering (REQ-004 W3 wiring)", () => {
  const panel = new AgentLivePanel({});

  it("renders `   └ <verb> · <gist>` beneath the row while a tool is active", () => {
    // No `currentToolStartMs` → no timer (the >5s timer is covered by the composer
    // tests with an explicit `now`); this keeps the render assertion deterministic.
    const row = toolRow({
      displayName: "Anscombe",
      title: "sum batch",
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm test -- sums.spec"}',
    });
    const lines = panel.renderRows([row], Number.POSITIVE_INFINITY);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Anscombe");
    expect(lines[1]).toBe("   └ bash · npm test");
  });

  it("emits no sub-line for a working row with no active tool", () => {
    const lines = panel.renderRows(
      [toolRow({ displayName: "Bessel", title: "thinking", currentTools: [] })],
      Number.POSITIVE_INFINITY,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("└");
  });

  it("the sub-line never contains `{`, `/bin/zsh -lc`, or `[current task]`", () => {
    const row = toolRow({
      currentTools: ["bash"],
      currentToolArgs: '{"command":"/bin/zsh -lc \\"npm test -- sums.spec\\""}',
    });
    const text = panel.renderRows([row], Number.POSITIVE_INFINITY).join("\n");
    expect(text).not.toContain("{");
    expect(text).not.toContain("/bin/zsh -lc");
    expect(text).not.toContain("[current task]");
    expect(text).toContain("└ bash · npm test");
  });

  it("width-clamps the sub-line so it never overflows a narrow terminal", () => {
    const row = toolRow({
      currentTools: ["bash"],
      currentToolArgs: '{"command":"npm run some-really-long-script-name"}',
    });
    for (const rendered of panel.renderRows([row], 18)) expect(rendered.length).toBeLessThanOrEqual(18);
  });

  // The store keeps the agent's message verbatim; collapsed onto one preview line
  // its markdown is punctuation marking nothing, so the RENDERER strips it.
  it("strips heading, bold, and backtick markers from the latest-message preview", () => {
    const row = toolRow({
      latestMessage: "# Step Usability Review ## Checks performed 1. **Full run** of `npm test` and __init__ paths",
    });
    const lines = panel.renderRows([row], Number.POSITIVE_INFINITY);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("   └ Step Usability Review Checks performed 1. Full run of npm test and init paths");
  });

  it("drops the dangling bold marker left by a message the store had to bound", () => {
    const row = toolRow({ latestMessage: "Reviewed the plan. **Next…" });
    expect(panel.renderRows([row], Number.POSITIVE_INFINITY)[1]).toBe("   └ Reviewed the plan. Next…");
  });
});
