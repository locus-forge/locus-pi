import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import ask from "../../../../extensions/ask-user-question/index.js";
import type { ExtensionAPI } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../../../test-harness.js";

// Scripted tool calls traverse real Pi registration, preparation, validation,
// dispatch and journals. Only model output and operator UI are fixtures.
describe("ask arguments through the Pi host", () => {
  let root: string;
  let session: AgentSession;
  let manager: SessionManager;
  const h = createHarness();
  const input = vi.fn(async (): Promise<string | undefined> => "answer");
  const custom = vi.fn(h.ctx.ui.custom!);
  const editor = vi.fn(async () => "edited");
  const select = vi.fn(
    async (_title: string, options: string[]) => options.find((option) => option === "Done selecting") ?? options[0],
  );
  const execute = vi.fn();
  const model = getModel("openai", "gpt-4o-mini");

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "ask-host-"));
    const agentDir = path.join(root, "agent");
    mkdirSync(agentDir);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          ask({
            ...(pi as unknown as ExtensionAPI),
            registerTool(definition) {
              execute.mockImplementation(definition.execute);
              pi.registerTool({ ...definition, execute } as unknown as Parameters<typeof pi.registerTool>[0]);
            },
          });
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    manager = SessionManager.inMemory(root);
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: ["ask"],
    }));
    await session.bindExtensions({
      mode: "tui",
      uiContext: { ...h.ctx.ui, input, editor, select, custom } as unknown as ExtensionUIContext,
    });
  });
  afterAll(() => {
    session?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function invoke(args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"]) {
    let turn = 0;
    session.agent.streamFunction = () => {
      const first = turn++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: first
          ? [{ type: "toolCall", id: "ask-fixture", name: "ask", arguments: args }]
          : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop",
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
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };
    await session.agent.prompt("Run the scripted ask call");
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(turn).toBe(2);
    return results.at(-1)!;
  }

  it.each(["select", "multi-select", "text", "editor"])("admits rich %s questions", async (kind) => {
    const args = { question: "Choose?", kind, options: ["one", "two"] };
    if (kind === "select") h.customInputQueue.push("\r");
    if (kind === "multi-select") h.customInputQueue.push(" ", "\x1b[B", "\x1b[B", "\r");
    const result = await invoke(args);
    expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![1]).toEqual(args);
    expect(input.mock.calls.length + editor.mock.calls.length + custom.mock.calls.length).toBeGreaterThan(0);
  });

  it("admits a batch and retains nested arguments", async () => {
    const args = {
      questions: [
        { id: "first", question: "First?", options: [{ label: "one" }] },
        { id: "second", question: "Second?", options: [{ label: "two" }], recommended: 0 },
      ],
    };
    h.customInputQueue.push("\r", "\r");
    const result = await invoke(args);
    expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
    expect(execute.mock.calls[0]![1]).toEqual(args);
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["empty", {}],
    ["missing kind", { question: "Question?" }],
    ["missing question", { kind: "text" }],
    ["empty batch", { questions: [] }],
    ["invalid kind", { question: "Question?", kind: "unknown" }],
    ["malformed rich options", { question: "Question?", kind: "select", options: [{ label: "one" }] }],
    ["missing nested fields", { questions: [{}] }],
    ["malformed option", { questions: [{ id: "a", question: "Question?", options: [{}] }] }],
    ["coercible nested label", { questions: [{ id: "a", question: "Question?", options: [{ label: 42 }] }] }],
    ["coercible rich question", { question: 42, kind: "text" }],
  ] satisfies Array<[string, Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"]]>)(
    "rejects %s before execute or UI",
    async (_name, args) => {
      const entriesBefore = manager.getEntries().filter((entry) => entry.type === "custom");
      const result = await invoke(args);
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result.content)).toContain("Validation failed");
      expect(execute).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(editor).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(custom).not.toHaveBeenCalled();
      expect(manager.getEntries().filter((entry) => entry.type === "custom")).toEqual(entriesBefore);
    },
  );

  it("preserves secret redaction in the result and actual decision journal", async () => {
    input.mockResolvedValueOnce("private-answer");
    const result = await invoke({ question: "Secret?", kind: "text", sensitivity: "secret" });
    expect(result).toMatchObject({ isError: false, details: { visibleValue: "[REDACTED:secret-answer]" } });
    const decisions = manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "decision");
    expect(decisions.at(-1)).toMatchObject({ data: { answer: "[REDACTED:secret-answer]", status: "answered" } });
    expect(JSON.stringify([result, decisions])).not.toContain("private-answer");
  });

  it("preserves cancellation", async () => {
    input.mockResolvedValueOnce(undefined);
    expect(await invoke({ question: "Cancel?", kind: "text" })).toMatchObject({ details: { cancelled: true } });
    const decisions = manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "decision");
    expect(decisions.at(-1)).toMatchObject({ data: { status: "cancelled" } });
  });
});
