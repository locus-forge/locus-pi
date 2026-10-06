import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
import {
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowWorkspaceStateDir,
} from "../../../../../extensions/workflows/runtime/workflow-output.js";
import { createHarness } from "../../../../test-harness.js";
import { executor, project, writeWorkflow } from "../../../../fixtures/workflow-durable-project.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("group drain precedes runner finalization", () => {
  it.each(["cap", "cancel"] as const)(
    "holds result and workspace lease until the delayed sibling settles (%s)",
    async (stop) => {
      const root = project();
      const held = deferred(),
        started = deferred(),
        stopped = deferred();
      const controller = new AbortController();
      const name = `drain-${stop}`;
      writeWorkflow(
        root,
        name,
        `export default (dsl) => dsl.parallel([
      () => dsl.agent("held"),
      () => dsl.agent("other"),
      () => { dsl.log("late branch"); return "late"; },
    ]);\n`,
      );
      const harness = createHarness(root);
      let runDir = "",
        settled = false;
      const events: Array<{ kind: string; message?: string }> = [];
      const calls: string[] = [];
      const lock = path.join(
        workflowWorkspaceStateDir(root, `.locus-pi/workspaces/${name}`),
        WORKFLOW_WORKSPACE_LEASE_FILE,
      );
      const run = runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: controller.signal,
        name,
        runName: name,
        budget: { concurrency: 2, ...(stop === "cap" ? { totalAgents: 1 } : {}) },
        onRunStart: (run) => {
          runDir = run.runDir;
        },
        onEvent: (line) => {
          events.push(line);
          if (line.message?.includes("stopped by budget totalAgents")) stopped.resolve();
        },
        createExecutor: executor(async (prompt) => {
          calls.push(prompt);
          if (prompt === "held") {
            started.resolve();
            await held.promise;
          } else {
            await started.promise;
            controller.abort({ kind: "operator_stop" });
            stopped.resolve();
          }
          return "done";
        }),
      });
      const completion = run.then((result) => {
        settled = true;
        return result;
      });
      try {
        await started.promise;
        await stopped.promise;
        await tick();
        expect(settled).toBe(false);
        expect(existsSync(lock)).toBe(true);
        expect(existsSync(workflowResultFile(runDir))).toBe(false);
        expect(events.some((line) => line.kind === "group_end")).toBe(false);
        expect(events.some((line) => line.message === "late branch")).toBe(false);
      } finally {
        held.resolve();
      }
      try {
        const result = await completion;
        expect(result.ok).toBe(false);
        expect(result.disposition?.status).toBe(stop === "cancel" ? "cancelled" : "failed");
        expect(existsSync(lock)).toBe(false);
        expect(existsSync(workflowResultFile(runDir))).toBe(true);
        expect(events.some((line) => line.message === "late branch")).toBe(false);
        const lastAgentEnd = events.map((line) => line.kind).lastIndexOf("agent_end");
        expect(lastAgentEnd).toBeGreaterThanOrEqual(0);
        expect(events.findIndex((line) => line.kind === "group_end")).toBeGreaterThan(lastAgentEnd);
        expect(calls).toEqual(stop === "cap" ? ["held"] : ["held", "other"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
