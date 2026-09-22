/**
 * Rendering and viewport: what the progress surface projects at a given width and
 * line budget — rail, roster, stage frontier, collapse and done lines. The layout
 * decisions under test belong to `operator/progress-render.ts`; they are exercised
 * through the component because that is the caller that composes them.
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WorkflowProgressComponent,
  renderAgentLiveRowsText,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { AgentLiveStatus } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { acquireFleetViewedRow, fleetMenuState } from "../../../../extensions/_shared/agent-runtime/fleet-menu.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveRowId,
} from "../../../../extensions/workflows/runtime/workflow-live.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  clearViewerExternalRows,
  viewerExternalRows,
} from "../../../../extensions/_shared/operator/viewer-geometry.js";

afterEach(() => clearViewerExternalRows("workflow-live"));

/** A workflow started by explicit path: 127 columns of `scriptRef`, shared by both header tests. */
const LONG_ABSOLUTE_REF =
  "/home/operator/projects/locus-pi-design-review/.locus-pi/workspaces/20260826-120000-a1b2-task-planning-x/implement-plan.workflow.mjs";

function line(input: Omit<WorkflowJournalLine, "ts"> & { ts: string | number }): WorkflowJournalLine {
  return input as WorkflowJournalLine;
}

function pushProgress(component: WorkflowProgressComponent, event: WorkflowJournalLine): void {
  applyWorkflowJournalLineToAgentLiveStore(event);
  component.push(event);
}

describe("workflow progress rendering and viewport", () => {
  it("keeps the source run agents visible when an operator answer starts a continuation", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 160 } };
    const sourceRunId = "20260817-150519-076c";
    const currentRunId = "20260817-151356-e575";

    applyWorkflowJournalLineToAgentLiveStore(
      line({
        kind: "agent_start",
        agent: "inspector",
        label: "inspect live Airflow planning evidence",
        ts: 1,
        runId: sourceRunId,
      }),
    );
    applyWorkflowJournalLineToAgentLiveStore(
      line({
        kind: "agent_start",
        agent: "router",
        label: "route planning readiness",
        ts: 2.1,
        runId: sourceRunId,
      }),
    );
    applyWorkflowJournalLineToAgentLiveStore(
      line({
        kind: "agent_end",
        agent: "router",
        label: "route planning readiness",
        status: "completed",
        durationMs: 8_000,
        ts: 2.2,
        runId: sourceRunId,
      }),
    );
    agentLiveStore.patch(
      workflowAgentLiveRowId(
        line({
          kind: "agent_start",
          agent: "inspector",
          label: "inspect live Airflow planning evidence",
          ts: 1,
          runId: sourceRunId,
        }),
      ),
      { tokenCount: { input: 5_000, output: 100 } },
    );
    applyWorkflowJournalLineToAgentLiveStore(
      line({
        kind: "agent_end",
        agent: "inspector",
        label: "inspect live Airflow planning evidence",
        status: "completed",
        durationMs: 77_000,
        ts: 2,
        runId: sourceRunId,
      }),
    );

    const component = new WorkflowProgressComponent(tui, {}, "airflow-dag-builder/plan", currentRunId, {
      scope: "workflow",
      continuationSourceRunId: sourceRunId,
      declaredStages: [{ title: "inspect" }, { title: "operator-gate" }, { title: "continue" }],
    });
    pushProgress(component, line({ kind: "phase", phase: "continue", ts: 3, runId: currentRunId }));
    pushProgress(
      component,
      line({
        kind: "agent_start",
        agent: "scope-writer",
        label: "apply the operator answer",
        ts: 4,
        runId: currentRunId,
      }),
    );

    const rendered = component.render(160).join("\n");
    expect(rendered).toContain("continues #076c");
    expect(rendered).toContain("previous run #076c");
    expect(rendered).toContain("inspect live Airflow planning evidence");
    expect(rendered).toContain("route planning readiness");
    expect(rendered).toContain("apply the operator answer");
    expect(rendered).toContain("stage 3/3 · continue");
    expect(rendered).toContain("0/1 done");
    expect(rendered).toContain("tok —");
    // Two stages are still declared and unreached (`inspect`, `operator-gate`);
    // they share ONE line naming the next one and counting the rest (T-192 W1).
    expect(rendered).toContain("○ next: inspect (+1 planned)");
    expect(rendered).not.toContain("○ operator-gate");

    // One line tighter than before: collapsing the pending stages gave the roster
    // a line back, so the clamp starts one row later than it used to.
    tui.terminal.rows = 11;
    const constrained = component.render(160).join("\n");
    expect(constrained).toContain("(+2 earlier agents)");
    expect(constrained).not.toContain("previous run #076c");
    expect(constrained).not.toContain("inspect live Airflow planning evidence");
    expect(constrained).not.toContain("route planning readiness");
    expect(constrained).toContain("apply the operator answer");

    component.dispose();
    agentLiveStore.reset();
  });

  it("shows an explicit source-history fallback when retained continuation rows are unavailable", () => {
    agentLiveStore.reset();
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 140 } };
    const component = new WorkflowProgressComponent(tui, {}, "airflow-dag-builder/plan", "current-run", {
      scope: "workflow",
      continuationSourceRunId: "20260817-150519-076c",
      declaredStages: [{ title: "continue" }],
    });
    pushProgress(component, line({ kind: "phase", phase: "continue", ts: 1, runId: "current-run" }));
    pushProgress(
      component,
      line({
        kind: "agent_start",
        agent: "writer",
        label: "continue current work",
        ts: 2,
        runId: "current-run",
      }),
    );

    const rendered = component.render(140).join("\n");
    expect(rendered).toContain("continues #076c");
    expect(rendered).toContain("previous run #076c · history unavailable");
    expect(rendered).toContain("/workflows status 076c");
    expect(rendered).toContain("0/1 done");
    expect(rendered).toContain("continue current work");

    component.dispose();
    agentLiveStore.reset();
  });

  it("renders phase, agent transitions, durations, and stays inside the terminal budget", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r1", {
      scope: "workflow",
      declaredStages: [{ title: "smoke" }, { title: "verify" }],
    });

    pushProgress(component, line({ kind: "phase", phase: "smoke", ts: 1, runId: "r1" }));
    pushProgress(component, line({ kind: "log", message: "starting", ts: 2, runId: "r1" }));
    pushProgress(component, line({ kind: "agent_start", agent: "explore", label: "note:explore", ts: 3, runId: "r1" }));
    pushProgress(
      component,
      line({
        kind: "agent_end",
        agent: "explore",
        label: "note:explore",
        status: "failed",
        durationMs: 22247,
        ts: 25,
        runId: "r1",
      }),
    );
    pushProgress(
      component,
      line({ kind: "agent_start", agent: "quick_task", label: "note:quick", ts: 26, runId: "r1" }),
    );
    agentLiveStore.patch(
      workflowAgentLiveRowId(
        line({ kind: "agent_start", agent: "quick_task", label: "note:quick", ts: 26, runId: "r1" }),
      ),
      { tokenCount: { input: 12, output: 3 } },
    );
    pushProgress(
      component,
      line({
        kind: "agent_end",
        agent: "quick_task",
        label: "note:quick",
        status: "completed",
        durationMs: 4346,
        ts: 30,
        runId: "r1",
      }),
    );
    const rendered = component.render(100);
    const text = rendered.join("\n");

    expect(rendered.length).toBeLessThanOrEqual(Math.max(6, Math.min(30 - 6, 24)));
    expect(text).toContain("◆ live-smoke │ tok 15 │ 1/2 smoke · ● RUNNING");
    expect(text).not.toContain(" active");
    // The roster shows the whole run: settled agents keep their outcome marker and
    // duration, and a declared stage the run has not reached yet stays visible as
    // planned work instead of being hidden until it starts.
    expect(text).toContain("note:quick");
    expect(text).toContain("4s");
    expect(text).toContain("✗ ");
    expect(text).toContain("note:explore");
    expect(text).toContain("22s");
    expect(text).toContain("○ verify  ·  planned");
    expect(rendered.some((renderedLine) => renderedLine.includes("widget truncated"))).toBe(false);
    expect(viewerExternalRows()).toBe(rendered.length);

    const commandRail = component.render(120)[0] ?? "";
    expect(commandRail).toContain("/ps inspect agents");
    expect(commandRail).toContain("/workflows stop last");
    expect(commandRail.trimEnd().endsWith("/workflows stop last")).toBe(true);
    expect(commandRail.indexOf("/ps inspect agents")).toBe(120 - "/ps inspect agents · /workflows stop last".length);

    fleetMenuState.setFocused(true);
    const focused = component.render(100).join("\n");
    expect(focused).toContain("note:explore");
    expect(focused).toContain("note:quick");
    fleetMenuState.setFocused(false);
    component.dispose();
    expect(viewerExternalRows()).toBe(0);
  });

  it("shows only the agent whose transcript viewer is open, then restores the roster", () => {
    agentLiveStore.reset();
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "task reviewer", "ordinary-r1");
    agentLiveStore.begin({ id: "viewer-filter-first", agentName: "reviewer", label: "first task" });
    const second = agentLiveStore.begin({ id: "viewer-filter-second", agentName: "scout", label: "selected task" });

    const release = acquireFleetViewedRow(second.id);
    const focused = component.render(100).join("\n");
    expect(focused).toContain("selected task");
    expect(focused).not.toContain("first task");

    release();
    const restored = component.render(100).join("\n");
    expect(restored).toContain("selected task");
    expect(restored).toContain("first task");
    expect(tui.requestRender).toHaveBeenCalled();

    component.dispose();
    agentLiveStore.reset();
  });

  it("rosters finished, running, and still-planned work, and keeps one row per re-entered slot", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 140 } };
    const component = new WorkflowProgressComponent(tui, {}, "review", "roster-r1", {
      scope: "workflow",
      declaredStages: [
        { title: "resolve-scope", detail: "Turn the intent into one review scope." },
        { title: "inventory-changes", detail: "Prove complete coverage of the changed surface." },
        { title: "verify-review", detail: "Reopen the evidence and author review.md." },
      ],
    });
    const slot = (phase: string, label: string, round?: number) => ({
      agent: "default",
      label,
      phase,
      runId: "roster-r1",
      slotKey: `${phase}${label}`,
      ...(round === undefined ? {} : { round }),
    });

    pushProgress(component, line({ kind: "phase", phase: "resolve-scope", ts: 1, runId: "roster-r1" }));
    pushProgress(component, line({ ...slot("resolve-scope", "resolve review scope"), kind: "agent_start", ts: 2 }));
    pushProgress(
      component,
      line({
        ...slot("resolve-scope", "resolve review scope"),
        kind: "agent_end",
        status: "completed",
        durationMs: 19_000,
        ts: 3,
      }),
    );
    pushProgress(component, line({ kind: "phase", phase: "inventory-changes", ts: 4, runId: "roster-r1" }));
    pushProgress(component, line({ ...slot("inventory-changes", "inventory changes"), kind: "agent_start", ts: 5 }));

    const running = component.render(140).join("\n");
    expect(running).toContain("✓ ");
    expect(running).toContain("resolve review scope");
    expect(running).toContain("19s");
    expect(running).toContain("inventory changes");
    // Stages the run has not reached yet stay visible with what they plan to do.
    expect(running).toContain("○ verify-review  ·  planned  ·  Reopen the evidence and author review.md.");
    // A reached stage is not advertised as planned any more.
    expect(running).not.toContain("○ resolve-scope");
    expect(running).not.toContain("○ inventory-changes");

    // A loop re-enters the same slot: the row is updated and carries `r2`, so the
    // roster never grows a second row for the same work.
    pushProgress(
      component,
      line({
        ...slot("inventory-changes", "inventory changes", 2),
        kind: "agent_end",
        status: "completed",
        durationMs: 9_000,
        ts: 6,
      }),
    );
    const looped = component.render(140);
    expect(looped.filter((renderedLine) => renderedLine.includes("inventory changes"))).toHaveLength(1);
    expect(looped.join("\n")).toContain("r2");
    component.dispose();
    agentLiveStore.reset();
  });

  it("collapses the oldest settled roster rows first and says how many it hid", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    // rows-6 leaves 8 lines total for header, stages, roster, and the hint.
    const tui = { requestRender: vi.fn(), terminal: { rows: 14, columns: 140 } };
    const component = new WorkflowProgressComponent(tui, {}, "review", "clamp-r1", { scope: "workflow" });

    for (let index = 1; index <= 8; index += 1) {
      const slot = { agent: "default", label: `stage ${index}`, phase: `p${index}`, runId: "clamp-r1" };
      pushProgress(component, line({ ...slot, kind: "agent_start", ts: index * 2 }));
      pushProgress(
        component,
        line({ ...slot, kind: "agent_end", status: "completed", durationMs: 1000, ts: index * 2 + 1 }),
      );
    }

    const rendered = component.render(140);
    const text = rendered.join("\n");
    expect(rendered.length).toBeLessThanOrEqual(8);
    expect(text).toMatch(/\(\+\d+ earlier agents\)/u);
    // The newest work survives the clamp; the oldest is the part that collapses.
    expect(text).toContain("stage 8");
    expect(text).not.toContain("stage 1 ");
    component.dispose();
    agentLiveStore.reset();
  });

  // ── Roster cardinality (T-192 W1) ──────────────────────────────────────────
  //
  // The panel and `/ps` share one set-level projection (`orderAgentLiveRows`),
  // so what a fan-out looks like is a property of how many members it has: none,
  // one, a few, many, some failed, or every state at once.
  describe("roster cardinality", () => {
    /** Start a `parallel` group of `total` members; returns their live row ids. */
    function startFanOut(
      component: WorkflowProgressComponent,
      runId: string,
      labels: string[],
      groupId = "fan-1",
    ): string[] {
      pushProgress(
        component,
        line({ kind: "group_start", groupId, groupKind: "parallel", groupTotal: labels.length, ts: 1, runId }),
      );
      return labels.map((label, index) => {
        const start = line({
          kind: "agent_start",
          agent: "worker",
          label,
          phase: "fan-out",
          groupId,
          groupKind: "parallel",
          ts: 2 + index,
          runId,
        });
        pushProgress(component, start);
        return workflowAgentLiveRowId(start);
      });
    }

    function fanOutComponent(runId: string, rows = 40, columns = 160): WorkflowProgressComponent {
      const tui = { requestRender: vi.fn(), terminal: { rows, columns } };
      return new WorkflowProgressComponent(tui, {}, "fan-out", runId, { scope: "workflow" });
    }

    afterEach(() => {
      fleetMenuState.setFocused(false);
      agentLiveStore.reset();
    });

    it("says it is waiting when the run has produced no agent yet (0)", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-zero");
      expect(component.render(160).join("\n")).toContain("waiting for workflow agents…");
      component.dispose();
    });

    it("gives a one-member group no heading and still shows its agent (1)", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-one");
      startFanOut(component, "card-one", ["only item"]);

      const text = component.render(160).join("\n");
      expect(text).toContain("only item");
      // A heading over a single row is a heading over nothing.
      expect(text).not.toContain("parallel (1)");
      component.dispose();
    });

    it("heads a small group and lists every member (few)", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-few");
      startFanOut(component, "card-few", ["alpha item", "beta item", "gamma item"]);

      const text = component.render(160).join("\n");
      expect(text).toContain("parallel (3)");
      expect(text).toContain("0/3 done");
      for (const label of ["alpha item", "beta item", "gamma item"]) expect(text).toContain(label);
      component.dispose();
    });

    it("keeps the heading and announces the collapse when the group outgrows the budget (many)", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-many");
      const labels = Array.from({ length: 30 }, (_unused, index) => `item ${index} of 30`);
      startFanOut(component, "card-many", labels);

      const rendered = component.render(160);
      const text = rendered.join("\n");
      expect(rendered.length).toBeLessThanOrEqual(24);
      // The summary is what survives: it still answers how the fan-out is going.
      expect(text).toContain("parallel (30)");
      expect(text).toMatch(/\(\+\d+ earlier agents\)/u);
      component.dispose();
    });

    it("keeps the live fan-out on screen when finished group headings fill the budget", () => {
      // A finished group's heading is not live work, so it must not outrank the
      // group that IS running. When headings could not be collapsed at all, a run
      // that had already closed twenty fan-outs filled the roster with `✓ parallel
      // (2)` summaries and the tail cut took the live group, both of its working
      // agents and the pending line off the screen.
      agentLiveStore.reset();
      const component = fanOutComponent("card-tail", 24);
      for (let group = 0; group < 20; group += 1) {
        const ids = startFanOut(component, "card-tail", [`closed ${group}a`, `closed ${group}b`], `fan-${group}`);
        for (const id of ids) agentLiveStore.patch(id, { status: "done" });
        pushProgress(
          component,
          line({
            kind: "group_end",
            status: "completed",
            groupId: `fan-${group}`,
            groupKind: "parallel",
            groupTotal: 2,
            groupCompleted: 2,
            groupFailed: 0,
            durationMs: 1_000,
            ts: 100 + group,
            runId: "card-tail",
          }),
        );
      }
      const liveIds = startFanOut(component, "card-tail", ["live-a item", "live-b item"], "fan-live");
      for (const id of liveIds) agentLiveStore.patch(id, { status: "working" });

      const rendered = component.render(160);
      const text = rendered.join("\n");
      expect(rendered.length).toBeLessThanOrEqual(24);
      // The running work — the only thing an operator can still steer — survives.
      expect(text).toContain("live-a item");
      expect(text).toContain("live-b item");
      // Finished members go first, then the headings above them — and both losses
      // are counted out loud instead of being cut off the bottom of the panel.
      expect(text).not.toContain("closed 0a");
      expect(text).not.toContain("closed 19b");
      expect(text).toMatch(/\(\+40 earlier agents · \+\d+ earlier groups\)/u);
      // The summaries that DID survive are the finished fan-outs, in one line each.
      expect(text).toContain("2/2 done");
      component.dispose();
    });

    it("collapses a group's finished members before the ones still working", () => {
      // `orderAgentLiveRows` puts working members on top of their group. A clamp
      // that then gave up rows from the top would hide exactly those and keep the
      // finished ones — the ordering rule defeated where it matters most.
      agentLiveStore.reset();
      const component = fanOutComponent("card-live-first", 14);
      const labels = [
        ...Array.from({ length: 6 }, (_unused, index) => `live item ${index}`),
        ...Array.from({ length: 4 }, (_unused, index) => `closed item ${index}`),
      ];
      const ids = startFanOut(component, "card-live-first", labels);
      ids.forEach((id, index) => agentLiveStore.patch(id, { status: index < 6 ? "working" : "done" }));

      const text = component.render(160).join("\n");
      expect(text).toContain("parallel (10)");
      // Every finished member is gone before a single working one is given up.
      expect(text).not.toContain("closed item");
      expect(text.match(/live item/gu) ?? []).toHaveLength(5);
      expect(text).toContain("live item 0");
      expect(text).toContain("live item 5");
      expect(text).toMatch(/\(\+5 earlier agents\)/u);
      component.dispose();
    });

    it("carries the failed count in the group heading (failed)", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-failed");
      const ids = startFanOut(component, "card-failed", ["ok item", "broken item", "other item"]);
      agentLiveStore.patch(ids[1]!, { status: "error" });
      pushProgress(
        component,
        line({
          kind: "group_end",
          status: "failed",
          groupId: "fan-1",
          groupKind: "parallel",
          groupTotal: 3,
          groupCompleted: 2,
          groupFailed: 1,
          durationMs: 5_000,
          ts: 90,
          runId: "card-failed",
        }),
      );

      const text = component.render(160).join("\n");
      expect(text).toContain("parallel (3)");
      expect(text).toContain("2/3 done");
      expect(text).toContain("1 failed");
      expect(text).toContain("broken item");
      component.dispose();
    });

    it("counts the group heading up while the fan-out is still running", () => {
      // The journal states `groupCompleted` only on `group_end`, so a heading that
      // waited for it sat at `0/9 done` for the whole run while eight of its nine
      // member rows already carried `✓` or `✗` right underneath it — and the
      // failed count did not appear at all until the group settled. The heading is
      // the summary of those rows, so it counts them.
      agentLiveStore.reset();
      const component = fanOutComponent("card-running", 40);
      const labels = Array.from({ length: 9 }, (_unused, index) => `running item ${index}`);
      const ids = startFanOut(component, "card-running", labels);
      ids.forEach((id, index) => {
        const status: AgentLiveStatus = index === 0 ? "error" : index < 7 ? "done" : "working";
        agentLiveStore.patch(id, { status });
      });

      const text = component.render(160).join("\n");
      expect(text).toContain("parallel (9)");
      expect(text).toContain("6/9 done");
      expect(text).toContain("1 failed");
      // The group row itself is still running: nothing has settled it.
      expect(text).not.toContain("9/9 done");
      component.dispose();
    });

    it("keeps the settled group counters the run reported over the member rows", () => {
      // `group_end` answers for branches that never produced a live row at all
      // (`completed = total - failed`), so once the run has stated the outcome the
      // heading repeats it instead of recounting the rows on screen.
      agentLiveStore.reset();
      const component = fanOutComponent("card-settled");
      const ids = startFanOut(component, "card-settled", ["kept item", "lost item"]);
      agentLiveStore.patch(ids[0]!, { status: "working" });
      agentLiveStore.patch(ids[1]!, { status: "working" });
      pushProgress(
        component,
        line({
          kind: "group_end",
          status: "completed",
          groupId: "fan-1",
          groupKind: "parallel",
          groupTotal: 2,
          groupCompleted: 2,
          groupFailed: 0,
          durationMs: 3_000,
          ts: 90,
          runId: "card-settled",
        }),
      );

      const text = component.render(160).join("\n");
      expect(text).toContain("2/2 done");
      component.dispose();
    });

    it("ranks group members working, failed, queued, done (mixed)", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-mixed");
      const ids = startFanOut(component, "card-mixed", ["delta done", "beta failed", "alpha working", "gamma queued"]);
      agentLiveStore.patch(ids[0]!, { status: "done" });
      agentLiveStore.patch(ids[1]!, { status: "error" });
      agentLiveStore.patch(ids[2]!, { status: "working" });
      agentLiveStore.patch(ids[3]!, { status: "queued" });

      const rendered = component.render(160);
      const at = (needle: string) => rendered.findIndex((renderedLine) => renderedLine.includes(needle));
      expect(at("parallel (4)")).toBeGreaterThanOrEqual(0);
      expect(at("parallel (4)")).toBeLessThan(at("alpha working"));
      expect(at("alpha working")).toBeLessThan(at("beta failed"));
      expect(at("beta failed")).toBeLessThan(at("gamma queued"));
      expect(at("gamma queued")).toBeLessThan(at("delta done"));
      component.dispose();
    });

    it("never spends more than 24 lines, however tall the terminal is", () => {
      agentLiveStore.reset();
      const component = fanOutComponent("card-budget", 100);
      startFanOut(
        component,
        "card-budget",
        Array.from({ length: 40 }, (_unused, index) => `budget item ${index}`),
      );

      // rows-6 would allow 94 lines here; the hard cap is 24.
      expect(component.render(160).length).toBeLessThanOrEqual(24);
      component.dispose();
    });

    it("collapses declared unreached phases into one line naming the next", () => {
      agentLiveStore.reset();
      const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 160 } };
      const component = new WorkflowProgressComponent(tui, {}, "fan-out", "card-pending", {
        scope: "workflow",
        declaredStages: [
          { title: "fan-out", detail: "Run the items." },
          { title: "collect", detail: "Gather the results." },
          { title: "verify", detail: "Prove the outcome." },
        ],
      });
      pushProgress(component, line({ kind: "phase", phase: "fan-out", ts: 1, runId: "card-pending" }));
      startFanOut(component, "card-pending", ["only item"], "fan-pending");

      const text = component.render(160).join("\n");
      expect(text).toContain("○ next: collect (+1 planned)");
      expect(text).not.toContain("○ verify");
      expect(text).not.toContain("Gather the results.");
      component.dispose();
    });
  });

  it("keeps ordinary agent panels expanded while workflow compaction stays scope-local", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
    const component = new WorkflowProgressComponent(tui, {}, "task reviewer", "ordinary-r1");

    pushProgress(
      component,
      line({ kind: "agent_start", agent: "first", label: "ordinary first", ts: 1, runId: "ordinary-r1" }),
    );
    pushProgress(
      component,
      line({ kind: "agent_start", agent: "second", label: "ordinary second", ts: 2, runId: "ordinary-r1" }),
    );

    const text = component.render(120).join("\n");
    expect(text).toContain("ordinary first");
    expect(text).toContain("ordinary second");
    expect(text).not.toContain("/ps inspect agents");
    component.dispose();
    agentLiveStore.reset();
  });

  // The live panel is the surface an operator watches while the run happens, so
  // a resumed run has to declare reused evidence here too. Counted from explicit
  // `replayed: true` markers only — never inferred from a zero duration or a
  // missing token count, which a fast real call would also produce.
  it("declares reused recorded evidence with replayed=<n> in the header, and omits it on a fresh run", () => {
    agentLiveStore.reset();
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
    const component = new WorkflowProgressComponent(tui, {}, "stages", "run-1", { scope: "workflow" });

    const stage = (n: number, replayed: boolean): void => {
      const common = {
        agent: "default",
        label: `note:stage-${n}`,
        runId: "run-1",
        ...(replayed ? { replayed: true } : {}),
      };
      pushProgress(component, line({ ...common, kind: "agent_start", ts: n * 2 }));
      pushProgress(
        component,
        line({ ...common, kind: "agent_end", status: "completed", durationMs: 0, ts: n * 2 + 1 }),
      );
    };

    stage(1, true);
    stage(2, true);
    stage(3, false);
    expect(component.render(120).join("\n")).toContain("◆ WORKFLOW · stages │ tok — │ stage — · ● RUNNING");
    expect(component.render(120).join("\n")).toContain("replayed 2");

    agentLiveStore.reset();
    const fresh = new WorkflowProgressComponent(tui, {}, "stages", "run-2", { scope: "workflow" });
    pushProgress(fresh, line({ kind: "agent_start", agent: "default", label: "note:only", ts: 1, runId: "run-2" }));
    pushProgress(
      fresh,
      line({
        kind: "agent_end",
        agent: "default",
        label: "note:only",
        status: "completed",
        durationMs: 0,
        ts: 2,
        runId: "run-2",
      }),
    );
    const freshText = fresh.render(120).join("\n");
    expect(freshText).toContain("◆ WORKFLOW · stages │ tok — │ stage — · ● RUNNING");
    expect(freshText).not.toContain("replayed=");
  });

  // A run started by absolute path used to spend the whole rail on the directory
  // prefix: every projection overflowed, the aligner gave up, and the right-hand
  // commands disappeared instead of degrading. Identity is cut first now.
  it("keeps the rail commands when the workflow was started by a long absolute path", () => {
    agentLiveStore.reset();
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 170 } };
    expect(LONG_ABSOLUTE_REF.length).toBe(132);
    const component = new WorkflowProgressComponent(tui, {}, LONG_ABSOLUTE_REF, "path-r1", { scope: "workflow" });

    const rail = component.render(170)[0] ?? "";
    expect(rail).toContain("…/implement-plan.workflow.mjs");
    expect(rail).not.toContain("/home/operator/projects");
    expect(rail).toContain("/ps inspect agents");
    expect(rail).toContain("/workflows stop last");
    expect(rail.length).toBeLessThanOrEqual(170);

    // A package ref and a plain name are identity already, and stay untouched.
    const packageRef = new WorkflowProgressComponent(tui, {}, "airflow-dag-builder/plan", "pkg-r1", {
      scope: "workflow",
    });
    expect(packageRef.render(170)[0] ?? "").toContain("◆ WORKFLOW · airflow-dag-builder/plan");
    component.dispose();
    packageRef.dispose();
  });

  // The fleet-scope header has no right-hand block to lose, but it truncates from
  // the right, so the same long path pushed `active=`/`done=` — the run state the
  // header exists to report — off the end of the line.
  it("keeps the fleet header counters when the workflow was started by a long absolute path", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    fleetMenuState.setVisibleRows([]);
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
    const component = new WorkflowProgressComponent(tui, {}, LONG_ABSOLUTE_REF, "fleet-path-r1");

    const header = component.render(120)[0] ?? "";
    expect(header).toContain("workflow …/implement-plan.workflow.mjs (fleet-path-r1)");
    expect(header).not.toContain("/home/operator/projects");
    expect(header).toContain("phase=not-set");
    expect(header).toContain("active=0");
    expect(header).toContain("done=0/0");
    expect(header.length).toBeLessThanOrEqual(120);
    component.dispose();
  });

  it("projects a cancelled agent_end as terminal while the workflow may still finish successfully", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    fleetMenuState.setVisibleRows([]);
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
      const component = new WorkflowProgressComponent(tui, {}, "cancel-smoke", "cancel-r1", { scope: "workflow" });
      const start = line({ kind: "agent_start", agent: "reviewer", label: "sleep 60", ts: 1, runId: "cancel-r1" });
      const end = line({
        kind: "agent_end",
        agent: "reviewer",
        label: "sleep 60",
        status: "cancelled",
        durationMs: 60_000,
        ts: 2,
        runId: "cancel-r1",
      });

      pushProgress(component, start);
      component.render(120); // Seeds the exact row selected by the shared fleet menu.
      fleetMenuState.setFocused(true);
      pushProgress(component, end);
      component.finish({ ok: true, result: { summary: "child status reviewer cancelled" } });

      const text = component.render(120).join("\n");
      expect(text).toContain("◆ WORKFLOW · cancel-smoke │ tok — │ stage — · ✓ OK");
      expect(text).toContain("⊘");
      expect(text).toContain("sleep 60");
      expect(text).toContain("✓ child status reviewer cancelled");
      expect(text).not.toMatch(/[⠿⠻⠽⠾]/u);
      expect(text).not.toContain("stop");
      expect(agentLiveStore.rows.get(workflowAgentLiveRowId(end))).toMatchObject({
        status: "cancelled",
        currentTools: [],
      });
    } finally {
      fleetMenuState.setFocused(false);
      fleetMenuState.setVisibleRows([]);
      agentLiveStore.reset();
    }
  });

  it("collapses workflow parent rows once SDK child rows exist", () => {
    agentLiveStore.reset();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "nested-r1");
      const parentLine = line({
        kind: "agent_start",
        agent: "reviewer",
        label: "review-step",
        phase: "smoke",
        ts: 1,
        runId: "nested-r1",
      });
      const parentRowId = workflowAgentLiveRowId(parentLine);

      pushProgress(component, parentLine);
      const child = agentLiveStore.begin({
        parentRowId,
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "working", currentTools: ["read"], stepCount: 1 });

      const rendered = component.render(100);
      const text = rendered.join("\n");

      expect(text).not.toContain("reviewer (review-step)");
      // T-191: new grammar — petname + title, no `on task`/hash tail; the `└`
      // action sub-line is deferred to T-196, so an active tool adds no sub-line.
      expect(text).toContain("SDK child session");
      expect(text).not.toContain("on task");
      expect(text).not.toMatch(/reviewer#\w+/);
      expect(text).not.toContain("[current task]");
      component.dispose();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("collapses workflow parent rows in the text fallback", () => {
    agentLiveStore.reset();
    try {
      agentLiveStore.begin({
        id: "workflow:text-r1:reviewer:review-step:smoke",
        agentName: "reviewer",
        label: "reviewer (review-step)",
        isolated: false,
        noMcp: false,
      });
      const child = agentLiveStore.begin({
        parentRowId: "workflow:text-r1:reviewer:review-step:smoke",
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "working", currentTools: ["read"], stepCount: 1 });

      const rendered = renderAgentLiveRowsText();

      expect(rendered).not.toContain("reviewer (review-step)");
      // T-191: `⠿ <petname>  SDK child session …` — no `[Working]`, no `on task`.
      // Assert the petname the store actually assigned: it is derived from a
      // time-based row id and may carry a `-2`, `-3`, … collision suffix, so any
      // guessed pattern is a flake waiting to happen.
      expect(child.displayName).toBeDefined();
      expect(rendered).toContain(`⠿ ${child.displayName}  SDK child session`);
      expect(rendered).not.toContain("[Working]");
      expect(rendered).not.toContain("on task");
      expect(rendered).not.toContain("[current task]");
    } finally {
      agentLiveStore.reset();
    }
  });

  it("renders the model+effort badge, token counter, and group summaries in the new grammar", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(true);
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 260 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "rich-r1");
      pushProgress(
        component,
        line({
          kind: "group_start",
          groupId: "parallel-1",
          groupKind: "parallel",
          groupTotal: 2,
          ts: 1,
          runId: "rich-r1",
        }),
      );
      pushProgress(
        component,
        line({
          kind: "agent_start",
          agent: "reviewer",
          label: "review-step",
          model: "test/strong",
          thinking: "high",
          groupId: "parallel-1",
          groupKind: "parallel",
          ts: 2,
          runId: "rich-r1",
        }),
      );
      const parentRowId = workflowAgentLiveRowId({ runId: "rich-r1", agent: "reviewer", label: "review-step" });
      const child = agentLiveStore.begin({
        parentRowId,
        agentName: "reviewer",
        label: "SDK child session",
        model: "test/strong",
        thinking: "high",
        isolated: true,
        noMcp: true,
      });
      agentLiveStore.patch(child.id, {
        status: "working",
        currentTools: ["read"],
        currentToolArgs: '{"file":"README.md"}',
        turnCount: 1,
        tokenCount: { input: 7, output: 8 },
      });
      pushProgress(
        component,
        line({
          kind: "group_end",
          status: "failed",
          groupId: "parallel-1",
          groupKind: "parallel",
          groupTotal: 2,
          groupCompleted: 1,
          groupFailed: 1,
          durationMs: 456,
          ts: 5,
          runId: "rich-r1",
        }),
      );

      const rendered = component.render(260).join("\n");

      // Group summary row: label + k/n done + failed count (no `[Working]`/`group=`).
      expect(rendered).toContain("parallel (2)");
      expect(rendered).toContain("1/2 done");
      expect(rendered).toContain("1 failed");
      expect(rendered).toMatch(/parallel \(2\).*↑7 ↓8/);
      // SDK child agent row: petname + title, model+effort badge (provider stripped),
      // no `on task`/`/effort=`/`args=`/`turns=`/`flags=`/`[current task]` sub-line.
      expect(rendered).toContain("SDK child session");
      expect(rendered).toContain("strong high");
      expect(rendered).not.toContain("on task");
      expect(rendered).not.toContain("/effort=");
      expect(rendered).not.toContain("[current task]");
      expect(rendered).not.toContain("turns=");
      expect(rendered).not.toContain("flags=");
      component.dispose();
    } finally {
      fleetMenuState.setFocused(false);
      agentLiveStore.reset();
    }
  });

  it("self-clamps to the rows-6 budget on a very short terminal (rows=8 -> 2 lines)", () => {
    // SPEC 3/A: the tight rows-6 budget wins; there is no 6-line floor to override it.
    const tui = { requestRender: vi.fn(), terminal: { rows: 8, columns: 80 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r1");

    pushProgress(component, line({ kind: "phase", phase: "smoke", ts: 1, runId: "r1" }));
    for (let i = 0; i < 6; i += 1) {
      pushProgress(component, line({ kind: "agent_start", agent: `agent_${i}`, ts: 2 + i, runId: "r1" }));
    }

    const rendered = component.render(80);
    expect(rendered.length).toBeLessThanOrEqual(8 - 6);
    expect(rendered.some((renderedLine) => renderedLine.includes("widget truncated"))).toBe(false);
    component.dispose();
  });

  it("never emits a line wider than the terminal at a narrow width (40)", () => {
    // SPEC 3/B + H: every built line is width-fitted before coloring. With a bare {}
    // theme there is no ANSI, so visible width == string length.
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 40 } };
    const component = new WorkflowProgressComponent(tui, {}, "a-very-long-script-reference-name", "run-1234567890");

    pushProgress(
      component,
      line({ kind: "phase", phase: "a-long-phase-name-that-overflows", ts: 1, runId: "run-1234567890" }),
    );
    pushProgress(
      component,
      line({
        kind: "agent_start",
        agent: "an_agent_with_a_long_name",
        label: "a-long-label-too",
        ts: 2,
        runId: "run-1234567890",
      }),
    );
    pushProgress(
      component,
      line({
        kind: "log",
        message: "a log line whose message far exceeds forty columns of width",
        ts: 3,
        runId: "run-1234567890",
      }),
    );
    pushProgress(
      component,
      line({
        kind: "agent_end",
        agent: "an_agent_with_a_long_name",
        label: "a-long-label-too",
        status: "completed",
        durationMs: 1234,
        ts: 4,
        runId: "run-1234567890",
      }),
    );

    for (const renderedLine of component.render(40)) {
      expect(renderedLine.length).toBeLessThanOrEqual(40);
    }
    component.dispose();
  });

  it("renders script, runtime, and legacy journal logs with distinct provenance", () => {
    fleetMenuState.setFocused(true);
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "provenance-r1");

    pushProgress(
      component,
      line({ kind: "log", source: "script", message: "compare candidates", ts: 1, runId: "provenance-r1" }),
    );
    pushProgress(
      component,
      line({ kind: "log", source: "runtime", message: "[workflow:enter]", ts: 2, runId: "provenance-r1" }),
    );
    pushProgress(component, line({ kind: "log", message: "old journal line", ts: 3, runId: "provenance-r1" }));

    const text = component.render(100).join("\n");
    expect(text).toContain("│ script · compare candidates");
    expect(text).toContain("│ runtime · [workflow:enter]");
    expect(text).toContain("│ journal · old journal line");
    expect(text).not.toContain("log:");
    expect(text.match(/│ script ·/g)).toHaveLength(1);
    component.dispose();
    fleetMenuState.setFocused(false);
  });

  it("projects only the current normalized stage and its stable position into the rail", () => {
    agentLiveStore.reset();
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 160 } };
    const component = new WorkflowProgressComponent(tui, {}, "review", "stage-r1", {
      scope: "workflow",
      declaredStages: [{ title: "clarify" }, { title: "scope" }, { title: "questions" }, { title: "review" }],
    });

    pushProgress(component, line({ kind: "phase", phase: "clarify", ts: 1, runId: "stage-r1" }));
    pushProgress(
      component,
      line({
        kind: "agent_start",
        agent: "reviewer",
        label: "metadata only",
        phase: "review",
        ts: 1.5,
        runId: "stage-r1",
      }),
    );
    pushProgress(component, line({ kind: "phase", phase: "questions", ts: 2, runId: "stage-r1" }));
    pushProgress(component, line({ kind: "phase", phase: "dynamic-check", ts: 3, runId: "stage-r1" }));

    const rail = component.render(160)[0];
    expect(rail).toContain("stage 5/5 · dynamic-check · ● RUNNING");
    expect(rail).not.toMatch(/completed|failed|✓|✗/u);
    expect(component.render(50)[0]).toContain("dynamic-check");
    component.dispose();
  });

  it("normalizes declared, reached, and current phases before stable deduplication", () => {
    agentLiveStore.reset();
    const component = new WorkflowProgressComponent(
      { requestRender: vi.fn(), terminal: { rows: 30, columns: 160 } },
      {},
      "review",
      "normalized-r1",
      {
        scope: "workflow",
        declaredStages: [
          { title: " review " },
          { title: "" },
          { title: "review" },
          { title: " verify " },
          { title: "verify" },
        ],
      },
    );

    pushProgress(component, line({ kind: "phase", phase: "   ", ts: 1, runId: "normalized-r1" }));
    pushProgress(component, line({ kind: "phase", phase: " review ", ts: 2, runId: "normalized-r1" }));
    pushProgress(component, line({ kind: "phase", phase: "review", ts: 3, runId: "normalized-r1" }));
    pushProgress(component, line({ kind: "phase", phase: " verify ", ts: 4, runId: "normalized-r1" }));
    pushProgress(component, line({ kind: "phase", phase: "", ts: 5, runId: "normalized-r1" }));

    expect(component.render(160)[0]).toContain("stage 2/2 · verify · ● RUNNING");
    component.dispose();
  });

  it("keeps bounded errors and evidence warnings visible in compact passive mode", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 140 } };
    const component = new WorkflowProgressComponent(tui, {}, "review", "diagnostic-r1", { scope: "workflow" });

    pushProgress(component, line({ kind: "error", message: "older diagnostic", ts: 1, runId: "diagnostic-r1" }));
    pushProgress(
      component,
      line({
        kind: "agent_end",
        agent: "reviewer",
        label: "review",
        status: "completed",
        evidenceWarnings: ["missing expected runtime evidence"],
        ts: 2,
        runId: "diagnostic-r1",
      }),
    );
    pushProgress(component, line({ kind: "error", message: "latest workflow error", ts: 3, runId: "diagnostic-r1" }));

    const text = component.render(140).join("\n");
    expect(text).toContain("agent_end: reviewer completed");
    expect(text).toContain("missing expected runtime evidence");
    expect(text).toContain("error: latest workflow error");
    expect(text).not.toContain("older diagnostic");
    expect(text).toContain("/ps inspect agents");
    component.dispose();
  });

  it("renders failed completion state in place", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r");

    component.finish({ ok: false, error: "Pi SDK host: connection refused" });

    expect(
      component
        .render(100)
        .some(
          (renderedLine) =>
            renderedLine.includes("failed") || renderedLine.includes("error") || renderedLine.includes("FAIL"),
        ),
    ).toBe(true);
  });

  it("renders waiting and cancelled outcomes without collapsing either to OK", () => {
    const awaiting = new WorkflowProgressComponent(
      { requestRender: vi.fn(), terminal: { rows: 30, columns: 140 } },
      {},
      "review",
      "awaiting-r1",
      { scope: "workflow" },
    );
    awaiting.finish({
      ok: true,
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
      result: { mode: "prepared" },
    });
    const awaitingText = awaiting.render(140).join("\n");
    expect(awaitingText).toContain("◐ AWAITING OPERATOR");
    expect(awaitingText).toContain("◐ awaiting operator · review clarification required");
    expect(awaitingText).not.toContain("✓ OK");

    const cancelled = new WorkflowProgressComponent(
      { requestRender: vi.fn(), terminal: { rows: 30, columns: 140 } },
      {},
      "review",
      "cancelled-r1",
      { scope: "workflow" },
    );
    cancelled.finish({
      ok: false,
      disposition: { status: "cancelled", reason: "operator_stop" },
      result: null,
    });
    const cancelledText = cancelled.render(140).join("\n");
    expect(cancelledText).toContain("⊘ CANCELLED");
    expect(cancelledText).toContain("⊘ cancelled by operator");
    expect(cancelledText).not.toContain("✓ OK");
  });

  it("renders exact semantic failure rows when no technical error exists", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 180 } };
    const component = new WorkflowProgressComponent(tui, {}, "semantic", "semantic-r1");

    component.finish({
      ok: false,
      result: { ok: false, summary: "Acceptance remains open", unresolvedRows: ["R-GIT", "R-CODE"] },
    });

    const text = component.render(180).join("\n");
    expect(text).toContain("✗ Acceptance remains open · unresolved: R-CODE, R-GIT");
    expect(text).not.toContain("unknown error");
  });

  it("renders result persistence failure as the final workflow verdict", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 180 } };
    const component = new WorkflowProgressComponent(tui, {}, "silent", "persistence-r1");

    component.finish({
      ok: false,
      error: "Workflow result was not persisted: blocked",
      result: { summary: "execution completed" },
      resultPersistence: {
        ok: false,
        path: "/blocked/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED",
        message: "Workflow result was not persisted: blocked",
      },
    });

    const text = component.render(180).join("\n");
    expect(text).toContain("FAILED");
    expect(text).toContain("✗ Workflow result was not persisted: blocked");
    expect(text).toContain("persistence: WORKFLOW_RESULT_WRITE_FAILED");
    expect(text).not.toContain("✓ execution completed");
  });

  it("prints the saved run directory in the finished result (T-188 W5)", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "20260101-000000-r1");

    component.finish({ ok: true, result: { ok: true }, runDir: ".pi/locus-pi/runs/20260101-000000-r1" });

    const text = component.render(120).join("\n");
    expect(text).toContain("saved: .pi/locus-pi/runs/20260101-000000-r1");
  });

  it("points a clipped prose verdict at the file and the command that show all of it", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 60 } };
    const component = new WorkflowProgressComponent(tui, {}, "review", "20260726-212752-98cc");

    component.finish({
      ok: true,
      result: `# Code Review\n\n${"A verdict far wider than this terminal. ".repeat(6)}`,
      runDir: ".pi/locus-pi/runs/20260726-212752-98cc",
      resultTextPath: ".pi/locus-pi/runs/20260726-212752-98cc/result.md",
    });

    const narrow = component.render(60).join("\n");
    // The command names the run, so it is usable even where the panel clips paths.
    expect(narrow).toContain("read the full result: /workflows result 98cc");
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    expect(component.render(120).join("\n")).toContain("result: .pi/locus-pi/runs/20260726-212752-98cc/result.md");
  });

  it("points a failed run with no prose result at the command that prints the reason", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 60 } };
    const component = new WorkflowProgressComponent(tui, {}, "plan", "20260730-162453-000e");

    component.finish({
      ok: false,
      result: {
        ok: false,
        stoppedBy: "round-cap",
        summary: "plan was not accepted within 4 drafting round(s)",
        unresolvedRows: [`S1: ${"the find command pattern may miss files. ".repeat(5)}`],
      },
      runDir: ".pi/locus-pi/runs/20260730-162453-000e",
    });

    const narrow = component.render(60).join("\n");
    // The verdict line is clipped to the terminal, so the panel has to name where
    // the whole reason is. Without this the operator's only lead was `saved:`.
    expect(narrow).toContain("read the full reason: /workflows status 000e");
    expect(narrow).not.toContain("/workflows result");
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("chooses a deterministic semantic completion without exposing arbitrary JSON", () => {
    const cases: Array<{ result: unknown; expected: string }> = [
      {
        result: { summary: "  candidates\n agree  ", verdict: "ignored", secret: { raw: true } },
        expected: "✓ candidates agree",
      },
      { result: { summary: "", verdict: "accepted", secret: { raw: true } }, expected: "✓ accepted" },
      { result: { verdict: false, secret: { raw: true } }, expected: "✓ false" },
      { result: "  plain result  ", expected: "✓ plain result" },
      { result: { match: true, secret: { raw: true } }, expected: "✓ completed" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 220 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", `summary-${index}`);
      component.finish({ ok: true, result: testCase.result });
      const text = component.render(220).join("\n");
      expect(text).toContain(testCase.expected);
      expect(text).not.toContain("secret");
      expect(text).not.toContain(JSON.stringify(testCase.result));
    }
  });

  it.each([220, 146])("keeps the semantic result readable and raw JSON out of the main widget at width %i", (width) => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: width } };
    const component = new WorkflowProgressComponent(tui, {}, "visibility-smoke", `width-${width}`);
    const verdict = "result1=55 result2=55 match=true";

    component.finish({
      ok: true,
      result: { verdict, rawEvidence: { first: 55, second: 55, nested: [1, 2, 3] } },
    });

    const rendered = component.render(width);
    expect(rendered).toContain(`✓ ${verdict}`);
    expect(rendered.join("\n")).not.toContain("rawEvidence");
    expect(rendered.every((renderedLine) => renderedLine.length <= width)).toBe(true);
  });

  it("renders the REQ-004 `└ <verb> · <gist>` action sub-line beneath a row while a tool is active (T-196)", () => {
    agentLiveStore.reset();
    try {
      agentLiveStore.begin({
        id: "workflow:dedupe-r1:reviewer:step:smoke",
        agentName: "reviewer",
        label: "reviewer (step)",
        isolated: false,
        noMcp: false,
      });
      const child = agentLiveStore.begin({
        parentRowId: "workflow:dedupe-r1:reviewer:step:smoke",
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "working", currentTools: [], stepCount: 1 });

      // «thinking» kind (no active tool): still no sub-line, never the old `[current task]`.
      const idle = renderAgentLiveRowsText();
      expect(idle).toContain("SDK child session");
      expect(idle).not.toContain("[current task]");
      expect(idle).not.toContain("└");

      // Tool active → a `└ <verb> · <gist>` sub-line appears (bash → command-head),
      // with no raw arg-soup (`{`) and no old `tool=`/`[current task]` markers.
      agentLiveStore.patch(child.id, {
        currentTools: ["bash"],
        currentToolArgs: '{"command":"npm test -- sums.spec"}',
      });
      const active = renderAgentLiveRowsText();
      expect(active).toContain("└ bash · npm test");
      expect(active).not.toContain("[current task]");
      expect(active).not.toContain("{");
      expect(active).not.toContain("tool=bash");
    } finally {
      agentLiveStore.reset();
    }
  });

  it("keeps a wide-character agent message inside the exact terminal width", () => {
    agentLiveStore.reset();
    try {
      const width = 210;
      const runId = "wide-message-r1";
      const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: width } };
      const component = new WorkflowProgressComponent(tui, {}, "handoff-smoke/answer", runId, {
        scope: "workflow",
      });
      const parentLine = line({
        kind: "agent_start",
        agent: "default",
        label: "route planning readiness",
        phase: "readiness-route",
        ts: 1,
        runId,
      });
      const parentRowId = workflowAgentLiveRowId(parentLine);
      pushProgress(component, parentLine);
      const child = agentLiveStore.begin({
        parentRowId,
        agentName: "default",
        label: "route planning readiness",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, {
        status: "working",
        latestMessage:
          "Based on my analysis, I can now determine whether we have enough verified evidence. Requirements: 1. ✅ Target behavior " +
          "x".repeat(240),
      });

      const rendered = component.render(width);
      expect(rendered.some((renderedLine) => renderedLine.includes("✅ Target behavior"))).toBe(true);
      expect(rendered.every((renderedLine) => visibleWidth(renderedLine) <= width)).toBe(true);
      component.dispose();
    } finally {
      agentLiveStore.reset();
    }
  });
});
