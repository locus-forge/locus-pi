import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
  WORKFLOW_FINALIZATION_ERROR_MAX_CHARS,
  WORKFLOW_RESULT_NOT_JSON_SAFE,
  WORKFLOW_RESULT_WRITE_FAILED,
  classifyWorkflowReturnedFailure,
  formatWorkflowResultDetail,
  formatWorkflowFailureSummary,
  formatWorkflowResultSummary,
  isWorkflowResultExplicitFailure,
  prepareWorkflowResult,
  projectWorkflowDisposition,
  readWorkflowRunResult,
  readWorkflowRunResultText,
  workflowDispositionForCompletion,
  workflowFinalizationError,
  workflowResultFile,
  writeWorkflowResultJson,
} from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  ensureWorkflowRunDir,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { readWorkflowRunSummary } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { createPersistedRunFixtures } from "../../../fixtures/workflow-persisted-run.js";

const fixtures = createPersistedRunFixtures("workflow-result-readback-");
const { temporaryRoot, workflowRunDirectory, writeResult, writeSnapshotRun } = fixtures;

afterEach(() => {
  fixtures.cleanup();
});

describe("workflow result JSON boundary", () => {
  it("bounds typed finalization errors without changing their stage", () => {
    const exact = workflowFinalizationError("report", "report failed");
    expect(exact).toEqual({ stage: "report", message: "report failed" });

    const bounded = workflowFinalizationError("lease-release", "x".repeat(2000));
    expect(bounded.stage).toBe("lease-release");
    expect(bounded.message).toHaveLength(WORKFLOW_FINALIZATION_ERROR_MAX_CHARS);
    expect(bounded.message).toMatch(/truncated/u);
  });

  it("projects new dispositions strictly while preserving only absent legacy envelopes", () => {
    expect(projectWorkflowDisposition({ ok: true, result: { summary: "legacy" } })).toEqual({
      status: "completed",
      summary: "legacy",
    });
    expect(projectWorkflowDisposition({ ok: false, result: null, error: "legacy failed" })).toEqual({
      status: "failed",
      summary: "legacy failed",
    });
    expect(
      projectWorkflowDisposition({
        ok: true,
        result: { mode: "prepared" },
        disposition: { status: "awaiting_operator", detail: "review clarification required" },
      }),
    ).toEqual({
      status: "awaiting_operator",
      summary: "awaiting operator · review clarification required",
    });
    expect(
      projectWorkflowDisposition({
        ok: false,
        result: null,
        disposition: { status: "cancelled", reason: "operator_stop" },
      }),
    ).toEqual({ status: "cancelled", summary: "cancelled by operator" });
    expect(
      projectWorkflowDisposition({
        ok: true,
        result: "would otherwise look successful",
        disposition: { status: "future_status" },
      }),
    ).toEqual({ status: "unknown", summary: "unknown workflow disposition" });
    expect(
      projectWorkflowDisposition({
        ok: true,
        result: "inconsistent",
        disposition: { status: "failed" },
      }),
    ).toEqual({ status: "unknown", summary: "unknown workflow disposition" });
  });

  it("gives controlling abort signals precedence over waiting and success", () => {
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: true,
        abortReason: { kind: "operator_stop" },
        awaitOperatorReason: "questions remain",
      }),
    ).toEqual({ status: "cancelled", reason: "operator_stop" });
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: true,
        abortReason: { kind: "session_shutdown" },
      }),
    ).toEqual({ status: "cancelled", reason: "session_shutdown" });
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: false,
        awaitOperatorReason: "questions remain",
      }),
    ).toEqual({ status: "awaiting_operator", detail: "questions remain" });
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: false,
        awaitOperatorReason: "x".repeat(201),
      }),
    ).toEqual({ status: "failed" });
  });

  it("classifies one returned-outcome failure policy for root and grouped execution", () => {
    expect(classifyWorkflowReturnedFailure({ ok: false, status: "blocked", summary: "stopped" })).toEqual({
      kind: "ok-false",
      status: "blocked",
      summary: "stopped",
    });
    expect(classifyWorkflowReturnedFailure({ partial: true })).toEqual({ kind: "partial" });
    expect(classifyWorkflowReturnedFailure({ status: "failed" })).toEqual({ kind: "status", status: "failed" });
    expect(classifyWorkflowReturnedFailure({ status: "blocked" })).toEqual({ kind: "status", status: "blocked" });
    expect(classifyWorkflowReturnedFailure({ status: "cancelled" })).toEqual({
      kind: "status",
      status: "cancelled",
    });
    expect(classifyWorkflowReturnedFailure({ status: "completed" })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure({ ok: true, partial: false })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure({ ok: "false", partial: "true" })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure({ summary: "legacy success" })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure(null)).toBeUndefined();

    expect(isWorkflowResultExplicitFailure({ ok: false })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ partial: true })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ status: "blocked" })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ status: "completed" })).toBe(false);
  });

  it("formats semantic failures with stable unresolved ids while technical errors retain priority", () => {
    const result = {
      ok: false,
      summary: "Acceptance remains open",
      unresolvedRows: [" R-GIT ", "R-CODE", "R-GIT", ""],
    };

    expect(formatWorkflowFailureSummary(result)).toBe("Acceptance remains open · unresolved: R-CODE, R-GIT");
    expect(formatWorkflowFailureSummary(result, " transport failed ")).toBe("transport failed");
    expect(formatWorkflowFailureSummary({ ok: false })).toBe("Workflow execution failed.");
  });

  it("preserves null but replaces undefined, BigInt, circular, and throwing toJSON results with an explicit sentinel", () => {
    const circular: Record<string, unknown> = { label: "cycle" };
    circular.self = circular;
    const throwingToJson = {
      toJSON(): never {
        throw new Error("toJSON refused");
      },
    };
    const throwingSummary: Record<string, unknown> = {};
    Object.defineProperty(throwingSummary, "summary", {
      enumerable: true,
      get(): never {
        throw new Error("summary getter refused");
      },
    });

    expect(prepareWorkflowResult(null)).toEqual({ value: null });
    expect(formatWorkflowResultSummary(null)).toBe("completed");
    expect(formatWorkflowResultDetail(null)).toBe("null");

    for (const unsafe of [undefined, 42n, circular, throwingToJson, throwingSummary]) {
      const prepared = prepareWorkflowResult(unsafe);
      expect(prepared.diagnostic).toMatchObject({
        kind: "workflow_result_diagnostic",
        code: WORKFLOW_RESULT_NOT_JSON_SAFE,
        message: expect.stringContaining("not JSON-safe"),
      });
      expect(prepared.value).toEqual(prepared.diagnostic);
      expect(() => formatWorkflowResultSummary(unsafe)).not.toThrow();
      expect(formatWorkflowResultSummary(unsafe)).toBe("result unavailable");
      const detail = formatWorkflowResultDetail(unsafe, 200);
      expect(detail.length).toBeLessThanOrEqual(200);
      expect(detail).toContain("WORKFLOW_RESULT_NOT_JSON_SAFE");
    }
  });

  it("reports both envelope serialization and filesystem write failures instead of swallowing them", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-result-boundary-"));
    try {
      const safeDir = ensureWorkflowRunDir(root, "safe");
      const safe = writeWorkflowResultJson(safeDir, { runId: "safe", ok: true, result: null });
      expect(safe).toEqual({ ok: true, path: workflowResultFile(safeDir) });
      expect(JSON.parse(readFileSync(safe.path, "utf8"))).toMatchObject({ runId: "safe", result: null });

      const unsafeDir = ensureWorkflowRunDir(root, "unsafe");
      const unsafe = writeWorkflowResultJson(unsafeDir, { runId: "unsafe", ok: true, result: 42n });
      expect(unsafe).toMatchObject({ ok: false, code: WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE });
      expect(existsSync(workflowResultFile(unsafeDir))).toBe(false);

      const blockedDir = ensureWorkflowRunDir(root, "blocked");
      rmSync(workflowRunRuntimeDir(blockedDir), { recursive: true });
      writeFileSync(workflowRunRuntimeDir(blockedDir), "not a directory", "utf8");
      const blocked = writeWorkflowResultJson(blockedDir, { runId: "blocked", ok: true, result: null });
      expect(blocked).toMatchObject({ ok: false, code: WORKFLOW_RESULT_WRITE_FAILED });
      if (blocked.ok) throw new Error("expected blocked persistence to fail");
      expect(blocked.message).toContain("not persisted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Readback of the SAME two files the writer above produced, as untrusted input:
 * legacy envelopes, hand-edited fields, a copied result, a workspace that is no
 * longer there. Each case asserts what the reader reports; whether such a run
 * may be RESUMED is admission, decided by its own owner, not here.
 */
describe("persisted workflow result readback", () => {
  it.each([
    { schemaVersion: 3 },
    { schemaVersion: 2, futureField: true },
    { schemaVersion: 2, builtinImports: "node:fs" },
  ])("projects present malformed script identity %j as invalid metadata", (change) => {
    const fixture = writeSnapshotRun("20260713-010102-invalid-script-identity", "invalid script identity\n");
    const result = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<string, unknown>;
    result.scriptIdentity = { ...(result.scriptIdentity as Record<string, unknown>), ...change };
    writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(result));

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      scriptIdentityInvalid: expect.any(String),
    });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("script identity is malformed"),
    });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });

  it("preserves malformed workspace and semantic metadata as explicit read-side invalid markers", () => {
    const fixture = writeSnapshotRun("20260713-010102-malformed-metadata", "malformed metadata\n");
    writeFileSync(
      workflowResultFile(fixture.runDir),
      JSON.stringify({
        runId: fixture.runId,
        ok: true,
        target: { kind: "name", ref: "alpha", source: "project" },
        workspaceDirExplicit: "true",
        semanticInputPresent: true,
        semanticInputSha256: "not-a-sha",
      }),
    );

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      workspaceDirExplicitInvalid: expect.any(String),
      semanticInputInvalid: expect.any(String),
    });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });

  it("rejects workspace explicitness without its complete workspace mapping", () => {
    const fixture = writeSnapshotRun("20260713-010102-explicit-without-workspace", "explicit without workspace\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, { workspaceDirExplicit: true });

    const result = readWorkflowRunResult(fixture.root, fixture.runId);
    expect(result).toMatchObject({ workspaceDirExplicitInvalid: expect.stringContaining("requires workspaceDir") });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });

  it("rejects a persisted workspace path that is an existing regular file", () => {
    const fixture = writeSnapshotRun("20260713-010102-workspace-file", "workspace file\n");
    const workspaceDir = path.join(fixture.root, "tmp", "not-a-directory");
    mkdirSync(path.dirname(workspaceDir), { recursive: true });
    writeFileSync(workspaceDir, "not a workspace");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir,
      workspaceDirRelative: "tmp/not-a-directory",
    });

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      workspaceDirInvalid: expect.stringContaining("must identify a directory"),
    });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });

  it("keeps a removed persisted workspace readable with an explicit unavailable marker", () => {
    const fixture = writeSnapshotRun("20260713-010102-workspace-removed-marker", "workspace removed marker\n");
    const workspaceDir = path.join(fixture.root, "tmp", "removed-marker");
    mkdirSync(workspaceDir, { recursive: true });
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, {
      workspaceDir,
      workspaceDirRelative: "tmp/removed-marker",
      workspacePhysicalIdentity: "tmp/removed-marker",
      workspacePhysicalIdentitySchemaVersion: 1,
      result: "still readable",
    });
    rmSync(workspaceDir, { recursive: true, force: true });

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      workspaceDirUnavailable: expect.stringContaining("unavailable"),
    });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({
      status: "ready",
      text: "still readable",
    });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("completed");
  });

  it.each([
    ["okInvalid", { ok: "true" }],
    ["errorInvalid", { error: 7 }],
    ["failureDiagnosticInvalid", { failureDiagnostic: {} }],
    ["artifactRefsInvalid", { artifactRefs: {} }],
    ["artifactRefsOmittedInvalid", { artifactRefsOmitted: 0 }],
    ["resultPersistenceInvalid", { resultPersistence: { ok: true, path: "wrong-result.json" } }],
  ] as const)("projects malformed present result field %s as invalid", (marker, metadata) => {
    const fixture = writeSnapshotRun(`20260713-010102-malformed-${marker}`, "malformed result field\n");
    writeResult(fixture.runDir, fixture.snapshotPath, fixture.sha256, undefined, metadata);

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({ [marker]: expect.any(String) });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({ status: "invalid" });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });

  it.each([
    { workspacePhysicalIdentity: "workspace" },
    { workspacePhysicalIdentitySchemaVersion: 1 },
    { workspacePhysicalIdentitySchemaVersion: 2 },
    { workspacePhysicalIdentity: "../escape", workspacePhysicalIdentitySchemaVersion: 1 },
  ])("projects malformed physical workspace metadata as invalid across result reads: %j", (metadata) => {
    const fixture = writeSnapshotRun("20260713-010102-malformed-physical", "malformed physical metadata\n");
    writeFileSync(
      workflowResultFile(fixture.runDir),
      JSON.stringify({
        ok: true,
        result: "ok",
        disposition: { status: "completed" },
        target: { kind: "name", ref: "post-code-review", source: "project" },
        ...metadata,
      }),
    );

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      workspacePhysicalIdentityInvalid: expect.any(String),
    });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("workspace physical identity"),
    });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });

  it("keeps legacy envelopes without optional metadata readable", () => {
    const root = temporaryRoot();
    const runId = "20260713-010102-legacy-metadata";
    const runDir = workflowRunDirectory(root, runId);
    mkdirSync(workflowRunRuntimeDir(runDir), { recursive: true });
    writeFileSync(workflowResultFile(runDir), JSON.stringify({ ok: true, result: "legacy" }));

    expect(readWorkflowRunResult(root, runId)).toEqual({
      ok: true,
      result: "legacy",
      runUnbound: "persisted result envelope has no runId",
    });
    expect(readWorkflowRunSummary(root, runId).status).toBe("completed");
  });

  it("keeps a removed but lexically matching scriptPath source readable", () => {
    const fixture = writeSnapshotRun("20260713-010102-removed-source", "removed source\n");
    const result = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<string, unknown>;
    result.target = { kind: "scriptPath", ref: "alpha.workflow.mjs", source: "project" };
    (result.scriptIdentity as Record<string, unknown>).sourcePath = path.join(fixture.root, "alpha.workflow.mjs");
    writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(result));
    expect(readWorkflowRunResult(fixture.root, fixture.runId)).not.toHaveProperty("scriptIdentityInvalid");
  });

  it.each([
    { ok: true, disposition: { status: "failed" } },
    { ok: true, disposition: { status: "future" } },
    { ok: "true", disposition: { status: "completed" } },
  ])("projects malformed persisted disposition %j as shared invalidity", (metadata) => {
    const fixture = writeSnapshotRun("20260713-010102-invalid-disposition", "invalid disposition\n");
    const result = JSON.parse(readFileSync(workflowResultFile(fixture.runDir), "utf8")) as Record<string, unknown>;
    Object.assign(result, metadata);
    writeFileSync(workflowResultFile(fixture.runDir), JSON.stringify(result));

    expect(readWorkflowRunResult(fixture.root, fixture.runId)).toMatchObject({
      dispositionInvalid: expect.any(String),
    });
    expect(readWorkflowRunResultText(fixture.root, fixture.runId)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("disposition is malformed or inconsistent"),
    });
    expect(readWorkflowRunSummary(fixture.root, fixture.runId).status).toBe("unknown");
  });
});
