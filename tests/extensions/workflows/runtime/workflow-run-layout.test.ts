import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { buildRunDetailBlock } from "../../../../extensions/workflows/run/run-evidence.js";
import { WorkflowRunViewer } from "../../../../extensions/workflows/run/run-viewer.js";
import { composeWorkflowChildTask } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import * as workflowArtifacts from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { readWorkflowArtifactRecord } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import * as workflowJournal from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  listWorkflowRunIds,
  listWorkflowRootRunIds,
  listWorkflowRuns,
  readWorkflowRunJournal,
  readWorkflowRunJournalState,
  readWorkflowRunResult,
  readWorkflowRunResultText,
  readWorkflowRunScriptSnapshot,
  readWorkflowRunSummary,
  resolveWorkflowRunId,
  workflowPersistedResultInvalidity,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import * as workflowRunLayout from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  assertWorkflowRunId,
  ensureWorkflowRunDir,
  replaceWorkflowRunFileAtomically,
  workflowJournalFile,
  resolveWorkflowRunDir,
  workflowStorageRootRunId,
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
  workflowRunFileExists,
  workflowRunDir,
  workflowRunsRootDir,
  workflowLegacyRunMigrationMessage,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { readWorkflowReplayLog } from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  readWorkflowResumeWorkspaceIdentity,
  runWorkflowScript,
} from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-layout-"));
  roots.push(root);
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "default.md"),
    "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
  );
  mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
  return root;
}

function workflowWorkspaceFromChildTask(task: string): string {
  const line = task
    .split("\n")
    .find((candidate) => candidate.startsWith("workflow workspace (durable workflow files and evidence): "));
  const directory = line?.split(": ").slice(1).join(": ");
  assert.ok(
    directory !== undefined && path.isAbsolute(directory),
    `child task must name an absolute workspace: ${task}`,
  );
  return directory;
}

describe("workflow workspace and run evidence", () => {
  it("uses a unique .locus-pi/workspaces workspace, gives every child that path once, and keeps run evidence separate", async () => {
    const root = project();
    const workingDirectory = path.join(root, "packages", "docs site");
    mkdirSync(workingDirectory, { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "files.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  const answer = await dsl.agent("write the plan", { label: "writer" });',
        "  return `${dsl.outputDir()}\\n${answer}`;",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "run-files" });
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory };
    const tasks: string[] = [];
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        tasks.push(request.task);
        writeFileSync(path.join(workflowWorkspaceFromChildTask(request.task), "plan.md"), "the plan body", "utf8");
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "wrote plan.md",
          text: "wrote plan.md",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "files",
      createExecutor,
    });

    const workspaceDir = path.join(root, ".locus-pi", "workspaces", `${result.runId}-files`);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDir, workspaceDir);
    assert.equal(result.workspaceDirRelative, `.locus-pi/workspaces/${result.runId}-files`);
    assert.equal(String(result.result).split("\n")[0], `.locus-pi/workspaces/${result.runId}-files`);
    const persisted = readWorkflowRunResult(root, result.runId);
    assert.equal(persisted?.workspacePhysicalIdentity, `.locus-pi/workspaces/${result.runId}-files`);
    assert.equal(persisted?.workspacePhysicalIdentityInvalid, undefined);
    assert.deepEqual(readdirSync(workspaceDir), [".workflow-runs.md", "plan.md"]);
    assert.equal(readFileSync(path.join(workspaceDir, "plan.md"), "utf8"), "the plan body");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.split(workspaceDir).length - 1, 1);

    const outputNames = readdirSync(workflowRunOutputsDir(workflowRunDir(root, result.runId))).sort();
    assert.deepEqual(outputNames, ["README.md", "workflow-result.md"]);
    assert.ok(!outputNames.includes("plan.md"));
    assert.deepEqual(readdirSync(result.runDir).sort(), ["README.md", "outputs", "runtime"]);
    assert.ok(readdirSync(workflowRunRuntimeDir(result.runDir)).includes("journal.ndjson"));
    assert.match(result.runDir, /\.locus-pi\/runs\//u);
  });

  it("keeps generated workspaces under .locus-pi/workspaces from a deep working directory", async () => {
    const root = project();
    const workingDirectory = path.join(root, "p".repeat(150), "q".repeat(150), "r".repeat(150));
    mkdirSync(workingDirectory, { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "long-default.workflow.mjs"),
      "export default function runWorkflow(dsl) { return dsl.outputDir(); }\n",
    );
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory };

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "long-default",
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDirRelative, `.locus-pi/workspaces/${result.runId}-long-default`);
    const persisted = readWorkflowRunResult(root, result.runId);
    assert.equal(persisted?.workspacePhysicalIdentity, result.workspacePhysicalIdentity);
    assert.equal(persisted?.workspacePhysicalIdentityInvalid, undefined);
  });

  it("creates the default workflow workspace before the script runs", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "empty.workflow.mjs"),
      "export default function runWorkflow(dsl) { return dsl.outputDir(); }\n",
    );
    const harness = createHarness(root, { sessionId: "run-files-empty" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDir, path.join(root, ".locus-pi", "workspaces", `${result.runId}-empty`));
    assert.equal(existsSync(result.workspaceDir!), true);
    assert.deepEqual(readdirSync(result.workspaceDir!), [".workflow-runs.md"]);
  });

  it("fails runWorkspaceDir() with the named migration error", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "legacy-workspace.workflow.mjs"),
      "export default function runWorkflow(dsl) { return dsl.runWorkspaceDir(); }\n",
    );
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "legacy-workspace",
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /runWorkspaceDir\(\) was removed/u);
    assert.match(result.error ?? "", /use outputDir\(\)/u);
  });

  it("rejects a Pi working directory outside the project before an agent starts", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-outside-pwd-"));
    roots.push(outside);
    writeFileSync(path.join(root, ".locus-pi", "workflows", "outside.workflow.mjs"), 'export default () => "ok";\n');
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory: outside };

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "outside",
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /working directory must be inside the project root/u);
  });

  it("rejects a physically escaping symlinked Pi working directory", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-symlink-pwd-"));
    roots.push(outside);
    const linked = path.join(root, "linked");
    symlinkSync(outside, linked, "dir");
    writeFileSync(path.join(root, ".locus-pi", "workflows", "linked.workflow.mjs"), 'export default () => "ok";\n');
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory: linked };

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "linked",
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /physical target escapes the project root/u);
    assert.deepEqual(readdirSync(outside), []);
  });

  it("creates only runtime evidence for a safe run id", () => {
    const root = project();
    const runDir = ensureWorkflowRunDir(root, "20260731-010203-abcd");
    assert.deepEqual(readdirSync(runDir).sort(), ["runtime"]);
    assert.throws(() => ensureWorkflowRunDir(root, "../escape"), /Invalid workflow run id/u);
  });

  it("accepts only bounded safe run-id components and keeps their paths under the run root", () => {
    const root = project();
    const valid = "20260731-010203-abcd";
    assert.equal(assertWorkflowRunId(valid), valid);
    assert.equal(path.relative(workflowRunsRootDir(root), workflowRunDir(root, valid)), valid);

    for (const invalid of [
      "../escape",
      "nested/run",
      "nested\\run",
      "/absolute-looking",
      "C:\\absolute-looking",
      "a".repeat(129),
    ]) {
      assert.throws(() => assertWorkflowRunId(invalid), /Invalid workflow run id/u);
      assert.throws(() => workflowRunDir(root, invalid), /Invalid workflow run id/u);
    }
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const invalid of [true, 1, 1n, null, [valid], { runId: valid }, circular]) {
      assert.throws(() => assertWorkflowRunId(invalid), /Invalid workflow run id/u);
    }
  });

  it("does not classify retired evidence through a symlinked ancestor", () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-legacy-outside-"));
    roots.push(outside);
    rmSync(path.join(root, ".pi"), { recursive: true, force: true });
    mkdirSync(path.join(outside, "locus-pi", "workflows", "legacy-run"), { recursive: true });
    symlinkSync(outside, path.join(root, ".pi"), "dir");

    assert.equal(workflowLegacyRunMigrationMessage(root, "legacy-run"), undefined);
  });

  it("keeps valid run discovery when a malformed directory is present", () => {
    const root = project();
    const validRunId = "20260731-010203-abcd";
    const validRunDir = ensureWorkflowRunDir(root, validRunId);
    writeFileSync(path.join(workflowRunRuntimeDir(validRunDir), "journal.ndjson"), "\n", "utf8");
    mkdirSync(path.join(workflowRunsRootDir(root), "a".repeat(129)));

    assert.deepEqual(listWorkflowRunIds(root), [validRunId]);
  });

  it("treats a missing intermediate runtime directory as absent evidence but rejects an unsafe replacement", () => {
    const root = project();
    const runId = "20260731-010203-runt";
    const runDir = ensureWorkflowRunDir(root, runId);
    const runtimeDir = workflowRunRuntimeDir(runDir);
    const resultPath = path.join(runtimeDir, "result.json");

    rmSync(runtimeDir, { recursive: true, force: true });
    assert.equal(workflowRunFileExists(runDir, resultPath), false);
    const summary = readWorkflowRunSummary(root, runId);
    assert.equal(summary.status, "unknown");
    assert.equal(summary.hasJournal, false);

    const outside = mkdtempSync(path.join(tmpdir(), "workflow-run-runtime-outside-"));
    roots.push(outside);
    symlinkSync(outside, runtimeDir, "dir");
    assert.throws(() => workflowRunFileExists(runDir, resultPath), /unsafe|canonical|escapes/u);
    assert.throws(() => readWorkflowRunSummary(root, runId), /unsafe|canonical|escapes/u);
  });

  it("rejects non-canonical resume ids in persisted journal lines", () => {
    const root = project();
    const runId = "20260731-010203-abcd";
    const runDir = ensureWorkflowRunDir(root, runId);
    const journalPath = path.join(workflowRunRuntimeDir(runDir), "journal.ndjson");
    const validSourceSummary = {
      runId,
      status: "completed",
      phase: null,
      agentsStarted: 0,
      agentsEnded: 0,
      agentsReplayed: 0,
      usage: null,
      errors: 0,
      lastKind: null,
      lastTs: null,
      hasResult: false,
    };
    const invalidIds: unknown[] = [true, 1, null, " source-run", "source-run ", "a/b", "../source", "a".repeat(129)];

    for (const invalidId of invalidIds) {
      const resumeLine = {
        ts: "2026-07-31T01:02:03.000Z",
        runId,
        kind: "log",
        source: "runtime",
        message: "[workflow:resume]",
        resumeFromRunId: invalidId,
      };
      writeFileSync(journalPath, `${JSON.stringify(resumeLine)}\n`, "utf8");
      const resumeRead = readWorkflowRunJournalState(root, runId);
      assert.deepEqual(resumeRead.lines, []);
      assert.equal(resumeRead.diagnostics.length, 1);
      assert.match(resumeRead.diagnostics[0]!.message, /resumeFromRunId/u);

      const summaryLine = {
        ...resumeLine,
        resumeFromRunId: runId,
        resumeSourceRunSummary: { ...validSourceSummary, runId: invalidId },
      };
      writeFileSync(journalPath, `${JSON.stringify(summaryLine)}\n`, "utf8");
      const summaryRead = readWorkflowRunJournalState(root, runId);
      assert.deepEqual(summaryRead.lines, []);
      assert.equal(summaryRead.diagnostics.length, 1);
      assert.match(summaryRead.diagnostics[0]!.message, /resumeSourceRunSummary/u);
    }

    const canonicalLine = {
      ts: "2026-07-31T01:02:03.000Z",
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:resume]",
      resumeFromRunId: runId,
      resumeSourceRunSummary: validSourceSummary,
    };
    writeFileSync(journalPath, `${JSON.stringify(canonicalLine)}\n`, "utf8");
    const canonicalRead = readWorkflowRunJournalState(root, runId);
    assert.deepEqual(canonicalRead.diagnostics, []);
    assert.equal(canonicalRead.lines.length, 1);
  });

  it("rejects empty or padded direct-runtime resume ids instead of normalizing them", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "resume-exact.workflow.mjs"),
      'export default function runWorkflow() { return "workflow-ran"; }\n',
    );
    const harness = createHarness(root, { sessionId: "exact-resume-id" });

    for (const resumeFromRunId of ["", " ", " known-run", "known-run "]) {
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "resume-exact",
        resumeFromRunId,
      });

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /Invalid workflow run id/u);
      assert.equal(result.result, undefined);
      assert.equal(result.childRuns, undefined);
      const persisted = readWorkflowRunResult(root, result.runId);
      assert.equal(persisted?.ok, false);
      assert.deepEqual(persisted?.disposition, { status: "failed" });
      assert.equal(persisted?.error, result.error);
    }
  });

  it("terminalizes non-string direct-runtime resume ids without starting child work", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "resume-type.workflow.mjs"),
      'export default async (dsl) => dsl.agent("must not run");\n',
    );
    const harness = createHarness(root, { sessionId: "resume-type" });
    let calls = 0;

    for (const invalid of [true, 1, null, ["known-run"], { runId: "known-run" }]) {
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "resume-type",
        resumeFromRunId: invalid as unknown as string,
        createExecutor: () => ({
          async run() {
            calls += 1;
            throw new Error("child must not start");
          },
        }),
      });

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /Invalid workflow run id/u);
      assert.equal(result.result, undefined);
      const persisted = readWorkflowRunResult(root, result.runId);
      assert.equal(persisted?.ok, false);
      assert.deepEqual(persisted?.disposition, { status: "failed" });
      assert.equal(persisted?.error, result.error);
    }
    assert.equal(calls, 0);
  });

  it("rejects an unsafe resume id before outside result, journal, or replay evidence can be read", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "resume-guard.workflow.mjs"),
      'export default function runWorkflow() { return "workflow-ran"; }\n',
    );
    const unsafeRunId = "../../outside";
    const outsideRuntime = path.join(root, ".pi", "outside", "runtime");
    mkdirSync(outsideRuntime, { recursive: true });
    const outsideEvidence = new Map([
      ["result.json", '{"ok":true,"result":"outside-result"}\n'],
      [
        "journal.ndjson",
        `${JSON.stringify({
          ts: "2026-07-31T01:02:03.000Z",
          runId: unsafeRunId,
          kind: "phase",
          phase: "done",
        })}\n`,
      ],
      ["replay.ndjson", '{"v":2,"seq":0,"kind":"agent","key":"outside","ok":true,"text":"outside-replay"}\n'],
    ]);
    for (const [name, contents] of outsideEvidence) {
      writeFileSync(path.join(outsideRuntime, name), contents, "utf8");
    }

    assert.equal(readWorkflowRunResult(root, unsafeRunId), null);
    assert.deepEqual(readWorkflowRunJournal(root, unsafeRunId), []);
    assert.deepEqual(readWorkflowReplayLog(root, unsafeRunId), []);
    assert.equal(workflowLegacyRunMigrationMessage(root, unsafeRunId), undefined);
    assert.throws(() => readWorkflowRunSummary(root, unsafeRunId), /Invalid workflow run id/u);

    const harness = createHarness(root, { sessionId: "unsafe-resume-id" });
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-guard",
      resumeFromRunId: unsafeRunId,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Invalid workflow run id/u);
    assert.equal(result.result, undefined);
    assert.equal(readWorkflowRunResult(root, result.runId)?.error, result.error);
    for (const [name, contents] of outsideEvidence) {
      assert.equal(readFileSync(path.join(outsideRuntime, name), "utf8"), contents);
    }
  });

  it("refuses a replaced outputs symlink for terminal writes and later reads", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "symlink-output.workflow.mjs"),
      'export default async function runWorkflow() { return "trusted result"; }\n',
    );
    const harness = createHarness(root, { sessionId: "run-output-symlink" });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "symlink-output",
      onRunStart: ({ runDir }) => {
        mkdirSync(workflowRunOutputsDir(runDir));
        rmSync(workflowRunOutputsDir(runDir), { recursive: true });
        symlinkSync(elsewhere, workflowRunOutputsDir(runDir));
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /terminal output was not persisted/u);
    assert.deepEqual(readdirSync(elsewhere), []);
    const readable = readWorkflowRunResultText(root, result.runId);
    assert.equal(readable.status, "ready");
    if (readable.status === "ready") assert.equal(readable.text, "trusted result");
    assert.deepEqual(readdirSync(elsewhere), []);
  });

  it.each([".locus-pi", ".locus-pi/runs"])(
    "rejects a symlinked %s ancestor for discovery and retained evidence reads",
    (ancestor) => {
      const root = project();
      const outside = mkdtempSync(path.join(tmpdir(), "workflow-run-outside-"));
      roots.push(outside);
      const runId = "20260731-010203-feed";
      const lexicalAncestor = path.join(root, ...ancestor.split("/"));
      rmSync(lexicalAncestor, { recursive: true, force: true });
      mkdirSync(path.dirname(lexicalAncestor), { recursive: true });

      const outsideTarget = path.join(outside, path.basename(lexicalAncestor));
      const suffix = ancestor === ".locus-pi" ? ["runs"] : [];
      const outsideRunDir = path.join(outsideTarget, ...suffix, runId);
      const outsideRuntime = path.join(outsideRunDir, "runtime");
      const outsideArtifacts = path.join(outsideRuntime, "artifacts");
      mkdirSync(outsideArtifacts, { recursive: true });
      const artifactBytes = Buffer.from("outside artifact", "utf8");
      const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
      writeFileSync(
        path.join(outsideArtifacts, "index.json"),
        JSON.stringify({
          version: 1,
          runId,
          artifacts: [
            {
              runId,
              artifactId: "outside",
              name: "outside.md",
              sha256: artifactSha256,
              kind: "published",
              mediaType: "text/markdown",
              size: artifactBytes.byteLength,
              relativePath: "outside.md",
              provenance: "published",
              createdAt: "2026-07-31T01:02:03.000Z",
            },
          ],
        }),
      );
      writeFileSync(path.join(outsideArtifacts, "outside.md"), artifactBytes);
      writeFileSync(
        path.join(outsideRuntime, "journal.ndjson"),
        `${JSON.stringify({ ts: "2026-07-31T01:02:03.000Z", runId, kind: "phase", phase: "outside" })}\n`,
      );
      writeFileSync(path.join(outsideRuntime, "replay.ndjson"), '{"v":2,"seq":0,"kind":"agent"}\n');
      writeFileSync(path.join(outsideRuntime, "result.json"), '{"ok":true,"result":"outside"}\n');
      symlinkSync(outsideTarget, lexicalAncestor, "dir");

      assert.deepEqual(listWorkflowRunIds(root), []);
      assert.equal(readWorkflowRunResult(root, runId), null);
      assert.deepEqual(readWorkflowRunJournal(root, runId), []);
      assert.deepEqual(readWorkflowReplayLog(root, runId), []);
      assert.equal(readWorkflowArtifactRecord(root, runId, "outside").status, "invalid");
    },
  );

  it("refuses terminal writes after the canonical runs root is replaced by a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-terminal-outside-"));
    roots.push(outside);
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "replace-runs.workflow.mjs"),
      'export default () => "must not escape";\n',
    );
    const harness = createHarness(root, { sessionId: "replace-runs" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "replace-runs",
      onRunStart: () => {
        rmSync(workflowRunsRootDir(root), { recursive: true });
        symlinkSync(outside, workflowRunsRootDir(root), "dir");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /canonical physical|unsafe|symlink/u);
    assert.deepEqual(readdirSync(outside), []);
  });
});

describe("grouped run lookup", () => {
  it("orders same-second executions by persisted time and keeps children out of root selection", () => {
    const root = project();
    const groupId = "20260903-120000-zzzz";
    const childId = "20260903-120000-aaaa";
    const attemptId = "20260903-120000-bbbb";
    const entries = [
      { runId: groupId, runDir: ensureWorkflowRunDir(root, groupId), ts: "2026-09-03T12:00:00.100Z" },
      {
        runId: childId,
        runDir: ensureWorkflowRunDir(root, childId, { storageRootRunId: groupId, kind: "child" }),
        ts: "2026-09-03T12:00:00.900Z",
      },
      {
        runId: attemptId,
        runDir: ensureWorkflowRunDir(root, attemptId, { storageRootRunId: groupId, kind: "attempt" }),
        ts: "2026-09-03T12:00:00.800Z",
      },
    ];
    for (const entry of entries) {
      writeFileSync(
        workflowJournalFile(entry.runDir),
        `${JSON.stringify({ ts: entry.ts, runId: entry.runId, kind: "phase", phase: "run" })}\n`,
      );
    }

    assert.deepEqual(
      listWorkflowRuns(root).map(({ runId }) => runId),
      [childId, attemptId, groupId],
    );
    assert.deepEqual(listWorkflowRunIds(root), [childId, attemptId, groupId]);
    assert.deepEqual(listWorkflowRootRunIds(root), [attemptId, groupId]);
    assert.deepEqual(resolveWorkflowRunId(root, "last"), { status: "resolved", runId: attemptId });
    assert.deepEqual(resolveWorkflowRunId(root, childId), { status: "resolved", runId: childId });
  });

  it("refuses latest selection when timestamps cannot order root runs", () => {
    let tied:
      | {
          root: string;
          runIds: [string, string];
          runs: ReturnType<typeof listWorkflowRuns>;
        }
      | undefined;
    for (let attempt = 0; attempt < 50 && tied === undefined; attempt += 1) {
      const root = project();
      const runIds: [string, string] = [`tie-${attempt}-a`, `tie-${attempt}-b`];
      const runsRoot = workflowRunsRootDir(root);
      mkdirSync(runsRoot, { recursive: true });
      const runDirs = runIds.map((runId) => workflowRunDir(root, runId));
      for (const runDir of runDirs) mkdirSync(runDir);
      for (const [index, runDir] of runDirs.entries()) {
        mkdirSync(workflowRunRuntimeDir(runDir));
        mkdirSync(workflowRunOutputsDir(runDir));
        writeFileSync(
          workflowJournalFile(runDir),
          `${JSON.stringify({ ts: "2026-09-03T12:00:00.123Z", runId: runIds[index], kind: "phase", phase: "run" })}\n`,
        );
      }
      const runs = listWorkflowRuns(root);
      if (runs.length === 2 && runs[0]!.claimedAt === runs[1]!.claimedAt) tied = { root, runIds, runs };
    }

    assert.ok(tied, "test setup could not create two directories in one claim-time millisecond");
    assert.deepEqual(
      tied.runs.map(({ runId, chronologyTied }) => ({ runId, chronologyTied })),
      tied.runIds.map((runId) => ({ runId, chronologyTied: true })),
    );
    assert.deepEqual(resolveWorkflowRunId(tied.root, "latest"), {
      status: "ambiguous",
      matched: 2,
      candidates: tied.runIds,
    });
  });

  it("requires storageRootRunId only for nested result envelopes", () => {
    const root = project();
    const group = ensureWorkflowRunDir(root, "legacy-flat");
    const child = ensureWorkflowRunDir(root, "nested-child", {
      storageRootRunId: "legacy-flat",
      kind: "child",
    });
    writeFileSync(path.join(group, "runtime", "result.json"), JSON.stringify({ runId: "legacy-flat", ok: true }));
    writeFileSync(path.join(child, "runtime", "result.json"), JSON.stringify({ runId: "nested-child", ok: true }));

    assert.equal(workflowPersistedResultInvalidity(readWorkflowRunResult(root, "legacy-flat")), undefined);
    assert.match(
      workflowPersistedResultInvalidity(readWorkflowRunResult(root, "nested-child")) ?? "",
      /storageRootRunId is required/u,
    );
    assert.throws(
      () => readWorkflowResumeWorkspaceIdentity(root, "nested-child"),
      /malformed persisted metadata.*storageRootRunId is required/u,
    );
  });

  it("lets one resolved listing feed row and snapshot readers without rediscovering the tree", () => {
    const root = project();
    const groupId = "resolved-group";
    const childId = "resolved-child";
    ensureWorkflowRunDir(root, groupId);
    const child = ensureWorkflowRunDir(root, childId, { storageRootRunId: groupId, kind: "child" });
    writeFileSync(
      workflowJournalFile(child),
      `${JSON.stringify({ ts: "2026-09-03T12:00:00.123Z", runId: childId, kind: "phase", phase: "child" })}\n`,
    );
    const source = path.join(root, ".locus-pi", "workflows", "resolved.workflow.mjs");
    const sourceText = 'export default () => "resolved";\n';
    const sha256 = createHash("sha256").update(sourceText).digest("hex");
    const snapshotPath = path.join(workflowRunRuntimeDir(child), `script-${sha256}.workflow.mjs`);
    writeFileSync(source, sourceText);
    writeFileSync(snapshotPath, sourceText);
    writeFileSync(
      workflowResultFile(child),
      JSON.stringify({
        runId: childId,
        storageRootRunId: groupId,
        ok: true,
        target: { kind: "name", ref: "resolved", source: "project", path: source },
        scriptIdentity: {
          schemaVersion: 2,
          identityPolicy: "static-node-only-v1",
          sourcePath: source,
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
        resultPersistence: { ok: true, path: workflowResultFile(child) },
      }),
    );
    const listed = listWorkflowRuns(root).find((entry) => entry.runId === childId);
    assert.ok(listed);

    ensureWorkflowRunDir(root, childId);
    assert.throws(() => resolveWorkflowRunDir(root, childId), /Ambiguous/u);
    assert.equal(readWorkflowRunSummary(root, childId, listed.runDir).phase, "child");
    assert.deepEqual(readWorkflowRunScriptSnapshot(root, childId, listed.runDir), {
      kind: "ready",
      runId: childId,
      target: { kind: "name", ref: "resolved", source: "project" },
      path: snapshotPath,
      sha256,
      identityCoverage: "self-contained-static",
      source: sourceText,
    });
  });

  it("threads one resolved execution directory through detail and viewer snapshot readers", () => {
    const root = project();
    const runId = "resolved-detail";
    const runDir = ensureWorkflowRunDir(root, runId);
    writeFileSync(
      workflowJournalFile(runDir),
      `${JSON.stringify({ ts: "2026-09-03T12:00:00.123Z", runId, kind: "phase", phase: "detail" })}\n`,
    );
    writeFileSync(workflowResultFile(runDir), JSON.stringify({ runId, ok: true }));
    const resolve = vi.spyOn(workflowRunLayout, "resolveWorkflowRunDir");
    const readJournal = vi.spyOn(workflowJournal, "readWorkflowRunJournalState");
    const readSummary = vi.spyOn(workflowJournal, "readWorkflowRunSummary");
    const readResult = vi.spyOn(workflowJournal, "readWorkflowRunResult");
    const readSnapshot = vi.spyOn(workflowJournal, "readWorkflowRunScriptSnapshot");
    const readArtifactIndex = vi.spyOn(workflowArtifacts, "readWorkflowArtifactIndex");

    buildRunDetailBlock(root, runId);
    assert.equal(resolve.mock.calls.length, 1);
    assert.ok(readJournal.mock.calls.some((call) => call[2] === runDir));
    assert.ok(readSummary.mock.calls.some((call) => call[2] === runDir));
    assert.ok(readResult.mock.calls.some((call) => call[2] === runDir));
    assert.ok(readSnapshot.mock.calls.some((call) => call[2] === runDir));

    vi.clearAllMocks();
    new WorkflowRunViewer(
      { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } },
      {},
      {},
      root,
      vi.fn(),
      runId,
    );
    assert.equal(resolve.mock.calls.length, 1);
    assert.ok(readJournal.mock.calls.some((call) => call[2] === runDir));
    assert.ok(readSummary.mock.calls.some((call) => call[2] === runDir));
    assert.ok(readResult.mock.calls.some((call) => call[2] === runDir));
    assert.ok(readArtifactIndex.mock.calls.some((call) => call[2] === runDir));
  });

  it("keeps the old projection and removes its temp file when authority expires before rename", () => {
    const root = project();
    const runDir = ensureWorkflowRunDir(root, "projection-fence");
    const file = path.join(runDir, "README.md");
    writeFileSync(file, "old\n");

    assert.throws(
      () =>
        replaceWorkflowRunFileAtomically(runDir, file, "new\n", {
          beforeRename: () => {
            throw new Error("projection authority is stale");
          },
        }),
      /authority is stale/u,
    );
    assert.equal(readFileSync(file, "utf8"), "old\n");
    assert.equal(
      readdirSync(runDir).some((name) => name.includes(".tmp-")),
      false,
    );
  });

  it("resolves root, child and attempt IDs and rejects ambiguity without reading arbitrary descendants", () => {
    const root = project();
    const group = ensureWorkflowRunDir(root, "group");
    const child = ensureWorkflowRunDir(root, "child", { storageRootRunId: "group", kind: "child" });
    const attempt = ensureWorkflowRunDir(root, "retry", { storageRootRunId: "group", kind: "attempt" });
    assert.equal(resolveWorkflowRunDir(root, "group"), group);
    assert.equal(resolveWorkflowRunDir(root, "child"), child);
    assert.equal(resolveWorkflowRunDir(root, "retry"), attempt);
    assert.equal(workflowStorageRootRunId(root, "retry"), "group");
    mkdirSync(path.join(group, "runtime", "ignored"), { recursive: true });
    assert.throws(() => resolveWorkflowRunDir(root, "ignored"), /not found/u);
    assert.throws(() => workflowRunFileExists(child, path.join(group, "runtime", "result.json")), /escapes/u);
    ensureWorkflowRunDir(root, "child");
    assert.throws(() => resolveWorkflowRunDir(root, "child"), /Ambiguous/u);
    assert.equal(resolveWorkflowRunDir(root, "retry"), attempt);
  });

  it("rejects nested symlink leaves and never follows container symlinks", () => {
    const root = project();
    const group = ensureWorkflowRunDir(root, "group");
    const external = project();
    writeFileSync(path.join(external, "sentinel"), "unchanged");
    mkdirSync(path.join(group, "children"));
    symlinkSync(external, path.join(group, "children", "unsafe"), "dir");
    symlinkSync(external, path.join(group, "attempts"), "dir");
    assert.throws(() => resolveWorkflowRunDir(root, "unsafe"), /unsafe/u);
    assert.throws(() => ensureWorkflowRunDir(root, "new", { storageRootRunId: "group", kind: "attempt" }), /unsafe/u);
    assert.equal(readFileSync(path.join(external, "sentinel"), "utf8"), "unchanged");
    assert.equal(existsSync(path.join(external, "new")), false);
  });

  it("keeps an unsafe resume rejection separate without changing the external source", async () => {
    const root = project();
    const external = project();
    mkdirSync(workflowRunsRootDir(root), { recursive: true });
    symlinkSync(external, workflowRunDir(root, "unsafe-source"), "dir");
    writeFileSync(path.join(external, "sentinel"), "unchanged");
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "missing",
      resumeFromRunId: "unsafe-source",
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /unsafe/u);
    assert.equal(result.resultPersistence.ok, true);
    assert.equal(result.runDir, workflowRunDir(root, result.runId));
    assert.equal(existsSync(path.join(result.runDir, "README.md")), false);
    assert.deepEqual(readdirSync(external).sort(), [".agents", ".locus-pi", "sentinel"]);
  });

  it("keeps two workflows from one session in separate groups with linked workspaces", async () => {
    const root = project();
    const harness = createHarness(root, { sessionId: "one-session" });
    for (const name of ["first", "second"])
      writeFileSync(path.join(root, ".locus-pi", "workflows", name + ".workflow.mjs"), 'export default () => "done";');
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "first",
    });
    const second = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "second",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.storageRootRunId, second.storageRootRunId);
    assert.notEqual(first.workspaceDir, second.workspaceDir);
    for (const result of [first, second]) {
      assert.equal(result.storageRootRunId, result.runId);
      const readme = readFileSync(path.join(result.runDir, "README.md"), "utf8");
      assert.match(readme, /runtime\/result.json/u);
      assert.doesNotMatch(readme, /status: completed/u);
      assert.match(
        readFileSync(path.join(result.workspaceDir!, ".workflow-runs.md"), "utf8"),
        new RegExp(result.runId, "u"),
      );
    }
  });
});

describe("workflow child task composition", () => {
  it("names the workflow workspace exactly once and leaves the workflow prompt last", () => {
    const task = composeWorkflowChildTask("draft the plan", "/project/tmp/plan");
    assert.match(task, /^## Workflow filesystem locations/u);
    assert.equal(task.split("/project/tmp/plan").length - 1, 1);
    assert.ok(task.endsWith("draft the plan"));
    assert.match(task, /workflow workspace \(durable workflow files and evidence\)/u);
    assert.doesNotMatch(task, /write intermediate and final workflow files here/u);
    assert.match(task, /replace assigned files idempotently/u);
    assert.match(task, /Durable handoffs, final results, review evidence, and explicit resume inputs/u);
    assert.match(task, /environments, dependency caches, test basetemp, transient renderer output, and staging/u);
    assert.match(task, /write or promote a final rendered deliverable there/u);
    assert.match(task, /never beside evidence/u);
    assert.match(task, /another owner's state/u);
    assert.match(task, /Never delete, rename, truncate, chmod, or replace \.locus-pi-workflow\.lock/u);
    assert.match(task, /instruction to write no other artifact means create or modify no other file/u);
    assert.match(task, /authored prompt that explicitly requests another placement remains authoritative/u);
    assert.doesNotMatch(task, /do not invent another project-relative durable root/u);
  });

  it("distinguishes a worktree code workspace from the workflow workspace and project context", () => {
    const task = composeWorkflowChildTask("implement the change", "/projects/main/tmp/review", {
      pwd: "/worktrees/child",
      projectRoot: "/projects/main",
    });

    assert.match(task, /workflow workspace .*: \/projects\/main\/tmp\/review/u);
    assert.match(task, /pwd \(code workspace\): \/worktrees\/child/u);
    assert.match(task, /project root \(source context\): \/projects\/main/u);
    assert.match(task, /Use pwd for code work/u);
    assert.match(
      task,
      /task artifact folder \(\.tasks\/<task>\/artifacts\/<stage>\/\) when the authored prompt selects one/u,
    );
    assert.doesNotMatch(task, /not as a default artifact destination/u);
  });

  it("leaves the prompt untouched when no directory or location is configured", () => {
    assert.equal(composeWorkflowChildTask("draft the plan", undefined), "draft the plan");
    assert.equal(composeWorkflowChildTask("draft the plan", "   "), "draft the plan");
  });
});
