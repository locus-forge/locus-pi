import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { deadMarkdownLinks } from "../../../scripts/markdown-links.js";
import { operateWorkflowSkillHosts, WORKFLOW_SKILL_NAMES } from "../../../extensions/workflows/command/skills.js";

/** Exercise managed discovery from an unpacked real package, outside the source checkout. */
export function verifyInstalledWorkflowDocs(packageRoot: string, temporaryRoot: string, packedFiles: string[]): void {
  expect(deadMarkdownLinks(packageRoot, { name: "the unpacked installation", files: new Set(packedFiles) })).toEqual(
    [],
  );
  const manual = realpathSync(path.join(packageRoot, "docs/workflows/index.md"));
  expect(readFileSync(manual, "utf8")).toContain("## What belongs here");
  expect(WORKFLOW_SKILL_NAMES).toEqual([
    "locus-pi-workflow-create",
    "locus-pi-workflow-create-detailed",
    "locus-pi-workflow-run",
    "external-locus-pi",
  ]);
  const projectRoot = path.join(temporaryRoot, "consumer-project");
  mkdirSync(projectRoot, { recursive: true });
  const operation = {
    host: "all" as const,
    scope: "project" as const,
    projectRoot,
    packageRoot,
    userHome: temporaryRoot,
  };
  const synced = operateWorkflowSkillHosts({ ...operation, action: "sync" });
  expect(synced.rows.filter((row) => !row.legacy && row.changed === "created")).toHaveLength(8);
  expect(operateWorkflowSkillHosts({ ...operation, action: "sync" }).rows.every((row) => row.changed === "none")).toBe(
    true,
  );
  for (const skill of WORKFLOW_SKILL_NAMES) {
    const directEntry = path.join(packageRoot, "skills", skill, "SKILL.md");
    const entrypoints = [
      directEntry,
      ...[".agents", ".claude"].map((host) => path.join(projectRoot, host, "skills", skill, "SKILL.md")),
    ];
    for (const entry of entrypoints) {
      const physicalEntry = realpathSync(entry);
      expect(physicalEntry).toBe(realpathSync(directEntry));
      if (entry !== directEntry)
        expect(existsSync(path.resolve(path.dirname(entry), "../../docs/workflows/index.md"))).toBe(false);
      const source = readFileSync(physicalEntry, "utf8");
      expect(source).toContain("Resolve this `SKILL.md` to its physical file");
      const manualLink = /\[workflow manual\]\(([^)]+)\)/u.exec(source);
      expect(manualLink, `${skill} has no discovery link`).not.toBeNull();
      expect(realpathSync(path.resolve(path.dirname(physicalEntry), manualLink![1]!))).toBe(manual);
      // Resolve every sibling/manual/example link from the physical installed skill, not the host alias or cwd.
      for (const target of source.matchAll(/\]\(([^)\s]+)\)/gu)) {
        const relativeFile = target[1]!.split("#")[0]!;
        if (!relativeFile || relativeFile.includes("://")) continue;
        const file = realpathSync(path.resolve(path.dirname(physicalEntry), relativeFile));
        expect(file.startsWith(`${realpathSync(packageRoot)}${path.sep}`), `${entry} -> ${target[1]}`).toBe(true);
        expect(packedFiles).toContain(path.relative(realpathSync(packageRoot), file).split(path.sep).join("/"));
      }
    }
  }
  const guide = readFileSync(path.join(packageRoot, "docs/workflows/create.md"), "utf8");
  const invocations = [
    ...guide.matchAll(/^\/skill:(locus-pi-workflow-create(?:-detailed)?) (Create a project-tour[^\n]+)/gmu),
  ];
  expect(invocations.map((match) => match[1])).toEqual([
    "locus-pi-workflow-create",
    "locus-pi-workflow-create-detailed",
  ]);
  expect(invocations[0]![2]).toBe(invocations[1]![2]);
  expect(readFileSync(path.join(packageRoot, "README.md"), "utf8")).toContain(
    "docs/workflows/create.md#choose-an-authoring-route",
  );
}
