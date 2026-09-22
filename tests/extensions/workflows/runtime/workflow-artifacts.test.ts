import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import {
  writeAgentRunResultArtifact,
  type AgentExecutor,
  type AgentRunRequest,
} from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowArtifactStore,
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
  type WorkflowArtifactIndex,
  type WorkflowArtifactPorts,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  workflowRunArtifactsDir,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import * as workflowRunLayout from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { parseWorkflowPersistedBinding } from "../../../../extensions/workflows/runtime/workflow-persisted-binding.js";
import {
  createWorkflowRuntime,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { hostRequest, runHost } from "../../../fixtures/agent-runtime/agent-failure-probes.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-artifacts-"));
  roots.push(root);
  return root;
}

function runDir(root: string, runId: string): string {
  const dir = path.join(root, ".locus-pi", "runs", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("workflow run artifact store", () => {
  it("returns child evidence destinations lazily", () => {
    const root = project(),
      id = "lazy-child-evidence";
    const { transcriptDir, resultArtifactsDir } = createWorkflowArtifactStore({
      projectRoot: root,
      runId: id,
      runDir: runDir(root, id),
    }).childEvidenceDestinations("call-0001");
    assert.deepEqual([existsSync(transcriptDir), existsSync(resultArtifactsDir)], [false, false]);
  });

  it.each([
    ["transcripts", "parent"],
    ["transcripts", "leaf"],
    ["results", "parent"],
    ["results", "leaf"],
  ] as const)("writes no %s evidence through a pre-existing %s symlink", async (zone, link) => {
    const root = project(),
      outside = project(),
      id = `linked-${zone}-${link}`;
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    const parent = path.join(store.artifactsDir, zone);
    if (link === "leaf") mkdirSync(parent);
    symlinkSync(outside, link === "parent" ? parent : path.join(parent, "call-0001"));
    // The bridge's order: request destinations, real SDK transcript export, real result envelope.
    const refusal = await (async () => {
      const destinations = store.childEvidenceDestinations("call-0001");
      const result = await runHost({ lastAssistantText: "answer" }, { reportsDir: destinations.transcriptDir });
      writeAgentRunResultArtifact(root, hostRequest(), result, destinations.resultArtifactsDir);
    })().catch((error: unknown) => error);
    assert.deepEqual(readdirSync(outside, { recursive: true }), [], "zero outside writes, not merely a late error");
    assert.match(String(refusal), /Workflow run directory is unsafe/u);
  });

  it("refuses an unclaimed execution directory instead of creating a flat run", () => {
    const root = project();
    const id = "unclaimed-child";
    const directory = path.join(root, ".locus-pi", "runs", id);
    assert.throws(
      () => createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: directory }),
      /claimed execution|missing|ENOENT/u,
    );
    assert.equal(existsSync(directory), false);
  });

  it("reads persisted indexes and bytes without creating missing runtime state", () => {
    const root = project();
    const absent = readWorkflowArtifactIndex(root, "absent-run");
    assert.equal(absent.status, "missing");
    assert.equal(existsSync(path.join(root, ".pi")), false);

    const id = "reader-run";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    const ref = store.publishText("reader.md", "reader bytes");
    assert.match(store.list()[0]?.relativePath ?? "", /published-0001-reader\.md$/u);
    const index = readWorkflowArtifactIndex(root, id);
    const record = readWorkflowArtifactRecord(root, id, ref.artifactId);

    assert.equal(index.status, "ready");
    assert.equal(record.status, "ready");
    if (record.status === "ready") assert.equal(record.bytes.toString("utf8"), "reader bytes");
    assert.equal(readWorkflowArtifactRecord(root, id, "missing-id").status, "missing");
    assert.equal(readWorkflowArtifactIndex(root, "../escape").status, "invalid");
  });

  it("indexes operator answers under a stable identity and detects payload tampering", () => {
    const root = project();
    const id = "operator-ask-run";
    const directory = runDir(root, id);
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: directory });
    const record = {
      tool: "workflow_ask" as const,
      toolCallId: "tool-call-7",
      declined: false,
      entries: [
        {
          id: "storage",
          question: "Which storage?",
          status: "answered" as const,
          answer: "sqlite",
          kind: "option" as const,
        },
      ],
    };

    const ref = store.recordOperatorAskEvidence("call-0003", record.toolCallId, 2, record);

    assert.equal(ref.artifactId, "call-0003-operator-ask-0002");
    const indexed = store.list().find((entry) => entry.artifactId === ref.artifactId);
    assert.deepEqual(indexed, {
      runId: id,
      artifactId: ref.artifactId,
      name: "operator-ask-0002.json",
      sha256: ref.sha256,
      kind: "operator-ask",
      mediaType: "application/json",
      size: Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
      relativePath: path.join("operator-asks", "call-0003", "operator-ask-0002.json"),
      provenance: "fresh",
      createdAt: indexed?.createdAt,
      callId: "call-0003",
      toolCallId: "tool-call-7",
      sequence: 2,
    });
    const read = readWorkflowArtifactRecord(root, id, ref.artifactId);
    assert.equal(read.status, "ready");
    if (read.status === "ready") assert.deepEqual(JSON.parse(read.bytes.toString("utf8")), record);

    writeFileSync(path.join(workflowRunArtifactsDir(directory), indexed!.relativePath), "tampered\n");
    assert.equal(readWorkflowArtifactRecord(root, id, ref.artifactId).status, "tampered");
  });

  it("rejects mismatched operator-answer identity before writing an artifact", () => {
    const root = project();
    const id = "operator-ask-invalid";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    const record = { tool: "workflow_ask" as const, toolCallId: "tool-a", declined: true, entries: [] };

    assert.throws(
      () => store.recordOperatorAskEvidence("call-0001", "tool-b", 1, record),
      /toolCallId does not match/u,
    );
    assert.equal(store.list().length, 0);
  });

  it("classifies a dangling index as invalid and refuses to replace it", () => {
    const root = project();
    const id = "dangling-index";
    const directory = runDir(root, id);
    const artifactsDir = workflowRunArtifactsDir(directory);
    mkdirSync(artifactsDir, { recursive: true });
    const indexPath = path.join(artifactsDir, "index.json");
    const missingTarget = path.join(root, "missing-index-target.json");
    symlinkSync(missingTarget, indexPath);

    const passive = readWorkflowArtifactIndex(root, id);
    assert.equal(passive.status, "invalid");
    if (passive.status === "invalid") assert.match(passive.message, /unsafe/u);
    assert.throws(() => createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: directory }), /unsafe/u);
    assert.equal(lstatSync(indexPath).isSymbolicLink(), true, "dangling symlink remains unchanged");
    assert.equal(existsSync(missingTarget), false, "outside target remains absent");
  });

  it("persists exactly one explicitly primary publication", () => {
    const root = project();
    const id = "primary-run";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });

    const ref = store.publishText("plan.md", "accepted plan", "finalize", "primary");

    assert.equal(ref.name, "plan.md");
    assert.equal(store.list()[0]?.kind, "primary");
    assert.throws(
      () => store.publishText("other.md", "other", "finalize", "primary"),
      /already contains a primary output/u,
    );
  });

  it("publishes and consumes only a complete verified prior-run text reference", () => {
    const root = project();
    const sourceRunId = "source-run";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const sourceRef = source.publishText("plan.md", "exact plan", "prepare");
    const terminalResult = {
      mode: "prepared",
      intentRef: sourceRef,
      questionsRef: { ...sourceRef, artifactId: "published-0002", name: "questions.md" },
    };
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        runId: sourceRunId,
        ok: true,
        result: terminalResult,
        artifactRefs: [sourceRef],
        target: { kind: "name", ref: "review", source: "package" },
      })}\n`,
    );

    const currentRunId = "current-run";
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: currentRunId,
      runDir: runDir(root, currentRunId),
    });
    const consumed = current.consumeText(sourceRef, "execute");

    assert.equal(consumed.text, "exact plan");
    assert.equal(consumed.ref.runId, currentRunId);
    assert.deepEqual(consumed.source, {
      runId: sourceRunId,
      target: { kind: "name", ref: "review", source: "package" },
      artifact: { kind: "published", stage: "prepare" },
      terminal: { result: terminalResult, artifactRefs: [sourceRef] },
    });
    assert.deepEqual(current.list().find((entry) => entry.artifactId === consumed.ref.artifactId)?.source, sourceRef);
    assert.throws(
      () => current.consumeText({ ...sourceRef, sha256: "0".repeat(64) }),
      /does not match its source index/u,
    );
    assert.throws(() => current.consumeText(consumed.ref), /self-reference/u);
    assert.throws(() => current.consumeText({ ...sourceRef, runId: "../escape" }), /Invalid workflow artifact runId/u);
  });

  it.each(["external snapshot path", "wrong snapshot hash", "snapshot from another run"] as const)(
    "rejects a source identity with %s",
    (corruption) => {
      const root = project();
      const sourceRunId = "snapshot-binding-source";
      const sourceRunDir = runDir(root, sourceRunId);
      const source = createWorkflowArtifactStore({ projectRoot: root, runId: sourceRunId, runDir: sourceRunDir });
      const sourceRef = source.publishText("plan.md", "exact plan");
      const snapshotBytes = Buffer.from("snapshot bytes\n", "utf8");
      const snapshotSha256 = createHash("sha256").update(snapshotBytes).digest("hex");
      const expectedSnapshot = path.join(workflowRunRuntimeDir(sourceRunDir), `script-${snapshotSha256}.workflow.mjs`);
      mkdirSync(workflowRunRuntimeDir(sourceRunDir), { recursive: true });
      writeFileSync(expectedSnapshot, snapshotBytes);
      const wrongHash = "a".repeat(64);
      const wrongHashSnapshot = path.join(workflowRunRuntimeDir(sourceRunDir), `script-${wrongHash}.workflow.mjs`);
      if (corruption === "wrong snapshot hash") writeFileSync(wrongHashSnapshot, snapshotBytes);
      const snapshotPath =
        corruption === "external snapshot path"
          ? path.join(root, "outside.workflow.mjs")
          : corruption === "snapshot from another run"
            ? path.join(root, ".locus-pi", "runs", "other-run", "runtime", `script-${snapshotSha256}.workflow.mjs`)
            : corruption === "wrong snapshot hash"
              ? wrongHashSnapshot
              : expectedSnapshot;
      const identitySha256 = corruption === "wrong snapshot hash" ? wrongHash : snapshotSha256;
      const result = {
        runId: sourceRunId,
        ok: true,
        result: "done",
        target: { kind: "name", ref: "task/plan", source: "package" },
        scriptIdentity: {
          schemaVersion: 2,
          identityPolicy: "static-node-only-v1",
          sourcePath: path.resolve("extensions/workflows/examples/task/plan.workflow.mjs"),
          snapshotPath,
          scriptSha256: identitySha256,
          identityCoverage: "self-contained-static",
          executionSource: "snapshot",
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          builtinImports: [],
          unboundDependencies: [],
        },
        artifactRefs: [sourceRef],
      };
      writeFileSync(workflowResultFile(sourceRunDir), `${JSON.stringify(result)}\n`);

      const current = createWorkflowArtifactStore({
        projectRoot: root,
        runId: "snapshot-binding-consumer",
        runDir: runDir(root, "snapshot-binding-consumer"),
      });
      assert.throws(() => current.consumeText(sourceRef), /snapshot/u);
    },
  );

  it("rejects a v2 script identity without a persisted target before consuming artifacts", () => {
    const root = project();
    const sourceRunId = "unbound-v2-source";
    const sourceRunDir = runDir(root, sourceRunId);
    const source = createWorkflowArtifactStore({ projectRoot: root, runId: sourceRunId, runDir: sourceRunDir });
    const sourceRef = source.publishText("plan.md", "exact plan");
    const snapshotSha256 = "a".repeat(64);
    const result = {
      runId: sourceRunId,
      ok: true,
      result: "done",
      artifactRefs: [sourceRef],
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        sourcePath: path.resolve("extensions/workflows/examples/task/plan.workflow.mjs"),
        snapshotPath: path.join(workflowRunRuntimeDir(sourceRunDir), `script-${snapshotSha256}.workflow.mjs`),
        scriptSha256: snapshotSha256,
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        builtinImports: [],
        unboundDependencies: [],
      },
    };
    writeFileSync(workflowResultFile(sourceRunDir), `${JSON.stringify(result)}\n`);

    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "unbound-v2-consumer",
      runDir: runDir(root, "unbound-v2-consumer"),
    });
    assert.throws(() => current.consumeText(sourceRef), /not usable|malformed script identity/u);
  });

  it("consumes a source artifact with a valid exact snapshot binding", () => {
    const root = project();
    const sourceRunId = "snapshot-binding-valid-source";
    const sourceRunDir = runDir(root, sourceRunId);
    const source = createWorkflowArtifactStore({ projectRoot: root, runId: sourceRunId, runDir: sourceRunDir });
    const sourceRef = source.publishText("plan.md", "exact plan");
    const snapshotBytes = Buffer.from("snapshot bytes\n", "utf8");
    const snapshotSha256 = createHash("sha256").update(snapshotBytes).digest("hex");
    const snapshotPath = path.join(workflowRunRuntimeDir(sourceRunDir), `script-${snapshotSha256}.workflow.mjs`);
    mkdirSync(workflowRunRuntimeDir(sourceRunDir), { recursive: true });
    writeFileSync(snapshotPath, snapshotBytes);
    writeFileSync(
      workflowResultFile(sourceRunDir),
      `${JSON.stringify({
        runId: sourceRunId,
        ok: true,
        result: "done",
        target: { kind: "name", ref: "task/plan", source: "package" },
        scriptIdentity: {
          schemaVersion: 2,
          identityPolicy: "static-node-only-v1",
          sourcePath: path.resolve("extensions/workflows/examples/task/plan.workflow.mjs"),
          snapshotPath,
          scriptSha256: snapshotSha256,
          identityCoverage: "self-contained-static",
          executionSource: "snapshot",
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          builtinImports: [],
          unboundDependencies: [],
        },
        artifactRefs: [sourceRef],
      })}\n`,
    );
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "snapshot-binding-valid-consumer",
      runDir: runDir(root, "snapshot-binding-valid-consumer"),
    });
    const originalResolve = workflowRunLayout.resolveWorkflowRunDir;
    const resolve = vi.spyOn(workflowRunLayout, "resolveWorkflowRunDir").mockImplementation((projectRoot, runId) => {
      const resolved = originalResolve(projectRoot, runId);
      if (runId === sourceRunId) {
        mkdirSync(path.join(runDir(root, "duplicate-source-group"), "children", sourceRunId), { recursive: true });
      }
      return resolved;
    });
    assert.equal(current.consumeText(sourceRef).text, "exact plan");
    assert.equal(resolve.mock.calls.length, 1);
  });

  it("binds present Package sources to inventory depth while preserving removed history", () => {
    const root = project();
    const runId = "inventory-binding";
    mkdirSync(runDir(root, runId), { recursive: true });
    const snapshotPath = path.join(
      root,
      ".locus-pi",
      "runs",
      runId,
      "runtime",
      `script-${"a".repeat(64)}.workflow.mjs`,
    );
    const identity = (sourcePath: string) => ({
      schemaVersion: 2,
      identityPolicy: "static-node-only-v1",
      sourcePath,
      snapshotPath,
      scriptSha256: "a".repeat(64),
      identityCoverage: "self-contained-static",
      executionSource: "snapshot",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      builtinImports: [],
      unboundDependencies: [],
    });
    const present = parseWorkflowPersistedBinding(
      {
        target: { kind: "name", ref: "task/plan", source: "package" },
        scriptIdentity: identity(path.resolve("extensions/workflows/examples/task/plan.workflow.mjs")),
      },
      root,
      runId,
    );
    assert.equal(present.scriptIdentityInvalid, undefined);

    const removedPackage = parseWorkflowPersistedBinding(
      {
        target: { kind: "name", ref: "plan", source: "package" },
        scriptIdentity: identity(path.resolve("extensions/workflows/examples/removed/deep/plan.workflow.mjs")),
      },
      root,
      runId,
    );
    assert.equal(removedPackage.scriptIdentityInvalid, undefined, "removed package history remains readable");

    const removedPersonal = parseWorkflowPersistedBinding(
      {
        target: { kind: "name", ref: "plan", source: "personal" },
        scriptIdentity: identity(
          path.join(homedir(), ".locus-pi", "workflows", "removed", "deep", "plan.workflow.mjs"),
        ),
      },
      root,
      runId,
    );
    assert.equal(removedPersonal.scriptIdentityInvalid, undefined, "removed personal history remains readable");
  });

  it.each([
    [
      "identity leaf ordering",
      (record: Record<string, unknown>) => {
        record.scriptIdentity = {
          schemaVersion: 2,
          identityPolicy: "static-node-only-v1",
          sourcePath: path.join(process.cwd(), "extensions/workflows/examples/task/plan.workflow.mjs"),
          snapshotPath: "/tmp/script-a.workflow.mjs",
          scriptSha256: "a".repeat(64),
          identityCoverage: "self-contained-static",
          executionSource: "snapshot",
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          builtinImports: ["node:z", "node:a"],
          unboundDependencies: [],
        };
      },
    ],
    [
      "disposition mismatch",
      (record: Record<string, unknown>) => {
        record.ok = true;
        record.disposition = { status: "failed" };
      },
    ],
  ] as const)("uses canonical persisted binding for continuation: %s", (_name, corrupt) => {
    const root = project();
    const sourceRunId = "binding-owner-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const sourceRef = source.publishText("plan.md", "exact plan");
    const result = {
      runId: sourceRunId,
      ok: true,
      target: { kind: "name", ref: "plan", source: "package" },
      artifactRefs: [sourceRef],
      result: "done",
    } as Record<string, unknown>;
    corrupt(result);
    writeFileSync(workflowResultFile(runDir(root, sourceRunId)), `${JSON.stringify(result)}\n`);
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "binding-owner-consumer",
      runDir: runDir(root, "binding-owner-consumer"),
    });

    assert.throws(() => current.consumeText(sourceRef), /malformed (?:script identity|disposition)/u);
  });

  it("writes and consumes a 3 MiB text artifact: size is not a policy", () => {
    const root = project();
    const sourceRunId = "large-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const large = "L".repeat(3 * 1024 * 1024);
    const sourceRef = source.publishText("large.md", large);
    assert.equal(source.read(sourceRef).byteLength, 3 * 1024 * 1024);
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        runId: sourceRunId,
        ok: true,
        result: "done",
        artifactRefs: [sourceRef],
        target: { kind: "name", ref: "review", source: "package" },
      })}\n`,
    );
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "large-consumer",
      runDir: runDir(root, "large-consumer"),
    });

    assert.equal(current.consumeText(sourceRef).text, large);
  });

  it("consumes an indexed source artifact omitted from the terminal display projection", () => {
    const root = project();
    const sourceRunId = "projected-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const projectedRef = source.publishText("projected.md", "projected");
    const omittedRef = source.publishText("omitted.md", "omitted");
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        runId: sourceRunId,
        ok: true,
        result: "projected",
        artifactRefs: [projectedRef],
        artifactRefsOmitted: 1,
        target: { kind: "name", ref: "review", source: "package" },
      })}\n`,
    );
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "projection-consumer",
      runDir: runDir(root, "projection-consumer"),
    });

    assert.equal(current.consumeText(omittedRef).text, "omitted");
    assert.equal(current.consumeText(projectedRef).text, "projected");
  });

  it("rejects a copied source result envelope whose runId names another run", () => {
    const root = project();
    const sourceRunId = "bound-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const sourceRef = source.publishText("plan.md", "exact plan");
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        runId: "different-source",
        ok: true,
        target: { kind: "name", ref: "review", source: "package" },
        artifactRefs: [sourceRef],
      })}\n`,
    );

    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "bound-consumer",
      runDir: runDir(root, "bound-consumer"),
    });
    assert.throws(() => current.consumeText(sourceRef), /belongs to another run/u);
    assert.equal(
      current.list().some((record) => record.kind === "input"),
      false,
    );
  });

  it("rejects a legacy source result envelope without a persisted runId", () => {
    const root = project();
    const sourceRunId = "unbound-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const sourceRef = source.publishText("plan.md", "exact plan");
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        ok: true,
        target: { kind: "name", ref: "review", source: "package" },
        artifactRefs: [sourceRef],
      })}\n`,
    );
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "unbound-consumer",
      runDir: runDir(root, "unbound-consumer"),
    });

    assert.throws(() => current.consumeText(sourceRef), /no valid persisted runId/u);
  });

  it("keeps missing source indexes side-effect free and rejects missing source target identity", () => {
    const root = project();
    const currentId = "lineage-reader";
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: currentId,
      runDir: runDir(root, currentId),
    });
    const missingIndexRun = "legacy-source";
    const legacyDir = runDir(root, missingIndexRun);
    mkdirSync(workflowRunRuntimeDir(legacyDir), { recursive: true });
    writeFileSync(
      workflowResultFile(legacyDir),
      `${JSON.stringify({
        runId: missingIndexRun,
        ok: true,
        target: { kind: "name", ref: "review", source: "package" },
      })}\n`,
    );
    const legacyRef = {
      runId: missingIndexRun,
      artifactId: "published-0001",
      name: "plan.md",
      sha256: "a".repeat(64),
    };

    assert.throws(() => current.consumeText(legacyRef), /index is missing/u);
    assert.equal(existsSync(path.join(workflowRunArtifactsDir(legacyDir), "index.json")), false);

    const noTargetRun = "missing-target-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: noTargetRun,
      runDir: runDir(root, noTargetRun),
    });
    const ref = source.publishText("plan.md", "bytes");
    writeFileSync(
      workflowResultFile(runDir(root, noTargetRun)),
      `${JSON.stringify({ runId: noTargetRun, ok: true })}\n`,
    );
    assert.throws(() => current.consumeText(ref), /not usable/u);
    assert.equal(
      current.list().some((record) => record.kind === "input"),
      false,
    );
  });

  it.each([
    { kind: "name", ref: " review", source: "package" },
    { kind: "name", ref: "review.workflow.mjs", source: "package" },
    { kind: "scriptPath", ref: "review.workflow.mjs", source: "personal" },
    { kind: "scriptPath", ref: "review.workflow.mjs", source: "package" },
    { kind: "name", ref: "review", source: "package", unexpected: true },
    { kind: "scriptPath", ref: "review.workflow.mjs", source: "project", path: 42 },
  ] as const)("rejects forged source-run target identity %j", (target) => {
    const root = project();
    const sourceRunId = "forged-target-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const sourceRef = source.publishText("plan.md", "exact plan");
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({ runId: sourceRunId, ok: true, target, artifactRefs: [sourceRef] })}\n`,
    );
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "forged-target-consumer",
      runDir: runDir(root, "forged-target-consumer"),
    });

    assert.throws(() => current.consumeText(sourceRef), /invalid target identity/u);
  });

  it.each(["external", "dangling", "directory"] as const)(
    "rejects target-only scriptPath %s leaf during artifact provenance",
    (kind) => {
      const root = project();
      const sourceRunId = "target-only-leaf-source";
      const source = createWorkflowArtifactStore({
        projectRoot: root,
        runId: sourceRunId,
        runDir: runDir(root, sourceRunId),
      });
      const sourceRef = source.publishText("plan.md", "exact plan");
      const targetPath = path.join(root, ".locus-pi", "workflows", "target.workflow.mjs");
      mkdirSync(path.dirname(targetPath), { recursive: true });
      if (kind === "external") {
        const external = path.join(path.dirname(root), "external-target-only.workflow.mjs");
        writeFileSync(external, "external");
        symlinkSync(external, targetPath);
      } else if (kind === "dangling") {
        symlinkSync(path.join(root, "missing.workflow.mjs"), targetPath);
      } else {
        mkdirSync(targetPath);
      }
      writeFileSync(
        workflowResultFile(runDir(root, sourceRunId)),
        `${JSON.stringify({
          runId: sourceRunId,
          ok: true,
          target: { kind: "scriptPath", ref: ".locus-pi/workflows/target.workflow.mjs", source: "project" },
          artifactRefs: [sourceRef],
        })}\n`,
      );
      const current = createWorkflowArtifactStore({
        projectRoot: root,
        runId: "target-only-leaf-consumer",
        runDir: runDir(root, "target-only-leaf-consumer"),
      });

      assert.throws(() => current.consumeText(sourceRef), /invalid target identity/u);
    },
  );

  it("removes orphan bytes after index persistence failure so retry can succeed", () => {
    const root = project();
    const id = "recover-index-failure";
    let sabotageIndex = false;
    let indexPath = "";
    const store = createWorkflowArtifactStore({
      projectRoot: root,
      runId: id,
      runDir: runDir(root, id),
      now() {
        if (sabotageIndex) writeFileSync(indexPath, "externally changed\n");
        return "2026-07-22T00:00:00.000Z";
      },
    });
    indexPath = path.join(store.artifactsDir, "index.json");
    const originalIndex = readFileSync(indexPath);
    const destination = path.join(store.artifactsDir, "published", "published-0001-retry.md");

    sabotageIndex = true;
    assert.throws(() => store.publishText("retry.md", "first attempt"), /index changed outside its owner/u);
    assert.equal(existsSync(destination), false);

    sabotageIndex = false;
    writeFileSync(indexPath, originalIndex);
    const ref = store.publishText("retry.md", "second attempt");
    assert.equal(store.read(ref).toString("utf8"), "second attempt");
  });

  it("refuses tampered bytes, corrupt indexes, and symlink destinations", () => {
    const root = project();
    const firstId = "tamper-run";
    const firstDir = runDir(root, firstId);
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: firstId, runDir: firstDir });
    const ref = store.publishText("report.md", "original");
    const record = store.list().find((entry) => entry.artifactId === ref.artifactId)!;
    writeFileSync(path.join(store.artifactsDir, record.relativePath), "changed");
    assert.throws(() => store.read(ref), /digest mismatch/u);
    assert.equal(readWorkflowArtifactRecord(root, firstId, ref.artifactId).status, "tampered");

    writeFileSync(path.join(store.artifactsDir, "index.json"), "{broken");
    assert.throws(
      () => createWorkflowArtifactStore({ projectRoot: root, runId: firstId, runDir: firstDir }),
      /index is corrupt/u,
    );

    const linkId = "link-run";
    const linked = createWorkflowArtifactStore({ projectRoot: root, runId: linkId, runDir: runDir(root, linkId) });
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(linked.artifactsDir, "published"));
    assert.throws(() => linked.publishText("escape.md", "no"), /unsafe/u);
  });

  it("rejects symlinked canonical-root ancestors before external artifact reads or writes", () => {
    for (const linkedAncestor of [".locus-pi", "runs"] as const) {
      const root = project();
      const external = project();
      const id = `ancestor-${linkedAncestor.replace(".", "")}`;
      const externalLocusPi = path.join(external, "external-locus-pi");
      const externalRuns = path.join(external, "external-runs");
      const externalRunDir =
        linkedAncestor === ".locus-pi" ? path.join(externalLocusPi, "runs", id) : path.join(externalRuns, id);
      mkdirSync(externalRunDir, { recursive: true });

      if (linkedAncestor === ".locus-pi") {
        symlinkSync(externalLocusPi, path.join(root, ".locus-pi"));
      } else {
        mkdirSync(path.join(root, ".locus-pi"));
        symlinkSync(externalRuns, path.join(root, ".locus-pi", "runs"));
      }

      const externalArtifacts = workflowRunArtifactsDir(externalRunDir);
      assert.throws(
        () =>
          createWorkflowArtifactStore({
            projectRoot: root,
            runId: id,
            runDir: path.join(root, ".locus-pi", "runs", id),
          }),
        /(?:directory|run path) is unsafe/u,
      );
      assert.equal(existsSync(externalArtifacts), false, `${linkedAncestor}: no external artifact write`);

      mkdirSync(externalArtifacts, { recursive: true });
      writeFileSync(path.join(externalArtifacts, "index.json"), "{externally controlled");
      const indexRead = readWorkflowArtifactIndex(root, id);
      assert.equal(indexRead.status, "invalid", `${linkedAncestor}: external index rejected`);
      if (indexRead.status === "invalid") {
        assert.match(
          indexRead.message,
          /(?:directory|run path) is unsafe/u,
          `${linkedAncestor}: rejected before external parse`,
        );
      }
      assert.equal(readWorkflowArtifactRecord(root, id, "published-0001").status, "invalid");
    }
  });

  it("allocates distinct call identities before parallel scheduling and persists text before failure propagation", async () => {
    const calls: string[] = [];
    const sequence: string[] = [];
    const ports: WorkflowArtifactPorts = {
      recordAgentEvidence(input) {
        calls.push(input.callId);
        sequence.push(`persist:${input.text}`);
        return {};
      },
      publishText() {
        throw new Error("unused");
      },
      consumeText() {
        throw new Error("unused");
      },
    };
    const runtime = createWorkflowRuntime({
      runId: "parallel-identities",
      artifactPorts: ports,
      onEvent(line) {
        if (line.kind === "agent_end") sequence.push(`end:${line.status}`);
      },
      agentRunner: async (request: WorkflowAgentRequest) => ({
        ok: request.prompt !== "bad",
        status: request.prompt === "bad" ? "failed" : "completed",
        summary: request.prompt,
        text: request.prompt === "bad" ? "partial answer" : request.prompt,
        diagnostics: [],
        agent: request.agent,
      }),
    });

    await runtime.dsl.parallel([
      () => runtime.dsl.agent("one", { label: "one" }),
      () => runtime.dsl.agent("two", { label: "two" }),
    ]);
    await assert.rejects(runtime.dsl.agent("bad"), WorkflowAgentExecutionError);

    assert.deepEqual(calls, ["call-0001", "call-0002", "call-0003"]);
    assert.ok(sequence.indexOf("persist:partial answer") < sequence.indexOf("end:failed"));
  });

  it("fails a successful child when automatic answer persistence fails", async () => {
    const runtime = createWorkflowRuntime({
      runId: "write-failure",
      artifactPorts: {
        recordAgentEvidence() {
          throw new Error("injected index write failure");
        },
        publishText() {
          throw new Error("unused");
        },
        consumeText() {
          throw new Error("unused");
        },
      },
      agentRunner: async (request) => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: "must persist",
        diagnostics: [],
        agent: request.agent,
      }),
    });

    await assert.rejects(runtime.dsl.agent("work"), /injected index write failure/u);
    assert.equal(
      runtime.getJournal().some((line) => line.kind === "agent_end"),
      false,
    );
    assert.equal(
      runtime.getJournal().some((line) => line.kind === "error"),
      true,
    );
  });

  it("wires exact answers, child transcripts, and result envelopes below one run root", async () => {
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "evidence.workflow.mjs"),
      'export default async function runWorkflow(dsl) { return { ok: true, answer: await dsl.agent("answer", { artifact: "review.md" }) }; }\n',
    );
    const harness = createHarness(root, { sessionId: "artifact-parent" });
    const createExecutor = (options: { reportsDir?: string }): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        assert.ok(options.reportsDir !== undefined);
        mkdirSync(options.reportsDir, { recursive: true });
        const childId = "child-evidence";
        const tracePath = path.join(options.reportsDir, "child.jsonl");
        writeFileSync(tracePath, `${JSON.stringify({ type: "session", id: childId })}\n`);
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
          childSession: { id: childId, createdAt: "now", metadata: {} },
          childTrace: { path: tracePath, format: "pi-session-jsonl", childSessionId: childId },
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "evidence",
      createExecutor,
    });

    assert.equal(result.ok, true, result.error);
    const index = JSON.parse(
      readFileSync(path.join(workflowRunArtifactsDir(result.runDir), "index.json"), "utf8"),
    ) as WorkflowArtifactIndex;
    assert.deepEqual(index.artifacts.map((entry) => entry.kind).sort(), ["answer", "result", "transcript"]);
    assert.ok(index.artifacts.every((entry) => !path.isAbsolute(entry.relativePath)));
    assert.equal(index.artifacts.find((entry) => entry.kind === "answer")?.name, "review.md");
    assert.ok(
      index.artifacts.every((entry) =>
        path
          .resolve(workflowRunArtifactsDir(result.runDir), entry.relativePath)
          .startsWith(workflowRunArtifactsDir(result.runDir)),
      ),
    );
  });

  it("persists a replayed answer with provenance and fabricates no transcript", async () => {
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "replay.workflow.mjs"),
      'export default async function runWorkflow(dsl) { return { ok: true, answer: await dsl.agent("same") }; }\n',
    );
    const harness = createHarness(root, { sessionId: "replay-parent" });
    let executions = 0;
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        executions += 1;
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "recorded answer",
          text: "recorded answer",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "replay",
      createExecutor,
    });
    const replay = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "replay",
      createExecutor,
      resumeFromRunId: first.runId,
    });

    assert.equal(first.ok, true, first.error);
    assert.equal(replay.ok, true, replay.error);
    assert.equal(executions, 1);
    const index = JSON.parse(
      readFileSync(path.join(workflowRunArtifactsDir(replay.runDir), "index.json"), "utf8"),
    ) as WorkflowArtifactIndex;
    assert.deepEqual(
      index.artifacts.map((entry) => entry.kind),
      ["answer"],
    );
    assert.equal(index.artifacts[0]?.provenance, "replay");
    assert.equal(index.artifacts[0]?.replaySourceRunId, first.runId);
  });

  it.each(["deleted", "wrong-byte", "symlinked"] as const)(
    "refuses resume when the source snapshot is %s before replay",
    async (mutation) => {
      const root = project();
      mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
      writeFileSync(
        path.join(root, ".agents", "agents", "default.md"),
        "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
      );
      mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
      writeFileSync(
        path.join(root, ".locus-pi", "workflows", "replay-snapshot.workflow.mjs"),
        'export default async function runWorkflow(dsl) { return { answer: await dsl.agent("same") }; }\n',
      );
      const harness = createHarness(root, { sessionId: `replay-snapshot-${mutation}` });
      let executions = 0;
      const createExecutor = (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          executions += 1;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "recorded answer",
            text: "recorded answer",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      });
      const first = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "replay-snapshot",
        createExecutor,
      });
      assert.equal(first.ok, true, first.error);
      assert.ok(first.scriptIdentity?.snapshotPath);
      const snapshotPath = first.scriptIdentity.snapshotPath;
      if (mutation === "deleted") {
        rmSync(snapshotPath);
      } else if (mutation === "wrong-byte") {
        chmodSync(snapshotPath, 0o644);
        writeFileSync(snapshotPath, "tampered snapshot bytes\n");
      } else {
        const outside = path.join(root, "outside.workflow.mjs");
        writeFileSync(outside, "outside snapshot bytes\n");
        rmSync(snapshotPath);
        symlinkSync(outside, snapshotPath);
      }

      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "replay-snapshot",
        createExecutor,
        resumeFromRunId: first.runId,
      });
      assert.equal(resumed.ok, false);
      assert.match(resumed.error ?? "", /unusable retained snapshot|snapshot/u);
      assert.equal(executions, 1, "resume must fail before replayed or fresh child work starts");
    },
  );
});
