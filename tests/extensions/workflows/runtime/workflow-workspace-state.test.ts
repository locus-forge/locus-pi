import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
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
import { describe, expect, it, vi } from "vitest";
import {
  acquireWorkflowRootLease,
  releaseWorkflowRootLease,
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowWorkspaceStateDir,
} from "../../../../extensions/workflows/runtime/workflow-output.js";
import {
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  writeWorkflowWorkspaceRunLink,
} from "../../../../extensions/workflows/runtime/workflow-workspace-state.js";
import { resolveWorkflowWorkspaceDirectory } from "../../../../extensions/workflows/runtime/workflow-workspace.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { writeWorkflowRunGroupReport } from "../../../../extensions/workflows/runtime/workflow-run-report.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import { project, writeWorkflow } from "../../../fixtures/workflow-durable-project.js";

describe("leased workspace navigation under a task artifacts root", () => {
  it("keeps the runtime lease under .locus-pi while retaining workspace navigation", () => {
    const root = project();
    const outputDir = ".tasks/T-144-2026-09-08-workflow/artifacts";
    const output = resolveWorkflowWorkspaceDirectory(root, outputDir, "unused", root);
    expect(output.relativePath).toBe(outputDir);
    const groupDir = ensureWorkflowRunDir(root, "tasks-root");
    const lease = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "tasks-root" });
    expect(existsSync(lease.lockFile)).toBe(true);
    expect(existsSync(path.join(root, outputDir, ".locus-pi-workflow.lock"))).toBe(false);
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
    expect(existsSync(lease.lockFile)).toBe(false);
  });
});

describe("checkpoint path confinement", () => {
  const identity = {
    parentScriptSha256: "a".repeat(64),
    childScriptSha256: "b".repeat(64),
    workspaceIdentity: "outputs/checkpoint-confinement",
    rootLineageId: "checkpoint-root",
    items: [],
    itemKey: "item-one",
    childRunId: "child-one",
  };

  it("rejects a valid-looking checkpoint behind an external checkpoints ancestor", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, identity.workspaceIdentity, "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "checkpoint-root" });
    const checkpoint = commitWorkflowCompletedCheckpoint(lease, identity);
    const checkpoints = path.join(lease.stateDir, "checkpoints", "v3");
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
    const output = resolveWorkflowWorkspaceDirectory(root, identity.workspaceIdentity, "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "checkpoint-dangling" });
    commitWorkflowCompletedCheckpoint(lease, identity);
    const checkpoints = path.join(lease.stateDir, "checkpoints", "v3");
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

describe("fenced native workspace leases and atomic checkpoints", () => {
  it("writes navigation only for the active root owner and preserves user backlink conflicts", async () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/links", "links", root);
    const groupDir = ensureWorkflowRunDir(root, "root-one");
    const lease = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "root-one" });
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
      workspaceDir: output.relativePath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Reserved workflow workspace file/u);
    expect(result.resultPersistence.ok).toBe(true);
    expect(readFileSync(reserved, "utf8")).toBe("user document\n");
    expect(existsSync(path.join(output.absolutePath, ".locus-pi-workflow.lock"))).toBe(false);
  });

  it("retries the live lock-create-to-write acquisition window", async () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/racing-owner", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(lockFile)}, "", { flag: "wx" });
process.stdout.write("ready\\n");
setTimeout(() => fs.writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({
  schema: "locus-pi.workflow-location-lease.v2",
  kind: "workspace",
  rootRunId: "racing-owner",
  relativePath: ${JSON.stringify(output.relativePath)},
  identity: ${JSON.stringify(output.identity)},
  pid: process.pid,
  fencingToken: "racing-token",
  acquiredAt: new Date().toISOString(),
}) + "\\n"), 25);
setTimeout(() => process.exit(0), 150);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout!, "data");

    expect(() => acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "contender" })).toThrow(
      "owned by live run racing-owner",
    );
    await once(child, "exit");
  });

  it("conflicts for one live namespace while independent namespaces remain ownable", () => {
    const root = project();
    const firstOutput = resolveWorkflowWorkspaceDirectory(root, "outputs/one", "unused", root);
    const secondOutput = resolveWorkflowWorkspaceDirectory(root, "outputs/two", "unused", root);
    const first = acquireWorkflowRootLease({ projectRoot: root, workspace: firstOutput, rootRunId: "run-one" });

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: firstOutput, rootRunId: "run-conflict" }),
    ).toThrow("owned by live run run-one");
    const independent = acquireWorkflowRootLease({
      projectRoot: root,
      workspace: secondOutput,
      rootRunId: "run-two",
    });

    releaseWorkflowRootLease(independent);
    releaseWorkflowRootLease(first);
  });

  it("allows a new owner after the native workspace is removed", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/cleared", "unused", root);
    const old = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "old-run" });
    releaseWorkflowRootLease(old);
    rmSync(output.absolutePath, { recursive: true, force: true });

    const recreated = resolveWorkflowWorkspaceDirectory(root, "outputs/cleared", "unused", root);
    const replacement = acquireWorkflowRootLease({ projectRoot: root, workspace: recreated, rootRunId: "new-run" });

    expect(replacement.lockFile).toBe(
      path.join(workflowWorkspaceStateDir(root, recreated.identity), WORKFLOW_WORKSPACE_LEASE_FILE),
    );
    expect(existsSync(replacement.lockFile)).toBe(true);
    releaseWorkflowRootLease(replacement);
  });

  it("keys leases by the physical workspace target across platform case aliases", () => {
    const root = project();
    const stored = resolveWorkflowWorkspaceDirectory(root, "outputs/CaseAlias", "unused", root);
    const alias = resolveWorkflowWorkspaceDirectory(root, "outputs/casealias", "unused", root);
    const first = acquireWorkflowRootLease({ projectRoot: root, workspace: stored, rootRunId: "stored-case" });
    const aliasSeesStoredLock = alias.identity === stored.identity;

    if (aliasSeesStoredLock) {
      expect(() => acquireWorkflowRootLease({ projectRoot: root, workspace: alias, rootRunId: "alias-case" })).toThrow(
        "owned by live run stored-case",
      );
    } else {
      const independent = acquireWorkflowRootLease({ projectRoot: root, workspace: alias, rootRunId: "alias-case" });
      releaseWorkflowRootLease(independent);
    }

    releaseWorkflowRootLease(first);
  });

  it("reclaims a provably dead local owner and refuses an unreadable owner", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/reclaim", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const reclaimed = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "replacement" });
    releaseWorkflowRootLease(reclaimed);

    writeFileSync(lockFile, "not json\n", "utf8");
    expect(() => acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "blocked" })).toThrow(
      "verify no writer is active",
    );
  });

  it("fails closed on a symlinked lock file without touching its external sentinel", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/symlinked-lease", "unused", root);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-lease-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    symlinkSync(sentinel, lockFile, "file");

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "symlinked-lease" }),
    ).toThrow("symlink");
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(lockFile, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("fails closed on lease release after lock-file replacement", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/replaced-lease", "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "replaced-lease" });
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
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/fenced", "unused", root);
    const former = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "former" });
    releaseWorkflowRootLease(former);
    const current = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "current" });
    const checkpoint = {
      parentScriptSha256: "a".repeat(64),
      childScriptSha256: "b".repeat(64),
      workspaceIdentity: output.identity,
      rootLineageId: "checkpoint-root",
      items: [],
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
