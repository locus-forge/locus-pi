import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { deadMarkdownLinks } from "../../../scripts/markdown-links.js";

/** Exercise the documented discovery route in an unpacked package, outside the source checkout. */
export function verifyInstalledWorkflowDocs(packageRoot: string, temporaryRoot: string, packedFiles: string[]): void {
  expect(deadMarkdownLinks(packageRoot, { name: "the unpacked installation", files: new Set(packedFiles) })).toEqual(
    [],
  );
  const manual = realpathSync(path.join(packageRoot, "docs/workflows/index.md"));
  expect(readFileSync(manual, "utf8")).toContain("## What belongs here");
  for (const skill of ["locus-pi-workflow-create", "locus-pi-workflow-run", "external-locus-pi"]) {
    const skillDirectory = path.join(packageRoot, "skills", skill);
    const directEntry = path.join(skillDirectory, "SKILL.md");
    const entrypoints = [directEntry];
    for (const host of [".agents", ".claude"]) {
      const hostRoot = path.join(temporaryRoot, "consumer-project", host, "skills");
      mkdirSync(hostRoot, { recursive: true });
      const link = path.join(hostRoot, skill);
      symlinkSync(skillDirectory, link, "dir");
      const entry = path.join(link, "SKILL.md");
      expect(existsSync(path.resolve(path.dirname(entry), "../../docs/workflows/index.md"))).toBe(false);
      entrypoints.push(entry);
    }
    for (const entry of entrypoints) {
      const physicalEntry = realpathSync(entry);
      const source = readFileSync(physicalEntry, "utf8");
      expect(source).toContain("Resolve this `SKILL.md` to its physical file");
      const link = /\[workflow manual\]\(([^)]+)\)/u.exec(source);
      expect(link, `${skill} has no discovery link`).not.toBeNull();
      expect(realpathSync(path.resolve(path.dirname(physicalEntry), link![1]!))).toBe(manual);
      // Every linked topic and heading resolves against the package the reader received.
      for (const target of source.matchAll(/\]\(([^)\s]*docs\/workflows\/[^)\s]+)\)/gu)) {
        const relativeFile = target[1]!.split("#")[0]!;
        const file = path.resolve(path.dirname(physicalEntry), relativeFile);
        expect(existsSync(file), `${entry} -> ${target[1]}`).toBe(true);
        expect(file.startsWith(`${realpathSync(packageRoot)}${path.sep}`)).toBe(true);
      }
    }
  }
}
