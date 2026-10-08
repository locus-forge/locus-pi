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
  for (const file of ["docs/workflows/dsl.md", "skills/locus-pi-workflow-create/references/dsl.md"]) {
    expect(packedFiles, `${file}: version-matched installed DSL`).toContain(file);
    expect(readFileSync(path.join(packageRoot, file), "utf8")).toContain("### invokeWorkflow");
  }
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

    projectRoot,
    packageRoot,
    userHome: temporaryRoot,
  };
  for (const scope of ["project", "user"] as const) {
    const scoped = { ...operation, scope };
    const synced = operateWorkflowSkillHosts({ ...scoped, action: "sync" });
    expect(synced.rows.filter((row) => !row.legacy && row.changed === "created")).toHaveLength(8);
    expect(operateWorkflowSkillHosts({ ...scoped, action: "sync" }).rows.every((row) => row.changed === "none")).toBe(
      true,
    );
  }
  for (const skill of WORKFLOW_SKILL_NAMES) {
    const directEntry = path.join(packageRoot, "skills", skill, "SKILL.md");
    const entrypoints = [
      directEntry,
      ...[projectRoot, temporaryRoot].flatMap((scopeRoot) =>
        [".agents", ".claude"].map((host) => path.join(scopeRoot, host, "skills", skill, "SKILL.md")),
      ),
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
      if (skill === "locus-pi-workflow-create" || skill === "locus-pi-workflow-create-detailed") {
        const link = /\[DSL\/API reference\]\(([^)#]+)(?:#[^)]*)?\)/u.exec(source);
        expect(link, `${skill}: required installed API reference`).not.toBeNull();
        const reference = realpathSync(path.resolve(path.dirname(physicalEntry), link![1]!));
        expect(reference).toBe(
          realpathSync(path.join(packageRoot, "skills/locus-pi-workflow-create/references/dsl.md")),
        );
        const api = readFileSync(reference, "utf8");
        const canonical = readFileSync(path.join(packageRoot, "docs/workflows/dsl.md"), "utf8");
        expect([...api.matchAll(/^### (\w+)$/gmu)].map((match) => match[1])).toEqual(
          [...canonical.matchAll(/^### (\w+)$/gmu)].map((match) => match[1]),
        );
        expect(api).toContain("**Signature:");
        expect(api).toContain("<!-- dsl-example: orchestration-only -->");
      }
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
    ...guide.matchAll(/^\/skill:(locus-pi-workflow-create(?:-detailed)?) (Create an evaluator-optimizer[^\n]+)/gmu),
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

/** Runs through the real Pi resource loader in the existing isolated installed-package subprocess. */
export function installedSkillSelectionScript(packageRoot: string, temporaryRoot: string): string {
  return `
      const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const { mkdirSync, readFileSync, realpathSync } = await import("node:fs");
      const path = await import("node:path");
      const root = realpathSync(${JSON.stringify(packageRoot)});
      const cwd = ${JSON.stringify(path.join(temporaryRoot, "pi-consumer"))};
      mkdirSync(cwd);
      mkdirSync(path.join(cwd, ".git")); // Bound project discovery before the separate managed-host fixtures.
      const names = ${JSON.stringify(WORKFLOW_SKILL_NAMES)};
      const authoringNames = names.filter((name) => name.startsWith("locus-pi-workflow-create"));
      const canonical = realpathSync(path.join(root, "docs/workflows/dsl.md"));
      if (!readFileSync(canonical, "utf8").includes("### invokeWorkflow"))
        throw new Error("Incomplete canonical installed DSL");
      // Omission discovers all four entries; [] disables them. Individual selection preserves sibling references.
      const selections = [undefined, [], ...authoringNames.map((name) => [name]), authoringNames];
      for (const [index, selection] of selections.entries()) {
        const expectedNames = selection ?? names;
        const agentDir = path.join(cwd, String(index));
        mkdirSync(agentDir);
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({
          packages: [{ source: root, extensions: [], ...(selection === undefined ? {} : {
            skills: selection.map((name) => "skills/" + name + "/SKILL.md"),
          }) }],
        }) });
        await loader.reload();
        const { skills, diagnostics } = loader.getSkills();
        if (diagnostics.length) throw new Error("Installed skill diagnostics: " + JSON.stringify(diagnostics));
        if (JSON.stringify(skills.map((skill) => skill.name).sort()) !== JSON.stringify([...expectedNames].sort()))
          throw new Error("Unexpected skill discovery for profile " + index + ": " + JSON.stringify(skills.map((skill) => skill.name)));
        for (const skill of skills) {
          const entry = realpathSync(skill.filePath);
          if (!entry.startsWith(root + path.sep)) throw new Error("Skill escaped the installed package");
          const text = readFileSync(entry, "utf8");
          const manualTarget = text.split("[workflow manual](")[1]?.split(")")[0];
          if (!manualTarget || realpathSync(path.resolve(path.dirname(entry), manualTarget)) !== path.join(root, "docs/workflows/index.md"))
            throw new Error("Skill manual link does not reach the installed package: " + skill.name);
          if (!authoringNames.includes(skill.name)) continue;
          const target = text.split("[DSL/API reference](")[1]?.split(")")[0]?.split("#")[0];
          if (!target) throw new Error("Missing skill API link");
          const apiPath = realpathSync(path.resolve(path.dirname(entry), target));
          if (apiPath !== realpathSync(path.join(root, "skills/locus-pi-workflow-create/references/dsl.md")))
            throw new Error("API reference does not reach the packaged projection: " + skill.name);
          if (!readFileSync(apiPath, "utf8").includes("### invokeWorkflow")) throw new Error("Incomplete API reference");
        }
      }`;
}
