import type { CustomUiComponent, ExtensionContext, WidgetFactoryTui } from "../host/pi-api.js";
import { setDismissibleView } from "./command-ui.js";
import {
  renderOperatorBlock,
  renderOperatorBlockPlain,
  type OperatorBlock,
  type OperatorThemeLike,
} from "./operator-ui.js";

/**
 * Widget placement policy (single source of truth — T-188 Q1).
 *
 * - Generic LIVE "work" surfaces render ABOVE the editor.
 * - The interactive fleet is the deliberate exception: it renders BELOW the
 *   editor so its passive rows stay in place while `ctx.ui.custom()` temporarily
 *   replaces only the editor to capture management keys (REQ-007).
 * - Passive VIEW surfaces (settings / help / catalog / list) render BELOW the
 *   editor.
 * - Settled CHANGE / RUN / RESULT / WARN / ERROR surfaces render ABOVE the
 *   editor. INPUT / SELECT are normally host-owned focus surfaces; their
 *   passive fallback also renders above.
 *
 * Host support for `placement` is `pi-api.ts` `ctx.ui.setWidget(..., { placement })`.
 * Live surfaces must import LIVE_WORK_PLACEMENT rather than hard-coding the string,
 * so the rule stays defined in exactly one place.
 */
export const LIVE_WORK_PLACEMENT = "aboveEditor" as const;
export const FLEET_MENU_PLACEMENT = "belowEditor" as const;
export const SETTINGS_HELP_PLACEMENT = "belowEditor" as const;

/**
 * The host clamps a string[] widget to this many lines by slicing the tail, so a
 * block rendered past it loses its controls with no notice to the operator. Our
 * own budget must match it exactly: over-rendering hands the decision of what to
 * drop to a host that has no idea which lines carry recovery instructions.
 */
export const HOST_STRING_ARRAY_WIDGET_LINES = 10;

export function operatorBlockPlacement(block: Pick<OperatorBlock, "type">): "aboveEditor" | "belowEditor" {
  return block.type === "VIEW" ? SETTINGS_HELP_PLACEMENT : LIVE_WORK_PLACEMENT;
}

export interface SetOperatorWidgetOptions {
  placement?: "aboveEditor" | "belowEditor";
  fallbackWidth?: number;
  /** Hide this presentation while another view uses its rows. Returns its restore callback if still mounted. */
  onOverflow?: (hide: () => (() => void) | undefined) => void;
}

class OperatorBlockWidget implements CustomUiComponent {
  private overflowReported = false;
  private hidden = false;
  private disposed = false;
  constructor(
    private readonly tui: WidgetFactoryTui,
    private readonly block: OperatorBlock,
    private readonly theme?: OperatorThemeLike,
    private readonly onOverflow?: SetOperatorWidgetOptions["onOverflow"],
    private readonly setPresented?: (presented: boolean) => void,
  ) {
    // Presentation asks for a normal differential paint. A forced full redraw
    // here clears and repaints the whole frame for every operator block, which
    // reads as a blink on slow consoles (WSL). When this widget REPLACES an
    // older one, the outgoing widget's dispose() still forces the clearing
    // redraw, so nothing is left stale by keeping presentation differential.
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.hidden || this.disposed) return [];
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, Math.min(rows - 6, 48));
    if (!this.onOverflow) return renderOperatorBlock(this.block, width, this.theme, { maxLines: budget });
    try {
      const lines = renderOperatorBlock(this.block, width, this.theme);
      if (lines.length <= budget) return lines;
      this.reportOverflow();
      return renderOperatorBlock(this.block, width, this.theme, { maxLines: budget });
    } catch {
      this.reportOverflow();
      return [];
    }
  }

  private reportOverflow(): void {
    if (this.overflowReported || !this.onOverflow) return;
    this.overflowReported = true;
    queueMicrotask(() => this.onOverflow?.(() => this.hide()));
  }

  private hide(): (() => void) | undefined {
    if (this.disposed || this.hidden) return undefined;
    this.hidden = true;
    this.setPresented?.(false);
    this.tui.requestRender();
    return () => {
      // Pi disposes this component whenever the key is replaced or cleared.
      if (this.disposed || !this.hidden) return;
      this.hidden = false;
      this.setPresented?.(true);
      this.tui.requestRender();
    };
  }

  invalidate(): void {
    // The block is projected from source on every render; no styled output is cached.
  }

  dispose(): void {
    this.disposed = true;
    // Full redraw clears cells outside a replacement/shrunk frame. A normal
    // differential render can preserve stale glyphs in terminal scrollback.
    this.tui.requestRender(true);
  }
}

/**
 * Deliver a typed operator block through the host mode's supported widget path.
 * The adapter registers only passive VIEW dismissibility; it does not own
 * domain cleanup or create transcript/session messages.
 */
export function setOperatorWidget(
  ctx: ExtensionContext,
  key: string,
  block: OperatorBlock,
  options: SetOperatorWidgetOptions = {},
): void {
  if (ctx.hasUI === false) return;

  const placement = { placement: options.placement ?? operatorBlockPlacement(block) };
  if (ctx.mode === "tui") {
    const setPresented = (presented: boolean) => setDismissibleView(ctx, key, presented && block.type === "VIEW");
    ctx.ui.setWidget(
      key,
      (tui, theme) =>
        new OperatorBlockWidget(
          tui as WidgetFactoryTui,
          block,
          operatorTheme(theme) ?? ctx.ui.theme,
          options.onOverflow,
          setPresented,
        ),
      placement,
    );
    setPresented(true);
    return;
  }

  ctx.ui.setWidget(
    key,
    renderOperatorBlockPlain(block, options.fallbackWidth ?? 80, {
      maxLines: HOST_STRING_ARRAY_WIDGET_LINES,
    }),
    placement,
  );
}

function operatorTheme(value: unknown): OperatorThemeLike | undefined {
  return typeof value === "object" && value !== null ? (value as OperatorThemeLike) : undefined;
}
