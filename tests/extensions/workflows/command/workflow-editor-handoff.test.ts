import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkflowCatalogModel } from "../../../../extensions/workflows/catalog/workflow-catalog.js";
import { workflowStartEditorHandoff } from "../../../../extensions/workflows/command/workflow-editor-handoff.js";
import { createHarness } from "../../../test-harness.js";

describe("workflow editor handoff failures", () => {
  it("keeps the editor unchanged when typed schema admission fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-editor-handoff-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "invalid.workflow.mjs"),
        'const inputSchema={type:"string"}; export const meta={inputSchema}; export default()=>null;\n',
      );
      const row = buildWorkflowCatalogModel(root, root).current[0]!;
      const harness = createHarness(root);

      expect(workflowStartEditorHandoff(harness.ctx, row, root, root)).toBeUndefined();
      expect(harness.editorText).toBe("");
      expect(harness.widgets.get("workflows")).toContain("Workflow action could not be prepared");
      expect(harness.widgets.get("workflows")).toContain("meta.inputSchema requires one");
      expect(harness.widgets.get("workflows")).toContain("explicit static schema declaration");
      expect(harness.widgets.get("workflows")).toContain("No editor text was changed and no workflow was started");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the editor unchanged when the selected search directory becomes blocked", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-editor-resolver-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(path.join(workflowDir, "selected.workflow.mjs"), "export default()=>null;\n");
      const row = buildWorkflowCatalogModel(root, root).current[0]!;
      rmSync(workflowDir, { recursive: true });
      writeFileSync(workflowDir, "blocked after selection\n");
      const harness = createHarness(root);

      expect(workflowStartEditorHandoff(harness.ctx, row, root, root)).toBeUndefined();
      expect(harness.editorText).toBe("");
      expect(harness.widgets.get("workflows")).toContain("Workflow search directory is not a");
      expect(harness.widgets.get("workflows")).toContain("directory:");
      expect(harness.widgets.get("workflows")).toContain("No editor text was changed and no workflow was started");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
