import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NODE_TIMER_MAX_DELAY_MS,
  assertRepresentableDelayMs,
  scheduleLongTimeout,
} from "../../../extensions/_shared/runtime/long-timer.js";

/**
 * The failure this module exists for: `setTimeout` clamps any delay above
 * 2^31-1 ms to ONE millisecond, so the exact input an operator chose deliberately
 * — a two-day deadline — is the input that fires immediately and reads as "the
 * agent timed out".
 *
 * Fake timers here are not a convenience. A real 48-hour wait cannot be tested,
 * and the point under test is precisely WHEN each physical timer is armed and for
 * how long, which only a controlled clock can observe.
 */
describe("scheduleLongTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once at the end of a delay Node could never represent", () => {
    const fortyEightHours = 48 * 60 * 60 * 1000;
    let fired = 0;
    scheduleLongTimeout(fortyEightHours, () => {
      fired += 1;
    });

    // One millisecond short: a clamped single timer would have fired long ago.
    vi.advanceTimersByTime(fortyEightHours - 1);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    // And it does not fire again as the remaining chain would have unwound.
    vi.advanceTimersByTime(fortyEightHours);
    expect(fired).toBe(1);
  });

  it("never arms a physical timer above Node's maximum delay", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const span = NODE_TIMER_MAX_DELAY_MS * 3 + 12_345;
    scheduleLongTimeout(span, () => {});
    vi.advanceTimersByTime(span);

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    expect(delays.length).toBeGreaterThan(1);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(NODE_TIMER_MAX_DELAY_MS);
    // The slices are the whole span, not an approximation of it.
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(span);
    setTimeoutSpy.mockRestore();
  });

  it("still handles an ordinary short delay with a single timer", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let fired = 0;
    scheduleLongTimeout(250, () => {
      fired += 1;
    });
    vi.advanceTimersByTime(250);

    expect(fired).toBe(1);
    expect(setTimeoutSpy.mock.calls).toHaveLength(1);
    setTimeoutSpy.mockRestore();
  });

  it("cancels the whole chain, not just the slice currently armed", () => {
    // The failure a naive cancel would leave behind: a slice already queued on the
    // event loop re-arms the next one and the abandoned deadline eventually fires.
    const span = NODE_TIMER_MAX_DELAY_MS * 2;
    let fired = 0;
    const cancel = scheduleLongTimeout(span, () => {
      fired += 1;
    });

    vi.advanceTimersByTime(NODE_TIMER_MAX_DELAY_MS + 5);
    cancel();
    vi.advanceTimersByTime(span * 2);
    expect(fired).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is safe to cancel after it already fired", () => {
    let fired = 0;
    const cancel = scheduleLongTimeout(10, () => {
      fired += 1;
    });
    vi.advanceTimersByTime(10);
    expect(fired).toBe(1);
    expect(() => {
      cancel();
    }).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses a delay no clock could count (%s), naming the field",
    (delayMs) => {
      expect(() => scheduleLongTimeout(delayMs, () => {}, "agent timeoutMs")).toThrow(
        /agent timeoutMs must be a non-negative safe integer/u,
      );
      expect(() => {
        assertRepresentableDelayMs(delayMs, "agent timeoutMs");
      }).toThrow(/agent timeoutMs/u);
    },
  );
});
