import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { hasReleaseHeading } from "./check-release-metadata.js";

export interface PullRequestPolicyInput {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  baseVersion: string;
  headVersion: string;
  headChangelog: string;
}

export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = parsedLeft.core[index]! - parsedRight.core[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length > 0) return 1;
  if (parsedLeft.prerelease.length > 0 && parsedRight.prerelease.length === 0) return -1;
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseSemver(version: string): { core: [number, number, number]; prerelease: string[] } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`invalid semver: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function evaluatePullRequestPolicy(input: PullRequestPolicyInput): string[] {
  const errors: string[] = [];

  if (input.baseRef === "dev") {
    if (input.headRef === "main" || input.headRef === "dev") {
      errors.push(`normal pull requests into dev must come from a task branch, not ${input.headRef}`);
    }
    return errors;
  }

  if (input.baseRef === "main") {
    const changelogChanged = input.changedFiles.includes("CHANGELOG.md");
    if (input.headRef !== "dev") {
      errors.push("main accepts only the release pull request from dev");
    }
    if (compareSemver(input.headVersion, input.baseVersion) <= 0) {
      errors.push(`release pull request must bump package version above ${input.baseVersion}`);
    }
    if (!changelogChanged) {
      errors.push("release pull request must update CHANGELOG.md");
    }
    if (!hasReleaseHeading(input.headChangelog, input.headVersion)) {
      errors.push(`CHANGELOG.md has no dated release heading for ${input.headVersion}`);
    }
    return errors;
  }

  errors.push(`pull requests may target only dev or main, not ${input.baseRef}`);
  return errors;
}

function gitText(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trimEnd();
}

function versionAt(revision: string): string {
  const packageJson = JSON.parse(gitText(["show", `${revision}:package.json`])) as { version: string };
  return packageJson.version;
}

function main(): void {
  const baseRef = process.env.GITHUB_BASE_REF ?? "";
  const headRef = process.env.GITHUB_HEAD_REF ?? "";
  const baseSha = process.env.GITHUB_BASE_SHA ?? "";
  const headSha = process.env.GITHUB_HEAD_SHA ?? "";
  if (!baseRef || !headRef || !baseSha || !headSha) {
    console.error("GITHUB_BASE_REF, GITHUB_HEAD_REF, GITHUB_BASE_SHA, and GITHUB_HEAD_SHA are required");
    process.exitCode = 1;
    return;
  }

  const changedFiles = gitText(["diff", "--name-only", `${baseSha}...${headSha}`])
    .split("\n")
    .filter(Boolean);
  const errors = evaluatePullRequestPolicy({
    baseRef,
    headRef,
    changedFiles,
    baseVersion: versionAt(baseSha),
    headVersion: versionAt(headSha),
    headChangelog: gitText(["show", `${headSha}:CHANGELOG.md`]),
  });
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Pull-request policy verified: ${headRef} -> ${baseRef}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
