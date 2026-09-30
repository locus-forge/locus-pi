/**
 * The `workflow_return` choice contract inside ONE child session: correction, idempotence,
 * conflict, refusal of every non-member value, budget accumulation and the hosts that
 * cannot carry it at all.
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

// SDK execution is real production code; only the injected Pi session is simulated.
interface SessionScenario {
  submissions: Array<Array<unknown>>;
  /** Defaults to the three-member choice contract below. */
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
      scenario.contract ?? normalizeWorkflowReturnContract({ choices: ["orders", "other", "complete"] }),
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
it("the contract carries only declared choices and the package-owned correction budget", () => {
  assert.equal(
    JSON.stringify(normalizeWorkflowReturnContract({ choices: ["accept", "revise"] })),
    '{"version":3,"choices":["accept","revise"],"maxAttempts":2}',
  );
  for (const removed of [
    { choices: ["a", "b"], schema: { type: "array" } },
    { choices: ["a", "b"], output: { type: "string" } },
    { choices: ["a", "b"], repair: { maxAttempts: 3 } },
  ])
    assert.throws(
      () => normalizeWorkflowReturnContract(removed as never),
      /a workflow return contract carries only choices; unsupported field\(s\): (schema|output|repair)/u,
    );
  assert.throws(() => normalizeWorkflowReturnContract({} as never), /requires an array of non-empty choice strings/u);
});
it("a non-member choice is corrected in the same session with only return tools, then disposed once", async () => {
  const got = await runSession({ submissions: [["bad"], ["orders"]] });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.text, '"orders"');
  assert.deepEqual(got.ids, ["same-child", "same-child"]);
  assert.equal(got.created, 1);
  assert.equal(got.disposed, 1);
  assert.equal(got.prompts.length, 2);
  assert.match(got.prompts[1]!, /value must exactly match one of \["orders","other","complete"\]/u);
  assert.match(got.prompts[1]!, /Reuse your existing evidence/u);
  assert.ok(got.restrictions.length >= 2);
  assert.ok(got.restrictions.every((names) => JSON.stringify(names) === '["workflow_return"]'));
  assert.deepEqual(got.result.outputAcceptance, { source: "tool", attempts: 2, toolName: "workflow_return" });
});
it("missing return tool use receives one bounded same-session clarification", async () => {
  const recovered = await runSession({ submissions: [[], ["orders"]] });
  assert.equal(recovered.result.status, "completed");
  assert.equal(recovered.created, 1);
  const exhausted = await runSession({ submissions: [[], [], []] });
  assert.equal(exhausted.prompts.length, 2);
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
it("an array or object proposal is never accepted, even when it wraps a declared member", async () => {
  const exhausted = await runSession({ submissions: [[["orders"]], [{ value: "orders" }]] });
  assert.equal(exhausted.result.status, "failed");
  assert.equal(exhausted.result.failureCause, "output-contract-exhausted");
  assert.equal(exhausted.result.outputAcceptance, undefined);
  assert.match(exhausted.prompts[1]!, /value must be one exact declared string, not an array/u);
  const corrected = await runSession({ submissions: [[{ choice: "orders", reason: "evidence" }], ["orders"]] });
  assert.equal(corrected.result.status, "completed");
  assert.equal(corrected.result.text, '"orders"');
  assert.match(corrected.prompts[1]!, /not an object/u);
});
it("a string containing JSON is a non-member that is corrected, not parsed", async () => {
  const got = await runSession({ submissions: [[JSON.stringify("orders")], ["orders"]] });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.outputAcceptance?.attempts, 2);
  assert.match(got.prompts[1]!, /value must exactly match one of/u);
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
  const tools = await runSession({ submissions: [["bad"], ["orders"]], maxToolCalls: 1 });
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
