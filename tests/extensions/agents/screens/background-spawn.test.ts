import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHarness, emit, runTool } from "../../../test-harness.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import agents from "../../../../extensions/agents/index.js";
import workflows from "../../../../extensions/workflows/index.js";
import { registerAgentCommands } from "../../../../extensions/agents/command/command-router.js";
import {
  currentCommandWidgetPresentation,
  pinTransientUiKey,
  setCommandWidget,
} from "../../../../extensions/_shared/operator/command-ui.js";
import { setWorkflowLaunchStatus } from "../../../../extensions/workflows/operator/operator-surface.js";
import { WORKFLOW_LIVE_WIDGET_KEY } from "../../../../extensions/workflows/operator/progress-widget.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
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

it("preserves actual spawn_agent pins until the last child settles through registered workflow cleanup", async () => {
  const h = createHarness(undefined, { isStreaming: true, sessionId: "tool-pin-proof" });
  h.ctx.hasUI = true;
  agents(h.pi);
  workflows(h.pi);
  await emit(h, "session_start");
  await h.commands.get("agent")!.handler("owner binding", h.ctx);
  vi.spyOn(h.ctx.ui, "select").mockResolvedValue(undefined);
  const registry = workflowBackgroundRunRegistry();
  const lease = registry.startSession(h.ctx.session!.projectRoot!, h.ctx.session!.id);
  const parent = new AbortController();
  let finishWorkflow!: () => void;
  const workflow = registry.attach(
    lease,
    parent.signal,
    () =>
      new Promise<void>((resolve) => {
        finishWorkflow = resolve;
      }),
  );
  if (!workflow.ok) throw new Error("Fixture workflow did not attach");
  await Promise.resolve();
  pinTransientUiKey(h.pi, WORKFLOW_LIVE_WIDGET_KEY);
  const progress = ["Pinned workflow fixture progress"];
  setCommandWidget(h.ctx, WORKFLOW_LIVE_WIDGET_KEY, progress);
  setWorkflowLaunchStatus(h.ctx, "fixture", "live status");
  const status = h.statuses.get("locus");

  const releases: Array<() => void> = [];
  const cancel = vi.fn();
  execution.run.mockImplementation(async ({ rowId, label, signal }) => {
    const row = agentLiveStore.begin({ id: rowId, label, workflowRunId: "held" });
    agentLiveStore.patch(row.id, { status: "working" });
    agentLiveStore.registerCancel(row.id, cancel);
    signal.addEventListener("abort", cancel);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    agentLiveStore.patch(row.id, { status: "done" });
    return success;
  });
  const children = [
    runTool(h, "spawn_agent", { task: "First child", background: false }),
    runTool(h, "spawn_agent", { task: "Second child", background: false }),
  ];
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const payload = h.widgetPayloads.get("agents");
    const presentation = currentCommandWidgetPresentation(h.ctx, "agents");
    const rows = [...agentLiveStore.rows.keys()];
    expect(typeof payload).toBe("function");
    expect(presentation).toBeDefined();
    expect(rows).toHaveLength(2);

    const heldEscape = [...h.terminalInputHandlers].some((listener) => listener("\x1b[27u")?.consume);
    if (!heldEscape) {
      h.ctx.abort?.();
      parent.abort();
    }
    const run = h.commands.get("workflows")!.handler;
    await run("", h.ctx);
    expect(h.widgetPayloads.get("agents")).toBe(payload);
    expect(currentCommandWidgetPresentation(h.ctx, "agents")).toBe(presentation);
    expect(h.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBe(progress);
    expect(h.statuses.get("locus")).toBe(status);
    expect([...agentLiveStore.rows.keys()]).toEqual(rows);
    expect(rows.map((id) => agentLiveStore.rows.get(id)?.status)).toEqual(["working", "working"]);
    expect(registry.unsettled(lease)[0]).toMatchObject({ state: "running", stopRequested: false });
    expect(h.abortCalls).toBe(0);
    expect(h.confirmCalls).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();

    releases[0]?.();
    await children[0];
    await emit(h, "input", { text: "ordinary input", source: "interactive" });
    expect(h.widgetPayloads.get("agents")).toBe(payload);
    expect(currentCommandWidgetPresentation(h.ctx, "agents")).toBe(presentation);

    releases[1]?.();
    await children[1];
    await run("status unresolved", h.ctx);
    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(currentCommandWidgetPresentation(h.ctx, "agents")).toBeUndefined();
  } finally {
    for (const release of releases) release();
    finishWorkflow();
    await Promise.allSettled(children);
    await workflow.run.terminal;
    registry.shutdown(lease);
  }
});

it.each(["ps", "agent"] as const)("keeps the registry aligned with the existing physical %s clear", async (command) => {
  const h = createHarness();
  h.ctx.hasUI = true;
  registerAgentCommands(h.pi, {
    openFleetMenu: async () => {},
    openAgentScreen: async () => {},
    agentSessionAuthority: { capture: () => 1, isCurrent: () => true },
  });
  registerAgentSpawnTools(h.pi);
  const child = runTool(h, "spawn_agent", { task: "Held dialog", background: false });
  try {
    await vi.waitFor(() => expect(execution.run).toHaveBeenCalledOnce());
    expect(currentCommandWidgetPresentation(h.ctx, "agents")).toBeDefined();
    await h.commands.get(command)!.handler(command === "agent" ? "drill fixture" : "", h.ctx);
    expect(h.widgetPayloads.get("agents")).toBeUndefined();
    expect(currentCommandWidgetPresentation(h.ctx, "agents")).toBeUndefined();
  } finally {
    finish(success);
    await child;
  }
});
