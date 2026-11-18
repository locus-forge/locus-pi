import { expect, it, vi } from "vitest";
import { createWorkflowTranscript } from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import { WorkflowProgressComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
import type { RunWorkflowScriptResult } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";

function render(surface: string, result: RunWorkflowScriptResult): string {
  if (surface === "transcript")
    return createWorkflowTranscript(createHarness().ctx, "counter", "command").finish(result).digest;
  const component = new WorkflowProgressComponent(
    { requestRender() {}, terminal: { rows: 30, columns: 180 } },
    {},
    "counter",
    result.runId,
  );
  component.finish(result);
  return component.render(180).join("\n");
}
const saved: RunWorkflowScriptResult = {
  runId: "20261102-000000-a0df",
  runDir: "/tmp/counter",
  ok: true,
  result: { status: "arbitrary-user-value", nested: { meaning: "unknown" } },
  journal: [],
  resultPersistence: { ok: true, path: "/tmp/counter/runtime/result.json" },
};

it.each(["transcript", "progress"])(
  "links the successful structured %s result without guessing a verdict",
  (surface) => {
    const frame = render(surface, saved);
    expect(frame).toContain("result record: /tmp/counter/runtime/result.json");
    expect(frame).toContain("inspect run: /workflows status a0df");
    expect(frame).not.toContain("/workflows result");
    expect(frame).not.toContain("arbitrary-user-value");
  },
);

it.each(["transcript", "progress"])("keeps prose navigation separate in the %s", (surface) => {
  const frame = render(surface, { ...saved, result: "Complete prose", resultTextPath: "/tmp/counter/result.md" });
  expect(frame).toContain("full result: /tmp/counter/result.md");
  expect(frame).toContain("read full result: /workflows result a0df");
  expect(frame).not.toContain("result record:");
});

it.each(["transcript", "progress"])("does not advertise an unpersisted result record in the %s", (surface) => {
  const frame = render(surface, {
    ...saved,
    ok: false,
    resultPersistence: {
      ok: false,
      path: "/tmp/counter/runtime/result.json",
      code: "WORKFLOW_RESULT_WRITE_FAILED",
      message: "blocked",
    },
  });
  expect(frame).not.toContain("result record:");
  expect(frame).not.toContain("/tmp/counter/runtime/result.json");
  expect(frame).not.toContain("/workflows result");
});

it.each(["transcript", "progress"])("treats an empty prose path as absent in the %s", (surface) => {
  const frame = render(surface, { ...saved, resultTextPath: "" });
  expect(frame).toContain("result record: /tmp/counter/runtime/result.json");
  expect(frame).not.toContain("/workflows result");
});

it.each(["transcript", "progress"])(
  "keeps a written prose file usable after canonical persistence fails in the %s",
  (surface) => {
    const frame = render(surface, {
      ...saved,
      ok: false,
      result: "Text was written",
      resultTextPath: "/tmp/counter/result.md",
      resultPersistence: {
        ok: false,
        path: "/tmp/counter/runtime/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED",
        message: "blocked",
      },
    });
    expect(frame).toContain("full result: /tmp/counter/result.md");
    expect(frame).toContain("inspect run: /workflows status a0df");
    expect(frame).not.toContain("/workflows result");
    expect(frame).not.toContain("/tmp/counter/runtime/result.json");
  },
);

it("does not promise a text command without canonical persistence evidence in a legacy progress caller", () => {
  const component = new WorkflowProgressComponent(
    { requestRender() {}, terminal: { rows: 30, columns: 180 } },
    {},
    "counter",
    saved.runId,
  );
  component.finish({ ok: true, result: "Text", resultTextPath: "/tmp/counter/result.md" });
  const frame = component.render(180).join("\n");
  expect(frame).toContain("full result: /tmp/counter/result.md");
  expect(frame).toContain("inspect run: /workflows status a0df");
  expect(frame).not.toContain("/workflows result");
});

it("points a clipped prose verdict at the file and the command that show all of it", () => {
  const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 60 } };
  const component = new WorkflowProgressComponent(tui, {}, "review", "20260726-212752-98cc");

  component.finish({
    ok: true,
    result: `# Code Review\n\n${"A verdict far wider than this terminal. ".repeat(6)}`,
    runDir: ".pi/locus-pi/runs/20260726-212752-98cc",
    resultTextPath: ".pi/locus-pi/runs/20260726-212752-98cc/result.md",
    resultPersistence: { ok: true, path: ".pi/locus-pi/runs/20260726-212752-98cc/runtime/result.json" },
  });

  const narrow = component.render(60).join("\n");
  // The command names the run, so it is usable even where the panel clips paths.
  expect(narrow).toContain("read full result: /workflows result 98cc");
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
  expect(narrow).toContain("read full reason: /workflows status 000e");
  expect(narrow).not.toContain("/workflows result");
  for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
});
