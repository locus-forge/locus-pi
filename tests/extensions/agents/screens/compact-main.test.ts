import { expect, it } from "vitest";
import { WorkflowProgressComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
it("modern main has no duplicate passive roster or unknown metrics; errors and handoff remain actionable", () => {
  const panel = new WorkflowProgressComponent({ requestRender() {} }, {}, "flow.mjs", "run1", {
    compactActivity: true,
    scope: "workflow",
  });
  expect(panel.render(80)).toEqual([]);
  panel.finish({ ok: true, disposition: { status: "completed" } });
  expect(panel.render(80)).toEqual([]);
  panel.finish({ ok: false, error: "Validation failed" });
  expect(panel.render(80).join("\n")).toContain("Validation failed");
  expect(panel.render(80).join("\n")).toContain("/workflows status");
  expect(panel.render(80).join("\n")).not.toMatch(/phase=|tok:|waiting for workflow agents/);
  panel.finish({ ok: true, disposition: { status: "awaiting_operator", detail: "Approve next step" } });
  expect(panel.render(80).join("\n")).toContain("Approve next step");
  expect(panel.render(80)).toHaveLength(2);
  panel.dispose();
});
