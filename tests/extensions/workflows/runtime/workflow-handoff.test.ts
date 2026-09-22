import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkflowHandoffContinuationEligibility,
  bindWorkflowHandoffClaim,
  claimWorkflowOperatorHandoff,
  projectWorkflowHandoffState,
  readCurrentWorkflowScriptIdentity,
  readPersistedWorkflowOperatorHandoff,
  readWorkflowHandoffClaim,
  readWorkflowOperatorHandoff,
  releaseWorkflowHandoffClaim,
  workflowContinuationForHandoff,
  type WorkflowHandoffClaimOptions,
  type WorkflowOperatorHandoffEnvelope,
} from "../../../../extensions/workflows/runtime/workflow-handoff.js";
import {
  ensureWorkflowRunDir,
  workflowJournalFile,
  workflowRunDir,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  readWorkflowResumeWorkspaceIdentity,
  runWorkflowScript,
  type WorkflowHandoffWorkspaceReuseBinding,
} from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowTarget } from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-handoff-"));
  roots.push(root);
  const workflows = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    path.join(workflows, "source.workflow.mjs"),
    `export default async function run(dsl, input) {
  const continuation = dsl.continuationArtifacts();
  if (continuation.length > 0) {
    return input === "reject"
      ? { ok: false, summary: "operator answer rejected", input }
      : { ok: true, input, consumed: continuation.map((item) => item.consumedArtifact.text) };
  }
  const intentRef = dsl.publishArtifact("intent.md", "review current changes", "prepare");
  dsl.awaitOperator({
    reason: "review clarification required",
    operatorHandoff: {
      title: "Choose review scope",
      questions: [{
        kind: "select",
        id: "scope",
        prompt: "What should be reviewed?",
        options: [{ label: "Current changes" }, { label: "Last commit" }],
        recommended: "Current changes",
        allowCustom: true,
      }],
      continuationArtifactRefs: [intentRef],
    },
  });
  return { mode: "prepared", intentRef };
}
`,
    "utf8",
  );
  writeFileSync(
    path.join(workflows, "reason-only.workflow.mjs"),
    `export default async function run(dsl) {
  dsl.awaitOperator({ reason: "manual inspection required" });
  return { mode: "prepared" };
}
`,
    "utf8",
  );
  return root;
}

async function sourceRun(root: string): Promise<{
  handoff: WorkflowOperatorHandoffEnvelope;
  resultPath: string;
  resultBytes: string;
}> {
  const harness = createHarness(root);
  const result = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name: "source",
  });
  expect(result.disposition).toEqual({
    status: "awaiting_operator",
    detail: "review clarification required",
  });
  const read = readWorkflowOperatorHandoff(result);
  expect(read.status).toBe("ready");
  if (read.status !== "ready") throw new Error("expected ready handoff");
  const resultPath = workflowResultFile(result.runDir);
  return { handoff: read.handoff, resultPath, resultBytes: readFileSync(resultPath, "utf8") };
}

describe("workflow operator handoff", () => {
  it("keeps reason-only behavior unchanged and persists one runner-enriched generic envelope", async () => {
    const root = project();
    const harness = createHarness(root);
    const reasonOnly = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "reason-only",
    });
    expect(reasonOnly.result).toEqual({ mode: "prepared" });
    expect(reasonOnly).not.toHaveProperty("operatorHandoff");
    expect(readWorkflowOperatorHandoff(reasonOnly)).toEqual({ status: "absent" });

    const source = await sourceRun(root);
    const persisted = JSON.parse(source.resultBytes) as Record<string, unknown>;
    expect(persisted.result).toMatchObject({ mode: "prepared" });
    expect(persisted.operatorHandoff).toMatchObject({
      version: "locus.workflow.operator-handoff.v1",
      originRunId: source.handoff.originRunId,
      title: "Choose review scope",
      target: { kind: "name", ref: "source", source: "project" },
      scriptIdentity: { identityCoverage: "self-contained-static", executionSource: "snapshot" },
    });
    expect(source.handoff.handoffId).toMatch(/^handoff-[a-f0-9]{24}$/u);
    expect(source.handoff.continuationArtifactRefs).toEqual([
      expect.objectContaining({ runId: source.handoff.originRunId, name: "intent.md" }),
    ]);
    expect(readPersistedWorkflowOperatorHandoff(root, source.handoff.originRunId)).toEqual({
      status: "ready",
      handoff: source.handoff,
    });
  });

  it("claims a raw project scriptPath handoff and accepts a confined symlink alias", async () => {
    const root = project();
    symlinkSync("source.workflow.mjs", path.join(root, ".locus-pi", "workflows", "alias.workflow.mjs"));
    const sourceHarness = createHarness(root);
    const source = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      scriptPath: "./.locus-pi/workflows/alias.workflow.mjs",
    });
    const read = readWorkflowOperatorHandoff(source);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("expected ready handoff");
    expect(read.handoff.target).toEqual({
      kind: "scriptPath",
      ref: "./.locus-pi/workflows/alias.workflow.mjs",
      source: "project",
    });
    const claim = claimWorkflowOperatorHandoff(root, read.handoff);
    expect(claim).toMatchObject({ status: "claimed" });
    if (claim.status !== "claimed") throw new Error("expected claim");

    const continued = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      scriptPath: "./.locus-pi/workflows/alias.workflow.mjs",
      input: "operator answer",
      continuation: workflowContinuationForHandoff(read.handoff),
      operatorHandoffClaim: claim.claim,
    });
    expect(continued.ok).toBe(true);
    expect(continued.result).toEqual({
      ok: true,
      input: "operator answer",
      consumed: ["review current changes"],
    });

    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "other.workflow.mjs"),
      readFileSync(path.join(root, ".locus-pi", "workflows", "source.workflow.mjs"), "utf8"),
      "utf8",
    );
    const changedTarget = {
      ...read.handoff,
      target: { ...read.handoff.target, ref: "./.locus-pi/workflows/other.workflow.mjs" },
    };
    expect(claimWorkflowOperatorHandoff(root, changedTarget)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("does not match"),
    });
  });

  it("reads a run with no result.json as absent, and a symlinked one as invalid", () => {
    const root = project();
    const incompleteDir = workflowRunDir(root, "20260725-135526-6710");
    ensureWorkflowRunDir(root, "20260725-135526-6710");
    writeFileSync(
      workflowJournalFile(incompleteDir),
      `${JSON.stringify({ ts: "2026-07-25T13:55:26.000Z", runId: "20260725-135526-6710", kind: "phase", phase: "scout" })}\n`,
      "utf8",
    );

    // An interrupted or still-running run has a journal and no result yet. It
    // carries no handoff, so it must read as absent — never as corrupt evidence.
    expect(readPersistedWorkflowOperatorHandoff(root, "20260725-135526-6710")).toEqual({ status: "absent" });

    const danglingDir = workflowRunDir(root, "20260725-140000-aaaa");
    ensureWorkflowRunDir(root, "20260725-140000-aaaa");
    symlinkSync(path.join(root, "outside-result.json"), workflowResultFile(danglingDir));
    expect(readPersistedWorkflowOperatorHandoff(root, "20260725-140000-aaaa")).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("regular non-symlink file"),
    });
  });

  it("requires the exact canonical awaiting-operator disposition", async () => {
    const root = project();
    const source = await sourceRun(root);
    const persisted = JSON.parse(source.resultBytes) as Record<string, unknown>;
    const malformedDispositions: unknown[] = [
      { status: "awaiting_operator" },
      { status: "awaiting_operator", detail: 42 },
      { status: "awaiting_operator", reason: "legacy" },
      { status: "awaiting_operator", detail: "" },
      { status: "awaiting_operator", detail: "x".repeat(201) },
      { status: "awaiting_operator", detail: "input", future: true },
    ];

    for (const disposition of malformedDispositions) {
      expect(readWorkflowOperatorHandoff({ ...persisted, disposition })).toMatchObject({
        status: "invalid",
        message: expect.stringContaining("exact awaiting_operator disposition"),
      });
    }
  });

  it.each([
    { kind: "name", ref: " source", source: "project" },
    { kind: "name", ref: "source.workflow.mjs", source: "project" },
    { kind: "scriptPath", ref: "source.workflow.mjs", source: "personal" },
    { kind: "scriptPath", ref: "source.workflow.mjs", source: "package" },
    { kind: "name", ref: "source", source: "project", unexpected: true },
  ] as const)("rejects forged persisted handoff target identity %j", async (target) => {
    const root = project();
    const source = await sourceRun(root);
    const persisted = JSON.parse(source.resultBytes) as Record<string, unknown>;
    const forged = {
      ...persisted,
      target,
      operatorHandoff: {
        ...(persisted.operatorHandoff as Record<string, unknown>),
        target,
      },
    };

    expect(readWorkflowOperatorHandoff(forged)).toMatchObject({ status: "invalid" });
  });

  it("rejects a copied handoff envelope whose persisted runId names another run", async () => {
    const root = project();
    const source = await sourceRun(root);
    const persisted = JSON.parse(source.resultBytes) as Record<string, unknown>;
    persisted.runId = "20260713-010103-copied-handoff";

    expect(readWorkflowOperatorHandoff(persisted)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("originRunId does not match"),
    });
  });

  it("accepts a handoff with twelve questions, long text, and many options", () => {
    const declarations: unknown[] = [];
    const runtime = createWorkflowRuntime({
      runId: "unbounded-handoff",
      agentRunner: async () => {
        throw new Error("must not run");
      },
      onAwaitOperator: (declaration) => declarations.push(declaration),
    });

    runtime.dsl.awaitOperator({
      reason: "needs input",
      operatorHandoff: {
        // Past every product ceiling this contract used to hold: 8 questions,
        // 20 options, 200-character titles/labels, 500-character prompts.
        title: "T".repeat(400),
        questions: Array.from({ length: 12 }, (_, index) => ({
          kind: "select" as const,
          id: `question-${index + 1}`,
          prompt: `${"P".repeat(900)} ${index + 1}?`,
          options: Array.from({ length: 25 }, (_, optionIndex) => ({
            label: `${"L".repeat(250)}-${index + 1}-${optionIndex + 1}`,
          })),
        })),
        continuationArtifactRefs: Array.from({ length: 12 }, (_, index) => ({
          runId: "run",
          artifactId: `published-${String(index + 1).padStart(4, "0")}`,
          name: `Design review, round ${index + 1}.md`,
          sha256: "a".repeat(64),
        })),
      },
    });

    expect(declarations).toHaveLength(1);
    const declaration = declarations[0] as { operatorHandoff: { questions: unknown[] } };
    expect(declaration.operatorHandoff.questions).toHaveLength(12);
  });

  it("rejects malformed declarations before publication and distinguishes absent from present malformed", () => {
    const declarations: unknown[] = [];
    const runtime = createWorkflowRuntime({
      runId: "strict-handoff",
      agentRunner: async () => {
        throw new Error("must not run");
      },
      onAwaitOperator: (declaration) => declarations.push(declaration),
    });

    expect(() =>
      runtime.dsl.awaitOperator({
        reason: "needs input",
        operatorHandoff: {
          title: "Question",
          questions: [
            {
              kind: "select",
              id: "scope",
              prompt: "Scope?",
              options: [{ label: "A" }],
              recommended: "missing",
            },
          ],
          continuationArtifactRefs: [
            { runId: "run", artifactId: "artifact", name: "intent.md", sha256: "a".repeat(64) },
          ],
        },
      }),
    ).toThrow(/recommended label must match/u);
    expect(declarations).toEqual([]);

    expect(() =>
      runtime.dsl.awaitOperator({
        reason: "needs input",
        operatorHandoff: {
          title: "Question",
          questions: [
            {
              kind: "text",
              id: "answer",
              prompt: "Answer?",
              multiline: true,
            } as never,
          ],
          continuationArtifactRefs: [
            { runId: "run", artifactId: "artifact", name: "intent.md", sha256: "a".repeat(64) },
          ],
        },
      }),
    ).toThrow(/unexpected fields/u);
    expect(declarations).toEqual([]);

    runtime.dsl.awaitOperator({
      reason: "needs input",
      operatorHandoff: {
        title: "Question",
        questions: [{ kind: "text", id: "answer", prompt: "Answer?" }],
        continuationArtifactRefs: [{ runId: "run", artifactId: "artifact", name: "intent.md", sha256: "a".repeat(64) }],
      },
    });
    expect(declarations).toHaveLength(1);

    expect(readWorkflowOperatorHandoff({ runId: "legacy", ok: true })).toEqual({ status: "absent" });
    expect(
      readWorkflowOperatorHandoff({
        runId: "broken",
        ok: true,
        disposition: { status: "awaiting_operator", detail: "input" },
        operatorHandoff: { version: "future" },
      }),
    ).toMatchObject({ status: "invalid", message: expect.stringContaining("operatorHandoff") });
  });

  it("fails closed when a workflow forges a continuation artifact reference", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "forged.workflow.mjs"),
      `export default async function run(dsl) {
  const ref = dsl.publishArtifact("intent.md", "intent");
  dsl.awaitOperator({
    reason: "needs input",
    operatorHandoff: {
      title: "Question",
      questions: [{ kind: "text", id: "answer", prompt: "Answer?" }],
      continuationArtifactRefs: [{ ...ref, sha256: "0".repeat(64) }],
    },
  });
  return { mode: "prepared", intentRef: ref };
}
`,
      "utf8",
    );
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "forged",
    });
    expect(result.ok).toBe(false);
    expect(result.disposition).toEqual({ status: "failed" });
    expect(result.result).toMatchObject({ mode: "prepared" });
    expect(result.error).toContain("not present in the terminal artifact projection");
    expect(result).not.toHaveProperty("operatorHandoff");
  });

  it("requires question detail to be one of the verified continuation artifacts", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "detached-detail.workflow.mjs"),
      `export default async function run(dsl) {
  const intent = dsl.publishArtifact("intent.md", "intent");
  const detail = dsl.publishArtifact("planning-blocker.md", "question detail");
  dsl.awaitOperator({
    reason: "needs input",
    operatorHandoff: {
      title: "Question",
      questions: [{
        kind: "select",
        id: "answer",
        prompt: "Answer?",
        detailArtifactRef: detail,
        options: [{ label: "Continue" }]
      }],
      continuationArtifactRefs: [intent],
    },
  });
  return "prepared";
}
`,
      "utf8",
    );
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "detached-detail",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("detail artifact must be a continuation artifact");
    expect(result).not.toHaveProperty("operatorHandoff");
  });

  it("requires fresh self-contained target/script identity before continuation", async () => {
    const root = project();
    const { handoff } = await sourceRun(root);
    const target = resolveWorkflowTarget({ name: "source" }, root, root);
    const currentIdentity = readCurrentWorkflowScriptIdentity(target.path);
    expect(() =>
      assertWorkflowHandoffContinuationEligibility(handoff, { target, scriptIdentity: currentIdentity }),
    ).not.toThrow();

    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}\n// drift\n`, "utf8");
    expect(() =>
      assertWorkflowHandoffContinuationEligibility(handoff, {
        target,
        scriptIdentity: readCurrentWorkflowScriptIdentity(target.path),
      }),
    ).toThrow(/script identity has changed/u);

    expect(() =>
      assertWorkflowHandoffContinuationEligibility(
        {
          ...handoff,
          scriptIdentity: {
            ...handoff.scriptIdentity,
            identityCoverage: "entry-only",
            executionSource: "source",
          },
        },
        {
          target,
          scriptIdentity: {
            ...currentIdentity,
            identityCoverage: "entry-only",
            executionSource: "source",
          },
        },
      ),
    ).toThrow(/not self-contained-static/u);
  });

  it("claims once, stores no answer, releases launch failure, and recovers a stale pre-start claim", async () => {
    const root = project();
    const source = await sourceRun(root);
    const initialBytes = source.resultBytes;
    const claimedAt = new Date("2026-07-25T00:00:00.000Z");
    const first = claimWorkflowOperatorHandoff(root, source.handoff, { now: () => claimedAt });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected claim");
    const duplicate = claimWorkflowOperatorHandoff(root, source.handoff, { now: () => claimedAt });
    expect(duplicate).toMatchObject({ status: "active" });
    const claimRead = readWorkflowHandoffClaim(root, source.handoff);
    expect(claimRead).toMatchObject({ status: "ready" });
    expect(claimRead.status === "ready" ? claimRead.state : {}).not.toHaveProperty("childRunId");
    const claimText = readFileSync(
      path.join(workflowRunRuntimeDir(workflowRunDir(root, source.handoff.originRunId)), "operator-handoff-claim.json"),
      "utf8",
    );
    expect(claimText).not.toContain("operator answer");
    expect(releaseWorkflowHandoffClaim(first.claim)).toBe(true);
    expect(projectWorkflowHandoffState(root, source.handoff)).toEqual({ status: "pending" });

    const old = claimWorkflowOperatorHandoff(root, source.handoff, { now: () => claimedAt });
    expect(old.status).toBe("claimed");
    expect(
      projectWorkflowHandoffState(root, source.handoff, {
        now: () => new Date("2026-07-25T00:06:00.000Z"),
      }),
    ).toMatchObject({ status: "retryable" });
    const recovered = claimWorkflowOperatorHandoff(root, source.handoff, {
      now: () => new Date("2026-07-25T00:06:00.000Z"),
    });
    expect(recovered.status).toBe("claimed");
    expect(readFileSync(source.resultPath, "utf8")).toBe(initialBytes);
  });

  it("never lets a lease expiry alone authorize a duplicate claim", async () => {
    const root = project();
    const source = await sourceRun(root);
    const claimedAt = new Date("2026-07-25T00:00:00.000Z");
    // Hours past both lease timers (5-minute prestart, 30-second lock).
    const muchLater = new Date("2026-07-25T06:00:00.000Z");

    const first = claimWorkflowOperatorHandoff(root, source.handoff, { now: () => claimedAt });
    if (first.status !== "claimed") throw new Error("expected claim");
    const second = claimWorkflowOperatorHandoff(root, source.handoff, { now: () => muchLater });
    if (second.status !== "claimed") throw new Error("expected stale prestart takeover");

    // Expiry made the claim ELIGIBLE for takeover; ownership is what decides. The
    // displaced holder cannot write beside the winner, and cannot release its claim.
    expect(() => bindWorkflowHandoffClaim(first.claim, "20260725-000001-displaced")).toThrow(
      /no longer owns the active claim/u,
    );
    expect(() => releaseWorkflowHandoffClaim(first.claim)).toThrow(/no longer owns the active claim/u);

    // Once a continuation run is bound, the clock stops deciding anything: only a
    // failed or cancelled child releases the claim, and this one is neither.
    bindWorkflowHandoffClaim(second.claim, "20260725-000002-continuation");
    expect(claimWorkflowOperatorHandoff(root, source.handoff, { now: () => muchLater })).toMatchObject({
      status: "active",
    });
    expect(projectWorkflowHandoffState(root, source.handoff, { now: () => muchLater })).toMatchObject({
      status: "running",
      childRunId: "20260725-000002-continuation",
    });
  });

  it("uses the filesystem claim as the exclusion point across Node processes", async () => {
    const root = project();
    const source = await sourceRun(root);
    const [left, right] = await Promise.all([
      claimInChildProcess(root, source.handoff),
      claimInChildProcess(root, source.handoff),
    ]);
    expect([left.status, right.status].sort()).toEqual(["active", "claimed"]);
    const winner = left.status === "claimed" ? left : right;
    if (winner.status !== "claimed") throw new Error("expected one cross-process claim winner");
    expect(releaseWorkflowHandoffClaim(winner.claim)).toBe(true);
  });

  it("fences a paused stale lock owner from successor state and lock release", async () => {
    const root = project();
    const source = await sourceRun(root);
    const initial = claimWorkflowOperatorHandoff(root, source.handoff, {
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });
    expect(initial.status).toBe("claimed");
    const runDirectory = workflowRunDir(root, source.handoff.originRunId);
    const claimPath = path.join(workflowRunRuntimeDir(runDirectory), "operator-handoff-claim.json");
    const lockPath = path.join(workflowRunRuntimeDir(runDirectory), "operator-handoff-claim.lock");
    const successorState = {
      ...(JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>),
      claimId: "11111111-1111-4111-8111-111111111111",
      claimedAt: "2026-07-25T00:10:00.000Z",
    };
    const successorLock = {
      version: "locus.workflow.operator-handoff-claim-lock.v1",
      ownerToken: "22222222-2222-4222-8222-222222222222",
      acquiredAt: "2026-07-25T00:10:00.000Z",
    };
    let takeoverObserved = false;
    const options: WorkflowHandoffClaimOptions = {
      now: () => new Date("2026-07-25T00:10:00.000Z"),
    };
    Object.defineProperty(options, "prestartStaleMs", {
      enumerable: true,
      get(): number {
        const pausedOwner = JSON.parse(readFileSync(lockPath, "utf8")) as { ownerToken?: unknown };
        expect(pausedOwner.ownerToken).not.toBe(successorLock.ownerToken);
        writeFileSync(lockPath, `${JSON.stringify(successorLock)}\n`, "utf8");
        writeFileSync(claimPath, `${JSON.stringify(successorState)}\n`, "utf8");
        takeoverObserved = true;
        return 0;
      },
    });

    expect(claimWorkflowOperatorHandoff(root, source.handoff, options)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("lock ownership was lost"),
    });
    expect(takeoverObserved).toBe(true);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(successorState);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(successorLock);
  });

  it("binds inside the runner even when onRunStart throws and projects terminal child outcomes", async () => {
    const root = project();
    const source = await sourceRun(root);
    const first = claimWorkflowOperatorHandoff(root, source.handoff);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected claim");
    const harness = createHarness(root);
    const child = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "source",
      input: "operator answer",
      continuation: workflowContinuationForHandoff(source.handoff),
      operatorHandoffClaim: first.claim,
      onRunStart: () => {
        throw new Error("presentation failed");
      },
    });
    expect(child.ok).toBe(true);
    expect(readWorkflowHandoffClaim(root, source.handoff)).toMatchObject({
      status: "ready",
      state: { childRunId: child.runId },
    });
    expect(projectWorkflowHandoffState(root, source.handoff)).toEqual({
      status: "resolved",
      childRunId: child.runId,
    });
    const claimText = readFileSync(
      path.join(workflowRunRuntimeDir(workflowRunDir(root, source.handoff.originRunId)), "operator-handoff-claim.json"),
      "utf8",
    );
    expect(claimText).not.toContain("operator answer");
    expect(readFileSync(source.resultPath, "utf8")).toBe(source.resultBytes);

    const secondSource = await sourceRun(root);
    const secondClaim = claimWorkflowOperatorHandoff(root, secondSource.handoff);
    expect(secondClaim.status).toBe("claimed");
    if (secondClaim.status !== "claimed") throw new Error("expected claim");
    const failed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "source",
      input: "reject",
      continuation: workflowContinuationForHandoff(secondSource.handoff),
      operatorHandoffClaim: secondClaim.claim,
    });
    expect(failed.ok).toBe(false);
    expect(projectWorkflowHandoffState(root, secondSource.handoff)).toEqual({
      status: "retryable",
      childRunId: failed.runId,
      message: `Continuation run ${failed.runId} failed.`,
    });
    const retry = claimWorkflowOperatorHandoff(root, secondSource.handoff);
    expect(retry.status).toBe("claimed");
    if (retry.status !== "claimed") throw new Error("expected retry claim");
    expect(retry.claim.claimId).not.toBe(secondClaim.claim.claimId);
  });

  it("reuses the claimed post-code-review workspace without the fresh namespace gate", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "post-code-review.workflow.mjs"),
      readFileSync(path.join(root, ".locus-pi", "workflows", "source.workflow.mjs"), "utf8"),
      "utf8",
    );
    const sourceHarness = createHarness(root);
    const source = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "review alpha",
      outputDir: "tmp/post-code-review/continuation",
    });
    expect(source.disposition).toEqual({
      status: "awaiting_operator",
      detail: "review clarification required",
    });
    const read = readWorkflowOperatorHandoff(source);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("expected ready handoff");
    const claim = claimWorkflowOperatorHandoff(root, read.handoff);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected claim");
    const workspace = readWorkflowResumeWorkspaceIdentity(root, source.runId);
    const reuse: WorkflowHandoffWorkspaceReuseBinding = {
      sourceRunId: source.runId,
      ...workspace,
    };

    const child = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "operator answer",
      continuation: workflowContinuationForHandoff(read.handoff),
      operatorHandoffClaim: claim.claim,
      operatorHandoffWorkspaceReuse: reuse,
    });
    expect(child.ok).toBe(true);
    expect(child.result).toEqual({
      ok: true,
      input: "operator answer",
      consumed: ["review current changes"],
    });
    expect(child.workspaceDirRelative).toBe(source.workspaceDirRelative);
    expect(child.workspaceDirExplicit).toBe(true);
    expect(JSON.parse(readFileSync(workflowResultFile(child.runDir), "utf8"))).toMatchObject({
      workspaceDirRelative: source.workspaceDirRelative,
      workspaceDirExplicit: true,
    });
    expect(projectWorkflowHandoffState(root, read.handoff)).toEqual({
      status: "resolved",
      childRunId: child.runId,
    });

    const omittedResume = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      resumeFromRunId: child.runId,
    });
    expect(omittedResume.ok).toBe(false);
    expect(omittedResume.error).toContain("source workspace was selected explicitly");
  });

  it("reuses a generated default workspace when the working-directory path contains spaces", async () => {
    const root = project();
    const workingDirectory = path.join(root, "packages", "docs site");
    const workflows = path.join(workingDirectory, ".locus-pi", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      path.join(workflows, "whitespace-handoff.workflow.mjs"),
      readFileSync(path.join(root, ".locus-pi", "workflows", "source.workflow.mjs"), "utf8"),
      "utf8",
    );
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory };
    const source = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "whitespace-handoff",
    });
    const read = readWorkflowOperatorHandoff(source);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("expected ready handoff");
    const claim = claimWorkflowOperatorHandoff(root, read.handoff);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected claim");
    const workspace = readWorkflowResumeWorkspaceIdentity(root, source.runId);
    expect(workspace.relativePath).toBe(`.locus-pi/workspaces/${source.runId}-whitespace-handoff`);

    const child = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "whitespace-handoff",
      input: "operator answer",
      continuation: workflowContinuationForHandoff(read.handoff),
      operatorHandoffClaim: claim.claim,
      operatorHandoffWorkspaceReuse: {
        sourceRunId: source.runId,
        ...workspace,
      },
    });
    expect(child.ok).toBe(true);
    expect(child.result).toEqual({
      ok: true,
      input: "operator answer",
      consumed: ["review current changes"],
    });
    expect(child.workspaceDirRelative).toBe(workspace.relativePath);
  });

  it("fails closed on malformed or symlinked claim state", async () => {
    const root = project();
    const source = await sourceRun(root);
    const claimPath = path.join(
      workflowRunRuntimeDir(workflowRunDir(root, source.handoff.originRunId)),
      "operator-handoff-claim.json",
    );
    writeFileSync(claimPath, '{"version":"future"}\n', "utf8");
    expect(readWorkflowHandoffClaim(root, source.handoff)).toMatchObject({ status: "invalid" });
    expect(() => projectWorkflowHandoffState(root, source.handoff)).toThrow();

    rmSync(claimPath);
    const outside = path.join(root, "outside-claim.json");
    writeFileSync(outside, "{}\n", "utf8");
    symlinkSync(outside, claimPath);
    expect(claimWorkflowOperatorHandoff(root, source.handoff)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("non-symlink"),
    });
  });

  it("fails closed when the claim lock sidecar is replaced by a symlink", async () => {
    const root = project();
    const source = await sourceRun(root);
    const runDirectory = workflowRunDir(root, source.handoff.originRunId);
    const lockPath = path.join(workflowRunRuntimeDir(runDirectory), "operator-handoff-claim.lock");
    const outside = path.join(root, "outside-lock.json");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, lockPath);

    expect(claimWorkflowOperatorHandoff(root, source.handoff)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("non-symlink"),
    });
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("rejects a claim whose source does not match continuation before child binding", async () => {
    const root = project();
    const firstSource = await sourceRun(root);
    const secondSource = await sourceRun(root);
    const claim = claimWorkflowOperatorHandoff(root, firstSource.handoff);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected claim");
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "source",
      continuation: workflowContinuationForHandoff(secondSource.handoff),
      operatorHandoffClaim: claim.claim,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not match the continuation origin run");
    expect(projectWorkflowHandoffState(root, firstSource.handoff)).toEqual({ status: "pending" });
  });
});

function claimInChildProcess(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
): Promise<ReturnType<typeof claimWorkflowOperatorHandoff>> {
  const moduleUrl = pathToFileURL(path.resolve("extensions/workflows/runtime/workflow-handoff.ts")).href;
  const script = [
    `import { claimWorkflowOperatorHandoff } from ${JSON.stringify(moduleUrl)};`,
    "const input = JSON.parse(process.env.WORKFLOW_HANDOFF_TEST_INPUT);",
    "process.stdout.write(JSON.stringify(claimWorkflowOperatorHandoff(input.projectRoot, input.handoff)));",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        WORKFLOW_HANDOFF_TEST_INPUT: JSON.stringify({ projectRoot, handoff }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claim child exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as ReturnType<typeof claimWorkflowOperatorHandoff>);
    });
  });
}
