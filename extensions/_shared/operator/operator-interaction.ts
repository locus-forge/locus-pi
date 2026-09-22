import type { CustomUiFactory, ExtensionContext } from "../host/pi-api.js";

interface InlineInteractionQueue {
  tail: Promise<void>;
  pending: number;
  /**
   * Releases whoever currently owns the single editor slot. A newer request
   * calls it instead of waiting behind a holder Pi may already have replaced.
   */
  releaseCurrent?: (() => void) | undefined;
  /** Fails the current holder's returned promise once it has been superseded. */
  supersedeCurrent?: (() => void) | undefined;
}

interface SessionGeneration {
  owner: object;
  id: string;
}

export interface InlineOperatorInteractionRequest {
  /**
   * Optional caller-owned lease check. It runs after this request reaches the
   * front of the queue and immediately before Pi mounts the component.
   */
  isCurrent?: () => boolean;
}

export class StaleInlineOperatorInteractionError extends Error {
  constructor(message = "Inline operator interaction was dropped because its session lease is stale.") {
    super(message);
    this.name = "StaleInlineOperatorInteractionError";
  }
}

/**
 * A newer interaction took the host's single editor slot. It extends the stale
 * error because every caller already abandons that one quietly, and the correct
 * response is identical: this interaction is no longer on screen.
 */
export class SupersededInlineOperatorInteractionError extends StaleInlineOperatorInteractionError {
  constructor() {
    super("Inline operator interaction was superseded by a newer one.");
    this.name = "SupersededInlineOperatorInteractionError";
  }
}

/**
 * The component was disposed by its owner and never reported a result.
 *
 * Pi resolves a `custom()` call only from its own `close`, so a component torn
 * down any other way — a session-scoped `invalidate()`, a re-entrant open —
 * leaves that promise pending forever. The awaiting caller is a slash-command
 * handler, and Pi's interactive loop awaits the handler before it re-arms the
 * editor callback, so one stranded request stops EVERY later command in the
 * session from being dispatched at all. Failing the caller here is what keeps a
 * dropped surface costing its own command instead of the session's keyboard.
 */
export class AbandonedInlineOperatorInteractionError extends StaleInlineOperatorInteractionError {
  constructor() {
    super("Inline operator interaction was disposed before it reported a result.");
    this.name = "AbandonedInlineOperatorInteractionError";
  }
}

const queuesByOwner = new WeakMap<object, Map<string, InlineInteractionQueue>>();

/**
 * Canonical blocking interaction surface for locus-pi.
 *
 * Pi's non-overlay custom UI replaces the editor container, so the interaction
 * stays anchored at the command line and disappears when `done()` resolves.
 * Raw overlay mode is deliberately centralized away from feature callers:
 * overlays cover scrollback and can leave the triggering key on a competing
 * global route while the focused component is closing.
 */
export const INLINE_OPERATOR_INTERACTION_OPTIONS = Object.freeze({
  overlay: false as const,
});

export async function requestInlineOperatorInteraction<T>(
  ctx: ExtensionContext,
  factory: CustomUiFactory<T>,
  request: InlineOperatorInteractionRequest = {},
): Promise<T> {
  const generation = captureSessionGeneration(ctx);
  const queues = queueMap(generation.owner);
  const queue = queues.get(generation.id) ?? { tail: Promise.resolve(), pending: 0 };
  queues.set(generation.id, queue);

  const available = queue.tail;
  // Slot ownership as this request sees it. It is what fences the host callback
  // below: once this request has lost the editor slot — superseded by a newer
  // one, or released — nothing it retained may act on the host's behalf again.
  let ownsSlot = true;
  let resolveSlot!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    resolveSlot = resolve;
  });
  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    // Releasing deliberately does NOT end callback ownership. A component may
    // dispose itself and then report its result — `Esc` in the agent viewer does
    // exactly that — and fencing on release would swallow that answer and leave
    // the caller waiting. Only a newer interaction taking the slot ends it.
    queue.pending -= 1;
    if (queue.releaseCurrent === releaseSlot) {
      queue.releaseCurrent = undefined;
      queue.supersedeCurrent = undefined;
    }
    resolveSlot();
    if (queue.pending === 0 && queues.get(generation.id) === queue) {
      queues.delete(generation.id);
    }
  };
  // One failure channel with two causes. Both end this request's ownership of
  // the slot and both reject the caller; only the wording differs.
  let failRequest!: (error: StaleInlineOperatorInteractionError) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    failRequest = (error) => {
      ownsSlot = false;
      reject(error);
    };
  });
  // Nothing observes this until the race below, and an unobserved rejection
  // would surface as an unhandled promise.
  failed.catch(() => {});
  const supersede = (): void => failRequest(new SupersededInlineOperatorInteractionError());
  const abandon = (): void => failRequest(new AbandonedInlineOperatorInteractionError());
  queue.pending += 1;

  // Waiting for the slot stays bounded by the previous holder's own lifetime,
  // except that the holder may already be gone: Pi owns one editor slot, and
  // mounting a component runs `editorContainer.clear()` — a component replaced
  // that way is never disposed and its promise never settles. Waiting on it
  // would block every later interaction for the rest of the session. So a
  // request that is genuinely ready to mount takes the slot instead of waiting.
  // Sole request: nothing to take the slot from, and the wait stays exactly as
  // cheap as it was. Contended: race, so a holder Pi already replaced cannot
  // strand the slot.
  if (queue.pending === 1) await available;
  else await Promise.race([available, whenReadyToMount(ctx, generation, request)]);
  try {
    if (!sessionLeaseIsCurrent(ctx, generation, request.isCurrent)) {
      throw new StaleInlineOperatorInteractionError();
    }

    const custom = ctx.ui.custom;
    if (custom === undefined) {
      throw new Error("Inline operator interaction is unavailable because this Pi host does not expose custom UI.");
    }

    /** Tell whoever holds the slot that they no longer do. */
    const retireIncumbent = (nextOwner: { release: () => void; supersede: () => void } | undefined): void => {
      const releasePrevious = queue.releaseCurrent;
      const supersedePrevious = queue.supersedeCurrent;
      if (releasePrevious === releaseSlot) return;
      queue.releaseCurrent = nextOwner?.release;
      queue.supersedeCurrent = nextOwner?.supersede;
      releasePrevious?.();
      supersedePrevious?.();
    };

    // Ownership changes only once this request has a real component in hand: Pi
    // mounts after the factory promise fulfils, so retiring the incumbent any
    // earlier would hand the slot to a request that may never appear.
    let tookSlot = false;
    const takeSlot = (): void => {
      if (!ownsSlot) return;
      tookSlot = true;
      retireIncumbent({ release: releaseSlot, supersede });
    };

    // The host's promise for a replaced component never settles, and its own
    // close path would restore the editor over whatever replaced it. So the
    // superseded caller is failed here instead, and the stale host promise is
    // left pending.
    const mount: { current?: object; inFlight: number } = { inFlight: 0 };
    try {
      return await Promise.race([
        custom.call(
          ctx.ui,
          wrapFactoryDisposal(factory, releaseSlot, takeSlot, () => ownsSlot, abandon, mount),
          INLINE_OPERATOR_INTERACTION_OPTIONS,
        ) as Promise<T>,
        failed,
      ]);
    } catch (error) {
      // A factory that rejects never mounts, but the host still runs its own
      // `restoreEditor()` on that path — the live component is off the screen
      // whether this request wanted the slot or not. Leaving the incumbent
      // registered would leave its owner awaiting a surface nobody can see, so
      // it is retired here and learns the same way it would from any takeover.
      if (!tookSlot && !isSupersededInlineOperatorInteractionError(error)) retireIncumbent(undefined);
      throw error;
    }
  } finally {
    releaseSlot();
  }
}

/**
 * Resolves once this request is both allowed and able to mount, and never
 * resolves otherwise. Raced against the queue, it decides which of two rules
 * applies: a request that can mount takes the slot from the current holder —
 * the newest component is what the host shows anyway — while a request that
 * cannot (stale lease, no custom UI) waits its turn and leaves whatever is on
 * screen alone.
 */
async function whenReadyToMount(
  ctx: ExtensionContext,
  generation: SessionGeneration,
  request: InlineOperatorInteractionRequest,
): Promise<void> {
  // One turn of the microtask queue: enough for a holder that is settling right
  // now to release, and short enough that a replaced holder does not strand the
  // slot. Everything here is synchronous host state, so nothing is polled.
  await Promise.resolve();
  if (!sessionLeaseIsCurrent(ctx, generation, request.isCurrent)) return await new Promise<void>(() => {});
  if (ctx.ui.custom === undefined) return await new Promise<void>(() => {});
}

export function isSupersededInlineOperatorInteractionError(
  error: unknown,
): error is SupersededInlineOperatorInteractionError {
  return error instanceof SupersededInlineOperatorInteractionError;
}

export function isStaleInlineOperatorInteractionError(error: unknown): error is StaleInlineOperatorInteractionError {
  return error instanceof StaleInlineOperatorInteractionError;
}

function captureSessionGeneration(ctx: ExtensionContext): SessionGeneration {
  return {
    owner: currentGenerationOwner(ctx),
    id: currentSessionId(ctx) ?? "session-unknown",
  };
}

function queueMap(owner: object): Map<string, InlineInteractionQueue> {
  const existing = queuesByOwner.get(owner);
  if (existing !== undefined) return existing;
  const created = new Map<string, InlineInteractionQueue>();
  queuesByOwner.set(owner, created);
  return created;
}

function sessionLeaseIsCurrent(
  ctx: ExtensionContext,
  captured: SessionGeneration,
  callerGuard: (() => boolean) | undefined,
): boolean {
  if (!sessionGenerationIsCurrent(ctx, captured)) return false;
  try {
    return callerGuard?.() ?? true;
  } catch {
    return false;
  }
}

/**
 * Session identity alone: the same owner object and the same session id this
 * request captured. `sessionLeaseIsCurrent` adds the caller's own guard on top
 * for the pre-mount decision. Nothing consults this after mounting — a surface
 * on screen must stay closable even when the session it belongs to has moved on,
 * because a component that cannot report its result is worse than a late one.
 */
function sessionGenerationIsCurrent(ctx: ExtensionContext, captured: SessionGeneration): boolean {
  try {
    if (currentGenerationOwner(ctx) !== captured.owner) return false;
    return (currentSessionId(ctx) ?? "session-unknown") === captured.id;
  } catch {
    // Pi invalidates captured contexts after session replacement/reload.
    return false;
  }
}

function currentGenerationOwner(ctx: ExtensionContext): object {
  if (isObject(ctx.sessionManager)) return ctx.sessionManager;
  return ctx.ui;
}

/**
 * Wrap the component Pi is about to mount so this package controls two things
 * the host does not: when the slot changes hands, and who may still speak for
 * the host afterwards.
 *
 * The second one is the load-bearing part. Pi keeps one `close` callback per
 * `custom()` call for that call's whole lifetime, and for a non-overlay
 * component `close` runs `editorContainer.clear()` + re-adds the editor. A
 * component the host silently replaced still holds its own `close`, so a late
 * call — an `ask.timeout` firing, an abort listener, a queued key — would
 * restore the editor over whichever interaction is on screen now, leaving the
 * newer one invisible and its caller waiting forever. `ownsSlot` fences that
 * callback: a request that no longer owns the slot drops the call and disposes
 * its own component instead, so a superseded surface can never blank the live
 * one.
 */
function wrapFactoryDisposal<T>(
  factory: CustomUiFactory<T>,
  releaseSlot: () => void,
  takeSlot: () => void,
  ownsSlot: () => boolean,
  abandon: () => void,
  /** What this request currently has on screen, and whether a replacement is on
   *  its way. One `custom()` call can run its factory more than once — the host
   *  retries a mount, and a caller may replace its own component — so only the
   *  disposal of the LAST mounted component, with no further mount in flight,
   *  means the request has lost its surface. */
  mount: { current?: object; inFlight: number },
): CustomUiFactory<T> {
  return async (tui, theme, keybindings, done) => {
    mount.inFlight += 1;
    let mounted: { dispose?: () => void } | undefined;
    let reported = false;
    const fencedDone = (value: T): void => {
      reported = true;
      if (!ownsSlot()) {
        // Nothing is retained beyond this point: the component's own timers and
        // listeners are exactly what would call back again.
        mounted?.dispose?.();
        return;
      }
      done(value);
    };
    let component: Awaited<ReturnType<CustomUiFactory<T>>>;
    try {
      component = await factory(tui, theme, keybindings, fencedDone);
    } catch (error) {
      // A factory that never produced a component leaves nothing on screen, and
      // an in-flight count that is never cleared would disable the abandon guard
      // for the rest of this request.
      mount.inFlight -= 1;
      throw error;
    }
    const dispose = component.dispose?.bind(component);
    let disposed = false;
    component.dispose = () => {
      if (disposed) return;
      disposed = true;
      try {
        dispose?.();
      } finally {
        // Pi can dispose a replaced session component without resolving the
        // old custom() promise. Once disposed, it no longer owns editor focus.
        releaseSlot();
        // Releasing the slot is not the same as ending the request, and a
        // component is allowed to dispose itself and then report — the agent
        // viewer's Escape does exactly that, synchronously. One microtask later
        // a silent disposal is no longer a report that is on its way; it is a
        // request nobody can ever settle, so the caller is failed instead of
        // left awaiting a surface that is already gone.
        queueMicrotask(() => {
          if (reported || mount.inFlight > 0 || mount.current !== component) return;
          abandon();
        });
      }
    };
    mounted = component;
    mount.current = component;
    mount.inFlight -= 1;
    takeSlot();
    return component;
  };
}

function currentSessionId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.() ?? ctx.session?.id;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
