import type { CustomUiComponent, CustomUiTui } from "../../_shared/host/pi-api.js";
import { clamp, padLine } from "../../_shared/operator/viewer-geometry.js";

const CONTENT_LINE_COUNT = 18;
const LARGE_SCROLL_STEP = 9;
/** `│ ` + ` │` — the padded gutter this overlay shares with every other framed surface. */
const FRAME_SIDE_WIDTH = 4;
/** Content width assumed for keystrokes that arrive before the first render. */
const FALLBACK_CONTENT_WIDTH = 76;

export interface ScrollableTextOverlayOptions {
  /**
   * False when the supplier already draws its own frame (an operator block
   * does). The overlay then contributes only the scroll window and its control
   * line, so the operator sees one box rather than a box inside a box.
   */
  ownsFrame?: boolean;
}

/** Static catalog/inspect text overlay. Live agent viewing belongs to AgentSessionViewer. */
export class ScrollableTextOverlay implements CustomUiComponent {
  #scroll = 0;
  /**
   * Content width of the last frame handed to the host. Keystrokes clamp their
   * scroll against the same projection the screen is showing, which a
   * width-aware supplier can only produce when it is told the width.
   */
  #contentWidth = FALLBACK_CONTENT_WIDTH;
  readonly #ownsFrame: boolean;

  constructor(
    private readonly title: string | (() => string),
    private readonly bodyLines: (width: number) => string[],
    protected readonly tui: CustomUiTui,
    private readonly done: () => void,
    options: ScrollableTextOverlayOptions = {},
  ) {
    this.#ownsFrame = options.ownsFrame !== false;
  }

  render(width: number): string[] {
    const budget = Math.max(0, Math.floor(width));
    if (budget === 0) return [""];
    this.#contentWidth = Math.max(1, this.#ownsFrame ? budget - FRAME_SIDE_WIDTH : budget);
    const body = this.bodyLines(this.#contentWidth);
    const maxScroll = Math.max(0, body.length - CONTENT_LINE_COUNT);
    this.#scroll = clamp(this.#scroll, 0, maxScroll);
    const visibleBody = body.slice(this.#scroll, this.#scroll + CONTENT_LINE_COUNT);
    const footer = `q/esc close · ↑/k ↓/j scroll · ${this.#scroll + 1}-${Math.min(body.length, this.#scroll + visibleBody.length)}/${body.length}`;
    if (!this.#ownsFrame) return [...visibleBody, footer].map((line) => padLine(line, budget));
    const title = typeof this.title === "function" ? this.title() : this.title;
    return frameLines(title, visibleBody, footer, budget);
  }

  handleInput(data: string): void {
    const key = normalizeKey(data);
    if (key === "close") {
      this.done();
      return;
    }
    const maxScroll = Math.max(0, this.bodyLines(this.#contentWidth).length - CONTENT_LINE_COUNT);
    if (key === "up") this.#scroll -= 1;
    else if (key === "down") this.#scroll += 1;
    else if (key === "pageUp") this.#scroll -= LARGE_SCROLL_STEP;
    else if (key === "pageDown") this.#scroll += LARGE_SCROLL_STEP;
    else if (key === "home") this.#scroll = 0;
    else if (key === "end") this.#scroll = maxScroll;
    else return;
    this.#scroll = clamp(this.#scroll, 0, maxScroll);
    this.tui.requestRender();
  }

  invalidate(): void {}
}

/** Historical workflow rounds stay a journal-backed text fallback in the native viewer. */
export interface DrillRoundsConfig {
  active: number;
  list: number[];
  readBody: (round: number) => string[] | undefined;
}

function normalizeKey(data: string): "close" | "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "unknown" {
  if (data === "q" || data === "escape" || data === "\u001b") return "close";
  if (data === "up" || data === "k" || data === "\u001b[A") return "up";
  if (data === "down" || data === "j" || data === "\u001b[B") return "down";
  if (data === "pageUp" || data === "pageup" || data === "shift+up" || data === "\u001b[5~" || data === "\u001b[1;2A")
    return "pageUp";
  if (
    data === "pageDown" ||
    data === "pagedown" ||
    data === "shift+down" ||
    data === "\u001b[6~" ||
    data === "\u001b[1;2B"
  )
    return "pageDown";
  if (data === "home" || data === "\u001b[H" || data === "\u001b[1~") return "home";
  if (data === "end" || data === "\u001b[F" || data === "\u001b[4~") return "end";
  return "unknown";
}

function frameLines(title: string, body: string[], footer: string, width: number): string[] {
  if (width === 1) return ["╭", ...body.map(() => "│"), "╰"];
  if (width === 2) return ["╭╮", ...body.map(() => "││"), "╰╯"];
  const horizontal = "─".repeat(width - 2);
  // Below five columns the padded gutter leaves no room for a single content
  // cell, so the frame degrades to its edges rather than overflowing the budget.
  if (width < FRAME_SIDE_WIDTH + 1) {
    const hollow = `│${" ".repeat(width - 2)}│`;
    return [`╭${horizontal}╮`, ...body.map(() => hollow), `╰${horizontal}╯`];
  }
  const innerWidth = width - FRAME_SIDE_WIDTH;
  const framed = (line: string) => `│ ${padLine(line, innerWidth)} │`;
  return [
    `╭${horizontal}╮`,
    framed(title),
    `├${horizontal}┤`,
    ...body.map(framed),
    `├${horizontal}┤`,
    framed(footer),
    `╰${horizontal}╯`,
  ];
}
