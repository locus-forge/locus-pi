import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultExtensionManifests,
  extensionDocs,
  featureDependencyGraph,
  publicCatalogs,
  root,
} from "../helpers/package-contract.js";

describe("extension reference contract", () => {
  /**
   * The reference table in docs/extensions.md is generated from this catalog, and
   * `npm run check:generated` proves the published table still matches it. What is left to prove
   * here is the other half: that the committed catalog still matches the manifests it came from.
   */
  it("keeps the generated extension catalog equal to the manifests it is built from", () => {
    const manifests = defaultExtensionManifests();
    expect(publicCatalogs.extensions).toEqual(
      manifests.map(({ id, manifest }) => ({
        id,
        tools: manifest.provides.tools,
        commands: manifest.provides.commands,
        hooks: manifest.provides.hooks,
        risk: manifest.risk,
      })),
    );

    for (const { manifestPath, manifest } of manifests) {
      expect(existsSync(path.join(root, manifest.docsPath)), manifest.docsPath).toBe(true);
      for (const testPath of manifest.tests)
        expect(existsSync(path.join(root, testPath)), `missing test from ${manifestPath}: ${testPath}`).toBe(true);
    }
  });

  it("keeps the documented feature dependency graph equal to the source imports", () => {
    const sourceGraph = featureDependencyGraph(publicCatalogs.extensions.map(({ id }) => id));
    expect([...sourceGraph].filter(([, dependencies]) => dependencies.length > 0)).toEqual([["agents", ["workflows"]]]);
    expect(extensionDocs).toContain("`agents → workflows`");
  });
});
