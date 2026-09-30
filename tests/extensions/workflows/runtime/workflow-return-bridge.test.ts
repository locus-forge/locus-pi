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
  customToolNames: string[][];
  returnToolDescriptions: string[];
} {
  const h = createHarness(root);
  const runDir = tempRun(root, id);
  const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir });
  const counters = { sessions: 0, prompts: 0, disposals: 0 };
  const feedback: string[] = [];
  const promptTexts: string[] = [];
  const customToolNames: string[][] = [];
  const returnToolDescriptions: string[] = [];
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
          customToolNames.push((sessionOptions.customTools ?? []).map((item) => item.name));
          // Present only for a choice call; a plain child answers with its final text.
          const tool = sessionOptions.customTools?.find((item) => item.name === "workflow_return");
          if (tool !== undefined) returnToolDescriptions.push(tool.description);
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
                if (tool === undefined) {
                  emit({ type: "agent_end", willRetry: false });
                  return;
                }
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
              getLastAssistantText: () => (tool === undefined ? "Plain exact text.\n" : "DO NOT USE THIS NARRATIVE"),
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
    customToolNames,
    returnToolDescriptions,
  };
}

test("a plain agent receives no workflow_return tool and returns its exact final text", async () =>
  temporary(async (root) => {
    const { runtime, counters, customToolNames, promptTexts } = bridgeHarness(root, "bridge-plain", () => {
      throw new Error("a plain child has no return tool to call");
    });
    const value = await runtime.dsl.agent("Write scope/scope.md, read it back, then summarize what was written.", {
      label: "collect-scope",
    });
    assert.equal(value, "Plain exact text.\n");
    assert.deepEqual(customToolNames, [[]]);
    assert.doesNotMatch(promptTexts[0]!, /workflow_return/u);
    assert.deepEqual(counters, { sessions: 1, prompts: 1, disposals: 1 });
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.outputAcceptance, undefined);
    assert.equal(end?.schemaValidation, undefined);
  }));

test("runtime -> bridge -> SDK returns the accepted choice and preserves one session during correction", async () =>
  temporary(async (root) => {
    const id = "bridge-return";
    const { runtime, counters, customToolNames, returnToolDescriptions } = bridgeHarness(root, id, (prompt) =>
      prompt === 1 ? "bad" : "accept",
    );
    const value = await runtime.dsl.agent("Choose the next action.", {
      label: "route",
      title: "Orders · route",
      choice: ["accept", "revise"],
    });
    assert.equal(value, "accept");
    assert.equal(counters.sessions, 1);
    assert.equal(counters.prompts, 2);
    assert.equal(counters.disposals, 1);
    // The choice child is given the one return tool and nothing else of the removed kind.
    assert.deepEqual(customToolNames, [["workflow_return"]]);
    assert.match(
      returnToolDescriptions[0]!,
      /value must be exactly one of these declared strings: "accept", "revise"/u,
    );
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.outputAcceptance?.attempts, 2);
    assert.ok(
      [...agentLiveStore.rows.values()].some(
        (row) => row.title === "Orders · route" && row.childSessionId === "bridge-child",
      ),
    );
  }));

test("array and object proposals are refused and never coerced into a choice", async () =>
  temporary(async (root) => {
    const { runtime, counters, feedback } = bridgeHarness(root, "choice-containers", (prompt) =>
      prompt === 1 ? ["accept"] : { value: "accept" },
    );
    await assert.rejects(
      runtime.dsl.agent("Choose the next action.", { label: "route", choice: ["accept", "revise"] }),
      /Output contract exhausted after 2 attempts: value must be one exact declared string, not an object/u,
    );
    assert.deepEqual(counters, { sessions: 1, prompts: 2, disposals: 1 });
    assert.match(feedback[0]!, /value must be one exact declared string, not an array/u);
    assert.equal(
      runtime.getJournal().find((line) => line.kind === "agent_end")?.failureCause,
      "output-contract-exhausted",
    );
  }));

test("a stringified choice is corrected, not parsed", async () =>
  temporary(async (root) => {
    const { runtime, counters, feedback } = bridgeHarness(root, "choice-stringified", (prompt) =>
      prompt === 1 ? JSON.stringify("revise") : "revise",
    );
    const value = await runtime.dsl.agent("Choose the next action.", {
      label: "route",
      choice: ["accept", "revise"],
    });
    assert.equal(value, "revise");
    assert.deepEqual(counters, { sessions: 1, prompts: 2, disposals: 1 });
    assert.match(feedback[0]!, /value must exactly match one of \["accept","revise"\]/u);
  }));

test("choice repair accepts only an exact tool value within the declared attempts", async () =>
  temporary(async (root) => {
    const choices = ["accept", "fix", "failed"] as const;
    const first = bridgeHarness(root, "choice-repaired", (prompt) =>
      prompt === 1 ? { choice: "fix", reason: "slice ready; more work remains" } : "fix",
    );
    const route = await first.runtime.dsl.agent("Route the slice review", {
      label: "choice-repaired",
      choice: choices,
    });
    assert.equal(route, "fix");
    assert.deepEqual(first.counters, { sessions: 1, prompts: 2, disposals: 1 });
    assert.match(first.promptTexts[0]!, /Your final message is not the result/u);
    assert.doesNotMatch(first.promptTexts[0]!, /Your exact final non-empty message is the result/u);
    assert.match(first.promptTexts[0]!, /Valid tool arguments are/u);
    assert.ok(first.promptTexts[0]!.includes(JSON.stringify(JSON.stringify({ value: "accept" })).slice(1, -1)));
    assert.ok(first.promptTexts[0]!.includes(JSON.stringify(JSON.stringify({ value: "fix" })).slice(1, -1)));
    assert.match(first.feedback[0]!, /without an object, list or explanatory text/u);
    assert.equal(first.runtime.getJournal().find((line) => line.kind === "agent_end")?.outputAcceptance?.attempts, 2);

    const exhausted = bridgeHarness(root, "choice-exhausted", (prompt) =>
      prompt === 1
        ? { choice: "fix", reason: "slice ready; more work remains" }
        : prompt === 2
          ? "fix — slice ready; more work remains"
          : "fix",
    );
    await assert.rejects(
      exhausted.runtime.dsl.agent("Route the slice review", { label: "choice-exhausted", choice: choices }),
      /Output contract exhausted after 2 attempts: value must exactly match one of/u,
    );
    assert.deepEqual(exhausted.counters, { sessions: 1, prompts: 2, disposals: 1 });
    assert.equal(
      exhausted.runtime.getJournal().find((line) => line.kind === "agent_end")?.failureCause,
      "output-contract-exhausted",
    );
  }));

test("mapped agents keep distinct human titles through runtime, bridge, fleet rows and drill", async () =>
  temporary(async (root) => {
    const id = "bridge-mapped-titles";
    const { runtime } = bridgeHarness(root, id, () => "done");
    const fields = ["run_time", "mail"];
    await runtime.dsl.parallel(
      fields.map(
        (field) => () =>
          runtime.dsl.agent(`Check ${field}`, {
            label: "check-field",
            title: `orders.py · ${field}`,
            choice: ["done", "missing"],
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
