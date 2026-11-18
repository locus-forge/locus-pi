import { afterEach, expect, it, vi } from "vitest";
import { createHarness, runTool } from "../../../test-harness.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
const gate = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }));
vi.mock("../../../../extensions/_shared/model/model-settings.js", async (original) => {
  const real = await original<typeof import("../../../../extensions/_shared/model/model-settings.js")>();
  return {
    ...real,
    loadModelRolesState: async (root: string) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return real.loadModelRolesState(root);
    },
  };
});
import { registerAgentSpawnTools } from "../../../../extensions/agents/tool/task-tool.js";
import { shutdownAgentCommands } from "../../../../extensions/agents/run/run-launcher.js";
afterEach(async () => {
  gate.release?.();
  await shutdownAgentCommands();
  agentLiveStore.reset();
  agentLiveStore.retainSessions = false;
});
it("real detached tool preflight cannot create a row after shutdown while model-role file load is pending", async () => {
  const h = createHarness();
  h.ctx.mode = "tui";
  agentLiveStore.retainSessions = true;
  registerAgentSpawnTools(h.pi);
  const queued = await runTool(h, "spawn_agent", { task: "Must not execute", modelRole: "undeclared-qa-role" });
  expect(queued.details).toMatchObject({ status: "queued" });
  const shutdown = shutdownAgentCommands();
  gate.release?.();
  await shutdown;
  expect(agentLiveStore.rows.size).toBe(0);
  const result = await runTool(h, "agent_status", { handle: (queued.details as { handle: string }).handle });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("cancelled before dispatch");
});
