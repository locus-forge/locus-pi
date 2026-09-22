import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  WorkflowOutputCapabilityError,
  createWorkflowRuntime,
  type WorkflowAgentHandoffOptions,
  type WorkflowAgentOptions,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { scriptedRuntime } from "../../../fixtures/scripted-agent-runtime.js";

describe("agent({ handoffs }) dynamic decomposition", () => {
  it("passes a complete narrative report without a shaped return or format retry", async () => {
    const report = "r".repeat(37_000);
    const { dsl, requests } = scriptedRuntime("agent-plain-report", [report]);
    await expect(dsl.agent("Review the accepted change.", { label: "review" })).resolves.toBe(report);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("Review the accepted change.");
    expect(requests[0]?.returnContract).toBeUndefined();
  });

  it("accepts one 8113-character handoff item: length is not a contract", async () => {
    // 8113 is the incident length: one character past the deleted 8000 default, which
    // truncated a real discovery queue by refusing the unit that had already been found.
    const item = `DAG ID: daily-sales\n${"detail line\n".repeat(700)}`.slice(0, 8_113);
    expect(item).toHaveLength(8_113);
    const { dsl, requests } = scriptedRuntime("agent-handoffs-8113", [JSON.stringify([item, "DAG ID: weekly"])]);

    await expect(dsl.agent("Discover every DAG.", { label: "discover", handoffs: {} })).resolves.toEqual([
      item,
      "DAG ID: weekly",
    ]);
    expect(requests).toHaveLength(1);
    // No invented per-item ceiling reaches the child's contract.
    expect(JSON.stringify(requests[0]?.returnContract)).not.toContain("maxLength");
  });

  it("accepts more than a hundred items when the author declared no maxItems", async () => {
    const items = Array.from({ length: 137 }, (_, index) => `work unit ${String(index)}`);
    const { dsl, requests } = scriptedRuntime("agent-handoffs-137", [JSON.stringify(items)]);

    await expect(dsl.agent("Discover units.", { handoffs: { minItems: 1 } })).resolves.toEqual(items);
    expect(requests[0]?.returnContract?.schema).toEqual({
      type: "array",
      items: { type: "string", minLength: 1, nonBlank: true },
      minItems: 1,
    });
  });

  it("keeps the author's own maxItems as a real consumer contract", async () => {
    const { dsl } = scriptedRuntime("agent-handoffs-declared-max", ['["a","b","c"]']);
    await expect(dsl.agent("Discover.", { handoffs: { maxItems: 2 } })).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("accepts two items that are identical after trimming", async () => {
    // Same text is not proof of the same work; the runtime no longer deduplicates for the author.
    const { dsl } = scriptedRuntime("agent-handoffs-trim-dupes", ['["DAG A", " DAG A "]']);
    await expect(dsl.agent("Discover.", { handoffs: {} })).resolves.toEqual(["DAG A", " DAG A "]);
  });

  it("still refuses a blank item: an empty string is not a work unit", async () => {
    const { dsl } = scriptedRuntime("agent-handoffs-blank", ['["   "]']);
    await expect(dsl.agent("Discover.", { handoffs: {} })).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("allows an empty discovery when minItems is omitted", async () => {
    const { dsl } = scriptedRuntime("agent-handoffs-empty", ["[]"]);
    await expect(dsl.agent("Discover units.", { handoffs: {} })).resolves.toEqual([]);
  });

  it("desugars to the byte-identical request used by the equivalent array schema", async () => {
    const handoffs = scriptedRuntime("agent-handoffs-equivalence", ['["DAG A"]']);
    const schema = scriptedRuntime("agent-schema-equivalence", ['["DAG A"]']);

    await handoffs.dsl.agent("Discover.", { handoffs: { minItems: 1, maxItems: 8 }, label: "discover" });
    await schema.dsl.agent("Discover.", {
      schema: {
        type: "array",
        items: { type: "string", minLength: 1, nonBlank: true },
        minItems: 1,
        maxItems: 8,
      },
      label: "discover",
    });

    expect(handoffs.requests).toEqual(schema.requests);
  });

  it.each([
    [{ handoffs: [] }, /agent handoffs must be an object/u],
    [{ handoffs: { minItems: -1, maxItems: 8 } }, /minItems must be a non-negative safe integer/u],
    [{ handoffs: { minItems: 9, maxItems: 8 } }, /minItems cannot exceed maxItems/u],
    [{ handoffs: { maxItems: 0 } }, /maxItems must be a positive safe integer when declared/u],
    [{ handoffs: { maxItems: 8, maxItemChars: 4_000 } }, /maxItemChars was removed/u],
    [{ handoffs: { maxItems: 8, maxChars: 10 } }, /agent handoffs has no option maxChars/u],
    [{ handoffs: { maxItems: 8 }, schema: { type: "array" } }, /cannot be combined with schema/u],
    [{ handoffs: { maxItems: 8 }, choice: ["a", "b"] }, /choice cannot be combined with handoffs/u],
    [{ handoffs: { maxItems: 8 }, maxAnswerChars: 10 }, /maxAnswerChars was removed/u],
  ])("rejects malformed declaration %# before any child runs", async (opts, error) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-handoffs-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect((dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("Discover.", opts)).rejects.toThrow(
      error,
    );
    expect(calls).toBe(0);
  });

  it("keeps handoffs out of exact-text option types", () => {
    const handoffOptions: WorkflowAgentHandoffOptions = { handoffs: { maxItems: 8 } };
    expect(handoffOptions.handoffs).toEqual({ maxItems: 8 });

    // @ts-expect-error handoffs selects WorkflowAgentHandoffOptions, never WorkflowAgentOptions
    const invalidTextOptions: WorkflowAgentOptions = { handoffs: { maxItems: 8 } };
    expect(invalidTextOptions).toBeDefined();
  });
});

describe("shaped returns on a transport that cannot carry them", () => {
  /** Exactly what a text-only host produces: a completed child with no tool receipt. */
  function textOnlyRuntime(runId: string) {
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: '["DAG A"]', diagnostics: [] };
      },
    });
    return { ...runtime, requests };
  }

  it("refuses by capability instead of falling back to parsing the final text", async () => {
    const { dsl } = textOnlyRuntime("agent-handoffs-no-tool");
    const failure = await dsl
      .agent("Discover.", { label: "discover", handoffs: {} })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowOutputCapabilityError);
    expect((failure as Error).message).toMatch(/Transport cannot carry a shaped result/u);
    expect((failure as Error).message).toMatch(/no text fallback/u);
    // The would-be parse target was right there and was NOT used.
    expect((failure as Error).message).not.toContain("DAG A");
  });

  it("still returns the exact full text for a plain call on the same transport", async () => {
    const { dsl } = textOnlyRuntime("agent-plain-no-tool");
    await expect(dsl.agent("Review.")).resolves.toBe('["DAG A"]');
  });
});

describe("large shaped values", () => {
  function toolRuntime(runId: string, answers: string[]) {
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: answers[requests.length - 1] ?? answers.at(-1) ?? "",
          diagnostics: [],
          outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
        };
      },
    });
    return { ...runtime, requests };
  }

  it("accepts a schema output well past 100000 characters", async () => {
    const finding = "The parser drops the trailing separator. ".repeat(3_000);
    const value = { findings: [finding, finding] };
    const serialized = JSON.stringify(value);
    expect(serialized.length).toBeGreaterThan(100_000);

    const { dsl, requests } = toolRuntime("agent-schema-large", [serialized]);
    await expect(
      dsl.agent("Report every finding in full.", {
        label: "review",
        schema: { type: "object", properties: { findings: { type: "array", items: { type: "string" } } } },
      }),
    ).resolves.toEqual(value);
    expect(requests[0]?.returnContract?.maxLength).toBeUndefined();
  });

  it("accepts one discovered work unit beyond 500k characters", async () => {
    const workUnit = "Migrate this source section\n".repeat(20_000);
    expect(workUnit.length).toBeGreaterThan(500_000);
    const { dsl, requests } = toolRuntime("agent-handoffs-large-unit", [JSON.stringify([workUnit])]);

    await expect(dsl.agent("Discover the migration work units.", { label: "discover", handoffs: {} })).resolves.toEqual(
      [workUnit],
    );
    expect(requests).toHaveLength(1);
  });

  it("keeps an author-declared output.maxLength as a real consumer contract", async () => {
    const { dsl } = toolRuntime("agent-output-maxlength", [JSON.stringify("a".repeat(90))]);
    await expect(
      dsl.agent("One-line heading.", { label: "title", output: { type: "string", maxLength: 80 } }),
    ).rejects.toThrow(/exceeds the declared maxLength of 80/u);
  });

  it("keeps a string output contract out of the shaped handoff options", () => {
    const bad: WorkflowAgentHandoffOptions = {
      handoffs: { maxItems: 2 },
      // @ts-expect-error output is a string-only contract; a handoff return carries its shape in handoffs
      output: { type: "string" },
    };
    expect(bad.handoffs).toEqual({ maxItems: 2 });
  });
});
