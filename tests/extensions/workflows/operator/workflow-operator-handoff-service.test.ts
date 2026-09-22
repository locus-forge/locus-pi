import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindWorkflowHandoffClaim,
  claimWorkflowOperatorHandoff,
  createWorkflowOperatorHandoffEnvelope,
  readCurrentWorkflowScriptIdentity,
  readWorkflowHandoffClaim,
  type WorkflowOperatorHandoffEnvelope,
} from "../../../../extensions/workflows/runtime/workflow-handoff.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowTarget } from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowRunRuntimeDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowLaunchBindingFile } from "../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { WorkflowOperatorHandoffController } from "../../../../extensions/workflows/operator/operator-handoff-controller.js";
import { createWorkflowOperatorHandoffService } from "../../../../extensions/workflows/operator/operator-handoff-service.js";
import type { WorkflowCommandLaunchResult } from "../../../../extensions/workflows/launch/workflow-command-launcher.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithHandoff(
  runId: string,
  existingRoot?: string,
  options: { targetKind?: "name" | "scriptPath" } = {},
): string {
  const root = realpathSync(existingRoot ?? mkdtempSync(path.join(tmpdir(), "workflow-handoff-service-")));
  if (existingRoot === undefined) roots.push(root);
  const workflowsDir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  const sourcePath = path.join(workflowsDir, "alpha.workflow.mjs");
  writeFileSync(
    sourcePath,
    'export const meta={name:"alpha",description:"Alpha"}; export default async()=>({ok:true});\n',
    "utf8",
  );
  if (options.targetKind === "scriptPath") {
    writeFileSync(path.join(root, "entry.workflow.mjs"), readFileSync(sourcePath), "utf8");
  }
  const target =
    options.targetKind === "scriptPath"
      ? resolveWorkflowTarget({ scriptPath: "entry.workflow.mjs" }, root, root)
      : resolveWorkflowTarget({ script: "alpha" }, root, root);
  const currentIdentity = readCurrentWorkflowScriptIdentity(target.path);
  const runDir = ensureWorkflowRunDir(root, runId);
  const snapshotPath = path.join(workflowRunRuntimeDir(runDir), `script-${currentIdentity.scriptSha256}.workflow.mjs`);
  writeFileSync(snapshotPath, readFileSync(target.path));
  const scriptIdentity = {
    ...currentIdentity,
    sourcePath: target.path,
    snapshotPath,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinImports: [],
    unboundDependencies: [],
  };
  const artifactRef = { runId, artifactId: "intent", name: "intent.md", sha256: "0".repeat(64) };
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
  const workspaceDir = path.join(root, "handoff-workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    workflowResultFile(runDir),
    `${JSON.stringify({
      runId,
      ok: true,
      result: { mode: "prepared" },
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
      journal: [],
      resultPersistence: { ok: true, path: workflowResultFile(runDir) },
      workspaceDir,
      workspaceDirRelative: "handoff-workspace",
      workspaceDirExplicit: true,
      target,
      scriptIdentity,
      artifactRefs: [artifactRef],
      operatorHandoff,
    })}\n`,
    "utf8",
  );
  return root;
}

function corruptHandoff(root: string, runId: string): void {
  const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", runId));
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  result.operatorHandoff = { ...(result.operatorHandoff as Record<string, unknown>), title: 42 };
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}

function corruptPhysicalWorkspaceMetadata(
  root: string,
  runId: string,
  metadata: { workspacePhysicalIdentity?: string; workspacePhysicalIdentitySchemaVersion?: number },
): void {
  const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", runId));
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  Object.assign(result, metadata);
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}

function persistLaunchBinding(root: string, runId: string): void {
  const runDir = path.join(root, ".locus-pi", "runs", runId);
  const result = JSON.parse(readFileSync(workflowResultFile(runDir), "utf8")) as Record<string, unknown>;
  const target = result.target as {
    kind: "name" | "scriptPath";
    ref: string;
    source: "project" | "personal" | "package";
  };
  const scriptIdentity = result.scriptIdentity as Record<string, unknown>;
  const workspaceDir = result.workspaceDir as string;
  const workspaceDirRelative = result.workspaceDirRelative as string;
  const sha256 = createHash("sha256").update("").digest("hex");
  writeFileSync(
    workflowLaunchBindingFile(runDir),
    `${JSON.stringify({
      schema: "locus-pi.workflow-launch-binding.v1",
      runId,
      target: { kind: target.kind, ref: target.ref, source: target.source },
      scriptIdentity,
      workspace: {
        absolutePath: workspaceDir,
        relativePath: workspaceDirRelative,
        physicalPath: realpathSync(workspaceDir),
        physicalIdentity: workspaceDirRelative,
        physicalIdentitySchemaVersion: 1,
        explicit: result.workspaceDirExplicit === true,
      },
      semanticInput: { present: false, sha256 },
    })}\n`,
    "utf8",
  );
}

describe("workflow operator handoff service", () => {
  it("renders a verified blocker artifact beside three choices and custom input", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-handoff-detail-")));
    roots.push(root);
    mkdirSync(path.join(root, ".locus-pi", "workflows", "test-question"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "test-question", "answer.workflow.mjs"),
      `export default (dsl) => {
  const blocker = dsl.publishArtifact("planning-blocker.md", "# Planning Blocker\\n\\n## Question\\nWhich queue should own retries?\\n");
  dsl.awaitOperator({
    reason: "planning blocker",
    operatorHandoff: {
      title: "Resolve planning blocker",
      questions: [{
        kind: "select",
        id: "planning-decision",
        prompt: "Choose how planning should proceed.",
        detailArtifactRef: blocker,
        options: [
          { label: "Use the safest assumption" },
          { label: "Keep an explicit prerequisite" },
          { label: "Reduce to evidenced scope" }
        ],
        recommended: "Use the safest assumption",
        allowCustom: true
      }],
      continuationArtifactRefs: [blocker]
    }
  });
  return "blocked";
};
`,
      "utf8",
    );
    const sourceHarness = createHarness(root);
    const source = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      name: "test-question/answer",
      outputDir: "outputs/alpha",
    });
    expect(source.ok, source.error).toBe(true);

    const service = createWorkflowOperatorHandoffService({ launch: vi.fn(() => ({ status: "started" as const })) });
    const controller = new WorkflowOperatorHandoffController(service);
    const uiHarness = createHarness(root);
    uiHarness.customInputQueue.push("\r");

    await expect(controller.pump(uiHarness.ctx, { runId: source.runId })).resolves.toEqual({
      status: "started",
      sourceRunId: source.runId,
    });
    const frame = uiHarness.customRenderFrames[0]?.join("\n") ?? "";
    expect(frame).toContain("Which queue should own retries?");
    expect(frame).toContain("Use the safest assumption (Recommended)");
    expect(frame).toContain("Keep an explicit prerequisite");
    expect(frame).toContain("Reduce to evidenced scope");
    expect(frame).toContain("Other (type your own)");
  });

  it.each([
    { label: "identity-only", metadata: { workspacePhysicalIdentity: "handoff-workspace" } },
    {
      label: "mismatched-identity",
      metadata: { workspacePhysicalIdentity: "another-handoff-workspace", workspacePhysicalIdentitySchemaVersion: 1 },
    },
    { label: "schema-only", metadata: { workspacePhysicalIdentitySchemaVersion: 1 } },
    { label: "unsupported-schema", metadata: { workspacePhysicalIdentitySchemaVersion: 2 } },
    {
      label: "unsafe-identity",
      metadata: { workspacePhysicalIdentity: "../escape", workspacePhysicalIdentitySchemaVersion: 1 },
    },
  ])(
    "rejects present-invalid physical workspace metadata in scan/read/launch ($label)",
    async ({ label, metadata }) => {
      const runId = `20260725-140101-${label}`;
      const root = projectWithHandoff(runId);
      const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });
      const initial = service.scan(root).find((entry) => entry.status === "actionable");
      if (initial?.status !== "actionable") throw new Error("expected actionable handoff");
      corruptPhysicalWorkspaceMetadata(root, runId, metadata);

      expect(service.scan(root)).toEqual([
        {
          status: "invalid",
          runId,
          message: expect.stringContaining("workspace physical identity"),
        },
      ]);
      expect(service.read(root, runId)).toMatchObject({
        message: expect.stringContaining("workspace physical identity"),
      });
      const harness = createHarness(root);
      await expect(service.launch(initial.handoff, "Current changes", harness.ctx)).resolves.toMatchObject({
        status: "invalid",
        message: expect.stringContaining("workspace physical identity"),
      });
    },
  );

  it("preserves invalid durable scan evidence", () => {
    const runId = "20260725-140000-invalid";
    const root = projectWithHandoff(runId);
    corruptHandoff(root, runId);
    const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });

    expect(service.scan(root)).toEqual([
      {
        status: "invalid",
        runId,
        message: expect.stringContaining("operatorHandoff title"),
      },
    ]);
  });

  it("rejects a mutable result projection when a launch binding is present", () => {
    const runId = "20260725-140200-launch-binding-result-tamper";
    const root = projectWithHandoff(runId);
    persistLaunchBinding(root, runId);
    const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", runId));
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    result.workspaceDirRelative = "other-workspace";
    result.workspaceDir = path.join(root, "other-workspace");
    result.workspaceDirExplicit = false;
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");

    const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });
    expect(service.scan(root)).toEqual([
      { status: "invalid", runId, message: expect.stringContaining("no valid host launch binding") },
    ]);
    expect(service.read(root, runId)).toMatchObject({
      message: expect.stringContaining("no valid host launch binding"),
    });
  });

  it("rejects a post-code-review handoff with a missing launch binding in scan/read/launch", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-handoff-owner-missing-binding-")));
    roots.push(root);
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "post-code-review.workflow.mjs"),
      `export default (dsl) => {\n` +
        `  const intent = dsl.publishArtifact("intent.md", "review", "prepare");\n` +
        `  dsl.awaitOperator({ reason: "review", operatorHandoff: { title: "Review", questions: [{ kind: "select", id: "scope", prompt: "Scope", options: [{ label: "Current" }], recommended: "Current", allowCustom: true }], continuationArtifactRefs: [intent] } });\n` +
        `  return "done";\n` +
        `};\n`,
      "utf8",
    );
    const harness = createHarness(root);
    const source = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "outputs/owner-handoff",
    });
    expect(source.ok, source.error).toBe(true);
    const launch = vi.fn();
    const service = createWorkflowOperatorHandoffService({ launch });
    const initial = service.scan(root).find((entry) => entry.status === "actionable");
    if (initial?.status !== "actionable") throw new Error("expected actionable owner handoff");
    const bindingPath = workflowLaunchBindingFile(source.runDir);
    unlinkSync(bindingPath);
    expect(service.scan(root)).toEqual([
      { status: "invalid", runId: source.runId, message: expect.stringContaining("no valid host launch binding") },
    ]);
    expect(service.read(root, source.runId)).toMatchObject({
      message: expect.stringContaining("no valid host launch binding"),
    });
    await expect(service.launch(initial.handoff, "Current", harness.ctx)).resolves.toMatchObject({
      status: "invalid",
      message: expect.stringContaining("no valid host launch binding"),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("lets valid actionable evidence win over malformed history", async () => {
    const malformedRunId = "20260725-141000-malformed";
    const actionableRunId = "20260725-142000-actionable";
    const root = projectWithHandoff(malformedRunId);
    corruptHandoff(root, malformedRunId);
    projectWithHandoff(actionableRunId, root);
    const launch = vi.fn(() => ({ status: "started" as const }));
    const service = createWorkflowOperatorHandoffService({ launch });
    const controller = new WorkflowOperatorHandoffController(service);
    const harness = createHarness(root);
    harness.customInputQueue.push("\r");

    await expect(controller.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: actionableRunId,
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: expect.objectContaining({ originRunId: actionableRunId }),
      }),
    );
  });

  it.each([
    [{ status: "busy", owner: "active-run" } satisfies WorkflowCommandLaunchResult, "busy"],
    [{ status: "stale" } satisfies WorkflowCommandLaunchResult, "failed"],
  ])("releases its claim when the shared launcher returns $status", async (launchResult, expectedStatus) => {
    const runId = `20260725-14300${expectedStatus === "busy" ? "0" : "1"}-release`;
    const root = projectWithHandoff(runId);
    const launch = vi.fn(() => launchResult);
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toMatchObject({
      status: expectedStatus,
    });
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toEqual({ status: "absent" });
  });

  it("releases an unbound claim when the shared launcher throws before returning", async () => {
    const runId = "20260725-143002-throw-release";
    const root = projectWithHandoff(runId);
    const launch = vi.fn((): WorkflowCommandLaunchResult => {
      throw new Error("launcher exploded");
    });
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toEqual({
      status: "failed",
      message: "Workflow continuation launch failed before start: launcher exploded",
    });
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toEqual({ status: "absent" });
    expect(service.scan(root)).toContainEqual({ status: "actionable", handoff: item.handoff, state: "pending" });
  });

  it("reports both launch and claim-release failures without hiding the durable claim", async () => {
    const runId = "20260725-143003-throw-release-failure";
    const root = projectWithHandoff(runId);
    const claimLockPath = path.join(
      workflowRunRuntimeDir(path.join(root, ".locus-pi", "runs", runId)),
      "operator-handoff-claim.lock",
    );
    const launch = vi.fn((): WorkflowCommandLaunchResult => {
      writeFileSync(claimLockPath, "active\n", "utf8");
      throw new Error("launcher exploded");
    });
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toEqual({
      status: "failed",
      message:
        "Workflow continuation launch failed before start: launcher exploded Its unbound claim could not be released: Workflow handoff claim transition is active.",
    });
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toMatchObject({ status: "ready" });
  });

  it("distinguishes a never-answered handoff from one whose continuation failed", () => {
    const runId = "20260725-145000-retry-state";
    const childRunId = "20260725-145100-failed-child";
    const root = projectWithHandoff(runId);
    const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });

    expect(service.scan(root)).toContainEqual(expect.objectContaining({ status: "actionable", state: "pending" }));

    const claimed = claimWorkflowOperatorHandoff(
      root,
      (service.scan(root)[0] as { handoff: { value: WorkflowOperatorHandoffEnvelope } }).handoff.value,
    );
    if (claimed.status !== "claimed") throw new Error("expected a claimed handoff");
    bindWorkflowHandoffClaim(claimed.claim, childRunId);
    const childRunDir = ensureWorkflowRunDir(root, childRunId);
    writeFileSync(
      workflowResultFile(childRunDir),
      `${JSON.stringify({
        runId: childRunId,
        ok: false,
        disposition: { status: "failed" },
        journal: [],
        resultPersistence: { ok: true, path: workflowResultFile(childRunDir) },
        error: "plan was not accepted",
      })}\n`,
      "utf8",
    );

    const items = service.scan(root).filter((entry) => entry.status === "actionable");
    expect(items).toContainEqual(expect.objectContaining({ status: "actionable", state: "retryable" }));
    expect(items).not.toContainEqual(expect.objectContaining({ state: "pending" }));
  });

  it("rejects target script drift before claiming or launching", async () => {
    const runId = "20260725-144000-drift";
    const root = projectWithHandoff(runId);
    const launch = vi.fn(() => ({ status: "started" as const }));
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "alpha.workflow.mjs"),
      'export const meta={name:"alpha",description:"Changed"}; export default async()=>({ok:false});\n',
      "utf8",
    );
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toMatchObject({
      status: "invalid",
      message: expect.stringContaining("script identity has changed"),
    });
    expect(launch).not.toHaveBeenCalled();
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toEqual({ status: "absent" });
  });

  it("rejects a persisted absolute external scriptPath before it becomes actionable", () => {
    const runId = "20260725-144050-external-script-path";
    const root = projectWithHandoff(runId);
    const resultPath = workflowResultFile(path.join(root, ".locus-pi", "runs", runId));
    const persisted = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    const externalTarget = {
      kind: "scriptPath",
      ref: path.join(path.dirname(root), "outside.workflow.mjs"),
      source: "project",
    };
    persisted.target = externalTarget;
    persisted.operatorHandoff = {
      ...(persisted.operatorHandoff as Record<string, unknown>),
      target: externalTarget,
    };
    writeFileSync(resultPath, `${JSON.stringify(persisted)}\n`, "utf8");

    const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });
    expect(service.scan(root)).toContainEqual({
      status: "invalid",
      runId,
      message: expect.stringContaining("target is malformed"),
    });
  });

  it("resolves a persisted scriptPath target as a path and forwards its verified workspace", async () => {
    const runId = "20260725-144100-script-path";
    const root = projectWithHandoff(runId, undefined, { targetKind: "scriptPath" });
    const launch = vi.fn(() => ({ status: "started" as const }));
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toEqual({ status: "started" });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptRef: path.join(root, "entry.workflow.mjs"),
        operatorHandoffWorkspaceReuse: expect.objectContaining({ relativePath: "handoff-workspace" }),
        target: expect.objectContaining({
          kind: "scriptPath",
          ref: path.join(root, "entry.workflow.mjs"),
        }),
      }),
    );
  });
});
