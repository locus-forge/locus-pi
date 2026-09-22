import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  GENERATED_DOCUMENTS,
  generatedPublicCatalogFiles,
  staleGeneratedFiles,
  type GeneratedFile,
} from "../../../scripts/build-public-catalogs.js";
import { listPackagedWorkflowEntries } from "../../../extensions/workflows/runtime/workflow-discovery.js";
import { defaultExtensionManifests, root } from "../helpers/package-contract.js";

const CATALOG_FILE = "dist/public-catalogs.json";
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

/**
 * The smallest tree `--check` reads under a given root: package.json, the manifests it declares, the
 * two published documents, and the committed catalog. Packaged workflows are deliberately absent —
 * the registry is the installed `extensions/workflows/examples/` directory the generator resolves from
 * its own module URL, not from the working directory, so a fixture cannot fake it.
 */
function fixtureRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "locus-pi-catalogs-"));
  temporaryRoots.push(directory);
  for (const relativePath of [
    "package.json",
    CATALOG_FILE,
    ...GENERATED_DOCUMENTS.map((document) => document.file),
    ...defaultExtensionManifests().map(({ id }) => `extensions/${id}/manifest.json`),
  ]) {
    const destination = path.join(directory, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, relativePath), destination);
  }
  return directory;
}

function runCheck(fixture: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "scripts", "build-public-catalogs.ts"), "--check"],
      { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function contentByPath(files: GeneratedFile[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.content]));
}

describe("generated public catalogs", () => {
  it("renders byte-identical output on two consecutive runs", async () => {
    const first = contentByPath(await generatedPublicCatalogFiles(root));
    const second = contentByPath(await generatedPublicCatalogFiles(root));
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [file, content] of first) {
      expect(Buffer.from(second.get(file) ?? "").equals(Buffer.from(content)), file).toBe(true);
    }
  });

  it("keeps every committed generated file equal to a fresh render", async () => {
    expect(await staleGeneratedFiles(root, await generatedPublicCatalogFiles(root))).toEqual([]);
  });

  it("publishes the six active extensions exactly once each", async () => {
    const [catalogFile] = await generatedPublicCatalogFiles(root);
    const catalogs = JSON.parse(catalogFile?.content ?? "") as {
      extensions: Array<{ id: string }>;
      workflows: Array<{ name: string; namespace: string }>;
    };
    expect(catalogFile?.path).toBe(CATALOG_FILE);
    expect(catalogs.extensions).toHaveLength(6);
    expect(catalogs.extensions.map(({ id }) => id)).toEqual(defaultExtensionManifests().map(({ id }) => id));
  });

  it("keeps the workflow catalog internally consistent with the packaged registry on disk", async () => {
    const [catalogFile] = await generatedPublicCatalogFiles(root);
    const { workflows } = JSON.parse(catalogFile?.content ?? "") as {
      workflows: Array<{ name: string; namespace: string }>;
    };
    const packaged = listPackagedWorkflowEntries();

    // Counts and namespaces are read from disk on purpose: a hand-maintained number here would
    // reintroduce exactly the drift this artifact exists to remove.
    expect(workflows.map(({ name }) => name)).toEqual(packaged.map(({ name }) => name));
    expect(new Set(workflows.map(({ name }) => name)).size).toBe(workflows.length);

    const namespaces = new Map<string, number>();
    for (const workflow of workflows) {
      expect(workflow.namespace, workflow.name).not.toBe("");
      expect(workflow.name === workflow.namespace || workflow.name.startsWith(`${workflow.namespace}/`)).toBe(true);
      namespaces.set(workflow.namespace, (namespaces.get(workflow.namespace) ?? 0) + 1);
    }
    expect(namespaces.size).toBeGreaterThan(0);
    for (const [namespace, members] of namespaces) expect(members, namespace).toBeGreaterThan(0);

    for (const entry of packaged) expect(existsSync(entry.path), entry.name).toBe(true);
  });

  it("carries one well-formed marker pair per catalog in every target document", () => {
    for (const { file, kinds } of GENERATED_DOCUMENTS) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const kind of kinds) {
        const start = `<!-- locus:${kind}:start -->`;
        const end = `<!-- locus:${kind}:end -->`;
        expect(text.split(start), `${file} ${start}`).toHaveLength(2);
        expect(text.split(end), `${file} ${end}`).toHaveLength(2);
        expect(text.indexOf(start), `${file} ${kind}`).toBeLessThan(text.indexOf(end));
      }
    }
  });

  it("accepts an untouched fixture and rejects a doctored generated fragment", () => {
    const fixture = fixtureRoot();
    expect(runCheck(fixture).status).toBe(0);

    const document = path.join(fixture, "docs/extensions.md");
    const text = readFileSync(document, "utf8");
    writeFileSync(document, text.replace("| `agents`", "| `agentz`"));

    const doctored = runCheck(fixture);
    expect(doctored.status).toBe(1);
    expect(doctored.output).toContain("docs/extensions.md");
    expect(doctored.output).toContain("npm run build:catalogs");
  });

  it("reports a deleted marker as a finding instead of crashing", () => {
    const fixture = fixtureRoot();
    const document = path.join(fixture, "docs/workflows.md");
    writeFileSync(document, readFileSync(document, "utf8").replace("<!-- locus:workflows:end -->", ""));

    const broken = runCheck(fixture);
    expect(broken.status).toBe(1);
    expect(broken.output).toContain("missing generated-region marker <!-- locus:workflows:end -->");
    expect(broken.output).not.toContain("at markerIndex");
  });

  it("rejects a stale committed catalog artifact", () => {
    const fixture = fixtureRoot();
    const artifact = path.join(fixture, CATALOG_FILE);
    const catalogs = JSON.parse(readFileSync(artifact, "utf8")) as { extensions: unknown[] };
    catalogs.extensions = catalogs.extensions.slice(0, -1);
    writeFileSync(artifact, `${JSON.stringify(catalogs, null, 2)}\n`);

    const stale = runCheck(fixture);
    expect(stale.status).toBe(1);
    expect(stale.output).toContain(CATALOG_FILE);
    expect(stale.output).toContain("npm run build:catalogs");
  });
});
