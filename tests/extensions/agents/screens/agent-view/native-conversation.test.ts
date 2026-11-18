import { beforeAll, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { NativeAgentConversation } from "../../../../../extensions/agents/fleet/native-conversation.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createBashToolDefinition: (...args: Parameters<typeof actual.createBashToolDefinition>) => ({
      ...actual.createBashToolDefinition(...args),
      execute,
    }),
  };
});
beforeAll(() => initTheme(undefined, false));
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
function conversation(name: string, args: unknown, output: string) {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call", name, arguments: args }] },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: name,
      content: [{ type: "text", text: output }],
      isError: false,
    },
  ];
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  return { messages, view: new NativeAgentConversation(() => messages, tui, "/project"), tui };
}

it("uses the real Pi bash renderer for multiline commands without executing or rewriting them", () => {
  const command = "printf 'one'\nprintf 'two'\nprintf '%s' 'literal\\nvalue'";
  const { messages, view } = conversation("bash", { command }, "onetwoliteral\\nvalue");
  const original = structuredClone(messages);
  const frame = plain(view.render(120));
  expect(
    frame
      .split("\n")
      .map((line) => line.trim())
      .join("\n"),
  ).toContain("$ printf 'one'\nprintf 'two'");
  expect(frame).not.toContain('{"command":');
  expect(frame).toContain("literal\\nvalue");
  expect(messages).toEqual(original);
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  ["read", { path: "sample.mjs", offset: 2, limit: 3 }],
  ["write", { path: "sample.mjs", content: "const n = 1;\nconsole.log(n);\n" }],
  ["edit", { path: "sample.mjs", oldText: "before\n", newText: "after\n" }],
])("keeps %s arguments intact while using its native path presentation", (name, args) => {
  const { messages, view } = conversation(name as string, args, "operation completed");
  const original = structuredClone(messages);
  const frame = plain(view.render(120));
  expect(frame).toContain("sample.mjs");
  expect(frame).not.toContain('{"path":');
  view.toggleToolsExpanded();
  view.render(120);
  expect(messages).toEqual(original);
});

it("expands and collapses the real tool output, including content outside the preview", () => {
  const output = Array.from({ length: 60 }, (_, i) => (i === 30 ? "MIDDLE_RESULT_VISIBLE" : `Output ${i}`)).join("\n");
  const { view, tui } = conversation("bash", { command: "produce output" }, output);
  expect(plain(view.render(120))).not.toContain("MIDDLE_RESULT_VISIBLE");
  vi.mocked(tui.requestRender).mockClear();
  view.toggleToolsExpanded();
  expect(tui.requestRender).toHaveBeenCalled();
  expect(plain(view.render(120))).toContain("MIDDLE_RESULT_VISIBLE");
  view.toggleToolsExpanded();
  expect(plain(view.render(120))).not.toContain("MIDDLE_RESULT_VISIBLE");
  expect(execute).not.toHaveBeenCalled();
});

it("preserves a native tool component's own expanded state across conversation refreshes", () => {
  const output = Array.from({ length: 60 }, (_, i) => (i === 30 ? "NATIVE_EXPANSION_KEPT" : `Output ${i}`)).join("\n");
  const expanded = vi.spyOn(ToolExecutionComponent.prototype, "setExpanded");
  try {
    const { view } = conversation("bash", { command: "produce output" }, output);
    view.render(120);
    const nativeTool = expanded.mock.contexts.at(-1) as ToolExecutionComponent;
    nativeTool.setExpanded(true);
    expect(plain(view.render(120))).toContain("NATIVE_EXPANSION_KEPT");
  } finally {
    expanded.mockRestore();
  }
});

it("retains the generic renderer for unknown tools without treating escaped strings as code", () => {
  const { messages, view } = conversation(
    "custom_inspect",
    { value: "literal\\nvalue", nested: { number: 7 } },
    "CUSTOM_RESULT",
  );
  const original = structuredClone(messages);
  const frame = plain(view.render(120));
  expect(frame).toContain("custom_inspect");
  expect(frame).toContain("CUSTOM_RESULT");
  expect(frame).toContain("literal");
  expect(frame).toContain("value");
  expect(messages).toEqual(original);
});
