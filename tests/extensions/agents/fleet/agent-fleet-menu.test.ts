import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import {
  FLEET_FOCUS_FALLBACK_SHORTCUT,
  FleetFocusComponent,
  fleetMenuState,
  renderFleetMenuRows,
  selectFleetMenuLeafRows,
  selectFleetMenuRows,
} from "../../../../extensions/_shared/agent-runtime/fleet-menu.js";
import { agentLiveStore, type AgentLiveStatus } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { orderAgentLiveRows } from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { DEFAULT_RENDER_MIN_INTERVAL_MS } from "../../../../extensions/_shared/host/render-scheduler.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveChildRowId,
  workflowAgentLiveRowId,
  workflowGroupLiveRowId,
} from "../../../../extensions/workflows/runtime/workflow-live.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { CustomUiComponent, CustomUiFactory } from "../../../../extensions/_shared/host/pi-api.js";
import {
  installWorkflowProgress,
  type WorkflowProgressComponent,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
import { createHarness, emit } from "../../../test-harness.js";

afterEach(() => {
  fleetMenuState.setFocused(false);
  fleetMenuState.setVisibleRows([]);
  fleetMenuState.setEmptyEditorFocusAvailable(false);
  fleetMenuState.setFallbackFocusAvailable(false);
  agentLiveStore.reset();
});

function row(id: string, title: string, status: AgentLiveStatus = "working") {
  const value = agentLiveStore.begin({ id, agentName: "reviewer", label: title, title });
  return agentLiveStore.patch(value.id, { status })!;
}

/**
 * A fan-out with the row layer a real run actually produces: the group row, one
 * workflow journal ANCHOR per branch under it, and the SDK child row under each
 * anchor. Two rows per agent, collapsed into one only by the shared projection.
 *
 * Every `/ps` assertion about a group — its heading, that heading's counters, the
 * order of its members — has to be made against this shape. A test that hangs the
 * members straight off the group row skips the collapse entirely and would pass
 * on code where the live surface shows no heading at all, which is exactly how
 * the pin below shipped broken.
 */
function liveFanOut(options: {
  runId: string;
  label: string;
  size: number;
  status?: (index: number) => AgentLiveStatus;
  groupCounters?: { groupCompleted: number; groupFailed: number };
}) {
  const { runId, label, size } = options;
  const group = agentLiveStore.begin({
    id: workflowGroupLiveRowId({ runId, groupId: `parallel-${size}` }),
    agentName: "workflow-group",
    label: `parallel (${size})`,
    groupKind: "parallel",
    groupTotal: size,
    workflowRunId: runId,
  });
  agentLiveStore.patch(group.id, { status: "working", ...(options.groupCounters ?? {}) });
  const statusOf = options.status ?? ((index: number) => (index === 0 ? "error" : index < 4 ? "done" : "working"));
  const branches = Array.from({ length: size }, (_unused, index) => {
    const memberLabel = `${label} ${index} of ${size}`;
    const line = { runId, executionMode: "bare", label: memberLabel, phase: "fanout" } as const;
    const anchor = agentLiveStore.begin({
      id: workflowAgentLiveRowId(line),
      parentRowId: group.id,
      agentName: "worker",
      label: memberLabel,
      workflowRunId: runId,
    });
    const child = agentLiveStore.begin({
      id: workflowAgentLiveChildRowId(line),
      parentRowId: anchor.id,
      agentName: "worker",
      label: memberLabel,
      title: memberLabel,
      workflowRunId: runId,
    });
    return { anchor, member: agentLiveStore.patch(child.id, { status: statusOf(index) })! };
  });
  return {
    group,
    anchors: branches.map((branch) => branch.anchor),
    members: branches.map((branch) => branch.member),
  };
}

describe("agent fleet menu", () => {
  it("puts the newest workflow run first and labels the runs behind it", () => {
    const earlier = agentLiveStore.begin({
      id: "workflow-agent:20260726-183012-a6aa:default",
      agentName: "default",
      label: "decide clarification",
      title: "decide clarification",
      workflowRunId: "20260726-183012-a6aa",
    });
    agentLiveStore.patch(earlier.id, { status: "done" });
    const current = agentLiveStore.begin({
      id: "workflow-agent:20260726-183412-b2c4:reviewer",
      agentName: "reviewer",
      label: "inventory changes",
      title: "inventory changes",
      workflowRunId: "20260726-183412-b2c4",
    });
    agentLiveStore.patch(current.id, { status: "working" });

    const rendered = renderFleetMenuRows([...agentLiveStore.rows.values()], 120, {});
    const text = rendered.join("\n");
    const label = rendered.findIndex((line) => line.includes("earlier workflow runs"));
    const currentRow = rendered.findIndex((line) => line.includes("inventory changes"));
    const earlierRow = rendered.findIndex((line) => line.includes("decide clarification"));

    expect(label).toBeGreaterThan(-1);
    expect(currentRow).toBeLessThan(label);
    expect(earlierRow).toBeGreaterThan(label);
    // Nothing is hidden: the earlier run stays drillable, it is only ranked below.
    expect(text).toContain("decide clarification");
  });

  it("keeps the same row projection when focus adds only the cursor and controls", () => {
    const first = row("row-a", "review auth");
    const second = row("row-b", "run tests");
    const rows = [first, second];
    const passive = renderFleetMenuRows(rows, 120, { focusShortcutsAvailable: true });
    const focused = renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: second.id });

    const passiveRows = passive.slice(0, -1).map((line) => line.slice(2));
    const focusedRows = focused.slice(0, -1).map((line) => line.slice(2));
    expect(focusedRows).toEqual(passiveRows);
    expect(focused[1]).toMatch(/^> /);
    expect(passive.at(-1)).toContain("manage");
    expect(focused.at(-1)).toContain("stop");
    expect(focused.at(-1)).toContain("back");
  });

  it("paints the cursor marker in the accent tone and leaves other rows unshifted", () => {
    const first = row("accent-a", "review auth");
    const second = row("accent-b", "run tests");
    const fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
    const themed = renderFleetMenuRows([first, second], 120, {
      focused: true,
      selectedRowId: second.id,
      theme: { fg },
    });

    const marked = themed.filter((line) => line.startsWith("<accent>> </accent>"));
    expect(marked).toHaveLength(1);
    expect(themed.filter((line) => !line.startsWith("<accent>")).every((line) => line.startsWith("  "))).toBe(true);
  });

  it("caps the passive fleet at eight rows and reports the hidden count", () => {
    const rows = Array.from({ length: 11 }, (_unused, index) => row(`row-${index}`, `task ${index}`));

    const selected = selectFleetMenuRows(rows);
    const rendered = renderFleetMenuRows(rows, 120, { focusShortcutsAvailable: true });

    expect(selected).toHaveLength(8);
    expect(rendered.some((line) => line.includes("… and 3 more"))).toBe(true);
  });

  it("shows only explicit Shift+Down as the fleet shortcut", () => {
    const rendered = renderFleetMenuRows([row("down-row", "down agent")], 120, {
      emptyEditorFocusAvailable: true,
      fallbackFocusAvailable: true,
    });
    expect(rendered.at(-1)).toContain("shift+down manage");
    expect(rendered.at(-1)).not.toMatch(/(?:^|\s)down manage/u);
    expect(rendered.at(-1)).not.toContain("cmd+");
    expect(rendered.at(-1)).not.toContain("ctrl+");
  });

  it("leaves bare arrows to Pi and uses explicit Shift+Down to drill the selected row", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("workflow-agent:run:reviewer:a:phase", "first workflow row");
    const second = row("workflow-agent:run:reviewer:b:phase", "second workflow row");
    fleetMenuState.setVisibleRows(selectFleetMenuRows([...agentLiveStore.rows.values()]));
    h.customInputQueue.push("down", "enter", "q");

    expect(h.shortcuts.has(FLEET_FOCUS_FALLBACK_SHORTCUT)).toBe(true);
    expect(h.shortcuts.has("super+down")).toBe(false);
    expect(h.shortcuts.has("ctrl+down")).toBe(false);

    const down = [...h.terminalInputHandlers].map((handler) => handler("down"));
    const up = [...h.terminalInputHandlers].map((handler) => handler("up"));
    expect(down.every((result) => result === undefined)).toBe(true);
    expect(up.every((result) => result === undefined)).toBe(true);
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    await vi.waitFor(() => expect(h.customOptions).toEqual([{ overlay: false }, { overlay: false }]));

    expect(h.customRenderFrames.at(-1)?.[0]).toContain(second.displayName);
    expect(fleetMenuState.focused).toBe(false);
  });

  it("leaves Up and Down to Pi even when the editor is empty and fleet rows are visible", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("editor-guard-row", "do not steal arrows");

    fleetMenuState.setVisibleRows(selectFleetMenuRows([...agentLiveStore.rows.values()]));
    const up = [...h.terminalInputHandlers].map((handler) => handler("up"));
    expect(up.every((result) => result === undefined)).toBe(true);

    const down = [...h.terminalInputHandlers].map((handler) => handler("down"));
    expect(down.every((result) => result === undefined)).toBe(true);
    expect(h.customComponents).toHaveLength(0);
  });

  it("focuses the existing below-editor roster while the custom component captures keys without a duplicate", () => {
    const active = row("screen-order-row", "prove screen order");
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    installWorkflowProgress(h.ctx, "fleet-order", "screen-order", "run");
    const factory = h.widgetPayloads.get("fleet-order") as (
      tui: { requestRender(): void; terminal: { rows: number; columns: number } },
      theme: unknown,
    ) => WorkflowProgressComponent;
    const widget = factory({ requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } }, {});
    fleetMenuState.setVisibleRows([active]);
    fleetMenuState.setFocused(true);
    const keyCapture = new FleetFocusComponent(() => [active], {}, { requestRender: vi.fn() }, vi.fn());

    const keyCaptureFrame = keyCapture.render(120);
    const focusedRoster = widget.render(120);

    expect(h.widgetOptions.get("fleet-order")).toEqual({ placement: "belowEditor" });
    expect(keyCaptureFrame).toEqual([]);
    expect(focusedRoster.join("\n")).toContain("prove screen order");
    expect(focusedRoster.some((line) => line.startsWith("> "))).toBe(true);
    expect(focusedRoster.at(-1)).toContain("stop");
    expect(focusedRoster.at(-1)).toContain("back");
    keyCapture.dispose();
    widget.dispose();
  });

  it("projects the global /ps snapshot through the primary workflow panel when ordinary rows coexist", () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    const ordinary = row("ordinary-agent-row", "ordinary agent work");
    const workflowPanel = installWorkflowProgress(h.ctx, "workflow-coexistence", "review", "coexist-run", {
      scope: "workflow",
      declaredStages: [{ title: "review" }],
    });
    const workflowLine: WorkflowJournalLine = {
      ts: "2026-07-22T00:00:00.000Z",
      runId: "coexist-run",
      kind: "agent_start",
      agent: "reviewer",
      label: "workflow agent work",
      phase: "review",
    };
    applyWorkflowJournalLineToAgentLiveStore(workflowLine);
    workflowPanel.push(workflowLine);
    const workflowRow = agentLiveStore.rows.get(workflowAgentLiveRowId(workflowLine));
    if (workflowRow === undefined) throw new Error("expected projected workflow row");
    if (workflowRow.displayName === undefined) throw new Error("expected workflow petname");
    const workflowChild = agentLiveStore.begin({
      id: "workflow-coexistence-sdk-child",
      parentRowId: workflowRow.id,
      agentName: "reviewer",
      label: "SDK child session",
      workflowRunId: workflowLine.runId,
    });
    agentLiveStore.patch(workflowChild.id, { status: "working" });
    const factory = h.widgetPayloads.get("workflow-coexistence") as (
      tui: { requestRender(): void; terminal: { rows: number; columns: number } },
      theme: unknown,
    ) => WorkflowProgressComponent;
    const widget = factory({ requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } }, {});
    fleetMenuState.beginFocus([...agentLiveStore.rows.values()]);
    fleetMenuState.setFocused(true);
    const keyCapture = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );
    const focused = widget.render(120).join("\n");
    expect(focused).toContain(ordinary.displayName);
    expect(focused).toContain(workflowRow.displayName);
    expect(focused).toContain("SDK child session");
    expect(focused).not.toContain("workflow agent work");
    expect(focused.match(new RegExp(workflowRow.displayName, "gu"))).toHaveLength(1);
    expect(keyCapture.render(120)).toEqual([]);
    keyCapture.dispose();
    fleetMenuState.setFocused(false);
    fleetMenuState.setVisibleRows([]);
    workflowPanel.dispose();
  });

  it("freezes focused membership and traverses every leaf through an eight-row viewport", () => {
    const rows = Array.from({ length: 11 }, (_unused, index) => row(`snapshot-${index}`, `snapshot task ${index}`));
    fleetMenuState.beginFocus(rows);
    fleetMenuState.setFocused(true);
    const component = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );

    const arrival = row("snapshot-arrival", "arrived after open");
    for (let index = 1; index < rows.length; index += 1) component.handleInput("down");

    expect(fleetMenuState.selectedRowId).toBe(rows.at(-1)?.id);
    expect(fleetMenuState.visibleRows()).not.toContainEqual(expect.objectContaining({ id: arrival.id }));
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("snapshot task 10");
    expect(rendered).toMatch(/↑ \d+ earlier/u);
    expect(rendered).not.toContain("arrived after open");
    component.dispose();
  });

  it("keeps the selected row and controls visible in a standard 24-row terminal", () => {
    const rows = Array.from({ length: 10 }, (_unused, index) => {
      const value = row(`compact-focus-${index}`, `compact task ${index}`, "done");
      return agentLiveStore.patch(value.id, { finalAnswer: `compact result ${index}` })!;
    });
    const h = createHarness();
    h.ctx.hasUI = true;
    const panel = installWorkflowProgress(h.ctx, "compact-focused-fleet", "compact", "run");
    const factory = h.widgetPayloads.get("compact-focused-fleet") as (
      tui: { requestRender(): void; terminal: { rows: number; columns: number } },
      theme: unknown,
    ) => WorkflowProgressComponent;
    const widget = factory({ requestRender: vi.fn(), terminal: { rows: 24, columns: 120 } }, {});
    fleetMenuState.beginFocus(rows);
    fleetMenuState.setFocused(true);

    const rendered = widget.render(120);

    expect(rendered.length).toBeLessThanOrEqual(18);
    expect(rendered.some((line) => line.startsWith("> "))).toBe(true);
    expect(rendered.at(-1)).toContain("back");
    panel.dispose();
  });

  it("routes x through a stop request instead of cancelling immediately, while Esc only returns", () => {
    const active = row("cancel-row", "stop this child");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    fleetMenuState.setVisibleRows([active]);
    fleetMenuState.setFocused(true);
    const done = vi.fn();
    const component = new FleetFocusComponent(() => [active], {}, { requestRender: vi.fn() }, done);

    component.handleInput("x");
    component.handleInput("escape");

    expect(cancel).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith({ kind: "stop", rowId: active.id });
    expect(done).toHaveBeenCalledWith({ kind: "close" });
    component.dispose();
  });

  it("keeps workflow rows inspectable but removes the competing x stop path", () => {
    const workflowLine: WorkflowJournalLine = {
      ts: "t",
      runId: "workflow-command-owned",
      kind: "agent_start",
      agent: "reviewer",
      label: "workflow child",
    };
    applyWorkflowJournalLineToAgentLiveStore(workflowLine);
    const workflowRow = agentLiveStore.rows.get(workflowAgentLiveRowId(workflowLine));
    expect(workflowRow).toMatchObject({ status: "working", workflowRunId: "workflow-command-owned" });
    if (workflowRow === undefined) throw new Error("expected workflow row");
    const done = vi.fn();
    fleetMenuState.setVisibleRows([workflowRow]);
    const rendered = renderFleetMenuRows([workflowRow], 120, {
      focused: true,
      selectedRowId: workflowRow.id,
    });
    const component = new FleetFocusComponent(() => [workflowRow], {}, { requestRender: vi.fn() }, done);

    component.handleInput("x");

    expect(rendered.at(-1)).not.toContain("stop");
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "stop" }));
    component.dispose();
  });

  it("cancels a selected child only after the operator confirms the x stop request", async () => {
    const active = row("confirmed-stop-row", "confirm this stop");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    h.confirmQueue.push(false);
    h.customInputQueue.push("x");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(cancel).not.toHaveBeenCalled();
    expect(h.notifications).toContain("Agent continues running.");

    h.confirmQueue.push(true);
    h.customInputQueue.push("x");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.notifications).toContain("Agent cancellation requested.");
  });

  it("does not cancel a same-id replacement registered while stop confirmation is pending", async () => {
    const original = row("confirm-authority-row", "original execution");
    const originalCancel = vi.fn();
    agentLiveStore.registerCancel(original.id, originalCancel);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    let resolveConfirm!: (confirmed: boolean) => void;
    const pendingConfirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    h.ctx.ui.confirm = vi.fn(async () => pendingConfirm);
    h.customInputQueue.push("x");

    const stopping = h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.confirm).toHaveBeenCalledOnce());
    const replacement = agentLiveStore.begin({
      id: original.id,
      agentName: "reviewer",
      label: "replacement execution",
      title: "replacement execution",
    });
    agentLiveStore.patch(replacement.id, { status: "working" });
    const replacementCancel = vi.fn();
    agentLiveStore.registerCancel(replacement.id, replacementCancel);
    resolveConfirm(true);
    await stopping;

    expect(originalCancel).not.toHaveBeenCalled();
    expect(replacementCancel).not.toHaveBeenCalled();
    expect(h.notifications).toContain(`Agent ${replacement.id} is no longer stoppable.`);

    h.ctx.ui.confirm = vi.fn(async () => true);
    h.customInputQueue.push("x");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(replacementCancel).toHaveBeenCalledOnce();
    expect(h.notifications).toContain("Agent cancellation requested.");
  });

  it("does not invoke a still-registered cancel seam after the row becomes terminal during confirmation", async () => {
    const active = row("terminal-during-confirm", "finishing execution");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    let resolveConfirm!: (confirmed: boolean) => void;
    const pendingConfirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    h.ctx.ui.confirm = vi.fn(async () => pendingConfirm);
    h.customInputQueue.push("x");

    const stopping = h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.confirm).toHaveBeenCalledOnce());
    agentLiveStore.patch(active.id, { status: "done" });
    resolveConfirm(true);
    await stopping;

    expect(cancel).not.toHaveBeenCalled();
    expect(h.notifications).toContain(`Agent ${active.id} is no longer stoppable.`);
  });

  it("asks before global Escape aborts an active parent agent operation", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("escape-guard-row", "guard this child");

    h.confirmQueue.push(false);
    const first = [...h.terminalInputHandlers].map((handler) => handler("\u001b"));
    await vi.waitFor(() => expect(h.confirmCalls).toHaveLength(1));
    expect(first).toContainEqual({ consume: true });
    expect(h.abortCalls).toBe(0);
    expect(h.notifications).toContain("Agent operation continues.");

    h.confirmQueue.push(true);
    const second = [...h.terminalInputHandlers].map((handler) => handler("escape"));
    await vi.waitFor(() => expect(h.abortCalls).toBe(1));
    expect(second).toContainEqual({ consume: true });
    expect(h.notifications).toContain("Agent cancellation requested.");
  });

  it("consumes global Escape without aborting or confirming while a workflow row is active", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    applyWorkflowJournalLineToAgentLiveStore({
      ts: "t",
      runId: "escape-workflow",
      kind: "agent_start",
      agent: "reviewer",
      label: "workflow child",
    });

    const results = [...h.terminalInputHandlers].map((handler) => handler("\u001b"));

    expect(results).toContainEqual({ consume: true });
    expect(h.abortCalls).toBe(0);
    expect(h.confirmCalls).toEqual([]);
  });

  it("consumes global Escape while a tool workflow is active before its first live row", async () => {
    const sessionId = "escape-pending-workflow";
    const h = createHarness(process.cwd(), { isStreaming: true, sessionId });
    h.ctx.hasUI = true;
    const registry = workflowBackgroundRunRegistry();
    const lease = registry.startSession(process.cwd(), sessionId);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const launched = registry.attach(lease, new AbortController().signal, async () => pending);
    expect(launched.ok).toBe(true);
    agents(h.pi);
    await emit(h, "session_start");

    const results = [...h.terminalInputHandlers].map((handler) => handler("\u001b"));

    expect(results).toContainEqual({ consume: true });
    expect(h.abortCalls).toBe(0);
    expect(h.confirmCalls).toEqual([]);

    settle();
    if (launched.ok) await launched.run.terminal;
    registry.shutdown(lease);
  });

  it("removes the stop affordance and ignores x for a cancelled terminal row", () => {
    const terminal = row("cancelled-row", "cancelled child", "cancelled");
    const staleCancel = vi.fn();
    agentLiveStore.registerCancel(terminal.id, staleCancel);
    fleetMenuState.setVisibleRows([terminal]);
    fleetMenuState.setFocused(true);

    const rendered = renderFleetMenuRows([terminal], 120, { focused: true, selectedRowId: terminal.id });
    const component = new FleetFocusComponent(() => [terminal], {}, { requestRender: vi.fn() }, vi.fn());
    component.handleInput("x");

    expect(rendered.at(-1)).not.toContain("stop");
    expect(rendered.join("\n")).toContain("⊘");
    expect(staleCancel).not.toHaveBeenCalled();
    component.dispose();
  });

  it("renders aggregate rows but skips them for cursor, Enter, and x", () => {
    const group = agentLiveStore.begin({
      id: "workflow:run:group:parallel-1",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      groupTotal: 2,
    });
    const firstRow = agentLiveStore.begin({
      id: "parallel-child-1",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "first child",
    });
    const secondRow = agentLiveStore.begin({
      id: "parallel-child-2",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "second child",
    });
    const first = agentLiveStore.patch(firstRow.id, { status: "working" })!;
    const second = agentLiveStore.patch(secondRow.id, { status: "working" })!;
    const rows = selectFleetMenuRows([group, first, second]);
    fleetMenuState.setVisibleRows(rows);
    fleetMenuState.setFocused(true);
    const done = vi.fn();
    const tui = { requestRender: vi.fn() };
    const component = new FleetFocusComponent(() => rows, {}, tui, done);

    expect(
      renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: fleetMenuState.selectedRowId! }).join("\n"),
    ).toContain("parallel (2)");
    expect(
      renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: group.id }).some((line) => line.startsWith("> ")),
    ).toBe(false);
    expect(fleetMenuState.selectedRowId).toBe(first.id);
    component.handleInput("down");
    expect(fleetMenuState.selectedRowId).toBe(second.id);
    component.handleInput("enter");
    component.handleInput("x");

    expect(done).toHaveBeenCalledWith({ kind: "drill", rowId: second.id });
    expect(done).toHaveBeenCalledWith({ kind: "stop", rowId: second.id });
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ rowId: group.id }));
    component.dispose();
  });

  it("shows the group heading in /ps and still reaches every leaf with the cursor", () => {
    // A running fan-out: eight items, one of them failed. `/ps` gets the group
    // heading and the working-first order from the shared projection, and — unlike
    // the passive progress panel — collapses nothing, so all eight stay reachable.
    const group = agentLiveStore.begin({
      id: "workflow:ps-fan:group:parallel-8",
      agentName: "workflow-group",
      label: "parallel (8)",
      groupKind: "parallel",
      groupTotal: 8,
      workflowRunId: "ps-fan",
    });
    // The counters are deliberately AHEAD of the leaves: two done and two failed
    // on the group row against one done and one failed leaf. `1/8 done` would
    // mean the heading was recomputed from the visible members, so `2/8 done`
    // is the only reading that proves it comes from the group row itself.
    agentLiveStore.patch(group.id, { status: "working", groupCompleted: 2, groupFailed: 2 });
    const members = Array.from({ length: 8 }, (_unused, index) => {
      const member = agentLiveStore.begin({
        id: `ps-fan-item-${index}`,
        parentRowId: group.id,
        agentName: "worker",
        label: `ps item ${index} of 8`,
        title: `ps item ${index} of 8`,
        workflowRunId: "ps-fan",
      });
      const status: AgentLiveStatus = index === 3 ? "error" : index === 5 ? "done" : "working";
      return agentLiveStore.patch(member.id, { status })!;
    });

    fleetMenuState.beginFocus([...agentLiveStore.rows.values()]);
    fleetMenuState.setFocused(true);
    const component = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );

    // The heading is part of the `/ps` row set, with the counters the group row
    // carries — not recomputed from the leaves (one done leaf, one failed leaf).
    const passive = renderFleetMenuRows([...agentLiveStore.rows.values()], 120, {}).join("\n");
    expect(passive).toContain("parallel (8)");
    expect(passive).toContain("2/8 done");
    expect(passive).toContain("2 failed");

    const visited = new Set<string>([fleetMenuState.selectedRowId!]);
    for (let step = 0; step < members.length; step += 1) {
      component.handleInput("down");
      visited.add(fleetMenuState.selectedRowId!);
      component.render(120);
    }
    expect([...visited].sort()).toEqual(members.map((member) => member.id).sort());
    // Up walks back over the same leaves; the heading is never selected.
    for (let step = 0; step < members.length; step += 1) {
      component.handleInput("up");
      expect(fleetMenuState.selectedRowId).not.toBe(group.id);
      visited.add(fleetMenuState.selectedRowId!);
    }
    expect(visited.size).toBe(members.length);

    // Working members first, the failed one next, the finished one last — and
    // nothing is collapsed away the way the passive progress panel collapses it.
    const focusedFrame = component.render(120);
    const at = (needle: string) => focusedFrame.findIndex((frameLine) => frameLine.includes(needle));
    expect(at("ps item 0 of 8")).toBeLessThan(at("ps item 3 of 8"));
    expect(at("ps item 3 of 8")).toBeLessThan(at("ps item 5 of 8"));
    expect(focusedFrame.join("\n")).not.toMatch(/earlier agents/u);
    component.dispose();
  });

  it("re-parents a leaf onto the nearest surviving ancestor when two nested groups are both too small", () => {
    // A group of one gets no heading and is dropped from the projection. When the
    // dropped group sits inside ANOTHER dropped group, handing its child the
    // grandparent's id names a row nobody holds any more: the leaf silently
    // detaches and renders as a root, after the next real root instead of under
    // the phase it belongs to.
    const phase = agentLiveStore.begin({ id: "nested-phase", agentName: "workflow", label: "phase anchor" });
    const outer = agentLiveStore.begin({
      id: "nested-outer",
      parentRowId: phase.id,
      agentName: "workflow-group",
      label: "pipeline (1)",
      groupKind: "pipeline",
      groupTotal: 1,
    });
    const inner = agentLiveStore.begin({
      id: "nested-inner",
      parentRowId: outer.id,
      agentName: "workflow-group",
      label: "parallel (1)",
      groupKind: "parallel",
      groupTotal: 1,
    });
    const leaf = agentLiveStore.begin({
      id: "nested-leaf",
      parentRowId: inner.id,
      agentName: "worker",
      label: "the only item",
    });
    // A second child of the phase, started after the group: it is where the
    // detached leaf ends up in front of, or behind, depending on whether the leaf
    // is still attached to the phase.
    const sibling = agentLiveStore.begin({
      id: "nested-sibling",
      parentRowId: phase.id,
      agentName: "worker",
      label: "sibling item",
    });

    expect(orderAgentLiveRows([phase, outer, inner, leaf, sibling]).map((row) => row.id)).toEqual([
      phase.id,
      leaf.id,
      sibling.id,
    ]);
  });

  it("keeps the group heading on screen in /ps while the fan-out fits the viewport", () => {
    // The heading is rendered by the focused selector too, straight from the
    // shared projection while the whole group fits the viewport. A fan-out that
    // does NOT fit is the next test: there the heading is pinned back on.
    const group = agentLiveStore.begin({
      id: "workflow:ps-small:group:parallel-3",
      agentName: "workflow-group",
      label: "parallel (3)",
      groupKind: "parallel",
      groupTotal: 3,
      workflowRunId: "ps-small",
    });
    agentLiveStore.patch(group.id, { status: "working", groupCompleted: 1, groupFailed: 1 });
    for (let index = 0; index < 3; index += 1) {
      const member = agentLiveStore.begin({
        id: `ps-small-item-${index}`,
        parentRowId: group.id,
        agentName: "worker",
        label: `small item ${index}`,
        title: `small item ${index}`,
        workflowRunId: "ps-small",
      });
      agentLiveStore.patch(member.id, { status: index === 1 ? "error" : "working" });
    }
    fleetMenuState.beginFocus([...agentLiveStore.rows.values()]);
    fleetMenuState.setFocused(true);
    const component = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );

    const rendered = component.render(120);
    expect(rendered.join("\n")).toContain("parallel (3)");
    expect(rendered.join("\n")).toContain("1/3 done");
    expect(rendered.some((frameLine) => frameLine.startsWith("> "))).toBe(true);
    // The heading itself is never the selected row.
    expect(rendered.find((frameLine) => frameLine.startsWith("> "))).not.toContain("parallel (3)");
    component.dispose();
  });

  it("pins the group heading in /ps when the fan-out is longer than the viewport", () => {
    // Nine leaves against an eight-row viewport. The window is anchored on the
    // cursor and only leaves take the cursor, so the heading — the row that says
    // WHICH fan-out these `↳` rows belong to and how it is going — scrolled off
    // the top and no key could bring it back: `/ps` showed a wall of members
    // under nothing. It is pinned above the window instead, and pinning it costs
    // no member row.
    //
    // The rows are built the way a live fan-out builds them — group, a workflow
    // journal ANCHOR per branch, and the SDK child under each anchor — because
    // that anchor layer is the whole difficulty: `/ps` freezes its membership and
    // re-projects it every frame, and a frozen set that lost its anchors cannot
    // re-parent the children onto the group. A flat group→member set passes
    // whether the pin works on the live surface or not.
    const { group, members } = liveFanOut({ runId: "ps-long", label: "long item", size: 9 });

    fleetMenuState.beginFocus([...agentLiveStore.rows.values()]);
    fleetMenuState.setFocused(true);
    const component = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );

    // The heading is on screen wherever the cursor stands, including the top of
    // the list and the bottom of it, and it counts the members the operator can
    // see: three done, one failed, while the group itself is still running.
    const visited = new Set<string>([fleetMenuState.selectedRowId!]);
    for (let step = 0; step < members.length + 2; step += 1) {
      const frame = component.render(120).join("\n");
      expect(frame).toContain("parallel (9)");
      expect(frame).toContain("3/9 done");
      expect(frame).toContain("1 failed");
      component.handleInput("down");
      visited.add(fleetMenuState.selectedRowId!);
    }
    for (let step = 0; step < members.length + 2; step += 1) {
      component.handleInput("up");
      expect(component.render(120).join("\n")).toContain("parallel (9)");
      visited.add(fleetMenuState.selectedRowId!);
      expect(fleetMenuState.selectedRowId).not.toBe(group.id);
    }
    // Every leaf is still reachable, and the heading is never selected.
    expect([...visited].sort()).toEqual(members.map((member) => member.id).sort());

    // The selected row is inside the window the heading was pinned onto: the
    // heading is extra chrome, not a member row given up to make room.
    const frame = component.render(120);
    expect(frame.find((frameLine) => frameLine.startsWith("> "))).toBeDefined();
    expect(frame.find((frameLine) => frameLine.startsWith("> "))).not.toContain("parallel (9)");
    expect(frame.filter((frameLine) => frameLine.includes("long item"))).toHaveLength(8);
    component.dispose();
  });

  it("counts the /ps group heading off the live anchor-backed members while the fan-out runs", () => {
    // A fan-out that is still running has stated no counters of its own — the
    // journal writes them at `group_end` — so the heading is summed from its
    // member rows. Those members are the group's members only after the anchor
    // collapse, and `/ps` keeps its own frozen row set: the heading would sit
    // over rows it cannot count and read `0/6 done` next to ✓ and ✗ members.
    const { group, members } = liveFanOut({
      runId: "ps-counters",
      label: "counted item",
      size: 6,
      status: () => "working",
    });
    expect(group.groupCompleted).toBeUndefined();

    fleetMenuState.beginFocus([...agentLiveStore.rows.values()]);
    fleetMenuState.setFocused(true);
    const component = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );
    expect(component.render(120).join("\n")).toContain("0/6 done");

    // Members settle under the open menu; the heading follows them.
    agentLiveStore.patch(members[0]!.id, { status: "error" });
    agentLiveStore.patch(members[1]!.id, { status: "done" });
    agentLiveStore.patch(members[2]!.id, { status: "done" });

    const frame = component.render(120).join("\n");
    expect(frame).toContain("2/6 done");
    expect(frame).toContain("1 failed");
    component.dispose();
  });

  it("re-ranks the live anchor-backed group members in /ps as they settle under the open menu", () => {
    // Working → failed → queued → done is a fact about the group's children, so
    // it needs the same anchor collapse the heading does. The menu freezes WHICH
    // rows it owns, never the order they project into: a member that fails while
    // `/ps` is open has to rise, and one that finishes has to fall.
    const { members } = liveFanOut({
      runId: "ps-order",
      label: "ranked item",
      size: 4,
      status: () => "working",
    });
    fleetMenuState.beginFocus([...agentLiveStore.rows.values()]);
    fleetMenuState.setFocused(true);
    const component = new FleetFocusComponent(
      () => [...agentLiveStore.rows.values()],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );
    const positionsOf = (frame: string[]) => (needle: string) =>
      frame.findIndex((frameLine) => frameLine.includes(needle));

    const opened = positionsOf(component.render(120));
    expect(opened("ranked item 0 of 4")).toBeLessThan(opened("ranked item 1 of 4"));

    agentLiveStore.patch(members[0]!.id, { status: "done" });
    agentLiveStore.patch(members[1]!.id, { status: "error" });

    const at = positionsOf(component.render(120));
    expect(at("ranked item 2 of 4")).toBeLessThan(at("ranked item 1 of 4"));
    expect(at("ranked item 1 of 4")).toBeLessThan(at("ranked item 0 of 4"));
    // Reordering moves rows, not the cursor: it stays on the row the operator
    // put it on, which has just travelled to the bottom of the group.
    expect(fleetMenuState.selectedRowId).toBe(members[0]!.id);
    expect(members.every((member) => at(member.title!) >= 0)).toBe(true);
    component.dispose();
  });

  it("repaints from live mutations, normalizes a removed cursor, and unsubscribes idempotently", () => {
    const first = row("live-focus-a", "first live row");
    const second = row("live-focus-b", "second live row");
    const requestRender = vi.fn();
    const before = agentLiveStore.emitter.listenerCount("change");
    const done = vi.fn();
    const component = new FleetFocusComponent(() => [...agentLiveStore.rows.values()], {}, { requestRender }, done);

    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);
    component.render(120);
    expect(fleetMenuState.selectedRowId).toBe(first.id);
    requestRender.mockClear();

    agentLiveStore.removeRows([first.id]);
    expect(requestRender).toHaveBeenCalledTimes(1);
    const rendered = component.render(120).join("\n");
    expect(fleetMenuState.selectedRowId).toBe(second.id);
    expect(rendered).toContain("second live row");
    expect(rendered).not.toContain("first live row");

    component.dispose();
    component.dispose();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    requestRender.mockClear();
    agentLiveStore.patch(second.id, { label: "mutated after close" });
    expect(requestRender).not.toHaveBeenCalled();
    const selectedAfterDispose = fleetMenuState.selectedRowId;
    expect(component.render(120)).toEqual([]);
    component.handleInput("down");
    component.handleInput("enter");
    component.handleInput("x");
    component.handleInput("escape");
    component.invalidate();
    expect(fleetMenuState.selectedRowId).toBe(selectedAfterDispose);
    expect(done).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("coalesces a live-mutation storm and drops the trailing repaint on dispose", () => {
    // The focused /ps selector subscribes to the live store, which emits once
    // per SDK event. Unthrottled that is the render storm that flickers on WSL.
    vi.useFakeTimers();
    try {
      const target = row("storm-a", "storm row");
      const requestRender = vi.fn();
      const component = new FleetFocusComponent(
        () => [...agentLiveStore.rows.values()],
        {},
        { requestRender },
        vi.fn(),
      );
      component.render(120);
      requestRender.mockClear();

      for (let i = 0; i < 50; i += 1) agentLiveStore.patch(target.id, { title: `mutation ${i}` });

      // One leading repaint; the other 49 fold into a single trailing one.
      expect(requestRender).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      expect(requestRender).toHaveBeenCalledTimes(2);

      // Newest state still reaches the screen.
      expect(component.render(120).join("\n")).toContain("mutation 49");

      // A pending trailing repaint must not outlive the component.
      agentLiveStore.patch(target.id, { title: "after close" });
      requestRender.mockClear();
      component.dispose();
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
      expect(requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never repaints for store churn that changes nothing visible", () => {
    // On a console where every repaint blinks (WSL), the guarantee the operator
    // needs is byte-identity: a frame equal to what is on screen must not reach
    // the terminal at all — not even as a throttled leading render.
    vi.useFakeTimers();
    try {
      const target = row("quiet-a", "quiet row");
      const requestRender = vi.fn();
      const component = new FleetFocusComponent(
        () => [...agentLiveStore.rows.values()],
        {},
        { requestRender },
        vi.fn(),
      );
      component.render(120);
      requestRender.mockClear();

      // eventLines feed the observer digest, not the fleet row — invisible here.
      agentLiveStore.patch(target.id, { eventLines: ["tool bash started"] });
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
      expect(requestRender).not.toHaveBeenCalled();

      // A visible change still paints immediately.
      agentLiveStore.patch(target.id, { title: "now different" });
      expect(requestRender).toHaveBeenCalledTimes(1);

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cursor movement on the immediate render path", () => {
    // Keystrokes are already human-rate-limited; throttling them would add
    // latency exactly where it is most visible.
    vi.useFakeTimers();
    try {
      row("cursor-a", "cursor row a");
      row("cursor-b", "cursor row b");
      const requestRender = vi.fn();
      const component = new FleetFocusComponent(
        () => [...agentLiveStore.rows.values()],
        {},
        { requestRender },
        vi.fn(),
      );
      component.render(120);
      requestRender.mockClear();

      component.handleInput("down");
      component.handleInput("up");
      component.handleInput("down");

      expect(requestRender).toHaveBeenCalledTimes(3);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stale menu result after reload even when the new session reuses the row id", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("reused-row", "old session row");
    const oldRequestRender = vi.fn();
    let oldComponent: CustomUiComponent | undefined;
    let resolveOld!: (value: unknown) => void;
    let oldFactoryDone = false;
    const oldResult = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      oldComponent = await factory({ requestRender: oldRequestRender }, {}, {}, (value) => {
        oldFactoryDone = true;
        resolveOld(value);
      });
      oldComponent.render(120);
      return oldResult as Promise<T>;
    };
    const oldMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(oldComponent).toBeDefined());

    await emit(h, "session_start");
    const reused = row("reused-row", "new session row");
    row("new-session-second", "new session second row");
    const newCancel = vi.fn();
    agentLiveStore.registerCancel(reused.id, newCancel);
    const newRequestRender = vi.fn();
    let newComponent: CustomUiComponent | undefined;
    let resolveNew!: (value: unknown) => void;
    const newResult = new Promise<unknown>((resolve) => {
      resolveNew = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      newComponent = await factory({ requestRender: newRequestRender }, {}, {}, (value) => resolveNew(value));
      newComponent.render(120);
      return newResult as Promise<T>;
    };
    const newMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(newComponent).toBeDefined());
    expect(fleetMenuState.focused).toBe(true);
    expect(fleetMenuState.selectedRowId).toBe(reused.id);
    const notificationsBeforeStaleResult = [...h.notifications];
    oldRequestRender.mockClear();
    newRequestRender.mockClear();

    expect(oldComponent?.render(120)).toEqual([]);
    // The session reset closed the old menu through its own `done` — that is what
    // hands Pi's editor slot back and lets the awaiting `/ps` handler return.
    // Its later input stays inert either way: the component is disposed, and the
    // ownership epoch stops any result from acting on the new session.
    expect(oldFactoryDone).toBe(true);
    oldComponent?.handleInput?.("down");
    oldComponent?.handleInput?.("enter");
    oldComponent?.handleInput?.("x");
    oldComponent?.handleInput?.("escape");
    expect(oldRequestRender).not.toHaveBeenCalled();
    expect(newRequestRender).not.toHaveBeenCalled();
    expect(fleetMenuState.selectedRowId).toBe(reused.id);

    resolveOld({ kind: "stop", rowId: reused.id });
    await oldMenu;
    expect(newCancel).not.toHaveBeenCalled();
    expect(h.notifications).toEqual(notificationsBeforeStaleResult);
    expect(fleetMenuState.focused).toBe(true);
    expect(fleetMenuState.selectedRowId).toBe(reused.id);

    resolveNew({ kind: "stop", rowId: reused.id });
    await newMenu;
    expect(newCancel).toHaveBeenCalledTimes(1);
    expect(h.notifications).toContain("Agent cancellation requested.");
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
  });

  it("disposes open focused selectors before session reset and shutdown without carrying their cursor", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    const oldFirst = row("old-session-a", "old first row");
    row("old-session-b", "old second row");
    const before = agentLiveStore.emitter.listenerCount("change");
    const discardedRequestRender = vi.fn();
    const oldRequestRender = vi.fn();
    let oldComponent: CustomUiComponent | undefined;
    let resolveOld!: (value: unknown) => void;
    const oldResult = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      await factory({ requestRender: discardedRequestRender }, {}, {}, (value) => resolveOld(value));
      oldComponent = await factory({ requestRender: oldRequestRender }, {}, {}, (value) => resolveOld(value));
      oldComponent.render(120);
      return oldResult as Promise<T>;
    };

    const oldMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(oldComponent).toBeDefined());
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);
    expect(fleetMenuState.focused).toBe(true);
    expect(fleetMenuState.selectedRowId).toBe(oldFirst.id);
    // Patch the rendered title (label is shadowed by it and would be filtered
    // by the frame-identity gate as an invisible change).
    agentLiveStore.patch(oldFirst.id, { title: "old row mutated" });
    expect(oldRequestRender).toHaveBeenCalledTimes(1);
    expect(discardedRequestRender).not.toHaveBeenCalled();
    oldRequestRender.mockClear();

    await emit(h, "session_start");
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    expect(oldRequestRender).not.toHaveBeenCalled();
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
    resolveOld({ kind: "close" });
    await oldMenu;

    const newFirst = row("new-session-a", "new first row");
    const newSecond = row("new-session-b", "new second row");
    let newRendered: string[] = [];
    let selectedInNewSession: string | undefined;
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      let result: T | undefined;
      const component = await factory({ requestRender: vi.fn() }, {}, {}, (value) => {
        result = value;
      });
      newRendered = component.render(120);
      component.handleInput?.("down");
      selectedInNewSession = fleetMenuState.selectedRowId;
      component.handleInput?.("escape");
      return result as T;
    };
    await h.commands.get("ps")!.handler("", h.ctx);
    expect(newRendered.join("\n")).toContain(newFirst.displayName);
    expect(newRendered.join("\n")).toContain(newSecond.displayName);
    expect(selectedInNewSession).toBe(newSecond.id);
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);

    const shutdownRequestRender = vi.fn();
    let resolveShutdown!: (value: unknown) => void;
    const shutdownResult = new Promise<unknown>((resolve) => {
      resolveShutdown = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      const component = await factory({ requestRender: shutdownRequestRender }, {}, {}, (value) => {
        resolveShutdown(value);
      });
      component.render(120);
      return shutdownResult as Promise<T>;
    };
    const shutdownMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1));
    shutdownRequestRender.mockClear();
    await emit(h, "session_shutdown", { reason: "reload" });
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
    agentLiveStore.patch(newFirst.id, { label: "mutated after shutdown" });
    expect(shutdownRequestRender).not.toHaveBeenCalled();
    resolveShutdown({ kind: "close" });
    await shutdownMenu;
  });

  it("traverses group to journal anchor to transcript leaf for guidance, exact /ps tails, and last", async () => {
    const groupKey = "parallel-1";
    const start: WorkflowJournalLine = {
      ts: "2026-07-13T10:00:00.000Z",
      runId: "final-review",
      kind: "agent_start",
      agent: "reviewer",
      label: "review final repairs",
      phase: "verify",
      groupId: groupKey,
      groupKind: "parallel",
    };
    applyWorkflowJournalLineToAgentLiveStore({
      ts: start.ts,
      runId: start.runId,
      kind: "group_start",
      groupId: groupKey,
      groupKind: "parallel",
      groupTotal: 1,
    });
    applyWorkflowJournalLineToAgentLiveStore(start);
    const groupId = workflowGroupLiveRowId(start);
    const anchorId = workflowAgentLiveRowId(start);
    const childId = workflowAgentLiveChildRowId(start);
    const child = agentLiveStore.begin({
      id: childId,
      parentRowId: anchorId,
      agentName: "reviewer",
      label: "review final repairs",
    });
    agentLiveStore.feedSessionEvent(child.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Repairs verified" }], stopReason: "stop" },
    });
    agentLiveStore.patch(child.id, { status: "done" });
    expect(selectFleetMenuLeafRows([...agentLiveStore.rows.values()]).map((row) => row.id)).toEqual([child.id]);

    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    h.customInputQueue.push("escape");
    await h.commands.get("ps")!.handler("last", h.ctx);
    expect(h.customRenderFrames.at(-1)?.[0]).toContain(child.displayName);
    expect(h.customRenderFrames.at(-1)?.join("\n")).toContain("Repairs verified");

    await h.commands.get("ps")!.handler(groupId, h.ctx);
    expect(h.widgets.get("agents")).toContain("is a group summary; choose one child agent.");
    expect(h.widgets.get("agents")).toContain("Open /ps and select a child");
    expect(h.widgets.get("agents")).toContain(child.id);

    await h.commands.get("ps")!.handler(anchorId, h.ctx);
    expect(h.widgets.get("agents")).toContain("is a group summary; choose one child agent.");
    expect(h.widgets.get("agents")).toContain("Open /ps and select a child");
    expect(h.widgets.get("agents")).toContain(child.id);

    h.customInputQueue.push("escape");
    await h.commands.get("ps")!.handler(`  ${child.id}  `, h.ctx);
    expect(h.customRenderFrames.at(-1)?.[0]).toContain(child.displayName);
    expect(h.customRenderFrames.at(-1)?.join("\n")).toContain("Repairs verified");
  });

  it("resolves an active workflow row by petname and last", async () => {
    const workflow = row("workflow-agent:active:reviewer:verify:phase", "verify workflow output");
    const petname = workflow.displayName!;
    const byPetname = createHarness();
    byPetname.ctx.hasUI = true;
    byPetname.customInputQueue.push("q");
    agents(byPetname.pi);

    await byPetname.commands.get("agent")!.handler(`drill ${petname}`, byPetname.ctx);
    expect(byPetname.customRenderFrames[0]?.[0]).toContain(workflow.displayName);

    const byLast = createHarness();
    byLast.ctx.hasUI = true;
    byLast.customInputQueue.push("q");
    agents(byLast.pi);
    await byLast.commands.get("agent")!.handler("drill last", byLast.ctx);
    expect(byLast.customRenderFrames[0]?.[0]).toContain(workflow.displayName);
    expect(byLast.customRenderFrames[0]?.join("\n")).toContain("Agent is working; waiting for assistant output");
  });

  it("degrades to passive rows when custom UI is absent", async () => {
    const active = row("passive-row", "headless-safe");
    const h = createHarness();
    h.ctx.hasUI = false;
    delete h.ctx.ui.custom;
    agents(h.pi);

    await expect(h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx)).resolves.toBeUndefined();
    expect(renderFleetMenuRows([active], 80, { focusShortcutsAvailable: false }).join("\n")).toContain("headless-safe");
  });

  it("uses string-array passive widgets and honest focus/drill fallback in RPC mode", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    agents(h.pi);
    const panel = installWorkflowProgress(h.ctx, "rpc-fleet", "rpc-run", "run");
    const active = row("rpc-row", "rpc passive row");

    expect(Array.isArray(h.widgetPayloads.get("rpc-fleet"))).toBe(true);
    expect(h.widgets.get("rpc-fleet")).toContain("rpc passive row");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(h.widgets.get("agents")).toContain("unavailable in rpc mode");
    await h.commands.get("agent")!.handler(`drill ${active.id}`, h.ctx);
    expect(h.widgets.get("agents")).toContain("[WARN] Agent drill");
    expect(h.widgets.get("agents")).toContain("Interactive drill is unavailable in rpc mode.");
    expect(h.customOptions).toEqual([]);
    panel.dispose();
  });

  it("reopens /ps on the drilled row after Escape closes the agent screen", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    const first = row("drill-return-a", "first fleet row");
    const second = row("drill-return-b", "second fleet row");
    const customCallFrameStart: number[] = [];
    const baseCustom = h.ctx.ui.custom!;
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>, options?: { overlay?: boolean }): Promise<T> {
      customCallFrameStart.push(h.customRenderFrames.length);
      return baseCustom.call(h.ctx.ui, factory, options) as Promise<T>;
    };
    // fleet: down, enter → agent screen: escape → fleet again: escape.
    h.customInputQueue.push("down", "enter", "escape", "escape");

    await h.commands.get("ps")!.handler("", h.ctx);

    expect(customCallFrameStart).toHaveLength(3);
    const reopened = h.customRenderFrames[customCallFrameStart[2]!];
    // The cursor is on the row the operator drilled, not on the first working row.
    expect(reopened?.find((line) => line.startsWith("> "))).toContain(second.displayName!);
    // Membership is a fresh snapshot, so the rest of the fleet comes back too.
    expect(reopened?.join("\n")).toContain(first.displayName!);
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
  });

  it("reopens on the usual preferred row when the drilled row retires during the drill", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    const first = row("retire-return-a", "surviving fleet row");
    const second = row("retire-return-b", "retiring fleet row");
    const customCallFrameStart: number[] = [];
    const baseCustom = h.ctx.ui.custom!;
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>, options?: { overlay?: boolean }): Promise<T> {
      customCallFrameStart.push(h.customRenderFrames.length);
      const result = (await baseCustom.call(h.ctx.ui, factory, options)) as T;
      // The agent screen has just closed; its row is gone before the fleet reopens.
      if (customCallFrameStart.length === 2) agentLiveStore.removeRows([second.id]);
      return result;
    };
    h.customInputQueue.push("down", "enter", "escape", "escape");

    await expect(h.commands.get("ps")!.handler("", h.ctx)).resolves.toBeUndefined();

    expect(customCallFrameStart).toHaveLength(3);
    const reopened = h.customRenderFrames[customCallFrameStart[2]!];
    expect(reopened?.find((line) => line.startsWith("> "))).toContain(first.displayName!);
    expect(reopened?.join("\n")).not.toContain(second.displayName!);
  });

  it("returns to the editor without reopening /ps when q closes the agent screen", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    row("quit-return-a", "first quit row");
    row("quit-return-b", "second quit row");
    // fleet: down, enter → agent screen: q. `q` leaves the agent surface for the
    // editor, so no third surface opens and the queue is not exhausted.
    h.customInputQueue.push("down", "enter", "q");

    await h.commands.get("ps")!.handler("", h.ctx);

    expect(h.customOptions).toEqual([{ overlay: false }, { overlay: false }]);
    expect(h.customInputQueue).toHaveLength(0);
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
  });

  it("hands the editor back instead of reopening /ps when the drilled row retires under the screen", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    const only = row("vanish-return-a", "only fleet row");
    // The agent screen closes itself when its row goes away mid-drill. That close
    // is not a request for the fleet, and here reopening would also warn that /ps
    // found no live agent rows.
    h.customInputQueue.push("enter");
    const baseCustom = h.ctx.ui.custom!;
    let customCalls = 0;
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>, options?: { overlay?: boolean }): Promise<T> {
      customCalls += 1;
      if (customCalls === 2) queueMicrotask(() => agentLiveStore.removeRows([only.id]));
      return baseCustom.call(h.ctx.ui, factory, options) as Promise<T>;
    };

    await h.commands.get("ps")!.handler("", h.ctx);

    expect(customCalls).toBe(2);
    expect(h.notifications.some((message) => message.includes("found no live agent rows"))).toBe(false);
    expect(fleetMenuState.focused).toBe(false);
  });

  it("returns /ps <target> to the editor without opening the fleet", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    const target = row("direct-target-row", "direct drill target");
    h.customInputQueue.push("escape");

    await h.commands.get("ps")!.handler(target.id, h.ctx);

    // One surface only: the agent screen. A named target never came from the fleet.
    expect(h.customOptions).toHaveLength(1);
    expect(h.customRenderFrames.at(-1)?.[0]).toContain(target.displayName!);
    expect(fleetMenuState.focused).toBe(false);
  });

  it("does not reopen /ps when the session resets during the drill", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("epoch-return-a", "first epoch row");
    row("epoch-return-b", "second epoch row");
    let customCalls = 0;
    const baseCustom = h.ctx.ui.custom!;
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>, options?: { overlay?: boolean }): Promise<T> {
      customCalls += 1;
      const result = (await baseCustom.call(h.ctx.ui, factory, options)) as T;
      if (customCalls === 2) {
        // A reload while the agent screen was open: the menu it came from is gone,
        // and rows of the replacement session are not a reason to bring it back.
        await emit(h, "session_start");
        row("epoch-return-c", "row after reload");
      }
      return result;
    };
    // No third Escape: a reopened menu would exhaust the queue and throw.
    h.customInputQueue.push("down", "enter", "escape");

    await h.commands.get("ps")!.handler("", h.ctx);

    expect(customCalls).toBe(2);
    expect(h.customInputQueue).toHaveLength(0);
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
  });
});
