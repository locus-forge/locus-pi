import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkflowOutputDirRemoved } from "../../../../extensions/workflows/catalog/workflow-meta.js";

// Admission examines source declarations without executing workflow modules.
describe("retired workflow output metadata", () => {
  it.each(['"reports"', '""', "undefined", "chooseDirectory()"])(
    "refuses a removed outputDir declaration with value %s without evaluating the module",
    (value) => {
      const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-retired-output-"));
      const file = path.join(root, "retired.workflow.mjs");
      try {
        writeFileSync(
          file,
          `globalThis.__retiredOutputImported = true; export const meta = { outputDir: ${value} }; export default () => null;`,
          "utf8",
        );
        expect(() => assertWorkflowOutputDirRemoved(file)).toThrow(
          "Workflow meta.outputDir was removed: assign exact file destinations in agent prompts",
        );
        expect((globalThis as Record<string, unknown>).__retiredOutputImported).toBeUndefined();
      } finally {
        delete (globalThis as Record<string, unknown>).__retiredOutputImported;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
