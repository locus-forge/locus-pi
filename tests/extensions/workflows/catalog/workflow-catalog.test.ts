import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderOperatorBlock, renderOperatorBlockPlain } from "../../../../extensions/_shared/operator/operator-ui.js";
import { parseRunCommand, workflowRunUsage } from "../../../../extensions/workflows/command/command-parser.js";
import { workflowArgumentCompletions } from "../../../../extensions/workflows/launch/command-completions.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogBlock,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
  safeRecentWorkflowLabel,
  type WorkflowBrowserIntent,
} from "../../../../extensions/workflows/catalog/workflow-catalog.js";
import { readWorkflowMetaDescription } from "../../../../extensions/workflows/catalog/workflow-meta.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  packagedWorkflowNames,
  packagedWorkflowPath,
  listWorkflowCatalogTargets,
  resolveWorkflowTarget,
  WorkflowGroupOnlyError,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { isPostCodeReviewTargetIdentity } from "../../../../extensions/workflows/runtime/workflow-saved-name.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { preflightWorkflowCommandTarget } from "../../../../extensions/workflows/launch/launch-guard.js";
import {
  workflowJournalFile,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness } from "../../../test-harness.js";

describe("workflow operator catalog", () => {
  it("supports group-only namespaces without synthesizing a runnable root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-group-only-"));
    const previousHome = process.env.HOME;
    try {
      const namespace = path.join(root, ".locus-pi", "workflows", "airflow-dag-builder");
      mkdirSync(namespace, { recursive: true });
      writeFileSync(path.join(namespace, "plan.workflow.mjs"), 'export default () => "plan";\n', "utf8");
      writeFileSync(path.join(namespace, "implement.workflow.mjs"), 'export default () => "implement";\n', "utf8");

      const names = listWorkflowCatalogTargets(root, root).map((target) => target.ref);
      expect(names).toContain("airflow-dag-builder/plan");
      expect(names).toContain("airflow-dag-builder/implement");
      expect(names).not.toContain("airflow-dag-builder");
      expect(resolveWorkflowTarget({ name: "airflow-dag-builder/plan" }, root, root)).toMatchObject({
        source: "project",
        ref: "airflow-dag-builder/plan",
      });
      expect(() => resolveWorkflowTarget({ name: "airflow-dag-builder" }, root, root)).toThrow(WorkflowGroupOnlyError);
      expect(preflightWorkflowCommandTarget("airflow-dag-builder", root, root)).toMatchObject({
        status: "group-only",
        workflowName: "airflow-dag-builder",
      });

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.groups).toContainEqual(
        expect.objectContaining({
          name: "airflow-dag-builder",
          children: ["airflow-dag-builder/implement", "airflow-dag-builder/plan"],
        }),
      );
      const groupList = renderOperatorBlockPlain(buildWorkflowCatalogBlock(root, root, "airflow-dag-builder"), 120, {
        maxLines: 20,
      }).join("\n");
      expect(groupList).toContain("airflow-dag-builder");
      expect(groupList).toContain("group-only (not runnable)");
      expect(groupList.match(/group-only \(not runnable\)/gu)).toHaveLength(1);
      expect(groupList.match(/airflow-dag-builder\/plan/gu)).toHaveLength(1);
      expect(buildWorkflowCatalogModel(root, root, "airflow-dag-builder").current.map((row) => row.name)).toEqual([
        "airflow-dag-builder/implement",
        "airflow-dag-builder/plan",
      ]);
      expect(model.current.filter((row) => row.source === "project").map((row) => row.name)).toEqual([
        "airflow-dag-builder/implement",
        "airflow-dag-builder/plan",
      ]);
      expect(buildWorkflowInfoBlock(root, root, "airflow-dag-builder").primary).toMatch(/group-only/u);

      writeFileSync(path.join(namespace, "airflow-dag-builder.workflow.mjs"), 'export default () => "root";\n', "utf8");
      expect(resolveWorkflowTarget({ name: "airflow-dag-builder" }, root, root)).toMatchObject({
        ref: "airflow-dag-builder",
        source: "project",
      });
      expect(buildWorkflowCatalogModel(root, root).groups.map((group) => group.name)).toEqual(["task"]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps group-only ownership atomic across lower sources", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-group-owner-"));
    const home = mkdtempSync(path.join(tmpdir(), "wf-catalog-group-home-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const projectNamespace = path.join(root, ".locus-pi", "workflows", "atomic-group");
      const personalNamespace = path.join(home, ".locus-pi", "workflows", "atomic-group");
      mkdirSync(projectNamespace, { recursive: true });
      mkdirSync(personalNamespace, { recursive: true });
      writeFileSync(path.join(projectNamespace, "plan.workflow.mjs"), 'export default () => "project";\n', "utf8");
      writeFileSync(
        path.join(personalNamespace, "implement.workflow.mjs"),
        'export default () => "personal";\n',
        "utf8",
      );

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.current.filter((row) => row.source === "project").map((row) => row.name)).toEqual([
        "atomic-group/plan",
      ]);
      expect(() => resolveWorkflowTarget({ name: "atomic-group/implement" }, root, root)).toThrow(/does not exist/u);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["an external file symlink", "file"],
    ["an external ancestor symlink", "ancestor"],
  ])("does not advertise or fall through a project entry behind %s", (_label, shape) => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-confinement-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-catalog-confinement-outside-"));
    const home = path.join(root, "home");
    const name = "collision";
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const personalDir = path.join(home, ".locus-pi", "workflows");
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(path.join(personalDir, `${name}.workflow.mjs`), 'export default () => "personal";\n', "utf8");

      const externalWorkflowDir = path.join(outside, ".locus-pi", "workflows");
      mkdirSync(externalWorkflowDir, { recursive: true });
      const externalFile = path.join(externalWorkflowDir, `${name}.workflow.mjs`);
      writeFileSync(externalFile, 'export const meta = { description: "outside" };\n', "utf8");
      const projectWorkflowDir = path.join(root, ".locus-pi", "workflows");
      if (shape === "file") {
        mkdirSync(path.dirname(projectWorkflowDir), { recursive: true });
        mkdirSync(projectWorkflowDir, { recursive: true });
        symlinkSync(externalFile, path.join(projectWorkflowDir, `${name}.workflow.mjs`));
      } else {
        symlinkSync(path.join(outside, ".locus-pi"), path.join(root, ".locus-pi"), "dir");
      }

      if (shape === "ancestor") {
        expect(() => buildWorkflowCatalogModel(root, root)).toThrow(/escapes project root through a symlink/u);
        expect(workflowArgumentCompletions("run c", root, root)).toEqual([]);
      } else {
        const model = buildWorkflowCatalogModel(root, root);
        expect(model.current.some((row) => row.name === name)).toBe(false);
        expect(workflowArgumentCompletions("run c", root, root)?.map((completion) => completion.value)).not.toContain(
          "run collision",
        );
      }
      expect(() => resolveWorkflowTarget({ name }, root, root)).toThrow(/escapes project root through a symlink/u);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not let an external project symlink fall through to the packaged workflow", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-package-confinement-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-catalog-package-outside-"));
    try {
      const projectWorkflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(projectWorkflowDir, { recursive: true });
      const externalFile = path.join(outside, "plan.workflow.mjs");
      writeFileSync(externalFile, 'export const meta = { description: "outside" };\n', "utf8");
      symlinkSync(externalFile, path.join(projectWorkflowDir, "plan.workflow.mjs"));

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.current.some((row) => row.name === "plan")).toBe(false);
      expect(workflowArgumentCompletions("run p", root, root)?.map((completion) => completion.value)).not.toContain(
        "run plan",
      );
      expect(() => resolveWorkflowTarget({ name: "plan" }, root, root)).toThrow(
        /escapes project root through a symlink/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks a directory-shaped project entry across resolver, catalog, info, completion, and launch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-directory-collision-"));
    try {
      mkdirSync(path.join(root, ".locus-pi", "workflows", "plan.workflow.mjs"), { recursive: true });

      expect(buildWorkflowCatalogModel(root, root).current.some((row) => row.name === "plan")).toBe(false);
      expect(workflowArgumentCompletions("run p", root, root)?.map((completion) => completion.value)).not.toContain(
        "run plan",
      );
      expect(buildWorkflowInfoBlock(root, root, "plan")).toMatchObject({
        primary: 'Unknown current workflow: "plan".',
      });
      expect(() => resolveWorkflowTarget({ name: "plan" }, root, root)).toThrow(/not a regular file/u);

      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "plan",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a regular file/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks an invalid higher-precedence search directory consistently", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-invalid-search-dir-"));
    try {
      mkdirSync(path.join(root, ".locus-pi"), { recursive: true });
      writeFileSync(path.join(root, ".locus-pi", "workflows"), "not a directory\n", "utf8");

      expect(() => buildWorkflowCatalogModel(root, root)).toThrow(/not a directory/u);
      expect(workflowArgumentCompletions("run c", root, root)).toEqual([]);
      expect(() => buildWorkflowInfoBlock(root, root, "collision")).toThrow(/not a directory/u);
      expect(() => resolveWorkflowTarget({ name: "collision" }, root, root)).toThrow(/not a directory/u);

      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "collision",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a directory/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports an internally confined project search-directory symlink consistently", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-internal-search-dir-"));
    try {
      const actual = path.join(root, "workflow-sources");
      mkdirSync(actual, { recursive: true });
      writeFileSync(path.join(actual, "inside.workflow.mjs"), 'export default () => "inside";\n', "utf8");
      mkdirSync(path.join(root, ".locus-pi"), { recursive: true });
      symlinkSync(actual, path.join(root, ".locus-pi", "workflows"), "dir");

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.current.find((row) => row.name === "inside")).toMatchObject({
        source: "project",
        target: { path: path.join(root, ".locus-pi", "workflows", "inside.workflow.mjs") },
      });
      expect(resolveWorkflowTarget({ name: "inside" }, root, root)).toMatchObject({
        source: "project",
        path: path.join(root, ".locus-pi", "workflows", "inside.workflow.mjs"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks the same invalid lower-precedence directory for an existing higher source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-lower-invalid-dir-"));
    try {
      const workingDirectory = path.join(root, "nested");
      const higher = path.join(workingDirectory, ".locus-pi", "workflows", "inside.workflow.mjs");
      mkdirSync(path.dirname(higher), { recursive: true });
      writeFileSync(higher, 'export default () => "higher";\n', "utf8");
      mkdirSync(path.join(root, ".locus-pi"), { recursive: true });
      writeFileSync(path.join(root, ".locus-pi", "workflows"), "not a directory\n", "utf8");

      expect(() => resolveWorkflowTarget({ name: "inside" }, root, workingDirectory)).toThrow(/not a directory/u);
      expect(() => listWorkflowCatalogTargets(root, workingDirectory)).toThrow(/not a directory/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a personal post-code-review name outside the project owner policy", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-owner-source-"));
    const home = mkdtempSync(path.join(tmpdir(), "wf-catalog-owner-home-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const personalDir = path.join(home, ".locus-pi", "workflows");
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(
        path.join(personalDir, "post-code-review.workflow.mjs"),
        'export default () => "personal";\n',
        "utf8",
      );

      const target = resolveWorkflowTarget({ name: "post-code-review" }, root, root);
      expect(target.source).toBe("personal");
      expect(isPostCodeReviewTargetIdentity(target)).toBe(false);
      expect(isPostCodeReviewTargetIdentity({ kind: "name", ref: "post-code-review", source: "package" })).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not let an external personal leaf symlink fall through to Package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-personal-confinement-"));
    const home = mkdtempSync(path.join(tmpdir(), "wf-catalog-personal-home-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-catalog-personal-outside-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const personalDir = path.join(home, ".locus-pi", "workflows");
      mkdirSync(personalDir, { recursive: true });
      const external = path.join(outside, "live-smoke.workflow.mjs");
      writeFileSync(external, "export default () => 'outside';\n", "utf8");
      symlinkSync(external, path.join(personalDir, "live-smoke.workflow.mjs"));

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.current.some((row) => row.name === "live-smoke")).toBe(false);
      expect(() => resolveWorkflowTarget({ name: "live-smoke" }, root, root)).toThrow(
        /personal workflow root|symlink/u,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps every curated Package workflow description concise and purpose-first", () => {
    const descriptions = packagedWorkflowNames().map((name) => ({
      name,
      description: readWorkflowMetaDescription(packagedWorkflowPath(name)),
    }));

    // Folder names sort top-level workflows; each root precedes its children.
    expect(descriptions.map(({ name }) => name)).toEqual([
      "live-smoke",
      "post-code-review",
      "post-code-review/boundaries",
      "post-code-review/contracts",
      "post-code-review/necessity",
      "post-code-review/scope",
      "post-code-review/simplicity",
      "post-code-review/style",
      "post-code-review/synthesis",
      "stage-loop",
      "task/draft",
      "task/plan",
    ]);
    for (const { name, description } of descriptions) {
      expect(description, name).not.toMatch(/description unavailable|no description/u);
      expect(description.length, name).toBeLessThanOrEqual(96);
      expect(description, name).not.toMatch(/result\.json|journal\.ndjson|verifiable|live proof|->/iu);
      expect(description, name).toMatch(/\.$/u);
    }
  });

  it("exposes exactly the curated Package registry through the catalog model", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-curated-"));
    try {
      const model = buildWorkflowCatalogModel(root, root);
      const packageNames = model.current.filter((row) => row.source === "package").map((row) => row.name);

      // Package rows are ordered as top-level folders with root before children.
      expect(packageNames).toEqual([
        "live-smoke",
        "post-code-review",
        "post-code-review/boundaries",
        "post-code-review/contracts",
        "post-code-review/necessity",
        "post-code-review/scope",
        "post-code-review/simplicity",
        "post-code-review/style",
        "post-code-review/synthesis",
        "stage-loop",
        "task/draft",
        "task/plan",
      ]);
      expect(packageNames).not.toContain("plan-build-review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes the complete post-code-review composition in every catalog identity surface", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-bundle-"));
    try {
      const model = buildWorkflowCatalogModel(root, root);
      const packageRows = model.current.filter((row) => row.source === "package");
      const bundleNames = [
        "post-code-review",
        "post-code-review/boundaries",
        "post-code-review/contracts",
        "post-code-review/necessity",
        "post-code-review/scope",
        "post-code-review/simplicity",
        "post-code-review/style",
        "post-code-review/synthesis",
      ];
      expect(packageRows.filter((row) => bundleNames.includes(row.name)).map((row) => row.name)).toEqual(
        expect.arrayContaining(bundleNames),
      );
      expect(model.current.find((row) => row.name === "post-code-review")).toMatchObject({
        role: "root",
        children: bundleNames.slice(1),
      });
      const parentRpc = renderOperatorBlockPlain(buildWorkflowInfoBlock(root, root, "post-code-review"), 80, {
        maxLines: 10,
      }).join("\n");
      expect(parentRpc).toContain("Composition: root");
      expect(parentRpc).toContain("7 child workflow");
      for (const name of bundleNames.slice(1)) {
        expect(model.current.find((row) => row.name === name)).toMatchObject({
          role: "child",
          rootName: "post-code-review",
        });
        const info = buildWorkflowInfoBlock(root, root, name);
        expect(info.body?.join("\\n")).toContain(`target: name:${name}`);
        expect(renderOperatorBlockPlain(info, 80, { maxLines: 10 }).join("\n")).toContain(
          "Composition: child of post-code-review",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects one whole namespace without mixing lower-source children", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-incomplete-bundle-"));
    const previousHome = process.env.HOME;
    try {
      const projectDir = path.join(root, ".locus-pi", "workflows");
      const home = path.join(root, "home");
      const personalDir = path.join(home, ".locus-pi", "workflows");
      process.env.HOME = home;
      const projectNamespace = path.join(projectDir, "post-code-review");
      mkdirSync(projectNamespace, { recursive: true });
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(path.join(projectNamespace, "post-code-review.workflow.mjs"), 'export default () => "root";\n');
      writeFileSync(path.join(projectNamespace, "scope.workflow.mjs"), 'export default () => "project";\n');

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.current.find((row) => row.name === "post-code-review")?.source).toBe("project");
      expect(model.current.find((row) => row.name === "post-code-review/scope")?.source).toBe("project");
      expect(model.current.find((row) => row.name === "post-code-review/contracts")).toBeUndefined();
      expect(() => resolveWorkflowTarget({ name: "post-code-review/contracts" }, root, root)).toThrow(
        /does not exist/u,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads only a static description on the exported top-level meta literal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-meta-"));
    const file = path.join(root, "safe.workflow.mjs");
    try {
      writeFileSync(
        file,
        [
          '// description: "comment decoy"',
          'const unrelated = { description: "unrelated decoy" };',
          'export const metadata = { description: "wrong export" };',
          'export const meta = { nested: { description: "nested decoy" }, "description": "right\\nvalue" };',
          'throw new Error("must not execute");',
        ].join("\n"),
        "utf8",
      );

      expect(readWorkflowMetaDescription(file)).toBe("right value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects computed metadata and template interpolation instead of guessing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-meta-dynamic-"));
    try {
      const computed = path.join(root, "computed.workflow.mjs");
      writeFileSync(computed, 'export const meta = makeMeta({ description: "wrong" });\n', "utf8");
      expect(readWorkflowMetaDescription(computed)).toBe("no description");

      const interpolated = path.join(root, "interpolated.workflow.mjs");
      writeFileSync(interpolated, 'const x = "secret"; export const meta = { description: `hello ${x}` };\n', "utf8");
      expect(readWorkflowMetaDescription(interpolated)).toBe("no description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps metadata scanning bounded", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-meta-bounded-"));
    const file = path.join(root, "late.workflow.mjs");
    try {
      writeFileSync(file, `${" ".repeat(70 * 1024)}export const meta = { description: "too late" };\n`, "utf8");
      expect(readWorkflowMetaDescription(file)).toBe("no description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects persisted path targets without absolute-path disclosure", () => {
    const projectRoot = "/workspace/project";
    expect(
      safeRecentWorkflowLabel(
        { kind: "scriptPath", ref: "/workspace/project/.locus-pi/workflows/safe.workflow.mjs" },
        projectRoot,
      ),
    ).toBe(".locus-pi/workflows/safe.workflow.mjs");
    expect(
      safeRecentWorkflowLabel({ kind: "scriptPath", ref: "/var/folders/private/secret.workflow.mjs" }, projectRoot),
    ).toBe("secret.workflow.mjs");
    expect(
      safeRecentWorkflowLabel({ kind: "scriptPath", ref: "C:\\Users\\name\\secret.workflow.mjs" }, projectRoot),
    ).toBe("secret.workflow.mjs");
  });

  it("filters by description and returns a typed no-match state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-filter-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        'export const meta = { description: "Handles invoices" }; export default () => null;\n',
        "utf8",
      );
      writeFileSync(
        path.join(workflowDir, "beta.workflow.mjs"),
        'export const meta = { description: "Reviews releases" }; export default () => null;\n',
        "utf8",
      );

      const filtered = buildWorkflowCatalogBlock(root, root, "invoices");
      const filteredText = filtered.body?.join("\n") ?? "";
      expect(filtered.primary).toBe('Matches for "invoices".');
      expect(filteredText).toContain("alpha · [P] · Handles invoices");
      expect(filteredText).not.toContain("beta · [P]");
      expect(filteredText).toContain("[R] Run history:\n  (no recent matches)");
      expect(filteredText).toContain("[U] User:\n  (no matches)");

      const noMatch = buildWorkflowCatalogBlock(root, root, "definitely-no-match");
      expect(noMatch).toMatchObject({
        type: "VIEW",
        primary: 'No workflows match "definitely-no-match".',
        metadata: ["Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history"],
        controls: ["Try: /workflows list <query>"],
      });
      expect(noMatch.body?.[0]).toMatch(/^Catalog contains \d+ top-level workflow\(s\) · \d+ child workflow\(s\);/u);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves historical personal source under a current project shadow", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-history-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "same.workflow.mjs"),
        'export const meta = { description: "current project" }; export default () => null;\n',
        "utf8",
      );
      writeRun(root, "20260101-000002-personal", {
        kind: "name",
        ref: "same",
        source: "personal",
      });
      writeRun(root, "20260101-000001-path", {
        kind: "scriptPath",
        ref: "/var/folders/private/secret.workflow.mjs",
        source: "project",
      });

      const block = buildWorkflowCatalogBlock(root, root);
      const text = block.body?.join("\n") ?? "";
      const recent = text.slice(text.indexOf("[R] Run history:"), text.indexOf("[P] Project:"));
      expect(block).toMatchObject({
        type: "VIEW",
        subject: "Workflow catalog",
        metadata: ["Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history"],
      });
      expect(block.controls).toContain(`Run: ${workflowRunUsage()}`);
      expect(recent).toContain("same · run 20260101-000002-personal · [U] · historical run snapshot");
      expect(recent).toContain("secret.workflow.mjs · run 20260101-000001-path · [P] · historical run snapshot");
      expect(recent).not.toContain("same · run 20260101-000002-personal · [P]");
      expect(text).not.toContain("/var/folders/private");
      expect(text).toContain("same · [P] · current project");
      const catalogRows = block.body?.filter((line) => line.startsWith("  ") && !line.startsWith("  (")) ?? [];
      expect(catalogRows.every((line) => !/\b(?:Project|User|Package)\b/u.test(line))).toBe(true);

      const compactBlock = buildWorkflowCatalogBlock(root, root, undefined, { compact: true });
      expect(compactBlock.controls).toEqual([`Run: ${workflowRunUsage()} · Filter: /workflows list <query>`]);
      expect(compactBlock.metadata).toContain(
        "Display order: Project → User → Package (does not change first-wins resolution)",
      );
      const compactRows = compactBlock.body ?? [];
      expect(compactRows).toContainEqual(expect.stringMatching(/^\+\d+ hidden workflow row\(s\);/u));
      const rpcCatalog = renderOperatorBlockPlain(compactBlock, 80, { maxLines: 10 }).join("\n");
      const compactModel = buildWorkflowCatalogModel(root, root);
      expect(rpcCatalog).toContain(
        `${compactModel.totalRoots} top-level workflow(s) · ${compactModel.totalChildren} child workflow(s)`,
      );
      expect(rpcCatalog).toMatch(/details\s+may\s+be\s+omitted\s+by\s+host\s+line\s+budget/u);
      expect(rpcCatalog).not.toContain("other workflow row(s)");
      expect(compactRows).toEqual(
        expect.arrayContaining([
          expect.stringContaining("same · run 20260101-000002-personal · [U] · historical run snapshot"),
          expect.stringContaining("same · [P] · current project"),
        ]),
      );
      expect(compactRows.every((line) => !/\b(?:Project|User|Package)\b/u.test(line))).toBe(true);
      expect(text.indexOf("[R] Run history:")).toBeLessThan(text.indexOf("[P] Project:"));
      expect(text.indexOf("[P] Project:")).toBeLessThan(text.indexOf("[U] User:"));
      expect(text.indexOf("[U] User:")).toBeLessThan(text.indexOf("[PKG] Package:"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps repeated runs as distinct run-specific history rows with exact snapshot paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-repeated-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      writeRun(root, "20260101-000002-alpha", { kind: "name", ref: "alpha", source: "project" });
      writeRun(root, "20260101-000001-alpha", { kind: "name", ref: "alpha", source: "project" });

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.history.map((row) => row.runId)).toEqual(["20260101-000002-alpha", "20260101-000001-alpha"]);
      expect(model.history.every((row) => row.snapshot.kind === "ready")).toBe(true);
      expect(model.history.every((row) => row.originPath.includes(row.runId))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the executed snapshot description after current metadata changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-history-description-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeRun(
        root,
        "20260101-000001-alpha",
        { kind: "name", ref: "alpha", source: "project" },
        'export const meta = { description: "Executed description" };\nexport default () => null;\n',
      );
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        'export const meta = { description: "Changed current description" };\n',
      );

      const model = buildWorkflowCatalogModel(root, root);

      expect(model.current.find((row) => row.name === "alpha")?.description).toBe("Changed current description");
      expect(model.history[0]?.description).toBe("Executed description");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips an interior-whitespace catalog Start command without an input tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-start-name-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "alpha workflow.workflow.mjs"),
        'export const meta = { description: "Quoted alpha" };\n',
      );
      const spaced = buildWorkflowCatalogModel(root, root).current.find((row) => row.name === "alpha workflow")!;

      const start = buildWorkflowActionPrompt({
        action: "start",
        row: spaced,
        sourceState: { kind: "ready", row: spaced, path: spaced.target.path, source: "source" },
      });

      expect(start).toBe('/workflows run "alpha workflow"');
      expect(parseRunCommand(start.slice("/workflows ".length))).toEqual({ scriptRef: "alpha workflow" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefills post-code-review Start with its generated workspace default", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-post-review-start-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(path.join(workflowDir, "post-code-review.workflow.mjs"), "export default () => null;\n");
      const row = buildWorkflowCatalogModel(root, root).current.find(
        (candidate) => candidate.name === "post-code-review",
      )!;
      const start = buildWorkflowActionPrompt({
        action: "start",
        row,
        sourceState: { kind: "ready", row, path: row.target.path, source: "source" },
      });

      expect(start).toBe("/workflows run post-code-review");
      expect(parseRunCommand(start.slice("/workflows ".length))).toEqual({
        scriptRef: "post-code-review",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds exact deterministic current and historical editor prompts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-prompts-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(path.join(workflowDir, "alpha.workflow.mjs"), 'export const meta = { description: "Alpha" };\n');
      writeRun(root, "20260101-000001-alpha", { kind: "name", ref: "alpha", source: "project" });
      const model = buildWorkflowCatalogModel(root, root);
      const current = model.current.find((row) => row.name === "alpha")!;
      const history = model.history[0]!;

      const currentState = { kind: "ready" as const, row: current, path: current.target.path, source: "source" };
      const historyState = { kind: "ready" as const, row: history, path: history.originPath, source: "source" };
      expect(buildWorkflowActionPrompt({ action: "start", row: current, sourceState: currentState })).toBe(
        "/workflows run alpha",
      );
      expect(buildWorkflowActionPrompt({ action: "edit", row: current, sourceState: currentState })).toBe(
        [
          `Request: Edit the exact current workflow at ${JSON.stringify(current.target.path)}.`,
          "Skill: locus-pi-workflow-create",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(buildWorkflowActionPrompt({ action: "review", row: current, sourceState: currentState })).toBe(
        [
          `Request: Review the exact current workflow at ${JSON.stringify(current.target.path)}.`,
          "Skill: locus-pi-workflow-create",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(buildWorkflowActionPrompt({ action: "review", row: history, sourceState: historyState })).toBe(
        [
          `Request: Review the immutable workflow snapshot for run ${JSON.stringify(history.runId)}, target "name:alpha", at ${JSON.stringify(history.originPath)}, SHA-256 ${JSON.stringify(history.snapshot.sha256)}.`,
          "Skill: locus-pi-workflow-create",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(() =>
        buildWorkflowActionPrompt({
          action: "start",
          row: history,
          sourceState: historyState,
        } as unknown as WorkflowBrowserIntent),
      ).toThrow("Historical workflow actions are review-only");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands off to the authoring skill that ships with the installed package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-handoff-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(path.join(workflowDir, "alpha.workflow.mjs"), 'export const meta = { description: "Alpha" };\n');
      const model = buildWorkflowCatalogModel(root, root);
      const current = model.current.find((row) => row.name === "alpha")!;

      const prompt = buildWorkflowActionPrompt({
        action: "edit",
        row: current,
        sourceState: { kind: "ready", row: current, path: current.target.path, source: "source" },
      });
      expect(prompt.split("\n")).toContain("Skill: locus-pi-workflow-create");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains resolver, static metadata, DSL, agents, and model precedence without importing source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-info-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        ["globalThis.__workflowInfoImported = true;", 'export const meta = { description: "Explains alpha" };'].join(
          "\n",
        ),
      );
      writeFileSync(
        path.join(workflowDir, "alpha workflow.workflow.mjs"),
        'export const meta = { description: "Explains quoted alpha" };',
      );

      const named = buildWorkflowInfoBlock(root, root, "alpha");
      const namedText = named.body?.join("\n") ?? "";
      expect(named.controls).toContain(`Run deliberately: ${workflowRunUsage("alpha")}`);
      expect(buildWorkflowInfoBlock(root, root, "alpha workflow").controls).toContain(
        `Run deliberately: ${workflowRunUsage('"alpha workflow"')}`,
      );
      expect(buildWorkflowInfoBlock(root, root, " alpha")).toMatchObject({
        type: "WARN",
        primary: 'Invalid saved workflow name: " alpha".',
      });
      expect(namedText).toContain("source locator: .locus-pi/workflows/alpha.workflow.mjs");
      expect(namedText).not.toContain(path.resolve(root));
      expect(namedText).toContain(
        "metadata: static meta.description/profile/phases; profile classifies source shape, not runtime behavior; module not evaluated",
      );
      expect(namedText).toContain("authoring profile: unclassified (no recognized source-shape contract)");
      // A workflow that declares no phases produces no phase lines at all.
      expect(namedText).not.toContain("phases:");
      expect(namedText).toContain("DSL: agent(), parallel(), pipeline(), phase(), log(), workflow()");
      expect(namedText).toContain('omitted agent uses role "default"');
      // The reader-facing routing claim, kept honest by assertion: `/workflows info`
      // must state the executor precedence and the two asymmetric failure modes, not
      // the pre-T-129 "metadata beside the session model" story.
      // The reader-facing routing claim, kept honest by assertion: `/workflows info`
      // must state the executor precedence and the two asymmetric failure modes, not
      // the pre-T-129 "metadata beside the session model" story. It also has to stay
      // short enough to survive the bounded 48-column view asserted below.
      expect(namedText).toContain(
        "the child session is created with opts.model, else opts.modelRole, else the agent frontmatter tier, " +
          "else the session model",
      );
      expect(namedText).toContain("an unresolvable provider/id fails the call");
      expect(namedText).toContain("an unassigned role normally degrades and is recorded");
      expect(namedText).toContain("requireModelRole refuses that fallback");
      expect(namedText).toContain("agent_end reports the read-back executedModel");
      expect(namedText).toContain("the nearest Project .locus-pi/workflows namespace wins");
      expect(namedText).toContain(
        "a canonical folder owns an optional <workflow>.workflow.mjs plus direct child entries",
      );
      expect((globalThis as Record<string, unknown>).__workflowInfoImported).toBeUndefined();

      expect(buildWorkflowInfoBlock(root, root).controls).toContain(`Run: ${workflowRunUsage()}`);

      expect(buildWorkflowInfoBlock(root, root, "unknown")).toMatchObject({
        type: "WARN",
        primary: 'Unknown current workflow: "unknown".',
      });

      for (const width of [146, 80, 48]) {
        for (const block of [buildWorkflowInfoBlock(root, root), named]) {
          const rendered = renderOperatorBlock(block, width, {}, { maxLines: 34 }).join(" ");
          expect(rendered).toContain("trust:");
          expect(rendered).toContain("history:");
          expect(rendered).toContain("agent models:");
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      delete (globalThis as Record<string, unknown>).__workflowInfoImported;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeRun(
  root: string,
  runId: string,
  target: { kind: "name" | "scriptPath"; ref: string; source: "project" | "personal" | "package" },
  executedSource = `export default () => ${JSON.stringify(runId)};\n`,
): void {
  const runDir = ensureWorkflowRunDir(root, runId);
  writeFileSync(workflowJournalFile(runDir), "", "utf8");
  const sha256 = createHash("sha256").update(executedSource).digest("hex");
  const snapshotPath = path.join(workflowRunRuntimeDir(runDir), `script-${sha256}.workflow.mjs`);
  writeFileSync(snapshotPath, executedSource, "utf8");
  writeFileSync(
    workflowResultFile(runDir),
    JSON.stringify({
      runId,
      ok: true,
      result: null,
      target,
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        sourcePath: path.join(root, ".locus-pi", "workflows", `${target.ref}.workflow.mjs`),
        snapshotPath,
        scriptSha256: sha256,
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        builtinImports: [],
        unboundDependencies: [],
      },
    }),
    "utf8",
  );
}
