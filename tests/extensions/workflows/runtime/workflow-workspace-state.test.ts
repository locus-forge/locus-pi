import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireWorkflowRootLease,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  releaseWorkflowRootLease,
  WORKFLOW_OUTPUT_LOCK_FILE,
  writeWorkflowWorkspaceRunLink,
} from "../../../../extensions/workflows/runtime/workflow-workspace-state.js";
import { resolveWorkflowOutputDirectory } from "../../../../extensions/workflows/runtime/workflow-workspace.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { writeWorkflowRunGroupReport } from "../../../../extensions/workflows/runtime/workflow-run-report.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import { project, writeWorkflow } from "../../../fixtures/workflow-durable-project.js";

describe("leased workspace navigation under a task artifacts root", () => {
  it("records that a task artifacts workspace also holds the runtime lease and navigation files", () => {
    const root = project();
    const outputDir = ".tasks/T-144-2026-09-08-workflow/artifacts";
    const output = resolveWorkflowOutputDirectory(root, outputDir, "unused", root);
    expect(output.relativePath).toBe(outputDir);
    const groupDir = ensureWorkflowRunDir(root, "tasks-root");
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "tasks-root" });
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(true);
    writeWorkflowRunGroupReport(
      {
        projectRoot: root,
        runId: "tasks-root",
        storageRootRunId: "tasks-root",
        workspaceDir: output.absolutePath,
        workflow: "unused",
      },
      lease,
    );
    writeWorkflowWorkspaceRunLink(lease, groupDir, "tasks-root");
    expect(existsSync(path.join(root, outputDir, ".workflow-runs.md"))).toBe(true);
    releaseWorkflowRootLease(lease);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });
});

describe("checkpoint path confinement", () => {
  const identity = {
    parentScriptSha256: "a".repeat(64),
    childScriptSha256: "b".repeat(64),
    outputDir: "outputs/checkpoint-confinement",
    itemKey: "item-one",
    childRunId: "child-one",
  };

  it("rejects a valid-looking checkpoint behind an external checkpoints ancestor", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, identity.outputDir, "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "checkpoint-root" });
    const checkpoint = commitWorkflowCompletedCheckpoint(lease, identity);
    const checkpoints = path.join(lease.stateDir, "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-checkpoint-outside-"));
    const outsideFile = path.join(outside, checkpointName!);
    writeFileSync(outsideFile, readFileSync(checkpointFile));
    rmSync(checkpoints, { recursive: true, force: true });
    symlinkSync(outside, checkpoints, "dir");

    expect(() => readWorkflowCompletedCheckpoint(lease, identity)).toThrow("contains a symlink");
    expect(readFileSync(outsideFile, "utf8")).toContain(checkpoint.childRunId);

    rmSync(checkpoints, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    releaseWorkflowRootLease(lease);
  });

  it("rejects a dangling checkpoint leaf instead of treating it as absent", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, identity.outputDir, "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "checkpoint-dangling" });
    commitWorkflowCompletedCheckpoint(lease, identity);
    const checkpoints = path.join(lease.stateDir, "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    unlinkSync(checkpointFile);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-checkpoint-dangling-"));
    symlinkSync(path.join(outside, "missing.json"), checkpointFile);

    expect(() => readWorkflowCompletedCheckpoint(lease, identity)).toThrow("contains a symlink");
    expect(existsSync(path.join(outside, "missing.json"))).toBe(false);

    rmSync(checkpoints, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    releaseWorkflowRootLease(lease);
  });
});

describe("fenced output leases and atomic checkpoints", () => {
  it("writes navigation only for the active root owner and preserves user backlink conflicts", async () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/links", "links", root);
    const groupDir = ensureWorkflowRunDir(root, "root-one");
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "root-one" });
    const input = {
      projectRoot: root,
      runId: "root-one",
      storageRootRunId: "root-one",
      workspaceDir: output.absolutePath,
      workflow: "links",
    };
    writeWorkflowRunGroupReport(input, lease);
    const readme = readFileSync(path.join(groupDir, "README.md"), "utf8");
    expect(existsSync(path.join(groupDir, "children"))).toBe(false);
    expect(existsSync(path.join(groupDir, "attempts"))).toBe(false);
    expect(readme).not.toContain("[Child runs](children/)");
    expect(readme).not.toContain("[Resume attempts](attempts/)");
    expect(readme).not.toContain("[First run status](runtime/result.json)");
    const backlinkFile = path.join(output.absolutePath, ".workflow-runs.md");
    const backlink = readFileSync(backlinkFile, "utf8");
    expect(readme).toContain("# Workflow run group");
    expect(backlink).toContain("# Linked workflow runs");
    const legacyBacklink = backlink
      .replace("# Linked workflow runs", "# Связанные запуски workflow")
      .replace(
        "Status and history are stored in group directories; this file contains links only.",
        "Статусы и история находятся в папках групп; этот файл содержит только ссылки.",
      )
      .replace("[Group root-one]", "[Группа root-one]");
    writeFileSync(backlinkFile, legacyBacklink);
    writeWorkflowWorkspaceRunLink(lease, groupDir, "root-one");
    expect(readFileSync(backlinkFile, "utf8")).toBe(backlink);

    writeFileSync(path.join(groupDir, "README.md"), "<!-- locus-pi:workflow-run-group:v1 -->\npartial");
    writeWorkflowRunGroupReport(input, lease);
    expect(readFileSync(path.join(groupDir, "README.md"), "utf8")).toBe(readme);
    writeFileSync(backlinkFile, "<!-- locus-pi:workflow-workspace-runs:v1 -->\npartial");
    expect(() => writeWorkflowWorkspaceRunLink(lease, groupDir, "root-one")).toThrow(
      expect.objectContaining({ code: "WORKFLOW_NAVIGATION_RECOVERY_REQUIRED" }),
    );
    expect(readFileSync(backlinkFile, "utf8")).toBe("<!-- locus-pi:workflow-workspace-runs:v1 -->\npartial");
    writeFileSync(backlinkFile, backlink);
    writeFileSync(backlinkFile, backlink.replace("[Group root-one]", "[Group root-two]"));
    expect(() => writeWorkflowWorkspaceRunLink(lease, groupDir, "root-one")).toThrow(
      expect.objectContaining({ code: "WORKFLOW_NAVIGATION_RECOVERY_REQUIRED" }),
    );
    writeFileSync(backlinkFile, backlink);
    expect(readdirSync(groupDir).some((name) => name.includes(".tmp-"))).toBe(false);
    expect(readdirSync(output.absolutePath).some((name) => name.includes(".tmp-"))).toBe(false);
    expect(() => writeWorkflowRunGroupReport({ ...input, runId: "child" }, lease)).toThrow(
      /Only the root lease owner/u,
    );
    releaseWorkflowRootLease(lease);
    expect(() => writeWorkflowRunGroupReport(input, lease)).toThrow();
    expect(() => writeWorkflowWorkspaceRunLink(lease, groupDir, "root-one")).toThrow();
    expect(readFileSync(path.join(groupDir, "README.md"), "utf8")).toBe(readme);
    expect(readFileSync(backlinkFile, "utf8")).toBe(backlink);

    writeWorkflow(root, "links", 'export default () => "must not execute";');
    const reserved = path.join(output.absolutePath, ".workflow-runs.md");
    writeFileSync(reserved, "user document\n");
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "links",
      outputDir: output.relativePath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Reserved workflow workspace file/u);
    expect(result.resultPersistence.ok).toBe(true);
    expect(readFileSync(reserved, "utf8")).toBe("user document\n");
    expect(existsSync(path.join(output.absolutePath, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it("retries the live lock-create-to-write acquisition window", async () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/racing-owner", "unused", root);
    const lockFile = path.join(output.absolutePath, WORKFLOW_OUTPUT_LOCK_FILE);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(lockFile)}, "", { flag: "wx" });
process.stdout.write("ready\\n");
setTimeout(() => fs.writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({
  schema: "locus-pi.workflow-output-lease.v1",
  rootRunId: "racing-owner",
  outputDir: ${JSON.stringify(output.relativePath)},
  pid: process.pid,
  fencingToken: "racing-token",
  acquiredAt: new Date().toISOString(),
}) + "\\n"), 25);
setTimeout(() => process.exit(0), 150);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout!, "data");

    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "contender" })).toThrow(
      "owned by live run racing-owner",
    );
    await once(child, "exit");
  });

  it("conflicts for one live namespace while independent namespaces remain ownable", () => {
    const root = project();
    const firstOutput = resolveWorkflowOutputDirectory(root, "outputs/one", "unused", root);
    const secondOutput = resolveWorkflowOutputDirectory(root, "outputs/two", "unused", root);
    const first = acquireWorkflowRootLease({ projectRoot: root, output: firstOutput, rootRunId: "run-one" });

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, output: firstOutput, rootRunId: "run-conflict" }),
    ).toThrow("owned by live run run-one");
    const independent = acquireWorkflowRootLease({
      projectRoot: root,
      output: secondOutput,
      rootRunId: "run-two",
    });

    releaseWorkflowRootLease(independent);
    releaseWorkflowRootLease(first);
  });

  it("allows a new owner after the output directory is removed", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/cleared", "unused", root);
    acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "old-run" });
    rmSync(output.absolutePath, { recursive: true, force: true });

    const recreated = resolveWorkflowOutputDirectory(root, "outputs/cleared", "unused", root);
    const replacement = acquireWorkflowRootLease({ projectRoot: root, output: recreated, rootRunId: "new-run" });

    expect(replacement.lockFile).toBe(path.join(recreated.absolutePath, WORKFLOW_OUTPUT_LOCK_FILE));
    expect(existsSync(replacement.lockFile)).toBe(true);
    releaseWorkflowRootLease(replacement);
  });

  it("keys leases by the physical output target across platform case aliases", () => {
    const root = project();
    const stored = resolveWorkflowOutputDirectory(root, "outputs/CaseAlias", "unused", root);
    const alias = resolveWorkflowOutputDirectory(root, "outputs/casealias", "unused", root);
    const first = acquireWorkflowRootLease({ projectRoot: root, output: stored, rootRunId: "stored-case" });
    const aliasSeesStoredLock = existsSync(path.join(alias.absolutePath, WORKFLOW_OUTPUT_LOCK_FILE));

    if (aliasSeesStoredLock) {
      expect(() => acquireWorkflowRootLease({ projectRoot: root, output: alias, rootRunId: "alias-case" })).toThrow(
        "owned by live run stored-case",
      );
    } else {
      const independent = acquireWorkflowRootLease({ projectRoot: root, output: alias, rootRunId: "alias-case" });
      releaseWorkflowRootLease(independent);
    }

    releaseWorkflowRootLease(first);
  });

  it("reclaims a provably dead local owner and refuses an unreadable owner", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/reclaim", "unused", root);
    const lockFile = path.join(output.absolutePath, WORKFLOW_OUTPUT_LOCK_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-output-lease.v1",
        rootRunId: "dead",
        outputDir: output.relativePath,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const reclaimed = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "replacement" });
    releaseWorkflowRootLease(reclaimed);

    writeFileSync(lockFile, "not json\n", "utf8");
    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "blocked" })).toThrow(
      "verify no writer is active",
    );
  });

  it("fails closed on a symlinked lock file without touching its external sentinel", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/symlinked-lease", "unused", root);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-lease-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const lockFile = path.join(output.absolutePath, WORKFLOW_OUTPUT_LOCK_FILE);
    symlinkSync(sentinel, lockFile, "file");

    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "symlinked-lease" })).toThrow(
      "symlink",
    );
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(lockFile, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("fails closed on lease release after lock-file replacement", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/replaced-lease", "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "replaced-lease" });
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-release-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    rmSync(lease.lockFile, { force: true });
    symlinkSync(sentinel, lease.lockFile, "file");

    expect(() => releaseWorkflowRootLease(lease)).toThrow("symlink");
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(lease.lockFile, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("fences a delayed former owner from checkpoint commit or release", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/fenced", "unused", root);
    const former = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "former" });
    releaseWorkflowRootLease(former);
    const current = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "current" });
    const checkpoint = {
      parentScriptSha256: "a".repeat(64),
      childScriptSha256: "b".repeat(64),
      outputDir: output.identity,
      itemKey: "item-one",
      childRunId: "child-one",
    };

    expect(() => commitWorkflowCompletedCheckpoint(former, checkpoint)).toThrow("fencing token is stale");
    expect(() => readWorkflowCompletedCheckpoint(former, checkpoint)).toThrow("fencing token is stale");
    expect(() => releaseWorkflowRootLease(former)).toThrow("fencing token is stale");
    expect(() => commitWorkflowCompletedCheckpoint(current, { ...checkpoint, childRunId: " child" })).toThrow(
      "Invalid workflow run id",
    );
    expect(commitWorkflowCompletedCheckpoint(current, checkpoint)).toMatchObject({ status: "completed" });
    const committed = readWorkflowCompletedCheckpoint(current, checkpoint);
    expect(committed).toMatchObject({ childRunId: checkpoint.childRunId });
    expect(committed).not.toHaveProperty("primaryFile");
    releaseWorkflowRootLease(current);
  });
});
