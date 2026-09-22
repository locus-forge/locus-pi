import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sdk from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { configureCliSessionDeadline } from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";

async function createChild(config: Parameters<typeof sdk.SettingsManager.inMemory>[0] = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "locus-cli-deadline-"));
  const settings = sdk.SettingsManager.inMemory({ ...config, retry: { enabled: false, ...config?.retry } });
  const model = { ...getModel("openai", "gpt-4o-mini"), baseUrl: "cli://fixture" };
  const runtime = await sdk.ModelRuntime.create({
    authPath: path.join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(cwd, "models-store.json"),
    refreshOnCreate: false,
  });
  const stream = vi.spyOn(runtime, "streamSimple").mockImplementation(() => createAssistantMessageEventStream());
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({
    cwd,
    model,
    modelRuntime: runtime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(),
    noTools: "all",
  });
  return { session, model, settings, stream };
}

describe("CLI child transport deadlines through the real Pi SDK", () => {
  it("requires stream support for a declared CLI transport, while model-only host doubles stay untouched", () => {
    const modelOnly = { model: { provider: "fixture", id: "fixture" } } as sdk.AgentSession;
    expect(() => configureCliSessionDeadline(modelOnly)).not.toThrow();
    const missingCliSubstrate = { model: { baseUrl: "cli://fixture" } } as sdk.AgentSession;
    expect(() => configureCliSessionDeadline(missingCliSubstrate)).toThrow();
  });
  it.each([
    { config: {}, request: undefined, expected: undefined },
    { config: {}, request: 86_400_000, expected: 86_400_000 },
    { config: { httpIdleTimeoutMs: 0 }, request: undefined, expected: undefined },
    { config: { httpIdleTimeoutMs: 45_000 }, request: undefined, expected: 45_000 },
    { config: { httpIdleTimeoutMs: 45_000 }, request: 86_400_000, expected: 45_000 },
    { config: { retry: { provider: { timeoutMs: 20_000, maxRetries: 2 } } }, request: undefined, expected: 20_000 },
    { config: { retry: { provider: { timeoutMs: 100_000_000 } } }, request: 86_400_000, expected: 86_400_000 },
  ])("passes only declared deadlines: $config / $request", async ({ config, request, expected }) => {
    const { session, model, settings, stream } = await createChild(config);
    const before = settings.getGlobalSettings();
    try {
      configureCliSessionDeadline(session, request);
      await session.agent.streamFunction(model, { messages: [] }, {});
      const options = stream.mock.calls[0]?.[2];
      if (expected === undefined) expect(options).not.toHaveProperty("timeoutMs");
      else expect(options?.timeoutMs).toBe(expected);
      expect(options?.maxRetries).toBe(settings.getProviderRetrySettings().maxRetries);
      expect(settings.getGlobalSettings()).toEqual(before);
    } finally {
      session.dispose();
    }
  });

  it.each([undefined, 86_400_000])(
    "preserves explicit calls, abort, HTTP switches, and SDK provider hooks (%s)",
    async (requestTimeoutMs) => {
      const { session, model, settings, stream } = await createChild();
      const controller = new AbortController();
      const onPayload = vi.fn();
      const onResponse = vi.fn();
      try {
        configureCliSessionDeadline(session, requestTimeoutMs);
        for (const timeoutMs of [1234, 300_000]) {
          await session.agent.streamFunction(
            model,
            { messages: [] },
            {
              timeoutMs,
              signal: controller.signal,
              headers: { "x-fixture": "value" },
              onPayload,
              onResponse,
              websocketConnectTimeoutMs: 4321,
            },
          );
          expect(stream.mock.lastCall?.[2]).toMatchObject({
            timeoutMs,
            signal: controller.signal,
            headers: { "x-fixture": "value" },
            onPayload,
            onResponse,
            websocketConnectTimeoutMs: 4321,
            transformHeaders: expect.any(Function),
          });
          expect(Object.getOwnPropertySymbols(stream.mock.lastCall?.[2] ?? {})).toEqual([]);
        }
        const headers = await stream.mock.lastCall?.[2]?.transformHeaders?.({ "x-provider": "kept" });
        expect(headers).toMatchObject({ "x-provider": "kept" });
        controller.abort();
        expect(stream.mock.lastCall?.[2]?.signal?.aborted).toBe(true);
        await session.agent.streamFunction({ ...model, baseUrl: "https://api.example" }, { messages: [] }, {});
        expect(stream.mock.lastCall?.[2]?.timeoutMs).toBe(settings.getHttpIdleTimeoutMs());
        expect(settings.getRetrySettings().enabled).toBe(false);
      } finally {
        session.dispose();
      }
    },
  );

  it("does not change another child's runtime or explicit direct runtime calls", async () => {
    const child = await createChild();
    const other = await createChild();
    try {
      configureCliSessionDeadline(child.session);
      child.session.modelRuntime.streamSimple(child.model, { messages: [] }, { timeoutMs: 300_000 });
      expect(child.stream.mock.lastCall?.[2]?.timeoutMs).toBe(300_000);
      await other.session.agent.streamFunction(other.model, { messages: [] }, {});
      expect(other.stream.mock.lastCall?.[2]?.timeoutMs).toBe(300_000);
    } finally {
      child.session.dispose();
      other.session.dispose();
    }
  });
});
