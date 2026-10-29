import { describe, expect, it, vi } from "vitest";
import { AgentTerminalLease } from "../../../../extensions/agents/fleet/terminal-lease.js";
import type { TUI } from "@earendil-works/pi-tui";

describe("exclusive terminal handoff", () => {
  it("stops host before starting child and restores once; can re-enter", () => {
    const events: string[] = [];
    const host = {
      terminal: {},
      getShowHardwareCursor: () => false,
      stop: () => events.push("host stop"),
      start: () => events.push("host start"),
      requestRender: vi.fn(),
    } as unknown as TUI;
    const lease = new AgentTerminalLease(host);
    vi.spyOn(lease.screen, "start").mockImplementation(() => {
      events.push("child start");
    });
    vi.spyOn(lease.screen, "stop").mockImplementation(() => {
      events.push("child stop");
    });
    lease.start();
    lease.start();
    lease.close();
    lease.close();
    expect(events).toEqual(["host stop", "child start", "child stop", "host start"]);
    lease.start();
    lease.close(true);
    expect(events.slice(4)).toEqual(["host stop", "child start", "child stop", "host start"]);
  });
  it("does not resurrect main on app shutdown", () => {
    const host = {
      terminal: {},
      getShowHardwareCursor: () => false,
      stop: vi.fn(),
      start: vi.fn(),
      requestRender: vi.fn(),
    } as unknown as TUI;
    const lease = new AgentTerminalLease(host);
    vi.spyOn(lease.screen, "start").mockImplementation(() => {});
    vi.spyOn(lease.screen, "stop").mockImplementation(() => {});
    lease.start();
    lease.close(false);
    lease.close();
    expect(host.start).not.toHaveBeenCalled();
  });
});
