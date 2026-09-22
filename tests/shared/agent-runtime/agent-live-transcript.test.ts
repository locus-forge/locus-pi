import { describe, expect, it } from "vitest";
import {
  AgentLiveTranscript,
  latestVisibleAssistantText,
} from "../../../extensions/_shared/agent-runtime/agent-live-transcript.js";

describe("AgentLiveTranscript", () => {
  it("keeps interleaved tools in stable start order and updates structured lifecycle state", () => {
    const transcript = new AgentLiveTranscript("/repo");
    transcript.ingest({ type: "tool_execution_start", toolCallId: "call-a", toolName: "read", args: { path: "a.ts" } });
    transcript.ingest({
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "bash",
      args: { command: "npm test" },
    });
    transcript.ingest({
      type: "tool_execution_update",
      toolCallId: "call-a",
      partialResult: { content: [{ type: "text", text: "A partial" }] },
    });
    let snapshot = transcript.ingest({
      type: "tool_execution_update",
      toolCallId: "call-b",
      partialResult: "B partial",
    });

    expect(snapshot.blocks.map((block) => block.id)).toEqual(["tool:call-a", "tool:call-b"]);
    expect(snapshot.blocks[0]).toMatchObject({ kind: "tool", cwd: "/repo", executionStarted: true, isPartial: true });
    expect(snapshot.blocks[1]).toMatchObject({
      kind: "tool",
      result: { content: [{ type: "text", text: "B partial" }] },
    });

    snapshot = transcript.ingest({
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "read",
      result: "A done",
      isError: false,
    });
    expect(snapshot.blocks[0]).toMatchObject({ id: "tool:call-a", isPartial: false, result: { isError: false } });
    expect(snapshot.blocks[1]).toMatchObject({ id: "tool:call-b", isPartial: true });
  });

  it("replaces a streaming assistant snapshot in place and derives latest visible text", () => {
    const transcript = new AgentLiveTranscript();
    const partial = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting" },
        { type: "text", text: "First draft" },
      ],
    };
    const streaming = transcript.ingest({ type: "message_update", message: partial });
    const completed = transcript.ingest({
      type: "message_end",
      message: { ...partial, content: [{ type: "text", text: "Final answer" }], stopReason: "stop" },
    });

    expect(streaming.blocks).toHaveLength(1);
    expect(streaming.blocks[0]).toMatchObject({ id: "assistant:1", kind: "assistant", complete: false });
    expect(completed.blocks).toHaveLength(1);
    expect(completed.blocks[0]).toMatchObject({ id: "assistant:1", complete: true });
    expect(completed.latestMessage).toBe("Final answer");
    expect(latestVisibleAssistantText(completed.blocks)).toBe("Final answer");
  });

  it("keeps the newest streaming output visible and restores the final report opening", () => {
    const transcript = new AgentLiveTranscript();
    const text = `Report opening\n${"Earlier session text. ".repeat(400)}\n[Claude Code progress] Reading src/provider.ts`;
    const message = {
      role: "assistant",
      provider: "claude-code",
      api: "claude-code-cli",
      content: [{ type: "text", text }],
    };
    const streaming = transcript.ingest({ type: "message_update", message });
    const block = streaming.blocks[0];
    expect(block?.kind).toBe("assistant");
    if (block?.kind === "assistant") {
      expect(block.message.content[0]?.text).toHaveLength(4000);
      expect(block.message.content[0]?.text).toMatch(/Reading src\/provider\.ts$/u);
    }
    expect(streaming.latestMessage).toHaveLength(300);
    expect(streaming.latestMessage).toMatch(/Reading src\/provider\.ts$/u);

    const newer = transcript.ingest({
      type: "message_update",
      message: { ...message, content: [{ type: "text", text: `${text}\nRead finished` }] },
    });
    expect(newer.blocks).toHaveLength(1);
    expect(newer.latestMessage).toMatch(/Read finished$/u);
    // Previously returned snapshots remain independent of later updates.
    expect(streaming.latestMessage).not.toContain("Read finished");

    const completed = transcript.ingest({ type: "message_end", message });
    expect(completed.latestMessage).toMatch(/^Report opening/u);
    expect(completed.latestMessage).not.toContain("Reading src/provider.ts");
    expect(transcript.replaceMessages([message]).latestMessage).toBe(completed.latestMessage);
  });

  it("reconciles canonical tool calls and results by toolCallId", () => {
    const snapshot = new AgentLiveTranscript("/repo").replaceMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading source" },
          { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
    ]);

    expect(snapshot.blocks.map((block) => block.id)).toEqual(["assistant:1", "tool:call-read", "assistant:2"]);
    expect(snapshot.blocks[1]).toMatchObject({
      kind: "tool",
      args: { path: "README.md" },
      result: { content: [{ type: "text", text: "file body" }], isError: false },
      isPartial: false,
    });
    expect(snapshot.latestMessage).toBe("Done");
  });

  it("keeps the viewer transcript limited to child assistant and tool output", () => {
    const snapshot = new AgentLiveTranscript().replaceMessages([
      { role: "system", content: "PARENT_SYSTEM_SENTINEL" },
      { role: "user", content: [{ type: "text", text: "PARENT_CHAT_SENTINEL" }] },
      { role: "assistant", content: [{ type: "text", text: "Child output" }], stopReason: "stop" },
    ]);

    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.latestMessage).toBe("Child output");
    expect(JSON.stringify(snapshot)).not.toContain("PARENT_SYSTEM_SENTINEL");
    expect(JSON.stringify(snapshot)).not.toContain("PARENT_CHAT_SENTINEL");
  });

  it("ignores repeated tool observations without a stable toolCallId", () => {
    const transcript = new AgentLiveTranscript("/repo");
    const incompleteAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "Working" },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
      ],
    };

    transcript.ingest({ type: "message_start", message: incompleteAssistant });
    transcript.ingest({ type: "message_update", message: incompleteAssistant });
    transcript.ingest({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
    const snapshot = transcript.ingest({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });

    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.blocks[0]).toMatchObject({ id: "assistant:1", kind: "assistant", complete: false });
    expect(snapshot.blocks.some((block) => block.kind === "tool")).toBe(false);
  });

  it("redacts sensitive tool values and does not expose image payloads", () => {
    const transcript = new AgentLiveTranscript();
    transcript.ingest({
      type: "tool_execution_start",
      toolCallId: "secret",
      toolName: "http",
      args: { token: "abc", nested: { apiKey: "xyz", ok: 1 } },
    });
    const snapshot = transcript.ingest({
      type: "tool_execution_end",
      toolCallId: "secret",
      result: { content: [{ type: "image", data: "base64-secret", mimeType: "image/png" }] },
    });

    expect(snapshot.blocks[0]).toMatchObject({
      args: { token: "[redacted]", nested: { apiKey: "[redacted]", ok: 1 } },
      result: { content: [{ type: "image", data: "[redacted]", mimeType: "image/png" }] },
    });
  });

  it("bounds canonical retention by blocks and reports omissions", () => {
    const messages = Array.from({ length: 125 }, (_unused, index) => ({
      role: "assistant",
      content: [{ type: "text", text: `line ${index}` }],
      stopReason: "stop",
    }));
    const snapshot = new AgentLiveTranscript().replaceMessages(messages);

    expect(snapshot.blocks).toHaveLength(120);
    expect(snapshot.blocks[0]).toMatchObject({ id: "assistant:6" });
    expect(snapshot.omittedBlockCount).toBe(5);
    expect(snapshot.latestMessage).toBe("line 124");
  });

  // Builds ~600 MB of string data (40 messages x 150 items x 100 KB), which
  // takes ~4s of the 5s default budget even on a fast machine — so it times out
  // intermittently under parallel load and on slower CI runners. The bound is
  // what this test asserts, not its speed; give it explicit headroom.
  it("bounds per-message content items and aggregate transcript bytes/nodes", () => {
    const huge = "x".repeat(100_000);
    const messages = Array.from({ length: 40 }, (_unused, index) => ({
      role: "assistant",
      content: Array.from({ length: 150 }, (_item, item) => ({ type: "text", text: `${index}:${item}:${huge}` })),
      stopReason: "stop",
    }));
    const snapshot = new AgentLiveTranscript().replaceMessages(messages);

    expect(snapshot.blocks.length).toBeLessThan(40);
    expect(snapshot.omittedBlockCount).toBeGreaterThan(0);
    const last = snapshot.blocks.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.message.content).toHaveLength(100);
      expect(last.message.content[0]?.text?.length).toBeLessThanOrEqual(4_000);
    }
  }, 30_000);
});
