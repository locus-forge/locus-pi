import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkflowRunResult } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import { executor, project, writeWorkflow } from "../../../fixtures/workflow-durable-project.js";

/**
 * T-218 W13 — the ordered pre-execution admission (`workflow-run-admission.ts`).
 *
 * These cases pin the WORKSPACE ADMISSION step: which workspace a launch may
 * write, what an owner workflow requires of it before any child starts, and what
 * a refusal is forbidden to leave behind. The run claim and first journal
 * prelude, which happen BEFORE admission, stay pinned in workflow-startup.test.ts.
 */

describe("workspace admission before execution", () => {
  it("gives post-code-review a unique default planning workspace", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.workspaceDirRelative).toBe(`.locus-pi/workspaces/${result.runId}-post-code-review`);
    expect(existsSync(path.join(root, result.workspaceDirRelative!))).toBe(true);
  });

  it("creates an empty style.md before post-code-review executes", async () => {
    const root = project();
    const styleFile = path.join(root, "tmp", "post-code-review", "empty-style", "style.md");
    writeWorkflow(
      root,
      "post-code-review",
      `import { readFileSync } from "node:fs";
export default () => readFileSync(${JSON.stringify(styleFile)}, "utf8");
`,
    );
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/empty-style",
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.result).toBe("");
    expect(readFileSync(styleFile, "utf8")).toBe("");
  });

  it("preserves an existing post-code-review style.md", async () => {
    const root = project();
    const outputDir = "tmp/post-code-review/custom-style";
    const styleFile = path.join(root, outputDir, "style.md");
    mkdirSync(path.dirname(styleFile), { recursive: true });
    writeFileSync(styleFile, "Prefer domain names over abbreviations.\n", "utf8");
    writeWorkflow(
      root,
      "post-code-review",
      `import { readFileSync } from "node:fs";
export default () => readFileSync(${JSON.stringify(styleFile)}, "utf8");
`,
    );
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir,
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.result).toBe("Prefer domain names over abbreviations.\n");
    expect(readFileSync(styleFile, "utf8")).toBe("Prefer domain names over abbreviations.\n");
  });

  it("rejects a symlinked post-code-review style.md without touching its target", async () => {
    const root = project();
    const outputDir = "tmp/post-code-review/symlinked-style";
    const workspace = path.join(root, outputDir);
    const outside = path.join(root, "outside-style.md");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, path.join(workspace, "style.md"));
    writeWorkflow(root, "post-code-review", `export default () => "must not run";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/style\.md|symbolic link|symlink|regular file/u);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("rejects fresh post-code-review reuse while allowing exact resume", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "first semantic target",
      outputDir: "tmp/post-code-review/review-one",
    });
    expect(first.ok, first.error).toBe(true);

    const secondHarness = createHarness(root);
    const fresh = await runWorkflowScript({
      pi: secondHarness.pi,
      ctx: secondHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "different semantic target",
      outputDir: "tmp/post-code-review/review-one",
    });
    expect(fresh.ok).toBe(false);
    expect(fresh.error).toContain("choose a new --run-name or --output-dir, or resume the original run");

    const distinctHarness = createHarness(root);
    const distinct = await runWorkflowScript({
      pi: distinctHarness.pi,
      ctx: distinctHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "different semantic target",
      outputDir: "tmp/post-code-review/review-two",
    });
    expect(distinct.ok, distinct.error).toBe(true);

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "first semantic target",
      outputDir: "tmp/post-code-review/review-one",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe("tmp/post-code-review/review-one");
  });

  it("does not recreate a removed workspace when fresh owner state rejects", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "first semantic target",
      outputDir: "tmp/post-code-review/removed-workspace",
    });
    expect(first.ok, first.error).toBe(true);
    rmSync(path.join(root, "tmp", "post-code-review"), { recursive: true, force: true });

    const freshHarness = createHarness(root);
    const fresh = await runWorkflowScript({
      pi: freshHarness.pi,
      ctx: freshHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "second semantic target",
      outputDir: "tmp/post-code-review/removed-workspace",
    });
    expect(fresh.ok).toBe(false);
    expect(fresh.error).toContain("already has durable post-code-review state");
    expect(existsSync(path.join(root, "tmp", "post-code-review"))).toBe(false);
  });
});
