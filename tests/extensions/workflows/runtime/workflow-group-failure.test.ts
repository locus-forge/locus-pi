import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_GROUP_FAILURE,
  WorkflowGroupFailureError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentRunner,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { readWorkflowRunSummary } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { createHarness } from "../../../test-harness.js";

const okRunner: WorkflowAgentRunner = async (request) => ({
  ok: true,
  status: "completed",
  summary: request.prompt,
  diagnostics: [],
  agent: request.agent,
});

describe("workflow group failure contract", () => {
  it("keeps mapped pipeline and nested member contexts distinct across awaits", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "group-member-context",
      agentRunner: async (request) => {
        requests.push(request);
        await Promise.resolve();
        return {
          ok: true,
          status: "completed",
          summary: request.prompt,
          text: request.prompt,
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    await expect(
      dsl.pipeline(["a", "b", "c"], async (value) => {
        await Promise.resolve();
        return dsl.agent(`pipeline ${String(value)}`, { label: "mapped", phase: "pipeline" });
      }),
    ).resolves.toEqual(["pipeline a", "pipeline b", "pipeline c"]);

    await expect(
      dsl.parallel(
        ["left", "right"].map((side) => async () => {
          await Promise.resolve();
          return dsl.parallel(
            [0, 1].map((index) => async () => {
              await Promise.resolve();
              return dsl.agent(`${side}-${index}`, { label: "nested", phase: "nested" });
            }),
          );
        }),
      ),
    ).resolves.toEqual([
      ["left-0", "left-1"],
      ["right-0", "right-1"],
    ]);

    const pipelineSlots = requests.slice(0, 3).map((request) => request.workflowSlot);
    expect(pipelineSlots.map((slot) => slot?.rowOccurrence)).toEqual([
      { groupId: "pipeline-1", memberIndex: 0 },
      { groupId: "pipeline-1", memberIndex: 1 },
      { groupId: "pipeline-1", memberIndex: 2 },
    ]);
    const nestedSlots = requests.slice(3).map((request) => request.workflowSlot);
    expect(new Set(nestedSlots.map((slot) => slot?.key)).size).toBe(4);
    expect(nestedSlots.map((slot) => slot?.rowOccurrence)).toEqual([
      { groupId: "parallel-3", memberIndex: 0 },
      { groupId: "parallel-3", memberIndex: 1 },
      { groupId: "parallel-4", memberIndex: 0 },
      { groupId: "parallel-4", memberIndex: 1 },
    ]);
  });

  it("keeps all-success ordering and treats an explicitly returned null as a real value", async () => {
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "group-success-null", agentRunner: okRunner });

    const parallel = await dsl.parallel([async () => null, async () => "second"]);
    const pipeline = await dsl.pipeline([1, 2], async (value) => Number(value) + 1);

    expect(parallel).toEqual([null, "second"]);
    expect(pipeline).toEqual([2, 3]);
    expect(getJournal().filter((line) => line.kind === "group_end")).toEqual([
      expect.objectContaining({ groupKind: "parallel", status: "completed", groupCompleted: 2, groupFailed: 0 }),
      expect.objectContaining({ groupKind: "pipeline", status: "completed", groupCompleted: 2, groupFailed: 0 }),
    ]);
  });

  it("stops later stages for failed items and reports item/stage evidence after siblings finish", async () => {
    const stageTwoSeen: string[] = [];
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "pipeline-failure-slots", agentRunner: okRunner });

    let caught: unknown;
    try {
      await dsl.pipeline(
        ["a", "b", "c"],
        async (value) =>
          value === "b" ? { ok: false, status: "blocked", summary: "blocked at stage zero" } : { ok: true, value },
        async (value) => {
          const item = (value as { value: string }).value;
          stageTwoSeen.push(item);
          if (item === "c") throw new Error("stage one exploded");
          return item.toUpperCase();
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowGroupFailureError);
    const failure = caught as WorkflowGroupFailureError<unknown>;
    expect(failure.partialResults).toEqual([
      "A",
      { ok: false, status: "blocked", summary: "blocked at stage zero" },
      null,
    ]);
    expect(failure.failures).toEqual([
      {
        index: 1,
        stageIndex: 0,
        kind: "returned-failure",
        status: "blocked",
        message: "blocked at stage zero",
      },
      { index: 2, stageIndex: 1, kind: "thrown", message: "stage one exploded" },
    ]);
    expect(stageTwoSeen).toEqual(["a", "c"]);
    expect(
      getJournal()
        .filter((line) => line.kind === "group_end")
        .at(-1),
    ).toMatchObject({
      groupKind: "pipeline",
      status: "failed",
      groupCompleted: 1,
      groupFailed: 2,
    });
  });

  it("fails direct partial:true group results even when ok remains true", async () => {
    const { dsl } = createWorkflowRuntime({ runId: "parallel-partial-return", agentRunner: okRunner });

    await expect(
      dsl.parallel<unknown>([
        async () => ({ ok: true, partial: true, diagnostics: ["one requirement remains"] }),
        async () => "kept",
      ]),
    ).rejects.toMatchObject({
      code: WORKFLOW_GROUP_FAILURE,
      partialResults: [{ ok: true, partial: true, diagnostics: ["one requirement remains"] }, "kept"],
      failures: [{ index: 0, kind: "returned-failure", message: "one requirement remains" }],
    });
  });

  it("classifies the same detached toJSON failure at root and in a direct group while preserving group evidence", async () => {
    const rawGroupValue = {
      status: "completed",
      marker: "raw-group-evidence",
      toJSON: () => ({ status: "blocked", summary: "detached owner decision" }),
    };
    const { dsl } = createWorkflowRuntime({ runId: "group-detached-return", agentRunner: okRunner });

    let groupError: unknown;
    try {
      await dsl.parallel([async () => rawGroupValue]);
    } catch (error) {
      groupError = error;
    }

    expect(groupError).toBeInstanceOf(WorkflowGroupFailureError);
    const groupFailure = groupError as WorkflowGroupFailureError<typeof rawGroupValue>;
    expect(groupFailure.failures).toEqual([
      {
        index: 0,
        kind: "returned-failure",
        status: "blocked",
        message: "detached owner decision",
      },
    ]);
    expect(groupFailure.partialResults[0]).toBe(rawGroupValue);
    expect(groupFailure.slots[0]).toMatchObject({ index: 0, status: "failed" });
    expect((groupFailure.slots[0] as { value?: unknown }).value).toBe(rawGroupValue);

    const root = mkdtempSync(path.join(tmpdir(), "wf-root-detached-return-"));
    const harness = createHarness(root, { sessionId: "wf-root-detached-return" });
    try {
      writeFileSync(
        path.join(root, "detached.workflow.mjs"),
        [
          "export default () => ({",
          "  status: 'completed',",
          "  marker: 'raw-root-value',",
          "  toJSON: () => ({ status: 'blocked', summary: 'detached owner decision' }),",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "detached.workflow.mjs",
      });

      expect(result.ok).toBe(false);
      expect(result.result).toEqual({ status: "blocked", summary: "detached owner decision" });
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed with raw evidence when direct group JSON preparation reports a diagnostic", async () => {
    const cases = [
      {
        name: "raw-ok-false",
        value: {
          ok: false,
          summary: "raw failure must stay failed",
          toJSON(): never {
            throw new Error("raw ok:false detachment refused");
          },
        },
      },
      {
        name: "ordinary-value",
        value: {
          ok: true,
          summary: "ordinary value with broken JSON",
          toJSON(): never {
            throw new Error("ordinary detachment refused");
          },
        },
      },
    ];

    for (const testCase of cases) {
      const { dsl } = createWorkflowRuntime({ runId: `group-diagnostic-${testCase.name}`, agentRunner: okRunner });
      let caught: unknown;
      try {
        await dsl.parallel([async () => testCase.value]);
      } catch (error) {
        caught = error;
      }

      expect(caught, testCase.name).toBeInstanceOf(WorkflowGroupFailureError);
      const failure = caught as WorkflowGroupFailureError<typeof testCase.value>;
      expect(failure.partialResults[0], testCase.name).toBe(testCase.value);
      expect((failure.slots[0] as { value?: unknown }).value, testCase.name).toBe(testCase.value);
      expect(failure.failures, testCase.name).toEqual([
        {
          index: 0,
          kind: "returned-failure",
          message: expect.stringContaining("Workflow result is unavailable because it is not JSON-safe"),
        },
      ]);
      expect(failure.failures[0]?.message, testCase.name).toContain("detachment refused");
      expect(failure.toEnvelope(), testCase.name).toMatchObject({
        ok: false,
        kind: "workflow_group_failure",
        code: WORKFLOW_GROUP_FAILURE,
        groupKind: "parallel",
        completed: 0,
        failed: 1,
        failures: [
          {
            index: 0,
            kind: "returned-failure",
            message: expect.stringContaining("not JSON-safe"),
          },
        ],
      });
    }
  });

  it("persists a JSON-safe typed envelope and failed status for an unhandled group failure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-group-unhandled-"));
    const harness = createHarness(root, { sessionId: "wf-group-unhandled" });
    try {
      writeFileSync(
        path.join(root, "unhandled.workflow.mjs"),
        [
          "export default async function run({ parallel }) {",
          "  await parallel([",
          "    async () => BigInt(1),",
          "    async () => { throw new Error('branch exploded'); },",
          "  ]);",
          "  return { ok: true, summary: 'must not reach' };",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "unhandled.workflow.mjs",
      });
      const persisted = JSON.parse(readFileSync(result.resultPersistence.path, "utf8")) as {
        ok?: boolean;
        result?: unknown;
        error?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toContain("parallel failed in 2/2 branch(es)");
      expect(result.result).toMatchObject({
        ok: false,
        kind: "workflow_group_failure",
        code: WORKFLOW_GROUP_FAILURE,
        groupKind: "parallel",
        total: 2,
        completed: 0,
        failed: 2,
        failures: [
          {
            index: 0,
            kind: "returned-failure",
            message: expect.stringContaining("not JSON-safe"),
          },
          { index: 1, kind: "thrown", message: "branch exploded" },
        ],
      });
      expect(persisted).toMatchObject({ ok: false, result: result.result, error: result.error });
      expect(readWorkflowRunSummary(root, result.runId).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows explicit typed partial recovery but never projects partial:true as ordinary success", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-group-acknowledged-"));
    const harness = createHarness(root, { sessionId: "wf-group-acknowledged" });
    try {
      writeFileSync(
        path.join(root, "acknowledged.workflow.mjs"),
        [
          "export default async function run({ parallel }) {",
          "  try {",
          "    await parallel([",
          "      async () => ({ ok: true, value: 'kept' }),",
          "      async () => ({ ok: false, status: 'cancelled', summary: 'operator stopped branch' }),",
          "    ]);",
          "  } catch (error) {",
          `    if (!error || error.code !== ${JSON.stringify(WORKFLOW_GROUP_FAILURE)}) throw error;`,
          "    return {",
          "      partial: true,",
          "      outcome: 'partial',",
          "      completed: error.completed,",
          "      failed: error.failed,",
          "      kept: error.partialResults[0].value,",
          "      failureStatus: error.failures[0].status,",
          "    };",
          "  }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "acknowledged.workflow.mjs",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        partial: true,
        outcome: "partial",
        completed: 1,
        failed: 1,
        kept: "kept",
        failureStatus: "cancelled",
      });
      expect(readWorkflowRunSummary(root, result.runId).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
