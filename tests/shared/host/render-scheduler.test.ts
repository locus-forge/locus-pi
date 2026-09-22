import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RENDER_MIN_INTERVAL_MS, RenderScheduler } from "../../../extensions/_shared/host/render-scheduler.js";

describe("RenderScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders synchronously on the leading edge", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render);

    scheduler.request();

    expect(render).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });

  it("collapses a burst into one leading render plus one trailing render", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render);

    for (let index = 0; index < 50; index += 1) scheduler.request();

    expect(render).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(true);

    vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);

    expect(render).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(false);

    // The window drained; no further work is queued.
    vi.advanceTimersByTime(5_000);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("treats a request after an idle window as a fresh leading edge", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render);

    scheduler.request();
    vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
    scheduler.request();

    expect(render).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(false);
  });

  it("flush renders immediately, cancels the trailing render, and reopens the window", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render);

    scheduler.request(); // leading
    scheduler.request(); // arms trailing
    expect(scheduler.pending).toBe(true);

    scheduler.flush();

    expect(render).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(false);

    // flush re-anchored the window, so the armed trailing render did not survive it.
    vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("cancel drops the trailing render without rendering", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render);

    scheduler.request();
    scheduler.request();
    render.mockClear();

    scheduler.cancel();
    vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);

    expect(render).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(false);
  });

  it("leads immediately again after a cancel", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render);

    scheduler.request();
    scheduler.request();
    scheduler.cancel();
    vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
    render.mockClear();

    scheduler.request();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("renders every request synchronously when throttling is disabled", () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render, { minIntervalMs: 0 });

    for (let index = 0; index < 5; index += 1) scheduler.request();

    expect(render).toHaveBeenCalledTimes(5);
    expect(scheduler.pending).toBe(false);
  });

  it("honours an injected clock", () => {
    let clock = 1_000;
    const render = vi.fn();
    const scheduler = new RenderScheduler(render, { minIntervalMs: 100, now: () => clock });

    scheduler.request();
    expect(render).toHaveBeenCalledTimes(1);

    clock += 50; // inside the window
    scheduler.request();
    expect(render).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(true);

    vi.advanceTimersByTime(50);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
