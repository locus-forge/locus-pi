import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sdk from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSdkSessionExecutor } from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { hostRequest } from "../../fixtures/agent-runtime/agent-failure-probes.js";

/**
 * The child-dispatch boundary against the REAL Pi agent session, not a structural fake.
 *
 * Pi settles `prompt()` only after the whole agent run, so a prompt that settles with no child
 * event was absorbed before dispatch — an `input` handler returned `handled`. The host used to
 * wait for an `agent_end` that never comes; without a child timeout that wait was unbounded.
 */
async function realChild(options: { absorbInput: boolean }) {
  const cwd = mkdtempSync(path.join(tmpdir(), "locus-sdk-dispatch-"));
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
  const model = getModel("openai", "gpt-4o-mini");
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(cwd, "models-store.json"),
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "fixture-key");
  const absorbingExtension: sdk.ExtensionFactory = (pi) => {
    pi.on("input", async () => ({ action: "handled" as const }));
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: options.absorbInput ? [absorbingExtension] : [],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    noTools: "all",
  });
  await session.bindExtensions({});
  const stream = vi.fn(() => {
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
  session.agent.streamFunction = stream;
  const executor = createAgentSdkSessionExecutor({
    createSession: async () => ({ session }) as never,
    reportsDir: mkdtempSync(path.join(tmpdir(), "locus-sdk-dispatch-reports-")),
    now: () => "fixed",
  });
  return { executor, stream };
}

describe("child prompt dispatch through the real Pi SDK", () => {
  it("fails an absorbed prompt by name instead of awaiting agent_end, with no child timeout", async () => {
    const { executor, stream } = await realChild({ absorbInput: true });

    const result = await executor.run(hostRequest(), new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", failureCause: "prompt-not-dispatched" });
    expect(result.reason).toContain("absorbed before model dispatch");
    expect(result.executedModel).toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
  });

  it("still completes a dispatched prompt, so settling after the run is not misread as absorption", async () => {
    const { executor, stream } = await realChild({ absorbInput: false });

    const result = await executor.run(hostRequest(), new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", text: "READY", executedModel: "openai/gpt-4o-mini" });
    expect(stream).toHaveBeenCalledOnce();
  });
});
