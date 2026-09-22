import { mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWorkflowRunDir } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { createWorkflowResourceLoader } from "../../../../../extensions/workflows/runtime/workflow-resources.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-resources-"));
  const workflowDirectory = path.join(root, "nested", "review");
  const resourceDirectory = path.join(workflowDirectory, "resources");
  const runDir = ensureWorkflowRunDir(root, "resource-test-run");
  mkdirSync(resourceDirectory, { recursive: true });
  const workflowPath = path.join(workflowDirectory, "review.workflow.mjs");
  writeFileSync(workflowPath, "export default async () => {};\n", "utf8");
  writeFileSync(
    path.join(resourceDirectory, "review.prompt.md"),
    "Target:\n{{TARGET}}\n\nPrior text:\n{{PRIOR_TEXT}}\n",
    "utf8",
  );
  return { root, workflowDirectory, workflowPath, resourceDirectory, runDir };
}

describe("workflow-local prompt resources", () => {
  it("renders a neighboring prompt source-relatively and records only prompt evidence", () => {
    const item = fixture();
    const loader = createWorkflowResourceLoader({
      workflowSourcePath: item.workflowPath,
      runDir: item.runDir,
    });

    const prompt = loader.renderPrompt("./resources/review.prompt.md", {
      TARGET: "base=abc head=def",
      PRIOR_TEXT: '{"status":"failed-looking"}',
    });

    expect(prompt).toBe('Target:\nbase=abc head=def\n\nPrior text:\n{"status":"failed-looking"}\n');
    expect(loader.evidence()).toHaveLength(1);
    expect(loader.evidence()[0]?.kind).toBe("prompt");
    expect(
      loader.evidence().every((evidence) => evidence.sourcePath.startsWith(realpathSync(item.workflowDirectory))),
    ).toBe(true);
  });

  it("copies immutable bytes once and records hash-backed run evidence", () => {
    const item = fixture();
    const loader = createWorkflowResourceLoader({
      workflowSourcePath: item.workflowPath,
      runDir: item.runDir,
    });
    const first = loader.renderPrompt("./resources/review.prompt.md", {
      TARGET: "one",
      PRIOR_TEXT: "two",
    });
    writeFileSync(path.join(item.resourceDirectory, "review.prompt.md"), "changed {{TARGET}} {{PRIOR_TEXT}}", "utf8");
    const second = loader.renderPrompt("./resources/review.prompt.md", {
      TARGET: "one",
      PRIOR_TEXT: "two",
    });
    const evidence = loader.evidence()[0]!;

    expect(second).toBe(first);
    expect(readFileSync(evidence.snapshotPath, "utf8")).toBe("Target:\n{{TARGET}}\n\nPrior text:\n{{PRIOR_TEXT}}\n");
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(evidence.snapshotPath).mode & 0o222).toBe(0);
  });

  it("rejects absolute paths, lexical escapes, symlink escapes, and wrong suffixes", () => {
    const item = fixture();
    const outside = path.join(item.root, "outside.prompt.md");
    writeFileSync(outside, "outside", "utf8");
    symlinkSync(outside, path.join(item.resourceDirectory, "escape.prompt.md"));
    const loader = createWorkflowResourceLoader({
      workflowSourcePath: item.workflowPath,
      runDir: item.runDir,
    });

    expect(() => loader.renderPrompt(outside)).toThrow("must be relative");
    expect(() => loader.renderPrompt("../../outside.prompt.md")).toThrow("escapes");
    expect(() => loader.renderPrompt("./resources/escape.prompt.md")).toThrow("through a symlink");
    expect(() => loader.renderPrompt("./resources/reviewer.agent.md")).toThrow("must use .prompt.md");
  });

  it("rejects missing and unused prompt variables", () => {
    const item = fixture();
    const loader = createWorkflowResourceLoader({
      workflowSourcePath: item.workflowPath,
      runDir: item.runDir,
    });

    expect(() => loader.renderPrompt("./resources/review.prompt.md", { TARGET: "target" })).toThrow(
      "PRIOR_TEXT is missing",
    );
    expect(() =>
      loader.renderPrompt("./resources/review.prompt.md", {
        TARGET: "target",
        PRIOR_TEXT: "prior",
        EXTRA: "unused",
      }),
    ).toThrow("variables are unused (EXTRA)");
  });

  it("fails empty prompts after recording their immutable source evidence", () => {
    const item = fixture();
    const badPath = path.join(item.resourceDirectory, "empty.prompt.md");
    writeFileSync(badPath, "\n", "utf8");
    const loader = createWorkflowResourceLoader({
      workflowSourcePath: item.workflowPath,
      runDir: item.runDir,
    });

    expect(() => loader.renderPrompt("./resources/empty.prompt.md")).toThrow("Workflow prompt resource is empty");
    expect(loader.evidence()).toHaveLength(1);
  });
});
