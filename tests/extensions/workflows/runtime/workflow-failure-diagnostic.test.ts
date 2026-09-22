import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  buildWorkflowFailureDiagnostic,
  formatWorkflowFailureDiagnosticLines,
  parseWorkflowFailureDiagnostic,
} from "../../../../extensions/workflows/runtime/workflow-failure.js";
import {
  readWorkflowRunResult,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

function journal(runId: string, phases: readonly string[]): WorkflowJournalLine[] {
  return phases.map((phase, index) => ({
    ts: `2026-01-01T00:00:0${index}.000Z`,
    runId,
    kind: "phase",
    phase,
  })) as WorkflowJournalLine[];
}

describe("workflow failure diagnostic", () => {
  it("names the failing stage, owning script, and the answer that stage produced", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/.pi/locus-pi/runs/run-1",
      journalPath: "/repo/.pi/locus-pi/runs/run-1/journal.ndjson",
      journal: [
        ...journal("run-1", ["resolve-scope", "inventory-changes"]),
        {
          ts: "2026-01-01T00:00:02.000Z",
          runId: "run-1",
          kind: "agent_end",
          status: "completed",
          callId: "call-0003",
          phase: "inventory-changes",
        },
      ],
      origin: "script",
      error: "review inventory returned neither a coverage entry nor the declaration",
      target: { ref: "review" },
      scriptIdentity: { sourcePath: "/repo/extensions/workflows/examples/review/review.workflow.mjs" },
      // Exactly the shape the artifact store records: relative to the run's
      // artifacts directory, so the pointer must resolve under runtime/artifacts.
      artifacts: [
        { kind: "answer", stage: "resolve-scope", relativePath: "answers/call-0002-scope.md.md" },
        {
          kind: "answer",
          callId: "call-0003",
          stage: "inventory-changes",
          relativePath: "answers/call-0003-inventory.md.md",
        },
        { kind: "published", stage: "resolve-scope", relativePath: "published/published-0001-intent.md" },
      ],
    });

    expect(diagnostic).toEqual({
      origin: "script",
      message: "review inventory returned neither a coverage entry nor the declaration",
      stage: "inventory-changes",
      workflow: "review",
      scriptPath: "extensions/workflows/examples/review/review.workflow.mjs",
      evidencePath: ".pi/locus-pi/runs/run-1/runtime/artifacts/answers/call-0003-inventory.md.md",
      journalPath: ".pi/locus-pi/runs/run-1/journal.ndjson",
      repairRequest:
        'Fix the "review" workflow: its script rejected the run at stage "inventory-changes" — review inventory ' +
        "returned neither a coverage entry nor the declaration. " +
        "Script: extensions/workflows/examples/review/review.workflow.mjs. " +
        "Failure evidence: .pi/locus-pi/runs/run-1/runtime/artifacts/answers/call-0003-inventory.md.md. " +
        "Run journal: .pi/locus-pi/runs/run-1/journal.ndjson.",
    });
    // The repair request survives a round trip through result.json unchanged.
    expect(parseWorkflowFailureDiagnostic(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic);
  });

  it("states what it cannot prove instead of guessing a stage, script, or answer", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/.pi/locus-pi/runs/run-2",
      journalPath: "/repo/.pi/locus-pi/runs/run-2/journal.ndjson",
      journal: [],
      error: "  Pi SDK host: connection refused  ",
    });

    expect(diagnostic.origin).toBe("runtime");
    expect(diagnostic).not.toHaveProperty("stage");
    expect(diagnostic).not.toHaveProperty("scriptPath");
    expect(diagnostic).not.toHaveProperty("evidencePath");
    expect(diagnostic.repairRequest).toBe(
      "Diagnose this workflow: the workflow runtime failed — Pi SDK host: connection refused. " +
        "Run journal: .pi/locus-pi/runs/run-2/journal.ndjson.",
    );
    expect(formatWorkflowFailureDiagnosticLines(diagnostic)).toEqual([
      "journal: .pi/locus-pi/runs/run-2/journal.ndjson",
    ]);
    expect(formatWorkflowFailureDiagnosticLines(diagnostic, { repairRequest: true }).at(-1)).toBe(
      `copy: ${diagnostic.repairRequest}`,
    );
  });

  it("rejects a persisted diagnostic that lost a required field", () => {
    expect(parseWorkflowFailureDiagnostic({ origin: "script", message: "x", journalPath: "j" })).toBeUndefined();
    expect(
      parseWorkflowFailureDiagnostic({ origin: "guess", message: "x", journalPath: "j", repairRequest: "r" }),
    ).toBeUndefined();
    expect(parseWorkflowFailureDiagnostic("failed")).toBeUndefined();
  });

  it("attaches the diagnostic to a thrown script run, persists it, and reads it back", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-failure-diagnostic-"));
    const harness = createHarness(root, { sessionId: "wf-failure-diagnostic" });
    try {
      writeFileSync(
        path.join(root, "boom.workflow.mjs"),
        [
          "export const meta = { name: 'boom', description: 'throws in a declared stage' };",
          "export default async function run({ agent, phase }) {",
          "  phase('inventory-changes');",
          "  await agent('inventory the changes', { label: 'inventory' });",
          "  throw new Error('inventory answer does not follow its prompt');",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "boom.workflow.mjs",
        createExecutor: () => ({
          async run(request: AgentRunRequest) {
            return {
              status: "completed" as const,
              agentName: request.agent?.name ?? "sub-agent",
              reason: "answered",
              text: "inventory: two files changed",
              diagnostics: [],
              lifecycleEntryIds: [],
            };
          },
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.failureDiagnostic).toMatchObject({
        origin: "script",
        message: "inventory answer does not follow its prompt",
        stage: "inventory-changes",
        workflow: "boom.workflow.mjs",
        scriptPath: "boom.workflow.mjs",
      });
      expect(result.failureDiagnostic?.journalPath).toContain(result.runId);
      // The pointer is only useful if it opens. Asserting the string shape alone
      // is how a two-segment path error survived: the producer writes the answer
      // relative to the artifacts directory, and the diagnostic must say so.
      const evidencePath = result.failureDiagnostic?.evidencePath;
      expect(evidencePath).toBeDefined();
      expect(existsSync(path.resolve(root, evidencePath ?? ""))).toBe(true);
      expect(readFileSync(path.resolve(root, evidencePath ?? ""), "utf8")).toContain("inventory: two files changed");
      expect(result.failureDiagnostic?.repairRequest).toContain('Fix the "boom.workflow.mjs" workflow');
      expect(result.failureDiagnostic?.repairRequest).toContain("Script: boom.workflow.mjs");

      const persisted = JSON.parse(readFileSync(result.resultPersistence.path, "utf8")) as {
        failureDiagnostic?: unknown;
      };
      expect(persisted.failureDiagnostic).toEqual(result.failureDiagnostic);
      expect(readWorkflowRunResult(root, result.runId)?.failureDiagnostic).toEqual(result.failureDiagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("points to the failed child's persisted result instead of a prior successful answer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-failed-child-"));
    const harness = createHarness(root, { sessionId: "wf-failed-child" });
    try {
      writeFileSync(
        path.join(root, "sequence.workflow.mjs"),
        [
          "export default async function run({ agent, phase }) {",
          "  phase('review');",
          "  await agent('child A success', { label: 'A' });",
          "  await agent('child B failure', { label: 'B' });",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "sequence.workflow.mjs",
        createExecutor: (options) => ({
          async run(request) {
            const failed = request.task.includes("child B");
            const childName = failed ? "child-b" : "child-a";
            const tracePath = path.join(options.reportsDir!, `${childName}.jsonl`);
            mkdirSync(options.reportsDir!, { recursive: true });
            writeFileSync(tracePath, `${JSON.stringify({ type: "session", id: childName })}\n`, "utf8");
            return failed
              ? {
                  status: "failed" as const,
                  reason: "child B failed",
                  failureCause: "call-timeout" as const,
                  diagnostics: ["child B evidence"],
                  lifecycleEntryIds: [],
                  childTrace: { path: tracePath, format: "pi-session-jsonl" as const, childSessionId: childName },
                }
              : {
                  status: "completed" as const,
                  reason: "child A completed",
                  text: "child A answer",
                  diagnostics: [],
                  lifecycleEntryIds: [],
                  childTrace: { path: tracePath, format: "pi-session-jsonl" as const, childSessionId: childName },
                };
          },
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.failureDiagnostic?.evidencePath).toContain("/results/");
      expect(result.failureDiagnostic?.evidencePath).not.toContain("answers/");
      const failedEvidence = result.failureDiagnostic?.evidencePath;
      expect(failedEvidence).toBeDefined();
      const failedEnvelope = JSON.parse(readFileSync(path.resolve(root, failedEvidence!), "utf8")) as {
        kind?: string;
        content?: string;
      };
      expect(failedEnvelope.kind).toBe("json");
      expect(failedEnvelope.content).toContain('"status": "failed"');
      expect(failedEnvelope.content).toContain('"reason": "child B failed"');
      expect(result.failureDiagnostic?.repairRequest).toContain("Failure evidence:");
      const persisted = JSON.parse(readFileSync(result.resultPersistence.path, "utf8")) as {
        failureDiagnostic?: { evidencePath?: string };
      };
      expect(persisted.failureDiagnostic?.evidencePath).toBe(result.failureDiagnostic?.evidencePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps retries exact, omits missing evidence, and refuses ambiguous parallel targets", () => {
    const base = {
      projectRoot: "/repo",
      runDir: "/repo/.pi/locus-pi/runs/run-evidence",
      journalPath: "/repo/.pi/locus-pi/runs/run-evidence/journal.ndjson",
      error: "child execution failed",
      target: { ref: "sequence" },
    } as const;
    const retryJournal = [
      {
        kind: "agent_end" as const,
        runId: "run-evidence",
        ts: "t1",
        status: "failed",
        callId: "call-a",
        phase: "review",
        resultArtifact: "/tmp/a-result.json",
      },
      {
        kind: "agent_end" as const,
        runId: "run-evidence",
        ts: "t2",
        status: "failed",
        callId: "call-b",
        phase: "review",
        resultArtifact: "/tmp/b-result.json",
        childTrace: { path: "/tmp/b-trace.jsonl", format: "pi-session-jsonl" as const, childSessionId: "b" },
      },
    ];
    const firstRetryLine = retryJournal[0]!;
    const retry = buildWorkflowFailureDiagnostic({
      ...base,
      journal: retryJournal,
      failedChild: { resultArtifact: "/tmp/b-result.json", childTrace: { path: "/tmp/b-trace.jsonl" } },
      artifacts: [
        { kind: "answer", callId: "call-a", stage: "review", relativePath: "answers/call-a.md" },
        { kind: "result", callId: "call-b", stage: "review", relativePath: "results/call-b/result.json" },
      ],
    });
    expect(retry.evidencePath).toBe(".pi/locus-pi/runs/run-evidence/runtime/artifacts/results/call-b/result.json");

    const transcriptOnly = buildWorkflowFailureDiagnostic({
      ...base,
      journal: retryJournal.slice(1),
      failedChild: { childTrace: { path: "/tmp/b-trace.jsonl" } },
      artifacts: [{ kind: "transcript", callId: "call-b", stage: "review", relativePath: "transcripts/call-b.jsonl" }],
    });
    expect(transcriptOnly.evidencePath).toBe(
      ".pi/locus-pi/runs/run-evidence/runtime/artifacts/transcripts/call-b.jsonl",
    );

    const missing = buildWorkflowFailureDiagnostic({
      ...base,
      journal: retryJournal.slice(1),
      failedChild: { resultArtifact: "/tmp/b-result.json", childTrace: { path: "/tmp/b-trace.jsonl" } },
      artifacts: [{ kind: "answer", callId: "call-a", stage: "review", relativePath: "answers/call-a.md" }],
    });
    expect(missing).not.toHaveProperty("evidencePath");

    const parallel = buildWorkflowFailureDiagnostic({
      ...base,
      journal: [
        { ...firstRetryLine, callId: "call-left", resultArtifact: "/tmp/left-result.json" },
        { ...firstRetryLine, callId: "call-right", resultArtifact: "/tmp/right-result.json" },
      ],
      artifacts: [
        { kind: "result", callId: "call-left", relativePath: "results/left/result.json" },
        { kind: "result", callId: "call-right", relativePath: "results/right/result.json" },
      ],
    });
    expect(parallel).not.toHaveProperty("evidencePath");
  });

  it("keeps the later script-owned answer after an earlier child failure was handled", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/.pi/locus-pi/runs/run-handled",
      journalPath: "/repo/.pi/locus-pi/runs/run-handled/journal.ndjson",
      journal: [
        {
          ts: "2026-01-01T00:00:00.000Z",
          runId: "run-handled",
          kind: "agent_end",
          status: "failed",
          callId: "call-a",
          phase: "review",
          resultArtifact: "/tmp/a-result.json",
        },
        {
          ts: "2026-01-01T00:00:01.000Z",
          runId: "run-handled",
          kind: "agent_end",
          status: "completed",
          callId: "call-b",
          phase: "review",
        },
      ],
      origin: "script",
      error: "validation rejected the successful review answer",
      target: { ref: "sequence" },
      artifacts: [
        { kind: "result", callId: "call-a", stage: "review", relativePath: "results/call-a/result.json" },
        { kind: "answer", callId: "call-b", stage: "review", relativePath: "answers/call-b-review.md" },
      ],
    });

    expect(diagnostic.evidencePath).toBe(".pi/locus-pi/runs/run-handled/runtime/artifacts/answers/call-b-review.md");
  });

  it("does not blame a successful answer for a runtime finalization failure", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/run",
      journalPath: "/repo/run/runtime/journal.ndjson",
      origin: "runtime",
      error: "result persistence failed",
      journal: [{ runId: "run", ts: "t", kind: "agent_end", callId: "call-success", status: "completed" }],
      artifacts: [{ kind: "answer", callId: "call-success", relativePath: "answers/success.md" }],
    });
    expect(diagnostic).not.toHaveProperty("evidencePath");
    expect(diagnostic.repairRequest).not.toContain("success.md");
    expect(diagnostic.journalPath).toBe("run/runtime/journal.ndjson");
  });

  it("does not replace a missing last-call answer with an older answer in the same phase", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/run",
      journalPath: "/repo/run/runtime/journal.ndjson",
      origin: "script",
      error: "answer rejected",
      journal: [{ runId: "run", ts: "t", kind: "agent_end", status: "completed", callId: "call-new", phase: "review" }],
      artifacts: [{ kind: "answer", callId: "call-old", stage: "review", relativePath: "answers/old.md" }],
    });
    expect(diagnostic).not.toHaveProperty("evidencePath");
  });

  it.each([
    {
      name: "handled child inside the currently failing group",
      body: `await parallel([
        async () => { try { await agent('FAIL_HANDLED', { label: 'handled' }); } catch {} return 'handled'; },
        async () => { await agent('OK_LATER', { label: 'later' }); throw new Error('branch configuration failed'); }
      ]);`,
      expectedLabel: undefined,
    },
    {
      name: "phase change after a completed answer",
      body: `phase('collect'); await agent('OK_COLLECT', { label: 'collect' });
        phase('publish'); throw new Error('publish configuration failed');`,
      expectedLabel: undefined,
      expectedError: "publish configuration failed",
    },
    {
      name: "script rejection of a completed group aggregate",
      body: `await parallel([() => agent('OK_LEFT', { label: 'left' }), () => agent('OK_RIGHT', { label: 'right' })]);
        throw new Error('aggregate rejected');`,
      expectedLabel: undefined,
      expectedError: "aggregate rejected",
    },
    {
      name: "caught group followed by script rejection",
      body: `try { await parallel([() => agent('FAIL_OLD', { label: 'old-fail' })]); } catch {}
        await agent('OK_FINAL', { label: 'later-success' });
        throw new Error('reject the later answer');`,
      expectedLabel: "later-success",
    },
    {
      name: "one failed child in the current group",
      body: `await parallel([() => agent('FAIL_NEW', { label: 'new-fail' }), () => agent('OK_NEW', { label: 'new-success' })]);`,
      expectedLabel: undefined,
    },
    {
      name: "ambiguous current group",
      body: `await parallel([() => agent('FAIL_LEFT', { label: 'left' }), () => agent('FAIL_RIGHT', { label: 'right' })]);`,
      expectedLabel: undefined,
    },
    {
      name: "historical group followed by a different failing group",
      body: `try { await parallel([() => agent('FAIL_OLD', { label: 'old-fail' })]); } catch {}
        await parallel([() => agent('FAIL_NEW', { label: 'new-fail' }), () => agent('OK_NEW', { label: 'new-success' })]);`,
      expectedLabel: undefined,
    },
    {
      name: "one nested failed child",
      body: `await parallel([() => parallel([() => agent('FAIL_NESTED', { label: 'nested-fail' })]), () => agent('OK_PEER', { label: 'peer' })]);`,
      expectedLabel: undefined,
    },
    {
      name: "nested and direct failures remain ambiguous",
      body: `await parallel([() => parallel([() => agent('FAIL_NESTED', { label: 'nested-fail' })]), () => agent('FAIL_DIRECT', { label: 'direct-fail' })]);`,
      expectedLabel: undefined,
    },
    {
      name: "successful retry does not compete with the current failed child",
      body: `await parallel([() => agent('RETRY_OK', { label: 'retry', attempts: 2 }), () => agent('FAIL_NEW', { label: 'new-fail' })]);`,
      expectedLabel: undefined,
    },
  ])("binds only current causal evidence: $name", async ({ body, expectedLabel, expectedError }) => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-causal-group-"));
    const harness = createHarness(root, { sessionId: "wf-causal-group" });
    const attempts = new Map<string, number>();
    let sessions = 0;
    try {
      writeFileSync(
        path.join(root, "group.workflow.mjs"),
        `export default async ({ agent, parallel, phase }) => { ${body} };\n`,
      );
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "group.workflow.mjs",
        createExecutor: (options) => ({
          async run(request) {
            const key = request.task.match(/\b(?:FAIL|OK)_[A-Z]+\b|\bRETRY_OK\b/)?.[0];
            expect(key).toBeDefined();
            const count = (attempts.get(key!) ?? 0) + 1;
            attempts.set(key!, count);
            const failed = key!.startsWith("FAIL_") || (key === "RETRY_OK" && count === 1);
            const name = `child-${++sessions}`;
            mkdirSync(options.reportsDir!, { recursive: true });
            const tracePath = path.join(options.reportsDir!, `${name}.jsonl`);
            writeFileSync(tracePath, `${JSON.stringify({ type: "session", id: name })}\n`);
            return {
              status: failed ? ("failed" as const) : ("completed" as const),
              reason: failed ? "test child failed" : "test child completed",
              ...(failed ? { failureCause: "call-timeout" as const } : { text: key! }),
              diagnostics: [],
              lifecycleEntryIds: [],
              childTrace: { path: tracePath, format: "pi-session-jsonl" as const, childSessionId: name },
            };
          },
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        expectedError ?? (expectedLabel === "later-success" ? "reject the later answer" : "parallel failed"),
      );
      const evidence = result.failureDiagnostic?.evidencePath;
      if (expectedLabel === undefined) {
        expect(evidence).toBeUndefined();
      } else {
        const owner = result.journal.find((line) => line.kind === "agent_end" && line.label === expectedLabel);
        expect(owner?.callId).toBeDefined();
        expect(owner?.status).toBe(expectedLabel === "later-success" ? "completed" : "failed");
        expect(evidence).toContain(owner!.callId);
        expect(existsSync(path.resolve(root, evidence!))).toBe(true);
      }
      const persisted = JSON.parse(readFileSync(result.resultPersistence.path, "utf8"));
      expect(persisted.failureDiagnostic).toEqual(result.failureDiagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves deliberate returned-outcome failures without a repair request", async () => {
    const cases = [
      { name: "ok-false", expression: "{ ok: false, summary: 'Acceptance remains open' }" },
      { name: "blocked", expression: "{ status: 'blocked', summary: 'Owner decision required' }" },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(path.join(tmpdir(), `wf-semantic-${testCase.name}-`));
      const harness = createHarness(root, { sessionId: `wf-semantic-${testCase.name}` });
      try {
        writeFileSync(
          path.join(root, "verdict.workflow.mjs"),
          `export default () => (${testCase.expression});\n`,
          "utf8",
        );
        const result = await runWorkflowScript({
          pi: harness.pi,
          ctx: harness.ctx,
          signal: new AbortController().signal,
          scriptPath: "verdict.workflow.mjs",
        });

        expect(result.ok, testCase.name).toBe(false);
        expect(result.error, testCase.name).toBeUndefined();
        expect(result.failureDiagnostic, testCase.name).toBeUndefined();
        expect(readWorkflowRunSummary(root, result.runId).status, testCase.name).toBe("failed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
