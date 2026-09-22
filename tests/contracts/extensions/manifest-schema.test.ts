import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extensionManifestProblems } from "../../../scripts/check-extension-manifests.js";
import { root } from "../helpers/package-contract.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A manifest the real schema accepts. Each case below breaks exactly one thing in it. */
function validManifest(): Record<string, unknown> {
  return {
    id: "one",
    runtimeRequirements: ["Pi command registration"],
    stateUsed: ["nothing persistent"],
    provides: { tools: ["one_tool"], commands: ["one run"], hooks: [] },
    uiLifecycle: { commands: [{ name: "one", taxonomy: ["no-ui"], persistent: [] }] },
    permissions: {
      filesystem: { read: [], write: [] },
      subprocess: [],
      network: [],
      browser: false,
      models: false,
      ui: [],
    },
    risk: "low",
    docsPath: "extensions/one/README.md",
    tests: ["tests/one.test.ts"],
  };
}

/**
 * Materialize a one-extension package around `manifest`, validated against the real
 * schemas/extension-manifest.schema.json rather than a copy, so a fixture cannot pass a rule the
 * repository no longer has.
 */
function fixtureRoot(manifest: unknown, options: { schema?: unknown } = {}): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "locus-extension-manifest-"));
  temporaryRoots.push(fixture);
  mkdirSync(path.join(fixture, "extensions", "one"), { recursive: true });
  mkdirSync(path.join(fixture, "schemas"), { recursive: true });
  mkdirSync(path.join(fixture, "tests"), { recursive: true });
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ files: ["extensions/one/README.md"], pi: { extensions: ["./extensions/one/index.ts"] } }),
  );
  if (options.schema === undefined) {
    copyFileSync(
      path.join(root, "schemas/extension-manifest.schema.json"),
      path.join(fixture, "schemas/extension-manifest.schema.json"),
    );
  } else {
    writeFileSync(path.join(fixture, "schemas/extension-manifest.schema.json"), JSON.stringify(options.schema));
  }
  writeFileSync(path.join(fixture, "extensions", "one", "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(fixture, "extensions", "one", "README.md"), "# one\n");
  writeFileSync(path.join(fixture, "tests", "one.test.ts"), "");
  return fixture;
}

function messages(manifest: unknown): string[] {
  return extensionManifestProblems(fixtureRoot(manifest)).map(
    ({ file, field, message }) => `${file}: ${field}: ${message}`,
  );
}

describe("extension manifest contract", () => {
  it("accepts every manifest package.json#pi.extensions declares", () => {
    expect(extensionManifestProblems(root)).toEqual([]);
  });

  it("accepts the fixture the rejection cases are built from", () => {
    expect(messages(validManifest())).toEqual([]);
  });

  it("rejects a field the schema does not declare", () => {
    expect(messages({ ...validManifest(), defaultEnabled: true })).toEqual([
      "extensions/one/manifest.json: defaultEnabled: is not declared by schemas/extension-manifest.schema.json",
    ]);
  });

  it("rejects a field the schema does not declare inside a governed object", () => {
    const manifest = validManifest();
    expect(messages({ ...manifest, uiLifecycle: { ...(manifest.uiLifecycle as object), tier: "core-owned" } })).toEqual(
      ["extensions/one/manifest.json: uiLifecycle.tier: is not declared by schemas/extension-manifest.schema.json"],
    );
  });

  it("rejects a missing required field", () => {
    const { risk: _risk, ...withoutRisk } = validManifest();
    expect(messages(withoutRisk)).toEqual(["extensions/one/manifest.json: risk: is required and missing"]);
  });

  it("rejects paths the manifest promises but the package does not have", () => {
    expect(
      messages({ ...validManifest(), docsPath: "extensions/one/MANUAL.md", tests: ["tests/absent.test.ts"] }),
    ).toEqual([
      "extensions/one/manifest.json: docsPath: points at a missing file: extensions/one/MANUAL.md",
      "extensions/one/manifest.json: tests[0]: points at a missing file: tests/absent.test.ts",
    ]);
  });

  it("rejects a uiLifecycle entry that names an undeclared surface", () => {
    expect(
      messages({ ...validManifest(), uiLifecycle: { tools: [{ name: "gone", taxonomy: ["no-ui"], persistent: [] }] } }),
    ).toEqual([
      "extensions/one/manifest.json: uiLifecycle.tools[0].name: names gone, which provides.tools does not declare",
    ]);
  });

  it("refuses a schema keyword the checker does not apply, instead of skipping it", () => {
    const fixture = fixtureRoot(validManifest(), {
      schema: { type: "object", properties: { id: { type: "string", minLength: 1 } } },
    });
    expect(() => extensionManifestProblems(fixture)).toThrow(/unsupported keyword "minLength"/u);
  });
});
