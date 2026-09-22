/**
 * long-timer.ts — one wall-clock wait of any length, built from waits Node can
 * actually represent.
 *
 * `setTimeout` silently clamps any delay above 2^31-1 ms to ONE millisecond. A
 * deadline an operator chose deliberately — a 48-hour run, a two-day child — is
 * therefore the exact input that turns into an immediate abort, and the failure
 * reads as "the agent timed out", not as "this host cannot count that high".
 *
 * The previous answer was a policy ceiling (`WORKFLOW_MAX_TIMEOUT_MS`): refuse the
 * long deadline so the clamp can never happen. That made a host implementation
 * detail into a limit on what an operator may ask for. This module removes the
 * need for the ceiling instead: a long wait is a CHAIN of representable waits, and
 * the caller's callback fires once, when the whole span has elapsed.
 *
 * Pure timers. No fs / process / network, so both the agent host and the workflow
 * runtime can depend on it.
 */

/** Node clamps any larger delay to 1 ms, which is why this module exists. */
export const NODE_TIMER_MAX_DELAY_MS = 2_147_483_647;

/** Cancels a pending chained wait. Safe to call after it already fired. */
export type CancelLongTimeout = () => void;

/**
 * Refuse a delay no clock could honour BEFORE anything is spent on the work it
 * would bound. Length is not the failure here — `scheduleLongTimeout` covers any
 * span — so only a value that is not a whole, countable number of milliseconds is
 * refused, and it is refused by name.
 */
export function assertRepresentableDelayMs(delayMs: number, field = "timeout"): void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error(`${field} must be a non-negative safe integer number of milliseconds`);
  }
}

/**
 * Fire `onFire` once, `delayMs` from now, however large `delayMs` is.
 *
 * Every physical timer armed here is at or below `NODE_TIMER_MAX_DELAY_MS`, so no
 * delay is ever clamped. Cancelling stops the chain wherever it is: the returned
 * function clears the armed slice AND latches, so a slice already queued on the
 * event loop neither re-arms nor fires.
 */
export function scheduleLongTimeout(delayMs: number, onFire: () => void, field = "timeout"): CancelLongTimeout {
  assertRepresentableDelayMs(delayMs, field);
  let remainingMs = delayMs;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const sliceMs = Math.min(remainingMs, NODE_TIMER_MAX_DELAY_MS);
    remainingMs -= sliceMs;
    timer = setTimeout(() => {
      timer = undefined;
      if (cancelled) return;
      if (remainingMs > 0) {
        arm();
        return;
      }
      onFire();
    }, sliceMs);
  };
  arm();
  return () => {
    cancelled = true;
    remainingMs = 0;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
