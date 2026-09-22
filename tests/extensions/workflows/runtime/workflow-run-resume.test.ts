import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowReplayFile } from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import { chmodSync, mkdirSync } from "node:fs";
import { vi } from "vitest";
import {
  WORKFLOW_OUTPUT_LOCK_FILE,
  workflowOutputStateDir,
} from "../../../../extensions/workflows/runtime/workflow-output.js";
import * as workflowJournal from "../../../../extensions/workflows/runtime/workflow-journal.js";
import * as workflowRunLayout from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  readWorkflowRunResult,
  readWorkflowRunResultText,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { executor, project, writeWorkflowTree, CHILD, PARENT } from "../../../fixtures/workflow-durable-project.js";
import {
  cleanupReplayProjects,
  runWorkflow,
  temporaryProject,
  workflowPrompt,
  writeWorkflow,
  THREE_STAGE_WORKFLOW,
} from "../../../fixtures/workflow-replay-project.js";

/**
 * T-218 W13 — the resume authority (`workflow-run-resume.ts`) decides what a
 * stopped run proves about itself: target identity, workspace identity, semantic
 * input, retained-snapshot usability, and whether a recorded prefix may be
 * replayed at all. Every case here is a VERDICT case: it asserts a refusal or an
 * admission, never how a replayed call is retried.
 */

afterEach(() => {
  cleanupReplayProjects();
});

describe("resume identity and replay admission", () => {
  it("refuses to replay identical bytes when the persisted target changed", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "alpha", THREE_STAGE_WORKFLOW);
    writeWorkflow(root, "beta", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "alpha", { outputDir: "same-replay-workspace" });
    const resumed = await runWorkflow(root, "beta", {
      outputDir: "same-replay-workspace",
      resumeFromRunId: first.runId,
    });

    expect(resumed.replay).toMatchObject({
      replayed: false,
      refusedReason: "target-changed",
      replayedCalls: 0,
      freshCalls: 3,
    });
    expect(resumed.executedPrompts).toEqual(["stage-1", "stage-2 ", "stage-3"]);
  });

  it("replays an owner workflow across equivalent and confined symlink target spellings", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "post-code-review", THREE_STAGE_WORKFLOW);
    symlinkSync(
      path.join(root, ".locus-pi", "workflows", "post-code-review.workflow.mjs"),
      path.join(root, "post-code-review-alias.workflow.mjs"),
    );
    const firstHarness = createHarness(root, { sessionId: "replay-owner-alias-first" });
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      scriptPath: "post-code-review-alias.workflow.mjs",
      outputDir: "post-code-review-alias",
      createExecutor: () => ({
        async run(request: AgentRunRequest) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: `answer(${workflowPrompt(request.task)})`,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    expect(first.ok).toBe(true);

    const secondHarness = createHarness(root, { sessionId: "replay-owner-alias-second" });
    const resumed = await runWorkflowScript({
      pi: secondHarness.pi,
      ctx: secondHarness.ctx,
      signal: new AbortController().signal,
      scriptPath: ".locus-pi/workflows/post-code-review.workflow.mjs",
      outputDir: "post-code-review-alias",
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          throw new Error("owner replay should not execute fresh children");
        },
      }),
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 3, freshCalls: 0 });
  });

  it.each(["mismatch", "absent", "malformed"] as const)(
    "fails post-code-review exact resume before child execution when source target is %s",
    async (mode) => {
      const root = temporaryProject();
      writeWorkflow(root, "other", THREE_STAGE_WORKFLOW);
      writeWorkflow(root, "post-code-review", THREE_STAGE_WORKFLOW);
      const first = await runWorkflow(root, "other", { outputDir: "post-code-review-resume" });
      if (mode !== "mismatch") {
        const result = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
        if (mode === "absent") delete result.target;
        else result.target = { kind: "name", ref: "nested/run/extra", source: "project" };
        writeFileSync(workflowResultFile(first.runDir), `${JSON.stringify(result)}\n`, "utf8");
      }

      const harness = createHarness(root, { sessionId: `exact-resume-${mode}` });
      const executedPrompts: string[] = [];
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        outputDir: "post-code-review-resume",
        resumeFromRunId: first.runId,
        createExecutor: () => ({
          async run(request: AgentRunRequest) {
            executedPrompts.push(workflowPrompt(request.task));
            return {
              status: "completed" as const,
              agentName: request.agent?.name ?? "sub-agent",
              reason: "must not run",
              text: "unexpected child execution",
              diagnostics: [],
              lifecycleEntryIds: [],
            };
          },
        }),
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.replay).toBeUndefined();
      expect(executedPrompts).toEqual([]);
      expect(resumed.error).toContain(mode === "mismatch" ? "post-code-review" : "malformed persisted metadata");
      expect(resumed.error).toContain(
        mode === "mismatch"
          ? // Ordinary roots now write a launch binding too, so a non-owner source is
            // refused by its recorded ownership rather than by a missing binding.
            "ownership differs"
          : mode === "absent"
            ? "script identity is malformed"
            : "target is malformed",
      );
    },
  );

  it("fails the reverse post-code-review owner transition before execution", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "post-code-review", THREE_STAGE_WORKFLOW);
    writeWorkflow(root, "other", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "post-code-review", { outputDir: "post-code-review-reverse" });
    const harness = createHarness(root, { sessionId: "exact-resume-reverse" });
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "other",
      outputDir: "post-code-review-reverse",
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          throw new Error("child must not run");
        },
      }),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.replay).toBeUndefined();
    expect(resumed.error).toContain("ownership differs");
  });

  it("refuses to record or replay a script that reads the clock directly", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "unsafe",
      `export const meta = { name: "unsafe", description: "reads the clock directly" };
export default async function runWorkflow(dsl) {
  const started = Date.now();
  const answer = await dsl.agent("stage-1");
  return { summary: answer, elapsed: typeof started };
}
`,
    );

    const first = await runWorkflow(root, "unsafe");
    expect(first.ok).toBe(true);
    expect(first.replay).toMatchObject({ recorded: false, notRecordedReason: "replay-unsafe-script" });
    expect(existsSync(workflowReplayFile(first.runDir))).toBe(false);

    const resumed = await runWorkflow(root, "unsafe", { resumeFromRunId: first.runId });
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "replay-unsafe-script" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });

  // Replay refusal reasons remain a fresh-run contract only when source identity
  // is readable. A source result without workspace identity cannot be resumed:
  // the runtime must fail before it can safely choose a workspace.
  it("fails when the recorded run lost its persisted workspace identity", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });

    // The run id still resolves (journal.ndjson survives), so this is reached
    // rather than the hard "source run not found" error raised earlier.
    rmSync(workflowResultFile(first.runDir));
    const resumedHarness = createHarness(root, { sessionId: "replay-missing-workspace" });
    const resumed = await runWorkflowScript({
      pi: resumedHarness.pi,
      ctx: resumedHarness.ctx,
      signal: new AbortController().signal,
      name: "stages",
      input: "alpha",
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          throw new Error("child must not run");
        },
      }),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.replay).toBeUndefined();
    expect(resumed.error).toContain("has no persisted workspace identity");
  });

  it("refuses with identity-coverage-unproven for an entry-only script, and records nothing", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "modular",
      `export const meta = { name: "modular", description: "declares entry-only coverage", identityCoverage: "entry-only" };
export default async function runWorkflow(dsl) {
  return { summary: await dsl.agent("stage-1") };
}
`,
    );

    // Imported bytes are outside the entry hash, so a matching scriptSha256
    // would not prove the call sequence is the same. Fail closed at record time.
    const first = await runWorkflow(root, "modular");
    expect(first.ok).toBe(true);
    expect(first.replay).toMatchObject({ recorded: false, notRecordedReason: "identity-coverage-unproven" });
    expect(existsSync(workflowReplayFile(first.runDir))).toBe(false);

    const resumed = await runWorkflow(root, "modular", { resumeFromRunId: first.runId });
    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "identity-coverage-unproven" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });

  it("refuses with no-recorded-calls when a replay-safe run had nothing to record", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "inert",
      `export const meta = { name: "inert", description: "replay-safe with no calls" };
export default async function runWorkflow(dsl, input) {
  return { summary: "no agents here: " + String(input ?? "") };
}
`,
    );

    const first = await runWorkflow(root, "inert");
    expect(first.ok).toBe(true);

    const resumed = await runWorkflow(root, "inert", { resumeFromRunId: first.runId });
    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "no-recorded-calls", replayedCalls: 0 });
    expect(resumed.executedPrompts).toEqual([]);
  });
});

describe("resume binds a run to the workspace and input its source proved", () => {
  it("resumes a qualified child in its persisted pre-upgrade default workspace", async () => {
    const root = project();
    writeWorkflowTree(root, "composed", {
      worker: `export const meta = { name: "composed/worker", profile: "standard" };
export default (dsl) => dsl.outputDir();
`,
    });
    const harness = createHarness(root);
    const legacyWorkspace = "tmp/composed";
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed/worker",
      outputDir: legacyWorkspace,
    });
    expect(first.ok, first.error).toBe(true);

    const persisted = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    writeFileSync(
      workflowResultFile(first.runDir),
      `${JSON.stringify({ ...persisted, workspaceDirExplicit: false })}\n`,
      "utf8",
    );

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed/worker",
      resumeFromRunId: first.runId,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe(legacyWorkspace);
  });

  it("does not implicitly reuse a persisted workspace for a different workflow target", async () => {
    const root = project();
    writeWorkflow(root, "alpha", `export default (dsl) => dsl.outputDir();\n`);
    writeWorkflow(root, "beta", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "alpha",
    });
    expect(first.ok, first.error).toBe(true);
    const originalReadme = readFileSync(path.join(first.runDir, "README.md"), "utf8");
    const originalBacklink = readFileSync(path.join(first.workspaceDir!, ".workflow-runs.md"), "utf8");

    let calls = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "beta",
      resumeFromRunId: first.runId,
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("outputDir must equal the source workspace");
    expect(resumed.runDir).toBe(path.join(first.runDir, "attempts", resumed.runId));
    expect(resumed.resultPersistence.ok).toBe(true);
    expect(readFileSync(path.join(first.runDir, "README.md"), "utf8")).toBe(originalReadme);
    expect(readFileSync(path.join(first.workspaceDir!, ".workflow-runs.md"), "utf8")).toBe(originalBacklink);
    expect(calls).toBe(0);
    expect(existsSync(path.join(root, "tmp", "beta"))).toBe(false);
  });

  it("binds resume to the source workspace when the same namespace is supplied", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const outputDir = "outputs/resume-source";
    const harness = createHarness(root);
    const calls: string[] = [];
    const createExecutor = executor((prompt) => {
      calls.push(prompt);
      const key = prompt.slice(prompt.lastIndexOf(":") + 1);
      writeFileSync(path.join(root, outputDir, `${key}.md`), `${prompt}\n`, "utf8");
      return "written";
    });

    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-one",
      items: ["alpha"],
      outputDir,
      createExecutor,
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspaceDirRelative).toBe(outputDir);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-one",
      items: ["alpha"],
      outputDir,
      resumeFromRunId: first.runId,
      createExecutor,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe(outputDir);
    expect(calls).toEqual([]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha", sourceRunId: first.childRuns?.[0]?.runId }),
    ]);
  });

  it("requires repeating an explicit outputDir even when it equals the default", async () => {
    const root = project();
    writeWorkflow(root, "default-resume", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const outputDir = "tmp/default-resume";
    const run = (options: { outputDir?: string; resumeFromRunId?: string } = {}) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "default-resume",
        ...options,
      });

    const first = await run({ outputDir });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspaceDirRelative).toBe(outputDir);
    expect(first.workspaceDirExplicit).toBe(true);
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspaceDirRelative: outputDir,
      workspaceDirExplicit: true,
    });

    const omitted = await run({ resumeFromRunId: first.runId });
    expect(omitted.ok).toBe(false);
    expect(omitted.error).toContain("source workspace was selected explicitly");

    const repeated = await run({ outputDir, resumeFromRunId: first.runId });
    expect(repeated.ok, repeated.error).toBe(true);
    expect(repeated.workspaceDirRelative).toBe(outputDir);
    expect(repeated.workspaceDirExplicit).toBe(true);
  });

  it("fails generic resume when a v2 source identity loses its persisted target", async () => {
    const root = project();
    writeWorkflow(root, "generic-v2-target", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "generic-v2-target",
      outputDir: "outputs/generic-v2-target",
    });
    expect(first.ok, first.error).toBe(true);
    const result = JSON.parse(readFileSync(first.resultPersistence.path, "utf8")) as Record<string, unknown>;
    delete result.target;
    writeFileSync(first.resultPersistence.path, `${JSON.stringify(result)}\n`, "utf8");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "generic-v2-target",
      outputDir: "outputs/generic-v2-target",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
    expect(resumed.childRuns ?? []).toEqual([]);
  });

  it.each(["true", 1, null])("fails closed when persisted workspaceDirExplicit has wrong type %j", async (value) => {
    const root = project();
    writeWorkflow(root, "malformed-explicit", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const outputDir = "tmp/malformed-explicit";
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "malformed-explicit",
      outputDir,
    });
    const resultPath = first.resultPersistence.path;
    const persisted = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    persisted.workspaceDirExplicit = value;
    writeFileSync(resultPath, `${JSON.stringify(persisted)}\n`, "utf8");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "malformed-explicit",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
  });

  it("binds post-code-review resume to exact semantic input before checkpoints", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "post-code-review", PARENT);
    const harness = createHarness(root);
    const outputDir = "outputs/post-code-review-input";
    let calls = 0;
    const createExecutor = executor((prompt) => {
      calls += 1;
      mkdirSync(path.join(root, outputDir), { recursive: true });
      writeFileSync(path.join(root, outputDir, "alpha.md"), `${prompt}\n`, "utf8");
      return `written:${prompt}`;
    });
    const run = (input: string, resumeFromRunId?: string, namespace = outputDir) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        input,
        items: ["alpha"],
        outputDir: namespace,
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor,
      });

    const first = await run("review alpha");
    expect(first.ok, first.error).toBe(true);
    expect(first.semanticInputPresent).toBe(true);
    expect(first.semanticInputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      semanticInputPresent: true,
      semanticInputSha256: first.semanticInputSha256,
    });
    const firstCalls = calls;

    const same = await run("review alpha", first.runId);
    expect(same.ok, same.error).toBe(true);
    expect(calls).toBe(firstCalls);
    expect(same.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);

    const changed = await run("review beta", first.runId);
    expect(changed.ok).toBe(false);
    expect(changed.error).toContain("semantic input differs");
    expect(changed.childRuns ?? []).toEqual([]);
    expect(changed.primaryFile).toBeUndefined();
    expect(changed.primaryOutputPath).toBeUndefined();
    expect(calls).toBe(firstCalls);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it("uses one persisted resume binding for workspace, owner, semantic, and replay checks", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const outputDir = "outputs/resume-binding";
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "resume binding",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);

    const originalResolve = workflowRunLayout.resolveWorkflowRunDir;
    const duplicateGroup = path.join(root, ".locus-pi", "runs", "duplicate-binding-group");
    const resolve = vi.spyOn(workflowRunLayout, "resolveWorkflowRunDir").mockImplementation((projectRoot, runId) => {
      const resolved = originalResolve(projectRoot, runId);
      mkdirSync(path.join(duplicateGroup, "children", runId), { recursive: true });
      return resolved;
    });
    const resolvedRunDir = workflowRunLayout.resolveWorkflowRunDir(root, first.runId);
    expect(readWorkflowLaunchBinding(root, first.runId, resolvedRunDir)).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockRestore();
    rmSync(duplicateGroup, { recursive: true, force: true });

    const readSpy = vi.spyOn(workflowJournal, "readWorkflowRunResult");
    try {
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        input: "resume binding",
        outputDir,
        resumeFromRunId: first.runId,
      });
      expect(resumed.ok, resumed.error).toBe(true);
      // The post-target binding is the only direct result read; summary status
      // uses its journal-owned projection and replay reuses this binding.
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects a valid-looking result projection rewrite before owner resume work", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const outputDir = "outputs/launch-binding-result-tamper";
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);
    expect(existsSync(workflowLaunchBindingFile(first.runDir))).toBe(true);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspaceDir = path.join(root, "outputs", "launch-binding-result-tamper-other");
    raw.workspaceDirRelative = "outputs/launch-binding-result-tamper-other";
    raw.workspacePhysicalIdentity = "outputs/launch-binding-result-tamper-other";
    raw.semanticInputSha256 = "a".repeat(64);
    raw.target = { kind: "name", ref: "ordinary", source: "project" };
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");

    let calls = 0;
    const resumed = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
      resumeFromRunId: first.runId,
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/no valid host launch binding|malformed persisted metadata/u);
    expect(resumed.childRuns ?? []).toEqual([]);
    expect(calls).toBe(0);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it("rejects a tampered host launch binding before owner resume work", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const outputDir = "outputs/launch-binding-sidecar-tamper";
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);

    const bindingPath = workflowLaunchBindingFile(first.runDir);
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as {
      semanticInput: { sha256: string };
    };
    binding.semanticInput.sha256 = "b".repeat(64);
    writeFileSync(bindingPath, JSON.stringify(binding), "utf8");

    const resumed = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("no valid host launch binding");
    expect(resumed.childRuns ?? []).toEqual([]);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it.each([
    {
      label: "wrong snapshot bytes",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        const identity = binding.scriptIdentity as Record<string, unknown>;
        chmodSync(identity.snapshotPath as string, 0o644);
        writeFileSync(identity.snapshotPath as string, "wrong bytes\n", "utf8");
      },
    },
    {
      label: "external snapshot symlink",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        const identity = binding.scriptIdentity as Record<string, unknown>;
        rmSync(identity.snapshotPath as string, { force: true });
        symlinkSync("/etc/hosts", identity.snapshotPath as string);
      },
    },
    {
      label: "malformed target source",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        binding.target = { kind: "name", ref: "post-code-review", source: "unknown" };
      },
    },
    {
      label: "unsorted dependencies",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.scriptIdentity as Record<string, unknown>).builtinImports = ["node:z", "node:a"];
      },
    },
    {
      label: "invalid builtin dependency",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.scriptIdentity as Record<string, unknown>).builtinImports = ["fs"];
      },
    },
    {
      label: "missing workspace",
      mutate: (root: string, binding: Record<string, unknown>) => {
        const workspace = binding.workspace as Record<string, unknown>;
        workspace.absolutePath = path.join(root, "outputs", "missing-workspace");
        workspace.relativePath = "outputs/missing-workspace";
        workspace.physicalPath = workspace.absolutePath;
        workspace.physicalIdentity = workspace.relativePath;
      },
    },
    {
      label: "workspace is a file",
      mutate: (root: string, binding: Record<string, unknown>) => {
        const workspace = binding.workspace as Record<string, unknown>;
        const filePath = path.join(root, "outputs", "workspace-file");
        writeFileSync(filePath, "not a directory\n", "utf8");
        workspace.absolutePath = filePath;
        workspace.relativePath = "outputs/workspace-file";
        workspace.physicalPath = filePath;
        workspace.physicalIdentity = workspace.relativePath;
      },
    },
    {
      label: "mismatched workspace physical identity",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.workspace as Record<string, unknown>).physicalIdentity = "outputs/other-workspace";
      },
    },
    {
      label: "extra semantic key",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.semanticInput as Record<string, unknown>).extra = true;
      },
    },
  ])("rejects launch binding with $label before handoff/resume use", async ({ mutate }) => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const outputDir = "outputs/launch-binding-validation";
    const first = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "validation",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);
    const bindingPath = workflowLaunchBindingFile(first.runDir);
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    mutate(root, binding);
    writeFileSync(bindingPath, `${JSON.stringify(binding)}\n`, "utf8");

    expect(readWorkflowLaunchBinding(root, first.runId)).toBeNull();
    const resumed = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "validation",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("no valid host launch binding");
    expect(resumed.childRuns ?? []).toEqual([]);
  });

  it.each([undefined, "outputs/resume-other"] as const)(
    "fails resume before child work when outputDir is %s instead of the source workspace",
    async (outputDir) => {
      const root = project();
      writeWorkflow(root, "child", CHILD);
      writeWorkflow(root, "parent", PARENT);
      const sourceOutputDir = "outputs/resume-source";
      const harness = createHarness(root);
      const createExecutor = executor((prompt) => {
        const key = prompt.slice(prompt.lastIndexOf(":") + 1);
        writeFileSync(path.join(root, sourceOutputDir, `${key}.md`), `${prompt}\n`, "utf8");
        return "written";
      });

      const first = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload-one",
        items: ["alpha"],
        outputDir: sourceOutputDir,
        createExecutor,
      });
      expect(first.ok, first.error).toBe(true);

      let calls = 0;
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload-one",
        items: ["alpha"],
        ...(outputDir === undefined ? {} : { outputDir }),
        resumeFromRunId: first.runId,
        createExecutor: executor(() => {
          calls += 1;
          return "must not run";
        }),
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.error).toContain(
        outputDir === undefined
          ? "source workspace was selected explicitly"
          : "outputDir must equal the source workspace",
      );
      expect(calls).toBe(0);
      const candidateRelative = outputDir ?? "tmp/parent";
      expect(existsSync(path.join(root, candidateRelative))).toBe(false);
      expect(existsSync(workflowOutputStateDir(root, candidateRelative))).toBe(false);
      expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
        ok: false,
        disposition: { status: "failed" },
        error: resumed.error,
      });
    },
  );

  it("fails resume when the source result has no persisted workspace identity", async () => {
    const root = project();
    writeWorkflow(root, "resume-missing-workspace", `export default () => "ok";\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-missing-workspace",
      outputDir: "outputs/source",
    });
    expect(first.ok, first.error).toBe(true);

    const persisted = readWorkflowRunResult(root, first.runId);
    if (persisted === null) throw new Error("expected persisted source result");
    const { workspaceDir: _workspaceDir, workspaceDirRelative: _workspaceDirRelative, ...withoutWorkspace } = persisted;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(withoutWorkspace), "utf8");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-missing-workspace",
      outputDir: "outputs/source",
      resumeFromRunId: first.runId,
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
    expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
      ok: false,
      disposition: { status: "failed" },
      error: resumed.error,
    });
  });

  it("keeps removed workspaces readable while resume fails physical identity preflight", async () => {
    const root = project();
    writeWorkflow(root, "removed-workspace", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "removed-workspace",
      outputDir: "outputs/removed-workspace",
    });
    expect(first.ok, first.error).toBe(true);
    rmSync(first.workspaceDir!, { recursive: true, force: true });

    const persistedAfterRemoval = readWorkflowRunResult(root, first.runId);
    expect(persistedAfterRemoval).toMatchObject({
      workspaceDir: path.join(root, "outputs", "removed-workspace"),
      workspaceDirRelative: "outputs/removed-workspace",
    });
    expect(persistedAfterRemoval).not.toHaveProperty("workspaceDirInvalid");
    expect(readWorkflowRunResultText(root, first.runId)).toMatchObject({ status: "ready" });
    expect(readWorkflowRunSummary(root, first.runId).status).toBe("completed");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "removed-workspace",
      outputDir: "outputs/removed-workspace",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("workspace identity is unavailable");
    expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
      ok: false,
      disposition: { status: "failed" },
    });
  });

  it("fails closed when persisted workspaceDir is relative", async () => {
    const root = project();
    writeWorkflow(root, "relative-workspace", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "relative-workspace",
      outputDir: "outputs/relative-workspace",
    });
    expect(first.ok, first.error).toBe(true);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspaceDir = "outputs/relative-workspace";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspaceDirInvalid: expect.stringContaining("absolute path"),
    });

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "relative-workspace",
      outputDir: "outputs/relative-workspace",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
    expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
      ok: false,
      disposition: { status: "failed" },
    });
  });
});
