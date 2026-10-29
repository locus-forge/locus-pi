import { TuiAltScreen, type TUI } from "@earendil-works/pi-tui";

/** Exclusive terminal ownership. The inactive renderer keeps its model, never its input loop. */
export class AgentTerminalLease {
  readonly screen: TuiAltScreen;
  #active = false;
  #closed = false;

  constructor(private readonly host: TUI) {
    this.screen = new TuiAltScreen(host.terminal, host.getShowHardwareCursor(), undefined, {
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
