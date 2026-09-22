/**
 * The PERSISTED artifact format: the version string, the exact JSON keys the index
 * carries, the strict parsers that refuse an unknown or malformed field, and the ref
 * identity projection every caller names an artifact with.
 *
 * The mutable store — digests, adoption, provenance and continuation — is proven in
 * workflow-artifacts.test.ts. What is proven here is only what the file IS.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  parseWorkflowArtifactIndex,
  parseWorkflowArtifactRecord,
  sameWorkflowArtifactRef,
  workflowArtifactRef,
  WORKFLOW_ARTIFACT_INDEX_VERSION,
  type WorkflowArtifactRecord,
} from "../../../../extensions/workflows/runtime/workflow-artifact-format.js";
import {
  createWorkflowArtifactStore,
  readWorkflowArtifactIndex,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-artifact-format-"));
  roots.push(root);
  return root;
}

function runDir(root: string, runId: string): string {
  const dir = path.join(root, ".locus-pi", "runs", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("workflow artifact format", () => {
  it("writes the declared version and exactly the persisted keys", () => {
    const root = project();
    const id = "format-envelope";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    store.publishText("report.md", "bytes", "review");

    const raw = JSON.parse(readFileSync(path.join(store.artifactsDir, "index.json"), "utf8")) as Record<
      string,
      unknown
    >;

    assert.equal(raw.version, "locus.workflow.artifacts.v1");
    assert.equal(raw.version, WORKFLOW_ARTIFACT_INDEX_VERSION);
    assert.deepEqual(Object.keys(raw).sort(), ["artifacts", "runId", "version"]);
    const record = (raw.artifacts as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(Object.keys(record).sort(), [
      "artifactId",
      "createdAt",
      "kind",
      "mediaType",
      "name",
      "provenance",
      "relativePath",
      "runId",
      "sha256",
      "size",
      "stage",
    ]);
  });

  it("parses a persisted index and refuses a foreign envelope", () => {
    const root = project();
    const id = "format-parse";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    store.publishText("report.md", "bytes");
    const raw = readFileSync(path.join(store.artifactsDir, "index.json"), "utf8");

    const parsed = parseWorkflowArtifactIndex(raw, id);
    assert.equal(parsed.version, WORKFLOW_ARTIFACT_INDEX_VERSION);
    assert.equal(parsed.runId, id);
    assert.equal(parsed.artifacts.length, 1);

    assert.throws(() => parseWorkflowArtifactIndex(raw, "another-run"), /invalid envelope/u);
    assert.throws(() => parseWorkflowArtifactIndex("{broken", id), /index is corrupt/u);
    const wrongVersion = JSON.stringify({ ...JSON.parse(raw), version: "locus.workflow.artifacts.v2" });
    assert.throws(() => parseWorkflowArtifactIndex(wrongVersion, id), /invalid envelope/u);
  });

  it("refuses a record whose kind, provenance, size or path is not the declared shape", () => {
    const base: Record<string, unknown> = {
      runId: "shape-run",
      artifactId: "published-0001",
      name: "report.md",
      sha256: "a".repeat(64),
      kind: "published",
      mediaType: "text/markdown; charset=utf-8",
      size: 5,
      relativePath: path.join("published", "published-0001-report.md"),
      provenance: "published",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(parseWorkflowArtifactRecord({ ...base }, "shape-run"), base);
    assert.throws(() => parseWorkflowArtifactRecord({ ...base }, "other-run"), /invalid record run id/u);
    assert.throws(() => parseWorkflowArtifactRecord({ ...base, kind: "sketch" }, "shape-run"), /kind\/provenance/u);
    assert.throws(
      () => parseWorkflowArtifactRecord({ ...base, provenance: "guessed" }, "shape-run"),
      /kind\/provenance/u,
    );
    assert.throws(() => parseWorkflowArtifactRecord({ ...base, size: -1 }, "shape-run"), /invalid size/u);
    assert.throws(() => parseWorkflowArtifactRecord({ ...base, size: 1.5 }, "shape-run"), /invalid size/u);
    assert.throws(() => parseWorkflowArtifactRecord({ ...base, sha256: "nope" }, "shape-run"), /invalid sha256/u);
    assert.throws(
      () => parseWorkflowArtifactRecord({ ...base, relativePath: path.join("..", "escape.md") }, "shape-run"),
      /relative path is unsafe/u,
    );
    assert.throws(
      () => parseWorkflowArtifactRecord({ ...base, kind: "operator-ask" }, "shape-run"),
      /missing its stable identity/u,
    );
    assert.throws(
      () => parseWorkflowArtifactRecord({ ...base, toolCallId: "tool-a", sequence: 1 }, "shape-run"),
      /operator-ask identity fields/u,
    );
  });

  it("refuses malformed optional metadata and unknown persisted fields", () => {
    const corruptions: Array<[string, (record: Record<string, unknown>) => void]> = [
      ["callId type", (record) => (record.callId = 42)],
      ["callId value", (record) => (record.callId = "../escape")],
      ["stage", (record) => (record.stage = { name: "prepare" })],
      ["childSessionId", (record) => (record.childSessionId = null)],
      ["source", (record) => (record.source = { runId: "source" })],
      ["replaySourceRunId", (record) => (record.replaySourceRunId = [])],
      ["unknown", (record) => (record.untrusted = true)],
    ];

    for (const [name, corrupt] of corruptions) {
      const root = project();
      const id = `invalid-${name.replaceAll(/[^a-z]+/gu, "-")}`;
      const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
      store.publishText("record.md", "bytes");
      const indexPath = path.join(store.artifactsDir, "index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as { artifacts: Array<Record<string, unknown>> };
      corrupt(index.artifacts[0]!);
      writeFileSync(indexPath, `${JSON.stringify(index)}\n`);

      const read = readWorkflowArtifactIndex(root, id);
      assert.equal(read.status, "invalid", name);
    }

    const root = project();
    const id = "invalid-index-envelope";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    const indexPath = path.join(store.artifactsDir, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    index.untrusted = true;
    writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
    assert.equal(readWorkflowArtifactIndex(root, id).status, "invalid");
  });

  it("projects a ref as exactly the four identity fields and compares only those", () => {
    const record: WorkflowArtifactRecord = {
      runId: "projection-run",
      artifactId: "published-0001",
      name: "report.md",
      sha256: "b".repeat(64),
      kind: "published",
      mediaType: "text/markdown; charset=utf-8",
      size: 5,
      relativePath: path.join("published", "published-0001-report.md"),
      provenance: "published",
      createdAt: "2026-01-01T00:00:00.000Z",
      stage: "review",
      callId: "call-0001",
    };

    const ref = workflowArtifactRef(record);

    assert.deepEqual(ref, {
      runId: "projection-run",
      artifactId: "published-0001",
      name: "report.md",
      sha256: "b".repeat(64),
    });
    assert.deepEqual(Object.keys(ref), ["runId", "artifactId", "name", "sha256"]);
    assert.notEqual(ref, record, "the projection is a new object, never the record itself");

    assert.equal(sameWorkflowArtifactRef(record, ref), true, "a record equals its own projection");
    assert.equal(sameWorkflowArtifactRef(ref, workflowArtifactRef(ref)), true);
    for (const field of ["runId", "artifactId", "name", "sha256"] as const) {
      assert.equal(sameWorkflowArtifactRef(ref, { ...ref, [field]: "different" }), false, field);
    }
  });
});
