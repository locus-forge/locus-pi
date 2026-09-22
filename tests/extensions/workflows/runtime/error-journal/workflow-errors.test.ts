import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournal,
} from "../../../../../extensions/workflows/runtime/workflow-journal.js";
import { ensureWorkflowRunDir } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { createWorkflowTranscript } from "../../../../../extensions/workflows/transcript/workflow-transcript.js";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { projectErrorJournalPath } from "../../../../../extensions/_shared/host/error-journal.js";
import { createHarness } from "../../../../test-harness.js";
const roots: string[] = [];
function project() {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-errors-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rows(root: string) {
  return readFileSync(projectErrorJournalPath(root), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
}
const failure: WorkflowAgentResult = {
  ok: false,
  status: "failed",
  failureCause: "provider-error",
  summary: "Provider quota exhausted",
  diagnostics: [],
};

describe("workflow error entry point", () => {
  it("retains failed calls after report-mode continuation and shows exact pointers in a successful transcript", async () => {
    const root = project(),
      runId = "continued",
      runDir = ensureWorkflowRunDir(root, runId);
    const { dsl, getJournal } = createWorkflowRuntime({
      runId,
      journal: createWorkflowJournalSink(root, runId, undefined, "design"),
      agentRunner: async (req) =>
        req.label === "review"
          ? failure
          : { ok: true, status: "completed", summary: "done", text: "review finding: needs revision", diagnostics: [] },
    });
    const report = await dsl.agent("review", {
      label: "review",
      title: "Review design",
      phase: "specification",
      result: "report",
    });
    await dsl.agent(report, { label: "arbiter" });
    expect(rows(root)).toHaveLength(1);
    expect(rows(root)[0]).toMatchObject({
      source: "workflow",
      event: "agent_end",
      workflow: "design",
      runId,
      callId: "call-0001",
      label: "review",
      phase: "specification",
      cause: "provider-error",
      message: "Provider quota exhausted",
    });
    expect(rows(root)[0]).not.toHaveProperty("attempt");
    const saved = readWorkflowRunJournal(root, runId);
    expect(saved).toContainEqual(
      expect.objectContaining({ errorLogPath: projectErrorJournalPath(root), message: "Provider quota exhausted" }),
    );
    const transcript = createWorkflowTranscript(createHarness(root).ctx, "design", "tool");
    const digest = transcript.finish({
      runId,
      runDir,
      ok: true,
      result: "useful design with limitation",
      journal: getJournal(),
      resultPersistence: { ok: true, path: path.join(runDir, "runtime/result.json") },
    }).digest;
    expect(digest).toContain("Execution failures (1");
    expect(digest).toContain("provider-error — Provider quota exhausted");
    expect(digest).toContain(projectErrorJournalPath(root));
    expect(digest).toContain(rows(root)[0].journalPath);
    expect(digest).toContain("review");
  });
  it("keeps parallel attempt identities and raw throws distinct", async () => {
    const root = project(),
      runId = "parallel";
    const { dsl } = createWorkflowRuntime({
      runId,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async (req) => {
        if (req.label === "throw") throw new Error("host crashed");
        return failure;
      },
    });
    await dsl.parallel([
      () => dsl.agent("a", { label: "a", result: "report" }),
      () => dsl.agent("b", { label: "b", result: "report" }),
    ]);
    await expect(dsl.agent("crash", { label: "throw", result: "report" })).rejects.toThrow("host crashed");
    expect(rows(root)).toHaveLength(3);
    expect(new Set(rows(root).map((r) => r.callId)).size).toBe(3);
    expect(rows(root)[2]).toMatchObject({ event: "error", message: "host crashed" });
  });
  it("retains the first attempt after a retry succeeds, using the real journal path", async () => {
    const root = project(),
      runId = "retry";
    let calls = 0;
    const { dsl, getJournal } = createWorkflowRuntime({
      runId,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async () =>
        ++calls === 1
          ? { ...failure, failureCause: "host-turn-timeout" }
          : { ok: true, status: "completed", summary: "done", text: "done", diagnostics: [] },
    });
    await expect(dsl.agent("review", { label: "review", attempts: 2 })).resolves.toBe("done");
    const first = getJournal().find((line) => line.kind === "agent_end");
    expect(rows(root)).toHaveLength(1);
    expect(rows(root)[0]).toMatchObject({ callId: first?.callId, logicalCallId: first?.logicalCallId, attempt: 1 });
    expect(readFileSync(rows(root)[0].journalPath, "utf8")).toContain(rows(root)[0].message);
  });
  it("discloses unavailable source evidence without replacing the original runtime failure", async () => {
    const root = project(),
      runId = "unwritable-source";
    const sink = createWorkflowJournalSink(root, runId);
    const runDir = ensureWorkflowRunDir(root, runId);
    const journalPath = path.join(runDir, "runtime/journal.ndjson");
    sink.initialize({ ts: "start", runId, kind: "log", message: "started" });
    chmodSync(journalPath, 0o400);
    try {
      const { dsl, getJournal } = createWorkflowRuntime({
        runId,
        journal: sink,
        agentRunner: async () => {
          throw new Error("original host failure");
        },
      });
      await expect(dsl.agent("review", { label: "review" })).rejects.toThrow("original host failure");
      const record = rows(root)[0];
      expect(record.message).toBe("original host failure");
      expect(record).not.toHaveProperty("journalPath");
      expect(record.evidenceWarning).toContain("Source journal write failed");
      expect(readFileSync(journalPath, "utf8")).not.toContain("original host failure");
      const transcript = createWorkflowTranscript(createHarness(root).ctx, "source-failure", "tool");
      const digest = transcript.finish({
        runId,
        runDir,
        ok: false,
        error: "original host failure",
        resultPersistence: { ok: true, path: path.join(runDir, "runtime/result.json") },
        result: null,
        journal: getJournal(),
      }).digest;
      expect(digest).toContain("Source journal write failed");
      expect(digest).toContain(projectErrorJournalPath(root));
    } finally {
      chmodSync(journalPath, 0o600);
    }
  });
  it("does not conceal the original failure when the index cannot be written", async () => {
    const root = project(),
      runId = "blocked-index",
      log = projectErrorJournalPath(root);
    mkdirSync(path.dirname(log), { recursive: true });
    mkdirSync(log);
    const { dsl, getJournal } = createWorkflowRuntime({
      runId,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async () => failure,
    });
    await expect(dsl.agent("review")).rejects.toThrow("Provider quota exhausted");
    expect(getJournal()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        message: "Provider quota exhausted",
        errorLogWarning: expect.stringContaining("unsafe log file"),
      }),
    );
  });
  it("does not duplicate the terminal pointer when saving the result also fails", async () => {
    const root = project(),
      harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      script: 'throw new Error("first failure");',
      onRunStart: ({ runDir }) => {
        mkdirSync(path.join(runDir, "runtime/result.json"));
      },
    });
    expect(result.ok).toBe(false);
    expect(result.resultPersistence.ok).toBe(false);
    expect(rows(root).filter((row) => row.event === "workflow_result")).toHaveLength(1);
    expect(rows(root)).toContainEqual(expect.objectContaining({ event: "error" }));
  });
  it("does not store an inline script as the workflow name", async () => {
    const root = project(),
      harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      script: 'throw new Error("inline failed");',
    });
    expect(result.ok).toBe(false);
    expect(rows(root)[0]).not.toHaveProperty("workflow");
  });
  it("indexes a script exception but not a semantic refusal", async () => {
    const root = project(),
      harness = createHarness(root);
    for (const [name, body] of [
      ["decision", 'return { ok: false, status: "needs_owner", summary: "choose direction" };'],
      ["crash", 'throw new Error("script exploded");'],
    ]) {
      writeFileSync(path.join(root, name + ".workflow.mjs"), `export default async function run() { ${body} }`);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: name + ".workflow.mjs",
      });
      expect(result.ok).toBe(false);
    }
    expect(rows(root)).toHaveLength(1);
    expect(rows(root)[0]).toMatchObject({ event: "workflow_result", message: "script exploded" });
  });
});
