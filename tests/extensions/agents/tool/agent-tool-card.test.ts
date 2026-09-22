import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ThemeLike,
  ToolDefinition,
  ToolRenderContext,
  ToolRenderResultOptions,
  ToolResult,
} from "../../../../extensions/_shared/host/pi-api.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import agents from "../../../../extensions/agents/index.js";
import { createHarness } from "../../../test-harness.js";

// Every directly spawned agent (`spawn_agent`) owns its own transcript
// block: a LOCUS rail with the agent's petname and live status, the task title
// it works on, and — when the child returns text — that answer marked with a
// left bar so it reads as the agent's own words.

const theme: ThemeLike = {
  fg(_tone, text) {
    return `[35m${text}[0m`;
  },
  bg(_tone, text) {
    return text;
  },
  bold(text) {
    return `[1m${text}[22m`;
  },
};

function spawnAgentTool(): ToolDefinition {
  const harness = createHarness();
  agents(harness.pi);
  return harness.tools.get("spawn_agent")!;
}

function render(tool: ToolDefinition, result: ToolResult, options: ToolRenderResultOptions, width = 80): string[] {
  const context: ToolRenderContext = {
    args: { task: "do the work" },
    toolCallId: "agent-card-test",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: options.isPartial,
    expanded: options.expanded,
    showImages: true,
    isError: result.isError === true,
  };
  const component = tool.renderResult!(result, options, theme, context);
  const lines = component.render(width);
  component.dispose?.();
  return lines;
}

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\[[0-9;]*m/gu, ""));
}

afterEach(() => {
  agentLiveStore.reset();
});

describe("spawn_agent tool card", () => {
  it("owns the tool shell for the canonical registered name", () => {
    const spawn = spawnAgentTool();
    expect(spawn.renderShell).toBe("self");
    expect(spawn.renderCall!({}, theme, {} as ToolRenderContext).render(80)).toEqual([]);
    expect(spawn.renderResult).toBeDefined();
  });

  it("renders one completed agent block with petname, title, elapsed, and the barred answer", () => {
    const lines = plain(
      render(
        spawnAgentTool(),
        {
          content: [{ type: "text", text: "Report ready.\n- reuse fetch\n- rewrite mail_error" }],
          details: {
            rowId: "task:explore:9",
            agent: "explore",
            displayName: "Wren",
            title: "Evaluate methods for reuse",
            status: "completed",
            elapsedMs: 147_000,
          },
        },
        { expanded: false, isPartial: false },
      ),
    );
    expect(lines[0]).toBe("│ LOCUS · agent Wren · COMPLETED");
    expect(lines[1]).toBe("│ ✓ [agent Wren] completed · Evaluate methods for reuse · 2m27s");
    expect(lines[2]).toBe("│ ▌ Report ready. … (+2 lines)");
    expect(lines).toHaveLength(3);
  });

  it("expands the answer in full while keeping the bar on every line", () => {
    const lines = plain(
      render(
        spawnAgentTool(),
        {
          content: [{ type: "text", text: "Report ready.\n- reuse fetch\n- rewrite mail_error" }],
          details: {
            rowId: "task:explore:10",
            agent: "explore",
            displayName: "Wren",
            title: "Evaluate methods",
            status: "completed",
          },
        },
        { expanded: true, isPartial: false },
      ),
    );
    expect(lines).toContain("│ ▌ Report ready.");
    expect(lines).toContain("│ ▌ - reuse fetch");
    expect(lines).toContain("│ ▌ - rewrite mail_error");
  });

  it("prefers the live row while the run is in flight and shows the working state", () => {
    const row = agentLiveStore.begin({
      id: "task:explore:11",
      agentName: "explore",
      label: "Evaluate methods",
      title: "Evaluate methods",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(row.id, { status: "working", startedAt: Date.now() - 5_000 });
    const lines = plain(
      render(
        spawnAgentTool(),
        {
          content: [{ type: "text", text: "● agent started" }],
          details: { rowId: row.id, agent: "explore", title: "Evaluate methods", status: "running" },
        },
        { expanded: false, isPartial: true },
      ),
    );
    expect(lines[0]).toBe(`│ LOCUS · agent ${row.displayName} · RUNNING`);
    expect(lines[1]).toMatch(
      new RegExp(`^│ [⠿⠻⠽⠾] \\[agent ${row.displayName}\\] working · Evaluate methods · \\d+s$`, "u"),
    );
    // A partial never shows an answer bar: streamed status text is not the answer.
    expect(lines.join("\n")).not.toContain("▌");
  });

  it("renders failures as a FAILED block with the reason as a dim line, never as an answer", () => {
    const lines = plain(
      render(
        spawnAgentTool(),
        {
          content: [{ type: "text", text: "Child agent returned no final text.\nsecond diagnostic" }],
          details: {
            rowId: "task:explore:12",
            agent: "explore",
            displayName: "Wren",
            title: "Evaluate methods",
            status: "failed",
          },
          isError: true,
        },
        { expanded: false, isPartial: false },
      ),
    );
    expect(lines[0]).toBe("│ LOCUS · agent Wren · FAILED");
    expect(lines[1]).toBe("│ ✗ [agent Wren] failed · Evaluate methods");
    expect(lines).toContain("│ reason: Child agent returned no final text.");
    expect(lines.join("\n")).not.toContain("▌");
  });

  it("keeps exact evidence paths and the index warning in collapsed failures", () => {
    const index = "/a-long-project-directory/with-a-long-workspace-name/.locus-pi/logs/errors.jsonl";
    const resultPath = "/a-long-project-directory/.locus-pi/runs/a-child-session/runtime/result.json";
    const lines = render(
      spawnAgentTool(),
      {
        content: [{ type: "text", text: "Provider quota exhausted" }],
        isError: true,
        details: {
          status: "failed",
          displayName: "Wren",
          title: "Review design",
          failureCause: "provider-error",
          errorLogPath: index,
          errorLogWarning: "Error index unavailable: busy",
          resultArtifact: resultPath,
        },
      },
      { expanded: false, isPartial: false },
      60,
    );
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    const text = plain(lines)
      .map((line) => line.replace(/^│ /u, ""))
      .join("");
    expect(text).toContain(index);
    expect(text).toContain(resultPath);
    expect(text).toContain("provider-error");
    expect(text).toContain("Error index unavailable: busy");
  });

  it("stays inside narrow widths without losing identity or state", () => {
    const width = 30;
    const lines = render(
      spawnAgentTool(),
      {
        content: [{ type: "text", text: "a rather long agent answer line that must clip" }],
        details: {
          rowId: "task:explore:13",
          agent: "explore",
          displayName: "Heisenberg",
          title: "a very long task title that cannot fit",
          status: "completed",
          elapsedMs: 3_000,
        },
      },
      { expanded: false, isPartial: false },
      width,
    );
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(plain(lines).join("\n")).toContain("Heisenberg");
  });
});
