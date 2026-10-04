import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "../../../../extensions/_shared/host/pi-api.js";
import { type SdkAgentSessionEventLike } from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { createHarness, runTool } from "../../../test-harness.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../../../model-roles-fixture.js";

const tempRoots: string[] = [];

afterEach(() => {
  agentLiveStore.reset();
  restoreGlobalModelRolesHome();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.doUnmock("../../../../extensions/_shared/agent-runtime/agent-runner.js");
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-pi-agent-task-tool-"));
  tempRoots.push(root);
  return root;
}

/**
 * A project root that owns the `task` agent outright.
 *
 * Agent discovery is project → user → bundled (`agents.ts` `agentDiscoveryDirs`), so
 * a root with no `.agents/agents/` silently borrows whatever catalog the developer
 * happens to have installed under `$HOME`. That was invisible while agent frontmatter
 * `model:` was parsed and never used; now that it selects the child's model, a stale
 * home catalog decides what these assertions see. So the project declares its own.
 */
function tempRootWithTaskAgent(): string {
  const root = tempRoot();
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "task.md"),
    "---\nname: task\ndescription: General task agent\nmodel: task\n---\nDo the task.\n",
    "utf8",
  );
  return root;
}

function mockSdkResult(text: string, turns = 1): void {
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    SessionManager: { create: () => ({ kind: "isolated-test-session" }) },
    DefaultResourceLoader: class {
      constructor(_options: Record<string, unknown>) {}
      reload() {}
    },
    getAgentDir() {
      return tempRoot();
    },
    async createAgentSession() {
      let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
      return {
        session: {
          sessionId: "sdk-child",
          subscribe(fn: (event: SdkAgentSessionEventLike) => void) {
            listener = fn;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            for (let turn = 0; turn < turns; turn++) listener?.({ type: "turn_start" });
            listener?.({ type: "agent_end", willRetry: false });
          },
          getSessionStats() {
            return { sessionId: "sdk-child", toolCalls: 0, toolResults: 0 };
          },
          getLastAssistantText() {
            return text;
          },
          exportToJsonl(outputPath: string) {
            return outputPath;
          },
          dispose() {},
        },
      };
    },
  }));
}

describe("agent task tool execution", () => {
  it("allows more than five turns and arms exactly one hour for a standalone task", async () => {
    mockSdkResult("done after six turns", 6);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { default: agents } = await import("../../../../extensions/agents/index.js");
    const h = createHarness(tempRootWithTaskAgent(), { mode: "tui" });
    agents(h.pi);
    const result = await runTool(h, "spawn_agent", { task: "Complete six turns" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "done after six turns" });
    expect(timer.mock.calls.filter((call) => call[1] === 3_600_000)).toHaveLength(1);
    expect(timer.mock.calls.some((call) => call[1] === 600_000)).toBe(false);
  });

  it("streams the generated live agent name as soon as the child starts", async () => {
    mockSdkResult("done");
    const { default: agents } = await import("../../../../extensions/agents/index.js");
    const h = createHarness(tempRootWithTaskAgent(), { sessionId: "parent-session" });
    agents(h.pi);
    const update = vi.fn();

    await h.tools
      .get("spawn_agent")!
      .execute(
        "test-spawn_agent",
        { task: "Return done", title: "Compute expression" },
        new AbortController().signal,
        update,
        h.ctx,
      );

    const row = [...agentLiveStore.rows.values()].at(-1);
    expect(row?.displayName).toBeTypeOf("string");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining(`agent ${row!.displayName} started — Compute expression`),
        },
      ],
      // Partial identity for the transcript card: it resolves the live row by id.
      details: {
        rowId: row!.id,
        executionMode: "bare",
        title: "Compute expression",
        status: "running",
      },
    });
  });

  it("returns one child's exact text and keeps metadata in details", async () => {
    mockSdkResult("  done\nwith details\n");
    const { default: agents } = await import("../../../../extensions/agents/index.js");
    const h = createHarness(tempRootWithTaskAgent(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" };
    h.pi.setThinkingLevel?.("high");
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", {
      task: "Return done",
      title: "Show model",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "  done\nwith details\n" }]);
    expect(result.details).toMatchObject({
      requestedSurface: "spawn_agent",
      executionMode: "bare",
      taskCount: 1,
      status: "completed",
      childSessionId: "sdk-child",
    });
    const row = [...agentLiveStore.rows.values()].at(-1);
    expect(row).toMatchObject({
      model: "openai/gpt-5.5",
      status: "done",
      finalAnswer: "  done\nwith details\n",
    });
    // The parent's `high` seeds the row as a request-side label, but this child session reads
    // no effort back, so the finished row does not present `high` as what ran.
    expect(row).not.toHaveProperty("thinking");
  });

  it("treats JSON-looking child output as ordinary text", async () => {
    const text = '{"status":"failed","summary":"model words only"}';
    mockSdkResult(text);
    const { default: agents } = await import("../../../../extensions/agents/index.js");
    const root = tempRootWithTaskAgent();
    const h = createHarness(root, { sessionId: "parent-session" });
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", { task: "Return JSON-looking prose" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(result.details).toMatchObject({ status: "completed", taskCount: 1 });
    expect(existsSync(path.join(root, ".locus-pi/logs/errors.jsonl"))).toBe(false);
  });

  it("returns isError when the child has no non-empty final text", async () => {
    mockSdkResult(" \n ");
    const { default: agents } = await import("../../../../extensions/agents/index.js");
    const h = createHarness(tempRootWithTaskAgent(), { sessionId: "parent-session" });
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", { task: "Return nothing" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Agent result text is empty." }]);
    expect(result.details).toMatchObject({ status: "failed", taskCount: 1 });
    const details = result.details as Record<string, unknown>;
    const record = JSON.parse(readFileSync(details.errorLogPath as string, "utf8"));
    expect(record).toMatchObject({
      source: "agent",
      status: "failed",
      message: "Agent result text is empty.",
      sessionId: "sdk-child",
      callId: details.rowId,
      resultPath: details.resultArtifact,
    });
    expect(record).not.toHaveProperty("runId");
    expect(record).not.toHaveProperty("attempt");
  });

  it("stops progress and surfaces an error when the run boundary throws", async () => {
    vi.doMock("../../../../extensions/_shared/agent-runtime/agent-runner.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../../../extensions/_shared/agent-runtime/agent-runner.js")
      >("../../../../extensions/_shared/agent-runtime/agent-runner.js");
      return {
        ...actual,
        async executeAgentRunBoundary() {
          throw new Error("simulated host crash mid-run");
        },
      };
    });
    const { default: agents } = await import("../../../../extensions/agents/index.js");
    const root = tempRootWithTaskAgent();
    mkdirSync(path.join(root, ".locus-pi/logs/errors.jsonl"), { recursive: true });
    const h = createHarness(root, { sessionId: "parent-session" });
    h.ctx.hasUI = true;
    agents(h.pi);

    await expect(runTool(h, "spawn_agent", { task: "explode" })).rejects.toThrow("simulated host crash mid-run");

    expect(h.notifications.join("\n")).toContain("Error index unavailable");
    expect(h.notifications.join("\n")).toContain("simulated host crash mid-run");
    const factory = h.widgetPayloads.get("agents");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: () => {}, terminal: { rows: 30, columns: 100 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => { render(width: number): string[] })(
      stubTui,
      {},
    );
    expect(component.render(100).some((line) => line.includes("error") || line.includes("FAILED"))).toBe(true);
  });
});

const strong = { ...getModel("openai", "gpt-5.2") };
const limited = { ...getModel("openai", "gpt-5.1") };
const nonReasoning = { ...getModel("openai", "gpt-4o-mini") };

/** Real SDK selection/defaults/clamping/readback, with only provider generation scripted. */
async function thinkingFixture(
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

describe("standalone child SDK thinking routing", () => {
  it.each(["high", "xhigh"] as const)("bare %s overrides low SDK defaults without an implicit role", async (effort) => {
    const f = await thinkingFixture();
    writeGlobalModelRoles(f.root, { agent: "openai/gpt-4o-mini:low" });
    f.h.pi.setThinkingLevel?.(effort);

    const result = await runTool(f.h, "spawn_agent", { task: "Return READY" });

    expect(result.isError).not.toBe(true);
    expect(f.captured).toHaveLength(1);
    expect(f.captured[0]).toMatchObject({ model: strong, thinkingLevel: effort });
    expect(f.stream).toHaveBeenCalledOnce();
    const { row, result: receipt } = f.readback();
    expect(row).toMatchObject({ status: "done", model: "openai/gpt-5.2", thinking: effort });
    expect(row.agentName).toBeUndefined();
    expect(receipt).toMatchObject({ executedModel: "openai/gpt-5.2", executedThinking: effort });
  });

  it.each([undefined, "smol"])("inherits parent high for a named inherited tier %s", async (profileModel) => {
    const f = await thinkingFixture({ profileModel });
    f.h.pi.setThinkingLevel?.("high");

    await f.h.commands.get("agent")!.handler("run reviewer Return READY", f.h.ctx as ExtensionCommandContext);

    expect(f.captured[0]).toMatchObject({ model: strong, thinkingLevel: "high" });
    expect(f.readback().result).toMatchObject({ executedThinking: "high" });
  });

  it.each([
    { profileModel: "openai/gpt-5.2:medium", roles: {}, requested: "medium", actual: "medium" },
    { profileModel: "smol", roles: { smol: "openai/gpt-5.2:xhigh" }, requested: "xhigh", actual: "xhigh" },
    { profileModel: "openai/gpt-5.2", roles: {}, requested: undefined, actual: "low" },
    { profileModel: "smol", roles: { smol: "openai/gpt-5.2" }, requested: undefined, actual: "low" },
  ] as const)("resolves $profileModel with SDK effort $requested and readback $actual", async (route) => {
    const f = await thinkingFixture({ profileModel: route.profileModel });
    writeGlobalModelRoles(f.root, route.roles);
    f.h.pi.setThinkingLevel?.("high");

    const result = await runTool(f.h, "spawn_agent", { agent: "reviewer", task: "Return READY" });

    expect(result.isError).not.toBe(true);
    expect(f.captured[0]?.thinkingLevel).toBe(route.requested);
    expect(f.readback().result).toMatchObject({ executedModel: "openai/gpt-5.2", executedThinking: route.actual });
  });

  it.each([undefined, "smol"])("uses SDK per-model fallback when parent thinking is unknown (%s)", async (agent) => {
    const f = await thinkingFixture({ profileModel: agent });
    delete f.h.pi.getThinkingLevel;
    f.settingsManager.setModelThinkingLevel("openai", "gpt-5.2", "medium");

    await runTool(f.h, "spawn_agent", { ...(agent === undefined ? {} : { agent: "reviewer" }), task: "Return READY" });

    expect(f.captured[0]).not.toHaveProperty("thinkingLevel");
    expect(f.readback().result).toMatchObject({ executedThinking: "medium" });
  });

  it.each(["thinking-level: xhigh", "thinkingLevel: xhigh"])("leaves separate profile %s inert", async (field) => {
    const f = await thinkingFixture({ profileModel: "openai/gpt-5.2", profileThinking: field });
    f.h.pi.setThinkingLevel?.("high");
    f.settingsManager.setModelThinkingLevel("openai", "gpt-5.2", "medium");

    await runTool(f.h, "spawn_agent", { agent: "reviewer", task: "Return READY" });

    expect(f.captured[0]).not.toHaveProperty("thinkingLevel");
    expect(f.readback().result).toMatchObject({ executedThinking: "medium" });
  });

  it.each([
    { model: limited, actual: "high" },
    { model: nonReasoning, actual: "off" },
  ] as const)("keeps SDK capability clamping for $model.id", async ({ model, actual }) => {
    const f = await thinkingFixture();
    f.h.ctx.model = model;
    f.h.pi.setThinkingLevel?.("xhigh");

    await runTool(f.h, "spawn_agent", { task: "Return READY" });

    expect(f.captured[0]?.thinkingLevel).toBe("xhigh");
    expect(f.readback().row).toMatchObject({ thinking: actual });
    expect(f.readback().result).toMatchObject({ executedThinking: actual });
  });

  it("leaves unavailable child thinking readback absent despite a known request", async () => {
    const f = await thinkingFixture({ hideThinking: true });
    f.h.pi.setThinkingLevel?.("high");

    await runTool(f.h, "spawn_agent", { task: "Return READY" });

    expect(f.captured[0]?.thinkingLevel).toBe("high");
    expect(f.readback().row.thinking).toBeUndefined();
    expect(f.readback().result).not.toHaveProperty("executedThinking");
  });

  it.each(["openai/missing:high", "openai/gpt-5.2:invalid"])("refuses %s before SDK creation", async (selector) => {
    const f = await thinkingFixture({ profileModel: "smol" });
    writeGlobalModelRoles(f.root, { smol: selector });
    f.h.pi.setThinkingLevel?.("high");

    const result = await runTool(f.h, "spawn_agent", { agent: "reviewer", task: "Return READY" });

    expect(result.isError).toBe(true);
    expect(f.captured).toEqual([]);
    expect(f.stream).not.toHaveBeenCalled();
    expect([...f.agentLiveStore.rows.values()].at(-1)).toMatchObject({ status: "error" });
    expect([...f.agentLiveStore.rows.values()].at(-1)?.thinking).toBeUndefined();
  });
});
