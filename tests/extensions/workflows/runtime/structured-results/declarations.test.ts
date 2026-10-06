import { describe, expect, it } from "vitest";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowAgentOutput } from "../../../../../extensions/workflows/runtime/workflow-agent-output.js";
import type {
  WorkflowAgentAnyOptions,
  WorkflowAgentStructuredOptions,
} from "../../../../../extensions/workflows/runtime/workflow-agent-contract.js";

function declaration(options: unknown) {
  let calls = 0;
  const output = createWorkflowAgentOutput({
    runId: "structured-declaration",
    now: () => "2026-10-06T00:00:00.000Z",
    emit: () => {},
    currentPhase: () => undefined,
    branchContext: () => undefined,
    activeGroupFields: () => ({}),
    runAgentAttempt: async () => {
      calls++;
      throw new Error("child must not start");
    },
  });
  const runtime = createWorkflowRuntime({
    runId: "structured-declaration",
    agentRunner: async () => {
      calls++;
      throw new Error("child must not start");
    },
  });
  return {
    dispatch: () => output.dispatchWorkflowAgentShape(options as WorkflowAgentAnyOptions),
    run: () => runtime.dsl.agent("Return data", options as WorkflowAgentStructuredOptions),
    calls: () => calls,
    journal: runtime.getJournal,
  };
}

describe("structured runtime declaration before child admission", () => {
  it.each(["null", "boolean", "string", "number", "integer", "array", "object"])(
    "selects the opt-in path for a %s root without starting a child",
    (type) => {
      const test = declaration({ schema: { type, ...(type === "array" ? { items: { type: "null" } } : {}) } });
      expect(test.dispatch()).toBe("structured");
      expect(test.calls()).toBe(0);
    },
  );
  it.each([{ validate: () => [] }, { repair: { maxAttempts: 2 } }])("refuses removed options %j", async (options) => {
    const test = declaration(options);
    await expect(test.run()).rejects.toThrow(/was removed/);
    expect(test.journal()).toEqual([]);
    expect(test.calls()).toBe(0);
  });
  it.each([
    { schema: { type: ["string", "null"] } },
    { schema: { type: "string", pattern: "a" } },
    { schema: { type: "number", minLength: 1 } },
    { schema: { type: "object", required: ["missing"] } },
    { schema: { type: "object", properties: null } },
    { schema: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 1 } },
  ])("names unsupported schema before spending a child: %j", async (options) => {
    const test = declaration(options);
    await expect(test.run()).rejects.toThrow(/unsupported-schema/);
    expect(test.journal()).toEqual([]);
    expect(test.calls()).toBe(0);
  });
  it.each([
    { choice: ["a", "b"] },
    { choiceFallback: "a" },
    { result: "report" },
    { repair: { maxAttempts: 0 } },
    { repair: { maxAttempts: 1.5 } },
    { repair: { maxAttempts: 2, alias: true } },
    { validate: "model reported valid" },
  ])("refuses incompatible or malformed declarations %j", async (options) => {
    const test = declaration({ schema: { type: "null" }, ...options });
    await expect(test.run()).rejects.toThrow();
    expect(test.journal()).toEqual([]);
    expect(test.calls()).toBe(0);
  });
});

it.each(["validate", "repair", "outputTransport"])(
  "refuses declared removed %s even when undefined",
  async (option) => {
    for (const extra of [{}, { schema: { type: "null" } }, { result: "report" }, { choice: ["a", "b"] }]) {
      const test = declaration({ ...extra, [option]: undefined });
      await expect(test.run()).rejects.toThrow(`agent ${option} was removed`);
      expect(test.calls()).toBe(0);
      expect(test.journal()).toEqual([]);
    }
  },
);
