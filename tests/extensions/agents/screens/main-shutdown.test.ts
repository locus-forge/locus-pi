import { expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { createHarness } from "../../../test-harness.js";
import type { ExtensionCommandContext } from "../../../../extensions/_shared/host/pi-api.js";

it("main exit aborts streaming main and joins main plus child before host shutdown", async () => {
  const h = createHarness();
  const ctx = h.ctx as ExtensionCommandContext;
  ctx.isIdle = () => false;
  const abort = vi.fn();
  ctx.abort = abort;
  let mainDone = () => {},
    childDone = () => {};
  ctx.waitForIdle = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        mainDone = resolve;
      }),
  );
  const shutdown = vi.fn();
  ctx.shutdown = shutdown;
  agents(h.pi);
  const execution = agentLiveStore.beginExecution({ id: "shutdown-child", label: "child" });
  const exit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        childDone = resolve;
      }),
  );
  agentLiveStore.registerAgentLifetime(execution, exit);
  const pending = h.commands.get("exit")!.handler("", ctx);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  expect(abort).toHaveBeenCalledOnce();
  expect(ctx.waitForIdle).toHaveBeenCalledOnce();
  expect(shutdown).not.toHaveBeenCalled();
  childDone();
  await Promise.resolve();
  expect(shutdown).not.toHaveBeenCalled();
  mainDone();
  await pending;
  expect(shutdown).toHaveBeenCalledOnce();
  agentLiveStore.reset();
});
