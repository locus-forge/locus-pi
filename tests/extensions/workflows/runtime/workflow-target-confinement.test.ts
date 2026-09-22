import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  listWorkflowCatalogTargets,
  packagedExamplesDir,
  resolveWorkflowTarget,
  WorkflowNameNotFoundError,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import {
  isPostCodeReviewTargetIdentity,
  isPostCodeReviewTargetProjection,
  workflowTargetIdentityKey,
} from "../../../../extensions/workflows/runtime/workflow-saved-name.js";
import { createHarness } from "../../../test-harness.js";

describe("workflow target physical confinement", () => {
  it.each([
    [{ kind: "name", ref: "post-code-review", source: "project" }, true],
    [{ kind: "name", ref: "post-code-review", source: "personal" }, false],
    [{ kind: "name", ref: "post-code-review", source: "package" }, true],
    [{ kind: "scriptPath", ref: "./.locus-pi/workflows/post-code-review.workflow.mjs", source: "project" }, true],
    [
      { kind: "scriptPath", ref: "nested/../.locus-pi/workflows/post-code-review.workflow.mjs", source: "project" },
      true,
    ],
    [{ kind: "scriptPath", ref: "nested/post-code-review.workflow.mjs", source: "project" }, false],
  ] as const)("classifies canonical owner identity source/path %j", (identity, expected) => {
    expect(isPostCodeReviewTargetIdentity(identity)).toBe(expected);
  });

  it("classifies an absolute in-project owner path only with its project root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-owner-absolute-"));
    try {
      const absolute = path.join(root, ".locus-pi", "workflows", "post-code-review.workflow.mjs");
      expect(isPostCodeReviewTargetIdentity({ kind: "scriptPath", ref: absolute, source: "project" }, root)).toBe(true);
      expect(isPostCodeReviewTargetIdentity({ kind: "scriptPath", ref: absolute, source: "project" })).toBe(false);
      expect(
        isPostCodeReviewTargetIdentity(
          {
            kind: "scriptPath",
            ref: path.join(root, "..", ".locus-pi", "workflows", "post-code-review.workflow.mjs"),
            source: "project",
          },
          root,
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one canonical key for equivalent path spellings and confined symlink aliases", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-owner-projection-"));
    try {
      const workflows = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflows, { recursive: true });
      const canonical = path.join(workflows, "post-code-review.workflow.mjs");
      const alias = path.join(root, "post-review-alias.workflow.mjs");
      writeFileSync(canonical, "export default () => 'ok';\n", "utf8");
      symlinkSync(canonical, alias);

      const canonicalTarget = resolveWorkflowTarget(
        { scriptPath: ".locus-pi/workflows/post-code-review.workflow.mjs" },
        root,
        root,
      );
      const aliasTarget = resolveWorkflowTarget({ scriptPath: "post-review-alias.workflow.mjs" }, root, root);
      const canonicalIdentity = { kind: "scriptPath" as const, ref: canonicalTarget.ref, source: "project" as const };
      const aliasIdentity = { kind: "scriptPath" as const, ref: aliasTarget.ref, source: "project" as const };

      expect(
        workflowTargetIdentityKey(
          { kind: "scriptPath", ref: "./.locus-pi/workflows/post-code-review.workflow.mjs", source: "project" },
          { projectRoot: root },
        ),
      ).toBe(workflowTargetIdentityKey(canonicalIdentity, { projectRoot: root, resolvedPath: canonicalTarget.path }));
      expect(
        isPostCodeReviewTargetProjection(aliasIdentity, { projectRoot: root, resolvedPath: aliasTarget.path }),
      ).toBe(true);
      expect(workflowTargetIdentityKey(aliasIdentity, { projectRoot: root, resolvedPath: aliasTarget.path })).toBe(
        workflowTargetIdentityKey(canonicalIdentity, { projectRoot: root, resolvedPath: canonicalTarget.path }),
      );
      expect(
        workflowTargetIdentityKey(
          { kind: "name", ref: "post-code-review", source: "project" },
          { projectRoot: root, resolvedPath: canonicalTarget.path },
        ),
      ).toBe(workflowTargetIdentityKey(canonicalIdentity, { projectRoot: root, resolvedPath: canonicalTarget.path }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicit external symlink before its module can be evaluated", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-confined-project-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-confined-outside-"));
    const marker = path.join(outside, "evaluated.marker");
    try {
      const externalScript = path.join(outside, "external.workflow.mjs");
      writeFileSync(
        externalScript,
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(marker)}, 'evaluated', 'utf8');`,
          "export default function() { return { escaped: true }; }",
          "",
        ].join("\n"),
        "utf8",
      );
      symlinkSync(externalScript, path.join(root, "escape.workflow.mjs"));

      expect(() => resolveWorkflowTarget({ scriptPath: "escape.workflow.mjs" }, root, root)).toThrow(
        /escapes project root through a symlink/u,
      );

      const harness = createHarness(root, { sessionId: "wf-confined-explicit" });
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "escape.workflow.mjs",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/escapes project root through a symlink/u);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(result.resultPersistence.path, "utf8"))).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a project saved-name symlink instead of falling through to another source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-confined-name-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-confined-name-outside-"));
    try {
      const projectWorkflows = path.join(root, ".locus-pi", "workflows");
      mkdirSync(projectWorkflows, { recursive: true });
      const externalScript = path.join(outside, "named.workflow.mjs");
      writeFileSync(externalScript, "export default () => ({ escaped: true });\n", "utf8");
      symlinkSync(externalScript, path.join(projectWorkflows, "named.workflow.mjs"));

      expect(() => resolveWorkflowTarget({ name: "named" }, root, root)).toThrow(
        /escapes project root through a symlink/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows internal symlinks under a symlinked project root and preserves lexical paths", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "wf-confined-internal-"));
    const physicalRoot = path.join(parent, "physical-project");
    const projectAlias = path.join(parent, "project-alias");
    try {
      const actualScript = path.join(physicalRoot, "actual", "inside.workflow.mjs");
      mkdirSync(path.dirname(actualScript), { recursive: true });
      mkdirSync(path.join(physicalRoot, ".locus-pi", "workflows"), { recursive: true });
      writeFileSync(actualScript, "export default () => ({ inside: true });\n", "utf8");
      symlinkSync(physicalRoot, projectAlias);
      symlinkSync(actualScript, path.join(physicalRoot, "entry.workflow.mjs"));
      symlinkSync(actualScript, path.join(physicalRoot, ".locus-pi", "workflows", "inside.workflow.mjs"));

      const explicit = resolveWorkflowTarget({ scriptPath: "entry.workflow.mjs" }, projectAlias, projectAlias);
      const named = resolveWorkflowTarget({ name: "inside" }, projectAlias, projectAlias);
      expect(explicit.path).toBe(path.join(projectAlias, "entry.workflow.mjs"));
      expect(named).toMatchObject({
        source: "project",
        path: path.join(projectAlias, ".locus-pi", "workflows", "inside.workflow.mjs"),
      });

      const harness = createHarness(projectAlias, { sessionId: "wf-confined-internal" });
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "entry.workflow.mjs",
      });
      expect(result).toMatchObject({ ok: true, result: { inside: true } });
      expect(result.target?.path).toBe(path.join(projectAlias, "entry.workflow.mjs"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("preserves missing and dangling paths, lexical containment, personal, and packaged sources", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-confined-sources-"));
    const home = mkdtempSync(path.join(tmpdir(), "wf-confined-home-"));
    const previousHome = process.env.HOME;
    try {
      const missing = resolveWorkflowTarget({ scriptPath: "missing.workflow.mjs" }, root, root);
      expect(missing.path).toBe(path.join(root, "missing.workflow.mjs"));
      const danglingPath = path.join(root, "dangling.workflow.mjs");
      symlinkSync(path.join(root, "absent-target.workflow.mjs"), danglingPath);
      expect(resolveWorkflowTarget({ scriptPath: "dangling.workflow.mjs" }, root, root).path).toBe(danglingPath);
      const danglingHarness = createHarness(root, { sessionId: "wf-confined-dangling" });
      const danglingResult = await runWorkflowScript({
        pi: danglingHarness.pi,
        ctx: danglingHarness.ctx,
        signal: new AbortController().signal,
        scriptPath: "dangling.workflow.mjs",
      });
      expect(danglingResult.ok).toBe(false);
      expect(() => resolveWorkflowTarget({ scriptPath: "../escape.workflow.mjs" }, root, root)).toThrow(/escapes/u);

      process.env.HOME = home;
      const personalDir = path.join(home, ".locus-pi", "workflows");
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(path.join(personalDir, "personal.workflow.mjs"), "export default () => 'personal';\n", "utf8");
      expect(resolveWorkflowTarget({ name: "personal" }, root, root)).toMatchObject({
        source: "personal",
        path: path.join(personalDir, "personal.workflow.mjs"),
      });

      expect(resolveWorkflowTarget({ name: "live-smoke" }, root, root)).toMatchObject({
        source: "package",
        path: path.join(packagedExamplesDir(), "live-smoke", "live-smoke.workflow.mjs"),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects personal workflow leaf and root symlinks that escape home", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-personal-confinement-"));
    const home = mkdtempSync(path.join(tmpdir(), "wf-personal-home-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-personal-outside-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const personalDir = path.join(home, ".locus-pi", "workflows");
      mkdirSync(personalDir, { recursive: true });
      const internalFile = path.join(personalDir, "inside.workflow.mjs");
      writeFileSync(internalFile, "export default () => 'inside';\n", "utf8");
      symlinkSync(internalFile, path.join(personalDir, "inside-alias.workflow.mjs"));
      expect(resolveWorkflowTarget({ name: "inside-alias" }, root, root)).toMatchObject({
        source: "personal",
        path: path.join(personalDir, "inside-alias.workflow.mjs"),
      });
      const externalFile = path.join(outside, "personal.workflow.mjs");
      writeFileSync(externalFile, "export default () => 'outside';\n", "utf8");
      symlinkSync(externalFile, path.join(personalDir, "personal.workflow.mjs"));
      expect(() => resolveWorkflowTarget({ name: "personal" }, root, root)).toThrow(/personal workflow root|symlink/u);

      rmSync(path.join(home, ".locus-pi"), { recursive: true, force: true });
      mkdirSync(path.join(outside, "workflows"), { recursive: true });
      writeFileSync(
        path.join(outside, "workflows", "personal.workflow.mjs"),
        "export default () => 'outside';\n",
        "utf8",
      );
      symlinkSync(outside, path.join(home, ".locus-pi"), "dir");
      expect(() => resolveWorkflowTarget({ name: "personal" }, root, root)).toThrow(/home directory|symlink/u);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("canonical saved-workflow source root", () => {
  const withProject = (run: (root: string) => void): void => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-interop-"));
    const previousHome = process.env.HOME;
    try {
      // Keep a real personal directory out of the resolution path.
      process.env.HOME = path.join(root, "home");
      run(root);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  };

  it.each([".pi", ".claude", ".agents"])("does not resolve saved names from legacy project root %s", (legacyRoot) => {
    withProject((root) => {
      const directory = path.join(root, legacyRoot, "workflows");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "old.workflow.mjs"), 'export default () => "old";\n', "utf8");

      expect(() => resolveWorkflowTarget({ name: "old" }, root, root)).toThrow(WorkflowNameNotFoundError);
      expect(listWorkflowCatalogTargets(root, root).map((target) => target.ref)).not.toContain("old");
    });
  });

  it("resolves only the pi-native entry from project .locus-pi/workflows", () => {
    withProject((root) => {
      const dir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "both.js"), "export default () => 'js';\n", "utf8");
      writeFileSync(path.join(dir, "both.workflow.mjs"), "export default () => 'mjs';\n", "utf8");

      expect(resolveWorkflowTarget({ name: "both" }, root, root)).toMatchObject({
        kind: "name",
        ref: "both",
        source: "project",
        path: path.join(dir, "both.workflow.mjs"),
      });
    });
  });

  it("resolves canonical folder roots and direct children", () => {
    withProject((root) => {
      const namespace = path.join(root, ".locus-pi", "workflows", "catalog");
      mkdirSync(namespace, { recursive: true });
      writeFileSync(path.join(namespace, "catalog.workflow.mjs"), 'export default () => "root";\n', "utf8");
      writeFileSync(path.join(namespace, "analyze-file.workflow.mjs"), 'export default () => "child";\n', "utf8");

      expect(resolveWorkflowTarget({ name: "catalog" }, root, root).path).toBe(
        path.join(namespace, "catalog.workflow.mjs"),
      );
      expect(resolveWorkflowTarget({ name: "catalog/analyze-file" }, root, root).path).toBe(
        path.join(namespace, "analyze-file.workflow.mjs"),
      );
    });
  });
});

describe("saved workflow name identity", () => {
  const withProject = (run: (root: string, workflowDir: string) => void): void => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-saved-name-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".locus-pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      run(root, workflowDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("resolves an interior-whitespace name exactly through canonical and legacy name fields", () => {
    withProject((root, workflowDir) => {
      const name = "alpha workflow";
      const file = path.join(workflowDir, `${name}.workflow.mjs`);
      writeFileSync(file, "export default () => 'exact';\n", "utf8");

      expect(resolveWorkflowTarget({ name }, root, root)).toMatchObject({ kind: "name", ref: name, path: file });
      expect(resolveWorkflowTarget({ script: name }, root, root)).toMatchObject({
        kind: "name",
        ref: name,
        path: file,
      });
    });
  });

  it("keeps invalid filename stems out of the catalog and rejects them without trimming", () => {
    withProject((root, workflowDir) => {
      const invalidFileNames = [
        " alpha",
        "alpha ",
        "alpha\u0001control",
        String.raw`alpha\beta`,
        "alpha.mjs",
        "alpha.MJS",
        "a".repeat(201),
      ];
      for (const name of invalidFileNames) {
        writeFileSync(path.join(workflowDir, `${name}.workflow.mjs`), "export default () => null;\n", "utf8");
      }

      const catalogNames = listWorkflowCatalogTargets(root, root).map((target) => target.ref);
      for (const name of invalidFileNames) {
        expect(catalogNames, name).not.toContain(name);
        expect(() => resolveWorkflowTarget({ name }, root, root), name).toThrow(/Invalid saved workflow name/u);
      }
      for (const name of [" alpha", "alpha ", "alpha\u0001control", "a".repeat(201)]) {
        expect(() => resolveWorkflowTarget({ script: name }, root, root), name).toThrow(/Invalid saved workflow name/u);
      }
      for (const name of ["alpha/beta/gamma", String.raw`alpha\beta`, "alpha.mjs", "alpha.MJS"]) {
        expect(() => resolveWorkflowTarget({ name }, root, root), name).toThrow(/Invalid saved workflow name/u);
      }
    });
  });
});
