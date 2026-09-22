import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { deadMarkdownLinks } from "../../scripts/markdown-links.js";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

afterEach(async () => {
  while (fixtureRoots.length > 0) await rm(fixtureRoots.pop()!, { recursive: true, force: true });
});

/**
 * The negative half of the `check:links` gate. The positive half is the whole
 * published surface, checked by `npm run check:links` and — against a real pack
 * rather than the allowlist — by `tests/integration/package-boundary.test.ts`;
 * both call the same `deadMarkdownLinks`. What no published document can prove
 * is that a broken link would actually be caught, so that is proved here on
 * temporary files, where a link is allowed to be wrong.
 *
 * Formatting and repository hygiene are not re-proved here. Their own gates
 * carry the negative suites.
 */
describe("published Markdown link gate", () => {
  it("accepts relative links, resolving anchors, external URLs, and fenced examples", async () => {
    const root = await linkFixture();
    expect(deadMarkdownLinks(root, packageSurface)).toEqual([]);
    expect(deadMarkdownLinks(root, repositorySurface)).toEqual([]);
  });

  it("reports a relative link to a file the surface does not publish", async () => {
    const root = await linkFixture({ guideExtras: ["[gone](missing.md)"] });
    expect(deadMarkdownLinks(root, packageSurface)).toEqual([
      "docs/guide.md:9 -> missing.md (docs/missing.md is missing from the repository too)",
    ]);
  });

  it("reports a link that resolves in the repository but outside the narrower surface", async () => {
    const root = await linkFixture({ guideExtras: ["[notes](../NOTES.md)"] });
    expect(deadMarkdownLinks(root, packageSurface)).toEqual([
      "docs/guide.md:9 -> ../NOTES.md (NOTES.md is in the repository but outside the npm package)",
    ]);
    // The same link is honest for a reader who cloned, so the wider surface keeps it.
    expect(deadMarkdownLinks(root, repositorySurface)).toEqual([]);
  });

  it("reports an anchor no heading in the target document defines", async () => {
    const root = await linkFixture({ guideExtras: ["[detail](reference.md#no-such-heading)"] });
    expect(deadMarkdownLinks(root, packageSurface)).toEqual([
      "docs/guide.md:9 -> reference.md#no-such-heading (docs/reference.md defines no anchor #no-such-heading)",
    ]);
  });

  it("reports a same-document anchor no heading defines", async () => {
    const root = await linkFixture({ guideExtras: ["[up](#no-such-section)"] });
    expect(deadMarkdownLinks(root, packageSurface)).toEqual([
      "docs/guide.md:9 -> #no-such-section (this file defines no anchor #no-such-section)",
    ]);
  });

  it("does not accept a heading that only exists inside a fenced example", async () => {
    const root = await linkFixture({ guideExtras: ["[fenced](#fenced-only)"] });
    expect(deadMarkdownLinks(root, packageSurface)).toEqual([
      "docs/guide.md:9 -> #fenced-only (this file defines no anchor #fenced-only)",
    ]);
  });

  it("fails check:links with both findings, and passes on the same tree repaired", async () => {
    const broken = await linkFixture({ guideExtras: ["[gone](missing.md)", "[detail](reference.md#no-such-heading)"] });
    const failure = await runCheckLinks(broken);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("Dead links in the repository:");
    expect(failure.stderr).toContain("docs/guide.md:9 -> missing.md");
    expect(failure.stderr).toContain("docs/guide.md:10 -> reference.md#no-such-heading");

    const repaired = await runCheckLinks(await linkFixture());
    expect(repaired.code).toBe(0);
    expect(repaired.stdout).toContain("Repository Markdown links verified:");
  });
});

const PACKAGE_FILES = ["docs/guide.md", "docs/reference.md"];
const REPOSITORY_FILES = ["NOTES.md"];
const packageSurface = { name: "the npm package", files: new Set([...PACKAGE_FILES, "package.json"]) };
const repositorySurface = {
  name: "the public repository",
  files: new Set([...PACKAGE_FILES, ...REPOSITORY_FILES, "package.json"]),
};

/**
 * A miniature published repository: two packed documents, one repository-only
 * document. The direct parser tests still exercise a narrower package surface.
 * `guideExtras` appends link lines to `docs/guide.md` starting at line 9.
 */
async function linkFixture({ guideExtras = [] }: { guideExtras?: string[] } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "locus-markdown-links-"));
  fixtureRoots.push(root);
  await mkdir(path.join(root, "docs"));

  await writeFile(
    path.join(root, "docs", "guide.md"),
    [
      "# Guide",
      "",
      "[reference](reference.md#known-heading) and [self](#guide) and [away](https://example.test/absent).",
      "",
      "```md",
      "# Fenced only",
      "[dead](nowhere.md)",
      "```",
      ...guideExtras,
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(root, "docs", "reference.md"), "# Reference\n\n## Known heading\n", "utf8");
  await writeFile(path.join(root, "NOTES.md"), "# Notes\n\n[guide](docs/guide.md)\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, files: PACKAGE_FILES }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCheckLinks(cwd: string): Promise<ScriptResult> {
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const script = path.join(process.cwd(), "scripts", "check-markdown-links.ts");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", pathToFileURL(tsx).href, script], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}
