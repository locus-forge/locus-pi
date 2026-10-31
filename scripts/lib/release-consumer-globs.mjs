import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Exercise installed Pi owners through real SDK exports, not a standalone matcher.
/** @param {string} consumerRoot */
export async function verifyConsumerGlobs(consumerRoot) {
  const piRoot = path.join(consumerRoot, "node_modules/@earendil-works/pi-coding-agent");
  const manifest = JSON.parse(readFileSync(path.join(piRoot, "package.json"), "utf8"));
  const sdk = await import(pathToFileURL(path.join(piRoot, manifest.exports["."].import)).href);
  const { DefaultPackageManager, SettingsManager, resolveModelScopeWithDiagnostics } = sdk;
  for (const api of [DefaultPackageManager, SettingsManager, resolveModelScopeWithDiagnostics])
    assert.equal(typeof api, "function", "Actual Pi SDK export is required");
  const fixture = mkdtempSync(path.join(tmpdir(), "locus-pi-globs-"));
  try {
    const packageRoot = path.join(fixture, "package");
    const files = ["extensions/a.ts", "extensions/A.ts", "extensions/nested/b.ts", "skills/a.ts"];
    for (const filename of files) {
      mkdirSync(path.dirname(path.join(packageRoot, filename)), { recursive: true });
      writeFileSync(path.join(packageRoot, filename), "export default function () {}\n");
    }
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "local-glob-fixture", pi: { extensions: files } }),
    );
    /** @type {[string, string[], string[]][]} */
    const packageCases = [
      ["wildcard", ["extensions/*.ts"], ["extensions/A.ts", "extensions/a.ts"]],
      ["globstar", ["extensions/**/*.ts"], files.slice(0, 3)],
      ["include-exclude", ["extensions/**/*.ts", "!extensions/nested/**"], files.slice(0, 2)],
      ["case-sensitive", ["extensions/A.ts"], ["extensions/A.ts"]],
      ["literal", ["extensions/a.ts"], ["extensions/a.ts"]],
      ["negative", ["missing/*.ts"], []],
    ];
    for (const [name, patterns, expected] of packageCases) {
      const cwd = path.join(fixture, name);
      const agentDir = path.join(cwd, "agent");
      mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ packages: [{ source: packageRoot, extensions: patterns }] }),
      );
      const manager = new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
      });
      /** @type {{extensions: {enabled: boolean, path: string}[]}} */
      const result = await manager.resolve();
      assert.deepEqual(
        result.extensions
          .filter((entry) => entry.enabled)
          .map((entry) => path.relative(packageRoot, entry.path))
          .sort(),
        [...expected].sort(),
        name,
      );
    }
    const models = [
      { provider: "fixture", id: "Alpha" },
      { provider: "fixture", id: "nested/Beta" },
      { provider: "other", id: "literal[1m]" },
    ];
    /** @type {[string, string, string[]][]} */
    const modelCases = [
      ["wildcard", "fixture/*", ["Alpha"]],
      ["globstar", "fixture/**", ["Alpha", "nested/Beta"]],
      ["nocase", "FIXTURE/AL*", ["Alpha"]],
      ["literal", "other/literal[1m]", ["literal[1m]"]],
      ["negative", "absent/*", []],
    ];
    for (const [name, pattern, expected] of modelCases) {
      /** @type {{scopedModels: {model: {id: string}}[], diagnostics: {code: string}[]}} */
      const result = await resolveModelScopeWithDiagnostics([pattern], {
        async getAvailable() {
          return models;
        },
      });
      assert.deepEqual(result.scopedModels.map(({ model }) => model.id).sort(), [...expected].sort(), name);
      assert.equal(result.diagnostics.length, expected.length ? 0 : 1, name);
      if (!expected.length) {
        assert(result.diagnostics[0]);
        assert.equal(result.diagnostics[0].code, "no-match");
      }
    }
    return {
      node: process.version,
      packageCases: packageCases.map(([name]) => name),
      modelCases: modelCases.map(([name]) => name),
      sdkExports: "imported and invoked",
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
