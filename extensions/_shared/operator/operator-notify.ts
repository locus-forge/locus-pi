/**
 * extensions/_shared/operator/operator-notify.ts — Best-effort operator notification.
 *
 * `ctx.ui.notify` is not available on every host: a headless session or a
 * partial UI surface throws, and a lifecycle line is never important enough to
 * fail the run that emitted it. Two extensions had each grown the same guarded
 * wrapper under different names (`notifyFallback`, `emitAgentEventLine`), which
 * meant "a missing UI must not break the run" was a decision recorded twice.
 *
 * The durable record is always the journal, transcript, or result artifact —
 * never this call.
 */

import type { ExtensionContext } from "../host/pi-api.js";

/** Notifies the operator when the host has a UI, and does nothing when it does not. */
export function notifyOperator(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Headless or partial UI host: the durable artifacts already hold this line.
  }
}
