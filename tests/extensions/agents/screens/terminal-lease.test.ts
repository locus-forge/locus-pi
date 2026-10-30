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

it("routes native page keys to mounted center details, then restores ordinary viewport scrolling", async () => {
  const { AgentTerminalScreen } = await import("../../../../extensions/agents/fleet/terminal-lease.js");
  const { TuiAltScreen } = await import("@earendil-works/pi-tui");
  let input: ((data: string) => void) | undefined;
  const terminal = new Proxy(
    {
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      start(onInput: (data: string) => void) {
        input = onInput;
      },
    },
    {
      get(target, key) {
        return Reflect.get(target, key) ?? (() => {});
      },
    },
  );
  const screen = new AgentTerminalScreen(terminal as unknown as TUI["terminal"]);
  const scrollDetailsBy = vi.fn();
  const root = { render: () => ["center"], invalidate() {}, scrollDetailsBy };
  const nativeScroll = vi.spyOn(TuiAltScreen.prototype, "scrollBy");
  screen.setLayoutRoot(root);
  screen.setFocus(root);
  screen.start();
  try {
    input!("\u001b[6~");
    expect(scrollDetailsBy).toHaveBeenLastCalledWith(expect.any(Number));
    expect(scrollDetailsBy.mock.calls.at(-1)![0]).toBeGreaterThan(0);
    input!("\u001b[5~");
    expect(scrollDetailsBy.mock.calls.at(-1)![0]).toBeLessThan(0);
    expect(nativeScroll).not.toHaveBeenCalled();
    screen.setLayoutRoot({ render: () => ["conversation"], invalidate() {} });
    input!("\u001b[6~");
    expect(nativeScroll).toHaveBeenCalledOnce();
    screen.setLayoutRoot(undefined);
    input!("\u001b[6~");
    expect(nativeScroll).toHaveBeenCalledTimes(2);
    expect(scrollDetailsBy).toHaveBeenCalledTimes(2);
  } finally {
    screen.stop();
    nativeScroll.mockRestore();
  }
});
