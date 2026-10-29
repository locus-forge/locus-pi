import { expect, it, vi } from "vitest";
import { AgentPicker } from "../../../../extensions/agents/fleet/agent-picker.js";
import { AgentScreenController } from "../../../../extensions/agents/fleet/agent-screen-controller.js";
import { createHarness } from "../../../test-harness.js";

it("retains selection by stable ID when the registry changes", () => {
  let entries = [
    { id: "main", label: "main" },
    { id: "a", label: "A" },
  ];
  const choose = vi.fn();
  const picker = new AgentPicker(
    () => entries,
    "a",
    choose,
    () => {},
    () => {},
  );
  entries = [{ id: "b", label: "B" }, ...entries];
  picker.handleInput("\r");
  expect(choose).toHaveBeenCalledWith("a");
});
it("bare main /ps uses only an inline widget and releases its input handler on dismissal", async () => {
  const h = createHarness();
  h.ctx.hasUI = true;
  h.ctx.mode = "tui";
  const custom = vi.spyOn(h.ctx.ui, "custom");
  const controller = new AgentScreenController();
  const before = h.terminalInputHandlers.size;
  await controller.open(h.ctx);
  expect(custom).not.toHaveBeenCalled();
  expect(h.terminalInputHandlers.size).toBe(before + 1);
  for (const handler of h.terminalInputHandlers) handler("\u001b");
  expect(h.terminalInputHandlers.size).toBe(before);
  controller.close(true);
});

it("does not silently choose main when the selected agent disappears", () => {
  let entries = [
    { id: "main", label: "main" },
    { id: "a", label: "A" },
  ];
  const choose = vi.fn();
  const picker = new AgentPicker(
    () => entries,
    "a",
    choose,
    () => {},
    () => {},
  );
  entries = entries.slice(0, 1);
  picker.handleInput("\r");
  expect(choose).not.toHaveBeenCalled();
});
it("Escape dismisses main picker before the earlier interrupt guard can cancel work", async () => {
  const { installAgentInterruptGuard } = await import("../../../../extensions/agents/fleet/interrupt-guard.js");
  const { agentLiveStore } = await import("../../../../extensions/_shared/agent-runtime/agent-live-store.js");
  const h = createHarness();
  h.ctx.hasUI = true;
  h.ctx.mode = "tui";
  h.ctx.isIdle = () => false;
  const abort = vi.fn();
  h.ctx.abort = abort;
  const confirm = vi.spyOn(h.ctx.ui, "confirm");
  installAgentInterruptGuard(h.ctx);
  agentLiveStore.beginExecution({ id: "picker-guard", label: "working" });
  const controller = new AgentScreenController();
  await controller.open(h.ctx);
  for (const handler of [...h.terminalInputHandlers]) {
    if (handler("\u001b")?.consume) break;
  }
  expect(confirm).not.toHaveBeenCalled();
  expect(abort).not.toHaveBeenCalled();
  controller.close(true);
  agentLiveStore.reset();
});
