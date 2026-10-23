import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createHarness } from "../../../test-harness.js";
import { writeGlobalModelRoles } from "../../../model-roles-fixture.js";
export const strong = { ...getModel("openai", "gpt-5.2") };
export const limited = { ...getModel("openai", "gpt-5.1") };
export const nonReasoning = { ...getModel("openai", "gpt-4o-mini") };

/** Real SDK selection/defaults/clamping/readback, with only provider generation scripted. */
export async function createThinkingFixture(
  tempRoots: string[],
  input: { profileModel?: string | undefined; profileThinking?: string; hideThinking?: boolean } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "locus-agent-thinking-"));
  tempRoots.push(root);
  writeGlobalModelRoles(root, {});
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Fixture reviewer",
      ...(input.profileModel === undefined ? [] : [`model: ${input.profileModel}`]),
      ...(input.profileThinking === undefined ? [] : [input.profileThinking]),
      "---",
      "Return READY.",
    ].join("\n"),
  );
  const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultThinkingLevel: "low",
    retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(root, "fixture-auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "fixture-key");
  const captured: Array<Record<string, unknown>> = [];
  const stream = vi.fn((model: Model<Api>) => {
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      content: [{ type: "text", text: "READY" }],
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
    const events = createAssistantMessageEventStream();
    events.push({ type: "done", reason: "stop", message });
    events.end();
    return events;
  });
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    ...sdk,
    getAgentDir: () => root,
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
      constructor(options: Record<string, unknown>) {
        super({
          ...options,
          cwd: root,
          agentDir: root,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        });
      }
    },
    async createAgentSession(options: Record<string, unknown>) {
      captured.push(options);
      const result = await sdk.createAgentSession({
        ...options,
        modelRuntime,
        settingsManager,
        noTools: "all",
        tools: [],
      });
      result.session.agent.streamFunction = stream;
      if (input.hideThinking === true) {
        Object.defineProperty(result.session, "thinkingLevel", { get: () => undefined });
      }
      return result;
    },
  }));
  const { default: agents } = await import("../../../../extensions/agents/index.js");
  const { agentLiveStore } = await import("../../../../extensions/_shared/agent-runtime/agent-live-store.js");
  agentLiveStore.reset();
  const h = createHarness(root, { models: [strong, limited, nonReasoning], sessionId: "fixture-parent" });
  h.ctx.model = strong;
  agents(h.pi);
  const readback = () => {
    const row = [...agentLiveStore.rows.values()].at(-1)!;
    const envelope = JSON.parse(readFileSync(row.resultArtifact!, "utf8")) as { content: string };
    return { row, result: JSON.parse(envelope.content) as Record<string, unknown> };
  };
  return { root, h, settingsManager, captured, stream, agentLiveStore, readback };
}
