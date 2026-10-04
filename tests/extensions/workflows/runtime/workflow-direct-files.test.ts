import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import workflows from "../../../../extensions/workflows/index.js";
import { readWorkflowRunResult } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-direct-files-"));
  roots.push(root);
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "default.md"),
    "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
  );
  mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
  return root;
}

describe("explicit agent files and native receipts", () => {
  it.each(["project", "temporary-worktree"] as const)(
    "writes/reads the exact requested file from %s cwd, keeping native evidence separate",
    async (mode) => {
      const root = project();
      const workingDirectory = path.join(root, "packages", "docs site");
      mkdirSync(workingDirectory, { recursive: true });
      if (mode === "temporary-worktree") {
        execFileSync("git", ["init", "-q", root]);
        execFileSync("git", [
          "-C",
          root,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-qm",
          "fixture",
        ]);
      }
      const destination = path.join(root, "assigned", "reports", "plan.md");
      writeFileSync(
        path.join(root, ".locus-pi", "workflows", "files.workflow.mjs"),
        [
          "export default async function runWorkflow(dsl) {",
          `  await dsl.agent(${JSON.stringify(`Write ${destination} through write and read it back.`)}, { label: "writer", workspaceMode: ${JSON.stringify(mode)} });`,
          `  const answer = await dsl.agent(${JSON.stringify(`Read the exact file ${destination}; do not search or reconstruct it.`)}, { label: "reader" });`,
          "  return answer;",
          "}",
        ].join("\n"),
      );
      const harness = createHarness(root, { sessionId: "run-files" });
      harness.ctx.session = { ...harness.ctx.session!, workingDirectory };
      const requests: AgentRunRequest[] = [];
      const createExecutor = (): AgentExecutor => ({
        async run(request) {
          requests.push(request);
          assert.ok(request.workingDirectory);
          assert.ok(request.task.includes(destination));
          assert.ok(request.task.includes(`pwd (actual execution directory): ${request.workingDirectory}`));
          assert.ok(!request.task.includes("workflow output (final deliverables)"));
          const signal = new AbortController().signal;
          if (requests.length === 1) {
            await createWriteTool(request.workingDirectory).execute(
              "write",
              { path: destination, content: "the plan body" },
              signal,
            );
          }
          const read = await createReadTool(request.workingDirectory).execute("read", { path: destination }, signal);
          assert.ok(read.content.some((item) => item.type === "text" && item.text.includes("the plan body")));
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "read assigned file",
            text: "the plan body",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      });
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "files",
        createExecutor,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result, "the plan body");
      assert.equal(readFileSync(destination, "utf8"), "the plan body");
      assert.equal(requests[1]!.workingDirectory, workingDirectory);
      if (mode === "project") assert.equal(requests[0]!.workingDirectory, workingDirectory);
      else {
        assert.notEqual(requests[0]!.workingDirectory, workingDirectory);
        // Retained execution evidence is unchanged; simulate later checkout release.
        execFileSync("git", ["-C", root, "worktree", "remove", "--force", requests[0]!.workingDirectory!]);
        assert.equal(existsSync(requests[0]!.workingDirectory!), false);
        const readAfterRelease = await createReadTool(workingDirectory).execute(
          "read-after-release",
          { path: destination },
          new AbortController().signal,
        );
        assert.ok(readAfterRelease.content.some((item) => item.type === "text" && item.text.includes("the plan body")));
      }
      const workspaceDir = path.join(root, ".locus-pi", "workspaces", `${result.runId}-files`);
      assert.equal(result.workspaceDir, workspaceDir);
      assert.deepEqual(readdirSync(workspaceDir), [".workflow-runs.md"]);
      assert.equal("outputDir" in result, false);
      assert.equal("primaryFile" in result, false);
      const persisted = readWorkflowRunResult(root, result.runId);
      assert.equal(persisted?.workspacePhysicalIdentity, `.locus-pi/workspaces/${result.runId}-files`);
      assert.equal(persisted?.workspacePhysicalIdentityInvalid, undefined);
      assert.deepEqual(readdirSync(workflowRunOutputsDir(result.runDir)).sort(), ["README.md", "workflow-result.md"]);
      assert.deepEqual(readdirSync(result.runDir).sort(), ["README.md", "outputs", "runtime"]);
      assert.ok(readdirSync(workflowRunRuntimeDir(result.runDir)).includes("journal.ndjson"));
    },
  );

  it("returns native tool evidence without output or primary-file projections", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "receipt.workflow.mjs"),
      'export default async function run() { return "native answer"; }',
    );
    const harness = createHarness(root, { sessionId: "direct-file-receipt" });
    workflows(harness.pi);
    const result = await harness.tools
      .get("workflow")!
      .execute("receipt", { name: "receipt" }, new AbortController().signal, () => void 0, harness.ctx);
    assert.notEqual(result.isError, true);
    for (const field of ["outputDir", "stableOutputDir", "stableOutputDirRelative", "primaryFile"]) {
      assert.equal(Object.hasOwn(result.details ?? {}, field), false, field);
    }
    assert.ok(result.details?.runDir);
    assert.ok(result.details?.resultTextPath);
  });
});
