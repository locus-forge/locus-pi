import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWorkflowOperatorHandoff,
  claimWorkflowOperatorHandoff,
  workflowContinuationForHandoff,
} from "../../../../../extensions/workflows/runtime/workflow-handoff.js";
import { readWorkflowRunResult } from "../../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import {
  readWorkflowResumeWorkspaceIdentity,
  runWorkflowScript,
} from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../../test-harness.js";
import { executor, project, writeWorkflow, CHILD, PARENT } from "../../../../fixtures/workflow-durable-project.js";

/**
 * A root `meta.outputDir` binds one workflow directory. These cases pin what the
 * binding changes across runs: saved children admitted under the root's proven
 * `.local` binding, checkpoint reuse scoped to one launch lineage, operator
 * continuation in the same directory, and pre-lineage launch bindings that stay
 * readable for unbound owner resume.
 */

/** Minimal awaiting-operator root: stops once, then consumes its continuation. */
const BOUND_HANDOFF = `export const meta = { name: "bound-handoff", outputDir: ".local/handoff" };
export default async function run(dsl, input) {
  if (dsl.continuationArtifacts().length > 0) return { ok: true, input };
  const intentRef = dsl.publishArtifact("intent.md", "review current changes", "prepare");
  dsl.awaitOperator({
    reason: "review clarification required",
    operatorHandoff: {
      title: "Choose review scope",
      questions: [{ kind: "text", id: "scope", prompt: "What should be reviewed?" }],
      continuationArtifactRefs: [intentRef],
    },
  });
  return { mode: "prepared", intentRef };
}
`;

describe("bound workflow directory across runs", () => {
  const BOUND_PARENT = PARENT.replace(
    `export const meta = { name: "parent", profile: "standard" };`,
    `export const meta = { name: "parent", profile: "standard", outputDir: ".local/catalog" };`,
  );

  function boundProject() {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", BOUND_PARENT);
    const harness = createHarness(root);
    const calls: string[] = [];
    const directories: string[] = [];
    const createExecutor = executor((prompt, request) => {
      calls.push(prompt);
      directories.push(request.task);
      const key = prompt.slice(prompt.lastIndexOf(":") + 1);
      writeFileSync(path.join(root, ".local", "catalog", `${key}.md`), `${prompt}\n`, "utf8");
      return "written";
    });
    const run = (options: { resumeFromRunId?: string } = {}) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        createExecutor,
        ...options,
      });
    return { root, calls, directories, run };
  }

  it("admits the child under the root's .local binding and shares that one directory", async () => {
    const { root, calls, directories, run } = boundProject();
    const first = await run();

    expect(first.ok, first.error).toBe(true);
    expect(first.workspaceDirRelative).toBe(".local/catalog");
    expect(first.outputDirRelative).toBe(".local/catalog");
    expect(first.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(calls).toEqual(["write:payload:alpha"]);
    expect(directories[0]).toContain(
      `workflow directory (handoffs under artifacts/, final files): ${path.join(root, ".local", "catalog")}`,
    );
    expect(readWorkflowRunResult(root, first.childRuns![0]!.runId!)).toMatchObject({
      workspaceDirRelative: ".local/catalog",
      outputDirRelative: ".local/catalog",
    });
    expect(existsSync(path.join(root, ".locus-pi", "workspaces"))).toBe(false);
  });

  it("re-executes items on a fresh launch but reuses them across resume and resume-of-resume", async () => {
    const { root, calls, run } = boundProject();
    const first = await run();
    expect(first.ok, first.error).toBe(true);
    expect(readWorkflowLaunchBinding(root, first.runId)?.rootLineageId).toBe(first.runId);

    calls.length = 0;
    const fresh = await run();
    expect(fresh.ok, fresh.error).toBe(true);
    expect(calls).toEqual(["write:payload:alpha"]);
    expect(fresh.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(readWorkflowLaunchBinding(root, fresh.runId)?.rootLineageId).toBe(fresh.runId);

    calls.length = 0;
    const resumed = await run({ resumeFromRunId: first.runId });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual([]);
    expect(resumed.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
    expect(readWorkflowLaunchBinding(root, resumed.runId)?.rootLineageId).toBe(first.runId);

    const resumedAgain = await run({ resumeFromRunId: resumed.runId });
    expect(resumedAgain.ok, resumedAgain.error).toBe(true);
    expect(calls).toEqual([]);
    expect(resumedAgain.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
    expect(readWorkflowLaunchBinding(root, resumedAgain.runId)?.rootLineageId).toBe(first.runId);
  });

  it("keeps cross-run checkpoint reuse for an unbound explicit stable workspace", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const workspaceDir = "outputs/stable";
    let calls = 0;
    const createExecutor = executor((prompt) => {
      calls += 1;
      const key = prompt.slice(prompt.lastIndexOf(":") + 1);
      writeFileSync(path.join(root, workspaceDir, "outputs", `${key}.md`), `${prompt}\n`, "utf8");
      return "written";
    });
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        workspaceDir,
        createExecutor,
      });

    expect((await run()).ok).toBe(true);
    const second = await run();
    expect(second.ok, second.error).toBe(true);
    expect(calls).toBe(1);
    expect(second.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
  });
  it("continues a bound root in its .local directory and keeps the source launch lineage", async () => {
    const root = project();
    writeWorkflow(root, "bound-handoff", BOUND_HANDOFF);
    const harness = createHarness(root);
    const source = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "bound-handoff",
    });
    const read = readWorkflowOperatorHandoff(source);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("expected ready handoff");
    const claim = claimWorkflowOperatorHandoff(root, read.handoff);
    if (claim.status !== "claimed") throw new Error("expected claim");
    const workspace = readWorkflowResumeWorkspaceIdentity(root, source.runId);
    expect(workspace.relativePath).toBe(".local/handoff");

    const child = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "bound-handoff",
      input: "operator answer",
      continuation: workflowContinuationForHandoff(read.handoff),
      operatorHandoffClaim: claim.claim,
      operatorHandoffWorkspaceReuse: { sourceRunId: source.runId, ...workspace },
    });
    expect(child.ok, child.error).toBe(true);
    expect(child.workspaceDirRelative).toBe(".local/handoff");
    expect(child.outputDirRelative).toBe(".local/handoff");
    expect(readWorkflowLaunchBinding(root, child.runId)?.rootLineageId).toBe(source.runId);
  });

  it("resumes an unbound owner run from a launch binding written before rootLineageId existed", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "post-code-review", PARENT);
    const harness = createHarness(root);
    const workspaceDir = "outputs/pre-lineage-binding";
    let calls = 0;
    const createExecutor = executor((prompt) => {
      calls += 1;
      writeFileSync(path.join(root, workspaceDir, "outputs", "alpha.md"), `${prompt}\n`, "utf8");
      return "written";
    });
    const run = (resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        input: "review alpha",
        items: ["alpha"],
        workspaceDir,
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor,
      });

    const first = await run();
    expect(first.ok, first.error).toBe(true);
    const bindingFile = workflowLaunchBindingFile(first.runDir);
    const binding = JSON.parse(readFileSync(bindingFile, "utf8")) as Record<string, unknown>;
    expect(binding.schema).toBe("locus-pi.workflow-launch-binding.v2");
    expect(binding.rootLineageId).toBe(first.runId);
    delete binding.rootLineageId;
    writeFileSync(bindingFile, `${JSON.stringify(binding)}\n`, "utf8");
    const preChange = readWorkflowLaunchBinding(root, first.runId);
    expect(preChange).not.toBeNull();
    expect(preChange).not.toHaveProperty("rootLineageId");

    const resumed = await run(first.runId);
    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toBe(1);
    expect(resumed.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
    expect(readWorkflowLaunchBinding(root, resumed.runId)?.rootLineageId).toBe(first.runId);
  });
});
