import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rawTurn } from "../../../../fixtures/agent-runtime/structured-sdk.js";
import { withStructuredSourceSdk } from "../../../../fixtures/agent-runtime/structured-source-sdk.js";
import { readWorkflowArtifactIndex } from "../../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { workflowReplayFile } from "../../../../../extensions/workflows/runtime/workflow-replay.js";

const docs = readFileSync("docs/workflows/source-shape.md", "utf8").split("## Checked dataflow-v1")[1]!;
const examples = [...docs.matchAll(/```js\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
const task = "Investigate authoritative evidence. Keep this complete Task: α / ticket-42.";
const plan = {
  items: [
    { id: "A", kind: "review", prompt: "Check the concrete A evidence" },
    { id: "B", kind: "context", prompt: "Supporting B context" },
  ],
};
const tool = (value: unknown) => rawTurn([JSON.stringify({ value })]);
const plain = (text: string) => {
  const item = {
    type: "message",
    id: "verifier-answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: "verifier-response", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "verifier-response", status: "completed", output: [item] } },
  ];
};
type SourceFixture = Parameters<Parameters<typeof withStructuredSourceSdk>[2]>[0];
type SourceRun = Awaited<ReturnType<SourceFixture["run"]>>;
const run = (
  index: number,
  turns: object[][],
  inspect?: (fixture: SourceFixture, first: SourceRun) => void,
  resumeInput = task,
) =>
  withStructuredSourceSdk(examples[index]!, turns, async (fixture) => {
    const first = await fixture.run({ input: task });
    inspect?.(fixture, first);
    const next = await fixture.run({ input: resumeInput, resumeFromRunId: first.runId });
    const suppliedPrompts = fixture.payloads.map((payload) => {
      const input = (payload as { input: { role?: string; content?: unknown }[] }).input;
      return JSON.stringify(input.filter((message) => message.role === "user").at(-1)?.content);
    });
    return {
      workflowRuns: [first, next],
      replayRecord: first.records,
      counters: fixture.counters,
      payloads: fixture.payloads,
      suppliedPrompts,
    };
  });

describe("verbatim documented dataflow graphs through actual Pi SDK and offline Responses", () => {
  it("checks records, preserves full task, assigns only review A and replays both typed calls", async () => {
    const result = await run(0, [tool(plan), tool({ id: "A", summary: "A evidence verified" })]);
    const [first, next] = result.workflowRuns!;
    expect(first?.ok, first?.error).toBe(true);
    expect(next?.ok, next?.error).toBe(true);
    expect(result.counters).toMatchObject({ sessions: 2, generations: 2, tools: 2, prompts: 2 });
    expect(first?.result).toBe("Reviewed 1 of 2 records; others were context.\nA: A evidence verified");
    expect(next?.result).toBe(first?.result);
    expect(next?.replay).toMatchObject({ replayedCalls: 2, freshCalls: 0 });
    expect(result.suppliedPrompts).toHaveLength(2);
    for (const prompt of result.suppliedPrompts) expect(prompt).toContain(task);
    expect(result.suppliedPrompts[1]).toContain("Review A: Check the concrete A evidence");
    expect(result.suppliedPrompts[1]).not.toContain("Supporting B context");
    expect(
      result.replayRecord
        .filter((value) => value.kind === "agent")
        .map((value) => (value.kind === "agent" ? value.node : undefined)),
    ).toEqual([expect.stringContaining("plan"), expect.stringContaining("review-item")]);
    expect(result.replayRecord.filter((value) => value.kind === "agent")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rcv: 4,
          structuredReceipt: expect.objectContaining({
            observerRevision: "codex-responses-v3",
            validation: "accepted",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(first?.journal)).toContain('"Plan"');
    expect(JSON.stringify(first?.journal)).toContain('"Review"');
    expect(first?.journal.find((line) => line.kind === "group_start")?.groupKeys).toEqual(["A"]);
  });
  it("corrects schema C to B in the same session before the plain downstream verifier", async () => {
    const result = await run(1, [
      tool({ id: "C", summary: "Unowned id" }),
      tool({ id: "B", summary: "B claim" }),
      plain("Evidence verifies B."),
    ]);
    const [first, next] = result.workflowRuns!;
    expect(first?.ok, first?.error).toBe(true);
    expect(next?.ok, next?.error).toBe(true);
    expect(result.counters).toMatchObject({ sessions: 2, generations: 3, tools: 1, prompts: 3 });
    expect(first?.result).toBe(
      "Workflow agent execution report\nLabel: verify\nExecution: completed\nThis records an answer, not verified task completion.\n\nAgent answer:\nEvidence verifies B.",
    );
    expect(next?.result).toBe(first?.result);
    expect(next?.replay).toMatchObject({ replayedCalls: 2, freshCalls: 0 });
    expect(result.suppliedPrompts[0]).toContain(task);
    expect(result.suppliedPrompts[1]).toContain("/id:");
    expect(result.suppliedPrompts[1]).toContain("Correct workflow_return only using existing evidence");
    expect(result.suppliedPrompts[2]).toContain(task);
    expect(result.suppliedPrompts[2]).toContain("Candidate B: B claim");
    expect(result.suppliedPrompts[2]).not.toContain("Unowned id");
    const wire = (
      result.payloads[0] as {
        tools: { name: string; strict?: boolean; parameters: { properties: { value: unknown } } }[];
      }
    ).tools.find((tool) => tool.name === "workflow_return")!;
    expect(wire.parameters.properties.value).toMatchObject({
      type: "object",
      properties: { id: { enum: ["A", "B"] } },
    });
    expect(wire.strict).toBe(true);
    expect(result.replayRecord[0]).toMatchObject({
      rcv: 4,
      structuredReceipt: {
        observerRevision: "codex-responses-v3",
        spent: { outputAttempts: 2 },
        validation: "accepted",
      },
    });
  });
  it("rejects duplicate planner ids before starting any fan-out branch", async () => {
    const duplicate = { items: [plan.items[0], plan.items[0]] };
    const result = await run(0, [tool(duplicate)]);
    expect(result.workflowRuns?.[0]?.ok).toBe(false);
    expect(result.workflowRuns?.[0]?.error).toContain("Plan item ids must be unique and nonblank");
    expect(result.workflowRuns?.[1]?.ok).toBe(false);
    expect(result.workflowRuns?.[1]?.error).toContain("Plan item ids must be unique and nonblank");
    expect(result.workflowRuns?.[1]?.replay).toMatchObject({ replayedCalls: 1, freshCalls: 0 });
    expect(result.counters.sessions).toBe(1);
    expect(result.suppliedPrompts.every((prompt) => !prompt.includes("Review A:"))).toBe(true);
  });
  it.each([
    [
      "blank planner id",
      { items: [{ id: "  ", kind: "review", prompt: "Review assigned item" }] },
      "Plan item ids must be unique and nonblank",
      1,
    ],
    ["wrong assigned review id", plan, "Review must return its assigned item id", 2],
  ])("keeps %s a source-owned error on zero-work replay", async (name, records, message, sessions) => {
    const result = await run(0, [tool(records), tool({ id: "B", summary: "Wrong assignment" })], ({ root }, first) => {
      const read = readWorkflowArtifactIndex(root, first.runId, first.runDir);
      expect(read.status).toBe("ready");
      if (read.status === "ready")
        expect(
          read.index.artifacts.some((artifact) => artifact.kind === "primary" || artifact.kind === "published"),
        ).toBe(false);
    });
    const [first, next] = result.workflowRuns!;
    expect(first?.ok).toBe(false);
    expect(first?.error).toContain(message);
    expect(next?.ok).toBe(false);
    expect(next?.error).toContain(message);
    expect(result.counters.sessions).toBe(sessions);
    expect(result.suppliedPrompts).toHaveLength(sessions as number);

    expect(next?.replay).toMatchObject({ replayedCalls: sessions, freshCalls: 0 });
  });
  it.each(["codex-responses-v1", "codex-responses-v2"])(
    "keeps unsafe %s replay refused without another session",
    async (observerRevision) => {
      const result = await run(0, [tool(plan), tool({ id: "A", summary: "Evidence" })], (_fixture, first) => {
        const file = workflowReplayFile(first.runDir);
        const rows = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        rows[0].structuredReceipt.observerRevision = observerRevision;
        writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      });
      expect(result.workflowRuns?.[0]?.ok).toBe(true);
      expect(result.workflowRuns?.[1]?.ok).toBe(false);
      expect(result.workflowRuns?.[1]?.error).toContain("replay-contract-failure");
      expect(result.counters.sessions).toBe(2);
    },
  );
  it.each(["missing-receipt", "uncommitted", "tampered-value"])(
    "refuses %s typed replay before another SDK session",
    async (mode) => {
      const result = await run(0, [tool(plan), tool({ id: "A", summary: "Evidence" })], (_fixture, first) => {
        const file = workflowReplayFile(first.runDir);
        const rows = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (mode === "missing-receipt") delete rows[0].structuredReceipt;
        else if (mode === "uncommitted") rows[0].ok = false;
        else rows[0].structuredReceipt.value.items[0].id = "tampered";
        writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      });
      expect(result.workflowRuns?.[0]?.ok).toBe(true);
      expect(result.workflowRuns?.[1]?.ok).toBe(false);
      expect(result.workflowRuns?.[1]?.error).toContain("replay-contract-failure");
      expect(result.counters.sessions).toBe(2);
    },
  );
  it("refuses changed current input without creating another SDK session", async () => {
    const result = await run(0, [tool(plan), tool({ id: "A", summary: "Evidence" })], undefined, task + " changed");
    expect(result.workflowRuns?.[0]?.ok).toBe(true);
    expect(result.workflowRuns?.[1]?.ok).toBe(false);
    expect(result.workflowRuns?.[1]?.error).toContain("replay-contract-failure");
    expect(result.counters.sessions).toBe(2);
  });
});
