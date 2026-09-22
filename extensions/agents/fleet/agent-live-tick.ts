import { defaultRenderProfile } from "../../_shared/host/render-profile.js";
import { AGENT_LIVE_SPINNER_FRAME_COUNT } from "../../_shared/agent-runtime/agent-live-panel.js";

/**
 * 1 Hz — slower than the render-scheduler's coalescing window, so a tick always
 * lands on a leading edge and costs one repaint, never a queued burst.
 */
export const AGENT_LIVE_TICK_MS = 1000;

export interface AgentLiveTickerOptions {
  /** Repaint request; called on every tick, calm or not. */
  onTick: () => void;
  /** Overrides the resolved profile; tests and hosts that already resolved calm. */
  calm?: boolean;
}

export interface AgentLiveTicker {
  /** Frame index for `statusMeta`; frozen at its current value under calm. */
  readonly spinnerIndex: number;
  readonly calm: boolean;
  /** Idempotent; every owner MUST call this from its own dispose. */
  stop(): void;
}

/**
 * The heartbeat of the agent drill screen, built to the pattern the workflow progress
 * panel already ran: one 1 Hz cadence for the `statusMeta` spinner and the elapsed text,
 * so a second surface animating the same row does not invent a second rhythm. The panel
 * keeps its own timer rather than calling this one, and deliberately: it starts and stops
 * with the working rows it can see (`progress-widget.ts:#startLiveTimer`), while a drill
 * ticks for as long as its screen is open.
 *
 * The timer runs for as long as the surface lives, calm or not — calm freezes the
 * FRAME, not the clock. Elapsed text still rolls over its buckets, and a frame
 * that changed nothing is then byte-identical and suppressed by the caller's own
 * identity gate rather than by a stopped interval. `unref` keeps it out of the
 * process's exit calculus; `stop()` is what actually ends it.
 *
 * Calm itself is NOT resolved here — `render-profile.ts` owns that decision for
 * every surface; this module only carries the resolved value so a caller reads
 * one source for both halves of the animation.
 */
export function startAgentLiveTicker(options: AgentLiveTickerOptions): AgentLiveTicker {
  const calm = options.calm ?? defaultRenderProfile().calm;
  let spinnerIndex = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (!calm) spinnerIndex = (spinnerIndex + 1) % AGENT_LIVE_SPINNER_FRAME_COUNT;
    options.onTick();
  }, AGENT_LIVE_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    get spinnerIndex() {
      return spinnerIndex;
    },
    calm,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
