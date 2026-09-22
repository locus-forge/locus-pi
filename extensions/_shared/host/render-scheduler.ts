/**
 * Render coalescing for live TUI surfaces.
 *
 * The agent live store emits one `change` per mutation, and a streaming child
 * agent mutates its row on every SDK event — tool start/end, token deltas,
 * transcript appends. Each subscriber turning that straight into a
 * `requestRender()` produces render storms measured in hundreds of frames per
 * second, of which at most a handful carry a visible difference.
 *
 * On a fast Linux TTY the surplus frames are merely wasteful. Across the WSL
 * console boundary each frame is a real cross-process write, so the queue backs
 * up and the panel visibly tears and flickers. Coalescing is therefore a
 * correctness fix for the slow terminal and a pure saving everywhere else,
 * which is why it is unconditional rather than gated on platform detection.
 *
 * The schedule is leading-edge + trailing-edge:
 *
 *   - the FIRST request in an idle window renders synchronously, so a surface
 *     never appears to lag behind the state change that caused it;
 *   - further requests inside the window are absorbed into a single trailing
 *     render at the end of it, so the last state is never dropped.
 *
 * Callers keep interactive repaints (keystrokes, cursor movement) on the direct
 * `requestRender()` path. Human input is already rate-limited, and routing it
 * through the scheduler would add latency exactly where it is most visible.
 */

/**
 * 4 fps. Chosen against the two cadences it sits between: it must stay BELOW
 * the 1 Hz liveness tick that drives the spinner and elapsed counters, so that
 * tick always lands on a leading edge and liveness is never reduced; and it
 * must stay ABOVE the millisecond spacing of SDK event bursts, so a burst
 * collapses to one frame. Text dashboards do not read as animation below ~10
 * fps, and 4 fps leaves a slow console 5-10x headroom per frame write.
 */
export const DEFAULT_RENDER_MIN_INTERVAL_MS = 250;

export interface RenderSchedulerOptions {
  /** Minimum ms between renders. `0` disables throttling — every request renders synchronously. */
  minIntervalMs?: number;
  /** Clock seam for tests; defaults to `Date.now`. */
  now?: () => number;
}

export class RenderScheduler {
  readonly #render: () => void;
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Start of the current window. `undefined` means idle — the next request is a
   * leading edge. Never read as a timestamp without that guard.
   */
  #lastRenderAt: number | undefined;

  constructor(render: () => void, options: RenderSchedulerOptions = {}) {
    this.#render = render;
    this.#minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_RENDER_MIN_INTERVAL_MS);
    this.#now = options.now ?? Date.now;
  }

  /** True while a trailing render is armed. */
  get pending(): boolean {
    return this.#timer !== undefined;
  }

  /**
   * Ask for a render. Renders now on a leading edge, otherwise folds into the
   * one already-armed trailing render.
   */
  request(): void {
    if (this.#minIntervalMs === 0) {
      this.#renderNow();
      return;
    }
    if (this.#timer !== undefined) return; // already folded into the armed trailing render
    const last = this.#lastRenderAt;
    const waited = last === undefined ? Number.POSITIVE_INFINITY : this.#now() - last;
    if (waited >= this.#minIntervalMs) {
      this.#renderNow();
      return;
    }
    this.#arm(this.#minIntervalMs - waited);
  }

  /**
   * Render immediately and reopen the window. Use for frames that must not be
   * lost or deferred — a run's terminal verdict, for instance.
   */
  flush(): void {
    this.#clearTimer();
    this.#renderNow();
  }

  /** Drop any armed trailing render without rendering. Use on teardown. */
  cancel(): void {
    this.#clearTimer();
  }

  #arm(delayMs: number): void {
    const timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#renderNow();
      },
      Math.max(0, delayMs),
    );
    (timer as { unref?: () => void }).unref?.();
    this.#timer = timer;
  }

  #renderNow(): void {
    this.#lastRenderAt = this.#now();
    this.#render();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Byte-identity of two frames. The companion to the scheduler: throttling
 * bounds how often a surface may repaint, this decides whether the repaint is
 * worth requesting at all. On consoles where every repaint blinks (WSL), a
 * frame equal to what is already on screen must never reach the terminal.
 */
export function framesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => line === b[index]);
}
