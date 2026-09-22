import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultExtensionManifests, root } from "../contracts/helpers/package-contract.js";

const expectedDocs = [
  "architecture.md",
  "environment-variables.md",
  "extensions.md",
  "getting-started.md",
  "locus-pi-workflows.md",
  "tui-design.md",
  "workflows",
  "workflows.md",
];

describe("public documentation topology", () => {
  it("keeps docs small and free of internal history surfaces", () => {
    expect(
      readdirSync(path.join(root, "docs"), { withFileTypes: true })
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(expectedDocs);
    for (const relativePath of [
      "docs/adr",
      "docs/decisions",
      "docs/prd",
      "docs/source-audit",
      "docs/internal",
      "docs/archive",
      "docs/milestones.md",
    ]) {
      expect(existsSync(path.join(root, relativePath)), relativePath).toBe(false);
    }
  });

  it("exposes authoring from the public guide and retires the hidden omnibus manual", () => {
    const guide = readFileSync(path.join(root, "docs/locus-pi-workflows.md"), "utf8");
    expect(guide).toContain("skills/locus-pi-workflow-create/SKILL.md");
    expect(guide).toContain("source-boundary.md");
    expect(guide).toContain("source-shape.md");
    expect(existsSync(path.join(root, "extensions/workflows/AUTHORING.md"))).toBe(false);
  });

  it("co-locates one manual with every default extension", () => {
    const index = readFileSync(path.join(root, "docs/extensions.md"), "utf8");
    for (const { id, manifest } of defaultExtensionManifests()) {
      expect(manifest.docsPath).toBe(`extensions/${id}/README.md`);
      expect(existsSync(path.join(root, manifest.docsPath)), manifest.docsPath).toBe(true);
      expect(index).toContain(`extensions/${id}/README.md`);
    }
  });

  it("links the public guides from the short root README", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    for (const relativePath of [
      "docs/getting-started.md",
      "docs/extensions.md",
      "docs/workflows.md",
      "docs/workflows/index.md",
      "docs/locus-pi-workflows.md",
      "skills/README.md",
    ]) {
      expect(readme).toContain(relativePath);
      expect(existsSync(path.join(root, relativePath)), relativePath).toBe(true);
    }
  });
});
