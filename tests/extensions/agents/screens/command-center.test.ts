import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, expect, it, vi } from "vitest";
import {
  AgentsCommandCenter,
  commandCenterRows,
  compactWorkflowPath,
} from "../../../../extensions/agents/fleet/command-center.js";
import {
  activityStore,
  renderActivityStrip,
  projectWorkflowActivityHandoff,
} from "../../../../extensions/_shared/agent-runtime/activity-store.js";
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
it("matches the accepted hierarchy palette, semantic status column and compact detail preview", () => {
  activityStore.workflow({
    runId: "w",
    projectRoot: "/project",
    sourcePath: "/project/workflows/check.mjs",
    status: "running",
  });
  const execution = agent("nested", "/project", "w");
  agentLiveStore.patchExecution(execution, {
    status: "working",
    displayName: "Gamma",
    latestMessage: "long message ".repeat(100),
    currentPath: "/very/long/cloud/path/project",
  });
  const selected = [...activityStore.agents.keys()][0]!;
  const center = new AgentsCommandCenter(() => 32, vi.fn(), vi.fn(), vi.fn(), activityStore, selected);
  const output = center.render(116).join("\n");
  expect(output).toContain("Agents / Workflows");
  expect(output).toContain("Status");
  expect(output).toContain("workflows/check.mjs");
  expect(output).toContain("└─");
  expect(output).toContain("\x1b[38;5;84mworking");
  expect(output).toContain("\x1b[38;5;141m");
  expect(output).toContain("\x1b[38;5;147mModel:");
  expect(output).toContain("Launch prompt");
  expect(output).not.toContain("\x1b[48;");
  for (const width of [50, 80, 116])
    for (const line of center.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

it("compacts workflow paths relative to project, marks external paths, and preserves identity", () => {
  expect(compactWorkflowPath("/project/workflows/release/very-long-directory/check.mjs", "/project", 35)).toContain(
    "check.mjs",
  );
  const inside = compactWorkflowPath("/project/workflows/release/very-long-directory/check.mjs", "/project", 35);
  expect(inside).not.toContain("/project");
  expect(inside).toContain("…");
  const external = compactWorkflowPath("/other/workflows/check.mjs", "/project", 32);
  expect(external).toContain("external:");
  expect(external).toContain("check.mjs");
  for (const width of [12, 20, 35]) {
    const value = compactWorkflowPath("/project/workflows/very-long-workflow-name.mjs", "/project", width);
    expect(visibleWidth(value)).toBeLessThanOrEqual(width);
    expect(value).not.toContain("\n");
    expect(value).toContain(".mjs");
  }
  for (const [runId, sourcePath] of [
    ["a", "/project/a/check.mjs"],
    ["b", "/other/a/check.mjs"],
  ])
    activityStore.workflow({ runId: runId!, sourcePath: sourcePath!, projectRoot: "/project", status: "running" });
  expect(
    commandCenterRows()
      .filter((r) => r.workflow)
      .map((r) => r.key),
  ).toEqual(["workflow:a", "workflow:b"]);
});

it("keeps distinguishable parent folders for same-basename workflows at 80-column tree widths", () => {
  const first = compactWorkflowPath(
    "/project/workflows/long-project-segment/research-pipeline/monthly-validation/verify.workflow.mjs",
    "/project",
    31,
  );
  const second = compactWorkflowPath("/project/workflows/other-validation/verify.workflow.mjs", "/project", 31);
  expect(first).not.toBe(second);
  expect(first).toContain("monthly");
  expect(second).toContain("other");
  expect(first).toContain("verify.workflow.mjs");
  expect(second).toContain("verify.workflow.mjs");
});

it("keeps ordinary workflow details compact and exposes full paths only on explicit expansion", () => {
  activityStore.workflow({
    runId: "w",
    projectRoot: "/very/long/cloud/project",
    sourcePath: "/very/long/cloud/project/workflows/build.mjs",
    status: "running",
  });
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn(), activityStore, "workflow:w");
  expect(center.render(80).join("\n")).not.toContain("Full source path");
  center.handleInput("p");
  expect(center.render(80).join("\n")).toContain("Full source path");
  center.handleInput("p");
  expect(center.render(80).join("\n")).not.toContain("Full source path");
});

it("projects a handoff into an old-shaped v1 singleton without requiring a new instance method", () => {
  const workflows = new Map(activityStore.workflows);
  workflows.set("source", {
    runId: "source",
    projectRoot: "/project",
    sourcePath: "handoff.mjs",
    status: "awaiting_operator",
  });
  const oldStore = {
    workflows,
    workflow(value: typeof workflows extends Map<string, infer T> ? T : never) {
      workflows.set(value.runId, value);
    },
  };
  projectWorkflowActivityHandoff("source", "resolved", oldStore);
  expect(workflows.get("source")).toMatchObject({ status: "awaiting_operator", handoffState: "resolved" });
});
it("labels narrow workflow details truthfully", () => {
  activityStore.workflow({ runId: "w", projectRoot: "/project", sourcePath: "build.mjs", status: "running" });
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn(), activityStore, "workflow:w");
  center.handleInput("\t");
  expect(center.render(50).join("\n")).toContain("Workflow Details");
});
