import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { executor, project, writeWorkflow } from "../../../../fixtures/workflow-durable-project.js";
import { createHarness } from "../../../../test-harness.js";

// Entry-only trusted JavaScript can materialize metadata after static admission.
describe("removed placement contracts before child work", () => {
  it.each(["root", "saved-child"])("refuses spread metadata in a %s before agents start", async (mode) => {
    const root = project();
    const harness = createHarness(root);
    let calls = 0;
    try {
      writeWorkflow(
        root,
        "retired",
        `const legacy = { outputDir: "reports" };
export const meta = { identityCoverage: "entry-only", ...legacy };
export default async function run(dsl) { return await dsl.agent("must not run"); }`,
      );
      writeWorkflow(
        root,
        "parent",
        `export default async function run(dsl) {
  return await dsl.invokeWorkflow({ name: "retired", key: "child", keys: ["child"] });
}`,
      );
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: mode === "root" ? "retired" : "parent",
        createExecutor: executor(() => {
          calls += 1;
          return "must not run";
        }),
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("meta.outputDir was removed");
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'const method = "output" + "Dir"; return dsl[method]();',
    'const method = "publishPrimary" + "File"; return dsl[method]("report.md");',
    'const source = { workflowSource: "workflow.mjs" }; return dsl.publishPrimaryArtifact("workflow.mjs", source);',
  ])("fails dynamic removed use with migration guidance: %s", async (body) => {
    const root = project();
    const harness = createHarness(root);
    try {
      writeWorkflow(root, "retired", `export default async function run(dsl) { ${body} }`);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "retired",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("removed");
      expect(result.journal.some((line) => line.kind === "agent_start")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
