import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, type PackageSource, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { operateWorkflowSkillHosts } from "../../../extensions/workflows/command/skills.js";
import { readExtensionManifest } from "../helpers/package-contract.js";

const packageRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  pi: { extensions: string[]; skills: string[] };
};
const extensionIds = packageJson.pi.extensions.map((entrypoint) => {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/u.exec(entrypoint);
  if (!match?.[1]) throw new Error(`Invalid package extension entrypoint: ${entrypoint}`);
  return match[1];
});
const bundledSkillNames = uniqueSorted(
  packageJson.pi.skills.flatMap((skillsRoot) => {
    const directory = path.resolve(packageRoot, skillsRoot);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(directory, entry.name, "SKILL.md")))
      .map((entry) => entry.name);
  }),
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe(`selective package loading through installed Pi ${VERSION}`, () => {
  it.each([
    ["workflows-only", ["workflows"]],
    ["agents-only", ["agents"]],
    ["status-line-only", ["status-line"]],
  ] as const)("loads only the requested entrypoints for %s", async (_profile, selectedIds) => {
    const result = await loadProfile([...selectedIds]);
    expect(result.extensionIds).toEqual([...selectedIds].sort());
    expect(result.tools).toEqual(expectedSurfaces([...selectedIds], "tools"));
    expect(result.commands).toEqual(expectedSurfaces([...selectedIds], "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces([...selectedIds], "hooks"));
    expect(result.packageSkills).toEqual([]);
  });

  it("loads every declared surface when every entrypoint is selected", async () => {
    const result = await loadProfile(extensionIds);
    expect(result.extensionIds).toEqual([...extensionIds].sort());
    expect(result.tools).toEqual(expectedSurfaces(extensionIds, "tools"));
    expect(result.commands).toEqual(expectedSurfaces(extensionIds, "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces(extensionIds, "hooks"));
  });

  it("keeps bundled skills available when the package filter omits the skills key", async () => {
    const result = await loadProfile(["workflows"], { includeSkills: true });
    expect(result.extensionIds).toEqual(["workflows"]);
    expect(result.packageSkills).toEqual(bundledSkillNames);
  });

  it("deduplicates Codex project links to the exact packaged skill trees without a collision", async () => {
    const result = await loadProfile(["workflows"], { includeSkills: true, syncProjectSkills: true });
    expect(result.workflowSkillNames).toEqual(bundledSkillNames);
    expect(result.workflowSkillDiagnostics).toEqual([]);
  });
  // Every case reloads the real Pi host off disk. That is fast in isolation and
  // slow whenever the machine is already busy, so the suite states its own
  // budget instead of inheriting the 5s default.
}, 30_000);

interface ProfileOptions {
  /** Leave the package filter's `skills` key out, so Pi resolves the bundled skill trees. */
  includeSkills?: boolean;
  syncProjectSkills?: boolean;
}

async function loadProfile(selectedIds: string[], options: ProfileOptions = {}) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-host-contract-"));
  temporaryRoots.push(temporaryRoot);
  const agentDir = path.join(temporaryRoot, "agent");
  const cwd = path.join(temporaryRoot, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (options.syncProjectSkills) {
    operateWorkflowSkillHosts({
      action: "sync",
      host: "codex",
      scope: "project",
      projectRoot: cwd,
      packageRoot,
      userHome: temporaryRoot,
    });
  }

  const source: PackageSource = {
    source: packageRoot,
    extensions: selectedIds.map((id) => `extensions/${id}/index.ts`),
    ...(options.includeSkills ? {} : { skills: [] }),
  };
  const settingsManager = SettingsManager.inMemory({ packages: [source] });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

  const loaded = await inIsolatedProcessState(temporaryRoot, cwd, async () => {
    await loader.reload(options.syncProjectSkills ? { resolveProjectTrust: async () => true } : undefined);
    return loader.getExtensions();
  });
  const loadedSkills = loader.getSkills();
  expect(loaded.errors, `Pi ${VERSION} extension load errors`).toEqual([]);

  return {
    extensionIds: loaded.extensions.map((extension) => path.basename(path.dirname(extension.path))).sort(),
    tools: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])),
    commands: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.commands.keys()])),
    hooks: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.handlers.keys()])),
    packageSkills: uniqueSorted(
      loadedSkills.skills
        .filter((skill) => skill.sourceInfo.origin === "package" && skill.sourceInfo.source === packageRoot)
        .map((skill) => skill.name),
    ),
    workflowSkillNames: loadedSkills.skills
      .map((skill) => skill.name)
      .filter((name) => bundledSkillNames.includes(name))
      .sort(),
    workflowSkillDiagnostics: loadedSkills.diagnostics.filter((diagnostic) =>
      bundledSkillNames.some((name) => JSON.stringify(diagnostic).includes(name)),
    ),
  };
}

/**
 * Run one host load with every piece of process state it reads under this test's control, and
 * hand it all back afterwards. `DefaultResourceLoader` takes an explicit `cwd` and `agentDir`,
 * but three inputs still reach past them into the developer's own machine:
 *
 *   HOME / XDG_CONFIG_HOME — Pi discovers user-scope skills and settings from the home
 *     directory. A machine that has this package's own workflow skills installed under
 *     `~/.agents/skills/` shadows and collides with the packaged trees, which fails the two
 *     skill cases for a reason that has nothing to do with the package.
 */
async function inIsolatedProcessState<T>(home: string, cwd: string, body: () => Promise<T>): Promise<T> {
  const names = ["HOME", "XDG_CONFIG_HOME"] as const;
  const previousEnv = names.map((name) => [name, process.env[name]] as const);
  const previousCwd = process.cwd();
  process.env["HOME"] = home;
  process.env["XDG_CONFIG_HOME"] = path.join(home, "config");
  process.chdir(cwd);
  try {
    return await body();
  } finally {
    process.chdir(previousCwd);
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectedSurfaces(selectedIds: string[], key: "tools" | "commands" | "hooks", topLevel = false): string[] {
  const values = selectedIds.flatMap((id) => readExtensionManifest(id, packageRoot).provides[key]);
  return uniqueSorted(topLevel ? values.map((value) => value.trim().split(/\s+/u)[0]!).filter(Boolean) : values);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
