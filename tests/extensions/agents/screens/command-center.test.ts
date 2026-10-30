import { beforeEach, expect, it, vi } from "vitest";
import { AgentsCommandCenter, commandCenterRows } from "../../../../extensions/agents/fleet/command-center.js";
import { activityStore, renderActivityStrip } from "../../../../extensions/_shared/agent-runtime/activity-store.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { installCommandCenterEditor } from "../../../../extensions/agents/fleet/command-center-editor.js";
import { createHarness } from "../../../test-harness.js";

beforeEach(() => {
  agentLiveStore.reset();
  activityStore.agents.clear();
  activityStore.workflows.clear();
  activityStore.maxItems = 4;
});
function agent(id: string, projectRoot = "/project", workflowRunId?: string) {
  return agentLiveStore.beginExecution({
    id,
    projectRoot,
    label: "Validate build",
    request: "Check the build",
    ...(workflowRunId ? { workflowRunId } : {}),
  });
}
it("retains selection by execution ID across insertion; pruning never silently chooses another session", () => {
  agent("a");
  const selected = [...activityStore.agents.keys()][0]!;
  const choose = vi.fn();
  const center = new AgentsCommandCenter(() => 24, choose, vi.fn(), vi.fn(), activityStore, selected);
  agent("b");
  center.handleInput("\r");
  expect(choose.mock.calls[0]![0].key).toBe(selected);
  activityStore.agents.delete(selected);
  choose.mockClear();
  center.handleInput("\r");
  expect(choose).not.toHaveBeenCalled();
});
it("counts unique executions, not mirrors or worktrees, and keeps replaced rounds read-only", () => {
  const old = agent("slot", "/one/project");
  agentLiveStore.patchExecution(old, { childSessionId: "old", currentPath: "/tmp/worktree" });
  agent("workflow:mirror", "/one/project");
  agent("slot", "/one/project");
  agent("second", "/two/project");
  const rows = commandCenterRows();
  expect(rows.filter((r) => r.kind === "agent")).toHaveLength(3);
  expect(rows.find((r) => r.key === "project:/one/project")?.text).toContain("2 sessions · 1 active · 1 inactive");
  expect([...activityStore.agents.values()].find((a) => a.execution === old)?.current).toBe(false);
});
it("always expands authoritative nested workflows and isolates concurrent identical script paths", () => {
  activityStore.workflow({ runId: "root", projectRoot: "/project", sourcePath: "/project/run.mjs", status: "running" });
  activityStore.workflow({
    runId: "child",
    parentRunId: "root",
    projectRoot: "/project",
    sourcePath: "/project/child.mjs",
    status: "running",
  });
  activityStore.workflow({
    runId: "other",
    projectRoot: "/project",
    sourcePath: "/project/run.mjs",
    status: "running",
  });
  agent("nested", "/project", "child");
  const rows = commandCenterRows();
  expect(rows.find((r) => r.key === "workflow:child")?.text).toMatch(/^    ◇/);
  expect(rows.find((r) => r.agent?.row.id === "nested")?.text).toMatch(/^      ●/);
  expect(rows.filter((r) => r.kind === "workflow")).toHaveLength(3);
  expect(renderActivityStrip(140)).toHaveLength(2);
});
it("missing/cyclic lineage never hides agents or loops", () => {
  for (const [runId, parentRunId] of [
    ["a", "b"],
    ["b", "a"],
    ["c", "missing"],
  ])
    activityStore.workflow({
      runId: runId!,
      parentRunId: parentRunId!,
      projectRoot: "/project",
      sourcePath: `${runId}.mjs`,
      status: "running",
    });
  expect(commandCenterRows().filter((r) => r.kind === "workflow")).toHaveLength(3);
});
it("bounds strip with overflow and configurable maximum, retaining workflow without double counting children", () => {
  activityStore.workflow({ runId: "w", projectRoot: "/project", sourcePath: "flow.mjs", status: "running" });
  agent("child", "/project", "w");
  for (let i = 0; i < 5; i++) agent(`a${i}`);
  const lines = renderActivityStrip(100);
  expect(lines).toHaveLength(5);
  expect(lines[0]).toContain("flow.mjs");
  expect(lines[4]).toContain("+2 more");
  activityStore.setMaxItems(2);
  expect(renderActivityStrip(100)).toHaveLength(3);
  expect(() => activityStore.setMaxItems(0)).toThrow();
});
it("renders compact normal-case details, launch prompt and quiet selection; Escape and Backspace dismiss only", () => {
  agent("a");
  const dismiss = vi.fn(),
    choose = vi.fn();
  const center = new AgentsCommandCenter(() => 24, choose, dismiss, vi.fn());
  const output = center.render(120).join("\n");
  expect(output).toContain("Agents Command Center");
  expect(output).toContain("Agent Details");
  expect(output).toContain("Launch prompt");
  expect(output).toContain("Validate build");
  expect(output).not.toContain("Task Details");
  expect(output).not.toContain("\x1b[48;");
  center.handleInput("\x1b");
  center.handleInput("\x7f");
  expect(dismiss).toHaveBeenCalledTimes(2);
  expect(choose).not.toHaveBeenCalled();
});
it("editor-local left hook preserves nonempty/multiline/modifier/completion/paste input and prior factory", () => {
  const h = createHarness();
  const open = vi.fn(),
    handle = vi.fn();
  let text = "",
    autocomplete = false;
  const editor = { handleInput: handle, getExpandedText: () => text, isShowingAutocomplete: () => autocomplete };
  let factory = () => editor;
  const original = factory;
  h.ctx.ui.getEditorComponent = () => factory;
  h.ctx.ui.setEditorComponent = (value) => {
    factory = value as typeof factory;
  };
  const dispose = installCommandCenterEditor(h.ctx, open);
  const wrapped = factory();
  for (const value of ["draft", "\n", "\nline", " "]) {
    text = value;
    wrapped.handleInput("\x1b[D");
  }
  text = "";
  autocomplete = true;
  wrapped.handleInput("\x1b[D");
  autocomplete = false;
  wrapped.handleInput("\x1b[1;5D");
  wrapped.handleInput("\x1b[200~");
  wrapped.handleInput("\x1b[D");
  wrapped.handleInput("\x1b[201~");
  expect(open).not.toHaveBeenCalled();
  wrapped.handleInput("\x1b[D");
  expect(open).toHaveBeenCalledOnce();
  expect(handle).toHaveBeenCalledTimes(9);
  dispose();
  expect(factory).toBe(original);
});

it("narrow screens expose details via Tab and empty fillers never appear selected", () => {
  const empty = new AgentsCommandCenter(() => 20, vi.fn(), vi.fn(), vi.fn());
  expect(empty.render(80).join("\n")).not.toContain("▧");
  agent("a");
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn());
  center.render(50);
  center.handleInput("\t");
  expect(center.render(50).join("\n")).toContain("Agent Details");
});
it("retained workflow children remain visible after their workflow settles and cycle roots cannot disappear", () => {
  activityStore.workflow({ runId: "w", projectRoot: "/project", sourcePath: "flow.mjs", status: "completed" });
  agent("child", "/project", "w");
  expect(renderActivityStrip(100)).toHaveLength(1);
  activityStore.workflow({
    runId: "a",
    parentRunId: "b",
    projectRoot: "/project",
    sourcePath: "a.mjs",
    status: "running",
  });
  activityStore.workflow({
    runId: "b",
    parentRunId: "a",
    projectRoot: "/project",
    sourcePath: "b.mjs",
    status: "running",
  });
  expect(renderActivityStrip(100)).toHaveLength(2);
});
it("unknown third-party editors keep Left without throwing or hijacking input", () => {
  const h = createHarness();
  const handleInput = vi.fn(),
    open = vi.fn();
  const editor = { handleInput };
  let factory = () => editor;
  h.ctx.ui.getEditorComponent = () => factory;
  h.ctx.ui.setEditorComponent = (value) => {
    factory = value as typeof factory;
  };
  installCommandCenterEditor(h.ctx, open);
  factory().handleInput("\x1b[D");
  expect(open).not.toHaveBeenCalled();
  expect(handleInput).toHaveBeenCalledOnce();
});
it("working agents precede retained idle sessions when the strip is capped", () => {
  const idle = agent("idle");
  agentLiveStore.patchExecution(idle, { status: "done" });
  agentLiveStore.registerInputForExecution(idle, async () => {});
  agent("working");
  activityStore.setMaxItems(1);
  expect(renderActivityStrip(100)[0]).toContain(
    [...activityStore.agents.values()].find((a) => a.row.id === "working")!.row.displayName!,
  );
  expect(renderActivityStrip(100)[0]).not.toContain("idle");
});
