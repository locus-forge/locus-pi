import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../../extensions/_shared/agent-runtime/agent-runner.js";
import runPlanWorkflow from "../../../../../extensions/workflows/examples/task/plan.workflow.mjs";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../../test-harness.js";

interface AgentCall {
  prompt: string;
  options: { label: string; choice?: string[]; handoffs?: object; result?: string; title?: string };
}

type AnswerQueues = Record<string, unknown[]>;
const roots: string[] = [];
const generatedSource =
  'export const meta = { name: "generated", profile: "standard" };\nexport default async function run(dsl) { return await dsl.agent("work", { label: "work" }); }\n';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function completeRunAnswers(): AnswerQueues {
  return {
    "workflow-design": ["Complete design ledger."],
    "workflow-design-review": ["Reviewed design ledger."],
    "workflow-source-seed": ["workflow-source-seed.md"],
    "workflow-source-seed-check": ["workflow-source-seed-check.md: passed"],
    "workflow-source-seed-route": ["passed"],
    "workflow-source-cut": [["slice-a: add the review branch"], []],
    "workflow-source-queue-assessment": ["queue transition is valid", "all requirements are implemented"],
    "workflow-source-queue-route": ["work", "complete"],
    "workflow-source-slice": ["workflow-source-slice.md"],
    "workflow-source-check": ["workflow-source-check.md: passed"],
    "workflow-source-check-route": ["passed"],
    "workflow-source-review": ["workflow-source-design-review.md: accepted"],
    "workflow-source-review-route": ["accept"],
    "workflow-source-final-check": ["workflow-source-final-check.md: passed"],
    "workflow-source-final-check-route": ["passed"],
    "workflow-source-final-review": ["workflow-source-final-review.md: complete"],
    "workflow-source-final-route": ["publish"],
  };
}

function fixture(overrides: Partial<AnswerQueues> = {}) {
  const calls: AgentCall[] = [];
  const phases: string[] = [];
  const answers = completeRunAnswers();
  for (const [label, values] of Object.entries(overrides)) {
    if (values !== undefined) answers[label] = [...values];
  }
  const publishPrimaryFile = vi.fn((relativePath: string) => ({
    relativePath,
    absolutePath: `/workspace/${relativePath}`,
    bytes: 321,
    sha256: "checked-digest",
  }));
  const dsl = {
    agent: async (prompt: string, options: AgentCall["options"]) => {
      calls.push({ prompt, options });
      const queue = answers[options.label];
      if (queue === undefined || queue.length === 0) throw new Error(`No scripted answer for ${options.label}`);
      return queue.shift();
    },
    phase: (name: string) => phases.push(name),
    publishPrimaryFile,
  };
  return {
    calls,
    phases,
    publishPrimaryFile,
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted brief."),
  };
}

function runnerFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "task-plan-workflow-runner-"));
  roots.push(root);
  const harness = createHarness(root, { sessionId: "task-plan-workflow" });
  const answers = completeRunAnswers();
  const tasks: string[] = [];
  const labels: string[] = [];
  const phases: string[] = [];
  const createExecutor: NonNullable<Parameters<typeof runWorkflowScript>[0]["createExecutor"]> = (
    options,
  ): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      const label = options.live?.label;
      if (label === undefined) throw new Error("Expected every task/plan child call to have a label");
      const queue = answers[label];
      if (queue === undefined || queue.length === 0) throw new Error(`No scripted answer for ${label}`);
      const value = queue.shift();
      labels.push(label);
      tasks.push(request.task);
      if (label === "workflow-source-seed") writeFileSync(path.join(root, "proof", "workflow.mjs"), generatedSource);
      return {
        status: "completed",
        agentName: request.agent?.name ?? "sub-agent",
        text: request.responseAcceptance === undefined ? String(value) : JSON.stringify(value),
        reason: "scripted task/plan answer",
        diagnostics: [],
        lifecycleEntryIds: [],
        ...(request.responseAcceptance === undefined
          ? {}
          : { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }),
      };
    },
  });
  return {
    root,
    tasks,
    labels,
    phases,
    run: () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "task/plan",
        input: "Accepted brief.",
        outputDir: "proof",
        createExecutor,
        onEvent: (line) => {
          if (line.kind === "phase" && line.phase !== undefined) phases.push(line.phase);
        },
      }),
  };
}

describe("Package workflow: task/plan", () => {
  it("returns the task/plan workspace file through the real runner primaryFile boundary", async () => {
    const fixtureRun = runnerFixture();
    const absolutePath = path.join(fixtureRun.root, "proof", "workflow.mjs");
    const result = await fixtureRun.run();

    expect(result.ok, result.error).toBe(true);
    expect(result.primaryFile).toEqual({
      relativePath: "workflow.mjs",
      absolutePath,
      bytes: Buffer.byteLength(generatedSource),
      sha256: createHash("sha256").update(generatedSource).digest("hex"),
    });
    expect(readFileSync(result.primaryFile!.absolutePath, "utf8")).toBe(generatedSource);
    expect(fixtureRun.tasks.every((task) => !task.includes(generatedSource))).toBe(true);
    expect(fixtureRun.labels.filter((label) => label === "workflow-source-cut")).toHaveLength(2);
    expect(fixtureRun.phases).toEqual(["design", "build", "verify", "build", "verify", "verify", "publish"]);
  });

  it("routes bounded source-free slices to terminal publication", async () => {
    const fixtureRun = fixture();

    await expect(fixtureRun.run()).resolves.toMatchObject({ relativePath: "workflow.mjs" });
    expect(fixtureRun.calls.every((call) => !call.prompt.includes(generatedSource))).toBe(true);
    expect(fixtureRun.publishPrimaryFile).toHaveBeenCalledOnce();
    expect(fixtureRun.publishPrimaryFile).toHaveBeenCalledWith("workflow.mjs");
    expect(fixtureRun.phases).toEqual(["design", "build", "verify", "build", "verify", "verify", "publish"]);

    const calls = fixtureRun.calls;
    expect(calls.filter((call) => call.options.label === "workflow-source-cut")).toHaveLength(2);
    expect(calls.find((call) => call.options.label === "workflow-source-cut")?.options.handoffs).toEqual({});
    expect(calls.find((call) => call.options.label === "workflow-source-slice")?.prompt).toContain(
      "slice-a: add the review branch",
    );
    expect(calls.find((call) => call.options.label === "workflow-source-final-review")?.prompt).toContain(
      "Queue evidence:\nall requirements are implemented",
    );
    for (const call of calls.filter(
      (entry) => entry.options.label.startsWith("workflow-source-") && !entry.options.choice,
    ))
      expect(call.prompt).toMatch(/never[^.]*source bytes/iu);
    for (const call of calls) expect(call.options.label).toMatch(/^workflow-/u);
  });

  it("routes every mechanical failure through one fix before semantic review", async () => {
    const fixtureRun = fixture({
      "workflow-source-check": ["workflow-source-check.md: failed"],
      "workflow-source-check-route": ["fix"],
      "workflow-source-fix": ["workflow-source-fix.md"],
      "workflow-source-fix-check": ["workflow-source-fix-check.md: passed"],
      "workflow-source-fix-route": ["passed"],
    });

    await expect(fixtureRun.run()).resolves.toMatchObject({ relativePath: "workflow.mjs" });
    expect(fixtureRun.calls.map((call) => call.options.label)).toEqual(
      expect.arrayContaining([
        "workflow-source-check",
        "workflow-source-check-route",
        "workflow-source-fix",
        "workflow-source-fix-check",
        "workflow-source-fix-route",
        "workflow-source-review",
      ]),
    );
    const reviewPrompt = fixtureRun.calls.find((call) => call.options.label === "workflow-source-review")?.prompt;
    expect(reviewPrompt).toContain(
      "Read the exact current mechanical evidence from workspace workflow-source-fix-check.md",
    );
    expect(reviewPrompt).not.toContain("workflow-source-check.md: failed");
    expect(
      fixtureRun.calls.find((call) => call.options.label === "workflow-source-check-route")?.options.choice,
    ).toEqual(["passed", "fix"]);
  });

  it("does not grant a second fix when the mechanical path consumed the slice allowance", async () => {
    const fixtureRun = fixture({
      "workflow-source-check-route": ["fix"],
      "workflow-source-fix": ["workflow-source-fix.md"],
      "workflow-source-fix-check": ["workflow-source-fix-check.md: passed"],
      "workflow-source-fix-route": ["passed"],
      "workflow-source-review-route": ["fix"],
    });

    await expect(fixtureRun.run()).resolves.toMatchObject({
      ok: false,
      status: "failed",
      reason: "slice_repair_failed",
      source: "workflow.mjs",
      diagnostics: "workflow-source-design-review.md: accepted",
    });
    expect(fixtureRun.calls.some((call) => call.options.label === "workflow-source-design-fix")).toBe(false);
    expect(fixtureRun.publishPrimaryFile).not.toHaveBeenCalled();
  });

  it("independently rechecks a semantic fix before accepting the slice", async () => {
    const fixtureRun = fixture({
      "workflow-source-review-route": ["fix"],
      "workflow-source-design-fix": ["workflow-source-design-fix.md"],
      "workflow-source-design-fix-check": ["workflow-source-design-fix-check.md: passed"],
      "workflow-source-design-fix-route": ["passed"],
      "workflow-source-design-recheck": ["workflow-source-design-recheck.md: accepted"],
      "workflow-source-design-recheck-route": ["accept"],
    });

    await expect(fixtureRun.run()).resolves.toMatchObject({ relativePath: "workflow.mjs" });
    expect(fixtureRun.calls.map((call) => call.options.label)).toEqual(
      expect.arrayContaining([
        "workflow-source-design-fix",
        "workflow-source-design-fix-check",
        "workflow-source-design-fix-route",
        "workflow-source-design-recheck",
        "workflow-source-design-recheck-route",
      ]),
    );
    expect(
      fixtureRun.calls.find((call) => call.options.label === "workflow-source-review-route")?.options.choice,
    ).toEqual(["accept", "fix", "failed"]);
  });

  it.each([
    {
      name: "mechanical fix recheck",
      overrides: {
        "workflow-source-check-route": ["fix"],
        "workflow-source-fix": ["workflow-source-fix.md"],
        "workflow-source-fix-check": ["mechanical fix failed"],
        "workflow-source-fix-route": ["failed"],
      },
      reason: "slice_repair_failed",
      diagnostics: "mechanical fix failed",
      lastLabel: "workflow-source-fix-route",
    },
    {
      name: "design fix mechanical recheck",
      overrides: {
        "workflow-source-review-route": ["fix"],
        "workflow-source-design-fix": ["workflow-source-design-fix.md"],
        "workflow-source-design-fix-check": ["design fix check failed"],
        "workflow-source-design-fix-route": ["failed"],
      },
      reason: "slice_repair_failed",
      diagnostics: "design fix check failed",
      lastLabel: "workflow-source-design-fix-route",
    },
    {
      name: "design fix semantic recheck",
      overrides: {
        "workflow-source-review-route": ["fix"],
        "workflow-source-design-fix": ["workflow-source-design-fix.md"],
        "workflow-source-design-fix-check": ["workflow-source-design-fix-check.md: passed"],
        "workflow-source-design-fix-route": ["passed"],
        "workflow-source-design-recheck": ["design still mismatched"],
        "workflow-source-design-recheck-route": ["failed"],
      },
      reason: "design_mismatch",
      diagnostics: "design still mismatched",
      lastLabel: "workflow-source-design-recheck-route",
    },
  ])("stops without publication after a failed $name", async ({ overrides, reason, diagnostics, lastLabel }) => {
    const fixtureRun = fixture(overrides);

    await expect(fixtureRun.run()).resolves.toMatchObject({
      ok: false,
      status: "failed",
      stage: "verify",
      reason,
      diagnostics,
    });
    expect(fixtureRun.calls.at(-1)?.options.label).toBe(lastLabel);
    expect(fixtureRun.publishPrimaryFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "seed failure",
      overrides: { "workflow-source-seed-route": ["failed"] },
      reason: "seed_failed",
    },
    {
      name: "queue conflict",
      overrides: { "workflow-source-queue-route": ["queue_conflict"] },
      reason: "queue_conflict",
    },
    {
      name: "empty work queue",
      overrides: { "workflow-source-cut": [[]], "workflow-source-queue-route": ["work"] },
      reason: "empty_queue",
    },
    {
      name: "final mechanical failure",
      overrides: { "workflow-source-final-check-route": ["failed"] },
      reason: "final_check_failed",
    },
    {
      name: "final design mismatch",
      overrides: { "workflow-source-final-route": ["design_mismatch"] },
      reason: "design_mismatch",
    },
  ])("fails closed on $name with an explicit diagnostic string", async ({ overrides, reason }) => {
    const fixtureRun = fixture(overrides);

    await expect(fixtureRun.run()).resolves.toMatchObject({
      ok: false,
      source: "workflow.mjs",
      reason,
      diagnostics: expect.any(String),
    });
    expect(fixtureRun.publishPrimaryFile).not.toHaveBeenCalled();
  });

  it("returns the full remaining queue when the six-slice allowance is exhausted", async () => {
    const slices = Array.from({ length: 7 }, (_, index) => [`slice-${index + 1}`]);
    const fixtureRun = fixture({
      "workflow-source-cut": slices,
      "workflow-source-queue-assessment": Array.from({ length: 7 }, (_, index) => `queue-${index + 1}`),
      "workflow-source-queue-route": Array.from({ length: 7 }, () => "work"),
      "workflow-source-slice": Array.from({ length: 6 }, (_, index) => `slice-report-${index + 1}`),
      "workflow-source-check": Array.from({ length: 6 }, (_, index) => `check-${index + 1}`),
      "workflow-source-check-route": Array.from({ length: 6 }, () => "passed"),
      "workflow-source-review": Array.from({ length: 6 }, (_, index) => `review-${index + 1}`),
      "workflow-source-review-route": Array.from({ length: 6 }, () => "accept"),
    });

    await expect(fixtureRun.run()).resolves.toMatchObject({
      ok: false,
      status: "incomplete",
      reason: "slice_allowance",
      source: "workflow.mjs",
      diagnostics: "queue-7",
      remaining: ["slice-7"],
    });
    expect(fixtureRun.calls.filter((call) => call.options.label === "workflow-source-slice")).toHaveLength(6);
    expect(fixtureRun.publishPrimaryFile).not.toHaveBeenCalled();
  });
});
