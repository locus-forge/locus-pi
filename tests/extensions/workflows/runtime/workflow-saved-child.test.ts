import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveWorkflowOutputDirectory,
  WORKFLOW_OUTPUT_LOCK_FILE,
  workflowOutputStateDir,
} from "../../../../extensions/workflows/runtime/workflow-output.js";
import {
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import * as workflowRunLayout from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  readWorkflowRunResult,
  readWorkflowRunResultText,
  readWorkflowRunScriptSnapshot,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import * as workflowJournal from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import {
  executor,
  project,
  writeWorkflow,
  writeWorkflowTree,
  CHILD,
  PARENT,
} from "../../../fixtures/workflow-durable-project.js";

describe("saved child execution and item checkpoints", () => {
  it("binds packageName children to the Package source and rejects a project shadow", async () => {
    const parentSource = `export const meta = { name: "package-parent", profile: "standard" };
export default (dsl) => dsl.invokeWorkflow({
  packageName: "live-smoke",
  key: "package-smoke",
  keys: ["package-smoke"],
  input: "package child proof",
  outputDir: dsl.outputDir(),
});
`;

    const root = project();
    writeWorkflow(root, "package-parent", parentSource);
    const harness = createHarness(root);
    const calls: string[] = [];
    const exact = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "package-parent",
      outputDir: "outputs/package-child",
      createExecutor: executor((prompt) => {
        calls.push(prompt);
        return "package child completed";
      }),
    });

    expect(exact.ok, exact.error).toBe(true);
    expect(calls).toHaveLength(2);
    expect(exact.childRuns).toEqual([
      expect.objectContaining({ status: "completed", key: "package-smoke", childScriptSha256: expect.any(String) }),
    ]);
    const exactChild = JSON.parse(
      readFileSync(path.join(exact.childRuns![0]!.runDir!, "runtime", "result.json"), "utf8"),
    );
    expect(exactChild.target).toMatchObject({ kind: "name", ref: "live-smoke", source: "package" });

    const shadowRoot = project();
    writeWorkflow(shadowRoot, "package-parent", parentSource);
    writeWorkflow(shadowRoot, "live-smoke", `export default () => "project shadow";\n`);
    const shadowHarness = createHarness(shadowRoot);
    const shadowCalls: string[] = [];
    const shadowed = await runWorkflowScript({
      pi: shadowHarness.pi,
      ctx: shadowHarness.ctx,
      signal: new AbortController().signal,
      name: "package-parent",
      outputDir: "outputs/package-shadow",
      createExecutor: executor((prompt) => {
        shadowCalls.push(prompt);
        return "must not run";
      }),
    });

    expect(shadowed.ok).toBe(false);
    expect(shadowed.error).toContain("saved child workflow source changed before execution");
    expect(shadowCalls).toEqual([]);
  });

  it("binds child to the running root folder and records its qualified identity", async () => {
    const root = project();
    writeWorkflowTree(root, "composed", {
      composed: `export const meta = { name: "composed", profile: "standard" };
export default (dsl) => dsl.invokeWorkflow({
  child: "worker",
  key: "worker",
  keys: ["worker"],
  input: "owned child",
  outputDir: dsl.outputDir(),
});
`,
      worker: `export const meta = { name: "composed/worker", profile: "standard" };
export default (dsl, input) => dsl.agent(input);
`,
    });
    const harness = createHarness(root);
    const calls: string[] = [];
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed",
      outputDir: "outputs/composed",
      createExecutor: executor((prompt) => {
        calls.push(prompt);
        return "done";
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(calls).toEqual(["owned child"]);
    expect(readWorkflowRunSummary(root, result.runId!).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(root, result.runId!)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref: "composed", source: "project" },
    });
    const childRunId = result.childRuns![0]!.runId!;
    const child = readWorkflowRunResult(root, childRunId);
    if (child === null) throw new Error("composed child result was not persisted");
    expect(child.target).toMatchObject({ kind: "name", ref: "composed/worker", source: "project" });
    expect(readWorkflowRunSummary(root, childRunId).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(root, childRunId)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref: "composed/worker", source: "project" },
    });
    const childArtifacts = readWorkflowArtifactIndex(root, childRunId);
    if (childArtifacts.status !== "ready") throw new Error(childArtifacts.message);
    const answerRef = childArtifacts.index.artifacts.find((artifact) => artifact.kind === "answer");
    if (answerRef === undefined) throw new Error("composed child answer was not persisted");
    expect(readWorkflowArtifactRecord(root, childRunId, answerRef.artifactId)).toMatchObject({
      status: "ready",
      bytes: Buffer.from("done"),
    });

    const direct = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed/worker",
      input: "direct child",
      createExecutor: executor(() => "direct done"),
    });
    expect(direct.ok, direct.error).toBe(true);
    expect(direct.workspaceDirRelative).toBe(`.locus-pi/workspaces/${direct.runId}-composed-worker`);
    expect(readWorkflowRunSummary(root, direct.runId!).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(root, direct.runId!)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref: "composed/worker", source: "project" },
    });
  });

  it("skips changed opaque payload in one namespace but runs it in a fresh namespace", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const calls: string[] = [];
    const createExecutor = executor((prompt) => {
      calls.push(prompt);
      const payload = prompt.slice("write:".length);
      const key = payload.slice(payload.lastIndexOf(":") + 1);
      writeFileSync(path.join(root, "outputs", "resume", `${key}.md`), `${payload}\n`, "utf8");
      return "written";
    });

    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-one",
      items: ["alpha", "beta"],
      outputDir: "outputs/resume",
      createExecutor,
    });

    expect(first.ok, first.error).toBe(true);
    expect(calls).toEqual(["write:payload-one:alpha", "write:payload-one:beta"]);
    expect(first.childRuns).toHaveLength(2);
    expect(first.result).toEqual([
      expect.objectContaining({ status: "completed", key: "alpha", runId: expect.any(String) }),
      expect.objectContaining({ status: "completed", key: "beta", runId: expect.any(String) }),
    ]);
    for (const exposed of first.result as Array<Record<string, unknown>>) {
      expect(exposed).not.toHaveProperty("childScriptSha256");
      expect(exposed).not.toHaveProperty("runDir");
    }
    for (const child of first.childRuns ?? []) {
      expect(child.status).toBe("completed");
      const persisted = JSON.parse(readFileSync(path.join(child.runDir!, "runtime", "result.json"), "utf8"));
      expect(persisted.lineage).toMatchObject({
        rootRunId: first.runId,
        parentRunId: first.runId,
        parentItemKey: child.key,
        depth: 1,
      });
      expect(persisted.workspaceDir).toBe(path.join(root, "outputs", "resume"));
      expect(persisted.workspaceDirRelative).toBe("outputs/resume");
      expect(persisted.stableOutputDirRelative).toBe("outputs/resume");
    }
    expect(first.journal.filter((line) => line.message?.includes("[workflow:child-start]"))).toHaveLength(2);
    expect(first.journal.filter((line) => line.message?.includes("[workflow:child-end]"))).toHaveLength(2);

    calls.length = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-two",
      items: ["alpha", "beta"],
      outputDir: "outputs/resume",
      createExecutor,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual([]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha", sourceRunId: first.childRuns?.[0]?.runId }),
      expect.objectContaining({ status: "skipped", key: "beta", sourceRunId: first.childRuns?.[1]?.runId }),
    ]);
    expect(resumed.result).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha", sourceRunId: first.childRuns?.[0]?.runId }),
      expect.objectContaining({ status: "skipped", key: "beta", sourceRunId: first.childRuns?.[1]?.runId }),
    ]);
    expect(resumed.journal.filter((line) => line.message?.includes("[workflow:child-skip]"))).toHaveLength(2);
    expect(resumed.journal.some((line) => line.message?.includes(`sourceRunId=${first.childRuns?.[0]?.runId}`))).toBe(
      true,
    );
    expect(readFileSync(path.join(root, "outputs", "resume", "alpha.md"), "utf8")).toBe("payload-one:alpha\n");
    expect(resumed.journal.some((event) => event.message?.includes("[workflow:project-source] policy=live"))).toBe(
      true,
    );

    const freshCalls: string[] = [];
    const fresh = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-two",
      items: ["alpha", "beta"],
      outputDir: "outputs/fresh",
      createExecutor: executor((prompt) => {
        freshCalls.push(prompt);
        const payload = prompt.slice("write:".length);
        const key = payload.slice(payload.lastIndexOf(":") + 1);
        writeFileSync(path.join(root, "outputs", "fresh", `${key}.md`), `${payload}\n`, "utf8");
        return "written";
      }),
    });

    expect(fresh.ok, fresh.error).toBe(true);
    expect(freshCalls).toEqual(["write:payload-two:alpha", "write:payload-two:beta"]);
    expect(fresh.childRuns).toEqual([
      expect.objectContaining({ status: "completed", key: "alpha" }),
      expect.objectContaining({ status: "completed", key: "beta" }),
    ]);
    expect(readFileSync(path.join(root, "outputs", "fresh", "alpha.md"), "utf8")).toBe("payload-two:alpha\n");
  });

  it("retries only an incomplete key and invalidates checkpoints when child source changes", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const calls: string[] = [];
    let failBeta = true;
    const createExecutor = executor((prompt) => {
      calls.push(prompt);
      const key = prompt.slice(prompt.lastIndexOf(":") + 1);
      if (key === "beta" && failBeta) throw new Error("interrupted beta");
      writeFileSync(path.join(root, "outputs", "retry", `${key}.md`), `${prompt}\n`, "utf8");
      return "written";
    });
    const run = (resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha", "beta"],
        outputDir: "outputs/retry",
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor,
      });

    const interrupted = await run();
    expect(interrupted.ok).toBe(false);
    expect(calls).toEqual(["write:payload:alpha", "write:payload:beta"]);

    calls.length = 0;
    failBeta = false;
    const resumed = await run(interrupted.runId);
    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual(["write:payload:beta"]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha" }),
      expect.objectContaining({ status: "completed", key: "beta" }),
    ]);
    expect(resumed.storageRootRunId).toBe(interrupted.runId);
    expect(resumed.runDir).toBe(path.join(interrupted.runDir, "attempts", resumed.runId));
    expect(resumed.lineage).toEqual({ rootRunId: resumed.runId, depth: 0 });
    const retriedChild = resumed.childRuns![1]!;
    expect(retriedChild.runDir).toBe(path.join(interrupted.runDir, "children", retriedChild.runId!));
    const childEnvelope = JSON.parse(readFileSync(workflowResultFile(retriedChild.runDir!), "utf8"));
    expect(childEnvelope.storageRootRunId).toBe(interrupted.runId);
    expect(childEnvelope.lineage.rootRunId).toBe(resumed.runId);
    expect(readWorkflowRunScriptSnapshot(root, retriedChild.runId!)).toMatchObject({ kind: "ready" });
    const resumedAgain = await run(resumed.runId);
    expect(resumedAgain.ok, resumedAgain.error).toBe(true);
    expect(resumedAgain.runDir).toBe(path.join(interrupted.runDir, "attempts", resumedAgain.runId));
    expect(resumedAgain.childRuns!.every((child) => child.status === "skipped")).toBe(true);

    calls.length = 0;
    writeWorkflow(root, "child", `${CHILD}\n// changed source identity\n`);
    const changed = await run();
    expect(changed.ok, changed.error).toBe(true);
    expect(calls).toEqual(["write:payload:alpha", "write:payload:beta"]);
  });

  it("reruns completed children when checkpointed primary evidence is missing or changed", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "stale-primary", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/stale-primary",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, `version ${calls}\n`, "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    unlinkSync(stableFile);
    const missing = await run();
    expect(missing.ok, missing.error).toBe(true);
    expect(missing.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(missing.journal.some((line) => line.message?.includes("[workflow:checkpoint-stale]"))).toBe(true);

    writeFileSync(stableFile, "tampered\n", "utf8");
    const changed = await run();
    expect(changed.ok, changed.error).toBe(true);
    expect(changed.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(changed.journal.some((line) => line.message?.includes("changed since checkpoint"))).toBe(true);
    expect(calls).toBe(3);
    expect(readFileSync(stableFile, "utf8")).toBe("version 3\n");
  });

  it("quarantines a corrupt checkpoint and reruns the child", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "corrupt-checkpoint", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/corrupt-checkpoint",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, `version ${calls}\n`, "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/corrupt-checkpoint", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointFile = path.join(
      checkpoints,
      readdirSync(checkpoints).find((name) => name.endsWith(".json"))!,
    );
    writeFileSync(checkpointFile, "not json\n", "utf8");

    const rerun = await run();
    expect(rerun.ok, rerun.error).toBe(true);
    expect(rerun.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(calls).toBe(2);
    expect(readdirSync(checkpoints).some((name) => name.includes(".json.stale-"))).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["object", { runId: "child" }],
    ["whitespace", " child"],
    ["control", "child\u0001run"],
    ["overlong", "a".repeat(129)],
  ] as const)("quarantines a checkpoint with %s childRunId and reruns the child", async (_label, childRunId) => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "invalid-child-run-id", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/invalid-child-run-id",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, `version ${calls}\n`, "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/invalid-child-run-id", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointFile = path.join(
      checkpoints,
      readdirSync(checkpoints).find((name) => name.endsWith(".json"))!,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8")) as Record<string, unknown>;
    if (childRunId === undefined) delete checkpoint.childRunId;
    else checkpoint.childRunId = childRunId;
    writeFileSync(checkpointFile, `${JSON.stringify(checkpoint)}\n`, "utf8");

    const rerun = await run();
    expect(rerun.ok, rerun.error).toBe(true);
    expect(rerun.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(calls).toBe(2);
    expect(readdirSync(checkpoints).some((name) => name.includes(".json.stale-"))).toBe(true);
  });

  it("fails closed without quarantining checkpoint paths that cannot be read as regular files", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "checkpoint-io-error", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/checkpoint-io-error",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, "complete\n", "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/checkpoint-io-error", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    unlinkSync(checkpointFile);
    mkdirSync(checkpointFile);

    const failed = await run();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("not a regular file");
    expect(calls).toBe(1);
    expect(existsSync(checkpointFile)).toBe(true);
    expect(readdirSync(checkpoints).some((name) => name.includes(".stale-"))).toBe(false);
  });

  it("fails closed without quarantining a checkpoint on a transient permission error", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "checkpoint-permission", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/checkpoint-permission",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, "complete\n", "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/checkpoint-permission", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    chmodSync(checkpointFile, 0o000);
    try {
      const failed = await run();
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatch(/EACCES|permission denied/u);
      expect(calls).toBe(1);
      expect(readdirSync(checkpoints).some((name) => name.includes(".stale-"))).toBe(false);
    } finally {
      chmodSync(checkpointFile, 0o600);
    }
  });

  it.each([
    ["duplicate", ["same", "same"]],
    ["unsafe", ["safe", "not safe"]],
  ])("rejects %s item keys before any child or agent starts", async (_label, items) => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    let calls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload",
      items,
      outputDir: `outputs/${_label}`,
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicated|child key/u);
    expect(calls).toBe(0);
    expect(result.childRuns).toBeUndefined();
  });

  it("shares the physical invocation fuse instead of resetting it in each child", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root, { mode: "json" });
    let calls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload",
      items: ["alpha", "beta"],
      outputDir: "outputs/shared-budget",
      budget: { totalAgents: 1 },
      createExecutor: executor((prompt) => {
        calls += 1;
        const key = prompt.slice(prompt.lastIndexOf(":") + 1);
        writeFileSync(path.join(root, "outputs", "shared-budget", `${key}.md`), "done\n", "utf8");
        return "written";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("maxTotalAgentInvocations cap of 1");
    expect(calls).toBe(1);
    expect(readWorkflowRunResult(root, result.childRuns![0]!.runId!)?.budget?.totalAgents).toBe(1);
  });

  it("shares one concurrency gate across parallel saved children", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(
      root,
      "parallel-parent",
      `export default async function run(dsl) {
  const items = dsl.items();
  return dsl.parallel(items.map((item) => () => dsl.invokeWorkflow({
    name: "child", key: item, keys: items, input: item, items: [item], outputDir: dsl.outputDir(),
  })));
}\n`,
    );
    const harness = createHarness(root);
    let active = 0;
    let peak = 0;

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parallel-parent",
      items: ["alpha", "beta"],
      outputDir: "outputs/shared-concurrency",
      budget: { concurrency: 1 },
      createExecutor: executor(async (prompt) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        const key = prompt.slice("write:".length);
        writeFileSync(path.join(root, "outputs", "shared-concurrency", `${key}.md`), "done\n", "utf8");
        active -= 1;
        return "written";
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(peak).toBe(1);
  });

  it("propagates root cancellation into an active saved child", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const pending = runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: controller.signal,
      name: "parent",
      input: "payload",
      items: ["alpha"],
      outputDir: "outputs/cancelled",
      createExecutor: () => ({
        async run(request, signal) {
          childSignal = signal;
          notifyStarted?.();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return {
            status: "cancelled" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "root cancelled",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    await started;
    controller.abort(new Error("operator stop"));
    const result = await pending;

    expect(childSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.disposition?.status).toBe("cancelled");
    expect(result.childRuns).toEqual([expect.objectContaining({ status: "cancelled", key: "alpha" })]);
    const childRunId = result.childRuns?.[0]?.runId;
    expect(childRunId).toBeTypeOf("string");
    expect(
      result.journal.some(
        (line) => line.message?.includes(`[workflow:child-start]`) && line.message.includes(childRunId!),
      ),
    ).toBe(true);
    expect(
      result.journal.some(
        (line) => line.message?.includes(`[workflow:child-end]`) && line.message.includes(`status=cancelled`),
      ),
    ).toBe(true);
  });

  it("rejects a child source mutation immediately after snapshot start, before import or agent work", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const marker = path.join(root, "import-side-effect.txt");
    let calls = 0;
    let mutated = false;

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload",
      items: ["alpha"],
      outputDir: "outputs/source-race",
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
      onEvent: (line) => {
        if (mutated || !line.message?.includes("[workflow:child-start]")) return;
        mutated = true;
        writeWorkflow(
          root,
          "child",
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported\\n");\nexport default async (dsl) => dsl.agent("must not run");\n`,
        );
      },
    });

    expect(mutated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("source changed before execution");
    expect(calls).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.childRuns).toEqual([expect.objectContaining({ status: "failed", key: "alpha" })]);
    expect(result.journal.some((line) => line.message?.includes("[workflow:child-start]"))).toBe(true);
    expect(
      result.journal.some(
        (line) => line.message?.includes("[workflow:child-end]") && line.message.includes("status=failed"),
      ),
    ).toBe(true);
  });

  it("rejects direct and nested saved-workflow cycles before descendant agent work", async () => {
    const root = project();
    writeWorkflow(
      root,
      "self",
      `export default (dsl) => dsl.invokeWorkflow({ name: "self", key: "one", keys: ["one"], items: [], outputDir: dsl.outputDir() });\n`,
    );
    writeWorkflow(root, "grandchild", `export default async (dsl) => dsl.agent("must not run");\n`);
    writeWorkflow(
      root,
      "nested-child",
      `export default (dsl) => dsl.invokeWorkflow({ name: "grandchild", key: "one", keys: ["one"], items: [], outputDir: dsl.outputDir() });\n`,
    );
    writeWorkflow(
      root,
      "nested-parent",
      `export default (dsl) => dsl.invokeWorkflow({ name: "nested-child", key: "one", keys: ["one"], items: [], outputDir: dsl.outputDir() });\n`,
    );
    const harness = createHarness(root);
    let calls = 0;
    const createExecutor = executor(() => {
      calls += 1;
      return "must not run";
    });

    const direct = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "self",
      outputDir: "outputs/direct-cycle",
      createExecutor,
    });
    const nested = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "nested-parent",
      outputDir: "outputs/nested-cycle",
      createExecutor,
    });

    expect(direct.ok).toBe(false);
    expect(direct.error).toContain("cycle detected");
    expect(nested.ok).toBe(false);
    expect(nested.error).toContain("may not invoke another");
    expect(calls).toBe(0);
  });
});
