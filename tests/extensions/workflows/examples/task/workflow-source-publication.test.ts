import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
} from "../../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { checkWorkflowSourceText } from "../../../../../extensions/workflows/tool/workflow-source-check-tool.js";
import { createHarness } from "../../../../test-harness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source =
  'export const meta = { name: "generated", profile: "standard" };\nexport default function run(dsl) { return dsl.publishPrimaryArtifact("answer.md", "real deliverable"); }\n';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-source-publication-"));
  roots.push(root);
  const saved = path.join(root, ".locus-pi/workflows");
  mkdirSync(saved, { recursive: true });
  writeFileSync(
    path.join(saved, "author.workflow.mjs"),
    `export default async function run(dsl) {
    await dsl.agent("Verify the workspace source", { label: "verifier" });
    return dsl.publishPrimaryArtifact("workflow.mjs", { workflowSource: "workflow.mjs" });
  }`,
  );
  const workspace = path.join(root, "proof");
  mkdirSync(workspace);
  const file = path.join(workspace, "workflow.mjs");
  const harness = createHarness(root);
  const run = () =>
    runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "author",
      outputDir: "proof",
      createExecutor: () => ({
        run: async (request) => ({
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          text: "All checks passed (prose)",
          reason: "done",
          diagnostics: [],
          lifecycleEntryIds: [],
        }),
      }),
    });
  return { root, file, harness, run };
}

describe("checked workspace source publication", () => {
  it("retains the checked bytes with the eval result name/output path and launches the retained copy", async () => {
    const f = fixture();
    writeFileSync(f.file, source);
    expect(checkWorkflowSourceText(source, "orchestration-only")).toEqual([]);
    const authored = await f.run();
    expect(authored.ok, authored.error).toBe(true);
    expect(authored.result).toMatchObject({
      name: "workflow.mjs",
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    const output = path.join(authored.runDir, "outputs/workflow.mjs");
    expect(readFileSync(output, "utf8")).toBe(source);
    const ref = authored.result as { artifactId: string };
    const artifact = readWorkflowArtifactRecord(f.root, authored.runId, ref.artifactId);
    expect(artifact.status).toBe("ready");
    if (artifact.status === "ready") expect(artifact.bytes.toString("utf8")).toBe(source);
    // Workspace edits do not replace the retained artifact read by the existing eval consumer.
    writeFileSync(f.file, "mutated workspace");
    const launched = await runWorkflowScript({
      pi: f.harness.pi,
      ctx: f.harness.ctx,
      signal: new AbortController().signal,
      scriptPath: path.relative(f.root, output),
    });
    expect(launched.ok, launched.error).toBe(true);
    expect(readFileSync(path.join(launched.runDir, "outputs/answer.md"), "utf8")).toBe("real deliverable");
    expect(JSON.stringify(launched.scriptIdentity)).toContain(createHash("sha256").update(source).digest("hex"));
  });

  it.each(["missing", "empty", "symlink", "shape", "syntax", "changed", "utf8"])(
    "fails closed for %s source despite verifier success prose",
    async (kind) => {
      const f = fixture();
      if (kind === "empty") writeFileSync(f.file, "");
      if (kind === "shape") writeFileSync(f.file, 'import fs from "node:fs";\n' + source);
      // AST parses this; Node rejects await outside an async function.
      if (kind === "syntax")
        writeFileSync(
          f.file,
          source.replace("return dsl.publishPrimaryArtifact", "return await dsl.publishPrimaryArtifact"),
        );
      if (kind === "symlink") {
        writeFileSync(path.join(f.root, "outside.mjs"), source);
        symlinkSync(path.join(f.root, "outside.mjs"), f.file);
      }
      if (kind === "utf8") writeFileSync(f.file, Buffer.from([0xff]));
      if (kind === "changed") {
        writeFileSync(f.file, source);
        expect(checkWorkflowSourceText(readFileSync(f.file, "utf8"), "orchestration-only")).toEqual([]);
        writeFileSync(f.file, "Verifier said passed, but this is not source");
      }
      const result = await f.run();
      expect(result.ok).toBe(false);
      const index = readWorkflowArtifactIndex(f.root, result.runId);
      expect(index.status).toBe("ready");
      if (index.status === "ready") expect(index.index.artifacts.some((entry) => entry.kind === "primary")).toBe(false);
      expect(result.error).toBeTruthy();
      if (kind !== "missing") expect(readFileSync(f.file).length).toBeGreaterThanOrEqual(0);
    },
  );
});
