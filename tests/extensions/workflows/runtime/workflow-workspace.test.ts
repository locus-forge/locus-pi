import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowWorktree,
  createWorkflowWorkspaceManager,
} from "../../../../extensions/workflows/runtime/workflow-worktree.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  assertWorkflowOutputDirPath,
  assertWorkflowPhysicalWorkspaceIdentity,
  referenceWorkflowPrimaryFile,
  resolveWorkflowOutputDirectory,
  WORKFLOW_OUTPUT_DIR_PATTERN,
} from "../../../../extensions/workflows/runtime/workflow-workspace.js";
import { project } from "../../../fixtures/workflow-durable-project.js";

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-workspace-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, ".gitignore"), ".locus-pi/\n.pi/\n", "utf8");
  writeFileSync(path.join(root, "file.txt"), "one\n", "utf8");
  execFileSync("git", ["add", ".gitignore", "file.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: root });
  const first = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  writeFileSync(path.join(root, "file.txt"), "two\n", "utf8");
  execFileSync("git", ["commit", "-qam", "second"], { cwd: root });
  const second = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, first, second };
}

describe("workflow runtime-owned workspace", () => {
  it("refuses an unclaimed run without creating a flat worktree root", () => {
    const repo = repository();
    const runDir = path.join(repo.root, ".locus-pi", "runs", "missing-run");
    expect(() =>
      createWorkflowWorktree({
        projectRoot: repo.root,
        runId: "missing-run",
        runDir,
        safeCallId: "agent-1",
      }),
    ).toThrow();
    expect(existsSync(runDir)).toBe(false);
  });

  it("allocates one opaque handle at the requested commit and resolves it repeatedly", () => {
    const repo = repository();
    const manager = createWorkflowWorkspaceManager({
      projectRoot: repo.root,
      runId: "review-fix",
      runDir: ensureWorkflowRunDir(repo.root, "review-fix"),
    });

    const handle = manager.allocate("accepted fixes", repo.first);
    const first = manager.resolve(handle);
    const second = manager.resolve(handle);

    expect(handle).toBe("workflow-workspace:1");
    expect(second).toEqual(first);
    expect(first.head).toBe(repo.first);
    expect(first.originalHead).toBe(repo.second);
    expect(first.path).not.toBe(repo.root);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: first.path, encoding: "utf8" }).trim()).toBe(repo.first);
    expect(manager.evidence()).toEqual([first]);
  });

  it("rejects unknown handles without accepting model-reported paths", () => {
    const repo = repository();
    const manager = createWorkflowWorkspaceManager({
      projectRoot: repo.root,
      runId: "review-fix",
      runDir: ensureWorkflowRunDir(repo.root, "review-fix"),
    });

    expect(() => manager.resolve("/tmp/model-reported-worktree")).toThrow("Unknown workflow workspace handle");
  });

  it("fails if the original checkout or retained workspace HEAD changes", () => {
    const repo = repository();
    const manager = createWorkflowWorkspaceManager({
      projectRoot: repo.root,
      runId: "review-fix",
      runDir: ensureWorkflowRunDir(repo.root, "review-fix"),
    });
    const handle = manager.allocate("accepted fixes", repo.first);
    writeFileSync(path.join(repo.root, "file.txt"), "mutated original\n", "utf8");

    expect(() => manager.resolve(handle)).toThrow("original checkout changed");

    execFileSync("git", ["checkout", "--", "file.txt"], { cwd: repo.root });
    const workspace = manager.resolve(handle);
    execFileSync("git", ["commit", "--allow-empty", "-qm", "unexpected"], {
      cwd: workspace.path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    expect(() => manager.resolve(handle)).toThrow("workspace HEAD changed");
  });

  it("rejects a symlinked run worktree base before Git can write outside", () => {
    const repo = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "locus-workflow-worktree-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const runtime = path.join(repo.root, ".locus-pi", "runs", "run-escape", "runtime");
    mkdirSync(runtime, { recursive: true });
    symlinkSync(outside, path.join(runtime, "worktrees"), "dir");

    expect(() =>
      createWorkflowWorktree({
        projectRoot: repo.root,
        runId: "run-escape",
        runDir: path.join(repo.root, ".locus-pi", "runs", "run-escape"),
        safeCallId: "agent-1",
      }),
    ).toThrow(/symlink|unsafe/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(path.join(runtime, "worktrees"), { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects an override base outside the run root before Git can write", () => {
    const repo = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "locus-workflow-worktree-override-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");

    expect(() =>
      createWorkflowWorktree({
        projectRoot: repo.root,
        runId: "run-override",
        runDir: ensureWorkflowRunDir(repo.root, "run-override"),
        safeCallId: "agent-1",
        baseDir: outside,
      }),
    ).toThrow(/escapes its run root/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked worktree target before Git can replace it", () => {
    const repo = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "locus-workflow-worktree-target-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const baseDir = path.join(repo.root, ".locus-pi", "runs", "run-target", "runtime", "worktrees");
    mkdirSync(baseDir, { recursive: true });
    symlinkSync(outside, path.join(baseDir, "agent-1"), "dir");

    expect(() =>
      createWorkflowWorktree({
        projectRoot: repo.root,
        runId: "run-target",
        runDir: ensureWorkflowRunDir(repo.root, "run-target"),
        safeCallId: "agent-1",
      }),
    ).toThrow(/symlink|unsafe/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(path.join(baseDir, "agent-1"), { force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("workflow workspace identity and file proofs", () => {
  it("keeps generated physical identity grammar separate from explicit outputDir grammar", () => {
    expect(() => assertWorkflowOutputDirPath("packages/docs site/tmp/files")).toThrow();
    expect(assertWorkflowOutputDirPath(".locus-pi/plans/20260819-120000-a1b2-task-draft")).toBe(
      ".locus-pi/plans/20260819-120000-a1b2-task-draft",
    );
    expect(assertWorkflowOutputDirPath(".locus-pi/workspaces/20260819-120000-a1b2-task-draft")).toBe(
      ".locus-pi/workspaces/20260819-120000-a1b2-task-draft",
    );
    expect(new RegExp(WORKFLOW_OUTPUT_DIR_PATTERN, "u").test(".locus-pi/plans/20260819-120000-a1b2-task-draft")).toBe(
      true,
    );
    expect(
      new RegExp(WORKFLOW_OUTPUT_DIR_PATTERN, "u").test(".locus-pi/workspaces/20260819-120000-a1b2-task-draft"),
    ).toBe(true);
    expect(() => assertWorkflowOutputDirPath(".locus-pi/plans/nested/task-draft")).toThrow();
    expect(() => assertWorkflowOutputDirPath(".locus-pi/workspaces/nested/task-draft")).toThrow();
    const grammar = new RegExp(WORKFLOW_OUTPUT_DIR_PATTERN, "u");
    for (const accepted of [".tasks/T-144-2026-09-08-workflow/artifacts", ".tasks/a/b/c", ".tasks/T-144"]) {
      expect(assertWorkflowOutputDirPath(accepted)).toBe(accepted);
      expect(grammar.test(accepted)).toBe(true);
    }
    for (const rejected of [".tasks", ".tasks/", ".tasks/../x", ".tasks/.hidden/x", ".tasks//x", ".tasks/x/../y"]) {
      expect(() => assertWorkflowOutputDirPath(rejected)).toThrow();
      expect(grammar.test(rejected)).toBe(false);
    }
    expect(assertWorkflowPhysicalWorkspaceIdentity("packages/docs site/tmp/files")).toBe(
      "packages/docs site/tmp/files",
    );
    expect(assertWorkflowPhysicalWorkspaceIdentity("p".repeat(401))).toHaveLength(401);
    for (const invalid of ["", "/outside", "a\\b", "a\0b", ".", "..", "a/../b", "a//b", "a/./b"]) {
      expect(() => assertWorkflowPhysicalWorkspaceIdentity(invalid)).toThrow();
    }
  });

  it("opens only the .tasks root and keeps every other dot directory closed", () => {
    const grammar = new RegExp(WORKFLOW_OUTPUT_DIR_PATTERN, "u");
    for (const denied of [
      ".git/objects",
      ".ssh/x",
      ".env/x",
      ".locus-pi/workflow-state/v1/x",
      ".locus-pi/runs/x",
      ".locus-pi",
      ".tasksextra/x",
    ]) {
      expect(() => assertWorkflowOutputDirPath(denied)).toThrow();
      expect(grammar.test(denied)).toBe(false);
    }
  });

  it("rejects a workspace ancestor replaced by an external symlink before primary open", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/primary-ancestor", "primary-ancestor", root);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-primary-outside-"));
    writeFileSync(path.join(outside, "plan.md"), "outside\n", "utf8");
    rmSync(output.absolutePath, { recursive: true, force: true });
    symlinkSync(outside, output.absolutePath, "dir");

    expect(() => referenceWorkflowPrimaryFile(output, "plan.md")).toThrow(/physical outputDir|workspace changed/u);

    rmSync(outside, { recursive: true, force: true });
  });
});
