import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureRepositoryCheckScripts,
  createReadOnlyAgentSessionCapabilities,
} from "../../../extensions/_shared/agent-runtime/agent-read-only-policy.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("read-only repository checks", () => {
  it("runs only declared package scripts in a disposable worktree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-check-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "repository-check@example.test");
    git(root, "config", "user.name", "Repository Check Test");
    writeFileSync(path.join(root, ".gitignore"), ".locus/\n", "utf8");
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: {
          verify:
            'node -e "require(\\\"node:fs\\\").writeFileSync(\\\"check-output.txt\\\", \\\"snapshot-only\\\"); console.log(\\\"CHECK_OK\\\")"',
        },
      })}\n`,
      "utf8",
    );
    git(root, "add", ".gitignore", "package.json");
    git(root, "commit", "--quiet", "-m", "fixture");

    const capabilities = createReadOnlyAgentSessionCapabilities(root, ["read", "repository_check", "bash"]);
    expect(capabilities.tools).toContain("repository_check");
    expect(capabilities.excludeTools).toContain("bash");
    const check = capabilities.customTools?.find((tool) => tool.name === "repository_check");
    expect(check).toBeDefined();

    const result = await check!.execute("verify", { script: "verify" }, new AbortController().signal);
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("CHECK_OK");
    expect(result.details).toMatchObject({ script: "verify", packageManager: "npm", isolatedSnapshot: true });
    expect(existsSync(path.join(root, "check-output.txt"))).toBe(false);
    expect(git(root, "status", "--short")).toBe("");

    const undeclared = await check!.execute("unknown", { script: "format" }, new AbortController().signal);
    expect(undeclared).toMatchObject({ isError: true, details: { blocked: true } });
    expect(undeclared.content[0]?.text).toContain("not present in the frozen baseline");
    const shellText = await check!.execute(
      "shell",
      { script: "verify", args: ["&&", "touch", "operator-checkout"] },
      new AbortController().signal,
    );
    expect(shellText).toMatchObject({ isError: true, details: { blocked: true } });
  });

  it("borrows the installed dependency root so a declared check can start, and leaves it intact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-deps-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "repository-check@example.test");
    git(root, "config", "user.name", "Repository Check Test");
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: { verify: 'node -e "console.log(require(\\"installed-fixture\\").marker)"' },
      })}\n`,
      "utf8",
    );
    git(root, "add", ".gitignore", "package.json");
    git(root, "commit", "--quiet", "-m", "fixture");

    // Git-ignored, so the snapshot never contains it: without the borrowed link
    // the check dies at startup and a verifier reads that as "could not run".
    const installed = path.join(root, "node_modules", "installed-fixture");
    mkdirSync(installed, { recursive: true });
    writeFileSync(path.join(installed, "package.json"), `${JSON.stringify({ name: "installed-fixture" })}\n`, "utf8");
    writeFileSync(path.join(installed, "index.js"), 'module.exports = { marker: "DEPENDENCY_RESOLVED" };\n', "utf8");

    const capabilities = createReadOnlyAgentSessionCapabilities(root, ["read", "repository_check"]);
    const check = capabilities.customTools?.find((tool) => tool.name === "repository_check");
    const result = await check!.execute("verify", { script: "verify" }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("DEPENDENCY_RESOLVED");
    // Cleanup unlinks the borrowed directory; it never deletes through it.
    expect(existsSync(path.join(installed, "index.js"))).toBe(true);
    expect(git(root, "status", "--short")).toBe("");
  });

  it("materializes initialized submodule source bytes in the disposable worktree", async () => {
    const source = mkdtempSync(path.join(tmpdir(), "locus-read-only-submodule-source-"));
    git(source, "init", "--quiet");
    git(source, "config", "user.email", "repository-check@example.test");
    git(source, "config", "user.name", "Repository Check Test");
    writeFileSync(path.join(source, "tracked.txt"), "base\n", "utf8");
    git(source, "add", "tracked.txt");
    git(source, "commit", "--quiet", "-m", "base");

    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-submodule-parent-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "repository-check@example.test");
    git(root, "config", "user.name", "Repository Check Test");
    writeFileSync(path.join(root, ".gitignore"), ".locus/\n", "utf8");
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: {
          verify:
            'node -e "const fs=require(\\\"node:fs\\\"); console.log(fs.readFileSync(\\\"vendor/module/tracked.txt\\\",\\\"utf8\\\").trim()+\\\":\\\"+fs.readFileSync(\\\"vendor/module/untracked.txt\\\",\\\"utf8\\\").trim())"',
        },
      })}\n`,
      "utf8",
    );
    git(root, "add", ".gitignore", "package.json");
    git(root, "commit", "--quiet", "-m", "fixture");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "vendor/module");
    git(root, "commit", "--quiet", "-am", "add submodule");

    writeFileSync(path.join(root, "vendor", "module", "tracked.txt"), "dirty\n", "utf8");
    writeFileSync(path.join(root, "vendor", "module", "untracked.txt"), "untracked\n", "utf8");

    const capabilities = createReadOnlyAgentSessionCapabilities(root, ["repository_check"]);
    const check = capabilities.customTools?.find((tool) => tool.name === "repository_check");
    const result = await check!.execute("verify", { script: "verify" }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("dirty:untracked");
    expect(existsSync(path.join(root, "check-output.txt"))).toBe(false);
  });

  it("rejects scripts added or changed after the host freezes the workflow baseline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-frozen-check-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "repository-check@example.test");
    git(root, "config", "user.name", "Repository Check Test");
    writeFileSync(path.join(root, ".gitignore"), ".locus/\n", "utf8");
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: { verify: 'node -e "console.log(\\"ORIGINAL\\")"' } })}\n`,
      "utf8",
    );
    git(root, "add", ".gitignore", "package.json");
    git(root, "commit", "--quiet", "-m", "fixture");

    const baseline = captureRepositoryCheckScripts(root);
    const capabilities = createReadOnlyAgentSessionCapabilities(root, ["repository_check"], {
      repositoryCheckScripts: baseline,
    });
    const check = capabilities.customTools?.find((tool) => tool.name === "repository_check");
    expect(check).toBeDefined();

    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: {
          verify: 'node -e "console.log(\\"MODIFIED\\")"',
          injected: 'node -e "console.log(\\"INJECTED\\")"',
        },
      })}\n`,
      "utf8",
    );

    const modified = await check!.execute("modified", { script: "verify" }, new AbortController().signal);
    expect(modified).toMatchObject({ isError: true, details: { blocked: true } });
    expect(modified.content[0]?.text).toContain("changed after the frozen baseline");

    const added = await check!.execute("added", { script: "injected" }, new AbortController().signal);
    expect(added).toMatchObject({ isError: true, details: { blocked: true } });
    expect(added.content[0]?.text).toContain("not present in the frozen baseline");
  });

  it("blocks added lifecycle hooks before they can execute around a frozen script", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-hook-check-"));
    const preMarker = path.join(root, "preverify-escaped.txt");
    const postMarker = path.join(root, "postverify-escaped.txt");
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "repository-check@example.test");
    git(root, "config", "user.name", "Repository Check Test");
    writeFileSync(path.join(root, ".gitignore"), ".locus/\n", "utf8");
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: { verify: 'node -e "console.log(\\"SAFE_VERIFY\\")"' } })}\n`,
      "utf8",
    );
    git(root, "add", ".gitignore", "package.json");
    git(root, "commit", "--quiet", "-m", "fixture");

    const baseline = captureRepositoryCheckScripts(root);
    const capabilities = createReadOnlyAgentSessionCapabilities(root, ["repository_check"], {
      repositoryCheckScripts: baseline,
    });
    const check = capabilities.customTools?.find((tool) => tool.name === "repository_check");
    expect(check).toBeDefined();

    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: {
          verify: 'node -e "console.log(\\"SAFE_VERIFY\\")"',
          preverify: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(preMarker)}, "ran")'`,
          postverify: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(postMarker)}, "ran")'`,
        },
      })}\n`,
      "utf8",
    );

    const result = await check!.execute("verify", { script: "verify" }, new AbortController().signal);
    expect(result).toMatchObject({ isError: true, details: { blocked: true } });
    expect(result.content[0]?.text).toContain("package.json scripts changed after the frozen baseline");
    expect(existsSync(preMarker)).toBe(false);
    expect(existsSync(postMarker)).toBe(false);
  });
});
