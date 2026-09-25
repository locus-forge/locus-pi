import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/release-candidate.mjs");

describe("npm release candidate", () => {
  it("binds the staged filename, package identity, and bytes to pack evidence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "locus-pi-candidate-test-"));
    try {
      execFileSync(process.execPath, [script, "pack", directory]);
      const evidencePath = path.join(directory, "candidate.json");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { filename: string; name: string };

      evidence.name = "@other/package";
      writeFileSync(evidencePath, JSON.stringify(evidence));
      expect(() => execFileSync(process.execPath, [script, "verify", directory], { stdio: "pipe" })).toThrow();

      evidence.name = "@locus-forge/locus-pi";
      writeFileSync(evidencePath, JSON.stringify(evidence));
      writeFileSync(path.join(directory, evidence.filename), "tampered");
      expect(() => execFileSync(process.execPath, [script, "verify", directory], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const root = process.cwd();
const consumerScript = pathToFileURL(path.join(root, "scripts/release-consumer-smoke.mjs")).href;
const workflows = JSON.parse(readFileSync(path.join(root, "dist/public-catalogs.json"), "utf8")).workflows;

function probe(mutate?: (packageRoot: string) => void): string {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-consumer-probe-"));
  try {
    const packageRoot = path.join(temporaryRoot, "package");
    const projectRoot = path.join(temporaryRoot, "consumer");
    const home = path.join(temporaryRoot, "home");
    mkdirSync(projectRoot);
    mkdirSync(home);
    cpSync(path.join(root, "extensions"), path.join(packageRoot, "extensions"), { recursive: true });
    cpSync(path.join(root, "examples"), path.join(packageRoot, "examples"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
    symlinkSync(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
    mutate?.(packageRoot);
    // These fixtures exercise failures quickly; CI separately runs the same verifier
    // in a real tarball consumer with independently installed Pi dependencies.
    const source = `
      import { workflowFileHashes, verifyInstalledWorkflows } from ${JSON.stringify(consumerScript)};
      await verifyInstalledWorkflows(${JSON.stringify(packageRoot)}, {
        workflows: ${JSON.stringify(workflows)},
        workflowFiles: workflowFileHashes(${JSON.stringify(path.join(root, "examples/workflows"))})
      }, ${JSON.stringify(projectRoot)});
    `;
    return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      stdio: "pipe",
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

describe("release consumer workflow verification", () => {
  it("discovers installed examples and preserves complete User and Project copies", () => {
    expect(probe()).toContain("Verified 13 installed workflows and complete Project/User namespace copies");
  }, 30_000);

  it("rejects an installed package with a missing runnable workflow", () => {
    expect(() =>
      probe((packageRoot) => {
        rmSync(path.join(packageRoot, "examples/workflows/task/plan.workflow.mjs"));
      }),
    ).toThrow(/Installed workflow names differ from checked source/);
  }, 30_000);

  it("rejects changed namespace resources even when all workflow names remain", () => {
    expect(() =>
      probe((packageRoot) => {
        writeFileSync(
          path.join(packageRoot, "examples/workflows/post-code-review/post-code-review-pipeline.svg"),
          "changed",
        );
      }),
    ).toThrow(/Installed workflow bytes differ from checked source/);
  }, 30_000);
});
