import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  activityStore,
  startWorkflowActivity,
  settleWorkflowActivity,
  projectWorkflowActivityPhase,
  projectWorkflowActivityHandoff,
  type WorkflowActivity,
} from "../../../../../extensions/_shared/agent-runtime/activity-store.js";
import { agentLiveStore } from "../../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { AgentsCommandCenter } from "../../../../../extensions/agents/fleet/command-center/center.js";
import {
  commandCenterRows,
  commandCenterTime,
  type CenterRow,
} from "../../../../../extensions/agents/fleet/command-center/model.js";
import { AgentScreen } from "../../../../../extensions/agents/fleet/agent-screen.js";

beforeEach(() => {
  agentLiveStore.reset();
  activityStore.agents.clear();
  activityStore.workflows.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
function workflow(fields: Partial<WorkflowActivity> = {}): CenterRow {
  return {
    key: "workflow:w",
    kind: "workflow",
    text: "",
    workflow: {
      runId: "w",
      projectRoot: "/demo",
      sourcePath: "flow.mjs",
      status: "running",
      ...fields,
    },
  };
}
it.each([
  [0, "<1s"],
  [12_000, "12s"],
  [84_000, "1m24s"],
  [3_720_000, "1h2m"],
  [90_000_000, "25h"],
])("shows elapsed duration at %i ms", (elapsed, expected) => {
  expect(commandCenterTime(workflow({ startedAt: 1_000 }), 1_000 + elapsed)).toBe(expected);
});
it.each(["completed", "failed", "cancelled", "awaiting_operator"] as const)(
  "shows result age rather than run duration for %s",
  (status) => {
    expect(commandCenterTime(workflow({ status, startedAt: 1_000, finishedAt: 90_000 }), 102_000)).toBe("12s ago");
  },
);
it("keeps absent/invalid timestamps unknown and clamps future timestamps without negative time", () => {
  for (const value of [undefined, NaN, Infinity, -1]) {
    const row = workflow(value === undefined ? {} : { startedAt: value });
    expect(commandCenterTime(row, 100_000)).toBe("—");
    expect(
      commandCenterTime(
        workflow({ status: "completed", ...(value === undefined ? {} : { finishedAt: value }) }),
        100_000,
      ),
    ).toBe("—");
  }
  expect(commandCenterTime(workflow({ startedAt: 200_000 }), 100_000)).toBe("<1s");
});
it("uses frozen agent completion evidence across later events and row replacement", () => {
  const old = agentLiveStore.beginExecution({ id: "a", label: "Count", projectRoot: "/demo" });
  agentLiveStore.patchExecution(old, { status: "done", startedAt: 1_000, elapsedMs: 89_000 });
  agentLiveStore.patchExecution(old, { lastActivityAt: 101_000, resultArtifact: "/result.json" });
  agentLiveStore.beginExecution({ id: "a", label: "Replacement", projectRoot: "/demo" });
  const row = commandCenterRows().find((row) => row.agent?.execution === old)!;
  expect(row.agent?.current).toBe(false);
  expect(commandCenterTime(row, 102_000)).toBe("12s ago");
});
it("records workflow start and first settlement through an old-shaped retained facade", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const workflows = new Map<string, WorkflowActivity>();
  const store = {
    workflows,
    workflow(value: WorkflowActivity) {
      workflows.set(value.runId, value);
    },
  };
  startWorkflowActivity({ runId: "w", projectRoot: "/demo", sourcePath: "flow.mjs" }, store);
  vi.setSystemTime(20_000);
  projectWorkflowActivityPhase("w", "Review", store);
  expect(workflows.get("w")?.startedAt).toBe(10_000);
  settleWorkflowActivity("w", "awaiting_operator", store);
  vi.setSystemTime(30_000);
  projectWorkflowActivityHandoff("w", "resolved", store);
  settleWorkflowActivity("w", "awaiting_operator", store);
  expect(workflows.get("w")).toMatchObject({
    startedAt: 10_000,
    finishedAt: 20_000,
    phase: "Review",
    handoffState: "resolved",
  });
  settleWorkflowActivity("missing", "failed", store);
  expect(workflows.size).toBe(1);
});
it.each([80, 173])("puts time after status at width %i and updates without changing selection", (width) => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const a = agentLiveStore.beginExecution({ id: "a", label: "Count", projectRoot: "/demo" });
  agentLiveStore.patchExecution(a, { status: "working", startedAt: 16_000 });
  const center = new AgentsCommandCenter(() => 30, vi.fn(), vi.fn(), vi.fn());
  const frame = center.render(width);
  expect(plain(frame)).toMatch(/running\s+1m24s/);
  expect(plain(frame)).toMatch(/Status\s+Time/);
  const key = center.selectedKey;
  vi.advanceTimersByTime(2_000);
  expect(plain(center.render(width))).toMatch(/running\s+1m26s/);
  expect(center.selectedKey).toBe(key);
  for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  center.dispose();
});
it("keeps time in details even when a very compact tree has no time column", () => {
  vi.useFakeTimers();
  vi.setSystemTime(102_000);
  const a = agentLiveStore.beginExecution({ id: "a", label: "Count", projectRoot: "/demo" });
  agentLiveStore.patchExecution(a, { status: "done", startedAt: 1_000, elapsedMs: 89_000 });
  const center = new AgentsCommandCenter(() => 30, vi.fn(), vi.fn(), vi.fn());
  center.render(40);
  center.handleInput("\t");
  expect(plain(center.render(40))).toContain("Result received: 12s ago");
  center.dispose();
});
it("ticks only while the center is visible and stops on select, suspend and dispose", async () => {
  vi.useFakeTimers();
  const repaint = vi.fn();
  const tui = { requestRender: repaint, setLayoutRoot() {}, setFocus() {} } as unknown as TUI & {
    setLayoutRoot(c: Component): void;
  };
  agentLiveStore.beginExecution({ id: "a", label: "Count" });
  const screen = new AgentScreen(tui, vi.fn());
  screen.list();
  screen.list();
  expect(vi.getTimerCount()).toBe(1);
  repaint.mockClear();
  vi.advanceTimersByTime(2_000);
  expect(repaint).toHaveBeenCalledTimes(2);
  await screen.select("a");
  expect(vi.getTimerCount()).toBe(0);
  screen.list();
  screen.suspend();
  expect(vi.getTimerCount()).toBe(0);
  screen.list();
  screen.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
