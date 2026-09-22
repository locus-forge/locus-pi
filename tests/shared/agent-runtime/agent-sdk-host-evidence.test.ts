import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import {
  createAgentSdkSessionExecutor,
  type CreateAgentSessionFactory,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  writeAgentRunResultArtifact,
  type AgentRunRequest,
  type AgentRunResult,
} from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import type { AgentDefinition } from "../../../extensions/_shared/agent-runtime/agents.js";

const baseAgent: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "grep"],
  risk: "medium",
  readOnly: true,
  evidence: { mode: "none" },
};

function request(agent: AgentDefinition = baseAgent): Extract<AgentRunRequest, { executionMode: "named" }> {
  const root = mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-"));
  return {
    executionMode: "named",
    agent,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: root,
    workingDirectory: root,
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: agent.allowedTools,
    approvalTier: "allow",
  };
}

function fakeSession(config: {
  toolCalls: number;
  toolResults: number;
  text: string;
  /** What the host reports the session runs on; absent = an older peer or a mock. */
  model?: unknown;
  events?: SdkAgentSessionEventLike[];
  exportHeaderId?: string;
  exportRawHeader?: string;
  exportOutsideReports?: boolean;
  exportError?: string;
  /** Absent = a host without `exportToHtml`, which must be RECORDED, not skipped. */
  exportsHtml?: boolean;
  htmlExportError?: string;
  htmlOutsideReports?: boolean;
  htmlEmpty?: boolean;
  promptError?: string;
  neverEnds?: boolean;
  abortNeverSettles?: boolean;
}): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  return {
    sessionId: "sdk-child",
    ...(config.model !== undefined ? { model: config.model } : {}),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      if (config.promptError !== undefined) throw new Error(config.promptError);
      for (const event of config.events ?? []) listener?.(event);
      if (config.neverEnds !== true) listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "sdk-child", toolCalls: config.toolCalls, toolResults: config.toolResults };
    },
    getLastAssistantText() {
      return config.text;
    },
    exportToJsonl(outputPath) {
      if (config.exportError !== undefined) throw new Error(config.exportError);
      const target = config.exportOutsideReports
        ? path.join(exportDir, "escaped.jsonl")
        : (outputPath ?? path.join(exportDir, "session.jsonl"));
      const header =
        config.exportRawHeader ??
        JSON.stringify({ type: "session", version: 3, id: config.exportHeaderId ?? "sdk-child" });
      writeFileSync(target, `${header}\n`, "utf8");
      return target;
    },
    ...(config.exportsHtml === true
      ? {
          // Async, like the real peer's `AgentSession.exportToHtml`.
          async exportToHtml(outputPath?: string) {
            await Promise.resolve();
            if (config.htmlExportError !== undefined) throw new Error(config.htmlExportError);
            const target = config.htmlOutsideReports
              ? path.join(exportDir, "escaped.html")
              : (outputPath ?? path.join(exportDir, "session.html"));
            writeFileSync(
              target,
              config.htmlEmpty === true
                ? ""
                : "<html><head><title>Session Export</title></head><body>session</body></html>",
              "utf8",
            );
            return target;
          },
        }
      : {}),
    dispose() {},
    abort: config.abortNeverSettles === true ? () => new Promise<void>(() => {}) : async () => {},
  };
}

function completedText(summary: string): string {
  return summary;
}

describe("agent SDK evidence surfacing", () => {
  it("attaches reasoning_only evidence for policy mode none with no tools", async () => {
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.deepEqual(result.evidence, {
      evidence: "reasoning_only",
      warnings: [],
      missingRequiredTools: [],
      observedTools: [],
    });
  });

  it("attaches missing_expected_evidence warnings for warn policy with no tool calls", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      evidence: { mode: "warn", requireAnyOf: ["read", "grep"] },
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(agent), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.equal(result.evidence?.evidence, "missing_expected_evidence");
    assert.deepEqual(result.evidence?.missingRequiredTools, ["read", "grep"]);
    assert.ok((result.evidence?.warnings.length ?? 0) > 0);
  });

  it("records a real-shaped SDK bash event and satisfies named-tool evidence", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      allowedTools: ["bash"],
      evidence: { mode: "warn", requireAnyOf: ["bash"] },
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 1,
          toolResults: 1,
          text: completedText("Checked."),
          events: [
            { type: "tool_execution_start", toolName: " bash ", toolCallId: "call-1", args: { command: "pwd" } },
            { type: "tool_execution_update", toolName: "bash", toolCallId: "call-1", args: { command: "pwd" } },
            { type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", isError: false },
          ],
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(agent), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.deepEqual(result.childOutputStats?.recordedToolNames, ["bash"]);
    assert.deepEqual(result.evidence, {
      evidence: "evidence_backed",
      warnings: [],
      missingRequiredTools: [],
      observedTools: ["bash"],
    });
  });

  it("does not invent a named tool from aggregate SDK counters", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      allowedTools: ["bash"],
      evidence: { mode: "warn", requireAnyOf: ["bash"] },
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 1,
          toolResults: 1,
          text: completedText("Checked."),
          events: [
            { type: "step_start", name: "bash" },
            { type: "tool_hint", toolName: "bash" },
          ],
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(agent), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.deepEqual(result.childOutputStats?.recordedToolNames, []);
    assert.equal(result.evidence?.evidence, "missing_expected_evidence");
    assert.deepEqual(result.evidence?.missingRequiredTools, ["bash"]);
    assert.deepEqual(result.evidence?.observedTools, []);
  });

  it("omits evidence from run-result artifact body when AgentRunResult evidence is undefined", () => {
    const req = request();
    const result: AgentRunResult = {
      status: "completed",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "ok",
      diagnostics: [],
      lifecycleEntryIds: [],
    };

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    assert.ok(withArtifact.resultArtifact !== undefined);
    const body = JSON.parse(withArtifact.resultArtifact.content) as Record<string, unknown>;
    assert.equal(body.version, "locus.agent.run-result.v2");
    assert.equal(Object.hasOwn(body, "evidence"), false);
  });

  it("reports a finished run whose envelope could not be stored as a storage failure, answer kept", () => {
    // Three notions, three answers: the execution FINISHED, its answer is ACCEPTABLE, and
    // the durable record was NOT stored. The old code returned the first two and appended
    // a diagnostic about the third, so the launcher printed `done` over a record that does
    // not exist. Nothing about the answer changes — only the claim that it was saved.
    const req = request();
    const result: AgentRunResult = {
      status: "completed",
      agentName: req.agent.name,
      reason: "ok",
      text: "The migration is safe; here is the evidence.",
      diagnostics: [],
      lifecycleEntryIds: [],
    };
    // A file where the artifacts directory should be: the store cannot create it, so the
    // write fails for a real filesystem reason rather than a stubbed throw.
    const blockedDir = path.join(mkdtempSync(path.join(tmpdir(), "locus-agent-storage-")), "artifacts");
    writeFileSync(blockedDir, "not a directory", "utf8");

    const stored = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result, blockedDir);

    assert.equal(stored.status, "storage-failed");
    assert.equal(stored.resultArtifact, undefined);
    // The answer survived, and so did the execution outcome it belongs to.
    assert.equal(stored.text, "The migration is safe; here is the evidence.");
    assert.equal(stored.resultStorage?.executionStatus, "completed");
    assert.equal(stored.resultStorage?.answerAvailable, true);
    assert.ok(stored.resultStorage!.reason.length > 0);
    assert.match(stored.reason, /result envelope was not written/u);
    assert.ok(stored.diagnostics.some((entry) => /result envelope was not written/u.test(entry)));
  });

  it("says so plainly when a run with no answer text also fails to store its envelope", () => {
    const req = request();
    const result: AgentRunResult = {
      status: "failed",
      agentName: req.agent.name,
      reason: "provider ended the turn",
      failureCause: "provider-error",
      diagnostics: [],
      lifecycleEntryIds: [],
    };
    const blockedDir = path.join(mkdtempSync(path.join(tmpdir(), "locus-agent-storage-")), "artifacts");
    writeFileSync(blockedDir, "not a directory", "utf8");

    const stored = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result, blockedDir);

    assert.equal(stored.status, "storage-failed");
    assert.equal(stored.resultStorage?.executionStatus, "failed");
    assert.equal(stored.resultStorage?.answerAvailable, false);
    // The original failure cause is not overwritten by the storage problem.
    assert.equal(stored.failureCause, "provider-error");
  });

  it("uses the request as the sole declared Fusion mode authority in the run-result artifact", () => {
    const req = { ...request(), capabilityMode: "tool-free" as const };
    const result: AgentRunResult & { capabilityMode: "agent" } = {
      status: "completed",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "ok",
      capabilityMode: "agent",
      activeToolNames: [],
      diagnostics: [],
      lifecycleEntryIds: [],
    };

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    assert.ok(withArtifact.resultArtifact !== undefined);
    const body = JSON.parse(withArtifact.resultArtifact.content) as Record<string, unknown>;
    assert.equal(body.capabilityMode, "tool-free");
    assert.deepEqual(body.activeToolNames, []);
  });

  it("carries the host-read executed model into the run-result artifact on disk", async () => {
    // The data-flow contract, asserted where it actually matters. The artifact is
    // written INSIDE `executeAgentRunBoundary`, before the workflow bridge ever sees
    // a result, so the only shape that can reach the JSON body is the readback
    // travelling on `AgentRunResult`. The assertion therefore reads the written file,
    // not the returned object.
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 0,
          toolResults: 0,
          text: completedText("Reviewed."),
          model: { provider: "test", id: "fast", name: "Test Fast" },
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });
    const req = request();

    const result = await executor.run(req, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.executedModel, "test/fast");

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    assert.ok(withArtifact.resultArtifact !== undefined);
    const onDisk = JSON.parse(readFileSync(withArtifact.resultArtifact.path, "utf8")) as { content: string };
    const body = JSON.parse(onDisk.content) as Record<string, unknown>;
    assert.equal(body.executedModel, "test/fast");
  });

  it("records `unavailable` in the artifact when the peer exposes no model", async () => {
    const executor = createAgentSdkSessionExecutor({
      // No `model` on the session, but a model WAS requested — so a body that says
      // "test/strong" here would be the request echoed back, which is the exact
      // fabrication this field exists to prevent.
      model: { provider: "test", id: "strong" },
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });
    const req = request();

    const result = await executor.run(req, new AbortController().signal);
    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    const onDisk = JSON.parse(readFileSync(withArtifact.resultArtifact!.path, "utf8")) as { content: string };
    const body = JSON.parse(onDisk.content) as Record<string, unknown>;

    assert.equal(body.executedModel, "unavailable");
  });

  it("omits both model facts from the artifact when the transport rejected the prompt", async () => {
    // Driven end to end through the executor, because the defect was in WHERE the
    // readback got promoted, not in the writer: it was published the moment the model
    // check passed, i.e. before `prompt()` was dispatched. A rejected prompt then wrote
    // an artifact naming an executed model, and `modelRoleFallback` — gated on that
    // same field — rode along, claiming "the child inherited the parent session model"
    // for a child that spent nothing. A request-shaped literal cannot catch that; only
    // a real run through the host can.
    const executor = createAgentSdkSessionExecutor({
      model: { provider: "test", id: "fast" },
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 0,
          toolResults: 0,
          text: "",
          model: { provider: "test", id: "fast" },
          promptError: "No API key found for deepseek.",
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "prompt-rejected",
    });
    const req = { ...request(), modelRoleFallback: 'modelRole "smol" is not assigned in any model-roles layer' };

    const result = await executor.run(req, new AbortController().signal);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /No API key found/u);
    assert.equal(result.executedModel, undefined);

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    const onDisk = JSON.parse(readFileSync(withArtifact.resultArtifact!.path, "utf8")) as { content: string };
    const body = JSON.parse(onDisk.content) as Record<string, unknown>;

    assert.ok(!("executedModel" in body));
    assert.ok(!("modelRoleFallback" in body));
  });

  it("records a tier degradation in the artifact once the child actually ran", () => {
    const req = { ...request(), modelRoleFallback: 'modelRole "smol" is not assigned in any model-roles layer' };
    const result: AgentRunResult = {
      status: "completed",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "ok",
      diagnostics: [],
      lifecycleEntryIds: [],
      childSession: { id: "child-1", createdAt: "fixed", parentSessionId: req.parentSessionId, metadata: {} },
      // Published only after child kickoff, so its presence is what proves a child ran.
      executedModel: "test/fast",
    };

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    const body = JSON.parse(withArtifact.resultArtifact!.content) as Record<string, unknown>;

    assert.equal(body.modelRoleFallback, 'modelRole "smol" is not assigned in any model-roles layer');
  });

  it("omits the tier degradation when a session was built but the child never ran", () => {
    // The gap round 2 found: a session created and then cancelled before kickoff has a
    // childSession id, so the old "child session exists" gate published a PAST-TENSE
    // claim ("the child inherited the parent session model") about a child that never
    // spent a token. Nothing executed, so nothing may be recorded as having degraded.
    const req = { ...request(), modelRoleFallback: 'modelRole "smol" is not assigned in any model-roles layer' };
    const result: AgentRunResult = {
      status: "cancelled",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "Agent run was cancelled before child session kickoff.",
      diagnostics: [],
      lifecycleEntryIds: [],
      childSession: { id: "child-1", createdAt: "fixed", parentSessionId: req.parentSessionId, metadata: {} },
      // No executedModel: the session existed, the child was never prompted.
    };

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    const body = JSON.parse(withArtifact.resultArtifact!.content) as Record<string, unknown>;

    assert.ok(!("modelRoleFallback" in body));
  });

  it("omits the tier degradation when the call died before a child session existed", () => {
    // The note reads "the child inherited the parent session model" — a past-tense
    // claim about a child. A call that never reached `createSession` (unavailable
    // substrate, refused model, abort in flight) has no child to have inherited
    // anything, so copying the request's note into the artifact would invent
    // execution evidence in the one file meant to prove execution.
    const req = { ...request(), modelRoleFallback: 'modelRole "smol" is not assigned in any model-roles layer' };
    const result: AgentRunResult = {
      status: "blocked",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "agent SDK unavailable",
      diagnostics: ["agent SDK unavailable"],
      lifecycleEntryIds: [],
    };

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    const body = JSON.parse(withArtifact.resultArtifact!.content) as Record<string, unknown>;

    // Absent, not null: `JSON.stringify` drops the undefined key, so the reader sees
    // no claim rather than an empty one.
    assert.ok(!("modelRoleFallback" in body));
  });

  it("keeps run-result artifacts distinct across fresh stores by child session id", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-agent-artifact-collision-"));
    const req = { ...request(), projectRoot: root };
    const first = writeAgentRunResultArtifact(root, req, {
      status: "completed",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "first",
      diagnostics: [],
      lifecycleEntryIds: [],
      text: "first",
      childSession: { id: "child-one", createdAt: "fixed", metadata: {} },
    });
    const second = writeAgentRunResultArtifact(root, req, {
      status: "completed",
      agentName: req.agent?.name ?? "sub-agent",
      reason: "second",
      diagnostics: [],
      lifecycleEntryIds: [],
      text: "second",
      childSession: { id: "child-two", createdAt: "fixed", metadata: {} },
    });

    assert.ok(first.resultArtifact !== undefined);
    assert.ok(second.resultArtifact !== undefined);
    assert.notEqual(first.resultArtifact.path, second.resultArtifact.path);
    assert.equal(JSON.parse(readFileSync(first.resultArtifact.path, "utf8")).content.includes("first"), true);
    assert.equal(JSON.parse(readFileSync(second.resultArtifact.path, "utf8")).content.includes("second"), true);
  });

  it("exposes a reports-confined, session-bound child trace and serializes it separately from the run result", async () => {
    const req = request();
    const reportsDir = path.join(req.projectRoot ?? process.cwd(), ".locus", "runtime", "reports");
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir,
      now: () => "fixed",
    });

    const result = await executor.run(req, new AbortController().signal);
    assert.equal(result.childTrace?.format, "pi-session-jsonl");
    assert.equal(result.childTrace?.childSessionId, "sdk-child");
    assert.match(path.basename(result.childTrace?.path ?? ""), /^agent-sdk-reviewer-[a-z0-9-]+-fixed\.jsonl$/u);
    assert.equal(path.dirname(result.childTrace?.path ?? ""), realpathSync(reportsDir));

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    assert.ok(withArtifact.resultArtifact !== undefined);
    assert.notEqual(withArtifact.resultArtifact.path, result.childTrace?.path);
    const body = JSON.parse(withArtifact.resultArtifact.content) as Record<string, unknown>;
    assert.deepEqual(body.childTrace, result.childTrace);
  });

  it("renders the session to HTML beside its JSONL and names the verified file in the run evidence", async () => {
    const req = request();
    const reportsDir = path.join(req.projectRoot ?? process.cwd(), ".locus", "runtime", "reports");
    const rowId = "workflow:run-proof:call-0001";
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed."), exportsHtml: true }),
      })) as CreateAgentSessionFactory,
      reportsDir,
      now: () => "fixed",
      promptEnv: { LOCUS_PI_HTML_TRANSCRIPTS: "1" },
      live: { rowId, label: "draft recon" },
    });

    const result = await executor.run(req, new AbortController().signal);
    const displayName = agentLiveStore.rows.get(rowId)?.displayName;
    assert.ok(displayName);
    const stem = `agent-sdk-reviewer-draft-recon-${displayName.toLocaleLowerCase()}-fixed`;
    const htmlPath = realpathSync(path.join(reportsDir, `${stem}.html`));
    assert.deepEqual(result.childTrace, {
      path: realpathSync(path.join(reportsDir, `${stem}.jsonl`)),
      format: "pi-session-jsonl",
      childSessionId: "sdk-child",
      htmlPath,
    });
    assert.equal(
      readFileSync(htmlPath, "utf8"),
      `<html><head><title>Agent transcript — ${displayName} · draft recon</title></head><body>session</body></html>`,
    );
    assert.ok(result.diagnostics.some((line) => line === `HTML transcript render exported: ${htmlPath}`));

    // Durable: the per-call result envelope is where a reader finds it later.
    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    const body = JSON.parse(withArtifact.resultArtifact!.content) as Record<string, unknown>;
    assert.deepEqual(body.childTrace, result.childTrace);
  });

  it.each([{}, { LOCUS_PI_HTML_TRANSCRIPTS: "0" }])(
    "keeps JSONL and quietly skips HTML when automatic rendering is disabled (%j)",
    async (promptEnv) => {
      const req = request();
      const reportsDir = path.join(req.projectRoot ?? process.cwd(), ".locus", "runtime", "reports");
      const executor = createAgentSdkSessionExecutor({
        createSession: (async () => ({
          session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed."), exportsHtml: true }),
        })) as CreateAgentSessionFactory,
        reportsDir,
        now: () => "fixed",
        promptEnv,
      });

      const result = await executor.run(req, new AbortController().signal);

      assert.equal(result.status, "completed");
      assert.equal(result.childTrace?.format, "pi-session-jsonl");
      assert.equal(result.childTrace?.htmlPath, undefined);
      assert.equal(
        result.diagnostics.some((line) => line.startsWith("HTML transcript render")),
        false,
      );
    },
  );

  it.each([
    ["a host without the method", {}, "unavailable: the installed Pi host exposes no AgentSession.exportToHtml"],
    ["a renderer that throws", { exportsHtml: true, htmlExportError: "renderer refused" }, "failed: renderer refused"],
    ["a render outside the reports root", { exportsHtml: true, htmlOutsideReports: true }, "escaped reports root"],
    ["an empty render", { exportsHtml: true, htmlEmpty: true }, "rendered file is empty"],
  ])("names %s as a warning and claims no HTML path", async (_name, htmlConfig, diagnostic) => {
    const req = request();
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed."), ...htmlConfig }),
      })) as CreateAgentSessionFactory,
      reportsDir: path.join(req.projectRoot ?? process.cwd(), ".locus", "runtime", "reports"),
      now: () => "fixed",
      promptEnv: { LOCUS_PI_HTML_TRANSCRIPTS: "1" },
    });

    const result = await executor.run(req, new AbortController().signal);

    // The run is unaffected and the JSONL still stands; only the render is missing.
    assert.equal(result.status, "completed");
    assert.equal(result.childTrace?.htmlPath, undefined);
    assert.ok(
      result.diagnostics.some((line) => line.startsWith("HTML transcript render") && line.includes(diagnostic)),
      `expected a named HTML warning containing ${diagnostic}, got ${JSON.stringify(result.diagnostics)}`,
    );
  });

  it.each([
    ["escaped path", { exportOutsideReports: true }, "escaped reports root"],
    ["malformed header", { exportRawHeader: "{not-json}" }, "JSONL export failed:"],
    ["wrong session", { exportHeaderId: "other-child" }, "does not match child"],
    ["export error", { exportError: "disk refused" }, "disk refused"],
  ])("omits childTrace after %s validation failure", async (_name, exportConfig, diagnostic) => {
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed."), ...exportConfig }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);
    assert.equal(result.childTrace, undefined);
    assert.ok(result.diagnostics.some((line) => line.includes("JSONL export failed:") && line.includes(diagnostic)));
  });

  it("preserves child identity and attempts trace export on every post-session failure or cancellation path", async () => {
    const parseExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "" }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "parse",
    });
    const parsed = await parseExecutor.run(request(), new AbortController().signal);
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.childTrace?.childSessionId, "sdk-child");

    const timeoutExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "", neverEnds: true }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "timeout",
      childTimeoutMs: 1,
    });
    const timedOut = await timeoutExecutor.run(request(), new AbortController().signal);
    assert.equal(timedOut.status, "failed");
    assert.equal(timedOut.childTrace?.childSessionId, "sdk-child");

    const cancelExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "", neverEnds: true }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "cancelled",
      childTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = cancelExecutor.run(request(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.childSession?.id, "sdk-child");
    assert.equal(cancelled.childTrace?.childSessionId, "sdk-child");

    const preKickoffController = new AbortController();
    const preKickoffExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => {
        preKickoffController.abort();
        return { session: fakeSession({ toolCalls: 0, toolResults: 0, text: "" }) };
      }) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "pre-kickoff",
    });
    const preKickoff = await preKickoffExecutor.run(request(), preKickoffController.signal);
    assert.equal(preKickoff.status, "cancelled");
    assert.equal(preKickoff.childSession?.id, "sdk-child");
    assert.equal(preKickoff.childTrace?.childSessionId, "sdk-child");

    const exceptionExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "", promptError: "transport failed" }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "exception",
    });
    const exception = await exceptionExecutor.run(request(), new AbortController().signal);
    assert.equal(exception.status, "failed");
    assert.match(exception.reason, /transport failed/u);
    assert.equal(exception.childSession?.id, "sdk-child");
    assert.equal(exception.childTrace?.childSessionId, "sdk-child");
  });

  it("persists timeout evidence when the SDK abort acknowledgement never settles", async () => {
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 0,
          toolResults: 0,
          text: "",
          neverEnds: true,
          abortNeverSettles: true,
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "hung-abort",
      childTimeoutMs: 1,
      abortTimeoutMs: 5,
    });

    const startedAt = Date.now();
    const result = await executor.run(request(), new AbortController().signal);

    assert.equal(result.status, "failed");
    assert.equal(result.childTrace?.childSessionId, "sdk-child");
    assert.ok(Date.now() - startedAt < 500, "bounded abort should not block evidence persistence");
  });
});
