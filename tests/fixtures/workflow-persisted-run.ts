/**
 * Fixtures that write ONE persisted workflow run the way a finished run leaves
 * it on disk: `runtime/result.json` plus the hash-named source snapshot beside
 * it. Reader and operator suites consume those bytes from different owners — the result
 * envelope (`workflow-result.ts`) and the snapshot verifier
 * (`workflow-run-snapshot.ts`) — so the writer stays in one place rather than
 * drifting into independent copies. Current handoff fixtures additionally use
 * production workspace, binding and text-artifact writers.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureWorkflowRunDir, workflowRunRuntimeDir } from "../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile, writeWorkflowResultJson } from "../../extensions/workflows/runtime/workflow-result.js";

import { createWorkflowArtifactStore } from "../../extensions/workflows/runtime/workflow-artifacts.js";
import { resolveWorkflowTarget } from "../../extensions/workflows/runtime/workflow-discovery.js";
import { createWorkflowOperatorHandoffEnvelope } from "../../extensions/workflows/runtime/workflow-handoff.js";
import { workflowRecoveryInputHash } from "../../extensions/workflows/runtime/workflow-interrupted-recovery.js";
import {
  createWorkflowLaunchBinding,
  projectWorkflowLaunchBindingOntoResult,
  writeWorkflowLaunchBinding,
} from "../../extensions/workflows/runtime/workflow-launch-binding.js";
import { resolveWorkflowWorkspaceDirectory } from "../../extensions/workflows/runtime/workflow-output.js";
import { workflowSemanticInputIdentity } from "../../extensions/workflows/runtime/workflow-run-resume.js";
import { createWorkflowScriptSnapshot } from "../../extensions/workflows/runtime/workflow-script-identity.js";

export interface PersistedRunTarget {
  kind: "name" | "scriptPath";
  ref: string;
  source: "project" | "personal" | "package";
  path?: string;
}

export interface PersistedRunFixture {
  root: string;
  runId: string;
  runDir: string;
  source: string;
  sha256: string;
  snapshotPath: string;
  sourcePath: string;
}

/** The exact digest the snapshot filename and `scriptSha256` are derived from. */
export function digest(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

export interface PersistedRunFixtures {
  /** Remove every temporary root this factory handed out. Call from `afterEach`. */
  cleanup: () => void;
  temporaryRoot: () => string;
  workflowRunDirectory: (root: string, runId: string) => string;
  writeSnapshotRun: (runId: string, source: string) => PersistedRunFixture;
  writeResult: (
    runDir: string,
    snapshotPath: string,
    sha256: string,
    target?: PersistedRunTarget,
    metadata?: Record<string, unknown>,
  ) => void;
}

export function createPersistedRunFixtures(prefix: string): PersistedRunFixtures {
  const roots: string[] = [];

  function temporaryRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function workflowRunDirectory(root: string, runId: string): string {
    return path.join(root, ".locus-pi", "runs", runId);
  }

  function writeSnapshotRun(runId: string, source: string): PersistedRunFixture {
    const root = temporaryRoot();
    const runDir = workflowRunDirectory(root, runId);
    const sourcePath = path.join(root, ".locus-pi", "workflows", "alpha.workflow.mjs");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
    const sha256 = digest(source);
    const snapshotPath = path.join(workflowRunRuntimeDir(runDir), `script-${sha256}.workflow.mjs`);
    mkdirSync(workflowRunRuntimeDir(runDir), { recursive: true });
    writeFileSync(snapshotPath, source);
    writeResult(runDir, snapshotPath, sha256);
    return { root, runId, runDir, source, sha256, snapshotPath, sourcePath };
  }

  function writeResult(
    runDir: string,
    snapshotPath: string,
    sha256: string,
    target: PersistedRunTarget = {
      kind: "name",
      ref: "alpha",
      source: "project",
    },
    metadata: Record<string, unknown> = {},
  ): void {
    const projectRoot = path.dirname(path.dirname(path.dirname(runDir)));
    const sourcePath =
      target.path ??
      (target.kind === "scriptPath"
        ? path.resolve(projectRoot, target.ref)
        : path.join(projectRoot, ".locus-pi", "workflows", `${target.ref}.workflow.mjs`));
    writeFileSync(
      workflowResultFile(runDir),
      JSON.stringify({
        runId: path.basename(runDir),
        ok: true,
        target,
        scriptIdentity: {
          schemaVersion: 2,
          identityPolicy: "static-node-only-v1",
          sourcePath,
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
        ...metadata,
      }),
    );
  }

  return {
    cleanup(): void {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    },
    temporaryRoot,
    workflowRunDirectory,
    writeSnapshotRun,
    writeResult,
  };
}

/** Current actionable handoff evidence; controllers can launch it without legacy authority shortcuts. */
export function writeNativeHandoffRun(root: string, runId: string, targetKind: "name" | "scriptPath" = "name"): void {
  const sourcePath = path.join(root, ".locus-pi", "workflows", "alpha.workflow.mjs");
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(
    sourcePath,
    'export const meta={name:"alpha",description:"Alpha"}; export default async()=>({ok:true});\n',
  );
  if (targetKind === "scriptPath") writeFileSync(path.join(root, "entry.workflow.mjs"), readFileSync(sourcePath));
  const target = resolveWorkflowTarget(
    targetKind === "scriptPath" ? { scriptPath: "entry.workflow.mjs" } : { name: "alpha" },
    root,
    root,
  );
  const runDir = ensureWorkflowRunDir(root, runId);
  const scriptIdentity = createWorkflowScriptSnapshot(target.path, workflowRunRuntimeDir(runDir));
  const artifactRef = createWorkflowArtifactStore({ projectRoot: root, runId, runDir }).publishText(
    "intent.md",
    "review current changes",
    "prepare",
  );
  const operatorHandoff = createWorkflowOperatorHandoffEnvelope({
    declaration: {
      title: "Review clarification",
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose review scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
          recommended: "Current changes",
          allowCustom: true,
        },
      ],
      continuationArtifactRefs: [artifactRef],
    },
    runId,
    target,
    scriptIdentity,
    terminalArtifactRefs: [artifactRef],
  });
  const binding = createWorkflowLaunchBinding({
    runId,
    rootLineageId: runId,
    recoveryInputSha256: workflowRecoveryInputHash({ items: [], budget: { concurrency: 4 } }),
    target: { kind: target.kind, ref: target.ref, source: target.source },
    scriptIdentity,
    workspace: resolveWorkflowWorkspaceDirectory(root, "handoff-workspace", "alpha", root),
    workspaceExplicit: true,
    semanticInput: workflowSemanticInputIdentity(undefined),
  });
  writeWorkflowLaunchBinding(runDir, binding);
  const result = {
    runId,
    ok: true,
    result: { mode: "prepared" },
    disposition: { status: "awaiting_operator", detail: "review clarification required" },
    journal: [],
    resultPersistence: { ok: true as const, path: workflowResultFile(runDir) },
    artifactRefs: [artifactRef],
    operatorHandoff,
  };
  const persisted = writeWorkflowResultJson(runDir, projectWorkflowLaunchBindingOntoResult(result, binding));
  if (!persisted.ok) throw new Error(persisted.message);
}
