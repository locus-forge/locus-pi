import { expect, it } from "vitest";
import {
  activityStore,
  activityStripItems,
  renderActivityStrip,
  projectWorkflowActivityPhase,
} from "../../../../extensions/_shared/agent-runtime/activity-store.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import { project, writeWorkflow } from "../../../fixtures/workflow-durable-project.js";

it("projects only each run's ungrouped declared phase and preserves last phase after completion", async () => {
  const root = project();
  writeWorkflow(root, "phase-child", 'export default dsl => { dsl.phase("Child phase"); return "child done"; };');
  writeWorkflow(
    root,
    "phase-root",
    `export default async dsl => {
    dsl.phase("Root prepare");
    await dsl.parallel([async () => { dsl.phase("Branch A"); return "a"; }, async () => { dsl.phase("Branch B"); return "b"; }]);
    await dsl.invokeWorkflow({scriptPath:".locus-pi/workflows/phase-child.workflow.mjs", key:"child", keys:["child"]});
    return "root done";
  };`,
  );
  const h = createHarness(root);
  let rootId = "";
  const seen: string[] = [];
  const snapshots: { phase: string | undefined; strip: string }[] = [];
  const result = await runWorkflowScript({
    pi: h.pi,
    ctx: h.ctx,
    signal: new AbortController().signal,
    name: "phase-root",
    onRunStart: (run) => {
      rootId = run.runId;
    },
    onEvent: (line) => {
      if (line.kind === "phase") {
        seen.push(line.phase!);
        snapshots.push({
          phase: activityStore.workflows.get(rootId)?.phase,
          strip: renderActivityStrip(80).join("\n"),
        });
      }
    },
  });
  expect(result.ok, result.error).toBe(true);
  expect(seen).toEqual(["Root prepare", "Branch A", "Branch B", "Child phase"]);
  expect(snapshots).toHaveLength(4);
  for (const snapshot of snapshots) {
    expect(snapshot.phase).toBe("Root prepare");
    expect(snapshot.strip).toContain("Root prepare");
  }
  expect(activityStore.workflows.get(rootId)).toMatchObject({ phase: "Root prepare", status: "completed" });
  const timing = activityStore.workflows.get(rootId)!;
  expect(timing.startedAt).toEqual(expect.any(Number));
  expect(timing.finishedAt).toEqual(expect.any(Number));
  expect(timing.finishedAt!).toBeGreaterThanOrEqual(timing.startedAt!);
  expect([...activityStore.workflows.values()].find((run) => run.parentRunId === rootId)?.phase).toBe("Child phase");
});
it("supports no observer, absent phases and old-shaped reload stores without inferred defaults", async () => {
  const root = project();
  writeWorkflow(root, "plain", 'export default () => "done";');
  const h = createHarness(root);
  const result = await runWorkflowScript({ pi: h.pi, ctx: h.ctx, signal: new AbortController().signal, name: "plain" });
  expect(activityStore.workflows.get(result.runId)).not.toHaveProperty("phase");
  const workflows = new Map(activityStore.workflows);
  const old = {
    workflows,
    workflow(value: typeof workflows extends Map<string, infer T> ? T : never) {
      workflows.set(value.runId, value);
    },
  };
  projectWorkflowActivityPhase(result.runId, "  ", old);
  expect(workflows.get(result.runId)).not.toHaveProperty("phase");
  projectWorkflowActivityPhase(result.runId, "Observed", old);
  expect(workflows.get(result.runId)?.phase).toBe("Observed");
});
it("does not suppress the phase observer when the read-only projection listener throws", async () => {
  const root = project();
  writeWorkflow(root, "phase", 'export default dsl => { dsl.phase("Observed"); return "done"; };');
  const h = createHarness(root);
  let received = false;
  const bad = () => {
    if (
      [...activityStore.workflows.values()].some(
        (run) => run.projectRoot === root && run.phase === "Observed" && run.status === "running",
      )
    )
      throw new Error("presentation listener failed");
  };
  activityStore.emitter.on("change", bad);
  try {
    const result = await runWorkflowScript({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      name: "phase",
      onEvent: (line) => {
        if (line.kind === "phase") received = true;
      },
    });
    expect(result.ok, result.error).toBe(true);
    expect(received).toBe(true);
  } finally {
    activityStore.emitter.off("change", bad);
  }
});
it("captures sequential phase without an external observer and retains it across operator handoff", async () => {
  const root = project();
  writeWorkflow(
    root,
    "waiting",
    'export default dsl => { dsl.phase("Prepare"); dsl.phase("Review"); dsl.awaitOperator({reason:"Choose next step"}); return "ready"; };',
  );
  const h = createHarness(root);
  const result = await runWorkflowScript({
    pi: h.pi,
    ctx: h.ctx,
    signal: new AbortController().signal,
    name: "waiting",
  });
  expect(result.disposition?.status).toBe("awaiting_operator");
  expect(activityStore.workflows.get(result.runId)).toMatchObject({ phase: "Review", status: "awaiting_operator" });
});
