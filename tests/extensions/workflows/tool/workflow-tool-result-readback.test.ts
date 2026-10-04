import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../../../../extensions/_shared/host/pi-api.js";
import workflows from "../../../../extensions/workflows/index.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { createHarness } from "../../../test-harness.js";

describe("workflow tool card persisted native result", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-card-result-"));
    roots.push(root);
    const runDir = ensureWorkflowRunDir(root, "run-card");
    const outputsDir = path.join(runDir, "outputs");
    mkdirSync(outputsDir, { recursive: true });
    const resultTextPath = path.join(outputsDir, "workflow-result.md");
    writeFileSync(resultTextPath, "Persisted exact native answer.\n", "utf8");
    return { runDir, outputsDir, resultTextPath };
  }

  function rendered(details: Record<string, unknown>) {
    const harness = createHarness();
    workflows(harness.pi);
    const tool = harness.tools.get("workflow")!;
    const context: ToolRenderContext = {
      args: { name: "plan" },
      toolCallId: "native-result-readback",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: true,
      isError: false,
    };
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "bounded digest" }],
        details: { workflowName: "plan", status: "completed", ...details },
      },
      { expanded: true, isPartial: false },
      { fg: (_tone, text) => text, bg: (_tone, text) => text, bold: (text) => text },
      context,
    );
    const text = component.render(220).join("\n");
    component.dispose?.();
    return text;
  }

  it("reads fresh native evidence without a redundant outputDir detail", () => {
    const { runDir, resultTextPath } = fixture();
    const text = rendered({ runDir, resultTextPath });
    expect(text).toContain("Persisted exact native answer.");
    expect(text).not.toContain("legacy native outputs:");
    expect(text).not.toContain("unavailable:");
  });

  it("reads the exact legacy evidence folder without mutating old receipt details", () => {
    const { runDir, outputsDir, resultTextPath } = fixture();
    const details = { runDir, outputDir: outputsDir, resultTextPath };
    const original = JSON.stringify(details);
    const text = rendered(details);
    expect(text).toContain("Persisted exact native answer.");
    expect(text).toContain(`legacy native outputs: ${outputsDir}`);
    expect(JSON.stringify(details)).toBe(original);
  });

  it.each(["other-folder", "wrong-type"])("refuses invalid legacy outputDir %s", (kind) => {
    const { runDir, resultTextPath } = fixture();
    const text = rendered({
      runDir,
      resultTextPath,
      outputDir: kind === "other-folder" ? path.join(runDir, "other") : 42,
    });
    expect(text).toContain("full workflow result unavailable: invalid output path");
    expect(text).not.toContain("Persisted exact native answer.");
  });

  it("refuses an arbitrary result path even when its file exists", () => {
    const { runDir } = fixture();
    const resultTextPath = path.join(runDir, "other.md");
    writeFileSync(resultTextPath, "Untrusted alternative answer.", "utf8");
    const text = rendered({ runDir, resultTextPath });
    expect(text).toContain("full workflow result unavailable: invalid result path");
    expect(text).not.toContain("Untrusted alternative answer.");
  });

  it("refuses a native result leaf symlink instead of reading its target", () => {
    const { runDir, resultTextPath } = fixture();
    const target = path.join(runDir, "outside-result.md");
    writeFileSync(target, "Symlink target answer.", "utf8");
    rmSync(resultTextPath);
    symlinkSync(target, resultTextPath);
    const text = rendered({ runDir, resultTextPath });
    expect(text).toContain("full workflow result unavailable: result file cannot be read");
    expect(text).not.toContain("Symlink target answer.");
  });
});
