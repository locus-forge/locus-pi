import { describe, expect, it, vi } from "vitest";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

/**
 * The shared live store on its own, with no SDK executor in the picture.
 *
 * Every case here drives `agentLiveStore` directly: row projection from session
 * events and stats, bounded event lines and transcripts, row retirement, and the
 * execution/cancellation authority rules that keep a replaced row from being
 * written by the execution it replaced.
 */

describe("agent live store", () => {
  it("records source-backed live metadata without fabricating unsupported fields", () => {
    agentLiveStore.reset();
    try {
      const row = agentLiveStore.begin({
        id: "metadata-row",
        agentName: "reviewer",
        label: "Review",
        isolated: false,
        noMcp: false,
      });

      agentLiveStore.feedSessionEvent(row.id, { type: "turn_start", cwd: "/repo/worktree" }, 1000);
      agentLiveStore.feedSessionEvent(
        row.id,
        {
          type: "tool_call",
          toolName: "read",
          toolCall: { args: { file: "README.md", range: [1, 4] } },
        },
        1100,
      );

      const updated = agentLiveStore.rows.get(row.id);
      expect(updated).toMatchObject({
        status: "working",
        activityState: "active",
        currentPath: "/repo/worktree",
        currentTools: ["read"],
        turnCount: 1,
        lastActivityAt: 1100,
      });
      expect(updated?.currentToolArgs).toContain("README.md");
      expect(updated?.tokenCount).toBeUndefined();
      expect(updated?.model).toBeUndefined();
      expect(updated?.thinking).toBeUndefined();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("adds token usage after each completed child turn without double-counting message_end", () => {
    agentLiveStore.reset();
    try {
      const row = agentLiveStore.begin({ id: "live-tokens", agentName: "reviewer", label: "Review" });
      const message = {
        role: "assistant",
        usage: { input: 120, output: 30, total: 150, cacheRead: 0, cacheWrite: 0 },
      };

      agentLiveStore.feedSessionEvent(row.id, { type: "message_end", message }, 1_000);
      expect(agentLiveStore.rows.get(row.id)?.tokenCount).toBeUndefined();

      agentLiveStore.feedSessionEvent(row.id, { type: "turn_end", message }, 1_100);
      agentLiveStore.feedSessionEvent(
        row.id,
        {
          type: "turn_end",
          message: { role: "assistant", usage: { input: 80, output: 20 } },
        },
        1_200,
      );

      expect(agentLiveStore.rows.get(row.id)?.tokenCount).toEqual({ input: 200, output: 50 });
    } finally {
      agentLiveStore.reset();
    }
  });

  it("stamps currentToolStartMs when a tool starts and clears it on tool end / change (T-196 W2)", () => {
    agentLiveStore.reset();
    try {
      const row = agentLiveStore.begin({
        id: "tool-clock",
        agentName: "reviewer",
        label: "Review",
        isolated: false,
        noMcp: false,
      });

      // Tool starts → anchor stamped at the event's `now`.
      const started = agentLiveStore.feedSessionEvent(
        row.id,
        { type: "tool_call", toolName: "bash", args: { command: "npm test -- sums.spec" } },
        10_000,
      );
      expect(started?.currentTools).toEqual(["bash"]);
      expect(started?.currentToolStartMs).toBe(10_000);

      // A *different* tool starts → anchor re-stamped (tool change resets the clock).
      const changed = agentLiveStore.feedSessionEvent(
        row.id,
        { type: "tool_call", toolName: "read", args: { path: "src/app.ts" } },
        12_000,
      );
      expect(changed?.currentToolStartMs).toBe(12_000);

      // Tool ends → anchor cleared.
      const ended = agentLiveStore.feedSessionEvent(row.id, { type: "tool_result", toolName: "read" }, 15_000);
      expect(ended?.currentToolStartMs).toBeUndefined();

      // agent_end also clears the anchor (defensive; tools already gone).
      agentLiveStore.feedSessionEvent(row.id, { type: "tool_call", toolName: "bash", args: { command: "ls" } }, 16_000);
      const finished = agentLiveStore.feedSessionEvent(row.id, { type: "agent_end" }, 17_000);
      expect(finished?.currentToolStartMs).toBeUndefined();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("updates AgentLiveStore rows from mocked session events and stats", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "live-1", agentName: "reviewer", label: "reviewer" });

    agentLiveStore.feedSessionEvent(row.id, { type: "tool_call", toolName: "read" }, 1000);
    const rebegun = agentLiveStore.begin({ id: row.id, agentName: "critic", label: "reviewer" });
    expect(rebegun.agentName).toBe("reviewer");
    expect(rebegun.eventLines).toEqual(["event type=tool_call tool=read"]);

    agentLiveStore.patch(row.id, { status: "working" });
    expect(agentLiveStore.rows.get(row.id)?.eventLines).toEqual(["event type=tool_call tool=read"]);
    agentLiveStore.feedSessionEvent(row.id, { type: "tool_result", toolName: "read" }, 1100);
    agentLiveStore.feedSessionEvent(row.id, { type: "willRetry", message: "retrying transport" }, 1200);
    expect(() => agentLiveStore.feedSessionEvent(row.id, { unexpected: "shape" }, 1250)).not.toThrow();
    agentLiveStore.feedSessionEvent(row.id, { type: "agent_end", willRetry: false }, 1300);
    agentLiveStore.applySessionStats(row.id, { sessionId: "sdk-child", toolCalls: 3, toolResults: 2 });

    expect(agentLiveStore.rows.get(row.id)).toMatchObject({
      id: "live-1",
      agentName: "reviewer",
      label: "reviewer",
      status: "done",
      currentTools: [],
      stepCount: 5,
      errors: ["retrying transport"],
      eventLines: [
        "event type=tool_call tool=read",
        "event type=tool_result tool=read",
        "event type=willRetry message=retrying transport",
        "event type=unknown",
        "event type=agent_end",
        "stats sessionId=sdk-child toolCalls=3 toolResults=2",
      ],
    });
  });

  it("trims AgentLiveStore event lines to the last 200 entries", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "live-trim", agentName: "reviewer", label: "reviewer" });

    for (let index = 0; index < 205; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, { type: `event_${index}` });
    }

    const eventLines = agentLiveStore.rows.get(row.id)?.eventLines;
    expect(eventLines).toHaveLength(200);
    expect(eventLines?.[0]).toBe("event type=event_5");
    expect(eventLines?.[199]).toBe("event type=event_204");
  });

  it("projects streaming and completed Pi messages into one readable chronological transcript", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "transcript-live", agentName: "reviewer", label: "reviewer" });
    const partial = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting" },
        { type: "text", text: "I will read" },
      ],
    };

    agentLiveStore.feedSessionEvent(row.id, { type: "message_update", message: partial });
    expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks).toHaveLength(1);
    expect(agentLiveStore.rows.get(row.id)?.latestMessage).toBe("I will read");

    agentLiveStore.feedSessionEvent(row.id, { type: "message_end", message: partial });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "file body" }] },
      isError: false,
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "agent_end",
      willRetry: false,
      messages: [
        {
          role: "assistant",
          content: [
            ...partial.content,
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "Final answer" }], stopReason: "stop" },
      ],
    });

    expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks.map((block) => block.id)).toEqual([
      "assistant:1",
      "tool:read-1",
      "assistant:2",
    ]);
    expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks[1]).toMatchObject({
      kind: "tool",
      args: { path: "README.md" },
      result: { content: [{ type: "text", text: "file body" }] },
    });
    expect(agentLiveStore.rows.get(row.id)?.latestMessage).toBe("Final answer");
  });

  it("bounds transcript retention and reports how many earlier lines were omitted", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "transcript-trim", agentName: "reviewer", label: "reviewer" });
    for (let index = 0; index < 125; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }], stopReason: "stop" },
      });
    }

    const retained = agentLiveStore.rows.get(row.id);
    expect(retained?.transcript?.blocks).toHaveLength(120);
    expect(retained?.transcript?.blocks[0]?.id).toBe("assistant:6");
    expect(retained?.transcript?.omittedBlockCount).toBe(5);
    expect(retained?.latestMessage).toBe("line 124");
  });

  it("removes retired rows and their transcript/cancel state with one change event", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "retired-row", agentName: "reviewer", label: "retired" });
    const cancel = vi.fn();
    agentLiveStore.registerCancel(row.id, cancel);
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop" },
    });
    const changed = vi.fn();
    agentLiveStore.emitter.on("change", changed);
    try {
      expect(agentLiveStore.removeRows([row.id, "missing-row"])).toBe(1);
      expect(changed).toHaveBeenCalledOnce();
      expect(agentLiveStore.cancel(row.id)).toBe(false);

      const replacement = agentLiveStore.begin({ id: row.id, agentName: "reviewer", label: "replacement" });
      agentLiveStore.feedSessionEvent(replacement.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "new answer" }], stopReason: "stop" },
      });
      expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks).toHaveLength(1);
      expect(agentLiveStore.rows.get(row.id)?.latestMessage).toBe("new answer");
    } finally {
      agentLiveStore.emitter.off("change", changed);
    }
  });

  it("keeps execution and cancellation authority exact across patch, replacement, remove, and reset", () => {
    agentLiveStore.reset();
    const first = agentLiveStore.begin({ id: "authority-row", agentName: "reviewer", label: "first execution" });
    const firstExecution = agentLiveStore.captureExecutionAuthority(first.id)!;
    agentLiveStore.patch(first.id, { status: "working" });
    expect(agentLiveStore.isExecutionAuthorityCurrent(firstExecution)).toBe(true);

    const firstCancel = vi.fn();
    const cleanupFirstCancel = agentLiveStore.registerCancel(first.id, firstCancel);
    const firstCancellation = agentLiveStore.captureCancellationAuthority(first.id)!;
    const replacementCancel = vi.fn();
    const cleanupReplacementCancel = agentLiveStore.registerCancel(first.id, replacementCancel);
    const replacementCancellation = agentLiveStore.captureCancellationAuthority(first.id)!;
    cleanupFirstCancel();
    expect(agentLiveStore.isCancellationAuthorityCurrent(firstCancellation)).toBe(false);
    expect(agentLiveStore.cancelWithAuthority(firstCancellation)).toBe(false);
    expect(agentLiveStore.isCancellationAuthorityCurrent(replacementCancellation)).toBe(true);
    expect(agentLiveStore.cancelWithAuthority(replacementCancellation)).toBe(true);
    expect(firstCancel).not.toHaveBeenCalled();
    expect(replacementCancel).toHaveBeenCalledOnce();

    const second = agentLiveStore.begin({ id: first.id, agentName: "reviewer", label: "second execution" });
    const secondExecution = agentLiveStore.captureExecutionAuthority(second.id)!;
    expect(agentLiveStore.isExecutionAuthorityCurrent(firstExecution)).toBe(false);
    expect(agentLiveStore.isExecutionAuthorityCurrent(secondExecution)).toBe(true);
    expect(agentLiveStore.isCancellationAuthorityCurrent(replacementCancellation)).toBe(false);
    expect(agentLiveStore.cancelWithAuthority(replacementCancellation)).toBe(false);
    cleanupReplacementCancel();

    expect(agentLiveStore.removeRows([second.id])).toBe(1);
    expect(agentLiveStore.isExecutionAuthorityCurrent(secondExecution)).toBe(false);
    const third = agentLiveStore.begin({ id: second.id, agentName: "reviewer", label: "third execution" });
    const thirdExecution = agentLiveStore.captureExecutionAuthority(third.id)!;
    agentLiveStore.reset();
    expect(agentLiveStore.isExecutionAuthorityCurrent(thirdExecution)).toBe(false);
  });

  it("starts a replacement execution with clean run state while preserving stable row identity", () => {
    agentLiveStore.reset();
    const first = agentLiveStore.beginExecution({
      id: "fresh-execution",
      agentName: "reviewer",
      label: "execution A",
      model: "test/a",
    });
    agentLiveStore.patchExecution(first, {
      status: "error",
      startedAt: 100,
      elapsedMs: 50,
      tokenCount: { input: 10, output: 5 },
      childSessionId: "child-a",
      finalAnswer: "answer A",
      errors: ["failure A"],
    });
    agentLiveStore.feedExecutionEvent(first, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "transcript A" }], stopReason: "stop" },
    });
    const displayName = agentLiveStore.rowForExecution(first)?.displayName;

    const second = agentLiveStore.beginExecution({
      id: "fresh-execution",
      agentName: "reviewer",
      label: "execution B",
      model: "test/b",
    });

    expect(agentLiveStore.rowForExecution(first)).toBeUndefined();
    expect(agentLiveStore.rowForExecution(second)).toMatchObject({
      id: "fresh-execution",
      displayName,
      label: "execution B",
      model: "test/b",
      status: "queued",
      currentTools: [],
      stepCount: 0,
      errors: [],
      eventLines: [],
    });
    const row = agentLiveStore.rowForExecution(second)!;
    for (const key of [
      "startedAt",
      "elapsedMs",
      "tokenCount",
      "childSessionId",
      "finalAnswer",
      "transcript",
      "latestMessage",
    ]) {
      expect(key in row).toBe(false);
    }
  });

  it("returns the execution it created even when a synchronous change listener replaces the row", () => {
    agentLiveStore.reset();
    let replacement: ReturnType<typeof agentLiveStore.captureExecutionAuthority>;
    let replaced = false;
    const replaceOnChange = () => {
      if (replaced) return;
      replaced = true;
      replacement = agentLiveStore.beginExecution({
        id: "reentrant-authority",
        agentName: "reviewer",
        label: "execution B",
      });
    };
    agentLiveStore.emitter.on("change", replaceOnChange);
    try {
      const first = agentLiveStore.beginExecution({
        id: "reentrant-authority",
        agentName: "reviewer",
        label: "execution A",
      });
      expect(agentLiveStore.isExecutionAuthorityCurrent(first)).toBe(false);
      expect(replacement).toBeDefined();
      expect(replacement === undefined ? false : agentLiveStore.isExecutionAuthorityCurrent(replacement)).toBe(true);
    } finally {
      agentLiveStore.emitter.off("change", replaceOnChange);
    }
  });
});
