import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { retainAgentSession } from "../../../../extensions/_shared/agent-runtime/session/lifetime.js";
import { formatAgentLiveRowLine } from "../../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { activityStore, agentActivityLabel } from "../../../../extensions/_shared/agent-runtime/activity-store.js";

afterEach(async () => {
  await agentLiveStore.shutdownAgents();
  agentLiveStore.reset();
  vi.useRealTimers();
});

describe("flat agent lifetime", () => {
  it("starts a fresh activity interval after idle without changing session identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const execution = agentLiveStore.beginExecution({ id: "clock", label: "Clock" });
    agentLiveStore.patchExecution(execution, { status: "done", startedAt: 1_000, elapsedMs: 10_000 });
    let finish = () => {};
    retainAgentSession(execution, { dispose() {}, getLastAssistantText: () => "done" }, async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const pending = agentLiveStore.sendInputForExecution(execution, "next");
    expect(agentLiveStore.rowForExecution(execution)).toMatchObject({
      status: "working",
      startedAt: 100_000,
      elapsedMs: undefined,
    });
    vi.advanceTimersByTime(2_000);
    expect(formatAgentLiveRowLine(agentLiveStore.rowForExecution(execution)!)).toContain("2s");
    finish();
    await pending;
    expect(agentLiveStore.rowForExecution(execution)).toMatchObject({
      status: "done",
      startedAt: 100_000,
      elapsedMs: 2_000,
    });
    expect(agentLiveStore.captureExecutionAuthority("clock")).toBe(execution);
    const activity = [...activityStore.agents.values()].find((entry) => entry.execution === execution)!;
    expect(activity.active).toBe(true);
    expect(agentActivityLabel(activity)).toBe("idle");
  });
  it("keeps the same execution through repeated idle turns and disposes only on exit", async () => {
    const execution = agentLiveStore.beginExecution({ id: "a", label: "A" });
    const session = { dispose: vi.fn(), getLastAssistantText: () => "answer" };
    const run = vi.fn(async () => {});
    retainAgentSession(execution, session, run);
    expect(await agentLiveStore.sendInputForExecution(execution, "first")).toEqual({ ok: true });
    expect(await agentLiveStore.sendInputForExecution(execution, "second")).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(agentLiveStore.captureExecutionAuthority("a")).toBe(execution);
    expect(session.dispose).not.toHaveBeenCalled();
    await agentLiveStore.exitAgent("a");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(agentLiveStore.rows.has("a")).toBe(false);
  });

  it("cancels one turn but keeps the agent available; exit never cascades to creator peers", async () => {
    const a = agentLiveStore.beginExecution({ id: "a", label: "A" });
    const b = agentLiveStore.beginExecution({ id: "b", label: "B", parentRowId: "a" });
    const disposeA = vi.fn(),
      disposeB = vi.fn();
    retainAgentSession(a, { dispose: disposeA, getLastAssistantText: () => "" }, async (_text, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    retainAgentSession(b, { dispose: disposeB, getLastAssistantText: () => "" }, async () => {});
    const pending = agentLiveStore.sendInputForExecution(a, "slow");
    expect(agentLiveStore.cancel("a")).toBe(true);
    await pending;
    expect(agentLiveStore.canSendInputForExecution(a)).toBe(true);
    expect(disposeA).not.toHaveBeenCalled();
    await agentLiveStore.exitAgent("a");
    expect(agentLiveStore.rows.has("b")).toBe(true);
    expect(disposeB).not.toHaveBeenCalled();
    await agentLiveStore.shutdownAgents();
    expect(disposeB).toHaveBeenCalledOnce();
  });
});

it("retires a superseded idle workflow round without cancelling an active peer", async () => {
  const first = agentLiveStore.beginExecution({ id: "workflow-agent:run:slot", label: "A" });
  const dispose = vi.fn();
  retainAgentSession(first, { dispose, getLastAssistantText: () => "done" }, async () => {});
  agentLiveStore.patchExecution(first, { status: "done" });
  const second = agentLiveStore.beginExecution({ id: "workflow-agent:run:slot", label: "A", round: 2 });
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(agentLiveStore.captureExecutionAuthority("workflow-agent:run:slot")).toBe(second);
  expect(agentLiveStore.rowForExecution(second)?.status).toBe("queued");
});
