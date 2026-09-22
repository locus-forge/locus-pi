import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThemeLike,
  ToolRenderContext,
  ToolRenderResultOptions,
  ToolResult,
} from "../../../../extensions/_shared/host/pi-api.js";
import type { ToolDefinition } from "../../../../extensions/_shared/host/pi-api.js";
import workflows from "../../../../extensions/workflows/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { snapshotWorkflowToolCardAgents } from "../../../../extensions/workflows/tool/workflow-tool-card.js";
import { createHarness } from "../../../test-harness.js";

const theme: ThemeLike = {
  fg(_tone, text) {
    return `\u001b[35m${text}\u001b[0m`;
  },
  bg(_tone, text) {
    return text;
  },
  bold(text) {
    return `\u001b[1m${text}\u001b[22m`;
  },
};

function workflowTool(): ToolDefinition {
  const harness = createHarness();
  workflows(harness.pi);
  return harness.tools.get("workflow")!;
}

function render(
  tool: ToolDefinition,
  result: ToolResult,
  options: ToolRenderResultOptions,
  args: Record<string, unknown> = { name: "plan" },
  width = 80,
  renderTheme: ThemeLike = theme,
): string[] {
  const context: ToolRenderContext = {
    args,
    toolCallId: "workflow-card-test",
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
  const component = tool.renderResult!(result, options, renderTheme, context);
  const lines = component.render(width);
  component.dispose?.();
  return lines;
}

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
}

describe("workflow tool card", () => {
  afterEach(() => vi.useRealTimers());

  it("owns the tool shell and renders partial updates as one named running workflow with an explicit agent row", () => {
    const tool = workflowTool();
    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall!({}, theme, {} as ToolRenderContext).render(80)).toEqual([]);

    const lines = plain(
      render(
        tool,
        {
          content: [{ type: "text", text: "legacy streamed agent text" }],
          details: {
            workflowName: "plan",
            status: "running",
            agentRows: [{ name: "Nernst", work: "reconnaissance", status: "working", elapsedMs: 400 }],
          },
        },
        { expanded: true, isPartial: true },
      ),
    );

    expect(lines[0]).toBe("│ LOCUS · workflow plan · RUNNING");
    expect(lines[1]).toMatch(/^│ [⠿⠻⠽⠾] \[agent Nernst\] working · reconnaissance · <1s$/u);
    expect(lines.join("\n")).not.toContain("RESULT");
    expect(lines.join("\n")).not.toContain("legacy streamed agent text");
  });

  it("keeps completed model text outside the technical rail", () => {
    const lines = plain(
      render(
        workflowTool(),
        {
          content: [{ type: "text", text: "bounded model digest" }],
          details: {
            workflowName: "plan",
            status: "completed",
            agentRows: [{ name: "Nernst", work: "reconnaissance", status: "done", elapsedMs: 18_000 }],
          },
        },
        { expanded: true, isPartial: false },
      ),
    );

    expect(lines).toEqual([
      "│ LOCUS · workflow plan · COMPLETED",
      "│ ✓ [agent Nernst] completed · reconnaissance · 18s",
    ]);
  });

  it("keeps failed and awaiting-operator explanations inside the Locus annotation", () => {
    const failed = plain(
      render(
        workflowTool(),
        {
          content: [{ type: "text", text: "model-facing failure digest" }],
          details: {
            workflowName: "review",
            status: "failed",
            summary: "child agent returned failed",
            agentRows: [{ name: "Nernst", work: "reconnaissance", status: "error", elapsedMs: 7_000 }],
          },
          isError: true,
        },
        { expanded: false, isPartial: false },
        { name: "review" },
      ),
    );
    expect(failed).toEqual([
      "│ LOCUS · workflow review · FAILED",
      "│ ✗ [agent Nernst] failed · reconnaissance · 7s",
      "│ reason: child agent returned failed",
    ]);
    expect(failed.join("\n")).not.toContain("model-facing failure digest");

    const awaiting = plain(
      render(
        workflowTool(),
        {
          content: [{ type: "text", text: "awaiting digest" }],
          details: {
            workflowName: "review",
            status: "awaiting_operator",
            summary: "answer required",
            agentRows: [{ name: "Nernst", work: "reconnaissance", status: "done", elapsedMs: 7_000 }],
          },
        },
        { expanded: false, isPartial: false },
        { name: "review" },
      ),
    );
    expect(awaiting).toContain("│ LOCUS · workflow review · AWAITING OPERATOR");
    expect(awaiting).toContain("│ ◐ waiting for operator decision");
  });

  it("preserves workflow identity and state at narrow widths without overflowing", () => {
    const width = 28;
    const lines = render(
      workflowTool(),
      {
        content: [{ type: "text", text: "streaming" }],
        details: {
          workflowName: "plan",
          status: "running",
          agentRows: [
            {
              name: "Nernst",
              work: "a very long reconnaissance label",
              status: "working",
              elapsedMs: 20_000,
            },
          ],
        },
      },
      { expanded: false, isPartial: true },
      { name: "plan" },
      width,
    );
    const text = plain(lines).join("\n");

    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(text).toContain("plan · RUNNING");
    expect(text).toContain("agent Nernst · working");
  });

  it("bounds compact multi-agent output and leaves expanded output complete", () => {
    const agentRows = Array.from({ length: 7 }, (_, index) => ({
      name: `Agent-${index + 1}`,
      work: `work-${index + 1}`,
      status: index === 6 ? "working" : "done",
      elapsedMs: 1_000,
    }));
    const result: ToolResult = {
      content: [{ type: "text", text: "streaming" }],
      details: { workflowName: "review", status: "running", agentRows },
    };

    const compact = plain(render(workflowTool(), result, { expanded: false, isPartial: true }));
    const expanded = plain(render(workflowTool(), result, { expanded: true, isPartial: true }));
    expect(compact.join("\n")).toContain("… +3 other agents");
    expect(compact.join("\n")).not.toContain("Agent-1");
    expect(compact.join("\n")).toContain("Agent-7");
    expect(expanded.filter((line) => line.includes("[agent Agent-"))).toHaveLength(7);
  });

  it("uses theme roles for the Locus hierarchy and distinct workflow states", () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const semanticTheme: ThemeLike = { ...theme, fg };
    const tool = workflowTool();

    render(
      tool,
      {
        content: [{ type: "text", text: "streaming" }],
        details: { workflowName: "plan", status: "running", agentRows: [] },
      },
      { expanded: false, isPartial: true },
      { name: "plan" },
      80,
      semanticTheme,
    );
    expect(fg).toHaveBeenCalledWith("syntaxKeyword", "│");
    expect(fg).toHaveBeenCalledWith("warning", "RUNNING");

    fg.mockClear();
    render(
      tool,
      {
        content: [{ type: "text", text: "failure" }],
        details: {
          workflowName: "plan",
          status: "failed",
          agentRows: [{ name: "Nernst", work: "reconnaissance", status: "error" }],
        },
        isError: true,
      },
      { expanded: false, isPartial: false },
      { name: "plan" },
      80,
      semanticTheme,
    );
    expect(fg).toHaveBeenCalledWith("error", "FAILED");
    expect(fg).toHaveBeenCalledWith("error", "✗");
  });

  it("reuses the card across running-to-completed redraws and stops timer invalidation", () => {
    vi.useFakeTimers();
    const tool = workflowTool();
    const invalidate = vi.fn();
    const context: ToolRenderContext = {
      args: { name: "plan" },
      toolCallId: "workflow-transition-test",
      invalidate,
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const running = tool.renderResult!(
      {
        content: [{ type: "text", text: "streaming" }],
        details: { workflowName: "plan", status: "running", agentRows: [] },
      },
      { expanded: false, isPartial: true },
      theme,
      context,
    );
    // The card ticks at 1 Hz: fast enough for a second-granular elapsed
    // counter, slow enough not to repaint four times per visible change.
    vi.advanceTimersByTime(2_000);
    expect(invalidate).toHaveBeenCalledTimes(2);

    const completed = tool.renderResult!(
      {
        content: [{ type: "text", text: "complete" }],
        details: { workflowName: "plan", status: "completed", agentRows: [] },
      },
      { expanded: false, isPartial: false },
      theme,
      { ...context, lastComponent: running, isPartial: false },
    );
    expect(completed).toBe(running);
    const settledInvalidations = invalidate.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(invalidate).toHaveBeenCalledTimes(settledInvalidations);
    completed.dispose?.();
  });
});

describe("workflow tool card task title and agent answers", () => {
  it("renders the workflow's task title under the LOCUS header", () => {
    const lines = plain(
      render(
        workflowTool(),
        {
          content: [{ type: "text", text: "streaming" }],
          details: {
            workflowName: "plan",
            status: "running",
            taskTitle: "Создать план переезда merch_check_by_urls",
            agentRows: [{ name: "Nernst", work: "reconnaissance", status: "working", elapsedMs: 400 }],
          },
        },
        { expanded: false, isPartial: true },
      ),
    );
    expect(lines[0]).toBe("│ LOCUS · workflow plan · RUNNING");
    expect(lines[1]).toBe("│ task: Создать план переезда merch_check_by_urls");
    expect(lines[2]).toMatch(/\[agent Nernst\] working/u);
  });

  it("derives the task title from the tool-call input when details predate it", () => {
    const lines = plain(
      render(
        workflowTool(),
        {
          content: [{ type: "text", text: "streaming" }],
          details: { workflowName: "plan", status: "running", agentRows: [] },
        },
        { expanded: false, isPartial: true },
        { name: "plan", input: "migrate the script\nsecond line is ignored" },
      ),
    );
    expect(lines[1]).toBe("│ task: migrate the script");
  });

  it("marks a completed agent's answer with a left bar: one line collapsed, bounded block expanded", () => {
    const answer = ["Report ready.", "- reuse fetch", "- rewrite mail_error"].join("\n");
    const details = {
      workflowName: "plan",
      status: "completed",
      agentRows: [{ name: "Nernst", work: "reconnaissance", status: "done", elapsedMs: 18_000, answer }],
    };
    const collapsed = plain(
      render(
        workflowTool(),
        { content: [{ type: "text", text: "d" }], details },
        { expanded: false, isPartial: false },
      ),
    );
    expect(collapsed).toContain("│   ▌ Report ready. … (+2 lines)");
    expect(collapsed.join("\n")).not.toContain("reuse fetch");

    const expanded = plain(
      render(workflowTool(), { content: [{ type: "text", text: "d" }], details }, { expanded: true, isPartial: false }),
    );
    expect(expanded).toContain("│   ▌ Report ready.");
    expect(expanded).toContain("│   ▌ - reuse fetch");
    expect(expanded).toContain("│   ▌ - rewrite mail_error");
  });

  it("bounds an expanded answer to twelve lines with an honest remainder", () => {
    const answer = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const expanded = plain(
      render(
        workflowTool(),
        {
          content: [{ type: "text", text: "d" }],
          details: {
            workflowName: "plan",
            status: "completed",
            agentRows: [{ name: "Nernst", work: "scan", status: "done", elapsedMs: 1_000, answer }],
          },
        },
        { expanded: true, isPartial: false },
      ),
    );
    expect(expanded).toContain("│   ▌ line 12");
    expect(expanded.join("\n")).not.toContain("line 13");
    expect(expanded).toContain("│   ▌ … (+8 lines)");
  });
});

describe("workflow tool card agent snapshot", () => {
  afterEach(() => {
    agentLiveStore.reset();
  });

  it("shows one entry per logical agent: the anchor collapses in favour of its executor row", () => {
    const runId = "run-snap-1";
    const anchor = agentLiveStore.begin({
      id: `workflow:${runId}:explore:reconnaissance:`,
      workflowRunId: runId,
      agentName: "explore",
      label: "explore (reconnaissance)",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(anchor.id, { status: "working", startedAt: Date.now() });
    const child = agentLiveStore.begin({
      id: `workflow-agent:${runId}:explore:reconnaissance:`,
      parentRowId: anchor.id,
      workflowRunId: runId,
      agentName: "explore",
      label: "reconnaissance",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(child.id, { status: "working", startedAt: Date.now() });

    const agents = snapshotWorkflowToolCardAgents(runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe(anchor.displayName);
    expect(agents[0]?.work).toBe("reconnaissance");
    expect(agents[0]?.status).toBe("working");
  });

  it("captures a completed agent's final answer, bounded for persistence", () => {
    const runId = "run-snap-2";
    const row = agentLiveStore.begin({
      id: `workflow:${runId}:task:report:`,
      workflowRunId: runId,
      agentName: "task",
      label: "task (report)",
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(row.id, { status: "done", finalAnswer: `ready\n${"x".repeat(3000)}` });

    const agents = snapshotWorkflowToolCardAgents(runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.answer?.startsWith("ready")).toBe(true);
    expect(agents[0]?.answer?.length).toBeLessThanOrEqual(2000);

    // A working row never leaks a stale answer into the card.
    agentLiveStore.patch(row.id, { status: "working" });
    expect(snapshotWorkflowToolCardAgents(runId)[0]?.answer).toBeUndefined();
  });
});
