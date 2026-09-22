import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const projectRoot = process.cwd();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("check-workflow-source-shape CLI", () => {
  it("exposes orchestration-only mode without importing the workflow", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-source-cli-"));
    roots.push(root);
    await writeFile(
      path.join(root, "sample.workflow.mjs"),
      'export const meta = { name: "sample", profile: "standard" };\n' +
        'export default function run({ agent, projectRoot }) { const root = projectRoot(); return agent(`Inspect ${root}`, { label: "review", title: "Review" }); }\n',
      "utf8",
    );

    const compatibility = await runScript(root, ["sample.workflow.mjs"]);
    expect(compatibility.code).toBe(0);
    expect(compatibility.stdout).toContain("standard source shape passed");

    const strict = await runScript(root, ["--mode", "orchestration-only", "sample.workflow.mjs"]);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain("orchestration-only workflow source shape failed");
    expect(strict.stderr).toContain("[WF_AUTHORING_SUBSET]");
    expect(strict.stderr).toContain("does not call projectRoot()");

    await writeFile(
      path.join(root, "sample.workflow.mjs"),
      'export const meta = { name: "sample", profile: "standard" };\n' +
        'export default function run({ agent }) { return agent("Inspect", { label: "review", title: "Review" }); }\n',
      "utf8",
    );
    const accepted = await runScript(root, ["--mode", "orchestration-only", "sample.workflow.mjs"]);
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain("orchestration-only workflow source shape passed");
  });

  it("rejects an unknown mode before checking source", async () => {
    const result = await runScript(projectRoot, ["--mode", "strict", "missing.workflow.mjs"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must be "compatibility" or "orchestration-only"');
    expect(result.stderr).not.toContain("unable to read source");
  });
});

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(cwd: string, args: string[]): Promise<ScriptResult> {
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const script = path.join(projectRoot, "scripts", "check-workflow-source-shape.ts");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", pathToFileURL(tsx).href, script, ...args],
      { cwd, encoding: "utf8" },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}
