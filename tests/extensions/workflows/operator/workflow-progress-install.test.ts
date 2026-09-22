/**
 * Host installation: how `installWorkflowProgress` and `installWorkflowTextWidget`
 * hand a component to Pi — factory shape, placement, and the non-UI short circuit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import workflowsExt from "../../../../extensions/workflows/index.js";
import {
  WorkflowProgressComponent,
  WorkflowTextComponent,
  installWorkflowProgress,
  installWorkflowTextWidget,
} from "../../../../extensions/workflows/operator/progress-widget.js";
import { applyWorkflowJournalLineToAgentLiveStore } from "../../../../extensions/workflows/runtime/workflow-live.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";
import { clearViewerExternalRows } from "../../../../extensions/_shared/operator/viewer-geometry.js";

afterEach(() => clearViewerExternalRows("workflow-live"));

function line(input: Omit<WorkflowJournalLine, "ts"> & { ts: string | number }): WorkflowJournalLine {
  return input as WorkflowJournalLine;
}

function pushProgress(component: WorkflowProgressComponent, event: WorkflowJournalLine): void {
  applyWorkflowJournalLineToAgentLiveStore(event);
  component.push(event);
}

describe("workflow progress host installation", () => {
  it("installs the fleet widget below the editor as a factory instead of a constructed component", () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;

    installWorkflowProgress(harness.ctx, "workflows", "live-smoke", "placeholder");

    // REQ-007: passive fleet rows stay below the editor while focus temporarily
    // replaces only the editor component.
    expect(harness.widgetOptions.get("workflows")).toEqual({ placement: "belowEditor" });
    const factory = harness.widgetPayloads.get("workflows") ?? harness.widgets.get("workflows");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => WorkflowProgressComponent)(stubTui, {});
    expect(typeof component.render).toBe("function");
    expect(typeof component.invalidate).toBe("function");
    expect(typeof component.dispose).toBe("function");
    expect((factory as (...args: unknown[]) => unknown).length).toBe(2);
  });

  it("installWorkflowProgress short-circuits setWidget when ctx.hasUI is not true", () => {
    // SPEC 5/F: a strict boolean gate. On a non-UI host (hasUI false) and on an
    // unknown host (hasUI absent/undefined) the function must NOT touch setWidget,
    // yet must still return a live component the headless caller can drive.
    for (const present of [true, false]) {
      const harness = createHarness();
      const setWidget = vi.fn();
      // present=true -> explicit non-UI host (hasUI false); present=false -> unknown
      // host (hasUI absent entirely). exactOptionalPropertyTypes forbids assigning
      // `undefined`, so model "absent" with delete rather than a write.
      if (present) harness.ctx.hasUI = false;
      else delete harness.ctx.hasUI;
      harness.ctx.ui.setWidget = setWidget;

      const component = installWorkflowProgress(harness.ctx, "workflows", "live-smoke", "placeholder");

      expect(setWidget).not.toHaveBeenCalled();
      expect(harness.widgetPayloads.has("workflows")).toBe(false);
      // The returned component is still live: push/finish must be harmless no-ops.
      expect(() => {
        pushProgress(component, line({ kind: "agent_start", agent: "a", ts: 1, runId: "r" }));
        component.finish({ ok: true });
      }).not.toThrow();
    }
  });

  it("static workflow text widgets self-clamp instead of relying on host string-array truncation", () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;

    installWorkflowTextWidget(
      harness.ctx,
      "workflows",
      Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
    );

    const factory = harness.widgetPayloads.get("workflows") ?? harness.widgets.get("workflows");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: vi.fn(), terminal: { rows: 14, columns: 80 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
    const rendered = component.render(80);
    expect(rendered.length).toBeLessThanOrEqual(14 - 6);
    expect(rendered.some((renderedLine) => renderedLine.includes("widget truncated"))).toBe(false);
  });

  it("places an unknown workflow warning above the editor", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflowsExt(harness.pi);

    await harness.commands.get("workflows")!.handler("unexpected", harness.ctx);

    expect(harness.widgets.get("workflows")).toContain("[WARN] Workflow command");
    expect(harness.widgetOptions.get("workflows")).toEqual({ placement: "aboveEditor" });
  });

  it("list fallback and status install static widget factories on UI hosts", async () => {
    for (const commandText of ["list", "status"]) {
      const harness = createHarness();
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      await handler(commandText, harness.ctx);

      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 100 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      expect(component.render(100).join("\n")).not.toContain("widget truncated");
    }
  });
});
