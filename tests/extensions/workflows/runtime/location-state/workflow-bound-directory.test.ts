/** Output-free launch format, exact root lineage and retained legacy evidence. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPersistedWorkflowOperatorHandoff,
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
import { workflowWorkspaceStateDir } from "../../../../../extensions/workflows/runtime/workflow-output.js";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness } from "../../../../test-harness.js";
import { executor, project, writeWorkflow, CHILD, PARENT } from "../../../../fixtures/workflow-durable-project.js";

const HANDOFF = `export default function run(dsl, input) {
  const refs = dsl.continuationArtifacts();
  if (refs.length > 0) return dsl.consumeTextArtifact(refs[0].sourceRef).text + ":" + input;
  const intentRef = dsl.publishArtifact("intent.md", "retained intent", "prepare");
  dsl.awaitOperator({ reason: "clarification required", operatorHandoff: {
    title: "Choose scope", questions: [{ kind: "text", id: "scope", prompt: "What should be reviewed?" }],
    continuationArtifactRefs: [intentRef],
  } });
  return "prepared";
}
`;

describe("output-free execution format across runs", () => {
  it("gives every fresh root a lineage and reuses exact child work only in that lineage", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    let calls = 0;
    const run = (resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        workspaceDir: "state/shared",
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor: executor(() => {
          calls += 1;
          return "written";
        }),
      });
    const first = await run();
    expect(first.ok, first.error).toBe(true);
    const checkpointRoot = path.join(workflowWorkspaceStateDir(root, "state/shared"), "checkpoints");
    const legacyCheckpoint = path.join(checkpointRoot, "legacy.json");
    const legacyBytes = JSON.stringify({
      schema: "locus-pi.workflow-checkpoint.v2",
      outputIdentity: "state/shared/outputs",
      childRunId: first.childRuns![0]!.runId,
    });
    writeFileSync(legacyCheckpoint, legacyBytes);
    const fresh = await run();
    expect(first.ok, first.error).toBe(true);
    expect(fresh.ok, fresh.error).toBe(true);
    expect(calls).toBe(2);
    expect(readWorkflowLaunchBinding(root, first.runId)).toMatchObject({
      schema: "locus-pi.workflow-launch-binding.v3",
      rootLineageId: first.runId,
    });
    expect(readWorkflowLaunchBinding(root, fresh.runId)?.rootLineageId).toBe(fresh.runId);
    const resumed = await run(first.runId);
    const resumedAgain = await run(resumed.runId);
    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumedAgain.ok, resumedAgain.error).toBe(true);
    expect(calls).toBe(2);
    expect(resumedAgain.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);
    expect(readWorkflowLaunchBinding(root, resumedAgain.runId)?.rootLineageId).toBe(first.runId);
    for (const result of [first, fresh, resumed, resumedAgain]) {
      expect(result).not.toHaveProperty("outputDir");
      expect(result).not.toHaveProperty("primaryFile");
      const binding = JSON.parse(readFileSync(workflowLaunchBindingFile(result.runDir), "utf8"));
      expect(binding).not.toHaveProperty("output");
    }
    const checkpoints = readdirSync(path.join(checkpointRoot, "v3"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(path.join(checkpointRoot, "v3", name), "utf8")));
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map((record) => record.rootLineageId).sort()).toEqual([first.runId, fresh.runId].sort());
    for (const checkpoint of checkpoints) {
      expect(checkpoint.schema).toBe("locus-pi.workflow-checkpoint.v3");
      expect(checkpoint).not.toHaveProperty("outputIdentity");
      expect(checkpoint).not.toHaveProperty("primaryFile");
    }
    expect(readFileSync(legacyCheckpoint, "utf8")).toBe(legacyBytes);
    expect(existsSync(path.join(root, "state/shared/outputs"))).toBe(false);
    expect(existsSync(path.join(root, ".locus-pi/workflow-output-state"))).toBe(false);
  });

  it("preserves an implicit task resume's explicit native workspace across resume-of-resume", async () => {
    const root = project();
    mkdirSync(path.join(root, ".locus-pi/workflows/task"));
    writeWorkflow(root, "task/draft", `export default (dsl, input) => dsl.agent(input, { label: "draft" });\n`);
    const harness = createHarness(root);
    let calls = 0;
    const run = (resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "task/draft",
        input: "exact draft",
        ...(resumeFromRunId === undefined ? { workspaceDir: "state/task-explicit" } : { resumeFromRunId }),
        createExecutor: executor(() => {
          calls += 1;
          return "draft";
        }),
      });
    const first = await run();
    const resumed = await run(first.runId);
    const resumedAgain = await run(resumed.runId);
    for (const result of [first, resumed, resumedAgain]) {
      expect(result.ok, result.error).toBe(true);
      expect(result.workspaceDirExplicit).toBe(true);
      expect(result.workspaceDirRelative).toBe("state/task-explicit");
      expect(readWorkflowLaunchBinding(root, result.runId)?.workspace.explicit).toBe(true);
      expect(readWorkflowLaunchBinding(root, result.runId)?.rootLineageId).toBe(first.runId);
    }
    expect(calls).toBe(1);
  });

  it("invalidates child checkpoints when exact input, ordered items or parent source changes", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    const parent = `export default (dsl, input) => dsl.invokeWorkflow({name: "child", key: "work", keys: ["work"], input, items: dsl.items()});\n`;
    writeWorkflow(root, "parent", parent);
    const harness = createHarness(root);
    let calls = 0;
    const run = (input: string, items: readonly string[], resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input,
        items,
        workspaceDir: "state/input-bound",
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor: executor(() => {
          calls += 1;
          return "written";
        }),
      });
    const first = await run("one", ["a", "b"]);
    const same = await run("one", ["a", "b"], first.runId);
    expect(same.ok, same.error).toBe(true);
    expect(calls).toBe(1);
    const input = await run("two", ["a", "b"], same.runId);
    expect(input.ok, input.error).toBe(true);
    expect(calls).toBe(2);
    const items = await run("two", ["b", "a"], input.runId);
    expect(items.ok, items.error).toBe(true);
    expect(calls).toBe(3);
    writeWorkflow(root, "parent", parent + "// changed parent source\n");
    const changed = await run("two", ["b", "a"], items.runId);
    expect(changed.ok, changed.error).toBe(true);
    expect(calls).toBe(4);
    expect(readWorkflowLaunchBinding(root, changed.runId)?.rootLineageId).toBe(first.runId);
  });

  it("preserves verified string-artifact continuation and source lineage", async () => {
    const root = project();
    writeWorkflow(root, "handoff", HANDOFF);
    const harness = createHarness(root);
    const source = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "handoff",
      workspaceDir: "state/handoff",
    });
    expect(source.disposition).toMatchObject({ status: "awaiting_operator" });
    const handoff = readPersistedWorkflowOperatorHandoff(root, source.runId);
    if (handoff.status !== "ready") throw new Error("Expected ready handoff");
    const claim = claimWorkflowOperatorHandoff(root, handoff.handoff);
    if (claim.status !== "claimed") throw new Error("Expected handoff claim");
    const child = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "handoff",
      input: "agreed scope",
      continuation: workflowContinuationForHandoff(handoff.handoff),
      operatorHandoffClaim: claim.claim,
      operatorHandoffWorkspaceReuse: {
        sourceRunId: source.runId,
        ...readWorkflowResumeWorkspaceIdentity(root, source.runId),
      },
    });
    expect(child.ok, child.error).toBe(true);
    expect(child.result).toBe("retained intent:agreed scope");
    expect(child.workspaceDir).toBe(source.workspaceDir);
    expect(readWorkflowLaunchBinding(root, child.runId)?.rootLineageId).toBe(source.runId);
    expect(child.continuation?.originRunId).toBe(source.runId);
  });

  it("refuses interrupted recovery of an old output-bound binding before any work", async () => {
    const root = project();
    writeWorkflow(root, "serial", `export default (dsl, input) => dsl.agent(input, { label: "serial" });\n`);
    const harness = createHarness(root);
    let calls = 0;
    const options = {
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "serial",
      input: "exact request",
      createExecutor: executor(() => {
        calls += 1;
        return "confirmed";
      }),
    };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(true);
    const bindingPath = workflowLaunchBindingFile(first.runDir);
    const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
    const oldBytes = JSON.stringify({
      ...binding,
      schema: "locus-pi.workflow-launch-binding.v2",
      output: { source: "default" },
    });
    writeFileSync(bindingPath, oldBytes);
    rmSync(workflowResultFile(first.runDir));
    const recovered = await runWorkflowScript({ ...options, resumeFromRunId: first.runId, recoverInterrupted: true });
    expect(recovered.ok).toBe(false);
    expect(recovered.error).toMatch(/output-free v3 required.*Start a fresh migrated run/u);
    expect(recovered.journal.some((line) => line.kind === "agent_start")).toBe(false);
    expect(calls).toBe(1);
    expect(readFileSync(bindingPath, "utf8")).toBe(oldBytes);
    expect(existsSync(workflowResultFile(first.runDir))).toBe(false);
  });

  it.each(["default", "declared", "missing-binding"])(
    "keeps %s legacy evidence readable but refuses resume and handoff before work",
    async (legacy) => {
      const root = project();
      writeWorkflow(root, "handoff", HANDOFF);
      const harness = createHarness(root);
      const source = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "handoff",
        workspaceDir: "state/legacy",
      });
      const bindingPath = workflowLaunchBindingFile(source.runDir);
      const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
      const resultPath = workflowResultFile(source.runDir);
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      if (legacy === "missing-binding") rmSync(bindingPath);
      else {
        const output = path.join(root, "legacy-output");
        mkdirSync(output);
        const outputRecord = {
          absolutePath: output,
          relativePath: "legacy-output",
          physicalPath: output,
          physicalIdentity: "legacy-output",
          physicalIdentitySchemaVersion: 1,
          source: legacy,
        };
        writeFileSync(
          bindingPath,
          JSON.stringify({ ...binding, schema: "locus-pi.workflow-launch-binding.v2", output: outputRecord }) + "\n",
        );
        writeFileSync(
          resultPath,
          JSON.stringify({
            ...result,
            outputDir: output,
            outputDirRelative: "legacy-output",
            outputPhysicalIdentity: "legacy-output",
            outputPhysicalIdentitySchemaVersion: 1,
            outputSource: legacy,
            primaryFile: {
              absolutePath: path.join(output, "gone.md"),
              relativePath: "gone.md",
              sha256: "a".repeat(64),
              bytes: 7,
            },
          }) + "\n",
        );
      }
      if (legacy === "declared") rmSync(path.join(root, "legacy-output"), { recursive: true });
      const oldResultBytes = readFileSync(resultPath);
      const oldBindingBytes = existsSync(bindingPath) ? readFileSync(bindingPath) : undefined;
      const readable = readWorkflowRunResult(root, source.runId);
      expect(readable?.result).toBe("prepared");
      if (legacy === "declared") expect(readable?.outputDirUnavailable).toMatch(/unavailable/u);
      if (legacy !== "missing-binding")
        expect(readable?.primaryFile).toMatchObject({ relativePath: "gone.md", bytes: 7 });
      expect(readWorkflowLaunchBinding(root, source.runId)).toBeNull();
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "handoff",
        workspaceDir: "state/legacy",
        resumeFromRunId: source.runId,
        createExecutor: executor(() => {
          throw new Error("legacy must not start work");
        }),
      });
      expect(resumed.ok).toBe(false);
      expect(resumed.error).toMatch(/output-free v3 required.*Start a fresh migrated run/u);
      expect(resumed.journal.some((line) => line.kind === "agent_start")).toBe(false);
      expect(() => readWorkflowResumeWorkspaceIdentity(root, source.runId)).toThrow(/output-free v3 required/u);
      const handoff = readPersistedWorkflowOperatorHandoff(root, source.runId);
      expect(handoff.status).toBe("ready");
      if (handoff.status !== "ready") throw new Error("Expected retained legacy handoff");
      const attempt = claimWorkflowOperatorHandoff(root, handoff.handoff);
      if (attempt.status !== "claimed") throw new Error("Expected legacy claim");
      const continued = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "handoff",
        input: "answer",
        continuation: workflowContinuationForHandoff(handoff.handoff),
        operatorHandoffClaim: attempt.claim,
        createExecutor: executor(() => {
          throw new Error("legacy handoff must not start work");
        }),
      });
      expect(continued.ok).toBe(false);
      expect(continued.error).toMatch(/output-free v3 required/u);
      expect(continued.journal.some((line) => line.kind === "agent_start")).toBe(false);

      expect(readFileSync(resultPath)).toEqual(oldResultBytes);
      if (oldBindingBytes !== undefined) expect(readFileSync(bindingPath)).toEqual(oldBindingBytes);
    },
  );
});
