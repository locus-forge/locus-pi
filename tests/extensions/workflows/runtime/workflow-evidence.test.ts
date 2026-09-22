import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import type {
  SdkAgentSessionEventLike,
  SdkAgentSessionLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { ThinkingLevel } from "../../../../extensions/_shared/host/pi-api.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { EvidenceEvaluation } from "../../../../extensions/_shared/agent-runtime/agent-evidence-evaluator.js";
import { WorkflowProgressComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
import { createHarness } from "../../../test-harness.js";

const evidence: EvidenceEvaluation = {
  evidence: "missing_expected_evidence",
  warnings: [
    "reviewer is missing expected runtime evidence (read, grep); mode=warn allows the run status to remain completed.",
  ],
  missingRequiredTools: ["read", "grep"],
  observedTools: [],
};

function tempProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-evidence-"));
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "reviewer.md"),
    "---\nname: reviewer\ndescription: Project reviewer\ntools: read, grep\n---\nReview carefully.\n",
    "utf8",
  );
  // The `default` agent has to belong to this project too. Discovery is
  // project → user → bundled, so a root that declares only `reviewer` borrows
  // `default` from whatever catalog the developer installed under `$HOME` — and
  // now that agent frontmatter `model:` selects the child's model, a stale home
  // catalog can fail these calls for reasons that have nothing to do with evidence.
  writeFileSync(
    path.join(dir, "default.md"),
    "---\nname: default\ndescription: General purpose agent\nmodel: task\n---\nDo the work.\n",
    "utf8",
  );
  return root;
}

describe("workflow evidence threading", () => {
  it("uses a high configurable tool-call fuse instead of the former 100-call ceiling", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const resultFor = (request: WorkflowAgentRequest): WorkflowAgentResult => ({
      ok: true,
      status: "completed",
      summary: "done",
      text: "done",
      diagnostics: [],
      agent: request.agent,
    });
    const defaultRuntime = createWorkflowRuntime({
      runId: "wf-default-tool-fuse",
      agentRunner: async (request) => {
        requests.push(request);
        return resultFor(request);
      },
    });

    await defaultRuntime.dsl.agent("default fuse");
    await defaultRuntime.dsl.agent("large explicit fuse", { maxToolCalls: 5_000 });

    assert.deepEqual(
      requests.map((request) => request.maxToolCalls),
      // Nobody declared a run-level tool-call budget, so the first call carries none.
      [undefined, 5_000],
    );

    const configuredRequests: WorkflowAgentRequest[] = [];
    const configuredRuntime = createWorkflowRuntime({
      runId: "wf-configured-tool-fuse",
      defaultMaxToolCalls: 2_000,
      agentRunner: async (request) => {
        configuredRequests.push(request);
        return resultFor(request);
      },
    });
    await configuredRuntime.dsl.agent("configured fuse");
    assert.equal(configuredRequests[0]?.maxToolCalls, 2_000);
  });

  it("rejects invalid tool-call fuse values before child execution", async () => {
    assert.throws(
      () =>
        createWorkflowRuntime({
          runId: "wf-invalid-default-tool-fuse",
          defaultMaxToolCalls: -1,
          agentRunner: async () => {
            throw new Error("must not run");
          },
        }),
      /defaultMaxToolCalls must be a non-negative safe integer/u,
    );

    let calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "wf-invalid-call-tool-fuse",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });
    await assert.rejects(
      runtime.dsl.agent("invalid explicit fuse", { maxToolCalls: 1.5 }),
      /agent maxToolCalls must be a non-negative safe integer/u,
    );
    assert.equal(calls, 0);
  });

  it("carries evidence from the agent boundary into WorkflowAgentResult", async () => {
    const root = tempProject();
    const h = createHarness(root, { sessionId: "wf-parent" });
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "reviewed",
          text: "reviewed",
          diagnostics: [],
          lifecycleEntryIds: [],
          evidence,
        };
      },
    });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor,
    });

    const result = await runner({ prompt: "review", agent: "reviewer" });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.evidence, evidence);
  });

  it("always inherits all tools and ignores legacy per-call restrictions", async () => {
    const root = tempProject();
    const h = createHarness(root, { sessionId: "wf-parent-read-only" });
    let observed: AgentRunRequest | undefined;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: () => ({
        async run(request: AgentRunRequest) {
          observed = request;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "read",
            text: "read",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const inherited = await runner({ prompt: "inspect", agent: "reviewer" });

    assert.equal(observed?.agent?.readOnly, false);
    assert.deepEqual(observed?.agent?.allowedTools, ["*"]);
    assert.deepEqual(observed?.allowedTools, ["*"]);
    assert.equal(inherited.readOnly, false);
    assert.equal(inherited.permissionMode, "inherit-parent");

    const legacyRestriction = await runner({
      prompt: "inspect",
      agent: "reviewer",
      readOnly: true,
      tools: ["read"],
    });

    assert.equal(observed?.agent.readOnly, false);
    assert.deepEqual(observed?.agent.tools, ["*"]);
    assert.deepEqual(observed?.allowedTools, ["*"]);
    assert.equal(legacyRestriction.readOnly, false);
  });

  it("freezes repository_check package scripts when the workflow runner is created", async () => {
    const root = tempProject();
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ scripts: { verify: "node verify.mjs" } })}\n`);
    const h = createHarness(root, { sessionId: "wf-parent-frozen-checks" });
    let observed: AgentRunRequest | undefined;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: () => ({
        async run(request: AgentRunRequest) {
          observed = request;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "read",
            text: "read",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: { verify: "node changed.mjs", injected: "node injected.mjs" } })}\n`,
    );
    await runner({ prompt: "inspect", agent: "default", readOnly: true, tools: ["repository_check"] });

    assert.deepEqual(observed?.repositoryCheckScripts, { verify: "node verify.mjs" });
  });

  it("writes evidence onto agent_end journal lines from WorkflowAgentResult", async () => {
    const result: WorkflowAgentResult = {
      ok: true,
      status: "completed",
      summary: "done",
      text: "done",
      diagnostics: [],
      agent: "reviewer",
      evidence,
      childSessionId: "child-session-1",
      childTrace: {
        path: "/tmp/run/child-session-1.jsonl",
        format: "pi-session-jsonl",
        childSessionId: "child-session-1",
      },
      resultArtifact: "/tmp/run/agent-result.json",
    };
    const runtime = createWorkflowRuntime({
      runId: "wf-evidence",
      now: () => "2026-01-01T00:00:00.000Z",
      agentRunner: async () => result,
    });

    await runtime.dsl.agent("review", { agent: "reviewer" });
    const endLine = runtime.getJournal().find((line) => line.kind === "agent_end");

    assert.ok(endLine !== undefined);
    assert.deepEqual(endLine.evidence, evidence);
    assert.deepEqual(endLine.evidenceWarnings, evidence.warnings);
    assert.equal(endLine.childSessionId, "child-session-1");
    assert.deepEqual(endLine.childTrace, {
      path: "/tmp/run/child-session-1.jsonl",
      format: "pi-session-jsonl",
      childSessionId: "child-session-1",
    });
    assert.equal(endLine.resultArtifact, "/tmp/run/agent-result.json");
  });

  it("renders agent_end evidence warnings in the progress widget tail", () => {
    const component = new WorkflowProgressComponent({ requestRender() {} }, {}, "script", "wf-evidence");
    const line: WorkflowJournalLine = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "wf-evidence",
      kind: "agent_end",
      agent: "reviewer",
      status: "completed",
      evidence,
      evidenceWarnings: evidence.warnings,
    };

    component.push(line);
    const rendered = component.render(200).join("\n");
    component.dispose();

    assert.match(rendered, /agent_end: reviewer completed/);
    assert.match(rendered, /missing expected runtime evidence/);
  });
});

/**
 * Replace the Pi SDK module itself, so the bridge's DEFAULT executor factory runs for
 * real. The fake host honours what it is given; returns what `createAgentSession` got.
 */
function mockPiSdk(): Array<Record<string, unknown>> {
  const sessionOptions: Array<Record<string, unknown>> = [];
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    getAgentDir: () => tmpdir(),
    DefaultResourceLoader: class {
      reload(): void {}
    },
    SessionManager: { create: () => ({ kind: "isolated-child-session" }) },
    createAgentSession: async (options: Record<string, unknown>) => {
      sessionOptions.push(options);
      let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
      const session: SdkAgentSessionLike = {
        sessionId: "default-executor-child",
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel as ThinkingLevel }),
        subscribe(fn) {
          listener = fn;
          return () => {
            listener = undefined;
          };
        },
        async prompt() {
          listener?.({ type: "agent_end", willRetry: false });
        },
        getSessionStats: () => ({ sessionId: "default-executor-child", toolCalls: 0, toolResults: 0 }),
        getLastAssistantText: () => "default answer",
        exportToJsonl(outputPath) {
          assert.ok(outputPath !== undefined, "the host names the evidence path");
          writeFileSync(outputPath, `${JSON.stringify({ type: "session", id: "default-executor-child" })}\n`);
          return outputPath;
        },
        dispose() {},
      };
      return { session };
    },
  }));
  return sessionOptions;
}

describe("the default executor factory (no createExecutor injected)", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });

  it("creates the child session on the requested model and writes its transcript to the run's evidence", async () => {
    const h = createHarness(tempProject(), { sessionId: "wf-parent-default-executor" });
    const sessionOptions = mockPiSdk();
    const transcriptDir = mkdtempSync(path.join(tmpdir(), "locus-workflow-evidence-transcripts-"));
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      evidenceDestinations: () => ({
        transcriptDir,
        resultArtifactsDir: mkdtempSync(path.join(tmpdir(), "locus-workflow-evidence-results-")),
        recordOperatorAskEvidence: () => {
          throw new Error("this call asks the operator nothing");
        },
      }),
    });

    const result = await runner({ prompt: "work", model: "test/fast:high", callId: "call-0001" });

    assert.equal(result.status, "completed");
    assert.equal(sessionOptions.length, 1);
    assert.deepEqual(sessionOptions[0]?.model, { provider: "test", id: "fast", name: "Test Fast" });
    assert.equal(sessionOptions[0]?.thinkingLevel, "high");
    assert.equal(path.dirname(result.childTrace?.path ?? ""), realpathSync(transcriptDir));
  });

  it("names no model to the host when neither the call nor the parent session declares one", async () => {
    // The one field the bridge can hand over as a present-but-undefined key: the
    // inherited parent model. The host must treat it exactly as an omitted one.
    const h = createHarness(tempProject(), { sessionId: "wf-parent-no-model" });
    assert.equal(h.ctx.model, undefined);
    const sessionOptions = mockPiSdk();
    const runner = createWorkflowAgentRunner({ pi: h.pi, ctx: h.ctx, signal: new AbortController().signal });

    const result = await runner({ prompt: "work" });

    assert.equal(result.status, "completed");
    assert.equal(sessionOptions.length, 1);
    assert.equal(Object.hasOwn(sessionOptions[0] ?? {}, "model"), false);
  });
});
