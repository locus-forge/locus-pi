import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHarness, runTool } from "../../../test-harness.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
const execution = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../extensions/agents/run/run-launcher.js", async (original) => ({
  ...(await original<typeof import("../../../../extensions/agents/run/run-launcher.js")>()),
  runAgentLiveTask: execution.run,
}));
import { registerAgentSpawnTools } from "../../../../extensions/agents/tool/task-tool.js";
import { shutdownAgentCommands } from "../../../../extensions/agents/run/run-launcher.js";
let finish: (result: unknown) => void;
beforeEach(() => {
  execution.run.mockReset();
  execution.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  agentLiveStore.retainSessions = true;
});
afterEach(async () => {
  finish?.({ status: "cancelled", reason: "test end", diagnostics: [] });
  await shutdownAgentCommands();
  agentLiveStore.reset();
  agentLiveStore.retainSessions = false;
});
const success = {
  status: "completed",
  text: "Checked result",
  reason: "Checked result",
  diagnostics: [],
  evidence: {},
  lifecycleEntryIds: [],
};
it("interactive default returns queued immediately and status defaults nonblocking then collects exact completion", async () => {
  const h = createHarness();
  h.ctx.mode = "tui";
  registerAgentSpawnTools(h.pi);
  const queued = await runTool(h, "spawn_agent", { task: "Validate" });
  const handle = (queued.details as { handle: string }).handle;
  expect(queued.details).toMatchObject({ status: "queued" });
  expect(await runTool(h, "agent_status", { handle })).toMatchObject({ details: { status: "queued" } });
  finish(success);
  await new Promise((r) => setTimeout(r, 0));
  const result = await runTool(h, "agent_status", { handle });
  expect(result.content).toEqual([{ type: "text", text: "Checked result" }]);
});
it.each(["headless", "opt-out"])("preserves awaited result for %s", async (mode) => {
  const h = createHarness();
  h.ctx.mode = mode === "headless" ? "rpc" : "tui";
  registerAgentSpawnTools(h.pi);
  let returned = false;
  const pending = runTool(h, "spawn_agent", {
    task: "Validate",
    ...(mode === "opt-out" ? { background: false } : {}),
  }).then((r) => {
    returned = true;
    return r;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  finish(success);
  expect((await pending).content).toEqual([{ type: "text", text: "Checked result" }]);
});
it("scopes handles to owning session and retains detached failures", async () => {
  const h = createHarness();
  h.ctx.mode = "tui";
  registerAgentSpawnTools(h.pi);
  const queued = await runTool(h, "spawn_agent", { task: "Validate" });
  const handle = (queued.details as { handle: string }).handle;
  finish({ status: "failed", reason: "refused", diagnostics: [] });
  await new Promise((r) => setTimeout(r, 0));
  expect(await runTool(h, "agent_status", { handle })).toMatchObject({ isError: true });
  h.ctx.session!.id = "another-session";
  expect((await runTool(h, "agent_status", { handle })).content).toEqual([
    { type: "text", text: "Unknown agent handle for this session." },
  ]);
});
it("shutdown aborts and joins detached preflight before any late child can start", async () => {
  let release!: () => void;
  const created = vi.fn();
  execution.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    await new Promise<void>((r) => {
      release = r;
    });
    if (signal.aborted) return { status: "cancelled", reason: "cancelled before create", diagnostics: [] };
    created();
    return success;
  });
  const h = createHarness();
  h.ctx.mode = "tui";
  registerAgentSpawnTools(h.pi);
  await runTool(h, "spawn_agent", { task: "Validate" });
  const stopped = shutdownAgentCommands();
  release();
  await stopped;
  expect(created).not.toHaveBeenCalled();
});

it("explicit status wait joins completion; cancelling that wait leaves child running", async () => {
  const h = createHarness();
  h.ctx.mode = "tui";
  registerAgentSpawnTools(h.pi);
  const queued = await runTool(h, "spawn_agent", { task: "Validate" });
  const handle = (queued.details as { handle: string }).handle;
  const controller = new AbortController();
  const wait = h.tools.get("agent_status")!.execute("wait", { handle, wait: true }, controller.signal, () => {}, h.ctx);
  controller.abort();
  expect(await wait).toMatchObject({ isError: true });
  expect((execution.run.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(false);
  const nextWait = runTool(h, "agent_status", { handle, wait: true });
  finish(success);
  expect((await nextWait).content).toEqual([{ type: "text", text: "Checked result" }]);
});
it("refuses already-aborted launch and invalidates handles on session generation change", async () => {
  const h = createHarness();
  h.ctx.mode = "tui";
  registerAgentSpawnTools(h.pi);
  const controller = new AbortController();
  controller.abort();
  expect(
    await h.tools.get("spawn_agent")!.execute("call", { task: "Validate" }, controller.signal, () => {}, h.ctx),
  ).toMatchObject({ isError: true });
  expect(execution.run).not.toHaveBeenCalled();
  const queued = await runTool(h, "spawn_agent", { task: "Validate" });
  const handle = (queued.details as { handle: string }).handle;
  const { emit } = await import("../../../test-harness.js");
  await emit(h, "session_start");
  expect(await runTool(h, "agent_status", { handle })).toMatchObject({ isError: true });
  finish(success);
});
it("a wait crossing session_start cannot return old-session result", async () => {
  const h = createHarness();
  h.ctx.mode = "tui";
  registerAgentSpawnTools(h.pi);
  const queued = await runTool(h, "spawn_agent", { task: "Validate" });
  const handle = (queued.details as { handle: string }).handle;
  const pending = runTool(h, "agent_status", { handle, wait: true });
  const { emit } = await import("../../../test-harness.js");
  await emit(h, "session_start");
  finish(success);
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("Checked result");
});
