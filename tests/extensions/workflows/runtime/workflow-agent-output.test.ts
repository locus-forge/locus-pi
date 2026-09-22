import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  createWorkflowAgentOutput,
  type WorkflowAgentOutputDeps,
} from "../../../../extensions/workflows/runtime/workflow-agent-output.js";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { completed, tempRun, temporary } from "../../../fixtures/scripted-agent-runtime.js";
import {
  SHAPED_RESULT_SCHEMA as RESULT,
  SHAPED_RESULT_RECORD as RECORD,
} from "../../../fixtures/workflow-return-acceptance.js";
import {
  SchemaValidationError,
  type AgentAttemptOutcome,
  type WorkflowAgentAnyOptions,
} from "../../../../extensions/workflows/runtime/workflow-agent-contract.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-journal-format.js";

/**
 * The shaped-output owner on its own, without the DSL around it.
 *
 * The suites beside this one drive the same behavior through `dsl.agent()`, which is the
 * right level for "what does an author get back". What they cannot show is that this
 * module decides it ALONE: that the acceptance reads the confirmed receipt the logical
 * call carries in `schemaCheck` and never the child's final text, and that every
 * declaration refusal fires here rather than somewhere further down the call.
 */
function outputOwner(runAgentAttempt: WorkflowAgentOutputDeps["runAgentAttempt"]) {
  const journal: WorkflowJournalLine[] = [];
  const owner = createWorkflowAgentOutput({
    runId: "agent-output",
    now: () => "2026-01-01T00:00:00.000Z",
    emit: (line) => {
      journal.push(line);
    },
    currentPhase: () => undefined,
    branchContext: () => undefined,
    activeGroupFields: () => ({}),
    runScriptValidate: (run) => run(),
    runAgentAttempt,
  });
  return { owner, journal };
}

/** A logical call that must never be reached: every case below refuses before it runs. */
const neverRuns: WorkflowAgentOutputDeps["runAgentAttempt"] = async () => {
  throw new Error("the logical call must not run for a refused declaration");
};

function accepted(value: unknown, text = "ignored final text"): AgentAttemptOutcome {
  return {
    text,
    callId: "call-0001",
    replayed: false,
    outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
    schemaCheck: { value, validation: { status: "valid", attempts: 1, errors: [] } },
  };
}

describe("workflow agent output — declaration dispatch", () => {
  it.each<[string, WorkflowAgentAnyOptions | undefined]>([
    ["no options at all", undefined],
    ["an empty declaration", {}],
    ["execution axes only", { label: "review", attempts: 2, timeoutMs: 1_000 }],
    ["an observed report", { result: "report" }],
  ])("routes %s to the plain path", (_name, opts) => {
    const { owner } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape(opts)).toBe("plain");
  });

  it.each<[string, WorkflowAgentAnyOptions]>([
    ["choice", { choice: ["accept", "revise"] }],
    ["handoffs", { handoffs: { minItems: 1 } }],
    ["schema", { schema: { type: "string" } }],
    ["output", { output: { type: "string" as const } }],
    // `repair` declares the clarification allowance of a contract, so it is a shaped
    // declaration on its own: routing it to the plain path would apply it to nothing.
    ["repair alone", { repair: { maxAttempts: 2 } } as WorkflowAgentAnyOptions],
  ])("routes %s to the shaped path", (_name, opts) => {
    const { owner } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape(opts)).toBe("shaped");
  });

  it.each<[WorkflowAgentAnyOptions, string]>([
    [{ maxAnswerChars: 400 } as WorkflowAgentAnyOptions, "agent maxAnswerChars was removed"],
    [{ schemaMaxLength: 400 } as WorkflowAgentAnyOptions, "agent schemaMaxLength was removed"],
    [{ result: "summary" } as WorkflowAgentAnyOptions, "agent result must be report when supplied"],
    [
      { result: "report", schema: { type: "string" } } as WorkflowAgentAnyOptions,
      "agent result: report cannot be combined with schema",
    ],
    [{ choiceFallback: "accept" } as WorkflowAgentAnyOptions, "agent choiceFallback requires choice"],
    [{ validate: () => [] } as WorkflowAgentAnyOptions, "agent validate requires a schema or handoffs"],
    [
      { returnVia: "text", schema: { type: "string" } } as WorkflowAgentAnyOptions,
      'agent returnVia: "text" was removed',
    ],
  ])("refuses %o at dispatch", (opts, message) => {
    const { owner } = outputOwner(neverRuns);
    expect(() => owner.dispatchWorkflowAgentShape(opts)).toThrow(message);
  });

  it('reports returnVia: "tool" as redundant rather than refusing it', () => {
    const { owner, journal } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape({ returnVia: "tool", schema: { type: "string" } })).toBe("shaped");
    expect(journal.map((line) => line.message)).toEqual([
      expect.stringContaining('agent returnVia: "tool" is redundant and ignored') as string,
    ]);
  });
});

describe("workflow agent output — mutually exclusive shapes", () => {
  it.each<[WorkflowAgentAnyOptions, string]>([
    [
      { handoffs: { minItems: 1 }, schema: { type: "array" } } as WorkflowAgentAnyOptions,
      "agent handoffs cannot be combined with schema",
    ],
    [
      { choice: ["a", "b"], handoffs: { minItems: 1 } } as WorkflowAgentAnyOptions,
      "agent choice cannot be combined with handoffs",
    ],
    [
      { choice: ["a", "b"], schema: { type: "string" } } as WorkflowAgentAnyOptions,
      "agent choice cannot be combined with schema",
    ],
    [
      { output: { type: "string" as const }, choice: ["a", "b"] } as WorkflowAgentAnyOptions,
      "agent output is a string-only contract and cannot be combined with choice, schema or handoffs",
    ],
    [
      { output: { type: "string" as const }, schema: { type: "string" } } as WorkflowAgentAnyOptions,
      "agent output is a string-only contract and cannot be combined with choice, schema or handoffs",
    ],
    [
      { output: { type: "string" as const }, handoffs: { minItems: 1 } } as WorkflowAgentAnyOptions,
      "agent output is a string-only contract and cannot be combined with choice, schema or handoffs",
    ],
    [
      { validate: () => [], output: { type: "string" as const } } as WorkflowAgentAnyOptions,
      "agent validate requires a schema or handoffs",
    ],
    [{ validate: "not a function", schema: { type: "string" } } as unknown as WorkflowAgentAnyOptions, "agent validate must be a function"], // prettier-ignore
  ])("refuses %o before the child starts", async (opts, message) => {
    const { owner } = outputOwner(neverRuns);
    await expect(owner.runShapedAgent("decide", opts)).rejects.toThrow(message);
  });
});

describe("workflow agent output — acceptance comes from the receipt", () => {
  it("returns the value the confirmed receipt carried, not the child's final text", async () => {
    const { owner } = outputOwner(async () => accepted({ verdict: "accept" }, '{"verdict":"revise"}'));
    await expect(owner.runShapedAgent("decide", { schema: { type: "object" } })).resolves.toEqual({
      verdict: "accept",
    });
  });

  it("fails closed when the call carries no verdict at all", async () => {
    // An answer that never reached `workflow_return` leaves `schemaCheck` unset. There is
    // nothing to parse it out of the text with, and nothing here tries.
    const { owner } = outputOwner(async () => ({
      text: '{"verdict":"accept"}',
      callId: "call-0001",
      replayed: false,
    }));
    await expect(owner.runShapedAgent("decide", { schema: { type: "object" } })).rejects.toThrow(
      new SchemaValidationError(["missing output validation"], 1),
    );
  });

  it("refuses a string contract whose receipt carried a non-string value", async () => {
    const { owner } = outputOwner(async () => accepted({ verdict: "accept" }));
    await expect(owner.runShapedAgent("summarize", { output: { type: "string" as const } })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it("journals the choice decision from the accepted value and the receipt's attempts", async () => {
    const { owner, journal } = outputOwner(async () => accepted("revise"));
    await expect(owner.runShapedAgent("decide", { choice: ["accept", "revise"], label: "gate" })).resolves.toBe(
      "revise",
    );
    const decision = journal.find((line) => line.message === "[workflow:choice]");
    expect(decision?.choiceDecision).toEqual({ value: "revise", source: "validated", returnVia: "tool", attempts: 1 });
    expect(decision?.label).toBe("gate");
    expect(decision?.callId).toBe("call-0001");
  });
});

/**
 * The same owner reached through `dsl.agent()`, where an author actually meets it: the
 * declaration table that is refused before any child starts, the ones that are merely
 * redundant, and the accepted value travelling from the child's receipt to the author and
 * to the persisted canonical bytes. Fake child sessions, not live Pi/model proof.
 */
describe("workflow agent output — through the DSL", () => {
  it("malformed output contracts fail before any child starts", async () => {
    let calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "bad-contracts",
      agentRunner: async (req) => {
        calls += 1;
        return completed(req, '"value"');
      },
    });
    const invalid = [
      { returnVia: "other" },
      // The named removal: `text` promised a transport that no longer exists.
      { returnVia: "text", output: { type: "string" } },
      { choice: ["yes", "no"], output: { type: "string" } },
      { output: { type: "string" }, repair: {} },
      { output: { type: "string" }, repair: { maxAttempts: 0 } },
      { output: { type: "string", extra: true } },
      { output: { type: "string", maxLength: 0 } },
      { schema: { type: "object" }, output: { type: "string" } },
      { schema: { type: "object" }, handoffs: { maxItems: 2 } },
      { schema: { type: "object", oneOf: [] } },
      { handoffs: { maxItems: 0 } },
      { handoffs: { maxItems: 4, maxItemChars: 100 } },
      { schema: { type: "object" }, maxAnswerChars: 100 },
    ];
    for (const options of invalid) await assert.rejects(runtime.dsl.agent("work", options as never));
    assert.equal(calls, 0);
  });
  it("options that are now redundant or newly supported start a child instead of failing", async () => {
    let calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "accepted-contracts",
      agentRunner: async (req) => ({
        ...completed(req, '"value"'),
        outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const },
      }),
    });
    // `returnVia: "tool"` is redundant and ignored with a notice for one release; a shaped
    // call may now declare transport `attempts`, and `validate` beside a schema.
    await runtime.dsl.agent("work", { output: { type: "string" } } as never);
    await runtime.dsl.agent("work", { output: { type: "string" }, attempts: 2 } as never);
    await runtime.dsl.agent("work", { schema: { type: "string" }, validate: () => [] } as never);
    assert.equal(calls, 0);
  });
  it("runtime sends the output contract and accepts only a successful receipt, preserving exact value", async () =>
    temporary(async (root) => {
      const id = "accepted-output";
      const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
      const runtime = createWorkflowRuntime({
        runId: id,
        artifactPorts: store,
        agentRunner: async (req) => {
          assert.equal(req.returnContract?.singleLine, true);
          // These bytes are the replay key of every recorded string tool-return call.
          // These bytes are the replay key of every recorded string tool-return call under
          // contract v2: no default maxLength at all, and a stated clarification allowance.
          assert.equal(JSON.stringify(req.returnContract), '{"version":2,"singleLine":true,"maxAttempts":2}');
          assert.ok(req.prompt.endsWith("Finish the turn normally after acceptance."));
          assert.ok(!req.prompt.includes("pass the JSON value itself"));
          return {
            ...completed(req, '"orders"'),
            outputAcceptance: { source: "tool", attempts: 2, toolName: "workflow_return" },
          };
        },
      });
      const value = await runtime.dsl.agent("Extract ID", {
        label: "id",
        output: { type: "string", singleLine: true },
      });
      assert.equal(value, "orders");
      assert.equal(runtime.getJournal().filter((line) => line.kind === "agent_start").length, 1);
      const canonical = store.list().filter((record) => record.kind === "answer");
      assert.ok(
        store
          .list()
          .some(
            (record) =>
              store
                .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
                .toString() === '"orders"',
          ),
        `accepted bytes missing: ${JSON.stringify(canonical)}`,
      );
      assert.equal(runtime.getJournal().find((line) => line.kind === "agent_end")?.outputAcceptance?.attempts, 2);
      const incompatible = createWorkflowRuntime({
        runId: "bad-boundary",
        agentRunner: async (req) => completed(req, '"orders"'),
      });
      await assert.rejects(
        incompatible.dsl.agent("Extract", { output: { type: "string" } }),
        /acceptance|receipt|output/iu,
      );
    }));
  it("runtime returns the validated record and handoff list from a tool receipt and refuses off-shape canonical bytes", async () => {
    const shaped = createWorkflowRuntime({
      runId: "shaped-tool",
      agentRunner: async (req) => {
        assert.deepEqual(req.returnContract?.schema, RESULT);
        assert.match(req.prompt, /pass the JSON value itself/u);
        return {
          ...completed(req, JSON.stringify(RECORD)),
          outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
        };
      },
    });
    assert.deepEqual(await shaped.dsl.agent("Verify", { label: "verify", schema: RESULT }), RECORD);
    const end = shaped.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.outputAcceptance?.attempts, 1);
    assert.equal(end?.schemaValidation?.status, "valid");
    const listed = createWorkflowRuntime({
      runId: "handoff-tool",
      agentRunner: async (req) => {
        assert.deepEqual(req.returnContract?.schema, {
          type: "array",
          items: { type: "string", minLength: 1, nonBlank: true },
          minItems: 0,
          maxItems: 3,
        });
        assert.match(req.prompt, /workflow_return/u);
        return {
          ...completed(req, '["a","b"]'),
          outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
        };
      },
    });
    assert.deepEqual(await listed.dsl.agent("Discover", { label: "discover", handoffs: { maxItems: 3 } }), ["a", "b"]);
    const offShape = createWorkflowRuntime({
      runId: "off-shape-tool",
      // Four items against a declared maxItems of three: the AUTHOR's contract, not a
      // runtime policy. Two identical strings would now be accepted.
      agentRunner: async (req) => ({
        ...completed(req, '["a","b","c","d"]'),
        outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
      }),
    });
    await assert.rejects(
      offShape.dsl.agent("Discover", { label: "discover", handoffs: { maxItems: 3 } }),
      (error: unknown) => error instanceof Error && error.name === "SchemaValidationError",
    );
    const unreceipted = createWorkflowRuntime({
      runId: "no-receipt-tool",
      agentRunner: async (req) => completed(req, JSON.stringify(RECORD)),
    });
    await assert.rejects(
      unreceipted.dsl.agent("Verify", { label: "verify", schema: RESULT }),
      /acceptance|receipt|output/iu,
    );
  });
});
