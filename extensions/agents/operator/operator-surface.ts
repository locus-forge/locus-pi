/**
 * extensions/agents/operator/operator-surface.ts — the ctx-bound writes to the `agents`
 * widget/status lane: the bounded text widget the observer renders into, the
 * transient cleanup every command starts with, the inline scroll surface the
 * catalog falls back from, and the notifications an agents surface emits.
 */
import { truncate } from "../../_shared/agent-runtime/agent-live-panel.js";
import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../../_shared/operator/operator-interaction.js";
import { renderOperatorBlock, type OperatorBlock, type OperatorThemeLike } from "../../_shared/operator/operator-ui.js";
import type { CustomUiComponent, ExtensionCommandContext, ExtensionContext } from "../../_shared/host/pi-api.js";
import { setTextWidget } from "../../_shared/host/pi-api.js";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ScrollableTextOverlay } from "../fleet/drill-overlay.js";
import { AGENTS_WIDGET_FALLBACK_WIDTH } from "./operator-ui.js";
import { notifyOperator } from "../../_shared/operator/operator-notify.js";

export const AGENTS_WIDGET_KEY = "agents";
const AGENTS_WIDGET_MAX_LINES = 10;

/**
 * Routes a catalog text surface (list/inspect) through the inline scrollable
 * interaction when the host exposes custom UI, so output is never silently
 * clipped to AGENTS_WIDGET_MAX_LINES. Returns true when the interaction was
 * used; false signals the caller to fall back to the bounded text widget,
 * exactly as /agent drill does for headless hosts.
 */
export async function renderAgentBlockInteraction(
  ctx: ExtensionCommandContext,
  block: OperatorBlock,
): Promise<boolean> {
  if (ctx.mode !== "tui" || ctx.hasUI !== true || ctx.ui.custom === undefined) return false;
  const title = `[${block.type}] ${block.subject}`;
  clearAgentsTransient(ctx);
  try {
    await requestInlineOperatorInteraction<void>(ctx, (tui, theme, _keybindings, done) => {
      // The catalog is the same semantic block every other surface renders, so it
      // takes the same themed frame at the live terminal width instead of a
      // colorless 80-column snapshot. The block draws its own frame; the overlay
      // adds only the scroll window and its control line.
      const blockTheme = operatorTheme(theme) ?? ctx.ui.theme;
      const body = (width: number): string[] => renderOperatorBlock(block, width, blockTheme);
      return new ScrollableTextOverlay(title, body, tui, done, { ownsFrame: false });
    });
  } catch (error) {
    if (isStaleInlineOperatorInteractionError(error)) {
      // The scroll surface never made it to the screen, and the transient widget
      // was already cleared for it. Reporting success here left the operator with
      // a blank screen and no catalog at all, so the bounded widget renders
      // instead — the same fallback a host without custom UI gets.
      notifyInteractionEnded(ctx, error, "Agent catalog");
      return false;
    }
    throw error;
  }
  return true;
}

function operatorTheme(value: unknown): OperatorThemeLike | undefined {
  return typeof value === "object" && value !== null ? (value as OperatorThemeLike) : undefined;
}

export function setAgentsWidget(
  ctx: ExtensionContext,
  content: string,
  maxLines: number = AGENTS_WIDGET_MAX_LINES,
  wrap = false,
): void {
  const lines = content.split(/\r?\n/).map((line) => line.trimEnd());
  const component = new BoundedTextWidget(lines, maxLines, wrap);
  if (ctx.mode !== "tui") {
    setTextWidget(ctx, AGENTS_WIDGET_KEY, component.render(AGENTS_WIDGET_FALLBACK_WIDTH).join("\n"), {
      placement: "belowEditor",
    });
    return;
  }
  try {
    ctx.ui.setWidget(AGENTS_WIDGET_KEY, () => component, { placement: "belowEditor" });
  } catch {
    setTextWidget(ctx, AGENTS_WIDGET_KEY, component.render(AGENTS_WIDGET_FALLBACK_WIDTH).join("\n"), {
      placement: "belowEditor",
    });
  }
}

export function clearAgentsStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus(AGENTS_WIDGET_KEY, undefined);
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
  }
}

export function clearAgentsTransient(ctx: ExtensionContext): void {
  clearAgentsStatus(ctx);
  try {
    ctx.ui.setWidget(AGENTS_WIDGET_KEY, undefined);
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
  }
}

export class BoundedTextWidget implements CustomUiComponent {
  constructor(
    private readonly lines: string[],
    private readonly maxLines: number,
    /**
     * Structured proof lines (e.g. "Artifact: <path>") must survive intact for
     * tooling to grep — wrap them across lines instead of ellipsis-clipping,
     * which would corrupt the path. Prose content (catalog/observer text)
     * keeps the default clip behavior, which is more compact.
     */
    private readonly wrap: boolean = false,
  ) {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : AGENTS_WIDGET_FALLBACK_WIDTH;
    const rendered = this.wrap
      ? this.lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth))
      : this.lines.map((line) => truncate(line, safeWidth));
    if (rendered.length <= this.maxLines) return rendered;
    const visibleCount = Math.max(0, this.maxLines - 1);
    const hiddenCount = rendered.length - visibleCount;
    return [...rendered.slice(0, visibleCount), truncate(`more: ${hiddenCount} line(s) not shown`, safeWidth)];
  }

  invalidate(): void {
    // Static text widget owns no cache or external handles.
  }
}

export function notifyActiveAgentsContinue(ctx: ExtensionContext, prefix: string): void {
  const count = [...agentLiveStore.rows.values()].filter(
    (row) => row.status === "working" || row.status === "queued",
  ).length;
  if (count > 0) ctx.ui.notify(`${prefix} ${count} agent${count === 1 ? "" : "s"} continue running.`, "info");
}

/**
 * Pi shows one inline component at a time, so a newer prompt can take the screen
 * from an open fleet or viewer. Saying so is the difference between a surface
 * that closed for a reason and a command that looks broken, and both reasons are
 * worth saying: a takeover, and a lease that went stale — which also covers a
 * failure to read host session state, in a session that is very much alive and
 * waiting for its answer. The only silence left is a host that cannot deliver a
 * notification at all.
 */
export function notifyInteractionEnded(ctx: ExtensionContext, error: unknown, subject: string): void {
  if (!isStaleInlineOperatorInteractionError(error)) return;
  const message = isSupersededInlineOperatorInteractionError(error)
    ? `${subject} closed: another prompt took the screen. Run /ps again when it is answered.`
    : `${subject} did not open: this session's UI surface is no longer the one that asked. Run /ps again.`;
  try {
    ctx.ui.notify(message, "info");
  } catch {
    // A replaced session has nobody left to tell.
  }
}

/**
 * Best-effort append of a REQ-011 lifecycle line to the transcript surface. Guarded
 * so a host without a live UI (or a partial UI surface) degrades to a no-op rather
 * than throwing into the agent run.
 */
export function emitAgentEventLine(ctx: ExtensionContext, line: string, level: "info" | "warning" | "error"): void {
  notifyOperator(ctx, line, level);
}
