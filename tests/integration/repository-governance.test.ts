import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { evaluatePullRequestPolicy } from "../../scripts/check-pull-request-policy.js";
import { candidateFiles, repositoryProblems } from "../../scripts/check-repository.js";
import { evaluateReleaseMetadata } from "../../scripts/check-release-metadata.js";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];
const releaseHeading = "# Changelog\n\n## [0.3.0] - 2026-07-16\n";

afterEach(async () => {
  while (fixtureRoots.length > 0) await rm(fixtureRoots.pop()!, { recursive: true, force: true });
});

describe("repository pull-request policy", () => {
  it("accepts a task branch into dev without requiring a changelog entry", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "dev",
        headRef: "codex/example",
        changedFiles: ["README.md"],
        baseVersion: "0.2.0",
        headVersion: "0.2.0",
        headChangelog: releaseHeading,
      }),
    ).toEqual([]);
  });

  it("still rejects integration branches that target dev", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "dev",
        headRef: "dev",
        changedFiles: ["extensions/workflows/index.ts"],
        baseVersion: "0.2.0",
        headVersion: "0.2.0",
        headChangelog: releaseHeading,
      }),
    ).toContain("normal pull requests into dev must come from a task branch, not dev");
  });

  it("rejects feature branches that target main directly", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "codex/example",
        changedFiles: ["package.json", "CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.3.0",
        headChangelog: releaseHeading,
      }),
    ).toContain("main accepts only the release pull request from dev");
  });

  it("requires a version bump for the dev to main release pull request", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "dev",
        changedFiles: ["CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.2.0",
        headChangelog: releaseHeading,
      }),
    ).toContain("release pull request must bump package version above 0.2.0");
  });

  it("rejects a release version lower than main", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "dev",
        changedFiles: ["package.json", "CHANGELOG.md"],
        baseVersion: "0.3.0",
        headVersion: "0.2.0",
        headChangelog: "# Changelog\n\n## [0.2.0] - 2026-07-16\n",
      }),
    ).toContain("release pull request must bump package version above 0.3.0");
  });

  it("accepts a versioned dev to main release pull request", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "dev",
        changedFiles: ["package.json", "CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.3.0",
        headChangelog: releaseHeading,
      }),
    ).toEqual([]);
  });
});

describe("release metadata", () => {
  it("accepts a package version with a matching changelog heading and tag", () => {
    expect(evaluateReleaseMetadata({ version: "0.3.0", changelog: releaseHeading, tagName: "v0.3.0" })).toEqual([]);
  });

  it("rejects a tag that does not match the package version", () => {
    expect(evaluateReleaseMetadata({ version: "0.3.0", changelog: releaseHeading, tagName: "v0.2.0" })).toContain(
      "tag v0.2.0 does not match package version 0.3.0",
    );
  });
});

describe("repository hygiene", () => {
  it("uses Git as the repository inventory and excludes tracked files deleted from the working tree", async () => {
    const root = await gitFixture({ "kept.txt": "kept\n", "deleted.txt": "deleted\n" });
    await unlink(path.join(root, "deleted.txt"));

    await expect(candidateFiles(root)).resolves.toEqual(["kept.txt"]);
  });

  it("does not scan ignored local state", async () => {
    const root = await gitFixture({ ".gitignore": "private.txt\n", "kept.txt": "kept\n" });
    await writeFile(path.join(root, "private.txt"), ["", "Users", "private", "local"].join("/"), "utf8");

    await expect(candidateFiles(root)).resolves.toEqual([".gitignore", "kept.txt"]);
  });

  it("rejects internal paths that were force-added to Git", async () => {
    const root = await gitFixture({ ".locus/private.md": "private\n" });

    await expect(repositoryProblems(root)).resolves.toContain("forbidden repository path: .locus/private.md");
  });

  it("rejects tracked symlinks", async () => {
    const root = await gitFixture({ "target.txt": "target\n" });
    await symlink("target.txt", path.join(root, "link.txt"));
    await execFileAsync("git", ["add", "link.txt"], { cwd: root });

    await expect(repositoryProblems(root)).resolves.toContain("symlink is not allowed: link.txt");
  });

  it.each([
    ["absolute workstation path", ["", "Users", "example", "private", "file"].join("/")],
    ["private key material", "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n"],
    ["npm auth configuration", "//registry." + "npmjs.org/pkg/" + ":_authToken=secret\n"],
  ])("rejects %s", async (kind, content) => {
    const root = await gitFixture({ "unsafe.txt": content });

    await expect(repositoryProblems(root)).resolves.toContain(`${kind} found: unsafe.txt`);
  });
});

async function gitFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "locus-repository-"));
  fixtureRoots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  await execFileAsync("git", ["add", "--force", "."], { cwd: root });
  return root;
}
