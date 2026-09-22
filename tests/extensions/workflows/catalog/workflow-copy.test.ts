import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkflowCatalogModel } from "../../../../extensions/workflows/catalog/workflow-catalog.js";
import { copyWorkflowNamespace } from "../../../../extensions/workflows/catalog/workflow-copy.js";
import { resolveWorkflowTarget } from "../../../../extensions/workflows/runtime/workflow-discovery.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow namespace copy", () => {
  it("copies a selected Package child as its complete editable Project namespace", () => {
    const { project } = temporaryEnvironment();
    const model = buildWorkflowCatalogModel(project, project);
    const selected = model.current.find((row) => row.name === "post-code-review/necessity")!;

    const result = copyWorkflowNamespace(selected, "project", project, project);

    expect(result).toMatchObject({ status: "copied", destination: "project", rootName: "post-code-review" });
    const destination = path.join(project, ".locus-pi", "workflows", "post-code-review");
    expect(existsSync(path.join(destination, "post-code-review.workflow.mjs"))).toBe(true);
    expect(existsSync(path.join(destination, "necessity.workflow.mjs"))).toBe(true);
    expect(existsSync(path.join(destination, "README.md"))).toBe(true);
    expect(existsSync(path.join(destination, "post-code-review-pipeline.svg"))).toBe(true);
    expect(resolveWorkflowTarget({ name: "post-code-review" }, project, project).source).toBe("project");
    expect(resolveWorkflowTarget({ name: "post-code-review/necessity" }, project, project).source).toBe("project");
  });

  it.each(["folder", "flat"] as const)("refuses an existing Project %s namespace without changing it", (shape) => {
    const { project } = temporaryEnvironment();
    const selected = buildWorkflowCatalogModel(project, project).current.find((row) => row.name === "live-smoke")!;
    const catalog = path.join(project, ".locus-pi", "workflows");
    mkdirSync(catalog, { recursive: true });
    const conflict =
      shape === "folder" ? path.join(catalog, "live-smoke") : path.join(catalog, "live-smoke.workflow.mjs");
    if (shape === "folder") {
      mkdirSync(conflict);
      writeFileSync(path.join(conflict, "keep.txt"), "keep folder\n", "utf8");
    } else {
      writeFileSync(conflict, "keep flat\n", "utf8");
    }

    const result = copyWorkflowNamespace(selected, "project", project, project);

    expect(result).toMatchObject({ status: "exists", conflictPath: conflict, rootName: "live-smoke" });
    expect(
      shape === "folder" ? readFileSync(path.join(conflict, "keep.txt"), "utf8") : readFileSync(conflict, "utf8"),
    ).toContain(`keep ${shape}`);
  });

  it("copies a group-only Package namespace without inventing a runnable root", () => {
    const { project } = temporaryEnvironment();
    const selected = buildWorkflowCatalogModel(project, project).current.find((row) => row.name === "task/plan")!;

    const result = copyWorkflowNamespace(selected, "project", project, project);

    expect(result).toMatchObject({ status: "copied", destination: "project", rootName: "task" });
    const destination = path.join(project, ".locus-pi", "workflows", "task");
    expect(existsSync(path.join(destination, "task.workflow.mjs"))).toBe(false);
    expect(existsSync(path.join(destination, "draft.workflow.mjs"))).toBe(true);
    expect(existsSync(path.join(destination, "plan.workflow.mjs"))).toBe(true);
    expect(resolveWorkflowTarget({ name: "task/plan" }, project, project).source).toBe("project");
    expect(resolveWorkflowTarget({ name: "task/draft" }, project, project).source).toBe("project");
    expect(() => resolveWorkflowTarget({ name: "task" }, project, project)).toThrow(/group-only/u);
  });

  it("runs the same Package workflow from Package and from its copied User namespace", async () => {
    const { project } = temporaryEnvironment();
    const selected = buildWorkflowCatalogModel(project, project).current.find((row) => row.name === "live-smoke")!;
    const packageTarget = resolveWorkflowTarget({ name: "live-smoke" }, project, project);
    expect(packageTarget.source).toBe("package");

    const result = copyWorkflowNamespace(selected, "personal", project, project);
    expect(result).toMatchObject({ status: "copied", destination: "personal", rootName: "live-smoke" });
    const personalTarget = resolveWorkflowTarget({ name: "live-smoke" }, project, project);
    expect(personalTarget.source).toBe("personal");

    const packageResult = await runLiveSmoke(packageTarget.path, "package");
    const personalResult = await runLiveSmoke(personalTarget.path, "personal");
    expect(packageResult).toEqual({
      topic: "copy proof",
      ok: true,
      notes: {
        first: "package:list cwd entries 1 inspected the directory",
        second: "package:list cwd entries 2 inspected the directory",
      },
    });
    expect(personalResult).toEqual({
      topic: "copy proof",
      ok: true,
      notes: {
        first: "personal:list cwd entries 1 inspected the directory",
        second: "personal:list cwd entries 2 inspected the directory",
      },
    });
  });

  it.each([
    ["project", "personal"],
    ["personal", "project"],
  ] as const)("materializes a confined %s symlink when copying to %s", (source, destination) => {
    const { project, home } = temporaryEnvironment();
    const sourceRoot = source === "project" ? project : home;
    const namespace = path.join(sourceRoot, ".locus-pi", "workflows", "alpha");
    const resource = path.join(namespace, "resources", "alpha-source.mjs");
    mkdirSync(path.dirname(resource), { recursive: true });
    writeFileSync(
      resource,
      'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>"alpha";\n',
      "utf8",
    );
    symlinkSync(resource, path.join(namespace, "alpha.workflow.mjs"));
    const selected = buildWorkflowCatalogModel(project, project).current.find((row) => row.name === "alpha")!;
    expect(selected.source).toBe(source);

    const result = copyWorkflowNamespace(selected, destination, project, project);

    expect(result.status).toBe("copied");
    const destinationRoot = destination === "project" ? project : home;
    const copiedEntry = path.join(destinationRoot, ".locus-pi", "workflows", "alpha", "alpha.workflow.mjs");
    expect(lstatSync(copiedEntry).isFile()).toBe(true);
    expect(lstatSync(copiedEntry).isSymbolicLink()).toBe(false);
    const verificationProject =
      destination === "personal" ? mkdtempSync(path.join(tmpdir(), "workflow-copy-verification-")) : project;
    if (verificationProject !== project) roots.push(verificationProject);
    expect(resolveWorkflowTarget({ name: "alpha" }, verificationProject, verificationProject).source).toBe(destination);
  });

  it("rejects a namespace resource symlink that escapes the namespace", () => {
    const { project, home } = temporaryEnvironment();
    const namespace = path.join(project, ".locus-pi", "workflows", "alpha");
    mkdirSync(path.join(namespace, "resources"), { recursive: true });
    writeFileSync(
      path.join(namespace, "alpha.workflow.mjs"),
      'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>"alpha";\n',
      "utf8",
    );
    const outside = path.join(project, "outside.txt");
    writeFileSync(outside, "private\n", "utf8");
    symlinkSync(outside, path.join(namespace, "resources", "outside.txt"));
    const selected = buildWorkflowCatalogModel(project, project).current.find((row) => row.name === "alpha")!;

    expect(() => copyWorkflowNamespace(selected, "personal", project, project)).toThrow(/escapes its allowed root/u);
    expect(existsSync(path.join(home, ".locus-pi", "workflows", "alpha"))).toBe(false);
  });
});

function temporaryEnvironment(): { project: string; home: string } {
  const project = mkdtempSync(path.join(tmpdir(), "workflow-copy-project-"));
  const home = mkdtempSync(path.join(tmpdir(), "workflow-copy-home-"));
  roots.push(project, home);
  process.env.HOME = home;
  return { project, home };
}

async function runLiveSmoke(sourcePath: string, source: "package" | "personal"): Promise<unknown> {
  const module = (await import(`${pathToFileURL(sourcePath).href}?copy-proof=${source}-${Date.now()}`)) as {
    default: (dsl: unknown, input: string) => Promise<unknown>;
  };
  return module.default(
    {
      phase: () => undefined,
      log: () => undefined,
      agent: async (_prompt: string, options: { label: string }) =>
        `${source}:${options.label} inspected the directory`,
    },
    "copy proof",
  );
}
