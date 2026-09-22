/**
 * A recorded prefix is REUSED, not re-run: a resumed graph that asks for the same call in
 * the same order receives the recorded answer and the child's side effect never happens a
 * second time, while a call whose request or contract differs from the record is refused as
 * prefix divergence rather than silently answered fresh.
 *
 * The replay log's format, its schema version boundaries and the whole `--resume` command
 * path live in `workflow-replay.test.ts`; what is proven here is only the confirmed-prefix
 * property that makes resume safe. Fake child sessions, not live Pi/model proof.
 */
import assert from "node:assert/strict";
import { it } from "vitest";
import { resolveWorkflowBudget } from "../../../../extensions/workflows/runtime/workflow-budget.js";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
} from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { completed, tempRun, temporary } from "../../../fixtures/scripted-agent-runtime.js";
import {
  SHAPED_RESULT_SCHEMA as RESULT,
  SHAPED_RESULT_RECORD as RECORD,
} from "../../../fixtures/workflow-return-acceptance.js";

it("recorded adaptive prefix replays without repeating confirmed worker side effects", async () =>
  temporary(async (root) => {
    const source = tempRun(root, "source");
    let effects = 0;
    const first = createWorkflowRuntime({
      runId: "source",
      replay: createWorkflowReplayController({ runDir: source }),
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, "confirmed");
      },
    });
    assert.equal(await first.dsl.agent("goal", { label: "worker" }), "confirmed");
    const recorded = readWorkflowReplayLog(root, "source");
    assert.equal(recorded.length, 1);
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "resume"),
      recorded,
      requireRecordedPrefix: true,
    });
    const resumed = createWorkflowRuntime({
      runId: "resume",
      maxTotalAgentInvocations: resolveWorkflowBudget(undefined, true).budget.totalAgents!,
      replay,
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, "new review");
      },
    });
    assert.equal(await resumed.dsl.agent("goal", { label: "worker" }), "confirmed");
    assert.equal(effects, 1);
    assert.equal(await resumed.dsl.agent("review", { label: "reviewer" }), "new review");
    assert.equal(effects, 2);
    assert.equal(replay.counts().replayedCalls, 1);
    const strict = createWorkflowReplayController({
      runDir: tempRun(root, "strict"),
      recorded,
      requireRecordedPrefix: true,
    });
    const changed = createWorkflowRuntime({
      runId: "strict",
      replay: strict,
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, "wrong");
      },
    });
    await assert.rejects(changed.dsl.agent("changed goal", { label: "worker" }), /prefix divergence/u);
    assert.equal(effects, 2);
  }));
it("a changed schema contract does not reuse the recorded record, an identical one does", async () =>
  temporary(async (root) => {
    const source = tempRun(root, "shaped-source");
    let effects = 0;
    const record = createWorkflowRuntime({
      runId: "shaped-source",
      replay: createWorkflowReplayController({ runDir: source }),
      agentRunner: async (req) => {
        effects += 1;
        return {
          ...completed(req, JSON.stringify(RECORD)),
          outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
        };
      },
    });
    const shaped = { label: "verify", schema: RESULT } as const;
    assert.deepEqual(await record.dsl.agent("Verify", shaped), RECORD);
    const recorded = readWorkflowReplayLog(root, "shaped-source");
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "shaped-resume"),
      recorded,
      requireRecordedPrefix: true,
    });
    const resumed = createWorkflowRuntime({
      runId: "shaped-resume",
      replay,
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, '{"decision":"unknown","summary":"fresh"}');
      },
    });
    assert.deepEqual(await resumed.dsl.agent("Verify", shaped), RECORD);
    assert.equal(effects, 1);
    assert.equal(replay.counts().replayedCalls, 1);
    const strict = createWorkflowReplayController({
      runDir: tempRun(root, "shaped-strict"),
      recorded,
      requireRecordedPrefix: true,
    });
    const changed = createWorkflowRuntime({
      runId: "shaped-strict",
      replay: strict,
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, JSON.stringify(RECORD));
      },
    });
    await assert.rejects(
      changed.dsl.agent("Verify", {
        ...shaped,
        schema: {
          ...RESULT,
          required: ["decision", "summary", "evidence"],
          properties: { ...RESULT.properties, evidence: { type: "string", minLength: 1 } },
        },
      }),
      /prefix divergence/u,
    );
    assert.equal(effects, 1);
  }));
