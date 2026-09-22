import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/live-smoke/live-smoke.workflow.mjs");

interface AgentCall {
  prompt: string;
  options: {
    agent?: string;
    label: string;
    permissionMode: string;
    workspaceMode: string;
    readOnly: boolean;
    tools: string[];
  };
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

describe("workflow example: live-smoke.workflow.mjs", () => {
  it("uses ordinary full-tool children without capability options", async () => {
    const calls: AgentCall[] = [];
    const runWorkflow = await loadWorkflow();

    const result = await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        async agent(prompt: string, options: AgentCall["options"]) {
          calls.push({ prompt, options });
          return `${options.label} inspected the directory`;
        },
      },
      "external install",
    );

    expect(calls.map((call) => call.options.agent)).toEqual([undefined, undefined]);
    for (const call of calls) {
      expect(call.options).toMatchObject({
        workspaceMode: "project",
      });
      expect(call.options).not.toHaveProperty("tools");
      expect(call.options).not.toHaveProperty("readOnly");
      expect(call.options).not.toHaveProperty("permissionMode");
      expect(call.prompt).toContain("Use your find tool");
      expect(call.prompt).not.toContain("bash");
    }
    expect(result).toEqual({
      topic: "external install",
      ok: true,
      notes: {
        first: "list cwd entries 1 inspected the directory",
        second: "list cwd entries 2 inspected the directory",
      },
    });
  });

  it.each([undefined, " \t "])("preserves the default topic for missing or blank input", async (input) => {
    const prompts: string[] = [];
    const logs: string[] = [];
    const runWorkflow = await loadWorkflow();

    const result = await runWorkflow(
      {
        phase: () => undefined,
        log: (message: string) => logs.push(message),
        async agent(prompt: string, options: AgentCall["options"]) {
          prompts.push(prompt);
          return `${options.label} inspected the directory`;
        },
      },
      input,
    );

    expect(logs).toEqual(["Live smoke for: runtime smoke test"]);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.endsWith("Topic: runtime smoke test."))).toBe(true);
    expect(result).toMatchObject({ topic: "runtime smoke test", ok: true });
  });
});
