import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
} from "../../../../extensions/workflows/catalog/workflow-catalog.js";

describe("workflow-specific static info", () => {
  it("exposes the complete adaptive-code-review operator contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-adaptive-info-"));
    try {
      const model = buildWorkflowCatalogModel(root, root);
      expect(model.current).toContainEqual(
        expect.objectContaining({ name: "adaptive-code-review", source: "package" }),
      );
      const text = buildWorkflowInfoBlock(root, root, "adaptive-code-review").body?.join("\n") ?? "";
      for (const title of [
        "Purpose",
        "Inputs",
        "Selection",
        "Full review",
        "Models",
        "Compatibility",
        "Artifact",
        "Continuation",
      ]) {
        expect(text).toContain(`${title}:`);
      }
      for (const contract of [
        "workflow contract:",
        "--input-json",
        "reviewMode to full",
        "task:xhigh",
        "agent:high",
        "Pi >=1.0.0",
        "adaptive-code-review.md",
        "awaitOperator",
        "phases: 5 declared before the run starts",
      ]) {
        expect(text).toContain(contract);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders generic literal info without evaluating workflow source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-static-info-"));
    try {
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        [
          'export const meta = { description: "Explains alpha", info: [',
          '  { title: "Inputs", detail: "One typed task object." },',
          '  { title: "Artifact", detail: "One durable report." },',
          "] };",
          'throw new Error("must not evaluate");',
        ].join("\n"),
      );

      const text = buildWorkflowInfoBlock(root, root, "alpha").body?.join("\n") ?? "";
      expect(text).toContain("workflow contract:");
      expect(text).toContain("Inputs: One typed task object.");
      expect(text).toContain("Artifact: One durable report.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
