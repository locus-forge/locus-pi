import { runAgentLoop, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AgentLivePanel } from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { AgentLiveTranscript } from "../../../extensions/_shared/agent-runtime/agent-live-transcript.js";

// Real Pi loop, controlled provider output. No Claude credentials or inference.
describe("external provider progress runtime contract", () => {
  it("projects replacement snapshots without another model turn or executing reported nested tools", async () => {
    const model = {
      ...getModel("openai", "gpt-4o-mini"),
      provider: "claude-code",
      api: "claude-code-cli",
      id: "review-fixture",
      baseUrl: "cli://local",
    };
    const transcript = new AgentLiveTranscript();
    const previews: string[] = [];
    const frames: string[] = [];
    const message: AssistantMessage = {
      role: "assistant",
      provider: model.provider,
      api: model.api,
      model: model.id,
      content: [],
      timestamp: 0,
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    const selectedStream = vi.fn<StreamFn>(() => stream);
    const observedEvents: string[] = [];
    const run = runAgentLoop(
      [{ role: "user", content: "Review source", timestamp: 0 }],
      { systemPrompt: "Test", messages: [], tools: [] },
      { model, convertToLlm: (messages) => messages as Message[] },
      (event) => {
        observedEvents.push(event.type);
        const snapshot = transcript.ingest(event);
        if (snapshot.latestMessage !== undefined) previews.push(snapshot.latestMessage);
        frames.push(
          new AgentLivePanel()
            .renderRows(
              [
                {
                  id: "child",
                  label: "Claude review",
                  status: "working",
                  currentTools: [],
                  stepCount: 0,
                  isolated: true,
                  noMcp: true,
                  errors: [],
                  eventLines: [],
                  transcript: snapshot,
                  latestMessage: snapshot.latestMessage,
                },
              ],
              100,
            )
            .join("\n"),
        );
      },
      undefined,
      selectedStream,
    );
    const push = async (text: string) => {
      // The partial snapshot is authoritative even for status-only (empty-delta) updates.
      message.content = [{ type: "text", text }];
      stream.push({ type: "text_delta", contentIndex: 0, delta: "", partial: structuredClone(message) });
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    stream.push({ type: "start", partial: structuredClone(message) });
    stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(message) });
    await push("[Claude Code progress] Session initialized");
    await push(
      `${"Earlier text. ".repeat(700)}\nClaude text: Checking ownership\n[Claude Code progress] Read src/provider.ts`,
    );
    await push("Claude text: Ownership checked\n[Claude Code progress] Read finished");
    message.content = [{ type: "text", text: "Final report" }];
    stream.push({ type: "done", reason: "stop", message: structuredClone(message) });
    stream.end();
    const messages = await run;

    expect(previews.some((text) => text.endsWith("Read src/provider.ts"))).toBe(true);
    expect(frames.some((frame) => frame.includes("Read src/provider.ts"))).toBe(true);
    expect(previews.some((text) => text.includes("Ownership checked"))).toBe(true);
    expect(transcript.snapshot().latestMessage).toBe("Final report");
    expect(JSON.stringify(messages)).not.toContain("[Claude Code progress]");
    expect(selectedStream).toHaveBeenCalledOnce();
    expect(selectedStream.mock.calls[0]?.[0]).toBe(model);
    expect(observedEvents.filter((type) => type === "turn_start")).toHaveLength(1);
    expect(observedEvents).not.toContain("tool_execution_start");
  });
});
