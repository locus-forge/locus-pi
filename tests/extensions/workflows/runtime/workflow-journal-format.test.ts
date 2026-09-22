/**
 * The PERSISTED journal event contract: which fields each event kind allows, which it
 * requires, and where the codec is deliberately tolerant of journals written before a
 * field existed.
 *
 * Storage — claiming a run, appending, reading a file back, listing and summarizing — is
 * proven against the filesystem elsewhere (workflow-run-report.test.ts,
 * workflow-run-snapshot.test.ts). What is proven here is only what one LINE is, read
 * straight through the codec with no file involved.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { workflowJournalLineProblem } from "../../../../extensions/workflows/runtime/workflow-journal-format.js";

const RUN_ID = "20260728-190000-ab12";
const TS = "2026-07-28T19:00:00.000Z";

function line(fields: Record<string, unknown>): Record<string, unknown> {
  return { ts: TS, runId: RUN_ID, ...fields };
}

describe("workflow journal line codec", () => {
  describe("malformed lines", () => {
    it("refuses a value that is not a JSON object", () => {
      assert.equal(workflowJournalLineProblem("phase", RUN_ID), "Expected a JSON object.");
      assert.equal(workflowJournalLineProblem(null, RUN_ID), "Expected a JSON object.");
      assert.equal(workflowJournalLineProblem([], RUN_ID), "Expected a JSON object.");
    });

    it("refuses a line with no timestamp", () => {
      assert.equal(
        workflowJournalLineProblem({ runId: RUN_ID, kind: "phase", phase: "one" }, RUN_ID),
        "Field ts must be a string.",
      );
    });

    it("refuses a line recorded under a different run", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "phase", phase: "one" }), "20260728-190000-cd34"),
        'Field runId must equal "20260728-190000-cd34".',
      );
    });

    it("refuses an event kind the runtime never writes", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_paused" }), RUN_ID),
        "Field kind is not a supported workflow journal event.",
      );
    });

    it("refuses a field carrying the wrong primitive type", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "log", message: 7 }), RUN_ID),
        "Field message must be string.",
      );
      assert.equal(
        workflowJournalLineProblem(
          line({ kind: "agent_end", status: "completed", agent: "default", durationMs: "12" }),
          RUN_ID,
        ),
        "Field durationMs must be finite number.",
      );
      assert.equal(
        workflowJournalLineProblem(
          line({ kind: "agent_end", status: "completed", agent: "default", replayed: "yes" }),
          RUN_ID,
        ),
        "Field replayed must be boolean.",
      );
    });

    it("refuses a status no reader can act on", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({
            kind: "group_end",
            groupId: "g1",
            groupKind: "parallel",
            groupTotal: 1,
            groupCompleted: 1,
            groupFailed: 0,
            status: "done",
          }),
          RUN_ID,
        ),
        "Field status must be completed or failed for group_end events.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_end", status: "done", agent: "default" }), RUN_ID),
        "Field status is invalid for agent_end events.",
      );
    });

    it("refuses a retry ordinal that is missing half its trio", () => {
      const base = { kind: "agent_end", status: "completed", callId: "c1", agent: "default" };
      assert.equal(
        workflowJournalLineProblem(line({ ...base, attempt: 1 }), RUN_ID),
        "Fields attempt and attempts must be present together.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ ...base, attempt: 1, attempts: 2 }), RUN_ID),
        "Fields attempt and logicalCallId must be present together.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ ...base, attempt: 3, attempts: 2, logicalCallId: "l1" }), RUN_ID),
        "Field attempt must not exceed attempts.",
      );
    });

    it("refuses a replayed agent line that also claims a live tool readback", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({
            kind: "agent_end",
            status: "completed",
            callId: "c1",
            agent: "default",
            replayed: true,
            activeToolNames: ["read"],
          }),
          RUN_ID,
        ),
        "Field activeToolNames cannot be present when replayed is true.",
      );
    });

    it("refuses group keys that do not name every member exactly once", () => {
      const base = { kind: "group_start", groupId: "g1", groupKind: "parallel", groupTotal: 2 };
      assert.equal(
        workflowJournalLineProblem(line({ ...base, groupKeys: ["a"] }), RUN_ID),
        "Field groupKeys must name every group member exactly once.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ ...base, groupKeys: ["a", "a"] }), RUN_ID),
        "Field groupKeys must name every group member exactly once.",
      );
    });

    it("refuses a canonical runtime choice log with no decision, and a decision outside it", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "log", source: "runtime", message: "[workflow:choice]" }), RUN_ID),
        "Canonical choice log requires choiceDecision.",
      );
      assert.equal(
        workflowJournalLineProblem(
          line({
            kind: "log",
            source: "script",
            message: "picked",
            choiceDecision: { value: "a", source: "validated", returnVia: "tool" },
          }),
          RUN_ID,
        ),
        "Field choiceDecision requires a canonical runtime choice log.",
      );
    });
  });

  describe("cross-kind fields", () => {
    it("refuses an agent field on a phase line", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "phase", phase: "one", agent: "default" }), RUN_ID),
        "Field agent is not allowed for phase events.",
      );
    });

    it("refuses an agent_end-only field on agent_start", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_start", agent: "default", status: "completed" }), RUN_ID),
        "Field status is not allowed for agent_start events.",
      );
      assert.equal(
        workflowJournalLineProblem(
          line({ kind: "agent_start", agent: "default", usage: { input: 1, output: 1, totalTokens: 2 } }),
          RUN_ID,
        ),
        "Field usage is not allowed for agent_start events.",
      );
    });

    it("refuses a log-only field on an error line", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({ kind: "error", message: "boom", continuation: { originRunId: RUN_ID, artifacts: [] } }),
          RUN_ID,
        ),
        "Field continuation is not allowed for error events.",
      );
    });

    it("refuses an agent_start-only field on agent_end", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({ kind: "agent_end", status: "completed", callId: "c1", requestedModel: "sonnet" }),
          RUN_ID,
        ),
        "Field requestedModel is not allowed for agent_end events.",
      );
    });
  });

  describe("unknown fields", () => {
    it("refuses a field the contract never declared", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "log", message: "hello", severity: "warn" }), RUN_ID),
        "Field severity is not allowed for log events.",
      );
    });

    it("tolerates an extra key inside usage, which checks its own fields and no closed set", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({
            kind: "agent_end",
            status: "completed",
            callId: "c1",
            agent: "default",
            usage: { input: 1, output: 1, totalTokens: 2, cached: 3 },
          }),
          RUN_ID,
        ),
        undefined,
      );
    });

    it("refuses an unknown field inside a payload object that declares a closed set", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({
            kind: "log",
            source: "runtime",
            message: "[workflow:choice]",
            choiceDecision: { value: "a", source: "validated", returnVia: "tool", extra: 1 },
          }),
          RUN_ID,
        ),
        "Field choiceDecision is invalid.",
      );
    });
  });

  describe("required fields", () => {
    it("names the first missing required field for each kind", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "phase" }), RUN_ID),
        "Field phase is required for phase events.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "log" }), RUN_ID),
        "Field message is required for log events.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "error" }), RUN_ID),
        "Field message is required for error events.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "group_start" }), RUN_ID),
        "Field groupId is required for group_start events.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_end", agent: "default" }), RUN_ID),
        "Field status is required for agent_end events.",
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_queued", agent: "default" }), RUN_ID),
        "Field callId is required for agent_queued events.",
      );
    });
  });

  describe("legacy tolerance", () => {
    it("accepts an agent_start with no callId, because the earliest journals wrote none", () => {
      assert.equal(workflowJournalLineProblem(line({ kind: "agent_start", agent: "default" }), RUN_ID), undefined);
    });

    it("accepts an agent line with no executionMode as long as it names an agent", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_end", status: "completed", agent: "default" }), RUN_ID),
        undefined,
      );
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_end", status: "completed" }), RUN_ID),
        "Field agent is required for legacy agent_end events.",
      );
    });

    it("accepts a schemaValidation with neither source nor coercion, and the retired coercion values", () => {
      const base = { kind: "agent_end", status: "completed", agent: "default", callId: "c1" };
      assert.equal(
        workflowJournalLineProblem(
          line({ ...base, schemaValidation: { status: "valid", attempts: 1, errors: [] } }),
          RUN_ID,
        ),
        undefined,
      );
      assert.equal(
        workflowJournalLineProblem(
          line({
            ...base,
            schemaValidation: { status: "mismatch", attempts: 1, errors: ["nope"], coercion: "bare-text" },
          }),
          RUN_ID,
        ),
        undefined,
      );
    });

    it("accepts usage with no costTotal, because absent means unknown and never zero", () => {
      assert.equal(
        workflowJournalLineProblem(
          line({
            kind: "agent_end",
            status: "completed",
            agent: "default",
            usage: { input: 10, output: 5, totalTokens: 15 },
          }),
          RUN_ID,
        ),
        undefined,
      );
    });

    it("accepts a non-completed agent_end with no failureCause, which reads as unclassified", () => {
      assert.equal(
        workflowJournalLineProblem(line({ kind: "agent_end", status: "failed", agent: "default" }), RUN_ID),
        undefined,
      );
    });

    it("accepts a log line with no source, because provenance must not be inferred", () => {
      assert.equal(workflowJournalLineProblem(line({ kind: "log", message: "hello" }), RUN_ID), undefined);
    });

    it("accepts a resume summary with no hasJournal flag", () => {
      const summary = {
        runId: "20260728-180000-99aa",
        status: "completed",
        phase: null,
        agentsStarted: 1,
        agentsEnded: 1,
        agentsReplayed: 0,
        usage: null,
        errors: 0,
        lastKind: "agent_end",
        lastTs: TS,
        hasResult: true,
      };
      assert.equal(
        workflowJournalLineProblem(
          line({ kind: "log", message: "resumed", resumeFromRunId: summary.runId, resumeSourceRunSummary: summary }),
          RUN_ID,
        ),
        undefined,
      );
    });
  });
});
