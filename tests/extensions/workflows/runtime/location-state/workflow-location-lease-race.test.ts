import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsHooks = vi.hoisted(() => ({
  afterLeaseRename: undefined as (() => void) | undefined,
  afterFileFsync: undefined as ((file: string) => void) | undefined,
  beforeOpen: undefined as ((file: string, flags: string | number) => void) | undefined,
  beforeRename: undefined as ((source: string, destination: string) => void) | undefined,
  openedFiles: new Map<number, string>(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    openSync(file: import("node:fs").PathLike, flags: string | number, mode?: string | number): number {
      fsHooks.beforeOpen?.(String(file), flags);
      const fd = actual.openSync(file, flags, mode);
      fsHooks.openedFiles.set(fd, String(file));
      return fd;
    },
    fsyncSync(fd: number): void {
      actual.fsyncSync(fd);
      const file = fsHooks.openedFiles.get(fd);
      if (file !== undefined) fsHooks.afterFileFsync?.(file);
    },
    closeSync(fd: number): void {
      try {
        actual.closeSync(fd);
      } finally {
        fsHooks.openedFiles.delete(fd);
      }
    },
    renameSync(source: import("node:fs").PathLike, destination: import("node:fs").PathLike): void {
      fsHooks.beforeRename?.(String(source), String(destination));
      actual.renameSync(source, destination);
      if (path.basename(String(source)) !== "lease.json" || !String(destination).includes(".stale-")) return;
      const hook = fsHooks.afterLeaseRename;
      fsHooks.afterLeaseRename = undefined;
      hook?.();
    },
  };
});

import {
  acquireWorkflowRootLease,
  releaseWorkflowRootLease,
  WORKFLOW_LEASE_RECLAIM_GUARD_FILE,
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowWorkspaceStateDir,
  type WorkflowRootLease,
} from "../../../../../extensions/workflows/runtime/location-state/workflow-location-lease.js";
import { ensureWorkflowRunDir } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
import { resolveWorkflowWorkspaceDirectory } from "../../../../../extensions/workflows/runtime/workflow-workspace.js";
import { project } from "../../../../fixtures/workflow-durable-project.js";

afterEach(() => {
  fsHooks.afterLeaseRename = undefined;
  fsHooks.afterFileFsync = undefined;
  fsHooks.beforeOpen = undefined;
  fsHooks.beforeRename = undefined;
  fsHooks.openedFiles.clear();
});

describe("workflow lease reclaim interleavings", () => {
  it("never removes a foreign lease when exclusive open fails before path lookup", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/open-failure", "unused", root);
    const owner = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "open-owner" });
    const original = readFileSync(owner.lockFile, "utf8");
    fsHooks.beforeOpen = (file) => {
      if (file === owner.lockFile) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "open-contender" }),
    ).toThrow("too many open files");
    expect(readFileSync(owner.lockFile, "utf8")).toBe(original);

    fsHooks.beforeOpen = undefined;
    releaseWorkflowRootLease(owner);
  });

  it("never removes a foreign reclaim guard when exclusive open fails before path lookup", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/guard-open-failure", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    const record = {
      schema: "locus-pi.workflow-location-lease.v2",
      kind: "workspace",
      rootRunId: "dead-owner",
      relativePath: output.relativePath,
      identity: output.identity,
      pid: 2_147_483_647,
      fencingToken: "dead-token",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(lockFile, `${JSON.stringify(record)}\n`, "utf8");
    writeFileSync(guardFile, `${JSON.stringify({ ...record, fencingToken: "foreign-guard" })}\n`, "utf8");
    const originalGuard = readFileSync(guardFile, "utf8");
    fsHooks.beforeOpen = (file) => {
      if (file === guardFile) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "guard-contender" }),
    ).toThrow("too many open files");
    expect(readFileSync(guardFile, "utf8")).toBe(originalGuard);
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toMatchObject({ rootRunId: "dead-owner" });
  });

  it("serializes a second reclaimer while the first owns the guard", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/two-reclaimers", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead-owner",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let secondError = "";
    fsHooks.afterFileFsync = (file) => {
      if (file !== guardFile) return;
      fsHooks.afterFileFsync = undefined;
      try {
        acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "second-reclaimer" });
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }
    };

    const first = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "first-reclaimer" });
    expect(secondError).toContain("reclaim is already in progress for run first-reclaimer");
    expect(JSON.parse(readFileSync(first.lockFile, "utf8"))).toMatchObject({ rootRunId: "first-reclaimer" });
    expect(existsSync(guardFile)).toBe(false);
    releaseWorkflowRootLease(first);
  });

  it("re-judges a new owner installed after guard creation", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/guarded-reread", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead-owner",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let winner: WorkflowRootLease | undefined;
    fsHooks.afterFileFsync = (file) => {
      if (file !== guardFile) return;
      fsHooks.afterFileFsync = undefined;
      unlinkSync(lockFile);
      winner = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "guarded-reread-winner" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "guarded-reclaimer" }),
    ).toThrow("owned by live run guarded-reread-winner");
    expect(existsSync(guardFile)).toBe(false);
    if (winner === undefined) throw new Error("guarded re-read winner did not run");
    releaseWorkflowRootLease(winner);
  });

  it("removes only its own guard when guarded rename fails", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/rename-failure", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead-owner",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    fsHooks.beforeRename = (source, destination) => {
      if (source === lockFile && destination.includes(".stale-")) {
        throw Object.assign(new Error("rename failed"), { code: "EIO" });
      }
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "rename-contender" }),
    ).toThrow("rename failed");
    expect(existsSync(guardFile)).toBe(false);
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toMatchObject({ rootRunId: "dead-owner" });
  });

  it("removes its partially written guard and preserves the judged lease after a guard write failure", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/guard-write-failure", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead-owner",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    fsHooks.afterFileFsync = (file) => {
      if (file === guardFile) throw Object.assign(new Error("guard fsync failed"), { code: "EIO" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "write-contender" }),
    ).toThrow("guard fsync failed");
    expect(existsSync(guardFile)).toBe(false);
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toMatchObject({ rootRunId: "dead-owner" });
  });

  it("removes its guard when replacement lease creation fails after the stale rename", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/replacement-open-failure", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead-owner",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let leaseOpenCount = 0;
    fsHooks.beforeOpen = (file, flags) => {
      if (file !== lockFile || flags !== "wx") return;
      leaseOpenCount += 1;
      if (leaseOpenCount === 2) throw Object.assign(new Error("replacement open failed"), { code: "EIO" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "replacement-contender" }),
    ).toThrow("replacement open failed");
    expect(existsSync(guardFile)).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    expect(readdirSync(stateDir).some((name) => name.includes(".stale-"))).toBe(false);
  });

  it("does not displace a normal acquirer that wins the dead-owner rename-to-create gap", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/dead-gap", "unused", root);
    const stateDir = workflowWorkspaceStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "dead-owner",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    let winner: WorkflowRootLease | undefined;
    fsHooks.afterLeaseRename = () => {
      winner = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "normal-winner" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "stale-reclaimer" }),
    ).toThrow("owned by live run normal-winner");
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toMatchObject({ rootRunId: "normal-winner" });
    expect(existsSync(path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE))).toBe(false);
    if (winner === undefined) throw new Error("normal acquirer did not run");
    releaseWorkflowRootLease(winner);
  });

  it("does not displace a normal acquirer that wins the force rename-to-create gap", () => {
    const root = project();
    const output = resolveWorkflowWorkspaceDirectory(root, "outputs/force-gap", "unused", root);
    const settledRunId = "settled-force-owner";
    const runDir = ensureWorkflowRunDir(root, settledRunId);
    writeFileSync(
      workflowResultFile(runDir),
      `${JSON.stringify({
        runId: settledRunId,
        ok: true,
        disposition: { status: "completed" },
        result: null,
        resultPersistence: { ok: true, path: workflowResultFile(runDir) },
      })}\n`,
      "utf8",
    );
    const former = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: settledRunId });

    let winner: WorkflowRootLease | undefined;
    fsHooks.afterLeaseRename = () => {
      winner = acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "force-gap-winner" });
    };

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, workspace: output, rootRunId: "force-reclaimer", force: true }),
    ).toThrow("owned by live run force-gap-winner");
    expect(JSON.parse(readFileSync(former.lockFile, "utf8"))).toMatchObject({ rootRunId: "force-gap-winner" });
    expect(existsSync(path.join(former.stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE))).toBe(false);
    expect(() => releaseWorkflowRootLease(former)).toThrow("fencing token is stale");
    if (winner === undefined) throw new Error("normal acquirer did not run");
    releaseWorkflowRootLease(winner);
  });
});
