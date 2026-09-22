import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentSchemaOptions,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { scriptedRuntime } from "../../../fixtures/scripted-agent-runtime.js";

/**
 * `validate` — the script-supplied half of the answer contract.
 *
 * A declared schema says what one node must look like. Referential integrity,
 * agreement between fields, a budget summed across items and the shape of a graph
 * are joins over the whole answer, and until this option existed they were checked
 * by ordinary script code after the await, where the only available verdict was a
 * `throw` that ended the run. It now runs inside the child's OWN session, beside the
 * schema check, so a violation is a clarification the child can answer rather than a
 * fresh child that remembers nothing. Every case here asks the same question from a
 * different side: does a violation reach the child that produced it, and does
 * everything else still fail closed?
 *
 * The never-retryable pin required by the doctrine — host-owned provenance,
 * continuation identity and prior-run text still ending the run without a re-ask —
 * lives with the fixtures that can express it, in
 * `tests/extensions/workflows/review-workflow.test.ts` and
 * `review-remediation-workflows.test.ts`.
 */

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "dependsOn"],
        properties: {
          id: { type: "string", pattern: "^U[1-9][0-9]*$" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** The cross-field rule the schema cannot say: every edge names a declared unit. */
function unknownDependencyErrors(value: unknown): string[] {
  const units = (value as { units: Array<{ id: string; dependsOn: string[] }> }).units;
  const declared = new Set(units.map((unit) => unit.id));
  return units.flatMap((unit, index) =>
    unit.dependsOn.flatMap((dependency, edge) =>
      declared.has(dependency)
        ? []
        : [`units[${index}].dependsOn[${edge}]: value ${JSON.stringify(dependency)} is not a declared unit id`],
    ),
  );
}

/** Call the shaped overload with an untyped option bag — workflow scripts are `.mjs`. */
function shaped(dsl: { agent: unknown }, prompt: string, opts: unknown): Promise<unknown> {
  return (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)(prompt, opts);
}

describe("agent({ schema, validate }) script validation", () => {
  it("reaches the acceptance boundary with EVERY validator error, in one child", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-reject", [
      '{"units":[{"id":"U1","dependsOn":["U7","U8"]}]}',
    ]);

    const failure = await dsl
      .agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SchemaValidationError);
    // Accumulating, not fail-fast, and never truncated: reporting one violation of
    // several turns a repairable answer into a fatal one.
    const reported = (failure as Error).message;
    expect(reported).toContain('units[0].dependsOn[0]: value "U7" is not a declared unit id');
    expect(reported).toContain('units[0].dependsOn[1]: value "U8" is not a declared unit id');
    expect(requests).toHaveLength(1);
    expect(getJournal().flatMap((line) => (line.kind === "agent_end" ? [line.schemaValidation] : []))).toEqual([
      {
        status: "mismatch",
        attempts: 1,
        source: "script",
        errors: [
          'units[0].dependsOn[0]: value "U7" is not a declared unit id',
          'units[0].dependsOn[1]: value "U8" is not a declared unit id',
        ],
      },
    ]);
  });

  it("accepts the value the validator passes", async () => {
    const { dsl, requests } = scriptedRuntime("agent-validate-accept", ['{"units":[{"id":"U1","dependsOn":[]}]}']);
    await expect(
      dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors }),
    ).resolves.toEqual({ units: [{ id: "U1", dependsOn: [] }] });
    expect(requests).toHaveLength(1);
  });

  it("names the SCHEMA as the rejecting authority when the shape is what broke", async () => {
    const { dsl, getJournal } = scriptedRuntime("agent-validate-schema-authority", [
      '{"units":[{"id":"nope","dependsOn":[]}]}',
    ]);

    await expect(
      dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    // Never merged with script errors: schema errors carry 0-indexed JSON paths and
    // observed values, and one merged list would hand the reader two index bases.
    expect(getJournal().flatMap((line) => (line.kind === "agent_end" ? [line.schemaValidation?.source] : []))).toEqual([
      "schema",
    ]);
  });

  it("keeps a schema-only call out of the source discriminator", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-absent", [
      '{"units":[{"id":"nope","dependsOn":[]}]}',
    ]);

    await expect(dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA } })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    expect(requests).toHaveLength(1);
    expect(getJournal().every((line) => line.kind !== "agent_end" || line.schemaValidation?.source === undefined)).toBe(
      true,
    );
  });

  it("ends the run without spending a retry when the validator throws, and journals the author error", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-throws", ['{"units":[]}']);

    await expect(
      dsl.agent("Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        label: "plan",
        validate: () => {
          throw new Error("author bug: cannot read properties of undefined");
        },
      }),
    ).rejects.toThrow("author bug: cannot read properties of undefined");

    // A bug in author code is not a model failure and must not be laundered into a
    // repair loop that blames the model for an exception it cannot fix.
    expect(requests).toHaveLength(1);
    const errors = getJournal().filter((line) => line.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: "script",
      label: "plan",
      message: "author bug: cannot read properties of undefined",
    });
    // The attempt really ran, so it must not leave an agent_start with no record.
    expect(getJournal().filter((line) => line.kind === "agent_end")).toHaveLength(0);
  });

  it("keeps a spent transport attempt readable when the validator then throws", async () => {
    // The same hiding hazard as a thrown transport failure, one layer further in: the
    // attempt that ended the run has no `agent_end`, so its `error` line is the only record
    // that a second child ran at all. Without the attempt trio on it, a reader sees one
    // discarded attempt with no bound and no logical call — ungroupable, and the report
    // drops the whole retry.
    const requests: WorkflowAgentRequest[] = [];
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "agent-validate-throws-after-retry",
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            ok: false,
            status: "failed",
            failureCause: "host-turn-timeout",
            summary: "Child agent turn exceeded its budget and was aborted.",
            diagnostics: [],
            agent: request.agent,
          };
        }
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: '{"units":[]}',
          diagnostics: [],
          agent: request.agent,
          outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const },
        };
      },
    });

    await expect(
      shaped(dsl, "Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        label: "plan",
        readOnly: true,
        // A shaped call may now declare transport retries: a same-session clarification is
        // not a physical child, so the two no longer multiply into attempts x schema budget.
        attempts: 2,
        validate: () => {
          throw new Error("author bug: cannot read properties of undefined");
        },
      }),
    ).rejects.toThrow("author bug: cannot read properties of undefined");

    expect(requests).toHaveLength(2);
    const journal = getJournal();
    const ends = journal.filter((line) => line.kind === "agent_end");
    const errors = journal.filter((line) => line.kind === "error");
    expect(ends.map((line) => [line.callId, line.attempt, line.attempts])).toEqual([["call-0001", 1, 2]]);
    expect(errors.map((line) => [line.callId, line.attempt, line.attempts])).toEqual([["call-0002", 2, 2]]);
    expect(errors[0]?.logicalCallId).toBe(ends[0]?.logicalCallId);
    expect(errors[0]?.logicalCallId).toBeDefined();
  });

  it.each([
    ["a non-array return", () => "nope" as unknown as string[], "agent validate must return an array of strings"],
    ["a non-string element", () => [1] as unknown as string[], "agent validate must return an array of strings"],
    [
      "a Promise",
      () => Promise.resolve([]) as unknown as string[],
      "agent validate must return an array of strings, not a Promise",
    ],
    ["an empty-string error", () => ["ok", ""], "agent validate error at index 1 must be a non-empty string"],
  ])("refuses %s instead of truncating or coercing it", async (_case, validate, message) => {
    const { dsl, requests } = scriptedRuntime("agent-validate-return-contract", ['{"units":[]}']);

    await expect(dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate })).rejects.toThrow(message);
    // A run error, never a validation mismatch: truncating would silently rewrite
    // the replay key, and retrying would spend a child on an author bug.
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["a parse failure", "not json at all"],
    ["a schema failure", '{"units":[{"id":"nope","dependsOn":[]}]}'],
  ])("never runs the validator on %s", async (_case, answer) => {
    let validatorCalls = 0;
    const { dsl } = scriptedRuntime(`agent-validate-gated-${_case.replace(/\s/gu, "-")}`, [answer]);

    await expect(
      dsl.agent("Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        validate: () => {
          validatorCalls += 1;
          return [];
        },
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    // Cross-field rules presuppose the shape holds; an off-shape answer would crash
    // author code that destructures it.
    expect(validatorCalls).toBe(0);
  });

  it("never runs the validator on an empty answer", async () => {
    let validatorCalls = 0;
    const { dsl } = scriptedRuntime("agent-validate-ungated-empty", ["   "]);

    await expect(
      shaped(dsl, "Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        validate: () => {
          validatorCalls += 1;
          return [];
        },
      }),
    ).rejects.toThrow(/Agent result text is empty/u);
    expect(validatorCalls).toBe(0);
  });

  it("accepts an arbitrarily long list of validator errors: a violation list has no budget", async () => {
    const many = Array.from({ length: 120 }, (_, index) => `e${String(index)}: ${"detail ".repeat(200)}`.trim());
    const { dsl } = scriptedRuntime("agent-validate-many-errors", ['{"units":[]}']);

    const failure = await dsl
      .agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: () => many })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SchemaValidationError);
    // Every one of them, verbatim: a truncated list hides a violation the child is
    // being asked to fix, and a refusal over the COUNT of real violations was a size
    // policy over the validator's findings.
    expect((failure as SchemaValidationError).errors).toHaveLength(120);
    expect((failure as Error).message).toContain(many[119]!);
  });

  it.each([
    [{ validate: () => [] }, "agent validate requires a schema or handoffs"],
    [{ schema: { ...PLAN_SCHEMA }, validate: "not-a-function" }, "agent validate must be a function"],
  ])("refuses a malformed validate declaration before any child runs", async (opts, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-validate-declaration-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(shaped(dsl, "Plan the units.", opts)).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("refuses a nested agent() call from inside the validator", async () => {
    // The validator runs between the child answer and agent_end, before artifact
    // recording and replay journaling, so a nested child call has no defined
    // position in either sequence.
    const { dsl, requests } = scriptedRuntime("agent-validate-reentrant", ['{"units":[]}']);
    let nested: Promise<unknown> | undefined;

    await expect(
      dsl.agent("Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        validate: () => {
          nested = dsl.agent("second opinion");
          return [];
        },
      }),
    ).resolves.toEqual({ units: [] });

    await expect(nested).rejects.toThrow("agent() must not be called from inside a validate callback");
    // The latch is released afterwards, so an ordinary later call still works.
    expect(requests).toHaveLength(1);
    await expect(dsl.agent("later")).resolves.toBe('{"units":[]}');
  });

  it("keeps the validator out of the recorded request so old recordings still replay", async () => {
    // `canonicalAgentRequest` is a JSON.stringify of a fixed field literal, and
    // JSON.stringify drops functions silently — putting `validate` in the key would
    // produce an identical key for two different validators with no divergence
    // signal. It is deliberately absent instead, and its verdict is re-applied to
    // every replayed answer (workflow-replay.test.ts).
    const plain = scriptedRuntime("agent-validate-key-a", ['{"units":[]}']);
    await plain.dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA } });
    const validating = scriptedRuntime("agent-validate-key-b", ['{"units":[]}']);
    await validating.dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors });

    // The callback travels beside the request as `returnValidate` so the acceptance tool
    // can apply it in-session; `canonicalAgentRequest` is an explicit field list that
    // omits it, and the PROMPT and contract — everything a key is built from — match.
    expect({ ...validating.requests[0], returnValidate: undefined }).toEqual({
      ...plain.requests[0],
      returnValidate: undefined,
    });
    expect(validating.requests[0]?.returnValidate).toBeTypeOf("function");
  });

  it("types the validator on the shaped options the Omit widening restores", () => {
    // Without widening `Omit<WorkflowAgentOptions, "schema" | "validate">`, the
    // inherited `never` on the text options would make the feature untypeable. The
    // matching negative pin lives in workflow-agent-schema.test.ts.
    const shapedOptions: WorkflowAgentSchemaOptions = { schema: { type: "string" }, validate: () => [] };
    expect(shapedOptions.validate).toBeTypeOf("function");
  });
});
