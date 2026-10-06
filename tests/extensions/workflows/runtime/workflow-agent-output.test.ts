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
  SchemaValidationError,
  WorkflowAgentExecutionError,
  type AgentAttemptOutcome,
  type WorkflowAgentAnyOptions,
  type WorkflowAgentChoiceOptions,
} from "../../../../extensions/workflows/runtime/workflow-agent-contract.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-journal-format.js";

/**
 * The result-mode owner on its own, without the DSL around it.
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

/** Every removed shaped-result option, with the start of its named refusal. */
const REMOVED_DECLARATIONS: Array<[string, WorkflowAgentAnyOptions, RegExp]> = [
  ["handoffs", { handoffs: {} } as WorkflowAgentAnyOptions, /agent handoffs was removed: .*items\(\).*choice/u],
  ["output", { output: { type: "string" } } as WorkflowAgentAnyOptions, /agent output was removed/u],
  ["returnVia", { returnVia: "tool" } as WorkflowAgentAnyOptions, /agent returnVia was removed/u],
  ["maxAnswerChars", { maxAnswerChars: 400 } as WorkflowAgentAnyOptions, /agent maxAnswerChars was removed/u],
  ["schemaMaxLength", { schemaMaxLength: 400 } as WorkflowAgentAnyOptions, /agent schemaMaxLength was removed/u],
];

/**
 * The same removed keys, declared with an explicit `undefined` value — what a spread such as
 * `{ ...legacy, schema: undefined }` produces. A declaration is the key, so each one is
 * still refused by name rather than silently becoming a plain call.
 */
const REMOVED_KEYS_DECLARED_UNDEFINED: Array<[string, WorkflowAgentAnyOptions, RegExp]> = REMOVED_DECLARATIONS.map(
  ([name, , message]) => [name, { label: "legacy", [name]: undefined } as WorkflowAgentAnyOptions, message],
);

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

  it("routes a choice to the choice path", () => {
    const { owner } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape({ choice: ["accept", "revise"], choiceFallback: "revise" })).toBe("choice");
  });

  it.each(REMOVED_DECLARATIONS)("refuses a removed %s declaration by name", (_name, opts, message) => {
    const { owner } = outputOwner(neverRuns);
    expect(() => owner.dispatchWorkflowAgentShape(opts)).toThrow(message);
  });

  it.each(REMOVED_KEYS_DECLARED_UNDEFINED)(
    "refuses a removed %s key declared with an undefined value",
    (_name, opts, message) => {
      const { owner } = outputOwner(neverRuns);
      expect(() => owner.dispatchWorkflowAgentShape(opts)).toThrow(message);
    },
  );

  it.each<[WorkflowAgentAnyOptions, string]>([
    [{ result: "summary" } as WorkflowAgentAnyOptions, "agent result must be report when supplied"],
    [
      { result: "report", choice: ["a", "b"] } as WorkflowAgentAnyOptions,
      "agent result: report cannot be combined with choice",
    ],
    [{ choiceFallback: "accept" } as WorkflowAgentAnyOptions, "agent choiceFallback requires choice"],
  ])("refuses %o at dispatch", (opts, message) => {
    const { owner } = outputOwner(neverRuns);
    expect(() => owner.dispatchWorkflowAgentShape(opts)).toThrow(message);
  });
});

describe("workflow agent output — choice declarations", () => {
  it.each<[unknown, string]>([
    ["accept", "agent choice must be an array of strings"],
    [["only"], "agent choice must contain at least 2 values"],
    [["a", " "], "agent choice value at index 1 must be a non-empty string"],
    [["a", "a"], 'agent choice contains duplicate value "a"'],
  ])("refuses choice %o before the child starts", async (choice, message) => {
    const { owner } = outputOwner(neverRuns);
    await expect(owner.runChoiceAgent("decide", { choice } as unknown as WorkflowAgentChoiceOptions)).rejects.toThrow(
      message,
    );
  });

  it("refuses a fallback outside the declared choices", async () => {
    const { owner } = outputOwner(neverRuns);
    await expect(
      owner.runChoiceAgent("decide", { choice: ["a", "b"], choiceFallback: "c" } as WorkflowAgentChoiceOptions),
    ).rejects.toThrow("agent choiceFallback must be one of the declared choices");
  });
});

describe("workflow agent output — acceptance comes from the receipt", () => {
  it("returns the choice the confirmed receipt carried, not the child's final text", async () => {
    const { owner } = outputOwner(async () => accepted("accept", '"revise"'));
    await expect(owner.runChoiceAgent("decide", { choice: ["accept", "revise"] })).resolves.toBe("accept");
  });

  it("fails closed when the call carries no verdict at all", async () => {
    // An answer that never reached `workflow_return` leaves `schemaCheck` unset. There is
    // nothing to parse it out of the text with, and nothing here tries.
    const { owner } = outputOwner(async () => ({ text: '"accept"', callId: "call-0001", replayed: false }));
    await expect(owner.runChoiceAgent("decide", { choice: ["accept", "revise"] })).rejects.toThrow(
      new SchemaValidationError(["missing output validation"], 1),
    );
  });

  it("refuses a receipt whose value is not a string", async () => {
    const { owner } = outputOwner(async () => accepted(["accept"]));
    await expect(owner.runChoiceAgent("decide", { choice: ["accept", "revise"] })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it("journals the choice decision from the accepted value and the receipt's attempts", async () => {
    const { owner, journal } = outputOwner(async () => accepted("revise"));
    await expect(owner.runChoiceAgent("decide", { choice: ["accept", "revise"], label: "gate" })).resolves.toBe(
      "revise",
    );
    const decision = journal.find((line) => line.message === "[workflow:choice]");
    expect(decision?.choiceDecision).toEqual({ value: "revise", source: "validated", returnVia: "tool", attempts: 1 });
    expect(decision?.label).toBe("gate");
    expect(decision?.callId).toBe("call-0001");
    expect(journal[0]?.message).toBe(
      "[workflow:return] gate: contract v3, 1 same-session clarification turn(s) (package default 1)",
    );
  });

  it("spends the declared fallback only when the package correction is exhausted", async () => {
    const exhausted = new WorkflowAgentExecutionError({
      ok: false,
      status: "failed",
      failureCause: "output-contract-exhausted",
      summary: "Output contract exhausted after 2 attempts",
      diagnostics: [],
    });
    const { owner, journal } = outputOwner(async () => {
      throw exhausted;
    });
    await expect(
      owner.runChoiceAgent("decide", { choice: ["accept", "revise"], choiceFallback: "revise", label: "gate" }),
    ).resolves.toBe("revise");
    expect(journal.find((line) => line.message === "[workflow:choice]")?.choiceDecision).toEqual({
      value: "revise",
      source: "fallback",
      returnVia: "tool",
      attempts: 2,
      reason: "output-contract-exhausted",
    });
  });
});

/**
 * The same owner reached through `dsl.agent()`, where an author actually meets it: every
 * removed declaration is refused before any child starts, and the accepted choice travels
 * from the child's receipt to the author and to the persisted canonical bytes. Fake child
 * sessions, not live Pi/model proof.
 */
describe("workflow agent output — through the DSL", () => {
  it("removed shaped-result declarations fail before the runner is invoked", async () => {
    let calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "removed-contracts",
      agentRunner: async (req) => {
        calls += 1;
        return completed(req, '"value"');
      },
    });
    for (const [, options, message] of REMOVED_DECLARATIONS)
      await assert.rejects(runtime.dsl.agent("work", options as never), message);
    assert.equal(calls, 0);
    assert.equal(runtime.getJournal().filter((line) => line.kind === "agent_start").length, 0);
  });

  it("removed keys declared with an undefined value fail before the runner is invoked", async () => {
    let calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "removed-undefined-contracts",
      agentRunner: async (req) => {
        calls += 1;
        return completed(req, "plain text");
      },
    });
    for (const [, options, message] of REMOVED_KEYS_DECLARED_UNDEFINED)
      await assert.rejects(runtime.dsl.agent("work", options as never), message);
    assert.equal(calls, 0);
    assert.equal(runtime.getJournal().filter((line) => line.kind === "agent_start").length, 0);
  });

  it("a plain call carries no return contract and returns the exact text", async () => {
    const runtime = createWorkflowRuntime({
      runId: "plain-text",
      agentRunner: async (req) => {
        assert.equal(req.returnContract, undefined);
        assert.equal(req.prompt, "Write scope/scope.md, then summarize it.");
        return completed(req, "Wrote scope/scope.md with 3 files.\n");
      },
    });
    assert.equal(
      await runtime.dsl.agent("Write scope/scope.md, then summarize it.", { label: "collect-scope" }),
      "Wrote scope/scope.md with 3 files.\n",
    );
  });

  it("runtime sends the choice-only contract and accepts only a successful receipt, preserving exact value", async () =>
    temporary(async (root) => {
      const id = "accepted-choice";
      const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
      const runtime = createWorkflowRuntime({
        runId: id,
        artifactPorts: store,
        agentRunner: async (req) => {
          // These bytes are the replay key of every recorded choice under contract v3.
          assert.equal(
            JSON.stringify(req.returnContract),
            '{"version":3,"choices":["accept","revise"],"maxAttempts":2}',
          );
          assert.ok(req.prompt.startsWith("Choose the next action.\n\nReturn your choice using workflow_return"));
          assert.ok(req.prompt.endsWith("Finish the turn normally after acceptance."));
          return {
            ...completed(req, '"revise"'),
            outputAcceptance: { source: "tool", attempts: 2, toolName: "workflow_return" },
          };
        },
      });
      const value = await runtime.dsl.agent("Choose the next action.", {
        label: "route",
        choice: ["accept", "revise"],
      });
      assert.equal(value, "revise");
      assert.equal(runtime.getJournal().filter((line) => line.kind === "agent_start").length, 1);
      assert.ok(
        store
          .list()
          .some(
            (record) =>
              store
                .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
                .toString() === '"revise"',
          ),
        "accepted bytes missing",
      );
      const end = runtime.getJournal().find((line) => line.kind === "agent_end");
      assert.equal(end?.outputAcceptance?.attempts, 2);
      assert.equal(end?.schemaValidation?.status, "valid");
      const incompatible = createWorkflowRuntime({
        runId: "bad-boundary",
        agentRunner: async (req) => completed(req, '"accept"'),
      });
      await assert.rejects(
        incompatible.dsl.agent("Choose", { label: "route", choice: ["accept", "revise"] }),
        /acceptance|receipt|choice result/iu,
      );
    }));

  it("refuses an accepted receipt that is not one of the declared choices", async () => {
    const runtime = createWorkflowRuntime({
      runId: "off-contract-receipt",
      agentRunner: async (req) => ({
        ...completed(req, '["accept"]'),
        outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
      }),
    });
    await assert.rejects(
      runtime.dsl.agent("Choose", { label: "route", choice: ["accept", "revise"] }),
      (error: unknown) => error instanceof Error && error.name === "SchemaValidationError",
    );
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.schemaValidation?.status, "mismatch");
  });
});
