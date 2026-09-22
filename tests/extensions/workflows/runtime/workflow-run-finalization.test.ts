/**
 * The finalization matrix: what each terminal step does to the run, in order.
 *
 * Every row below names one step of `workflow-run-finalization.ts` and the exact
 * consequence it is allowed to have. The rows that must NOT change semantic
 * success (the Markdown report) are as load-bearing as the ones that must.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  claimWorkflowOperatorHandoff,
  projectWorkflowHandoffState,
  readWorkflowOperatorHandoff,
} from "../../../../extensions/workflows/runtime/workflow-handoff.js";
import { workflowJournalFile } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { WORKFLOW_OUTPUT_LOCK_FILE } from "../../../../extensions/workflows/runtime/workflow-output.js";
import { workflowReportDir } from "../../../../extensions/workflows/runtime/workflow-run-report.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";
import { executor, project, writeWorkflow } from "../../../fixtures/workflow-durable-project.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway project that also carries the one agent the report family uses. */
function reportProject(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "default.md"),
    "---\nname: default\ndescription: Report agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
  return root;
}

/** An executor that answers every call with one fixed line. */
function answeringExecutor(): AgentExecutor {
  return {
    async run(request: AgentRunRequest) {
      return {
        status: "completed" as const,
        agentName: request.agent?.name ?? "sub-agent",
        reason: "answered",
        text: "answer",
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  };
}

/** Turn `<runDir>/outputs` into a regular FILE, so every write under it fails. */
function blockOutputsDirectory(runDir: string): void {
  mkdirSync(path.join(runDir, "outputs"));
  rmSync(path.join(runDir, "outputs"), { recursive: true });
  writeFileSync(path.join(runDir, "outputs"), "not a directory", "utf8");
}

function trackProject(): string {
  const root = project();
  roots.push(root);
  return root;
}

describe("workflow run finalization", () => {
  it("gives a controlling abort precedence over waiting and over a successful return", async () => {
    const root = trackProject();
    writeWorkflow(
      root,
      "waiting",
      `export default async function run(dsl) {
  dsl.awaitOperator({ reason: "operator input required" });
  return { mode: "prepared" };
}
`,
    );
    writeWorkflow(root, "plain", `export default async function run() { return "done"; }\n`);
    const harness = createHarness(root);

    // Waiting, uninterrupted: the declaration decides.
    const waiting = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "waiting",
    });
    assert.deepEqual(waiting.disposition, { status: "awaiting_operator", detail: "operator input required" });
    assert.equal(waiting.ok, true);

    // The same declaration under a controlling abort: the abort wins.
    const abortedWaiting = new AbortController();
    abortedWaiting.abort({ kind: "operator_stop" });
    const cancelledWait = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: abortedWaiting.signal,
      name: "waiting",
    });
    assert.deepEqual(cancelledWait.disposition, { status: "cancelled", reason: "operator_stop" });
    assert.equal(cancelledWait.ok, false);

    // A plain successful return under the same abort: the abort still wins, and
    // the cancellation is journalled rather than inferred later from the status.
    const abortedPlain = new AbortController();
    abortedPlain.abort({ kind: "session_shutdown" });
    const cancelledSuccess = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: abortedPlain.signal,
      name: "plain",
    });
    assert.deepEqual(cancelledSuccess.disposition, { status: "cancelled", reason: "session_shutdown" });
    assert.equal(cancelledSuccess.ok, false);
    assert.ok(
      cancelledSuccess.journal.some((line) => line.message === "[workflow:cancelled] reason=session_shutdown"),
      "the cancellation must be recorded once in the run journal",
    );
  });

  it("fails the run on a stale workspace lease and then releases nothing", async () => {
    const root = trackProject();
    const runName = "stale-fencing";
    const workspace = path.join(root, ".locus-pi", "workspaces", runName);
    const lockFile = path.join(workspace, WORKFLOW_OUTPUT_LOCK_FILE);
    writeWorkflow(root, "stale-fencing", `export default (dsl) => dsl.agent("break the lease");\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "stale-fencing",
      runName,
      // Replace the fencing token while the run is still executing, long before
      // finalization reads it back.
      createExecutor: executor(() => {
        const record = JSON.parse(readFileSync(lockFile, "utf8")) as Record<string, unknown>;
        writeFileSync(lockFile, `${JSON.stringify({ ...record, fencingToken: "00000000-taken-over" })}\n`, "utf8");
        return "done";
      }),
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.disposition, { status: "failed" });
    assert.match(result.error ?? "", /fencing token is stale/u);
    // The failed fencing check consumes the release: a lease this run no longer
    // owns must not be removed a second time, and no release error is recorded.
    assert.equal(result.finalizationErrors, undefined);
    assert.equal(existsSync(lockFile), true, "the successor's lock file must survive an unowned release");
    rmSync(lockFile);
  });

  it("releases the workspace lease exactly once and leaves the workspace claimable", async () => {
    const root = trackProject();
    const runName = "released-lease";
    const lockFile = path.join(root, ".locus-pi", "workspaces", runName, WORKFLOW_OUTPUT_LOCK_FILE);
    writeWorkflow(root, "released-lease", `export default async function run() { return "done"; }\n`);
    const harness = createHarness(root);

    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "released-lease",
      runName,
    });
    assert.equal(first.ok, true);
    assert.equal(existsSync(lockFile), false, "the lease must be released before the run returns");
    assert.equal(first.finalizationErrors, undefined);

    // Released exactly once, not zero times: the same workspace is claimable again.
    const second = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "released-lease",
      runName,
    });
    assert.equal(second.ok, true);
    assert.equal(existsSync(lockFile), false);
  });

  it("records a failed Markdown report WITHOUT turning a successful run into a failed one", async () => {
    const root = reportProject("workflow-report-only-blocked-");
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "structured.workflow.mjs"),
      // A STRUCTURED result: `runtime/result.json` already owns it, so the
      // mandatory terminal-prose step writes nothing and only the best-effort
      // report can fail here.
      'export default async function run() { return { verdict: "accepted" }; }\n',
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "report-only-blocked" });
    const events: WorkflowJournalLine[] = [];

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "structured",
      onRunStart: ({ runDir }) => blockOutputsDirectory(runDir),
      onEvent: (line) => events.push(line),
      createExecutor: answeringExecutor,
    });

    // The readable projection failed. The semantic verdict is untouched.
    assert.equal(result.ok, true);
    assert.deepEqual(result.disposition, { status: "completed" });
    assert.deepEqual(result.result, { verdict: "accepted" });
    assert.equal(result.error, undefined);
    assert.equal(result.failureDiagnostic, undefined);
    // What DOES change is the silence: the failure is named in both projections.
    assert.deepEqual(
      result.finalizationErrors?.map((entry) => entry.stage),
      ["report"],
    );
    assert.ok(
      events.some((line) => (line.message ?? "").includes("Workflow run report was not written")),
      "a failed report reaches the live surface",
    );
    assert.equal(result.resultPersistence.ok, true);
    const envelope = JSON.parse(readFileSync(workflowResultFile(result.runDir), "utf8")) as {
      ok?: boolean;
      journal?: unknown;
      finalizationErrors?: Array<{ stage?: string }>;
    };
    assert.equal(envelope.ok, true);
    // The complete chronological journal has ONE owner: journal.ndjson.
    assert.equal(envelope.journal, undefined);
    assert.deepEqual(
      envelope.finalizationErrors?.map((entry) => entry.stage),
      ["report"],
    );
  });

  it("releases an operator-handoff claim the run never bound", async () => {
    const root = trackProject();
    writeWorkflow(
      root,
      "handoff-source",
      `export default async function run(dsl) {
  const intentRef = dsl.publishArtifact("intent.md", "review current changes", "prepare");
  dsl.awaitOperator({
    reason: "operator input required",
    operatorHandoff: {
      title: "Choose review scope",
      questions: [{
        kind: "select",
        id: "scope",
        prompt: "What should be reviewed?",
        options: [{ label: "Current changes" }, { label: "Last commit" }],
      }],
      continuationArtifactRefs: [intentRef],
    },
  });
  return { mode: "prepared" };
}
`,
    );
    const harness = createHarness(root);
    const source = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "handoff-source",
    });
    const read = readWorkflowOperatorHandoff(source);
    assert.equal(read.status, "ready");
    if (read.status !== "ready") throw new Error("expected a ready handoff");

    const claimed = claimWorkflowOperatorHandoff(root, read.handoff);
    assert.equal(claimed.status, "claimed");
    if (claimed.status !== "claimed") throw new Error("expected a claim");

    // A claim WITHOUT its continuation is refused before the runner binds it.
    const unbound = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "handoff-source",
      operatorHandoffClaim: claimed.claim,
    });
    assert.equal(unbound.ok, false);
    assert.match(unbound.error ?? "", /handoff claim requires a continuation/u);
    // Finalization gives the unbound claim back, so the handoff stays offerable
    // instead of being pinned to a run that never took it.
    assert.deepEqual(projectWorkflowHandoffState(root, read.handoff), { status: "pending" });
  });

  it("journals a failed report write instead of letting the budget evidence vanish silently", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-report-blocked-"));
    roots.push(root);
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Report agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "report-fail.workflow.mjs"),
      'export const meta = { name: "report-fail", description: "one stage" };\n' +
        "export default async function runWorkflow(dsl) {\n" +
        '  return await dsl.agent("answer");\n' +
        "}\n",
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "report-blocked" });
    const events: WorkflowJournalLine[] = [];
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "report-fail",
      // A regular FILE where the outputs directory must be: the write fails and the
      // module returns { ok: false } instead of throwing, exactly as documented.
      // Planted once the run id exists and long before the report is written.
      onRunStart: ({ runDir }) => {
        mkdirSync(path.join(runDir, "outputs"));
        rmSync(path.join(runDir, "outputs"), { recursive: true });
        writeFileSync(path.join(runDir, "outputs"), "not a directory", "utf8");
      },
      onEvent: (line) => events.push(line),
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

    // The secondary report failure is recorded, and the missing mandatory
    // terminal output makes the run fail instead of claiming an unreadable success.
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /terminal output was not persisted/u);
    const failure = result.journal.find(
      (line) => line.kind === "error" && (line.message ?? "").includes("Workflow run report was not written"),
    );
    assert.ok(failure !== undefined, "the failed report write must leave a trace in the journal");
    assert.equal(failure.source, "runtime");
    assert.ok(
      events.some((line) => (line.message ?? "").includes("Workflow run report was not written")),
      "and reach the live surface too",
    );
    // The durable journal on disk carries it, not only the returned envelope.
    const persisted = readFileSync(workflowJournalFile(result.runDir), "utf8");
    assert.match(persisted, /Workflow run report was not written/u);
    assert.match(persisted, /Workflow terminal output was not persisted/u);
    // result.json keeps only the bounded independent finalization projection.
    // The complete chronological journal has one owner: journal.ndjson.
    assert.equal(result.resultPersistence.ok, true);
    const envelope = JSON.parse(readFileSync(workflowResultFile(result.runDir), "utf8")) as {
      journal?: unknown;
      finalizationErrors?: Array<{ stage?: string; message?: string }>;
    };
    assert.equal(envelope.journal, undefined);
    assert.deepEqual(
      envelope.finalizationErrors?.map((entry) => entry.stage),
      ["terminal-output", "report"],
    );
    assert.match(envelope.finalizationErrors?.[1]?.message ?? "", /Workflow run report was not written/u);
  });

  it("persists finalization errors when the best-effort journal append also fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-finalization-fallback-"));
    roots.push(root);
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Report agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "finalization-fallback.workflow.mjs"),
      'export default async function runWorkflow(dsl) { return await dsl.agent("answer"); }\n',
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "finalization-fallback" });
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "finalization-fallback",
      onRunStart: ({ runDir }) => {
        mkdirSync(path.join(runDir, "outputs"));
        rmSync(path.join(runDir, "outputs"), { recursive: true });
        writeFileSync(path.join(runDir, "outputs"), "not a directory", "utf8");
        const journalPath = workflowJournalFile(runDir);
        rmSync(journalPath);
        mkdirSync(journalPath);
      },
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

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.finalizationErrors?.map((entry) => entry.stage),
      ["terminal-output", "report"],
    );
    const envelope = JSON.parse(readFileSync(workflowResultFile(result.runDir), "utf8")) as {
      journal?: unknown;
      finalizationErrors?: Array<{ stage: string; message: string }>;
    };
    assert.equal(envelope.journal, undefined);
    assert.deepEqual(
      envelope.finalizationErrors?.map((entry) => entry.stage),
      ["terminal-output", "report"],
    );
  });

  it("reprojects the readable report as failed when result.json cannot be persisted", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-result-envelope-blocked-"));
    roots.push(root);
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Report agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi", "workflows", "result-fail.workflow.mjs"),
      'export default async function runWorkflow() { return "answer"; }\n',
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "result-envelope-blocked" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "result-fail",
      onRunStart: ({ runDir }) => {
        mkdirSync(workflowResultFile(runDir));
      },
      createExecutor: (): AgentExecutor => ({
        async run() {
          throw new Error("this workflow starts no child");
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.resultPersistence.ok, false);
    const readme = readFileSync(path.join(workflowReportDir(root, result.runId), "README.md"), "utf8");
    assert.match(readme, /- Status: failed/u);
    assert.match(readme, /Workflow result was not persisted/u);
    assert.doesNotMatch(readme, /- Status: completed/u);
  });
});
