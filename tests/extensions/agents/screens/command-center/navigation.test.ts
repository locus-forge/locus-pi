import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AgentsCommandCenter,
  commandCenterRows,
} from "../../../../../extensions/agents/fleet/command-center/center.js";
import { activityStore } from "../../../../../extensions/_shared/agent-runtime/activity-store.js";
import { agentLiveStore } from "../../../../../extensions/_shared/agent-runtime/agent-live-store.js";

const temporary: string[] = [];
beforeEach(() => {
  agentLiveStore.reset();
  activityStore.agents.clear();
  activityStore.workflows.clear();
});
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const plain = (value: string[]) => value.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
function begin(id: string, root = "/project") {
  return agentLiveStore.beginExecution({
    id,
    projectRoot: root,
    label: "Implement",
    request: "Long instruction\n".repeat(90),
  });
}

it.each(["directory", "worktree marker"])("groups nested attempts under their repository with a %s", (marker) => {
  const repository = mkdtempSync(path.join(tmpdir(), "center-repo-"));
  temporary.push(repository);
  if (marker === "directory") mkdirSync(path.join(repository, ".git"));
  else {
    mkdirSync(path.join(repository, ".git-metadata"));
    writeFileSync(path.join(repository, ".git"), "gitdir: .git-metadata\n");
  }
  const roots = ["first", "second"].map((name) => path.join(repository, "experiments", name));
  for (const [index, root] of roots.entries()) {
    mkdirSync(root, { recursive: true });
    const child = begin(`agent-${index}`, root);
    agentLiveStore.patchExecution(child, { childSessionId: "same-id", status: "working" });
    activityStore.workflow({ runId: `run-${index}`, projectRoot: root, sourcePath: "flow.mjs", status: "running" });
  }
  const rows = commandCenterRows();
  const projects = rows.filter((row) => row.kind === "project");
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({ projectPath: repository, repositoryRoot: repository, launchRoots: roots });
  expect(projects[0]!.counts).toContain("2 sessions");
  expect(rows.filter((row) => row.workflow).map((row) => row.workflow!.projectRoot)).toEqual(roots);
  expect([...activityStore.agents.values()].map((agent) => agent.row.projectRoot)).toEqual(roots);
  const choose = vi.fn();
  const center = new AgentsCommandCenter(() => 32, choose, vi.fn(), vi.fn(), activityStore, projects[0]!.key);
  expect(plain(center.render(120))).toContain(`Project: ${path.basename(repository)}`);
  center.handleInput("\r");
  expect(plain(center.render(120))).toContain("Focus: details");
  expect(choose).not.toHaveBeenCalled();
  center.handleInput("p");
  const full = plain(center.render(300));
  expect(full).toContain(roots[0]);
  expect(full).toContain(roots[1]);
});

it("keeps unknown/non-Git launch directories distinct and selectable", () => {
  begin("one", "/not-a-git-repository/one");
  begin("two", "/not-a-git-repository/two");
  expect(
    commandCenterRows()
      .filter((row) => row.projectPath)
      .map((row) => row.projectPath),
  ).toEqual(["/not-a-git-repository/one", "/not-a-git-repository/two"]);
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn());
  center.render(120);
  center.handleInput("\x1b[A");
  expect(center.selectedKey).toBe("project:/not-a-git-repository/one");
  expect(plain(center.render(120))).toContain("Project directory:");
});

it.each([50, 120])("makes detail focus visible and scrolls arrows without changing selection at width %i", (width) => {
  begin("one");
  const dismiss = vi.fn();
  const center = new AgentsCommandCenter(() => 24, vi.fn(), dismiss, vi.fn());
  center.render(width);
  const selected = center.selectedKey;
  center.handleInput("\t");
  expect(plain(center.render(width))).toContain("Focus: details");
  center.handleInput("\x1b[B");
  expect(center.selectedKey).toBe(selected);
  expect(plain(center.render(width))).toContain("Details 2–");
  center.handleInput("\x1b[D");
  expect(plain(center.render(width))).toContain("Focus: tree");
  expect(dismiss).not.toHaveBeenCalled();
  center.handleInput("\x1b[D");
  expect(dismiss).toHaveBeenCalledOnce();
});

it("reveals the agent working path in place before a long prompt and marks the global path mode", () => {
  const execution = begin("one");
  agentLiveStore.patchExecution(execution, { currentPath: "/external/specific/working-directory", status: "working" });
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn());
  const compact = plain(center.render(220));
  expect(compact).toContain("Activity: running");
  center.handleInput("p");
  const full = plain(center.render(220));
  expect(full).toContain("Working directory: /external/specific/working-directory");
  expect(full).toContain("Paths: full");
  expect(full.indexOf("Working directory:")).toBeLessThan(full.indexOf("Launch prompt"));
  expect(agentLiveStore.rowForExecution(execution)!.status).toBe("working");
});

it.each(["p", "P", "з", "З", "\x1b[112u", "\x1b[112;2u"])(
  "recognizes the path shortcut in native key encoding %j",
  (key) => {
    begin("one");
    const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn());
    center.render(120);
    center.handleInput(key);
    expect(plain(center.render(120))).toContain("Paths: full");
    center.handleInput(key);
    expect(plain(center.render(120))).toContain("Paths: short");
  },
);

it("preserves repository and final directory anchors in a compact launch path", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "center-anchor-"));
  temporary.push(repository);
  mkdirSync(path.join(repository, ".git"));
  const root = path.join(repository, "experiments", "very-long-series-directory", "2048-final-attempt");
  mkdirSync(root, { recursive: true });
  const execution = begin("nested", root);
  agentLiveStore.patchExecution(execution, { currentPath: root });
  const center = new AgentsCommandCenter(() => 32, vi.fn(), vi.fn(), vi.fn());
  const output = plain(center.render(200));
  expect(output).toContain(path.basename(repository));
  expect(output).toContain("2048-final-attempt");
  expect(output).toContain("same as launch");
  for (const width of [40, 70, 100])
    expect(center.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
});

it("uses a subdued full-row selection and marker without requesting bold text", () => {
  const execution = begin("one");
  agentLiveStore.patchExecution(execution, { status: "working" });
  const bold = vi.fn(() => {
    throw new Error("Selection must not use bold");
  });
  const bg = vi.fn((_token: string, text: string) => `\x1b[48;2;38;34;48m${text}\x1b[49m`);
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn(), activityStore, undefined, { bg, bold });
  const selected = center.render(120).find((line) => line.includes("▸"))!;
  expect(bg).toHaveBeenCalledWith("userMessageBg", expect.any(String));
  expect(visibleWidth(bg.mock.calls[0]![1])).toBe(visibleWidth(plain([selected]).split(" │ ")[0]!));
  expect(selected.indexOf("\x1b[48;")).toBeLessThan(selected.indexOf("running"));
  expect(selected.indexOf("\x1b[49m")).toBeGreaterThan(selected.indexOf("running"));
  expect(selected).not.toContain("\x1b[1m");
  expect(bold).not.toHaveBeenCalled();
  bg.mockClear();
  const projectLine = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn(), activityStore, "project:/project", {
    bg,
    bold,
  })
    .render(120)
    .find((line) => line.includes("▸"))!;
  expect(visibleWidth(bg.mock.calls[0]![1])).toBe(visibleWidth(plain([projectLine]).split(" │ ")[0]!));
});

it("cleans full project launch paths, including unlabelled directory-list entries", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const root = `/not-a-repository/\x1b[31m${token}`;
  begin("one", root);
  const project = commandCenterRows().find((row) => row.kind === "project")!;
  const center = new AgentsCommandCenter(() => 30, vi.fn(), vi.fn(), vi.fn(), activityStore, project.key);
  center.render(300);
  center.handleInput("p");
  const output = center.render(300).join("\n");
  expect(output).toContain("Paths: full");
  expect(output).toContain("[REDACTED:github-token]");
  expect(output).not.toContain(token);
  expect(output).not.toContain("\x1b[31m");
});

it.each(["arbitrary text", "gitdir: missing-target\n"])(
  "does not infer a repository through a broken .git marker: %s",
  (content) => {
    const outer = mkdtempSync(path.join(tmpdir(), "center-invalid-git-"));
    temporary.push(outer);
    mkdirSync(path.join(outer, ".git"));
    const nested = path.join(outer, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(nested, ".git"), content);
    const root = path.join(nested, "attempt");
    mkdirSync(root);
    begin("one", root);
    expect(commandCenterRows().find((row) => row.projectPath)).toMatchObject({ projectPath: root });
    expect(commandCenterRows().find((row) => row.projectPath)!.repositoryRoot).toBeUndefined();
  },
);

it("shows a current error as failed without rewriting its runtime state", () => {
  const execution = begin("failed");
  agentLiveStore.patchExecution(execution, { status: "error" });
  const output = plain(new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn()).render(120));
  expect(output).toContain("Activity: failed");
  expect(agentLiveStore.rowForExecution(execution)!.status).toBe("error");
});

it("keeps the complete last message before a long launch prompt without duplicating its preview", () => {
  const execution = begin("one");
  const message = Array.from({ length: 12 }, (_, i) => `Message line ${i}`).join("\n") + "\nMESSAGE_END_VISIBLE";
  agentLiveStore.patchExecution(execution, { latestMessage: message });
  const output = plain(new AgentsCommandCenter(() => 300, vi.fn(), vi.fn(), vi.fn()).render(120));
  expect(output.indexOf("MESSAGE_END_VISIBLE")).toBeGreaterThan(output.indexOf("Last message"));
  expect(output.indexOf("MESSAGE_END_VISIBLE")).toBeLessThan(output.indexOf("Launch prompt"));
  expect(output.split("Message line 0")).toHaveLength(2);
  expect(output).toContain("Long instruction");
});

it.each([40, 50, 60, 70, 114, 115, 173])(
  "keeps truthful contextual actions and path help visible at width %i",
  (width) => {
    const historical = begin("slot");
    agentLiveStore.patchExecution(historical, { status: "done" });
    const current = begin("slot");
    activityStore.workflow({ runId: "w", projectRoot: "/project", sourcePath: "flow.mjs", status: "completed" });
    const key = (execution: typeof current) =>
      [...activityStore.agents.values()].find((entry) => entry.execution === execution)!.key;
    for (const [selected, action] of [
      ["project:/project", "Enter details"],
      ["workflow:w", "Enter details"],
      [key(historical), "Enter history"],
      [key(current), "Enter session"],
    ]) {
      const frame = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn(), activityStore, selected).render(width);
      const controls = plain([frame.at(-2)!]);
      for (const label of [action!, "Esc", "Tab", "P/З paths"]) expect(controls).toContain(label);
      expect(visibleWidth(frame.at(-2)!)).toBeLessThanOrEqual(width);
      expect(plain([frame[4]!])).toContain("Status");
    }
  },
);

it.each([40, 120])("does not promise opening details without an available selection at width %i", (width) => {
  const empty = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn());
  const emptyControls = plain([empty.render(width).at(-2)!]);
  expect(emptyControls).toContain("No selection");
  expect(emptyControls).not.toContain("Enter details");
  begin("one");
  begin("two");
  const selected = [...activityStore.agents.keys()][0]!;
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn(), activityStore, selected);
  center.render(width);
  activityStore.agents.delete(selected);
  const controls = plain([center.render(width).at(-2)!]);
  expect(controls).toContain("No selection");
  expect(controls).not.toContain("Enter details");
  expect(center.selectedKey).toBe(selected);
});

it.each([
  [70, false],
  [114, false],
  [115, true],
  [173, true],
])("uses two panes at width %i only when both are useful", (width, split) => {
  begin("one");
  const center = new AgentsCommandCenter(() => 24, vi.fn(), vi.fn(), vi.fn());
  const header = plain([center.render(width as number)[4]!]);
  expect(header.includes(" │ ")).toBe(split);
  if (!split) {
    center.handleInput("\t");
    expect(plain([center.render(width as number)[4]!])).toContain("Agent Details");
  }
});
