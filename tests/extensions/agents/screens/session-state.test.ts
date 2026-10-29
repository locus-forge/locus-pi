import { describe, expect, it, vi } from "vitest";
import { AgentSessionState } from "../../../../extensions/_shared/agent-runtime/session/state.js";

describe("agent shutdown ownership", () => {
  it("global shutdown and repeated exit join an in-flight child exit", async () => {
    const state = new AgentSessionState<object>();
    const execution = {};
    let finish = () => {};
    const exit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    state.registerLifetime(execution, exit);
    const first = state.exit(execution);
    expect(state.exit(execution)).toBe(first);
    const settled = vi.fn();
    const shutdown = state.shutdown().then(settled);
    await Promise.resolve();
    expect(exit).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, shutdown]);
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe("failure cleanup", () => {
  it("waits for every agent even when one exit rejects", async () => {
    const state = new AgentSessionState<object>();
    const a = {},
      b = {};
    let finish = () => {};
    state.registerLifetime(a, async () => {
      throw new Error("failed turn");
    });
    state.registerLifetime(
      b,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const outcome = state.shutdown().catch((error: unknown) => error);
    await Promise.resolve();
    finish();
    expect(await outcome).toBeInstanceOf(AggregateError);
    await expect(state.shutdown()).resolves.toBeUndefined();
  });
});
