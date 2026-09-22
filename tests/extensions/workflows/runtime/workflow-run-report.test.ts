import assert from "node:assert/strict";
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
import { afterEach, describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import type { WorkflowArtifactRecord } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  resolveWorkflowBudget,
  type WorkflowBudget,
} from "../../../../extensions/workflows/runtime/workflow-budget.js";

/** A run that declared everything, so the report's applied column has numbers to print. */
const DECLARED_BUDGET: WorkflowBudget = {
  concurrency: 4,
  totalAgents: 10_000,
  runtimeMs: 86_400_000,
  timeoutMs: 86_400_000,
  toolCalls: 1_000,
  turns: 1_000,
};
import {
  workflowReportDir,
  writeWorkflowRunReport as writeClaimedWorkflowRunReport,
  type WorkflowRunReportEvidenceSource,
  type WorkflowRunReportInput,
} from "../../../../extensions/workflows/runtime/workflow-run-report.js";
import { readWorkflowRunJournalState } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  ensureWorkflowRunDir,
  workflowJournalFile,
  workflowRunDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { writeWorkflowResultText } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  createWorkflowRuntime,
  type WorkflowJournalLine,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-report-"));
  roots.push(root);
  return root;
}

const RUN_ID = "20260728-190000-abcd";

type TestWorkflowRunReportInput = Omit<WorkflowRunReportInput, "runDir"> & { runDir?: string };

function writeWorkflowRunReport(
  input: TestWorkflowRunReportInput,
  evidence: WorkflowRunReportEvidenceSource,
): ReturnType<typeof writeClaimedWorkflowRunReport> {
  let runDir = input.runDir;
  if (runDir === undefined) {
    try {
      runDir = ensureWorkflowRunDir(input.projectRoot, input.runId);
    } catch {
      runDir = input.projectRoot;
    }
  }
  return writeClaimedWorkflowRunReport({ ...input, runDir }, evidence);
}

function record(
  overrides: Partial<WorkflowArtifactRecord> & Pick<WorkflowArtifactRecord, "artifactId" | "name" | "kind">,
): WorkflowArtifactRecord {
  return {
    runId: RUN_ID,
    sha256: "a".repeat(64),
    mediaType: "text/markdown; charset=utf-8",
    size: 1,
    relativePath: path.join("answers", overrides.artifactId),
    provenance: "fresh",
    createdAt: "2026-07-28T19:00:00.000Z",
    ...overrides,
  };
}

function agentLines(callId: string, label: string, phase: string): WorkflowJournalLine[] {
  return [
    { ts: "2026-07-28T19:00:00.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", label, callId, phase },
    {
      ts: "2026-07-28T19:00:01.000Z",
      runId: RUN_ID,
      kind: "agent_end",
      agent: "default",
      label,
      callId,
      phase,
      status: "completed",
    },
  ] as WorkflowJournalLine[];
}

function evidenceFrom(
  records: WorkflowArtifactRecord[],
  bytes: Record<string, string>,
): WorkflowRunReportEvidenceSource {
  return {
    list: () => records,
    read: (ref) => {
      const text = bytes[ref.artifactId];
      if (text === undefined) throw new Error(`unreadable artifact: ${ref.artifactId}`);
      return Buffer.from(text, "utf8");
    },
  };
}

describe("workflow run report", () => {
  it("refuses an unclaimed directory without creating a flat run", () => {
    const root = project();
    const runDir = path.join(root, ".locus-pi", "runs", RUN_ID);
    const outcome = writeClaimedWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, runDir, status: "failed", journal: [] },
      evidenceFrom([], {}),
    );
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(runDir), false);
  });

  it("projects each artifact name as ONE document holding its newest revision, with the chain in the README", () => {
    const root = project();
    ensureWorkflowRunDir(root, RUN_ID);
    const records = [
      record({ artifactId: "published-0001", name: "task.md", kind: "published" }),
      record({
        artifactId: "call-0001-answer",
        name: "context.md",
        kind: "published",
        callId: "call-0001",
        stage: "scout-repository",
      }),
      record({
        artifactId: "call-0002-answer",
        name: "plan.md",
        kind: "published",
        callId: "call-0002",
        stage: "draft-plan",
      }),
      record({
        artifactId: "call-0003-answer",
        name: "plan-critique.json",
        kind: "published",
        callId: "call-0003",
        stage: "critique-plan",
      }),
      record({
        artifactId: "call-0004-answer",
        name: "plan.md",
        kind: "primary",
        callId: "call-0004",
        stage: "draft-plan",
      }),
      record({ artifactId: "published-0002", name: "questions.md", kind: "published", stage: "draft-plan" }),
      record({
        artifactId: "call-0001-transcript",
        name: "scout.transcript",
        kind: "transcript",
        callId: "call-0001",
        stage: "scout-repository",
        relativePath: path.join("transcripts", "call-0001", "trace.jsonl"),
        mediaType: "application/x-ndjson",
      }),
    ];
    writeWorkflowResultText(workflowRunDir(root, RUN_ID), "# Accepted plan\n");
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        workspaceDir: path.join(root, "tmp", "plan"),
        status: "completed",
        target: { kind: "name", ref: "plan", source: "package" },
        result: "# Accepted plan\n",
        journal: [
          ...agentLines("call-0001", "scout", "scout-repository"),
          ...agentLines("call-0002", "planner round 1", "draft-plan"),
          ...agentLines("call-0003", "critic round 1", "critique-plan"),
          ...agentLines("call-0004", "planner round 2", "draft-plan"),
        ],
      },
      evidenceFrom(records, {
        "published-0001": "the task text",
        "call-0001-answer": "context body",
        "call-0002-answer": "plan round 1 body",
        "call-0003-answer": '{"verdict":"revise","defects":["S2: path is wrong","S5: no verify"]}',
        "call-0004-answer": "plan round 2 body",
        "published-0002": "questions body",
      }),
    );

    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const reportDir = workflowReportDir(root, RUN_ID);
    const names = readdirSync(reportDir).sort();
    assert.deepEqual(names, [
      "README.md",
      "context.md",
      "plan-critique.md",
      "plan.md",
      "questions.md",
      "task.md",
      "workflow-result.md",
    ]);
    assert.ok(names.every((name) => !name.endsWith(".md.md")));
    assert.equal(readFileSync(path.join(reportDir, "task.md"), "utf8"), "the task text");
    assert.equal(readFileSync(path.join(reportDir, "workflow-result.md"), "utf8"), "# Accepted plan\n");
    assert.equal(readFileSync(path.join(reportDir, "context.md"), "utf8"), "context body");
    // The document is the newest explicitly published revision.
    assert.equal(readFileSync(path.join(reportDir, "plan.md"), "utf8"), "plan round 2 body");
    assert.equal(
      readFileSync(path.join(reportDir, "plan-critique.md"), "utf8"),
      ["- **verdict**: revise", "- **defects**:", "  1. S2: path is wrong", "  2. S5: no verify", ""].join("\n"),
    );

    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Workflow: `plan` \(package\)/u);
    assert.match(readme, /- Status: completed/u);
    assert.match(readme, /- Task: \[task\.md\]\(task\.md\)/u);
    assert.match(readme, /- Result: \[workflow-result\.md\]\(workflow-result\.md\)/u);
    assert.ok(readme.includes(`- Workflow workspace: \`${path.join(root, "tmp", "plan")}\``));
    assert.match(readme, /- Machine records: `\.\.\/runtime\/`/u);
    assert.equal(reportDir, path.join(workflowRunDir(root, RUN_ID), "outputs"));
    // One Documents list ordered by first publication; the revised document
    // lists every workflow-owned revision with a machine-bytes link.
    assert.match(readme, /## Documents/u);
    assert.match(readme, /\[plan\.md\]\(plan\.md\) — \*\*primary output\*\* — workflow · draft-plan — 2 revisions:/u);
    assert.match(readme, /1\. workflow · draft-plan — \[machine copy\]/u);
    assert.match(readme, /2\. workflow · draft-plan — \[machine copy\]/u);
    // Single-revision documents stay single lines without a revision list.
    assert.match(readme, /\[context\.md\]\(context\.md\) — workflow · scout-repository/u);
    assert.doesNotMatch(readme, /\[context\.md\]\(context\.md\)[^\n]*revisions/u);
    assert.match(readme, /\[questions\.md\]\(questions\.md\) — workflow · draft-plan/u);
    const planEntry = readme.indexOf("[plan.md](plan.md)");
    const contextEntry = readme.indexOf("[context.md](context.md)");
    assert.ok(contextEntry > 0 && contextEntry < planEntry, "documents are ordered by first publication");
    // The Logs section names the combined journal and each child transcript,
    // as run-directory siblings of the report.
    assert.match(readme, /## Logs/u);
    assert.match(readme, /\[journal\.ndjson\]\(\.\.\/runtime\/journal\.ndjson\)/u);
    assert.match(
      readme,
      /scout · scout-repository — \[transcript\]\(\.\.\/runtime\/artifacts\/transcripts\/call-0001\/trace\.jsonl\)/u,
    );
  });

  it("keeps un-published agent answers and their model metadata out of outputs", () => {
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "cheap.md", kind: "answer", callId: "call-0001", stage: "draft" }),
      record({
        artifactId: "call-0002-answer",
        name: "strong.md",
        kind: "answer",
        callId: "call-0002",
        stage: "judge",
      }),
      record({ artifactId: "call-0003-answer", name: "old.md", kind: "answer", callId: "call-0003", stage: "legacy" }),
    ];
    const journal = [
      ...agentLines("call-0001", "cheap stage", "draft"),
      ...agentLines("call-0002", "strong stage", "judge"),
      ...agentLines("call-0003", "legacy stage", "legacy"),
    ];
    // agent_start carries a REQUEST; the report must ignore it. If it did not, the
    // legacy call below would be reported as having run on `test/strong`, which
    // nothing observed.
    const startFor = (callId: string) => journal.find((l) => l.callId === callId && l.kind === "agent_start")!;
    const endFor = (callId: string) => journal.find((l) => l.callId === callId && l.kind === "agent_end")!;
    startFor("call-0001").requestedModel = "test/fast";
    endFor("call-0001").executedModel = "test/fast";
    startFor("call-0002").requestedModel = "test/strong";
    endFor("call-0002").executedModel = "test/strong";
    startFor("call-0003").requestedModel = "test/strong";
    endFor("call-0003").modelRoleFallback = 'modelRole "smol" is not assigned in any model-roles layer';

    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal },
      evidenceFrom(records, {
        "call-0001-answer": "cheap body",
        "call-0002-answer": "strong body",
        "call-0003-answer": "legacy body",
      }),
    );

    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.match(readme, /## Documents\n\n- none/u);
    assert.equal(/test\/fast|test\/strong|declared tier unassigned/u.test(readme), false);
  });

  it("does not leak unavailable model sentinels from runtime-only answers", () => {
    // `unavailable` is the D6 sentinel for "the peer reported nothing". Rendered as
    // "ran on unavailable" it reads to a human as a model NAMED unavailable — a
    // fabricated model name in the reader's own copy of the evidence.
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "quiet.md", kind: "answer", callId: "call-0001", stage: "draft" }),
    ];
    const journal = [...agentLines("call-0001", "quiet stage", "draft")];
    journal.find((l) => l.callId === "call-0001" && l.kind === "agent_end")!.executedModel = "unavailable";

    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal },
      evidenceFrom(records, { "call-0001-answer": "quiet body" }),
    );

    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.match(readme, /## Documents\n\n- none/u);
    assert.equal(/unavailable/u.test(readme), false);
  });

  it("renders JSON documents as Markdown, fencing nested shapes and keeping non-JSON verbatim", () => {
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "flat.json", kind: "published", callId: "call-0001" }),
      record({ artifactId: "call-0002-answer", name: "nested.json", kind: "published", callId: "call-0002" }),
      record({ artifactId: "call-0003-answer", name: "broken.json", kind: "published", callId: "call-0003" }),
    ];
    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal: [] },
      evidenceFrom(records, {
        "call-0001-answer": '{"verdict":"accept","defects":[]}',
        "call-0002-answer": '{"rows":[{"id":1}]}',
        "call-0003-answer": "not json at all",
      }),
    );
    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.equal(
      readFileSync(path.join(reportDir, "flat.md"), "utf8"),
      "- **verdict**: accept\n- **defects**: (none)\n",
    );
    const fenced = readFileSync(path.join(reportDir, "nested.md"), "utf8");
    assert.match(fenced, /^```json\n/u);
    assert.match(fenced, /"rows": \[/u);
    assert.equal(readFileSync(path.join(reportDir, "broken.json"), "utf8"), "not json at all");
  });

  it("prints the whole reason a run stopped, and refuses to call a rejected draft a result", () => {
    // The live shape this comes from: a stalled `plan` returns `{ok:false}` with
    // its open defects, and every live surface clips that text — the operator saw
    // one sentence ending in "..." and had nowhere to read the rest, while
    // `plan.md` in this folder held a draft the critic had rejected.
    const root = project();
    const defect =
      "S1: the find command pattern used to identify DAG files is not properly executed and may miss files " +
      "under nested directories, so the step cannot be carried out as written";
    const records = [
      record({
        artifactId: "call-0002-answer",
        name: "plan.md",
        kind: "published",
        callId: "call-0002",
        stage: "draft",
      }),
    ];
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "failed",
        result: {
          ok: false,
          stoppedBy: "round-cap",
          rounds: 4,
          summary: "plan was not accepted within 4 drafting round(s)",
          unresolvedRows: [defect, "S3: no verification command exists for this step"],
        },
        journal: agentLines("call-0002", "draft plan round 4", "draft"),
      },
      evidenceFrom(records, { "call-0002-answer": "the rejected draft" }),
    );

    assert.equal(outcome.ok, true);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.match(readme, /## Why this run ended `failed`/u);
    assert.match(readme, /- \*\*summary\*\*: plan was not accepted within 4 drafting round\(s\)/u);
    // The defect is present in full — no ellipsis, no 160-character cap.
    assert.ok(readme.includes(defect), "the whole defect sentence must be readable in the report");
    assert.match(readme, /S3: no verification command exists for this step/u);
    // And the retained draft is not dressed up as the run's answer.
    assert.match(readme, /This run returned no document as its result \(status `failed`\)/u);
    assert.equal(/\*\*final result\*\*/u.test(readme), false);
  });

  it("folds every copy of the task into task.md instead of leaving a duplicate document", () => {
    // A continuation holds the task twice — the input it consumed and the copy it
    // republished — and the second one used to become a byte-identical `task-2.md`
    // leading the Documents list under a name that says nothing.
    const root = project();
    const records = [
      record({
        artifactId: "input-0001",
        name: "task.md",
        kind: "input",
        relativePath: path.join("inputs", "input-0001-task.md"),
        source: {
          runId: "20260728-180000-prev",
          artifactId: "published-0001",
          name: "task.md",
          sha256: "c".repeat(64),
        },
      }),
      record({ artifactId: "published-0001", name: "task.md", kind: "published" }),
      record({ artifactId: "call-0001-answer", name: "plan.md", kind: "primary", callId: "call-0001" }),
    ];
    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal: [] },
      evidenceFrom(records, {
        "input-0001": "the operator task",
        "published-0001": "the operator task",
        "call-0001-answer": "plan body",
      }),
    );

    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.deepEqual(readdirSync(reportDir).sort(), ["README.md", "plan.md", "task.md"]);
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Task: \[task\.md\]\(task\.md\)/u);
    assert.equal(/task-2\.md/u.test(readme), false);
  });

  it("leaves result.md to a document that owns the name when the run returned no text", () => {
    // Reserving all three runner-owned names unconditionally cost a document its
    // own name: this run writes no result.md, so nothing should be renamed.
    const root = project();
    const records = [record({ artifactId: "published-0001", name: "result.md", kind: "published" })];
    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", result: { ok: true }, journal: [] },
      evidenceFrom(records, { "published-0001": "a document the workflow named result.md" }),
    );

    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.deepEqual(readdirSync(reportDir).sort(), ["README.md", "result.md"]);
    assert.equal(readFileSync(path.join(reportDir, "result.md"), "utf8"), "a document the workflow named result.md");
  });

  it("keeps transferred inputs runtime-only until the workflow publishes them", () => {
    const root = project();
    const records = [
      record({
        artifactId: "input-0001",
        name: "task.md",
        kind: "input",
        relativePath: path.join("inputs", "input-0001-task.md"),
        source: {
          runId: "20260728-180000-prev",
          artifactId: "published-0001",
          name: "task.md",
          sha256: "c".repeat(64),
        },
      }),
    ];
    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal: [] },
      evidenceFrom(records, { "input-0001": "the operator task" }),
    );

    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.deepEqual(readdirSync(reportDir).sort(), ["README.md"]);
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.doesNotMatch(readme, /- Task:/u);
  });

  it("keeps a structured result out of result.md and says where it lives", () => {
    const root = project();
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "failed",
        result: { ok: false, summary: "round cap" },
        error: "plan was not accepted",
        journal: [],
      },
      evidenceFrom([], {}),
    );
    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.equal(existsSync(path.join(reportDir, "result.md")), false);
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Status: failed/u);
    assert.match(readme, /structured — see `result\.json`/u);
    assert.match(readme, /- Error: plan was not accepted/u);
  });

  it("refuses an unsafe run id and a symlinked outputs directory", () => {
    const root = project();
    const unsafe = writeWorkflowRunReport(
      { projectRoot: root, runId: "../escape", status: "completed", journal: [] },
      evidenceFrom([], {}),
    );
    assert.equal(unsafe.ok, false);

    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(workflowRunDir(root, RUN_ID), { recursive: true });
    symlinkSync(elsewhere, path.join(workflowRunDir(root, RUN_ID), "outputs"));
    const symlinked = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal: [] },
      evidenceFrom([], {}),
    );
    assert.equal(symlinked.ok, false);
    assert.equal(readdirSync(elsewhere).length, 0);
  });

  it("survives an unreadable artifact and marks it unavailable in the table of contents", () => {
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "context.md", kind: "published", callId: "call-0001" }),
      record({ artifactId: "call-0002-answer", name: "plan.md", kind: "primary", callId: "call-0002" }),
    ];
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        journal: [...agentLines("call-0001", "scout", "s"), ...agentLines("call-0002", "planner round 1", "d")],
      },
      evidenceFrom(records, { "call-0002-answer": "plan body" }),
    );
    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.equal(existsSync(path.join(reportDir, "context.md")), false);
    assert.equal(readFileSync(path.join(reportDir, "plan.md"), "utf8"), "plan body");
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /context\.md — workflow — unavailable/u);
  });

  it("is written by the runner next to the machine records on a live run", async () => {
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "report.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  dsl.publishArtifact("task.md", "the operator task");',
        '  const review = await dsl.agent("answer", { artifact: "review.md", label: "scout" });',
        '  dsl.publishPrimaryArtifact("review.md", review);',
        "  return review;",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "report-parent" });
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "report",
      createExecutor,
    });

    assert.equal(result.ok, true, result.error);
    const reportDir = workflowReportDir(root, result.runId);
    const names = readdirSync(reportDir).sort();
    assert.deepEqual(names, ["README.md", "review.md", "task.md", "workflow-result.md"]);
    assert.equal(readFileSync(path.join(reportDir, "review.md"), "utf8"), "exact answer");
    assert.equal(readFileSync(path.join(reportDir, "task.md"), "utf8"), "the operator task");
    assert.equal(readFileSync(path.join(reportDir, "workflow-result.md"), "utf8"), "exact answer\n");
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Workflow: `report` \(project\)/u);
    // This run returned the agent's answer, so that document is the result and
    // says so — the rest of a run's documents are working material.
    assert.match(readme, /\[review\.md\]\(review\.md\) — \*\*primary output\*\* — workflow/u);
    assert.match(readme, /The document marked \*\*primary output\*\* is the workflow-declared result/u);
    // The Logs section names the combined journal even when no child exported a
    // transcript (this harness executor returns answers without one).
    assert.match(readme, /## Logs/u);
    assert.match(readme, /\[journal\.ndjson\]\(\.\.\/runtime\/journal\.ndjson\)/u);
  });

  it("names every discarded transport attempt, its callId and its class", async () => {
    // A retried stage looks like one clean answer in the documents list. The second child
    // really ran, burned an invocation and left its own transcript, so the reader's copy has
    // to say so — otherwise the only trace of the second bill is a machine file.
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "retried.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("answer", {',
        '    artifact: "review.md",',
        '    label: "scout",',
        '    phase: "review",',
        "    readOnly: true,",
        "    attempts: 2,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "report-retry-parent" });
    let child = 0;
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        child += 1;
        // First child: the host turn budget expired mid-answer. Second: a real answer.
        if (child === 1) {
          return {
            status: "failed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "Child agent turn exceeded the 5000ms budget and was aborted.",
            failureCause: "host-turn-timeout",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        }
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "retried",
      createExecutor,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(child, 2, "the transport failure must have cost a second real child");

    const readme = readFileSync(path.join(workflowReportDir(root, result.runId), "README.md"), "utf8");
    assert.match(readme, /## Retried agent calls/u);
    // BOTH attempts, each by its own callId, and the discarded one by its class.
    assert.match(readme, /- attempt 1 of 2 — `call-0001` — failed \(host-turn-timeout\)/u);
    assert.match(readme, /- attempt 2 of 2 — `call-0002` — completed/u);
    assert.match(readme, /- scout · review/u);

    // The same two attempts are readable in the journal the report was projected from,
    // and the journal a reader loads back reports no structural problem.
    const journal = readWorkflowRunJournalState(root, result.runId);
    assert.deepEqual(journal.diagnostics, []);
    const ends = journal.lines.filter((line) => line.kind === "agent_end");
    assert.deepEqual(
      ends.map((line) => [line.callId, line.attempt, line.attempts, line.status, line.failureCause]),
      [
        ["call-0001", 1, 2, "failed", "host-turn-timeout"],
        ["call-0002", 2, 2, "completed", undefined],
      ],
    );
    assert.equal(
      journal.lines.filter((line) => line.message?.startsWith("[workflow:retry]") === true).length,
      1,
      "the boundary between the two attempts is named in the journal",
    );
  });

  it("names a retry whose second attempt threw, which leaves only one agent_end behind", async () => {
    // The failure path that hides a retry: attempt 1 times out and IS re-run, attempt 2
    // throws. A thrown attempt never reaches an `agent_end`, so a report built from
    // `agent_end` alone sees one attempt, drops the group, and renders a stage that ran
    // twice and cost twice as if it never retried — while the run's own error message
    // names only the throw. The terminal `error` line is that attempt's record and has to
    // carry the same attempt identity.
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "threw.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("answer", {',
        '    artifact: "review.md",',
        '    label: "scout",',
        '    phase: "review",',
        "    readOnly: true,",
        "    attempts: 2,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "report-threw-parent" });
    let child = 0;
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        child += 1;
        if (child === 1) {
          return {
            status: "failed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "Child agent turn exceeded the 5000ms budget and was aborted.",
            failureCause: "host-turn-timeout",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        }
        throw new Error("the child host vanished mid-turn");
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "threw",
      createExecutor,
    });

    assert.equal(result.ok, false, "a thrown attempt ends the run");
    assert.equal(child, 2, "the transport failure must have cost a second real child");

    const readme = readFileSync(path.join(workflowReportDir(root, result.runId), "README.md"), "utf8");
    assert.match(readme, /## Retried agent calls/u);
    assert.match(readme, /- attempt 1 of 2 — `call-0001` — failed \(host-turn-timeout\)/u);
    // The thrown attempt is named as itself — not "failed", and not silently absent.
    assert.match(readme, /- attempt 2 of 2 — `call-0002` — threw/u);

    // The journal the report was projected from: one agent_end, one error line, the same
    // logical call named on both, and no structural problem when a reader loads it back.
    const journal = readWorkflowRunJournalState(root, result.runId);
    assert.deepEqual(journal.diagnostics, []);
    const ends = journal.lines.filter((line) => line.kind === "agent_end");
    const errors = journal.lines.filter((line) => line.kind === "error" && line.callId !== undefined);
    assert.deepEqual(
      ends.map((line) => [line.callId, line.attempt, line.attempts]),
      [["call-0001", 1, 2]],
    );
    assert.deepEqual(
      errors.map((line) => [line.callId, line.attempt, line.attempts]),
      [["call-0002", 2, 2]],
    );
    assert.equal(errors[0]?.logicalCallId, ends[0]?.logicalCallId);
    assert.notEqual(errors[0]?.logicalCallId, undefined);
  });

  it("says nothing about retries when a call needed only one attempt", () => {
    // The section is evidence, not decoration: a call that declared a budget and did not
    // spend it must not grow a "Retried agent calls" heading.
    const root = project();
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        journal: [
          {
            ts: "2026-07-28T19:00:00.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0001",
            logicalCallId: "logical-0001",
            attempt: 1,
            attempts: 3,
            status: "completed",
          },
        ] as WorkflowJournalLine[],
      },
      evidenceFrom([], {}),
    );

    assert.equal(outcome.ok, true);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.doesNotMatch(readme, /Retried agent calls/u);
  });

  it("keeps two interleaved calls apart when agent, label, phase and group all agree", () => {
    // Two calls can agree on every descriptive field — a loop's second round, or two
    // sequential calls on one slot — and once they overlap in the journal their attempts
    // interleave. (Two CONCURRENT branches holding one slot no longer reach this shape:
    // the runtime's slot guard refuses the second. The report still has to read journals
    // written before that guard, and the sequential case stands either way.) Grouping by
    // those fields would put three of these four attempts in one group and leave the other
    // looking like it never retried — a section that reads as evidence while attributing
    // one stage's second bill to another. Only the runtime's own logical-call identity
    // separates them.
    const root = project();
    const shared = { runId: RUN_ID, kind: "agent_end" as const, agent: "default", label: "advise", phase: "advise" };
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        journal: [
          // A's first attempt, then B's first attempt, then A's second, then B's second.
          {
            ...shared,
            ts: "2026-07-28T19:00:01.000Z",
            groupId: "group-1",
            callId: "call-0001",
            logicalCallId: "logical-0001",
            attempt: 1,
            attempts: 2,
            status: "failed",
            failureCause: "host-turn-timeout",
          },
          {
            ...shared,
            ts: "2026-07-28T19:00:02.000Z",
            groupId: "group-1",
            callId: "call-0002",
            logicalCallId: "logical-0002",
            attempt: 1,
            attempts: 2,
            status: "failed",
            failureCause: "call-timeout",
          },
          {
            ...shared,
            ts: "2026-07-28T19:00:03.000Z",
            groupId: "group-1",
            callId: "call-0003",
            logicalCallId: "logical-0001",
            attempt: 2,
            attempts: 2,
            status: "completed",
          },
          {
            ...shared,
            ts: "2026-07-28T19:00:04.000Z",
            groupId: "group-1",
            callId: "call-0004",
            logicalCallId: "logical-0002",
            attempt: 2,
            attempts: 2,
            status: "completed",
          },
        ] as WorkflowJournalLine[],
      },
      evidenceFrom([], {}),
    );

    assert.equal(outcome.ok, true);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Retried agent calls"));
    // Two calls, each with exactly its OWN two attempts. Grouping by the descriptive fields
    // produces one bullet with three attempt lines instead, so this fails on that shape.
    assert.equal(section.split("\n").filter((line) => line === "- advise · advise").length, 2);
    assert.match(
      section,
      /- attempt 1 of 2 — `call-0001` — failed \(host-turn-timeout\)\n {2}- attempt 2 of 2 — `call-0003` — completed/u,
    );
    assert.match(
      section,
      /- attempt 1 of 2 — `call-0002` — failed \(call-timeout\)\n {2}- attempt 2 of 2 — `call-0004` — completed/u,
    );
  });
});

/**
 * T-131 W8 — the report answers "what was this run allowed to spend, and what did
 * it spend", and is explicit about the axes it cannot measure.
 */
describe("workflow run report budget section", () => {
  function budgetInput(overrides: Partial<WorkflowRunReportInput> = {}): WorkflowRunReportInput {
    const projectRoot = overrides.projectRoot ?? project();
    const runId = overrides.runId ?? RUN_ID;
    return {
      projectRoot,
      runId,
      runDir: overrides.runDir ?? ensureWorkflowRunDir(projectRoot, runId),
      status: "completed",
      journal: [],
      budget: { applied: DECLARED_BUDGET, peakConcurrency: 0 },
      ...overrides,
    };
  }

  function readmeOf(input: WorkflowRunReportInput): string {
    const outcome = writeWorkflowRunReport(input, evidenceFrom([], {}));
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
    return readFileSync(path.join(workflowReportDir(input.projectRoot, input.runId), "README.md"), "utf8");
  }

  it("prints every axis with its applied value", () => {
    const readme = readmeOf(budgetInput());

    assert.match(readme, /## Budget/u);
    assert.match(readme, /\| `concurrency` \| 4 \|/u);
    assert.match(readme, /\| `totalAgents` \| 10000 \|/u);
    assert.match(readme, /\| `runtimeMs` \| 86400000 ms \|/u);
    assert.match(readme, /\| `timeoutMs` \| 86400000 ms \|/u);
    assert.match(readme, /\| `toolCalls` \| 1000 \|/u);
    assert.match(readme, /\| `turns` \| 1000 \|/u);
    // No answer-size axis exists any more: a run bounds spend, never the size of a
    // result it already paid for.
    assert.doesNotMatch(readme, /`answerChars`/u);
  });

  it("renders declared Fusion mode separately from live host tool readback", () => {
    const readme = readmeOf(
      budgetInput({
        journal: [
          {
            ts: "2026-07-28T19:00:00.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            label: "member",
            callId: "call-0001",
            status: "completed",
            capabilityMode: "tool-free",
            activeToolNames: [],
            replayed: false,
          },
          {
            ts: "2026-07-28T19:00:01.000Z",
            runId: RUN_ID,
            kind: "error",
            source: "script",
            message: "validator exploded after replay",
            agent: "default",
            label: "judge",
            callId: "call-0002",
            capabilityMode: "agent",
            replayed: true,
          },
          {
            ts: "2026-07-28T19:00:02.000Z",
            runId: RUN_ID,
            kind: "error",
            source: "runtime",
            message: "legacy terminal origin missing",
            agent: "default",
            label: "unknown-origin",
            callId: "call-0003",
            capabilityMode: "agent",
          },
        ],
      }),
    );

    assert.match(readme, /## Fusion capability evidence/u);
    assert.match(
      readme,
      /\| <code>call-0001<\/code> \| member \| <code>tool-free<\/code> \| none \(`\[\]`\) \| fresh \|/u,
    );
    assert.match(
      readme,
      /\| <code>call-0002<\/code> \| judge \| <code>agent<\/code> \| not recorded \| replayed; no child ran \|/u,
    );
    assert.match(
      readme,
      /\| <code>call-0003<\/code> \| unknown-origin \| <code>agent<\/code> \| not recorded \| not recorded \|/u,
    );
  });

  it("rejects persisted replay evidence with a live tool readback before report rendering", () => {
    const root = project();
    const runDir = ensureWorkflowRunDir(root, RUN_ID);
    const fresh = {
      ts: "2026-07-28T19:00:00.000Z",
      runId: RUN_ID,
      kind: "agent_end",
      agent: "default",
      label: "fresh-member",
      callId: "call-0001",
      status: "completed",
      capabilityMode: "tool-free",
      activeToolNames: [],
      replayed: false,
    };
    const contradictory = {
      ts: "2026-07-28T19:00:01.000Z",
      runId: RUN_ID,
      kind: "agent_end",
      agent: "default",
      label: "impossible-replay",
      callId: "call-0002",
      status: "completed",
      capabilityMode: "agent",
      activeToolNames: ["read"],
      replayed: true,
    };
    writeFileSync(workflowJournalFile(runDir), `${JSON.stringify(fresh)}\n${JSON.stringify(contradictory)}\n`, "utf8");

    const persisted = readWorkflowRunJournalState(root, RUN_ID);
    assert.equal(persisted.lines.length, 1);
    assert.deepEqual(persisted.diagnostics, [
      {
        kind: "structure",
        lineNumber: 2,
        message: "Field activeToolNames cannot be present when replayed is true.",
      },
    ]);

    const readme = readmeOf(budgetInput({ projectRoot: root, journal: persisted.lines }));
    assert.match(readme, /fresh-member/u);
    assert.doesNotMatch(readme, /impossible-replay|replayed; no child ran.*<code>read<\/code>/u);
  });

  it("escapes every dynamic Fusion capability table cell", () => {
    const readme = readmeOf(
      budgetInput({
        journal: [
          {
            ts: "2026-07-28T19:00:00.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            label: "leg|`<unsafe>",
            callId: "call|`<id>",
            status: "completed",
            capabilityMode: "agent",
            activeToolNames: ["read|pipe", "tick`<tool>"],
            replayed: false,
          },
        ],
      }),
    );

    const row = readme.split("\n").find((line) => line.includes("call&#124;&#96;&lt;id&gt;"));
    assert.ok(row !== undefined);
    assert.equal(row.split("|").length, 7);
    assert.match(row, /<code>call&#124;&#96;&lt;id&gt;<\/code>/u);
    assert.match(row, /leg&#124;&#96;&lt;unsafe&gt;/u);
    assert.match(row, /<code>read&#124;pipe<\/code>, <code>tick&#96;&lt;tool&gt;<\/code>/u);
  });

  it("prints the axes nobody counts as not recorded, never as zero", () => {
    const readme = readmeOf(budgetInput());

    for (const axis of ["toolCalls", "turns"]) {
      const row = readme.split("\n").find((line) => line.startsWith(`| \`${axis}\``));
      assert.ok(row !== undefined, `missing row for ${axis}`);
      assert.match(row, /not recorded/u);
      assert.doesNotMatch(row, /\| 0 \|/u);
    }
    // The host reports no price at all; the report says so instead of "$0".
    assert.match(readme, /\| cost \| not enforced \| not available \|/u);
  });

  it("reports measured spend where the journal really carries it", () => {
    const readme = readmeOf(
      budgetInput({
        journal: [
          { ts: "2026-07-28T19:00:00.000Z", runId: RUN_ID, kind: "log", source: "runtime", message: "budget" },
          { ts: "2026-07-28T19:00:00.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", callId: "call-0001" },
          {
            ts: "2026-07-28T19:00:04.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0001",
            status: "completed",
            durationMs: 4_000,
            usage: { input: 100, output: 40, totalTokens: 140, costTotal: 0 },
          },
          { ts: "2026-07-28T19:00:04.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", callId: "call-0002" },
          {
            ts: "2026-07-28T19:00:11.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0002",
            status: "completed",
            durationMs: 7_000,
            usage: { input: 10, output: 5, totalTokens: 15, costTotal: 0 },
          },
        ] as WorkflowJournalLine[],
        budget: { applied: DECLARED_BUDGET, peakConcurrency: 2 },
      }),
    );

    assert.match(readme, /\| `totalAgents` \| 10000 \| 2 fresh \|/u);
    assert.match(readme, /\| `runtimeMs` \| 86400000 ms \| 11000 ms over the journal \|/u);
    assert.match(readme, /\| `timeoutMs` \| 86400000 ms \| 7000 ms longest child \|/u);
    assert.match(readme, /\| `concurrency` \| 4 \| 2 peak \(gate-owned\) \|/u);
    assert.match(readme, /\| tokens \| not enforced \| 155 observed \|/u);
  });

  it("counts post-child error evidence when no agent_end exists", () => {
    const readme = readmeOf(
      budgetInput({
        journal: [
          { ts: "2026-07-28T19:00:00.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", callId: "call-0001" },
          {
            ts: "2026-07-28T19:00:30.000Z",
            runId: RUN_ID,
            kind: "error",
            source: "script",
            message: "validator threw after the child answered",
            agent: "default",
            callId: "call-0001",
            executedModel: "test/model",
            durationMs: 30_000,
            usage: { input: 80, output: 20, totalTokens: 100, costTotal: 0 },
          },
        ] as WorkflowJournalLine[],
      }),
    );

    assert.match(readme, /\| `timeoutMs` \| 86400000 ms \| 30000 ms longest child \|/u);
    assert.match(readme, /\| tokens \| not enforced \| 100 observed \|/u);
  });

  it("counts a replayed call apart from the fresh ones and charges it to nothing", () => {
    // A replayed attempt starts no child, so it spends no `totalAgents` and its
    // durationMs measures projecting a recorded answer — folding that into "longest
    // child" would compare a lookup against a per-child fuse.
    //
    // The replayed attempt is deliberately the LONGER of the two, so the assertion
    // below cannot pass by accident: with the replay filter removed the row reads
    // 9000. That ordering is not contrived — a replayed attempt's measured window
    // still covers artifact recording, schema validation and the script's `validate`
    // callback, any of which can outlast a fast fresh child.
    const readme = readmeOf(
      budgetInput({
        journal: [
          {
            ts: "2026-07-28T19:00:00.000Z",
            runId: RUN_ID,
            kind: "agent_start",
            agent: "default",
            callId: "call-0001",
            replayed: true,
          },
          {
            ts: "2026-07-28T19:00:09.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0001",
            status: "completed",
            durationMs: 9_000,
            replayed: true,
          },
          { ts: "2026-07-28T19:00:09.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", callId: "call-0002" },
          {
            ts: "2026-07-28T19:00:15.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0002",
            status: "completed",
            durationMs: 6_000,
            usage: { input: 10, output: 5, totalTokens: 15, costTotal: 0 },
          },
        ] as WorkflowJournalLine[],
      }),
    );

    assert.match(readme, /\| `totalAgents` \| 10000 \| 1 fresh \+ 1 replayed \(not charged\) \|/u);
    // The FRESH child's 6000 ms, not the longer replay projection.
    assert.match(readme, /\| `timeoutMs` \| 86400000 ms \| 6000 ms longest child \|/u);
    // A replayed call reports no usage, so only the fresh child's tokens are observed.
    assert.match(readme, /\| tokens \| not enforced \| 15 observed \|/u);
  });

  it("reports no longest child at all when the whole run was served from records", () => {
    const readme = readmeOf(
      budgetInput({
        journal: [
          {
            ts: "2026-07-28T19:00:00.000Z",
            runId: RUN_ID,
            kind: "agent_start",
            agent: "default",
            callId: "call-0001",
            replayed: true,
          },
          {
            ts: "2026-07-28T19:00:00.003Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0001",
            status: "completed",
            durationMs: 3,
            replayed: true,
          },
        ] as WorkflowJournalLine[],
      }),
    );

    assert.match(readme, /\| `totalAgents` \| 10000 \| 0 fresh \+ 1 replayed \(not charged\) \|/u);
    // "3 ms longest child" would claim a child ran for 3 ms when none ran at all.
    assert.match(readme, /\| `timeoutMs` \| 86400000 ms \| not recorded \|/u);
  });

  it("says tokens are not recorded when the host reported none, rather than 0", () => {
    const readme = readmeOf(
      budgetInput({
        journal: [
          { ts: "2026-07-28T19:00:00.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", callId: "call-0001" },
          {
            ts: "2026-07-28T19:00:01.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0001",
            status: "completed",
            durationMs: 1_000,
          },
        ] as WorkflowJournalLine[],
      }),
    );

    assert.match(readme, /\| tokens \| not enforced \| not recorded \|/u);
  });

  it("omits the section entirely for a caller that supplies no budget", () => {
    const input = budgetInput();
    delete (input as { budget?: unknown }).budget;

    assert.doesNotMatch(readmeOf(input), /## Budget/u);
  });

  it("reports the GATE peak, not the count of overlapping journal intervals", async () => {
    // Six children through a runtime bounded at 2. `agent_start` is written before
    // the gate is acquired, so counting overlapping start/end intervals would say
    // 6 — a limit breach that never happened.
    const runtime = createWorkflowRuntime({
      runId: RUN_ID,
      maxConcurrentAgents: 2,
      agentRunner: async (request) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return {
          ok: true as const,
          status: "completed" as const,
          summary: "done",
          text: "answer",
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    await runtime.dsl.parallel([
      () => runtime.dsl.parallel([() => runtime.dsl.agent("a"), () => runtime.dsl.agent("b")]),
      () => runtime.dsl.parallel([() => runtime.dsl.agent("c"), () => runtime.dsl.agent("d")]),
      () => runtime.dsl.parallel([() => runtime.dsl.agent("e"), () => runtime.dsl.agent("f")]),
    ]);

    const journal = runtime.getJournal();
    assert.equal(journal.filter((line) => line.kind === "agent_start").length, 6);
    assert.equal(runtime.peakAgentConcurrency(), 2);

    const readme = readmeOf(budgetInput({ journal, budget: { applied: DECLARED_BUDGET, peakConcurrency: 2 } }));
    assert.match(readme, /\| `concurrency` \| 4 \| 2 peak \(gate-owned\) \|/u);
    assert.doesNotMatch(readme, /6 peak/u);
  });

  it("shows the applied contract in a REAL run's report, for a script that declares no limit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-report-budget-"));
    roots.push(root);
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Report agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "unbounded.workflow.mjs"),
      'export const meta = { name: "unbounded", description: "declares no limit of any kind" };\n' +
        "export default async function runWorkflow(dsl) {\n" +
        '  return await dsl.agent("answer");\n' +
        "}\n",
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "report-budget" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "unbounded",
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "answer",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    assert.equal(result.ok, true, result.error);
    const readme = readFileSync(path.join(workflowReportDir(root, result.runId), "README.md"), "utf8");
    // A real run that declares nothing: the report names every axis and says out
    // loud that five of the six will not stop it.
    assert.match(readme, /## Budget/u);
    assert.match(readme, /\| `concurrency` \| 4 \| 1 peak \(gate-owned\) \|/u);
    assert.match(readme, /\| `totalAgents` \| unbounded \| 1 fresh \|/u);
    assert.match(readme, /\| `runtimeMs` \| unbounded \|/u);
    assert.match(readme, /\| `timeoutMs` \| unbounded \|/u);
    assert.match(readme, /\| `toolCalls` \| unbounded \| not recorded \|/u);
    assert.match(readme, /\| `turns` \| unbounded \| not recorded \|/u);
  });
});
