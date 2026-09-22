import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWorkflowOutputDirectory,
  WORKFLOW_OUTPUT_LOCK_FILE,
  workflowOutputStateDir,
} from "../../../../extensions/workflows/runtime/workflow-output.js";
import { readWorkflowRunResult } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowTarget } from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { createHarness } from "../../../test-harness.js";
import { executor, project, writeWorkflow, writeWorkflowTree } from "../../../fixtures/workflow-durable-project.js";

describe("stable workflow output paths", () => {
  it("does not fall back to a legacy source after a bound canonical source disappears", async () => {
    const root = project();
    const piWorkflow = path.join(root, ".locus-pi", "workflows", "switch.workflow.mjs");
    writeWorkflow(root, "switch", `export default () => "project-source";\n`);
    const target = resolveWorkflowTarget({ name: "switch" }, root, root);
    rmSync(piWorkflow);
    mkdirSync(path.join(root, ".claude", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "workflows", "switch.workflow.mjs"), 'export default () => "shadow";\n');

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      targetBinding: target,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing|snapshot|target|ENOENT/u);
    expect(result.result).not.toBe("shadow");
  });

  it.each([
    { kind: "name", ref: "switch", source: "personal", path: "PLACEHOLDER" },
    { kind: "name", ref: "other", source: "project", path: "PLACEHOLDER" },
  ])("rejects forged target binding %j", async (forged) => {
    const root = project();
    writeWorkflow(root, "switch", `export default () => "project-source";\n`);
    const target = resolveWorkflowTarget({ name: "switch" }, root, root);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      targetBinding: { ...forged, path: target.path } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/binding|source|request/u);
  });

  it("rejects a target binding whose path ancestor is a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-bound-target-"));
    writeFileSync(path.join(outside, "switch.workflow.mjs"), 'export default () => "outside";\n');
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    rmSync(path.join(root, ".locus-pi", "workflows"), { recursive: true, force: true });
    symlinkSync(outside, path.join(root, ".locus-pi", "workflows"), "dir");
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      targetBinding: {
        kind: "name",
        ref: "switch",
        source: "project",
        path: path.join(root, ".locus-pi", "workflows", "switch.workflow.mjs"),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symlink|binding|canonical/u);
  });

  it("accepts an internally confined target symlink after physical proof", async () => {
    const root = project();
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    const real = path.join(root, ".locus-pi", "workflows", "switch.workflow.mjs");
    const alias = path.join(root, ".locus-pi", "workflows", "alias.workflow.mjs");
    writeFileSync(real, 'export default () => "project-source";\n');
    symlinkSync(real, alias);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: ".locus-pi/workflows/alias.workflow.mjs",
      targetBinding: {
        kind: "scriptPath",
        ref: ".locus-pi/workflows/alias.workflow.mjs",
        source: "project",
        path: alias,
      },
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toBe("project-source");
  });

  it("rejects a target binding when multiple public target fields are supplied", async () => {
    const root = project();
    writeWorkflow(root, "switch", `export default () => "project-source";\n`);
    const target = resolveWorkflowTarget({ name: "switch" }, root, root);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      scriptPath: "switch.workflow.mjs",
      targetBinding: target,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exactly one public target field");
  });

  it("rejects a .tasks workspace whose root escapes the project through a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-tasks-outside-"));
    symlinkSync(outside, path.join(root, ".tasks"), "dir");
    writeWorkflow(root, "empty", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
      outputDir: ".tasks/T-144/artifacts",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("symlink");
  });

  it.each([
    ["task/draft", "task-draft"],
    ["task/plan", "task-plan"],
  ])("gives every fresh %s run a distinct timestamped task workspace", async (name, slug) => {
    const root = project();
    writeWorkflowTree(root, "task", {
      draft: `export const meta = { name: "task/draft" };\nexport default (dsl) => dsl.outputDir();\n`,
      plan: `export const meta = { name: "task/plan" };\nexport default (dsl) => dsl.outputDir();\n`,
    });

    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name,
    });
    const secondHarness = createHarness(root);
    const second = await runWorkflowScript({
      pi: secondHarness.pi,
      ctx: secondHarness.ctx,
      signal: new AbortController().signal,
      name,
    });

    expect(first.ok, first.error).toBe(true);
    expect(second.ok, second.error).toBe(true);
    expect(first.workspaceDirRelative).toBe(`.locus-pi/workspaces/${first.runId}-${slug}`);
    expect(second.workspaceDirRelative).toBe(`.locus-pi/workspaces/${second.runId}-${slug}`);
    expect(second.workspaceDirRelative).not.toBe(first.workspaceDirRelative);
  });

  it("expands one runName to the same planning workspace across workflows", async () => {
    const root = project();
    writeWorkflow(root, "ordinary", `export default (dsl) => dsl.outputDir();\n`);
    writeWorkflowTree(root, "task", {
      draft: `export const meta = { name: "task/draft" };\nexport default (dsl) => dsl.outputDir();\n`,
      plan: `export const meta = { name: "task/plan" };\nexport default (dsl) => dsl.outputDir();\n`,
    });

    for (const name of ["ordinary", "task/draft", "task/plan"]) {
      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name,
        runName: "airflow-builder",
      });
      expect(result.ok, result.error).toBe(true);
      expect(result.workspaceDirRelative).toBe(".locus-pi/workspaces/airflow-builder");
    }
  });

  it("reuses a legacy named workspace without changing its checkpoint namespace", async () => {
    const root = project();
    const runName = "legacy-builder";
    const legacyWorkspace = `.locus-pi/plans/${runName}`;
    mkdirSync(path.join(root, legacyWorkspace), { recursive: true });
    writeFileSync(path.join(root, legacyWorkspace, "marker.txt"), "legacy\n", "utf8");
    writeWorkflow(root, "legacy-named", `export default (dsl) => dsl.outputDir();\n`);
    const legacyIdentity = resolveWorkflowOutputDirectory(root, legacyWorkspace, "unused", root, {
      create: false,
    }).identity;
    const stateDirBefore = workflowOutputStateDir(root, legacyIdentity);

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "legacy-named",
      runName,
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.workspaceDirRelative).toBe(legacyWorkspace);
    expect(result.workspacePhysicalIdentity).toBe(legacyIdentity);
    expect(workflowOutputStateDir(root, result.workspacePhysicalIdentity!)).toBe(stateDirBefore);
    expect(readFileSync(path.join(result.workspaceDir!, "marker.txt"), "utf8")).toBe("legacy\n");
  });

  it("fails a dual-root runName before child work", async () => {
    const root = project();
    const runName = "ambiguous-builder";
    mkdirSync(path.join(root, ".locus-pi", "workspaces", runName), { recursive: true });
    mkdirSync(path.join(root, ".locus-pi", "plans", runName), { recursive: true });
    writeWorkflow(root, "ambiguous-named", `export default (dsl) => dsl.agent("must not run");\n`);
    let calls = 0;

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "ambiguous-named",
      runName,
      createExecutor: executor(() => {
        calls += 1;
        return "unexpected";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      "both .locus-pi/workspaces/ambiguous-builder and .locus-pi/plans/ambiguous-builder exist",
    );
    expect(calls).toBe(0);
  });

  it("resumes through the recorded legacy binding even when both named roots later exist", async () => {
    const root = project();
    const runName = "resume-legacy-builder";
    const legacyWorkspace = `.locus-pi/plans/${runName}`;
    mkdirSync(path.join(root, legacyWorkspace), { recursive: true });
    writeWorkflow(root, "resume-named", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-named",
      runName,
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspaceDirExplicit).toBe(false);
    mkdirSync(path.join(root, ".locus-pi", "workspaces", runName), { recursive: true });

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-named",
      runName,
      resumeFromRunId: first.runId,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe(legacyWorkspace);
    expect(resumed.workspacePhysicalIdentity).toBe(first.workspacePhysicalIdentity);
  });

  it.each(["current", "legacy"] as const)(
    "rejects a mismatched runName when resuming a %s named workspace",
    async (workspaceKind) => {
      const root = project();
      const runName = `${workspaceKind}-resume-name`;
      if (workspaceKind === "legacy") {
        mkdirSync(path.join(root, ".locus-pi", "plans", runName), { recursive: true });
      }
      writeWorkflow(root, "resume-name-match", `export default (dsl) => dsl.outputDir();\n`);
      const harness = createHarness(root);
      const first = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "resume-name-match",
        runName,
      });
      expect(first.ok, first.error).toBe(true);

      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "resume-name-match",
        runName: "different-name",
        resumeFromRunId: first.runId,
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.error).toContain('runName "different-name" does not match the source workspace');
      expect(existsSync(path.join(root, ".locus-pi", "workspaces", "different-name"))).toBe(false);
      expect(existsSync(path.join(root, ".locus-pi", "plans", "different-name"))).toBe(false);
    },
  );

  it("rejects a missing explicit legacy workspace instead of recreating the retired root", async () => {
    const root = project();
    writeWorkflow(root, "missing-legacy", `export default (dsl) => dsl.agent("must not run");\n`);
    let calls = 0;

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "missing-legacy",
      outputDir: ".locus-pi/plans/missing-legacy",
      createExecutor: executor(() => {
        calls += 1;
        return "unexpected";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing|does not exist|identity is unavailable/u);
    expect(existsSync(path.join(root, ".locus-pi", "plans", "missing-legacy"))).toBe(false);
    expect(calls).toBe(0);
  });

  it("persists a bounded lease-release finalization error", async () => {
    const root = project();
    const runName = "lease-finalization";
    const workspace = path.join(root, ".locus-pi", "workspaces", runName);
    const lockFile = path.join(workspace, WORKFLOW_OUTPUT_LOCK_FILE);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-lease-finalization-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    writeWorkflow(root, "lease-finalization", `export default (dsl) => dsl.agent("replace lease");\n`);
    const controller = new AbortController();

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: controller.signal,
      name: "lease-finalization",
      runName,
      onEvent: (line) => {
        if (line.message?.startsWith("[workflow:cancelled]") !== true) return;
        rmSync(lockFile);
        symlinkSync(sentinel, lockFile, "file");
      },
      createExecutor: executor(() => {
        controller.abort({ kind: "operator_stop" });
        return "done";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.finalizationErrors).toEqual([
      { stage: "lease-release", message: expect.stringContaining("lease release failed") },
    ]);
    const persisted = JSON.parse(readFileSync(workflowResultFile(result.runDir), "utf8")) as {
      journal?: unknown;
      finalizationErrors?: Array<{ stage: string; message: string }>;
    };
    expect(persisted.journal).toBeUndefined();
    expect(persisted.finalizationErrors).toEqual(result.finalizationErrors);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(lockFile);
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects unsafe and conflicting runName selections", async () => {
    const root = project();
    writeWorkflowTree(root, "task", {
      draft: `export const meta = { name: "task/draft" };\nexport default (dsl) => dsl.outputDir();\n`,
    });

    for (const options of [
      { name: "task/draft", runName: "../escape" },
      { name: "task/draft", runName: "named", outputDir: "tmp/conflict" },
    ]) {
      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        ...options,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/runName|mutually exclusive/u);
    }
  });

  it("accepts confined absolute and dot-relative outputDir paths", async () => {
    const root = project();
    const workingDirectory = path.join(root, "packages", "docs");
    mkdirSync(workingDirectory, { recursive: true });
    writeWorkflow(root, "paths", `export default (dsl) => dsl.outputDir();\n`);

    const absoluteHarness = createHarness(root);
    const absolute = await runWorkflowScript({
      pi: absoluteHarness.pi,
      ctx: absoluteHarness.ctx,
      signal: new AbortController().signal,
      name: "paths",
      outputDir: path.join(root, "custom", "absolute"),
    });
    expect(absolute.ok, absolute.error).toBe(true);
    expect(absolute.workspaceDirRelative).toBe("custom/absolute");

    const relativeHarness = createHarness(root);
    relativeHarness.ctx.session = { ...relativeHarness.ctx.session!, workingDirectory };
    const relative = await runWorkflowScript({
      pi: relativeHarness.pi,
      ctx: relativeHarness.ctx,
      signal: new AbortController().signal,
      name: "paths",
      outputDir: "./workspace",
    });
    expect(relative.ok, relative.error).toBe(true);
    expect(relative.workspaceDirRelative).toBe("packages/docs/workspace");
  });

  it.each(["task/draft", "task/plan"])(
    "lets %s resume reuse an explicit source workspace without repeating outputDir",
    async (name) => {
      const root = project();
      writeWorkflowTree(root, "task", {
        draft: `export const meta = { name: "task/draft" };\nexport default (dsl) => dsl.outputDir();\n`,
        plan: `export const meta = { name: "task/plan" };\nexport default (dsl) => dsl.outputDir();\n`,
      });
      const selectedWorkspace = ".locus-pi/plans/20260819-120000-a1b2-airflow-dag-builder";
      mkdirSync(path.join(root, selectedWorkspace), { recursive: true });
      const firstHarness = createHarness(root);
      const first = await runWorkflowScript({
        pi: firstHarness.pi,
        ctx: firstHarness.ctx,
        signal: new AbortController().signal,
        name,
        outputDir: selectedWorkspace,
      });
      expect(first.ok, first.error).toBe(true);

      const resumedHarness = createHarness(root);
      const resumed = await runWorkflowScript({
        pi: resumedHarness.pi,
        ctx: resumedHarness.ctx,
        signal: new AbortController().signal,
        name,
        resumeFromRunId: first.runId,
      });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.workspaceDirRelative).toBe(selectedWorkspace);
      expect(resumed.workspaceDirExplicit).toBe(true);

      const conflictingHarness = createHarness(root);
      const conflicting = await runWorkflowScript({
        pi: conflictingHarness.pi,
        ctx: conflictingHarness.ctx,
        signal: new AbortController().signal,
        name,
        outputDir: ".locus-pi/plans/20260819-120001-b2c3-other-task",
        resumeFromRunId: first.runId,
      });
      expect(conflicting.ok).toBe(false);
      expect(conflicting.error).toContain("outputDir must equal the source workspace");
    },
  );

  it("runs a generated workflow script in its selected task workspace", async () => {
    const root = project();
    const workspace = ".locus-pi/plans/20260819-120000-a1b2-task-plan";
    const scriptPath = path.join(root, workspace, "workflow.mjs");
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, `export default (dsl) => dsl.outputDir();\n`, "utf8");

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath,
      outputDir: workspace,
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.workspaceDirRelative).toBe(workspace);
    expect(result.result).toBe(workspace);
  });

  it("binds an absolute owner path to owner metadata and semantic input on resume", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const scriptPath = path.join(root, ".locus-pi", "workflows", "post-code-review.workflow.mjs");
    const outputDir = "tmp/post-code-review/absolute-owner";
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      scriptPath,
      input: "review alpha",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.semanticInputPresent).toBe(true);
    expect(first.semanticInputSha256).toMatch(/^[a-f0-9]{64}$/u);

    const changedHarness = createHarness(root);
    const changed = await runWorkflowScript({
      pi: changedHarness.pi,
      ctx: changedHarness.ctx,
      signal: new AbortController().signal,
      scriptPath,
      input: "review beta",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(changed.ok).toBe(false);
    expect(changed.error).toContain("semantic input differs");
  });

  it("refuses resume from a copied result envelope bound to another run", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "review alpha",
      outputDir: "tmp/post-code-review/copied-source",
    });
    expect(first.ok, first.error).toBe(true);

    const copiedRunId = "20260713-010103-copied-resume";
    const copiedRunDir = path.join(root, ".locus-pi", "runs", copiedRunId);
    mkdirSync(path.join(copiedRunDir, "runtime"), { recursive: true });
    writeFileSync(workflowResultFile(copiedRunDir), readFileSync(workflowResultFile(first.runDir), "utf8"), "utf8");

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "review alpha",
      outputDir: "tmp/post-code-review/copied-source",
      resumeFromRunId: copiedRunId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/persisted result envelope|malformed persisted metadata/u);
  });

  it("persists a project-relative physical workspace identity and rejects malformed post-code-review resume evidence", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspacePhysicalIdentity).toBe("tmp/post-code-review/review-identity");
    expect(first.workspacePhysicalIdentitySchemaVersion).toBe(1);
    expect(first.workspacePhysicalIdentity).not.toContain(root);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspacePhysicalIdentity = "../outside";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspacePhysicalIdentityInvalid: expect.stringContaining("unsafe path component"),
    });

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("physical identity is malformed");

    raw.workspacePhysicalIdentity = first.workspacePhysicalIdentity;
    raw.workspacePhysicalIdentitySchemaVersion = 2;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const schemaResumeHarness = createHarness(root);
    const schemaResumed = await runWorkflowScript({
      pi: schemaResumeHarness.pi,
      ctx: schemaResumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(schemaResumed.ok).toBe(false);
    expect(schemaResumed.error).toContain("physical identity schema");

    delete raw.workspacePhysicalIdentitySchemaVersion;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const identityOnlyHarness = createHarness(root);
    const identityOnlyResumed = await runWorkflowScript({
      pi: identityOnlyHarness.pi,
      ctx: identityOnlyHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(identityOnlyResumed.ok).toBe(false);
    expect(identityOnlyResumed.error).toContain("physical identity schema");

    raw.workspacePhysicalIdentitySchemaVersion = 1;
    delete raw.workspacePhysicalIdentity;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const schemaOnlyHarness = createHarness(root);
    const schemaOnlyResumed = await runWorkflowScript({
      pi: schemaOnlyHarness.pi,
      ctx: schemaOnlyHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(schemaOnlyResumed.ok).toBe(false);
    expect(schemaOnlyResumed.error).toContain("workspace physical identity is required");
  });

  it("uses the persisted generated workspace identity when resuming a default workspace with spaces", async () => {
    const root = project();
    const workingDirectory = path.join(root, "packages", "docs site");
    mkdirSync(workingDirectory, { recursive: true });
    writeWorkflow(root, "default-space", `export default (dsl) => dsl.outputDir();\n`);
    const sourceHarness = createHarness(root);
    sourceHarness.ctx.session = { ...sourceHarness.ctx.session!, workingDirectory };
    const first = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      name: "default-space",
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspacePhysicalIdentity).toBe(`.locus-pi/workspaces/${first.runId}-default-space`);
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspacePhysicalIdentity: `.locus-pi/workspaces/${first.runId}-default-space`,
    });

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspacePhysicalIdentity = "packages/docs site/tmp/other";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const resumeHarness = createHarness(root);
    resumeHarness.ctx.session = { ...resumeHarness.ctx.session!, workingDirectory };
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "default-space",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
  });

  it("rejects post-code-review resume when the recorded physical identity changed", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity-change",
    });
    expect(first.ok, first.error).toBe(true);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspacePhysicalIdentity = "tmp/post-code-review/replaced-identity";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity-change",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
  });

  it("fails closed when a post-code-review workspace ancestor is physically replaced", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const outputDir = "tmp/post-code-review/review-replaced";
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);

    const outside = mkdtempSync(path.join(tmpdir(), "workflow-post-review-replaced-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const workspaceParent = path.join(root, "tmp", "post-code-review");
    rmSync(workspaceParent, { recursive: true, force: true });
    symlinkSync(outside, workspaceParent, "dir");

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/symlink|physical|outputDir|unavailable|binding/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(workspaceParent, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("defaults a unique planning namespace from the run id and saved workflow name", async () => {
    const root = project();
    writeWorkflow(root, "default-output", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "default-output",
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.workspaceDirRelative).toBe(`.locus-pi/workspaces/${result.runId}-default-output`);
    expect(result.workspaceDir).toBe(path.join(root, ".locus-pi", "workspaces", `${result.runId}-default-output`));
  });

  it("derives distinct safe default namespaces for legacy names beginning with underscore or hyphen", async () => {
    const root = project();
    const harness = createHarness(root);
    const names = ["_legacy", "-legacy", "legacy"];
    for (const name of names) writeWorkflow(root, name, `export default () => ${JSON.stringify(name)};\n`);

    const results = await Promise.all(
      names.map((name) =>
        runWorkflowScript({
          pi: harness.pi,
          ctx: harness.ctx,
          signal: new AbortController().signal,
          name,
        }),
      ),
    );

    for (const result of results) {
      expect(result.ok, result.error).toBe(true);
      expect(result.workspaceDirRelative).toMatch(/^\.locus-pi\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    }
    const namespaces = results.map((result) => result.workspaceDirRelative!);
    expect(new Set(namespaces).size).toBe(names.length);
    expect(namespaces[2]).toMatch(/-legacy$/u);
    expect(namespaces[0]).toMatch(/-_legacy$/u);
    expect(namespaces[1]).toMatch(/--legacy$/u);
  });

  it.each(["/tmp/escape", "../escape", "outputs/../escape", " outputs/task", "outputs/task/"])(
    "rejects unsafe outputDir %s before an agent starts",
    async (outputDir) => {
      const root = project();
      writeWorkflow(root, "empty", `export default () => "ok";\n`);
      let calls = 0;
      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "empty",
        outputDir,
        createExecutor: executor(() => {
          calls += 1;
          return "unused";
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/outputDir|path component|project-relative/u);
      expect(calls).toBe(0);
    },
  );

  it("accepts a long component-valid outputDir instead of refusing it on a character count", async () => {
    // The 400-character gate was an aggregate bound on the whole string, not a filesystem
    // limit: each component was already inside the safe alphabet and the path already
    // confined. What actually bounds a path is the filesystem, and it says so itself.
    const root = project();
    writeWorkflow(root, "empty", `export default () => "ok";\n`);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
      outputDir: `${"a".repeat(200)}/${"b".repeat(200)}`,
      createExecutor: executor(() => "unused"),
    });

    expect(result.ok).toBe(true);
  });

  it.each([null, true, 1, [], { path: "outputs/task" }])(
    "terminalizes non-string direct outputDir %j before child work",
    async (outputDir) => {
      const root = project();
      writeWorkflow(root, "empty", `export default async (dsl) => dsl.agent("must not run");\n`);
      let calls = 0;
      const harness = createHarness(root);

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "empty",
        outputDir: outputDir as unknown as string,
        createExecutor: executor(() => {
          calls += 1;
          return "unused";
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("workflow outputDir must be a non-empty trimmed path");
      expect(calls).toBe(0);
      expect(readWorkflowRunResult(root, result.runId)).toMatchObject({
        ok: false,
        disposition: { status: "failed" },
        error: result.error,
      });
    },
  );

  it("rejects an output path whose existing ancestor is a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-output-outside-"));
    mkdirSync(path.join(root, "outputs"));
    symlinkSync(outside, path.join(root, "outputs", "linked"), "dir");
    writeWorkflow(root, "empty", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
      outputDir: "outputs/linked/task",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("symlink");
  });

  it("keeps run-local outputDir compatibility and exposes a distinct stable primary-file reference", async () => {
    const root = project();
    writeWorkflow(
      root,
      "writer",
      `export default async function run(dsl) {
  await dsl.agent("write result");
  return dsl.publishPrimaryFile("result.md");
}\n`,
    );
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "task", "result.md");

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "writer",
      outputDir: "outputs/task",
      createExecutor: executor(() => {
        writeFileSync(stableFile, "durable result\n", "utf8");
        return "written";
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.stableOutputDir).toBe(path.join(root, "outputs", "task"));
    expect(result.stableOutputDirRelative).toBe("outputs/task");
    expect(result.primaryFile).toMatchObject({
      relativePath: "result.md",
      absolutePath: stableFile,
      bytes: 15,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(readFileSync(stableFile, "utf8")).toBe("durable result\n");
    expect(path.join(result.runDir, "outputs")).not.toBe(result.stableOutputDir);
    expect(result.primaryOutputPath).not.toBe(stableFile);
  });

  it("keeps stable files available when later workflow work fails", async () => {
    const root = project();
    writeWorkflow(
      root,
      "failing-writer",
      `export default async function run(dsl) {
  await dsl.agent("write then fail");
  throw new Error("later stage failed");
}\n`,
    );
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "failed", "partial.md");

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "failing-writer",
      outputDir: "outputs/failed",
      createExecutor: executor(() => {
        writeFileSync(stableFile, "inspectable partial\n", "utf8");
        return "written";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("later stage failed");
    expect(readFileSync(stableFile, "utf8")).toBe("inspectable partial\n");
  });

  it("rejects missing, empty, and symlinked primary files", async () => {
    const root = project();
    writeWorkflow(root, "primary", `export default (dsl) => dsl.publishPrimaryFile(dsl.items()[0]);\n`);
    const output = path.join(root, "outputs", "primary-checks");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "empty.md"), "", "utf8");
    const outside = path.join(root, "outside.md");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, path.join(output, "linked.md"));
    const harness = createHarness(root);

    for (const [file, error] of [
      ["missing.md", "ENOENT"],
      ["empty.md", "empty"],
      ["linked.md", "symlink"],
    ] as const) {
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "primary",
        items: [file],
        outputDir: "outputs/primary-checks",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(error);
    }
  });
});
