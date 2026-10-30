import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";

function fixture(slow = false, abortTimeoutMs = 10, displayTask?: string) {
  agentLiveStore.reset();
  agentLiveStore.retainSessions = true;
  const dir = mkdtempSync(path.join(tmpdir(), "flat-agent-"));
  const listeners = new Set<(event: { type: string }) => void>();
  const emit = (type: string) => {
    for (const fn of listeners) fn({ type });
  };
  let count = 0;
  const session: SdkAgentSessionLike = {
    sessionId: "same-session",
    isStreaming: false,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    prompt: vi.fn(async () => {
      count++;
      emit("agent_start");
      emit("turn_start");
      if (!(slow && count === 1)) emit("agent_end");
    }),
    getSessionStats: () => ({ sessionId: "same-session", toolCalls: 0, toolResults: 0 }),
    getLastAssistantText: () => "done",
    getActiveToolNames: () => ["read"],
    setActiveToolsByName: vi.fn(),
    abort: vi.fn(async () => {
      emit("agent_end");
    }),
    dispose: vi.fn(),
    exportToJsonl: (file) => {
      const target = file ?? path.join(dir, "session.jsonl");
      writeFileSync(target, "{}\n");
      return target;
    },
  };
  const createSession = vi.fn(async () => ({ session }));
  const executor = createAgentSdkSessionExecutor({
    createSession,
    reportsDir: dir,
    abortTimeoutMs,
    live: { rowId: "a", label: "A", ...(displayTask === undefined ? {} : { displayTask }) },
  });
  const request: AgentRunRequest = {
    executionMode: "bare",
    task: "task",
    projectRoot: dir,
    workingDirectory: dir,
    allowedTools: ["read"],
    parentSessionId: "main",
    depth: 0,
    maxDepth: 1,
    approvalTier: "allow",
  };
  return { executor, session, createSession, request };
}
afterEach(async () => {
  await agentLiveStore.shutdownAgents();
  agentLiveStore.reset();
});

describe("SDK assignment and agent lifetimes", () => {
  it("continues twice after completion without recreating SDK or disposing the agent", async () => {
    const { executor, session, createSession, request } = fixture();
    const original = await executor.run(request, new AbortController().signal);
    const execution = agentLiveStore.captureExecutionAuthority("a")!;
    expect(original.status).toBe("completed");
    expect(await agentLiveStore.sendInputForExecution(execution, "follow-up 1")).toEqual({ ok: true });
    expect(await agentLiveStore.sendInputForExecution(execution, "follow-up 2")).toEqual({ ok: true });
    expect(createSession).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(original.text).toBe("done");
  });
  it("cancel during initial assignment preserves an idle agent, exit disposes it", async () => {
    const { executor, session, request } = fixture(true);
    const first = executor.run(request, new AbortController().signal);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    agentLiveStore.cancel("a");
    expect((await first).status).toBe("cancelled");
    expect(session.dispose).not.toHaveBeenCalled();
    const execution = agentLiveStore.captureExecutionAuthority("a")!;
    expect(await agentLiveStore.sendInputForExecution(execution, "continue")).toEqual({ ok: true });
    await agentLiveStore.exitAgent("a");
    expect(session.dispose).toHaveBeenCalledOnce();
  });
  it("does not reset lifetime turn budgets for follow-up", async () => {
    const { executor, session, request } = fixture();
    await executor.run({ ...request, maxTurns: 1 }, new AbortController().signal);
    const execution = agentLiveStore.captureExecutionAuthority("a")!;
    const result = await agentLiveStore.sendInputForExecution(execution, "another turn");
    expect(result.ok).toBe(false);
    expect(session.prompt).toHaveBeenCalledOnce();
  });
  it("does not retain an initially cancelled session whose abort never confirms idle", async () => {
    const { executor, session, request } = fixture(true);
    Object.defineProperty(session, "isStreaming", { value: true });
    session.abort = vi.fn(() => new Promise<void>(() => {}));
    const pending = executor.run(request, new AbortController().signal);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    agentLiveStore.cancel("a");
    await pending;
    const execution = agentLiveStore.captureExecutionAuthority("a")!;
    expect(agentLiveStore.canSendInputForExecution(execution)).toBe(false);
    expect(session.dispose).toHaveBeenCalledOnce();
  });
  it("disables follow-up input after an uncertain cancellation rather than overlapping prompts", async () => {
    const { executor, session, request } = fixture();
    await executor.run(request, new AbortController().signal);
    const execution = agentLiveStore.captureExecutionAuthority("a")!;
    Object.defineProperty(session, "isStreaming", { value: true });
    session.prompt = vi.fn(async () => {});
    session.abort = vi.fn(() => new Promise<void>(() => {}));
    const pending = agentLiveStore.sendInputForExecution(execution, "slow");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    agentLiveStore.cancel("a");
    expect((await pending).ok).toBe(false);
    expect(agentLiveStore.canSendInputForExecution(execution)).toBe(false);
    expect((await agentLiveStore.sendInputForExecution(execution, "overlap")).ok).toBe(false);
    expect(session.prompt).toHaveBeenCalledOnce();
    await expect(agentLiveStore.exitAgent("a")).rejects.toThrow("abort settlement remained unconfirmed");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(agentLiveStore.rows.has("a")).toBe(false);
  });
  it("ends workflow return protocol without widening tools or changing its accepted result", async () => {
    const { createWorkflowReturnController, normalizeWorkflowReturnContract } =
      await import("../../../../extensions/workflows/runtime/workflow-return.js");
    const { tool, acceptance } = createWorkflowReturnController(normalizeWorkflowReturnContract({ choices: ["ok"] }));
    const { executor, session, request, createSession } = fixture();
    session.getActiveToolNames = () => ["read", tool.name];
    await tool.execute("return-1", { value: "ok" }, new AbortController().signal);
    const result = await executor.run(
      { ...request, customTools: [tool], responseAcceptance: acceptance },
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(result.text).toBe(JSON.stringify("ok"));
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read"]);
    const execution = agentLiveStore.captureExecutionAuthority("a")!;
    expect((await agentLiveStore.sendInputForExecution(execution, "independent next task")).ok).toBe(true);
    expect(createSession).toHaveBeenCalledOnce();
    expect(result.text).toBe(JSON.stringify("ok"));
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read"]);
  });
});

it("shows the author prompt, never the workflow execution capsule, while SDK receives full execution task", async () => {
  const author = "Validate this build without changing files.";
  const { executor, request, session } = fixture(false, 10, author);
  const internal = "## Workflow execution context\nINTERNAL CONTROL\n\n---\n\n" + author;
  await executor.run({ ...request, task: internal }, new AbortController().signal);
  const execution = agentLiveStore.captureExecutionAuthority("a")!;
  expect(agentLiveStore.rowForExecution(execution)?.request).toBe(author);
  expect(agentLiveStore.sessionDisplay(execution).task).toBe(author);
  expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("INTERNAL CONTROL"), expect.anything());
});
