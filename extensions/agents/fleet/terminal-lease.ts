import { TuiAltScreen, type TUI, type Component } from "@earendil-works/pi-tui";

/** Route native viewport keys through the public scroll API, not private input listeners. */
export class AgentTerminalScreen extends TuiAltScreen {
  #root: (Component & { scrollDetailsBy?(lines: number): void }) | undefined;

  override setLayoutRoot(component: Component | undefined): void {
    this.#root = component;
    super.setLayoutRoot(component);
  }

  override scrollBy(lines: number): void {
    if (this.#root?.scrollDetailsBy) this.#root.scrollDetailsBy(lines);
    else super.scrollBy(lines);
  }

  override scrollToTop(): void {
    if (this.#root?.scrollDetailsBy) this.#root.scrollDetailsBy(-Number.MAX_SAFE_INTEGER);
    else super.scrollToTop();
  }

  override scrollToBottom(): void {
    if (this.#root?.scrollDetailsBy) this.#root.scrollDetailsBy(Number.MAX_SAFE_INTEGER);
    else super.scrollToBottom();
  }
}

/** Exclusive terminal ownership. The inactive renderer keeps its model, never its input loop. */
export class AgentTerminalLease {
  readonly screen: TuiAltScreen;
  #active = false;
  #closed = false;

  constructor(private readonly host: TUI) {
    this.screen = new AgentTerminalScreen(host.terminal, host.getShowHardwareCursor(), undefined, {
      scrollToEndIndicator: () => " Jump to latest message ",
    });
  }

  start(): void {
    if (this.#active) return;
    this.#closed = false;
    this.host.stop({ preserveScreen: true });
    this.#active = true;
    try {
      this.screen.start();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(restoreHost = true): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#active) return;
    this.#active = false;
    try {
      this.screen.stop({ preserveScreen: true });
    } finally {
      if (restoreHost) {
        this.host.start();
        this.host.requestRender(true);
      }
    }
  }
}

export function supportsAgentTerminal(tui: unknown): tui is TUI {
  const value = tui as Partial<TUI> | undefined;
  return (
    value?.terminal !== undefined &&
    typeof value.start === "function" &&
    typeof value.stop === "function" &&
    typeof value.getShowHardwareCursor === "function"
  );
}
