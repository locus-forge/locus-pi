/**
 * The `workflow_return` contract inside ONE child session: repair, idempotence, conflict,
 * budget accumulation and the hosts that cannot carry it at all.
 *
 * The controller (`workflow-return.ts`) and the SDK host that runs its tool
 * (`agent-sdk-host.ts`) are both production code here; only the injected Pi session is a
 * double, so what is proven is that a wrong first answer is corrected WITHOUT a second
 * child. Requires installed Pi imports; fake child sessions, not live Pi/model proof.
 *
 * The same contract driven through `dsl.agent()` and the bridge lives in
 * `workflow-return-bridge.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import {
  createWorkflowReturnController,
  normalizeWorkflowReturnContract,
  type WorkflowReturnContract,
} from "../../../../extensions/workflows/runtime/workflow-return.js";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionLike,
  type SdkAgentSessionEventLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { temporaryValue } from "../../../fixtures/scripted-agent-runtime.js";
import {
  SHAPED_RESULT_SCHEMA as RESULT,
  SHAPED_RESULT_RECORD as RECORD,
} from "../../../fixtures/workflow-return-acceptance.js";

// SDK execution is real production code; only the injected Pi session is simulated.
interface SessionScenario {
  submissions: Array<Array<unknown>>;
  /** Defaults to the single-line string contract; a shaped case supplies its own. */
  contract?: WorkflowReturnContract;
  rejectPrompt?: number;
  providerFailure?: boolean;
  cancelAfterProposal?: boolean;
  maxToolCalls?: number;
  maxTurns?: number;
  noRestriction?: boolean;
  conflicting?: boolean;
}
async function runSession(scenario: SessionScenario) {
  return temporaryValue(async (root) => {
    const controller = createWorkflowReturnController(
      scenario.contract ??
        normalizeWorkflowReturnContract({ output: { type: "string", singleLine: true }, repair: { maxAttempts: 3 } }),
    );
    const abort = new AbortController();
    const prompts: string[] = [];
    const restrictions: string[][] = [];
    const ids: string[] = [];
    let created = 0,
      disposed = 0,
      toolCalls = 0,
      active = ["read", "write", "workflow_return"];
    let emit: (event: SdkAgentSessionEventLike) => void = () => {};
    const messages: unknown[] = [];
    const executor = createAgentSdkSessionExecutor({
      maxToolCalls: scenario.maxToolCalls ?? 10,
      childTimeoutMs: 1000,
      reportsDir: path.join(root, "reports"),
      createSession: async () => {
        created += 1;
        const session: SdkAgentSessionLike = {
          sessionId: "same-child",
          messages,
          subscribe(listener) {
            emit = listener;
            return () => {
              emit = () => {};
            };
          },
          async prompt(text) {
            prompts.push(text);
            ids.push("same-child");
            emit({ type: "turn_start" });
            if (scenario.rejectPrompt === prompts.length) throw new Error("provider transport rejected");
            for (const value of scenario.submissions[prompts.length - 1] ?? []) {
              toolCalls += 1;
              emit({ type: "tool_execution_start", toolName: "workflow_return", toolCallId: `t${toolCalls}` });
              await controller.tool.execute(`t${toolCalls}`, { value }, abort.signal);
              emit({ type: "tool_execution_end", toolName: "workflow_return", toolCallId: `t${toolCalls}` });
            }
            if (scenario.providerFailure)
              messages.push({ role: "assistant", stopReason: "error", errorMessage: "provider failed after proposal" });
            if (scenario.cancelAfterProposal) abort.abort();
            emit({ type: "agent_end", willRetry: false });
          },
          getActiveToolNames: () => [...active],
          ...(scenario.noRestriction
            ? {}
            : {
                setActiveToolsByName(names: string[]) {
                  active = [...names];
                  restrictions.push([...names]);
                },
              }),
          getSessionStats: () => ({ sessionId: "same-child", toolCalls, toolResults: toolCalls }),
          getLastAssistantText: () => "Untrusted narrative is not the accepted value",
          exportToJsonl(target) {
            const file = target ?? path.join(root, "session.jsonl");
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, "{}\n");
            return file;
          },
          async abort() {},
          dispose() {
            disposed += 1;
          },
        };
        return { session };
      },
    });
    const request: AgentRunRequest = {
      executionMode: "bare",
      task: "Research the field",
      projectRoot: root,
      workingDirectory: root,
      parentSessionId: "parent",
      maxTurns: scenario.maxTurns ?? 6,
      depth: 0,
      maxDepth: 1,
      allowedTools: ["*"],
      approvalTier: "allow",
      customTools: [controller.tool],
      responseAcceptance: controller.acceptance,
    };
    const result = await executor.run(request, abort.signal);
    return { result, created, disposed, prompts, restrictions, ids, toolCalls };
  });
}
it("invalid output is corrected in the same session with only return tools, then disposed once", async () => {
  const got = await runSession({ submissions: [["bad\nline"], ["orders"]] });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.text, '"orders"');
  assert.deepEqual(got.ids, ["same-child", "same-child"]);
  assert.equal(got.created, 1);
  assert.equal(got.disposed, 1);
  assert.equal(got.prompts.length, 2);
  assert.match(got.prompts[1]!, /Reuse your existing evidence/u);
  assert.ok(got.restrictions.length >= 2);
  assert.ok(got.restrictions.every((names) => JSON.stringify(names) === '["workflow_return"]'));
  assert.deepEqual(got.result.outputAcceptance, { source: "tool", attempts: 2, toolName: "workflow_return" });
});
it("missing return tool use receives bounded same-session clarification", async () => {
  const recovered = await runSession({ submissions: [[], ["orders"]] });
  assert.equal(recovered.result.status, "completed");
  assert.equal(recovered.created, 1);
  const exhausted = await runSession({ submissions: [[], [], []] });
  assert.equal(exhausted.prompts.length, 3);
  assert.equal(exhausted.result.failureCause, "output-contract-exhausted");
  assert.equal(exhausted.result.outputAcceptance, undefined);
  assert.equal(exhausted.disposed, 1);
});
it("identical return proposal is idempotent; conflicting proposals never succeed", async () => {
  const duplicate = await runSession({ submissions: [["orders", "orders"]] });
  assert.equal(duplicate.result.status, "completed");
  assert.equal(duplicate.result.outputAcceptance?.attempts, 1);
  const conflict = await runSession({ submissions: [["orders", "other"]] });
  assert.equal(conflict.result.failureCause, "output-contract-conflict");
  assert.equal(conflict.result.outputAcceptance, undefined);
});
// The regexes below quote validator wording owned by workflow-schema.ts; a reword updates both.
it("an off-shape record is corrected in the same session and the accepted value is canonical JSON", async () => {
  const got = await runSession({
    contract: normalizeWorkflowReturnContract({ schema: RESULT, repair: { maxAttempts: 2 } }),
    submissions: [[{ decision: "complete" }], [RECORD]],
  });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.text, '{"decision":"complete","summary":"ok"}');
  assert.equal(got.created, 1);
  assert.equal(got.prompts.length, 2);
  assert.match(got.prompts[1]!, /summary/u);
  assert.match(got.prompts[1]!, /Reuse your existing evidence/u);
  assert.equal(got.result.outputAcceptance?.attempts, 2);
  assert.ok(got.restrictions.every((names) => JSON.stringify(names) === '["workflow_return"]'));
});
it("a string containing JSON is a shape mismatch that is repaired, not parsed", async () => {
  const got = await runSession({
    contract: normalizeWorkflowReturnContract({ schema: RESULT, repair: { maxAttempts: 2 } }),
    submissions: [[JSON.stringify(RECORD)], [RECORD]],
  });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.outputAcceptance?.attempts, 2);
  assert.match(got.prompts[1]!, /expected object, got string/u);
});
it("an AUTHOR-declared maxLength is corrected in the same session, not after the child ends", async () => {
  // The bound under test is the author's own `maxLength` inside the schema, not a runtime
  // default: there is none. A value past it is a correctable violation, not a dead child.
  const got = await runSession({
    contract: normalizeWorkflowReturnContract({
      schema: { type: "string", minLength: 1, maxLength: 200_000 },
      repair: { maxAttempts: 2 },
    }),
    submissions: [["x".repeat(200_001)], ["short"]],
  });
  assert.equal(got.result.status, "completed");
  assert.equal(got.created, 1);
  assert.match(got.prompts[1]!, /expected at most 200000 character/u);
});
it("a shaped value carries no runtime size policy of its own", async () => {
  const huge = "x".repeat(400_000);
  const got = await runSession({
    contract: normalizeWorkflowReturnContract({ schema: { type: "string", minLength: 1 } }),
    submissions: [[huge]],
  });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.text, JSON.stringify(huge));
});
it("exhausted schema repair fails the call without an unvalidated value", async () => {
  const got = await runSession({
    contract: normalizeWorkflowReturnContract({ schema: RESULT, repair: { maxAttempts: 2 } }),
    submissions: [[{}], [{}]],
  });
  assert.equal(got.result.status, "failed");
  assert.equal(got.result.failureCause, "output-contract-exhausted");
  assert.equal(got.result.outputAcceptance, undefined);
});
it("identical record proposals are idempotent; a different record conflicts", async () => {
  const duplicate = await runSession({
    contract: normalizeWorkflowReturnContract({ schema: RESULT, repair: { maxAttempts: 2 } }),
    submissions: [[RECORD, { ...RECORD }]],
  });
  assert.equal(duplicate.result.status, "completed");
  assert.equal(duplicate.result.outputAcceptance?.attempts, 1);
  const conflict = await runSession({
    contract: normalizeWorkflowReturnContract({ schema: RESULT, repair: { maxAttempts: 2 } }),
    submissions: [[RECORD, { ...RECORD, summary: "other" }]],
  });
  assert.equal(conflict.result.failureCause, "output-contract-conflict");
  assert.equal(conflict.result.outputAcceptance, undefined);
});
it("handoffs through the tool use the same bounded unique array contract", async () => {
  const contract = () =>
    normalizeWorkflowReturnContract({
      schema: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 2000, nonBlank: true },
        minItems: 1,
        maxItems: 2,
        uniqueTrimmedItems: true,
      },
      repair: { maxAttempts: 2 },
    });
  const repaired = await runSession({ contract: contract(), submissions: [[["a", " a "]], [["a", "b"]]] });
  assert.equal(repaired.result.status, "completed");
  assert.equal(repaired.result.text, '["a","b"]');
  assert.match(repaired.prompts[1]!, /duplicates item 0/u);
  const overflowing = await runSession({ contract: contract(), submissions: [[["a", "b", "c"]], [["a", "b", "c"]]] });
  assert.equal(overflowing.result.failureCause, "output-contract-exhausted");
});
it("a proposed value is not success after provider failure or cancellation", async () => {
  const failed = await runSession({ submissions: [["orders"]], providerFailure: true });
  assert.equal(failed.result.failureCause, "provider-error");
  assert.equal(failed.result.outputAcceptance, undefined);
  const cancelled = await runSession({ submissions: [["orders"]], cancelAfterProposal: true });
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal(cancelled.result.outputAcceptance, undefined);
});
it("tool and assistant-turn budgets accumulate across clarification rather than reset", async () => {
  const tools = await runSession({ submissions: [["bad\nline"], ["orders"]], maxToolCalls: 1 });
  assert.equal(tools.result.failureCause, "tool-call-budget");
  const turns = await runSession({ submissions: [[], ["orders"]], maxTurns: 1 });
  assert.equal(turns.result.failureCause, "assistant-turn-budget");
  assert.equal(turns.prompts.length, 1);
});
it("unsupported same-session host fails before asking the model, without a new-session fallback", async () => {
  const got = await runSession({ submissions: [["orders"]], noRestriction: true });
  assert.equal(got.result.failureCause, "output-contract-unavailable");
  assert.equal(got.prompts.length, 0);
  assert.equal(got.disposed, 1);
});
