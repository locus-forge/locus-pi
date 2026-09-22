import { describe, expect, it, vi } from "vitest";
import {
  WorkflowOperatorHandoffController,
  type ActionableWorkflowHandoff,
  type WorkflowHandoffControllerPorts,
} from "../../../../extensions/workflows/operator/operator-handoff-controller.js";
import { requestInlineOperatorInteraction } from "../../../../extensions/_shared/operator/operator-interaction.js";
import type { CustomUiComponent, CustomUiFactory } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../../../test-harness.js";

function handoff(runId: string, overrides: Partial<ActionableWorkflowHandoff> = {}): ActionableWorkflowHandoff {
  return {
    runId,
    title: `Workflow ${runId}`,
    questions: [
      {
        kind: "select",
        id: "scope",
        prompt: "Choose scope",
        options: [{ label: "Current changes" }, { label: "Last commit" }],
        recommended: "Current changes",
        allowCustom: true,
      },
    ],
    value: {
      version: "locus.workflow.operator-handoff.v1",
      handoffId: `handoff-${runId}`,
      originRunId: runId,
      title: `Workflow ${runId}`,
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
          recommended: "Current changes",
          allowCustom: true,
        },
      ],
      continuationArtifactRefs: [],
      target: { kind: "name", ref: "review", source: "package" },
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        scriptSha256: "0".repeat(64),
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
      },
    },
    ...overrides,
  };
}

function controller(
  listed: ActionableWorkflowHandoff[],
  launch = vi.fn(async (_item: ActionableWorkflowHandoff, _answer: string, _ctx: unknown) => ({
    status: "started" as const,
  })),
): { controller: WorkflowOperatorHandoffController; launch: typeof launch } {
  const byId = new Map(listed.map((item) => [item.runId, item]));
  const ports: WorkflowHandoffControllerPorts = {
    scan: () => listed.map((handoff) => ({ status: "actionable", handoff })),
    read: (_projectRoot, runId) => byId.get(runId),
    launch,
  };
  return { controller: new WorkflowOperatorHandoffController(ports), launch };
}

describe("workflow operator handoff controller", () => {
  it("opens the oldest actionable handoff first and renders FIFO progress without a run picker", async () => {
    const newer = handoff("20260725-130000-new");
    const older = handoff("20260725-120000-old");
    const { controller: queue, launch } = controller([newer, older]);
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: older.runId,
    });
    expect(launch).toHaveBeenCalledWith(older, "Current changes", harness.ctx);
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Question 1 of 2");
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Choose scope");
    expect(harness.customRenderFrames[0]?.join("\n")).not.toContain(newer.runId);
    expect(harness.customOptions).toEqual([{ overlay: false }]);
  });

  it("uses persisted chronology for same-second runs instead of sorting random suffixes", async () => {
    const newer = handoff("20260725-120000-0001");
    const older = handoff("20260725-120000-ffff");
    const { controller: queue, launch } = controller([newer, older]);
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    expect(queue.eligibleRunIds("/project")).toEqual([older.runId, newer.runId]);
    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: older.runId,
    });
    expect(launch).toHaveBeenCalledWith(older, "Current changes", harness.ctx);
  });

  it("delivers Escape as a refusal answer through the ordinary launch path", async () => {
    const item = handoff("20260725-120000-pending");
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("\x1b");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: item.runId,
    });
    expect(launch).toHaveBeenCalledWith(
      item,
      [
        "The operator declined to answer this workflow's questions.",
        "",
        "1. Choose scope",
        "   id: scope",
        "   answer: none — the operator declined",
      ].join("\n"),
      harness.ctx,
    );
  });

  it("keeps answers given before the refusal and marks only the declined questions", async () => {
    const item = handoff("20260725-120000-partial", {
      questions: [
        { kind: "select", id: "scope", prompt: "Choose scope", options: [{ label: "Current changes" }] },
        { kind: "text", id: "note", prompt: "Add a note" },
      ],
    });
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("\r", "\x1b");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });
    expect(launch.mock.calls[0]?.[1]).toBe(
      [
        "The operator declined to answer this workflow's questions.",
        "",
        "1. Choose scope",
        "   id: scope",
        "   answer: Current changes",
        "2. Add a note",
        "   id: note",
        "   answer: none — the operator declined",
      ].join("\n"),
    );
  });

  it("collects multiple questions in one component at a time and renders one deterministic input", async () => {
    const item = handoff("20260725-120000-multi", {
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose scope",
          options: [{ label: "Current changes" }],
        },
        {
          kind: "text",
          id: "note",
          prompt: "Add a note",
        },
      ],
    });
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("\r", "Keep generated files excluded.", "\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });
    expect(launch.mock.calls[0]?.[1]).toBe(
      "1. Choose scope\n   id: scope\n   answer: Current changes\n2. Add a note\n   id: note\n   answer: Keep generated files excluded.",
    );
    expect(harness.customComponents).toHaveLength(2);
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Prompt 1 of 2");
    expect(harness.customRenderFrames.at(-1)?.join("\n")).toContain("Prompt 2 of 2");
  });

  it("names the blocked run and the tool that blocked it inside the question block", async () => {
    const item = handoff("20260725-120000-multi", {
      questions: [{ kind: "text", id: "note", prompt: "Add a note" }],
    });
    const { controller: queue } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("Keep generated files excluded.", "\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });
    const frame = harness.customRenderFrames[0]?.join("\n") ?? "";
    // Provenance survives a narrow terminal because it is a body line, not a
    // badge, and the progress badge is still there beside it.
    expect(frame).toContain("run #ulti · awaitOperator");
    expect(frame).toContain("Question 1 of 1");
  });

  it("keeps run context beside three choices and the custom-answer row", async () => {
    const item = handoff("20260725-120000-choice", {
      questions: [
        {
          kind: "select",
          id: "planning-decision",
          prompt: "How should planning proceed?",
          options: [
            { label: "Use the safest assumption" },
            { label: "Keep an explicit prerequisite" },
            { label: "Reduce to evidenced scope" },
          ],
          recommended: "Use the safest assumption",
          allowCustom: true,
        },
      ],
    });
    const { controller: queue } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });
    const frame = harness.customRenderFrames[0]?.join("\n") ?? "";
    expect(frame).toContain("run #oice · awaitOperator");
    expect(frame).toContain("Use the safest assumption (Recommended)");
    expect(frame).toContain("Keep an explicit prerequisite");
    expect(frame).toContain("Reduce to evidenced scope");
    expect(frame).toContain("Other (type your own)");
  });

  it("validates explicit noninteractive answers without mounting UI", async () => {
    const item = handoff("20260725-120000-explicit", {
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
        },
      ],
    });
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness(process.cwd(), { mode: "json" });

    await expect(queue.pump(harness.ctx, { runId: item.runId, answer: "Unknown scope" })).resolves.toMatchObject({
      status: "invalid",
      message: expect.stringContaining("exactly match"),
    });
    await expect(queue.pump(harness.ctx, { runId: item.runId, answer: "Last commit" })).resolves.toMatchObject({
      status: "started",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(harness.customComponents).toEqual([]);
  });

  it("requires explicit input in one-way modes and drops stale-session mounts", async () => {
    const item = handoff("20260725-120000-mode");
    const { controller: queue, launch } = controller([item]);
    const jsonHarness = createHarness(process.cwd(), { mode: "json" });

    await expect(queue.pump(jsonHarness.ctx, { runId: item.runId })).resolves.toEqual({
      status: "unavailable",
      runId: item.runId,
    });
    const tuiHarness = createHarness();
    await expect(queue.pump(tuiHarness.ctx, { isCurrent: () => false })).resolves.toEqual({
      status: "stale",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not mount or launch after a held interaction slot reaches the front while Pi is busy", async () => {
    const item = handoff("20260725-120000-held");
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const held = requestInlineOperatorInteraction(harness.ctx, () => inertComponent());
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const pending = queue.pump(harness.ctx);
    harness.setStreaming(true);
    completions[0]!("released");

    await expect(held).resolves.toBe("released");
    await expect(pending).resolves.toEqual({ status: "busy" });
    expect(harness.ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it("keeps a handoff pending when Pi becomes busy after the answer and launches it on retry", async () => {
    const item = handoff("20260725-120000-answer-race");
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    const custom = harness.ctx.ui.custom!;
    harness.ctx.ui.custom = (async (...args: Parameters<typeof custom>) => {
      const result = await custom.apply(harness.ctx.ui, args);
      harness.setStreaming(true);
      return result;
    }) as typeof custom;
    harness.customInputQueue.push("\r");

    await expect(queue.pump(harness.ctx)).resolves.toEqual({ status: "busy" });
    expect(launch).not.toHaveBeenCalled();

    harness.setStreaming(false);
    harness.ctx.ui.custom = custom;
    harness.customInputQueue.push("\r");
    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: item.runId,
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("never reopens a retryable handoff unprompted, and says so exactly once per session", async () => {
    // A retryable handoff already consumed an answer whose continuation failed.
    // The unprompted pump re-asking those questions is how an operator ends up
    // answering the same clarification twice with no way to type a command.
    const item = handoff("20260725-120000-retryable");
    const launch = vi.fn(async () => ({ status: "started" as const }));
    const ports: WorkflowHandoffControllerPorts = {
      scan: () => [{ status: "actionable", handoff: item, state: "retryable" }],
      read: () => item,
      launch,
    };
    const queue = new WorkflowOperatorHandoffController(ports);
    const harness = createHarness();
    // The unprompted pump carries the session scope; this session owns the run.
    const originRunIds = new Set([item.runId]);

    await expect(queue.pump(harness.ctx, { originRunIds })).resolves.toEqual({
      status: "deferred",
      runId: item.runId,
    });
    await expect(queue.pump(harness.ctx, { originRunIds })).resolves.toEqual({ status: "none" });
    expect(harness.customComponents).toEqual([]);
    expect(launch).not.toHaveBeenCalled();

    // An explicit /workflows still opens the same handoff with its questions.
    harness.customInputQueue.push("\r");
    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: item.runId,
    });
    expect(launch).toHaveBeenCalledWith(item, "Current changes", harness.ctx);
  });

  it("reports every failed continuation of a run, not only the first one", async () => {
    // A session-wide "already told them" flag meant the operator was warned about
    // the first failed continuation and about nothing after it — every later retry
    // of the same handoff failed in silence.
    const item = handoff("20260725-120000-repeat");
    const launch = vi.fn(async () => ({ status: "started" as const }));
    const ports: WorkflowHandoffControllerPorts = {
      scan: () => [{ status: "actionable", handoff: item, state: "retryable" }],
      read: () => item,
      launch,
    };
    const queue = new WorkflowOperatorHandoffController(ports);
    const harness = createHarness();
    const originRunIds = new Set([item.runId]);

    await expect(queue.pump(harness.ctx, { originRunIds })).resolves.toEqual({
      status: "deferred",
      runId: item.runId,
    });
    await expect(queue.pump(harness.ctx, { originRunIds })).resolves.toEqual({ status: "none" });

    // The operator answers explicitly; that continuation fails too.
    harness.customInputQueue.push("\r");
    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });

    await expect(queue.pump(harness.ctx, { originRunIds })).resolves.toEqual({
      status: "deferred",
      runId: item.runId,
    });
    await expect(queue.pump(harness.ctx, { originRunIds })).resolves.toEqual({ status: "none" });
  });

  it("still opens pending handoffs unprompted while a retryable one waits behind them", async () => {
    const pending = handoff("20260725-121000-pending");
    const retryable = handoff("20260725-120000-retryable");
    const launch = vi.fn(async () => ({ status: "started" as const }));
    const ports: WorkflowHandoffControllerPorts = {
      scan: () => [
        { status: "actionable", handoff: pending, state: "pending" },
        { status: "actionable", handoff: retryable, state: "retryable" },
      ],
      read: () => pending,
      launch,
    };
    const queue = new WorkflowOperatorHandoffController(ports);
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    await expect(
      queue.pump(harness.ctx, { originRunIds: new Set([pending.runId, retryable.runId]) }),
    ).resolves.toMatchObject({
      status: "started",
      sourceRunId: pending.runId,
    });
    // The retryable handoff is not part of the unprompted queue count.
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Question 1 of 1");
    expect(launch).toHaveBeenCalledWith(pending, "Current changes", harness.ctx);
  });

  it("translates unexpected pump failures to invalid instead of rejecting", async () => {
    const item = handoff("20260725-120000-rejection");
    const ports: WorkflowHandoffControllerPorts = {
      scan: () => {
        throw new Error("durable scan exploded");
      },
      read: () => item,
      launch: vi.fn(),
    };
    const queue = new WorkflowOperatorHandoffController(ports);
    const harness = createHarness();

    await expect(queue.pump(harness.ctx)).resolves.toEqual({
      status: "invalid",
      message: "Workflow handoff pump failed: durable scan exploded",
    });
  });
});

function inertComponent(): CustomUiComponent {
  return {
    render: () => ["held"],
    invalidate() {},
  };
}
