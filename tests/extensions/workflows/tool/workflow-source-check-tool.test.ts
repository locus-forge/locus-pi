import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness, runTool } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-source-check-"));
  roots.push(root);
  mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
  return root;
}

function standardSource(body = 'return agent("Review the change");'): string {
  return `export const meta = { name: "sample", profile: "standard" };\nexport default function run({ agent }) { ${body} }\n`;
}

describe("workflow_check_source", () => {
  it("registers under the workflows owner and accepts a valid standard source", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"), standardSource());
    const harness = createHarness(root);
    workflows(harness.pi);

    expect(harness.tools.has("workflow_check_source")).toBe(true);
    expect(harness.tools.get("workflow_check_source")?.approval).toBe("read");
    const result = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: ".locus-pi/workflows/sample.workflow.mjs: standard workflow source shape passed",
    });
    expect(result.details).toEqual({
      owner: "workflows",
      path: ".locus-pi/workflows/sample.workflow.mjs",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
    });
  });

  it("returns every source-shape error without importing or running the target", async () => {
    const root = temporaryRoot();
    const marker = path.join(root, "executed.txt");
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      `import { writeFileSync } from "node:fs";\n${standardSource('if (process.env.DEPLOY === "yes") return agent("Deploy"); return agent("Hold");')}\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const result = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
    });

    expect(result.isError).toBe(true);
    expect(result.details?.errorCount).toBeGreaterThan(0);
    expect(result.details?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WF_IMPORT", severity: "error", line: 1, column: 1 })]),
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
    const output = String((result.content[0] as { text: string }).text);
    expect(output).toContain("standard workflow source shape failed");
    expect(output).toContain(
      ".locus-pi/workflows/sample.workflow.mjs:1:1 [WF_IMPORT] standard profile imports no node: modules",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("reports Node syntax failure as a diagnostic without executing source", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, "invalid.workflow.mjs"), standardSource('return await agent("Work");'));
    const harness = createHarness(root);
    workflows(harness.pi);
    const result = await runTool(harness, "workflow_check_source", { path: "invalid.workflow.mjs" });
    expect(result.isError).toBe(true);
    expect(result.details?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "WF_SOURCE_PARSE", severity: "error" })]),
    );
  });

  it("machine-enforces the orchestration-only workflow-create subset", async () => {
    const root = temporaryRoot();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      standardSource("const root = projectRoot(); return agent(`Inspect the project at ${root}`);").replace(
        "run({ agent })",
        "run({ agent, projectRoot })",
      ),
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const compatibility = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
    });
    const strict = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
      mode: "orchestration-only",
    });

    expect(compatibility.isError).not.toBe(true);
    expect(strict.isError).toBe(true);
    expect(strict.details?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WF_AUTHORING_SUBSET",
          severity: "error",
          message:
            "orchestration-only authoring does not call projectRoot(); put source or file work in an agent prompt",
        }),
      ]),
    );
    expect(String((strict.content[0] as { text: string }).text)).toContain(
      "orchestration-only workflow source shape failed",
    );
  });

  it("requires a literal agent label in the strict mode, so a generated workflow can be repaired", async () => {
    const root = temporaryRoot();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      standardSource('return agent("Review the change");'),
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    // The compatibility mode still accepts every reviewed workflow written before
    // the rule; only the strict mode generated sources must pass gains it.
    const compatibility = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
    });
    const strict = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
      mode: "orchestration-only",
    });

    expect(compatibility.isError).not.toBe(true);
    expect(strict.isError).toBe(true);
    expect(strict.details?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WF_AGENT_LABEL_MISSING",
          severity: "error",
          message:
            "agent() must declare a literal label; a call without one cannot be resumed after the source is repaired",
        }),
      ]),
    );
  });

  it("rejects two agent calls sharing one label, the only reachable answer substitution", async () => {
    const root = temporaryRoot();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      standardSource(
        'const first = await agent("same prompt", { label: "dup" });\n' +
          '  const second = await agent("same prompt", { label: "dup" });\n' +
          '  return [first, second].join(" | ");',
      ).replace("export default function run", "export default async function run"),
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const strict = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
      mode: "orchestration-only",
    });

    // The paired runtime test records what such a source does once it runs: after
    // the first site is deleted, the second is served the first's recorded answer.
    // The source never reaching Build is the actual fix.
    expect(strict.isError).toBe(true);
    expect(strict.details?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WF_AGENT_LABEL_DUPLICATE",
          severity: "error",
          message:
            'agent() label "dup" is already used in this file; two call sites sharing a label are one address on resume',
        }),
      ]),
    );
  });

  it("accepts a strict source whose agent calls all carry unique literal labels", async () => {
    const root = temporaryRoot();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      standardSource(
        'const draft = await agent("draft it", { label: "draft" });\n' +
          '  return await agent("review it: " + draft, { label: "review" });',
      ).replace("export default function run", "export default async function run"),
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const strict = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/sample.workflow.mjs",
      mode: "orchestration-only",
    });

    expect(strict.isError).not.toBe(true);
    expect(strict.details?.errorCount).toBe(0);
  });

  it("keeps errorCount as the unique legacy-message count when structured occurrences repeat", async () => {
    const root = temporaryRoot();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      [
        'export const meta = { name: "sample", profile: "standard" };',
        'import fs from "node:fs";',
        'import path from "node:path";',
        "export default function run() { return true; }",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const result = await runTool(harness, "workflow_check_source", { path: ".locus-pi/workflows/sample.workflow.mjs" });
    const diagnostics = result.details?.diagnostics as readonly unknown[];

    expect(result.isError).toBe(true);
    expect(result.details?.errorCount).toBe(3);
    expect(result.details?.warningCount).toBe(0);
    expect(diagnostics).toHaveLength(6);
  });

  it("returns warning diagnostics without failing the tool", async () => {
    const root = temporaryRoot();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "sample.workflow.mjs"),
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "unused" }] };\nexport default function run({ phase }) { return { ok: true }; }\n',
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const result = await runTool(harness, "workflow_check_source", { path: ".locus-pi/workflows/sample.workflow.mjs" });

    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({
      owner: "workflows",
      path: ".locus-pi/workflows/sample.workflow.mjs",
      errorCount: 0,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      warningCount: 1,
      diagnostics: [
        {
          code: "WF_PHASE_UNUSED_DECLARATION",
          severity: "warning",
          message: 'meta.phases title "unused" has no literal phase("unused") call',
          line: 1,
          column: 78,
          endLine: 1,
          endColumn: 86,
        },
      ],
      outputTruncated: false,
      outputRedacted: false,
    });
    expect(String((result.content[0] as { text: string }).text)).toBe(
      ".locus-pi/workflows/sample.workflow.mjs: standard workflow source shape passed with 1 warning(s):\n" +
        '.locus-pi/workflows/sample.workflow.mjs:1:78 [WF_PHASE_UNUSED_DECLARATION] meta.phases title "unused" has no literal phase("unused") call',
    );
  });

  it("rejects lexical and symlink escapes from the current project", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const outsideFile = path.join(outside, "outside.workflow.mjs");
    writeFileSync(outsideFile, standardSource());
    symlinkSync(outsideFile, path.join(root, ".locus-pi", "workflows", "linked.workflow.mjs"));
    const harness = createHarness(root);
    workflows(harness.pi);

    const lexical = await runTool(harness, "workflow_check_source", { path: "../outside.workflow.mjs" });
    const symlink = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/linked.workflow.mjs",
    });

    expect(lexical.isError).toBe(true);
    expect(String((lexical.content[0] as { text: string }).text)).toContain("path escapes the project root");
    expect(symlink.isError).toBe(true);
    expect(String((symlink.content[0] as { text: string }).text)).toContain("through a symlink");
  });

  it("rejects an oversized source before parsing it", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".locus-pi", "workflows", "large.workflow.mjs"), "x".repeat(512 * 1024 + 1));
    const harness = createHarness(root);
    workflows(harness.pi);

    const result = await runTool(harness, "workflow_check_source", {
      path: ".locus-pi/workflows/large.workflow.mjs",
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain(
      "source exceeds the 524288-byte validation limit",
    );
  });
});
