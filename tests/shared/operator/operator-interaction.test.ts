import { describe, expect, it, vi } from "vitest";
import type { CustomUiComponent, CustomUiFactory } from "../../../extensions/_shared/host/pi-api.js";
import {
  requestInlineOperatorInteraction,
  StaleInlineOperatorInteractionError,
  SupersededInlineOperatorInteractionError,
} from "../../../extensions/_shared/operator/operator-interaction.js";
import { createHarness } from "../../test-harness.js";

describe("inline operator interaction ownership", () => {
  it("gives the slot to the newest interaction and tells the one it replaced", async () => {
    const harness = createHarness();
    const mounted: string[] = [];
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        const component = await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        mounted.push(component.render(80)[0] ?? "");
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    // Pi shows one component at a time and replaces it without disposing the
    // old one, so the newest request owns the slot rather than queueing behind
    // a component the operator may no longer be looking at.
    // The rejection is observed from the start: it lands before the assertion
    // below and would otherwise surface as an unhandled promise.
    let firstError: unknown;
    const first = requestInlineOperatorInteraction(harness.ctx, () => component("first")).catch((error: unknown) => {
      firstError = error;
    });
    const second = requestInlineOperatorInteraction(harness.ctx, () => component("second"));

    await vi.waitFor(() => expect(mounted).toEqual(["first", "second"]));
    await first;
    expect(firstError).toBeInstanceOf(SupersededInlineOperatorInteractionError);
    completions[1]!("second-result");
    await expect(second).resolves.toBe("second-result");
  });

  it("never mounts an interaction whose caller lease is already stale", async () => {
    const harness = createHarness();
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const active = requestInlineOperatorInteraction(harness.ctx, () => component("active"));
    await vi.waitFor(() => expect(completions).toHaveLength(1));

    // A caller that has already lost its lease leaves the live component alone.
    const stale = requestInlineOperatorInteraction(harness.ctx, () => component("must-not-mount"), {
      isCurrent: () => false,
    });

    completions[0]!("done");
    await expect(active).resolves.toBe("done");
    await expect(stale).rejects.toBeInstanceOf(StaleInlineOperatorInteractionError);
    expect(harness.ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("does not make a fresh session generation wait for the old generation", async () => {
    const harness = createHarness();
    let sessionId = "one";
    harness.ctx.sessionManager!.getSessionId = () => sessionId;
    const mounted: string[] = [];
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        const child = await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        mounted.push(child.render(80)[0] ?? "");
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const oldGeneration = requestInlineOperatorInteraction(harness.ctx, () => component("old"));
    await vi.waitFor(() => expect(mounted).toEqual(["old"]));
    sessionId = "two";
    const freshGeneration = requestInlineOperatorInteraction(harness.ctx, () => component("fresh"));
    await vi.waitFor(() => expect(mounted).toEqual(["old", "fresh"]));

    completions[1]!("fresh-result");
    await expect(freshGeneration).resolves.toBe("fresh-result");
    completions[0]!("old-result");
    await expect(oldGeneration).resolves.toBe("old-result");
  });

  it("releases the slot when Pi disposes a component whose custom promise remains unsettled", async () => {
    const harness = createHarness();
    const mounted: CustomUiComponent[] = [];
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        const child = await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        mounted.push(child);
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const retired = requestInlineOperatorInteraction(harness.ctx, () => component("retired"));
    await vi.waitFor(() => expect(mounted).toHaveLength(1));

    // Pi can dispose a replaced component without ever resolving its promise.
    mounted[0]!.dispose?.();

    // That request is now unsettleable, so it is failed rather than left
    // awaiting: its caller is a command handler, and Pi's interactive loop
    // awaits the handler before it re-arms the editor, so one request that can
    // never settle stops every later command in the session from running.
    await expect(retired).rejects.toBeInstanceOf(StaleInlineOperatorInteractionError);

    // The slot is free either way, which is what the next interaction needs.
    const next = requestInlineOperatorInteraction(harness.ctx, () => component("next"));
    await vi.waitFor(() => expect(mounted).toHaveLength(2));
    completions[1]!("next-result");
    await expect(next).resolves.toBe("next-result");

    // A late resolution of the retired promise changes nothing — the caller was
    // told its surface was gone, which is the truth about a disposed component.
    completions[0]!("retired-result");
    await expect(retired).rejects.toBeInstanceOf(StaleInlineOperatorInteractionError);
  });
});

function component(label: string): CustomUiComponent {
  return {
    render: () => [label],
    invalidate() {},
  };
}
