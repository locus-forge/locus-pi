import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowRunSummary } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { readWorkflowRunScriptSnapshot } from "../../../../extensions/workflows/runtime/workflow-run-snapshot.js";
import {
  buildWorkflowCatalogModel,
  readWorkflowCatalogSource,
} from "../../../../extensions/workflows/catalog/workflow-catalog.js";
import { workflowRunRuntimeDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  readWorkflowRunResult,
  readWorkflowRunResultText,
  workflowResultFile,
} from "../../../../extensions/workflows/runtime/workflow-result.js";
import { packagedWorkflowPath } from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { createPersistedRunFixtures, digest } from "../../../fixtures/workflow-persisted-run.js";

const fixtures = createPersistedRunFixtures("workflow-run-snapshot-");
const { temporaryRoot, workflowRunDirectory, writeResult, writeSnapshotRun } = fixtures;

afterEach(() => {
  fixtures.cleanup();
});

describe("persisted workflow run source snapshot", () => {
  it("reads only the exact hash-named regular file inside the exact run directory", () => {
    const fixture = writeSnapshotRun("20260713-010101-ready", "export default () => 'ready';\n");

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toEqual({
      kind: "ready",
      runId: fixture.runId,
      target: { kind: "name", ref: "alpha", source: "project" },
      path: fixture.snapshotPath,
      sha256: fixture.sha256,
      identityCoverage: "self-contained-static",
      source: fixture.source,
    });
  });

  it.each(["../escape", "/tmp/escape", "nested/run"])("rejects non-simple run id %j", (runId) => {
    const root = temporaryRoot();
    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({ kind: "invalid", runId });
  });

  it.each(["", ".", "..", "a".repeat(129), true, 1, null, ["valid-looking"], { runId: "valid-looking" }])(
    "classifies malformed direct run id %j as invalid",
    (runId) => {
      const root = temporaryRoot();
      expect(readWorkflowRunScriptSnapshot(root, runId as string)).toMatchObject({ kind: "invalid" });
    },
  );

  it("classifies BigInt and circular direct values without throwing from diagnostics", () => {
    const root = temporaryRoot();
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(readWorkflowRunScriptSnapshot(root, 1n as unknown as string)).toMatchObject({ kind: "invalid" });
    expect(readWorkflowRunScriptSnapshot(root, circular as unknown as string)).toMatchObject({ kind: "invalid" });
  });

  it("accepts an adjacent-dot run id through the central classifier", () => {
    const fixture = writeSnapshotRun("20260713..010101-ready", "adjacent dots remain one safe component\n");

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
      kind: "ready",
      runId: fixture.runId,
    });
  });

  it("reports legacy results without snapshot identity and never reads current source", () => {
    const root = temporaryRoot();
    const runId = "20260713-010102-legacy";
    const runDir = workflowRunDirectory(root, runId);
    mkdirSync(workflowRunRuntimeDir(runDir), { recursive: true });
    writeFileSync(
      workflowResultFile(runDir),
      JSON.stringify({
        target: { kind: "name", ref: "alpha", source: "project" },
      }),
    );
    writeFileSync(path.join(root, "current-decoy.workflow.mjs"), "must not be read");

    expect(readWorkflowRunResult(root, runId)).toMatchObject({
      runUnbound: expect.any(String),
    });
    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({
      kind: "legacy",
      target: { ref: "alpha" },
    });
  });

  it("rejects a copied result envelope whose persisted runId names another run", () => {
    const fixture = writeSnapshotRun("20260713-010102-source-bound", "source\n");
    const copiedRunId = "20260713-010103-copied-envelope";
    const copiedDir = workflowRunDirectory(fixture.root, copiedRunId);
    mkdirSync(workflowRunRuntimeDir(copiedDir), { recursive: true });
    const sourceEnvelope = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(workflowResultFile(copiedDir), JSON.stringify(sourceEnvelope));

    expect(readWorkflowRunResult(fixture.root, copiedRunId)).toMatchObject({
      runIdInvalid: expect.stringContaining("does not match selected run"),
    });
    expect(readWorkflowRunResult(fixture.root, copiedRunId)).not.toHaveProperty("target");
    expect(readWorkflowRunResultText(fixture.root, copiedRunId)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("runId is malformed or does not match"),
    });
    expect(readWorkflowRunScriptSnapshot(fixture.root, copiedRunId)).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("persisted result binding"),
    });
  });

  it("reports malformed persisted snapshot identity as invalid rather than legacy", () => {
    const fixture = writeSnapshotRun("20260713-010102-invalid-identity", "invalid identity\n");
    writeFileSync(
      workflowResultFile(fixture.runDir),
      JSON.stringify({
        runId: fixture.runId,
        target: { kind: "name", ref: "alpha", source: "project" },
        scriptIdentity: { snapshotPath: fixture.snapshotPath, scriptSha256: "wrong" },
      }),
    );

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a present v2 script identity without a persisted target across read surfaces", () => {
    const fixture = writeSnapshotRun("20260713-010102-v2-without-target", "unbound identity\n");
    const result = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<string, unknown>;
    delete result.target;
    writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(result));

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      scriptIdentityInvalid: expect.stringContaining("requires a persisted target"),
    });
    expect(readWorkflowRunResult(fixture.root, fixture.runId)).not.toHaveProperty("scriptIdentity");
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a present target.path that escapes its persisted source root", () => {
    const fixture = writeSnapshotRun("20260713-010102-invalid-target-path", "invalid target path\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, {
      kind: "name",
      ref: "alpha",
      source: "project",
      path: path.join(path.dirname(fixture.root), "outside.workflow.mjs"),
    });

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      targetInvalid: expect.any(String),
    });
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it.each(["../outside.workflow.mjs", path.join(path.parse(process.cwd()).root, "outside.workflow.mjs")])(
    "rejects project scriptPath target ref outside the project root without enrichment: %s",
    (ref) => {
      const fixture = writeSnapshotRun("20260713-010102-target-ref-escape", "target ref escape\n");
      const record = {
        runId: fixture.runId,
        ok: true,
        target: { kind: "scriptPath", ref, source: "project" },
      };
      writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(record));

      expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
        targetInvalid: expect.stringContaining("escapes the project root"),
      });
      expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
    },
  );

  it.each(["external", "dangling", "directory"] as const)(
    "rejects target-only scriptPath %s leaf that is not a confined regular file",
    (kind) => {
      const fixture = writeSnapshotRun("20260713-010102-target-only-leaf", "target-only leaf\n");
      const targetPath = path.join(fixture.root, ".locus-pi", "workflows", "target.workflow.mjs");
      mkdirSync(path.dirname(targetPath), { recursive: true });
      if (kind === "external") {
        const external = path.join(path.dirname(fixture.root), "external-target-only.workflow.mjs");
        writeFileSync(external, fixture.source);
        symlinkSync(external, targetPath);
      } else if (kind === "dangling") {
        symlinkSync(path.join(fixture.root, "missing.workflow.mjs"), targetPath);
      } else {
        mkdirSync(targetPath);
      }
      writeFileSync(
        workflowResultFile(fixture.runDir),
        JSON.stringify({
          runId: fixture.runId,
          ok: true,
          target: { kind: "scriptPath", ref: ".locus-pi/workflows/target.workflow.mjs", source: "project" },
        }),
      );

      expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
        targetInvalid: expect.any(String),
      });
      expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
    },
  );

  it("propagates a present-but-malformed target as invalid across result, text, summary, and snapshot reads", () => {
    const fixture = writeSnapshotRun("20260713-010102-malformed-target", "malformed target\n");
    writeFileSync(
      workflowResultFile(fixture.runDir),
      JSON.stringify({
        runId: fixture.runId,
        ok: true,
        result: "ok",
        disposition: { status: "completed" },
        target: { kind: "name", ref: "nested/run/extra", source: "project" },
        scriptIdentity: {
          schemaVersion: 2,
          identityPolicy: "static-node-only-v1",
          sourcePath: path.join(path.dirname(fixture.runDir), "alpha.workflow.mjs"),
          snapshotPath: fixture.snapshotPath,
          scriptSha256: fixture.sha256,
          identityCoverage: "self-contained-static",
          executionSource: "snapshot",
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          builtinImports: [],
          unboundDependencies: [],
        },
      }),
    );

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({ targetInvalid: expect.any(String) });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a present workspace location with a non-string field across read surfaces", () => {
    const fixture = writeSnapshotRun("20260713-010102-malformed-workspace-type", "malformed workspace type\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir: 7,
      workspaceDirRelative: "tmp/ordinary",
    });

    expectMalformedWorkspaceReadSurfaces(fixture);
  });

  it("rejects a relative raw workspaceDir before cwd-dependent path resolution", () => {
    const fixture = writeSnapshotRun("20260713-010102-relative-workspace", "relative workspace\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir: "tmp/relative",
      workspaceDirRelative: "tmp/relative",
    });

    expectMalformedWorkspaceReadSurfaces(fixture);
  });

  it("rejects an external absolute workspace location across read surfaces", () => {
    const fixture = writeSnapshotRun("20260713-010102-malformed-workspace-external", "external workspace\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir: path.join(fixture.root, "..", "external-workspace"),
      workspaceDirRelative: "external-workspace",
    });

    expectMalformedWorkspaceReadSurfaces(fixture);
  });

  it("rejects an inconsistent workspace absolute/relative pair across read surfaces", () => {
    const fixture = writeSnapshotRun("20260713-010102-malformed-workspace-pair", "inconsistent workspace\n");
    const workspaceDir = path.join(fixture.root, "tmp", "ordinary");
    mkdirSync(workspaceDir, { recursive: true });
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir,
      workspaceDirRelative: "tmp/other",
    });

    expectMalformedWorkspaceReadSurfaces(fixture);
  });

  it("rejects a persisted physical workspace identity that names another existing workspace", () => {
    const fixture = writeSnapshotRun("20260713-010102-mismatched-physical", "mismatched physical workspace\n");
    const workspaceDir = path.join(fixture.root, "tmp", "one");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(path.join(fixture.root, "tmp", "other"), { recursive: true });
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir,
      workspaceDirRelative: "tmp/one",
      workspacePhysicalIdentity: "tmp/other",
      workspacePhysicalIdentitySchemaVersion: 1,
    });

    const result = readWorkflowRunResult(fixture.root, fixture.runId);
    expect(result).toMatchObject({ workspacePhysicalIdentityInvalid: expect.stringContaining("does not match") });
    expect(result).not.toHaveProperty("workspaceDir");
    expect(result).not.toHaveProperty("workspaceDirRelative");
    expect(result).not.toHaveProperty("workspacePhysicalIdentity");
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
    const snapshot = readWorkflowRunScriptSnapshot(fixture.root, fixture.runId);
    expect(snapshot).toMatchObject({ kind: "invalid" });
    const catalog = buildWorkflowCatalogModel(fixture.root, fixture.root);
    expect(catalog.history[0]?.snapshot).toMatchObject({ kind: "invalid" });
    expect(readWorkflowCatalogSource(catalog.history[0]!, fixture.root, fixture.root)).toMatchObject({
      kind: "invalid",
    });
  });

  it("rejects physical identity metadata without a complete workspace pair across read surfaces", () => {
    const fixture = writeSnapshotRun("20260713-010102-physical-without-workspace", "physical without workspace\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspacePhysicalIdentity: "tmp/removed",
      workspacePhysicalIdentitySchemaVersion: 1,
    });

    const result = readWorkflowRunResult(fixture.root, fixture.runId);
    expect(result).toMatchObject({
      workspacePhysicalIdentityInvalid: expect.stringContaining("required when workspace physical identity is present"),
    });
    expect(result).not.toHaveProperty("workspacePhysicalIdentity");
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a removed workspace whose persisted physical identity disagrees with its pair", () => {
    const fixture = writeSnapshotRun("20260713-010102-removed-mismatched-physical", "removed mismatch\n");
    const workspaceDir = path.join(fixture.root, "tmp", "removed-mismatch");
    mkdirSync(workspaceDir, { recursive: true });
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir,
      workspaceDirRelative: "tmp/removed-mismatch",
      workspacePhysicalIdentity: "tmp/other",
      workspacePhysicalIdentitySchemaVersion: 1,
    });
    rmSync(workspaceDir, { recursive: true, force: true });

    const result = readWorkflowRunResult(fixture.root, fixture.runId);
    expect(result).toMatchObject({ workspacePhysicalIdentityInvalid: expect.stringContaining("does not match") });
    expect(result).not.toHaveProperty("workspaceDir");
    expect(result).not.toHaveProperty("workspaceDirRelative");
    expect(result).not.toHaveProperty("workspacePhysicalIdentity");
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("keeps a removed workspace readable while resume remains responsible for availability", () => {
    const fixture = writeSnapshotRun("20260713-010102-removed-workspace", "removed workspace\n");
    const workspaceDir = path.join(fixture.root, "tmp", "removed");
    mkdirSync(workspaceDir, { recursive: true });
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir,
      workspaceDirRelative: "tmp/removed",
      workspacePhysicalIdentity: "tmp/removed",
      workspacePhysicalIdentitySchemaVersion: 1,
      result: "removed workspace remains readable",
    });
    rmSync(workspaceDir, { recursive: true, force: true });

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).not.toMatchObject({
      workspaceDirInvalid: expect.any(String),
      workspacePhysicalIdentityInvalid: expect.any(String),
    });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "ready" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "ready" });
  });

  it.each([
    { kind: "name", ref: " alpha", source: "project" },
    { kind: "name", ref: "alpha ", source: "personal" },
    { kind: "name", ref: "nested/run/extra", source: "project" },
    { kind: "name", ref: "alpha\u0001control", source: "project" },
    { kind: "name", ref: "alpha.workflow.mjs", source: "package" },
    { kind: "scriptPath", ref: "alpha.workflow.mjs", source: "personal" },
    { kind: "scriptPath", ref: "alpha.workflow.mjs", source: "package" },
    { kind: "scriptPath", ref: "", source: "project" },
  ] as const)("rejects forged persisted target identity %j", (target) => {
    const fixture = writeSnapshotRun("20260713-010102-invalid-target", "invalid target\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, target);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects persisted target paths that do not match the target identity", () => {
    const fixture = writeSnapshotRun("20260713-010102-target-fields", "target fields\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, {
      kind: "name",
      ref: "alpha",
      source: "project",
      path: fixture.root,
    });
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("accepts an exact project scriptPath target", () => {
    const fixture = writeSnapshotRun("20260713-010102-script-path", "script path\n");
    const target = { kind: "scriptPath" as const, ref: "alpha.workflow.mjs", source: "project" as const };
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, target);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "ready", target });
  });

  it.each([
    { ref: "post-code-review", path: packagedWorkflowPath("post-code-review") },
    { ref: "post-code-review/scope", path: packagedWorkflowPath("post-code-review/scope") },
  ])("reads canonical Package folder identity $ref", ({ ref, path: sourcePath }) => {
    const fixture = writeSnapshotRun(`20260713-010102-package-${ref.includes("/") ? "child" : "root"}`, "package\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, {
      kind: "name",
      ref,
      source: "package",
      path: sourcePath,
    });

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).not.toHaveProperty("targetInvalid");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref, source: "package" },
    });
  });

  it.each([
    { kind: "scriptPath", ref: "alpha.workflow.mjs", sourcePath: "other.workflow.mjs" },
    { kind: "name", ref: "alpha", sourcePath: "other.workflow.mjs" },
  ])("rejects target/source parity drift without runner path: %j", ({ kind, ref, sourcePath }) => {
    const fixture = writeSnapshotRun("20260713-010102-source-parity", "source parity\n");
    const result = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<string, unknown>;
    result.target = { kind, ref, source: "project" };
    (result.scriptIdentity as Record<string, unknown>).sourcePath =
      kind === "scriptPath"
        ? path.join(fixture.root, sourcePath)
        : path.join(fixture.root, ".locus-pi", "workflows", sourcePath);
    writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(result));

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      scriptIdentityInvalid: expect.any(String),
    });
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("keeps removed canonical Project workflow history readable", () => {
    const fixture = writeSnapshotRun("20260713-010102-removed-project-name", "removed project name\n");
    rmSync(fixture.sourcePath);

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).not.toHaveProperty("scriptIdentityInvalid");
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "ready" });
  });

  it("rejects a missing named Project source outside workflow inventory", () => {
    const fixture = writeSnapshotRun("20260713-010102-missing-project-name", "missing project name\n");
    const result = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<string, unknown>;
    (result.scriptIdentity as Record<string, unknown>).sourcePath = path.join(
      fixture.root,
      "not-workflows",
      "alpha.workflow.mjs",
    );
    writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(result));

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      scriptIdentityInvalid: expect.stringContaining("persisted workflow source root"),
    });
    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("reports a missing expected snapshot", () => {
    const fixture = writeSnapshotRun("20260713-010103-missing", "missing\n");
    rmSync(fixture.snapshotPath);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
      kind: "missing",
      path: fixture.snapshotPath,
      sha256: fixture.sha256,
    });
  });

  it("rejects a file symlink even when its target bytes and basename hash match", () => {
    const fixture = writeSnapshotRun("20260713-010104-file-link", "file symlink\n");
    const external = path.join(fixture.root, "external.workflow.mjs");
    writeFileSync(external, fixture.source);
    rmSync(fixture.snapshotPath);
    symlinkSync(external, fixture.snapshotPath);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a symlinked ancestor below the project root", () => {
    const root = temporaryRoot();
    const external = temporaryRoot();
    symlinkSync(external, path.join(root, ".locus-pi"));
    const runId = "20260713-010105-ancestor-link";
    const source = "ancestor symlink\n";
    const sha256 = digest(source);
    const externalRunDir = path.join(external, "runs", runId);
    mkdirSync(externalRunDir, { recursive: true });
    const snapshotPath = path.join(root, ".locus-pi", "runs", runId, "runtime", `script-${sha256}.workflow.mjs`);
    mkdirSync(path.dirname(path.join(externalRunDir, "runtime", path.basename(snapshotPath))), { recursive: true });
    writeFileSync(path.join(externalRunDir, "runtime", path.basename(snapshotPath)), source);
    writeResult(externalRunDir, snapshotPath, sha256);

    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({ kind: "invalid" });
  });

  it.each([".locus-pi", ".locus-pi/runs"])("rejects a snapshot behind a symlinked %s evidence ancestor", (ancestor) => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const runId = "20260713-010105-ancestor-table";
    const source = "ancestor symlink table\n";
    const sha256 = digest(source);
    const lexicalAncestor = path.join(root, ...ancestor.split("/"));
    mkdirSync(path.dirname(lexicalAncestor), { recursive: true });
    const outsideTarget = path.join(outside, path.basename(lexicalAncestor));
    const suffix = ancestor === ".locus-pi" ? ["runs"] : [];
    const outsideRunDir = path.join(outsideTarget, ...suffix, runId);
    const snapshotPath = path.join(root, ".locus-pi", "runs", runId, "runtime", `script-${sha256}.workflow.mjs`);
    mkdirSync(path.join(outsideRunDir, "runtime"), { recursive: true });
    writeFileSync(path.join(outsideRunDir, "runtime", path.basename(snapshotPath)), source);
    writeResult(outsideRunDir, snapshotPath, sha256);
    symlinkSync(outsideTarget, lexicalAncestor, "dir");

    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a wrong basename or path even when the bytes hash correctly", () => {
    const fixture = writeSnapshotRun("20260713-010106-wrong-name", "wrong name\n");
    const wrongPath = path.join(path.dirname(fixture.snapshotPath), "snapshot.workflow.mjs");
    rmSync(fixture.snapshotPath);
    writeFileSync(wrongPath, fixture.source);
    writeResult(fixture.runDir, wrongPath, fixture.sha256);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("reports changed bytes as tampered", () => {
    const fixture = writeSnapshotRun("20260713-010107-tampered", "original\n");
    writeFileSync(fixture.snapshotPath, "changed\n");

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
      kind: "tampered",
      sha256: fixture.sha256,
    });
  });

  it("rejects a directory at the expected snapshot path", () => {
    const fixture = writeSnapshotRun("20260713-010108-directory", "directory\n");
    rmSync(fixture.snapshotPath);
    mkdirSync(fixture.snapshotPath);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });
});

function expectMalformedWorkspaceReadSurfaces(fixture: { root: string; runId: string }): void {
  expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
    workspaceDirInvalid: expect.any(String),
  });
  const result = readWorkflowRunResult(fixture.root, fixture.runId);
  expect(result).not.toHaveProperty("workspaceDir");
  expect(result).not.toHaveProperty("workspaceDirRelative");
  expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({
    status: "invalid",
    message: expect.stringContaining("workspace location is malformed"),
  });
  expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
    kind: "invalid",
    message: expect.stringContaining("workspace location is malformed"),
  });
}
