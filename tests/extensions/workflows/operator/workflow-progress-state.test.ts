/**
 * Component state: the live tick, the render scheduler, store and fleet
 * subscriptions, the frame-identity cache and the finish/dispose lifecycle owned
 * by `operator/progress-widget.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowProgressComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { DEFAULT_RENDER_MIN_INTERVAL_MS } from "../../../../extensions/_shared/host/render-scheduler.js";
import { applyWorkflowJournalLineToAgentLiveStore } from "../../../../extensions/workflows/runtime/workflow-live.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { clearViewerExternalRows } from "../../../../extensions/_shared/operator/viewer-geometry.js";

afterEach(() => clearViewerExternalRows("workflow-live"));

function line(input: Omit<WorkflowJournalLine, "ts"> & { ts: string | number }): WorkflowJournalLine {
  return input as WorkflowJournalLine;
}

function pushProgress(component: WorkflowProgressComponent, event: WorkflowJournalLine): void {
  applyWorkflowJournalLineToAgentLiveStore(event);
  component.push(event);
}

describe("workflow progress component state", () => {
  it("forces a live re-render for an in-flight agent and stops the timer when it ends", () => {
    // SPEC 1/D: a long-running agent whose state has not changed must still get its
    // elapsed column refreshed by a timer, not only on the next journal event.
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r1");

      pushProgress(component, line({ kind: "agent_start", agent: "slow", ts: 1, runId: "r1" }));
      const afterStart = tui.requestRender.mock.calls.length;

      // No new journal event — only wall-clock advances. The timer must drive renders.
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender.mock.calls.length).toBeGreaterThan(afterStart);

      // Agent ends -> timer retires -> further wall-clock ticks add no more renders.
      pushProgress(
        component,
        line({ kind: "agent_end", agent: "slow", status: "completed", durationMs: 3000, ts: 4, runId: "r1" }),
      );
      // Let any coalesced trailing render drain before sampling, so the count
      // below measures timer retirement rather than the throttle window.
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      const afterEnd = tui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(tui.requestRender.mock.calls.length).toBe(afterEnd);

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps live progress running after invalidation and stops only on dispose", () => {
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "invalidate-r1");

      pushProgress(component, line({ kind: "agent_start", agent: "slow", ts: 1, runId: "invalidate-r1" }));
      tui.requestRender.mockClear();

      component.invalidate();
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).toHaveBeenCalled();

      tui.requestRender.mockClear();
      component.dispose();
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops old journal lines and coalesces a push storm into a bounded number of renders", () => {
    // Regression guard for the WSL/Windows flicker: the store emits per SDK
    // event, and turning each one into a frame is what tore the panel. A burst
    // must collapse to one leading render plus one trailing flush — while the
    // last pushed state still survives into the projection.
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r");

      for (let i = 0; i < 199; i += 1) {
        pushProgress(component, line({ kind: "log", message: "x", ts: 1, runId: "r" }));
      }
      pushProgress(component, line({ kind: "log", message: "final-line", ts: 1, runId: "r" }));

      expect(tui.requestRender.mock.calls.length).toBeLessThanOrEqual(2);

      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      expect(tui.requestRender.mock.calls.length).toBeLessThanOrEqual(3);

      // Coalescing must never cost the newest state.
      const rendered = component.render(80);
      expect(rendered.length).toBeLessThanOrEqual(24);
      expect(rendered.join("\n")).toContain("final-line");

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the final frame on finish and stops rendering after dispose", () => {
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "finish-r1");

      pushProgress(component, line({ kind: "agent_start", agent: "slow", ts: 1, runId: "finish-r1" }));
      for (let i = 0; i < 20; i += 1) {
        pushProgress(component, line({ kind: "log", message: `x${i}`, ts: 1, runId: "finish-r1" }));
      }
      tui.requestRender.mockClear();

      component.finish({ ok: true, result: "done" });

      // The verdict frame is synchronous — never deferred behind the window.
      expect(tui.requestRender).toHaveBeenCalled();

      tui.requestRender.mockClear();
      vi.advanceTimersByTime(5000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calm mode stops all repaints while nothing visible changes, yet still paints transitions", () => {
    // The WSL guarantee: frozen spinner + coarse elapsed keep idle frames
    // byte-identical, so the liveness tick keeps firing but nothing reaches the
    // terminal until a real state transition.
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "calm-r1", { calm: true });
      pushProgress(component, line({ kind: "agent_start", agent: "slow", ts: 1, runId: "calm-r1" }));
      component.render(100);
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      tui.requestRender.mockClear();

      // Three liveness ticks with a frozen spinner and an unchanged elapsed
      // bucket: zero terminal writes.
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender).not.toHaveBeenCalled();

      // A real transition still paints.
      pushProgress(
        component,
        line({ kind: "agent_end", agent: "slow", status: "completed", durationMs: 3000, ts: 4, runId: "calm-r1" }),
      );
      expect(tui.requestRender).toHaveBeenCalled();

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips repaints when the projection is unchanged", () => {
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "quiet-r1", {
        scope: "workflow",
      });
      pushProgress(component, line({ kind: "agent_start", agent: "slow", ts: 1, runId: "quiet-r1" }));
      component.render(100);
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      tui.requestRender.mockClear();

      // A row belonging to a different run is outside this widget's projection,
      // so its churn must not reach the terminal at all.
      agentLiveStore.begin({ id: "unrelated-row", label: "unrelated", workflowRunId: "other-run" });
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 2);
      expect(tui.requestRender).not.toHaveBeenCalled();

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
