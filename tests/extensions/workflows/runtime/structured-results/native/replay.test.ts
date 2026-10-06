import { VERSION } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { structuredSdk, nativeTurn } from "../../../../../fixtures/agent-runtime/structured-sdk.js";
import { createHarness } from "../../../../../test-harness.js";
import { createWorkflowStructuredReplayRoute } from "../../../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { createWorkflowRuntime } from "../../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  type WorkflowReplayEntry,
} from "../../../../../../extensions/workflows/runtime/workflow-replay.js";

const options = { schema: { type: "string" }, outputTransport: "native" as const };
const model = { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
async function resume(
  records: WorkflowReplayEntry[],
  current = model,
  tweak?: (ctx: any) => void,
  replayOptions: typeof options & { modelRole?: string } = options,
) {
  const root = mkdtempSync(path.join(tmpdir(), "native-replay-"));
  const harness = createHarness(root);
  harness.ctx.model = current;
  Object.assign(harness.ctx.modelRegistry!, {
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: () => undefined,
  });
  tweak?.(harness.ctx);
  let child = 0;
  const runtime = createWorkflowRuntime({
    runId: "resume",
    replaySourceRunId: "prior",
    structuredReplayHostVersion: async () => VERSION,
    structuredReplayRoute: createWorkflowStructuredReplayRoute({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
    }),
    structuredSourceIdentity: { sha256: "a".repeat(64), covered: true, inputSha256: "c".repeat(64) },
    replay: createWorkflowReplayController({ runDir: root, recorded: records }),
    agentRunner: async () => {
      child++;
      throw new Error("Replay must never dispatch");
    },
  });
  try {
    return { value: await runtime.dsl.agent("Return authoritative data", replayOptions), child };
  } catch (error) {
    return { error, child };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("v5 replay with fresh existing current model resolution", () => {
  it("uses the execution identity for a whitespace-padded current named profile", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "native-named-route-"));
    const harness = createHarness(root);
    harness.ctx.model = model;
    Object.assign(harness.ctx.modelRegistry!, {
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
    });
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "native-fixture.md"),
      "---\nname: native-fixture\ndescription: Isolated named fixture\n---\nReturn the requested result.\n",
    );
    const route = createWorkflowStructuredReplayRoute({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
    });
    try {
      const expected = await route({ agent: "native-fixture" });
      await expect(route({ agent: " native-fixture " })).resolves.toEqual(expected);
      await expect(route({ agent: " missing-profile " })).rejects.toThrow("unknown current agent profile");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["both", "config", "native"])("refuses missing current routing readback: %s", async (kind) => {
    const first = await structuredSdk(options, [nativeTurn()]);
    const result = await resume(first.replayRecord, model, (ctx) => {
      if (kind !== "native") delete ctx.modelRegistry.getRegisteredProviderConfig;
      if (kind !== "config") delete ctx.modelRegistry.getRegisteredNativeProvider;
    });
    expect(result.error).toMatchObject({ message: expect.stringContaining("readback unavailable") });
    expect(result.child).toBe(0);
  });
  it("reuses committed native data with zero child or auth lookup", async () => {
    const first = await structuredSdk(options, [nativeTurn()]);
    expect(first.error).toBeUndefined();
    let auth = 0;
    const replay = await resume(first.replayRecord, model, (ctx) => {
      ctx.modelRegistry.getApiKeyAndHeaders = () => {
        auth++;
        throw new Error("Auth is forbidden");
      };
      ctx.modelRegistry.refresh = () => {
        auth++;
        throw new Error("Refresh is forbidden");
      };
    });
    expect(replay).toEqual({ value: "known", child: 0 });
    expect(auth).toBe(0);
  });
  it("names the native contract when a committed replay record lacks its receipt", async () => {
    const first = await structuredSdk(options, [nativeTurn()]);
    const records = structuredClone(first.replayRecord);
    delete (records[0] as any).structuredReceipt;
    const result = await resume(records);
    expect(result.error).toMatchObject({ message: "replay-contract-failure: v5 receipt missing" });
    expect(result.child).toBe(0);
  });
  it.each([
    { ...model, id: "gpt-6-luna" },
    { ...model, id: "unknown-snapshot" },
    { ...model, api: "different" },
    { ...model, baseUrl: "https://proxy.invalid/v1" },
  ])("rejects changed inherited route %j without any child", async (current) => {
    const first = await structuredSdk(options, [nativeTurn()]);
    const result = await resume(first.replayRecord, current);
    expect(result.error).toBeDefined();
    expect(result.child).toBe(0);
  });
  it("refuses opaque public provider overrides without inspecting credentials", async () => {
    const first = await structuredSdk(options, [nativeTurn()]);
    const result = await resume(first.replayRecord, model, (ctx) => {
      ctx.modelRegistry.getRegisteredProviderConfig = () => ({
        streamSimple() {},
        get apiKey() {
          throw new Error("Never read credentials");
        },
      });
    });
    expect(result.error).toMatchObject({ message: expect.stringContaining("opaque") });
    expect(result.child).toBe(0);
  });
  it("rejects corrupt native source, wire, raw text, phase, ledger and cross-version provenance", async () => {
    const first = await structuredSdk(options, [nativeTurn()]);
    for (const mutate of [
      (record: any) => {
        record.structuredReceipt.version = 4;
      },
      (record: any) => {
        record.structuredReceipt.sourceIdentity = "b".repeat(64);
      },
      (record: any) => {
        record.structuredReceipt.schemaSha256 = "b".repeat(64);
      },
      (record: any) => {
        record.structuredReceipt.rawTurns[0].payload.wireSchemaSha256 = "b".repeat(64);
      },
      (record: any) => {
        record.structuredReceipt.rawTurns[0].payload.route.model = "gpt-6-luna";
      },
      (record: any) => {
        record.structuredReceipt.rawTurns[0].output.text = '{"value":"tampered"}';
      },
      (record: any) => {
        record.structuredReceipt.rawTurns[0].output.phase = "commentary";
      },
      (record: any) => {
        record.structuredReceipt.rawTurns[0].calls = [];
      },
      (record: any) => {
        record.structuredReceipt.spent.outputAttempts = 0;
      },
      (record: any) => {
        record.structuredReceipt.spent.toolCalls = -1;
      },
    ]) {
      const records = structuredClone(first.replayRecord);
      mutate(records[0]);
      const result = await resume(records);
      expect(result.error).toMatchObject({ message: expect.stringContaining("replay-contract-failure") });
      expect(result.child).toBe(0);
    }
  });
});

it("detects unchanged-role remapping through the current role table and concrete registry resolver", async () => {
  const roles = mkdtempSync(path.join(tmpdir(), "native-role-"));
  vi.stubEnv("PI_MODEL_ROLES_HOME", roles);
  const selected = { ...options, modelRole: "native-work" };
  try {
    const first = await structuredSdk(selected, [nativeTurn()]);
    expect(first.error).toBeUndefined();
    mkdirSync(path.join(roles, "model-roles"));
    writeFileSync(
      path.join(roles, "model-roles/config.json"),
      JSON.stringify({ version: 1, roles: { "native-work": "openai/gpt-6-luna" } }),
    );
    let lookups = 0;
    const replay = await resume(
      first.replayRecord,
      model,
      (ctx) => {
        ctx.modelRegistry.find = (provider: string, id: string) => {
          lookups++;
          return { ...model, provider, id };
        };
      },
      selected,
    );
    expect(replay.error).toMatchObject({ message: expect.stringContaining("native route") });
    expect(replay.child).toBe(0);
    expect(lookups).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    rmSync(roles, { recursive: true, force: true });
  }
});
