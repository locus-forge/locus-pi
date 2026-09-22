import { describe, expect, it } from "vitest";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
  StaleInlineOperatorInteractionError,
  SupersededInlineOperatorInteractionError,
} from "../../../extensions/_shared/operator/operator-interaction.js";
import type { CustomUiComponent, CustomUiFactory, ExtensionContext } from "../../../extensions/_shared/host/pi-api.js";

/**
 * Models Pi's interactive host faithfully in the one respect that matters here:
 * it owns a single editor slot, and mounting a component runs
 * `editorContainer.clear(); addChild(component)` — the component already there
 * is detached without `dispose()` and without its `custom()` promise ever
 * settling (`@earendil-works/pi-coding-agent`, interactive mode).
 */
function hostWithSingleEditorSlot() {
  const mounted: CustomUiComponent[] = [];
  const ui = {
    notify() {},
    async custom<T>(factory: CustomUiFactory<T>): Promise<T> {
      return await new Promise<T>((resolve, reject) => {
        let closed = false;
        const close = (value: T): void => {
          if (closed) return;
          closed = true;
          // Pi's own close path for a non-overlay component: it clears the editor
          // container and puts the editor back, whatever is in there now.
          mounted.length = 0;
          resolve(value);
        };
        void Promise.resolve(factory({ requestRender() {} } as never, {} as never, {} as never, close))
          .then((component) => {
            if (closed) return;
            mounted.length = 0;
            mounted.push(component);
          })
          .catch((error: unknown) => {
            if (closed) return;
            closed = true;
            // The host restores the editor and rejects when a factory fails.
            mounted.length = 0;
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    },
  };
  return { ui, mounted };
}

function component(): CustomUiComponent {
  return { render: () => [], invalidate: () => {} };
}

async function flush(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Promise.resolve();
}

function contextFor(ui: unknown, id = "session-1"): ExtensionContext {
  return { ui, session: { id } } as unknown as ExtensionContext;
}

describe("inline operator interaction slot", () => {
  it("lets a later interaction open after the host silently replaced an earlier one", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui);

    // The fleet selector opens. The host will replace it without disposing it,
    // so its promise never settles on its own.
    let fleetError: unknown;
    const fleet = requestInlineOperatorInteraction(ctx, async () => component()).catch((error: unknown) => {
      fleetError = error;
    });
    await flush(() => mounted.length === 1);

    // A workflow clarification arrives and takes the slot.
    let questionMounted = false;
    const question = requestInlineOperatorInteraction(ctx, async (_tui, _theme, _keys, done) => {
      questionMounted = true;
      queueMicrotask(() => done("answered"));
      return component();
    });
    await flush(() => questionMounted);
    expect(questionMounted).toBe(true);
    expect(await question).toBe("answered");

    // The superseded caller is told, so it can drop its own UI state instead of
    // waiting on a component that is no longer on screen.
    await fleet;
    expect(fleetError).toBeInstanceOf(SupersededInlineOperatorInteractionError);
    expect(isStaleInlineOperatorInteractionError(fleetError)).toBe(true);

    // Reopening the fleet works — the deadlock this test exists for.
    let reopened = false;
    const again = requestInlineOperatorInteraction(ctx, async (_tui, _theme, _keys, done) => {
      reopened = true;
      queueMicrotask(() => done("closed"));
      return component();
    });
    await flush(() => reopened);
    expect(await again).toBe("closed");
  });

  it("leaves the live component alone when the newcomer cannot mount", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-2");

    let holderDone: ((value: string) => void) | undefined;
    const holder = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      holderDone = done;
      return component();
    });
    await flush(() => mounted.length === 1);
    expect(holderDone).toBeDefined();

    // A caller whose lease is gone must not take a question off the screen.
    let refusedMounted = false;
    let refusedError: unknown;
    const refused = requestInlineOperatorInteraction(
      ctx,
      async () => {
        refusedMounted = true;
        return component();
      },
      { isCurrent: () => false },
    ).catch((error: unknown) => {
      refusedError = error;
    });

    await flush(() => false);
    expect(refusedMounted).toBe(false);

    holderDone?.("holder");
    expect(await holder).toBe("holder");
    await refused;
    expect(refusedError).toBeInstanceOf(StaleInlineOperatorInteractionError);
    expect(refusedError).not.toBeInstanceOf(SupersededInlineOperatorInteractionError);
  });

  it("does not let a replaced surface blank the interaction that took its place", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-late-close");

    // An ask prompt opens and keeps the callback Pi handed it — exactly what an
    // `ask.timeout` or an abort listener fires later.
    let askDone: ((value: string) => void) | undefined;
    let askError: unknown;
    const ask = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      askDone = done;
      return component();
    }).catch((error: unknown) => {
      askError = error;
      return "superseded";
    });
    await flush(() => mounted.length === 1);

    // The operator opens the agent fleet, which takes the slot.
    let fleetDone: ((value: string) => void) | undefined;
    const fleetComponent = component();
    const fleet = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      fleetDone = done;
      return fleetComponent;
    });
    await flush(() => mounted[0] === fleetComponent);
    expect(await ask).toBe("superseded");
    expect(askError).toBeInstanceOf(SupersededInlineOperatorInteractionError);

    // The replaced prompt's retained callback fires now. Before the fence, this
    // ran Pi's close path and cleared the container holding the fleet: the
    // operator saw an empty editor and /ps looked like it had done nothing.
    askDone?.("late");
    await flush(() => false);
    expect(mounted).toEqual([fleetComponent]);

    // And the fleet still closes on its own terms.
    fleetDone?.("closed");
    expect(await fleet).toBe("closed");
  });

  it("keeps the slot with the live interaction while a newcomer is still constructing", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-slow-mount");

    let holderDone: ((value: string) => void) | undefined;
    let holderError: unknown;
    const holderComponent = component();
    const holder = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      holderDone = done;
      return holderComponent;
    }).catch((error: unknown) => {
      holderError = error;
      return "lost";
    });
    await flush(() => mounted.length === 1);

    // A newcomer whose factory has not resolved yet holds no component, so the
    // host has not mounted anything and the live surface is untouched.
    let releaseFactory!: () => void;
    const constructing = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const slow = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      await constructing;
      queueMicrotask(() => done("slow"));
      return component();
    });
    await flush(() => false);
    expect(mounted).toEqual([holderComponent]);
    expect(holderError).toBeUndefined();

    releaseFactory();
    expect(await slow).toBe("slow");
    expect(await holder).toBe("lost");
    expect(holderError).toBeInstanceOf(SupersededInlineOperatorInteractionError);
    holderDone?.("late");
  });

  it("tells the live interaction's owner when a newcomer's failed mount cleared the screen", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-failed-mount");

    let holderError: unknown;
    const holder = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      void done;
      return component();
    }).catch((error: unknown) => {
      holderError = error;
      return "lost";
    });
    await flush(() => mounted.length === 1);

    const failed = requestInlineOperatorInteraction<string>(ctx, async () => {
      throw new Error("selector could not be constructed");
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(await failed).toBe("selector could not be constructed");

    // Pi restores the editor when a factory rejects, so the live component is
    // gone from the screen. Its owner must hear that instead of waiting on a
    // surface nobody can see.
    expect(mounted).toEqual([]);
    expect(await holder).toBe("lost");
    expect(holderError).toBeInstanceOf(SupersededInlineOperatorInteractionError);

    // And the slot is free: the next interaction opens normally.
    const next = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      queueMicrotask(() => done("reopened"));
      return component();
    });
    expect(await next).toBe("reopened");
  });

  it("still delivers the answer of a component that disposes itself before reporting", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-dispose-then-done");

    // The agent viewer closes exactly this way on Esc: dispose, then report. The
    // input has to be driven after the component is mounted, because only then
    // does `dispose` carry the slot wrapper — disposing the half-built object the
    // factory is still returning would exercise nothing.
    let ownDisposeCalls = 0;
    const opening = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      const self: CustomUiComponent = {
        render: () => [],
        invalidate: () => {},
        dispose: () => {
          ownDisposeCalls += 1;
        },
        handleInput: () => {
          self.dispose?.();
          done("closed by the operator");
        },
      };
      return self;
    });
    await flush(() => mounted.length === 1);
    const wrappedDispose = mounted[0]?.dispose;
    mounted[0]?.handleInput?.("escape");

    // Closing hands the editor back, which is why `mounted` is empty again.
    expect(await opening).toBe("closed by the operator");
    expect(ownDisposeCalls).toBe(1);
    expect(wrappedDispose).toBeDefined();
    expect(mounted).toEqual([]);
  });

  it("fails the caller when its mounted component is disposed without ever reporting", async () => {
    // The session-wedge defect. Pi resolves `custom()` only from its own close,
    // so a component torn down by its owner — the fleet menu's session-scoped
    // `invalidate()` — used to leave this promise pending forever. The awaiting
    // caller is a slash-command handler, and Pi's interactive loop awaits the
    // handler before it re-arms the editor callback, so one stranded request
    // stopped EVERY later command in the session from being dispatched.
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-wedge");

    const opening = requestInlineOperatorInteraction<string>(ctx, async () => component());
    await flush(() => mounted.length === 1);

    mounted[0]?.dispose?.();

    await expect(opening).rejects.toBeInstanceOf(StaleInlineOperatorInteractionError);
    await expect(opening).rejects.toThrow("disposed before it reported a result");

    // And the slot is usable again: the next command opens normally rather than
    // queueing behind a request that can never settle.
    const next = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      queueMicrotask(() => done("next interaction"));
      return component();
    });
    await expect(next).resolves.toBe("next interaction");
  });

  it("does not abandon a caller that disposes its own component and then reports", async () => {
    // The agent viewer's Escape does exactly this, synchronously, and the answer
    // it reports afterwards must still reach the caller.
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-dispose-then-report");

    const opening = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      const self: CustomUiComponent = {
        render: () => [],
        invalidate: () => {},
        handleInput: () => {
          self.dispose?.();
          done("reported after disposing");
        },
      };
      return self;
    });
    await flush(() => mounted.length === 1);
    mounted[0]?.handleInput?.("escape");

    await expect(opening).resolves.toBe("reported after disposing");
  });

  it("does not abandon a caller whose factory replaces its own component mid-mount", async () => {
    // One `custom()` call may run its factory more than once; the first component
    // is disposed while the second is still being built. That is a replacement,
    // not a lost surface, and it must not fail the request.
    const ui = {
      notify() {},
      async custom<T>(factory: CustomUiFactory<T>): Promise<T> {
        return await new Promise<T>((resolve) => {
          const done = (value: T): void => resolve(value);
          void Promise.resolve(factory({ requestRender() {} } as never, {} as never, {} as never, done)).then(
            () => void Promise.resolve(factory({ requestRender() {} } as never, {} as never, {} as never, done)),
          );
        });
      },
    };
    const ctx = contextFor(ui, "session-remount");

    let previous: CustomUiComponent | undefined;
    const opening = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      previous?.dispose?.();
      const self: CustomUiComponent = {
        render: () => [],
        invalidate: () => {},
        handleInput: () => done("answered on the second mount"),
      };
      previous = self;
      return self;
    });

    await flush(() => previous?.handleInput !== undefined);
    await Promise.resolve();
    previous?.handleInput?.("enter");

    await expect(opening).resolves.toBe("answered on the second mount");
  });

  it("keeps ordinary sequential interactions unchanged", async () => {
    const { ui } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-3");

    const first = await requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      queueMicrotask(() => done("first"));
      return component();
    });
    const second = await requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      queueMicrotask(() => done("second"));
      return component();
    });

    expect([first, second]).toEqual(["first", "second"]);
  });
});
