/** Requires installed Pi imports; fake session integration, not a live provider run. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it as test } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowRuntime,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionEventLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  formatAgentLiveRowLine,
  formatAgentDrillTitle,
  statusMeta,
} from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { createHarness } from "../../../test-harness.js";
function tempRun(root: string, id: string): string {
  const dir = path.join(root, ".locus-pi", "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  // realpath: the host records the real exported path, and the artifact root must match it.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "locus-bridge-return-")));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/** One real runtime -> bridge -> SDK stack whose only fake part is the Pi session.
 *  `submit` returns the value this child proposes on the given 1-based prompt. */
function bridgeHarness(
  root: string,
  id: string,
  submit: (prompt: number) => unknown,
): {
  runtime: WorkflowRuntime;
  counters: { sessions: number; prompts: number; disposals: number };
  feedback: string[];
  promptTexts: string[];
} {
  const h = createHarness(root);
  const runDir = tempRun(root, id);
  const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir });
  const counters = { sessions: 0, prompts: 0, disposals: 0 };
  const feedback: string[] = [];
  const promptTexts: string[] = [];
  const runner = createWorkflowAgentRunner({
    pi: h.pi,
    ctx: h.ctx,
    signal: new AbortController().signal,
    workflowRunId: id,
    workflowRunDir: runDir,
    evidenceDestinations: (callId) => store.childEvidenceDestinations(callId),
    createExecutor: (opts) =>
      createAgentSdkSessionExecutor({
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.thinkingLevel === undefined ? {} : { thinkingLevel: opts.thinkingLevel }),
        ...(opts.live === undefined ? {} : { live: opts.live }),
        ...(opts.maxToolCalls === undefined ? {} : { maxToolCalls: opts.maxToolCalls }),
        ...(opts.childTimeoutMs === undefined ? {} : { childTimeoutMs: opts.childTimeoutMs }),
        ...(opts.reportsDir === undefined ? {} : { reportsDir: opts.reportsDir }),
        ...(opts.onLiveExecution === undefined ? {} : { onLiveExecution: opts.onLiveExecution }),
        createSession: async (sessionOptions) => {
          counters.sessions += 1;
          const sessionId = counters.sessions === 1 ? "bridge-child" : `bridge-child-${counters.sessions}`;
          let active = ["read", "write", "workflow_return"];
          let emit: (event: SdkAgentSessionEventLike) => void = () => {};
          const tool = sessionOptions.customTools?.find((item) => item.name === "workflow_return");
          assert.ok(tool);
          return {
            session: {
              sessionId,
              subscribe(listener) {
                emit = listener;
                return () => {};
              },
              async prompt(promptText) {
                counters.prompts += 1;
                promptTexts.push(promptText);
                emit({ type: "turn_start" });
                emit({
                  type: "tool_execution_start",
                  toolName: "workflow_return",
                  toolCallId: `t${counters.prompts}`,
                });
                const response = await tool.execute(
                  `t${counters.prompts}`,
                  { value: submit(counters.prompts) },
                  new AbortController().signal,
                );
                feedback.push(
                  response.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n"),
                );
                emit({ type: "agent_end", willRetry: false });
              },
              getActiveToolNames: () => active,
              setActiveToolsByName(names) {
                active = [...names];
              },
              getSessionStats: () => ({
                sessionId,
                toolCalls: counters.prompts,
                toolResults: counters.prompts,
              }),
              getLastAssistantText: () => "DO NOT USE THIS NARRATIVE",
              exportToJsonl(target) {
                const file = target ?? path.join(root, "trace.jsonl");
                mkdirSync(path.dirname(file), { recursive: true });
                // The host verifies the session header before adopting the trace.
                writeFileSync(file, `${JSON.stringify({ type: "session", id: sessionId })}\n`, "utf8");
                return file;
              },
              dispose() {
                counters.disposals += 1;
              },
              async abort() {},
            },
          };
        },
      }),
  });
  return {
    runtime: createWorkflowRuntime({ runId: id, agentRunner: runner, artifactPorts: store }),
    counters,
    feedback,
    promptTexts,
  };
}

test("runtime -> bridge -> SDK returns the validated tool value and preserves one session during repair", async () =>
  temporary(async (root) => {
    const id = "bridge-return";
    const { runtime, counters } = bridgeHarness(root, id, (prompt) => (prompt === 1 ? "bad\nline" : "orders"));
    const value = await runtime.dsl.agent("Extract an ID", {
      label: "extract",
      title: "Orders · ID",
      output: { type: "string", singleLine: true },
    });
    assert.equal(value, "orders");
    assert.equal(counters.sessions, 1);
    assert.equal(counters.prompts, 2);
    assert.equal(counters.disposals, 1);
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.outputAcceptance?.attempts, 2);
    assert.ok(
      [...agentLiveStore.rows.values()].some(
        (row) => row.title === "Orders · ID" && row.childSessionId === "bridge-child",
      ),
    );
  }));

const RESULT = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary"],
  properties: {
    decision: { type: "string", enum: ["complete", "needs-work", "unknown"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

test("stringified arrays and objects receive raw-container examples and require an actual corrected value", async () =>
  temporary(async (root) => {
    const cases = [
      { type: "array", schema: { type: "array", minItems: 1, items: { type: "string" } }, value: ["Existing report"] },
      { type: "object", schema: RESULT, value: { decision: "complete", summary: "Existing evidence" } },
    ];
    for (const item of cases) {
      const { runtime, counters, feedback, promptTexts } = bridgeHarness(root, `raw-${item.type}`, (prompt) =>
        prompt === 1 ? JSON.stringify(item.value) : item.value,
      );
      const result = await runtime.dsl.agent("Return the existing evidence", {
        label: `raw-${item.type}`,
        schema: item.schema,
      });
      assert.deepEqual(result, item.value);
      assert.equal(counters.sessions, 1);
      assert.equal(counters.prompts, 2);
      assert.equal(counters.disposals, 1);
      const example = item.type === "array" ? '{"value":[]}' : '{"value":{}}';
      assert.ok(feedback[0]?.includes(`expected ${item.type}, got string`));
      assert.ok(feedback[0]?.includes(example));
      assert.ok(feedback[0]?.includes("without JSON.stringify"));
      assert.ok(promptTexts[1]?.includes(example));
    }
  }));

test("repeating a stringified array still exhausts the contract instead of being coerced", async () =>
  temporary(async (root) => {
    const { runtime, counters } = bridgeHarness(root, "raw-array-exhausted", () => '["Existing report"]');
    await assert.rejects(
      runtime.dsl.agent("Return the existing evidence", {
        label: "raw-array-exhausted",
        schema: { type: "array", items: { type: "string" } },
      }),
      /Output contract exhausted after 2 attempts: root: expected array, got string/,
    );
    assert.equal(counters.sessions, 1);
    assert.equal(counters.prompts, 2);
    assert.equal(counters.disposals, 1);
    assert.equal(
      runtime.getJournal().find((line) => line.kind === "agent_end")?.failureCause,
      "output-contract-exhausted",
    );
  }));

test("an already-correct container receives only its actual content validation error", async () =>
  temporary(async (root) => {
    const { runtime, feedback, promptTexts } = bridgeHarness(root, "array-item-correction", (prompt) =>
      prompt === 1 ? [7] : ["Existing item"],
    );
    const value = await runtime.dsl.agent("Return the existing item", {
      label: "array-item-correction",
      schema: { type: "array", items: { type: "string" } },
    });
    assert.deepEqual(value, ["Existing item"]);
    assert.ok(feedback[0]?.includes("expected string, got number"));
    assert.ok(!feedback[0]?.includes("tool-argument syntax"));
    assert.ok(!promptTexts[1]?.includes("tool-argument syntax"));
  }));

test("a large discovered work unit passes runtime -> bridge -> SDK in one session and proposal", async () =>
  temporary(async (root) => {
    const workUnit = "Migrate this source section\n".repeat(20_000);
    const { runtime, counters } = bridgeHarness(root, "bridge-large-handoff", () => [workUnit]);
    const value = await runtime.dsl.agent("Discover migration work units with their source context.", {
      label: "discover",
      handoffs: { minItems: 0, maxItems: 1 },
    });
    assert.deepEqual(value, [workUnit]);
    assert.deepEqual(counters, { sessions: 1, prompts: 1, disposals: 1 });
    assert.equal(runtime.getJournal().find((line) => line.kind === "agent_end")?.outputAcceptance?.attempts, 1);
  }));

test("runtime -> bridge -> SDK returns the validated record after same-session shape repair", async () =>
  temporary(async (root) => {
    const id = "bridge-shaped";
    const { runtime, counters } = bridgeHarness(root, id, (prompt) =>
      prompt === 1 ? { decision: "complete" } : { decision: "complete", summary: "ok" },
    );
    const value = await runtime.dsl.agent("Verify", {
      label: "verify",
      title: "Orders · verify",
      schema: RESULT,
    });
    assert.deepEqual(value, { decision: "complete", summary: "ok" });
    assert.equal(counters.sessions, 1);
    assert.equal(counters.prompts, 2);
    assert.equal(counters.disposals, 1);
    assert.equal(runtime.getJournal().find((line) => line.kind === "agent_end")?.outputAcceptance?.attempts, 2);
  }));

test("mapped agents keep distinct human titles through runtime, bridge, fleet rows and drill", async () =>
  temporary(async (root) => {
    const id = "bridge-mapped-titles";
    const { runtime } = bridgeHarness(root, id, () => "done");
    const fields = ["run_time", "mail"];
    await runtime.dsl.parallel(
      fields.map(
        (field) => () =>
          runtime.dsl.agent(`Extract ${field}`, {
            label: "extract-field",
            title: `orders.py · ${field}`,
            output: { type: "string" },
          }),
      ),
      { keys: fields },
    );
    const rows = [...agentLiveStore.rows.values()].filter(
      (row) => row.workflowRunId === id && row.groupKind === undefined,
    );
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    for (const field of fields) {
      const title = `orders.py · ${field}`;
      const row = rows.find((row) => row.title === title);
      assert.ok(row);
      assert.ok(formatAgentLiveRowLine(row, statusMeta(row.status, 0), 160).includes(title));
      assert.ok(formatAgentDrillTitle(row).includes(title));
    }
    assert.deepEqual(
      runtime
        .getJournal()
        .filter((line) => line.kind === "agent_start")
        .map((line) => line.title)
        .sort(),
      fields.map((field) => `orders.py · ${field}`).sort(),
    );
  }));
