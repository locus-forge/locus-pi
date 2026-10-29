import { fleetMenuState } from "../../_shared/agent-runtime/fleet-menu.js";
import { coerceTheme } from "../../_shared/host/render-profile.js";
import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { AgentTerminalLease, supportsAgentTerminal } from "./terminal-lease.js";
import { AgentPicker } from "./agent-picker.js";
import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import { AgentScreen, agentPickerEntries } from "./agent-screen.js";

/** Owns one terminal handoff at a time; background agents never own terminal callbacks. */
export class AgentScreenController {
  #lease: AgentTerminalLease | undefined;
  #screen: AgentScreen | undefined;
  #done: (() => void) | undefined;
  #opening = false;
  #shutdown = false;
  #closePicker: (() => void) | undefined;

  async open(ctx: ExtensionContext, target = ""): Promise<void> {
    if (this.#shutdown || ctx.mode !== "tui" || !ctx.hasUI || ctx.ui.custom === undefined) return;
    if (target === "main") {
      this.close();
      return;
    }
    if (this.#screen !== undefined && this.#done !== undefined) {
      if (target === "") this.#screen.list();
      else await this.#screen.select(target);
      return;
    }
    if (target === "") {
      this.openMainPicker(ctx);
      return;
    }
    this.#closePicker?.();
    if (this.#opening) return;
    this.#opening = true;
    try {
      await ctx.ui.custom<void>(
        (host, theme, _keys, done) => {
          if (!supportsAgentTerminal(host)) throw new Error("Agent screens require Pi's terminal renderer API.");
          const lease = this.#lease ?? new AgentTerminalLease(host);
          this.#lease = lease;
          const screen =
            this.#screen ??
            new AgentScreen(
              lease.screen,
              () => this.close(),
              (message) => ctx.ui.notify(message, "error"),
              coerceTheme(theme),
            );
          this.#screen = screen;
          this.#done = () => done();
          // Pi mounts its inert slot in the next microtask. The child owns the terminal afterwards.
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (this.#shutdown || this.#lease !== lease || this.#done === undefined) return;
              void (async () => {
                try {
                  lease.start();
                  if (target === "") screen.list();
                  else await screen.select(target);
                } catch (error) {
                  this.close();
                  ctx.ui.notify(`Agent screen failed: ${String(error)}`, "error");
                }
              })();
            }),
          );
          return { render: () => [], invalidate() {}, dispose: () => this.close() };
        },
        { overlay: false },
      );
    } finally {
      this.#opening = false;
    }
  }

  private openMainPicker(ctx: ExtensionContext): void {
    this.#closePicker?.();
    if (ctx.ui.onTerminalInput === undefined) {
      ctx.ui.notify("Inline agent picker requires terminal input support; use /ps ID.", "warning");
      return;
    }
    let removeInput = () => {};
    const close = () => {
      if (this.#closePicker !== close) return;
      this.#closePicker = undefined;
      fleetMenuState.setFocused(false);
      removeInput();
      agentLiveStore.emitter.off("change", render);
      ctx.ui.setWidget("agent-picker", undefined);
    };
    const picker = new AgentPicker(
      agentPickerEntries,
      "main",
      (id) => {
        close();
        if (id !== "main") void this.open(ctx, id).catch((error) => ctx.ui.notify(String(error), "error"));
      },
      close,
      () => render(),
    );
    const render = () => ctx.ui.setWidget("agent-picker", () => picker, { placement: "aboveEditor" });
    this.#closePicker = close;
    fleetMenuState.setFocused(true);
    removeInput = ctx.ui.onTerminalInput((data) => {
      picker.handleInput(data);
      return { consume: true };
    });
    agentLiveStore.emitter.on("change", render);
    render();
  }

  close(shutdown = false): void {
    this.#closePicker?.();
    if (shutdown) this.#shutdown = true;
    this.#screen?.suspend();
    const done = this.#done;
    this.#done = undefined;
    const lease = this.#lease;
    if (shutdown) {
      this.#screen?.dispose();
      this.#screen = undefined;
      this.#lease = undefined;
    }
    // Restore the host editor while stopped, then resume it exactly once.
    done?.();
    lease?.close(!this.#shutdown);
  }
}
