import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { OperatorSurfaceType } from "./operator-ui.js";
import type {
  CommandArgs,
  CommandOptions,
  EventPayload,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "../host/pi-api.js";

export type CommandUiSurface =
  | "persistent-state"
  | "transient-widget"
  | "status"
  | "overlay-selector"
  | "blocking-prompt"
  | "artifact-write"
  | "no-ui";

export interface CommandUiLifecycleSpec {
  command: string;
  group?: string;
  surfaces: CommandUiSurface[];
  transientWidgets?: string[];
  /** A late input event supplies no trustworthy selection for these widgets or their cleanup callbacks. */
  acceptedCommandWidgets?: string[];
  transientStatuses?: string[];
  persistentStatuses?: string[];
}

interface CommandUiOwnerRegistration {
  specs: Map<string, CommandUiLifecycleSpec>;
  inputCleanupInstalled: boolean;
  pinnedKeys: Set<string>;
  cleanupByKey: Map<string, Set<(ctx: ExtensionContext) => void>>;
}

interface CommandUiRuntimeScope {
  owners: Set<CommandUiOwnerRegistration>;
  widgets: Map<string, CommandWidgetPresentation>;
  terminalInputUnsubscribe: (() => void) | undefined;
}

export interface CommandWidgetPresentation {
  readonly key: string;
  readonly surface: OperatorSurfaceType | undefined;
  hidden?: boolean;
}

interface CommandUiRegistry {
  version: 3;
  pendingByPi: WeakMap<ExtensionAPI, CommandUiOwnerRegistration>;
  byUi: WeakMap<object, CommandUiRuntimeScope>;
}

const COMMAND_UI_REGISTRY_SYMBOL = Symbol.for("locus-pi.command-ui-lifecycle.v3");
// Transient widget/status keys that are "pinned" while a live run owns them.
// clearTransientCommandUi skips pinned keys so a chat message or unrelated slash
// command does not dispose a still-running task/spawn_agent progress widget.

/** Pin a transient UI key so clearTransientCommandUi leaves it alone until unpinned.
 *  Used while a task/spawn_agent run is live so typing in chat cannot vanish its
 *  progress widget mid-flight. ALWAYS pair with unpinTransientUiKey in a finally. */
export function pinTransientUiKey(pi: ExtensionAPI, key: string): void {
  ownerRegistration(pi).pinnedKeys.add(key);
}

/** Release a previously pinned transient UI key so normal lifecycle clearing resumes. */
export function unpinTransientUiKey(pi: ExtensionAPI, key: string): void {
  ownerRegistration(pi).pinnedKeys.delete(key);
}

/**
 * Register owner cleanup that must run when a transient UI key is actually
 * cleared. This keeps non-visual state (for example live-store rows) aligned
 * with the widget lifecycle without teaching this generic module domain rules.
 */
export function registerTransientUiCleanup(
  pi: ExtensionAPI,
  key: string,
  cleanup: (ctx: ExtensionContext) => void,
): void {
  const registration = ownerRegistration(pi);
  const callbacks = registration.cleanupByKey.get(key) ?? new Set<(ctx: ExtensionContext) => void>();
  callbacks.add(cleanup);
  registration.cleanupByKey.set(key, callbacks);
}

export function registerCommandWithUiLifecycle(
  pi: ExtensionAPI,
  spec: CommandUiLifecycleSpec,
  options: CommandOptions,
): void {
  rememberCommandUiSpec(pi, spec);
  installInputCleanup(pi);
  pi.registerCommand(spec.command, {
    ...options,
    handler(args: CommandArgs, ctx: ExtensionCommandContext) {
      clearTransientCommandUi(pi, ctx, spec.command);
      return options.handler(args, ctx);
    },
  });
}

function clearTransientCommandUi(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  currentCommand?: string,
  fromInput = false,
): void {
  const scope = bindOwnerToUi(pi, ctx);
  const currentGroup = currentCommand === undefined ? undefined : commandGroupForCommand(scope, pi, currentCommand);
  const transientStatuses = new Set<string>();
  const transientWidgets = new Set<string>();
  const acceptedCommandWidgets = new Set<string>();
  for (const owner of scope.owners) {
    for (const spec of owner.specs.values()) {
      for (const key of spec.acceptedCommandWidgets ?? []) acceptedCommandWidgets.add(key);
      if (fromInput && currentGroup !== undefined && commandGroup(spec) === currentGroup) continue;
      for (const key of spec.transientStatuses ?? []) transientStatuses.add(key);
      for (const key of spec.transientWidgets ?? []) transientWidgets.add(key);
    }
  }
  for (const key of acceptedCommandWidgets) {
    if (fromInput) {
      transientStatuses.delete(key);
      transientWidgets.delete(key);
    } else {
      transientWidgets.add(key);
    }
  }

  // Capture the old presentations before invoking any host callback that could render again.
  const selected = new Map(scope.widgets);
  const callbacks = new Set<(ctx: ExtensionContext) => void>();
  for (const key of transientStatuses) {
    if (isTransientKeyPinned(scope, key)) continue;
    clearStatus(ctx, key);
    collectTransientCleanup(scope, key, callbacks);
  }
  for (const key of transientWidgets) {
    const presentation = selected.get(key);
    if (presentation !== undefined) {
      clearCommandWidgetPresentation(ctx, presentation, callbacks);
    } else if (!acceptedCommandWidgets.has(key) && !scope.widgets.has(key) && !isTransientKeyPinned(scope, key)) {
      // Older publishers of unrelated widgets still use the host's key-only API.
      clearWidget(ctx, key);
      collectTransientCleanup(scope, key, callbacks);
    }
  }
  runTransientCleanup(ctx, callbacks);
}

type HostWidgetArgs = Parameters<ExtensionContext["ui"]["setWidget"]>;

export function setCommandWidget(
  ctx: ExtensionContext,
  key: string,
  content: Exclude<HostWidgetArgs[1], undefined>,
  options?: HostWidgetArgs[2],
  surface?: OperatorSurfaceType,
  onPublished?: (presentation: CommandWidgetPresentation) => void,
): void {
  ctx.ui.setWidget(key, content, options);
  const scope = runtimeScope(ctx);
  // The object identity is the version. Replacing even identical content invalidates earlier selections.
  scope.widgets.delete(key);
  const presentation = { key, surface };
  scope.widgets.set(key, presentation);
  onPublished?.(presentation);
  if (surface === "VIEW" && ctx.mode === "tui" && ctx.hasUI !== false) installTerminalInputListener(ctx, scope);
  else stopTerminalInputListenerWhenIdle(scope);
}

export function currentCommandWidgetPresentation(
  ctx: ExtensionContext,
  key: string,
): CommandWidgetPresentation | undefined {
  return commandUiRegistry().byUi.get(ctx.ui)?.widgets.get(key);
}

/** Hide or restore only the component still installed in this slot. */
export function setCommandWidgetPresented(
  ctx: ExtensionContext,
  presentation: CommandWidgetPresentation,
  presented: boolean,
): boolean {
  if (currentCommandWidgetPresentation(ctx, presentation.key) !== presentation) return false;
  presentation.hidden = !presented;
  return true;
}

export function clearCommandWidgetPresentation(
  ctx: ExtensionContext,
  presentation: CommandWidgetPresentation,
  deferredCleanup?: Set<(ctx: ExtensionContext) => void>,
): boolean {
  const scope = commandUiRegistry().byUi.get(ctx.ui);
  const { key } = presentation;
  if (scope === undefined || scope.widgets.get(key) !== presentation || isTransientKeyPinned(scope, key)) return false;
  if (!clearWidget(ctx, key) || scope.widgets.get(key) !== presentation) return false;
  scope.widgets.delete(key);
  stopTerminalInputListenerWhenIdle(scope);
  const callbacks = deferredCleanup ?? new Set<(ctx: ExtensionContext) => void>();
  collectTransientCleanup(scope, key, callbacks);
  if (deferredCleanup === undefined) runTransientCleanup(ctx, callbacks);
  return true;
}

function rememberCommandUiSpec(pi: ExtensionAPI, spec: CommandUiLifecycleSpec): void {
  ownerRegistration(pi).specs.set(spec.command, spec);
}

function installInputCleanup(pi: ExtensionAPI): void {
  const registration = ownerRegistration(pi);
  if (registration.inputCleanupInstalled) return;
  registration.inputCleanupInstalled = true;
  pi.on("input", (event, ctx) => {
    const text = inputText(event).trim();
    if (text === "") return;
    const command = commandFromText(text);
    clearTransientCommandUi(pi, ctx, command, true);
  });
}

function commandFromText(text: string): string | undefined {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s|$)/u.exec(text);
  return match?.[1];
}

function inputText(event: EventPayload): string {
  if (typeof event.text === "string") return event.text;
  if (typeof event.input === "string") return event.input;
  if (isTextInputObject(event.input)) return event.input.text;
  return "";
}

function isTextInputObject(input: unknown): input is { text: string } {
  return typeof input === "object" && input !== null && typeof (input as { text?: unknown }).text === "string";
}

function collectTransientCleanup(
  scope: CommandUiRuntimeScope,
  key: string,
  callbacks: Set<(ctx: ExtensionContext) => void>,
): void {
  for (const owner of scope.owners) {
    for (const cleanup of owner.cleanupByKey.get(key) ?? []) callbacks.add(cleanup);
  }
}

function runTransientCleanup(ctx: ExtensionContext, callbacks: Set<(ctx: ExtensionContext) => void>): void {
  for (const cleanup of callbacks) {
    try {
      cleanup(ctx);
    } catch {
      // UI cleanup stays best-effort; an owner callback cannot break input.
    }
  }
}

function isTransientKeyPinned(scope: CommandUiRuntimeScope, key: string): boolean {
  for (const owner of scope.owners) {
    if (owner.pinnedKeys.has(key)) return true;
  }
  return false;
}

function commandGroupForCommand(scope: CommandUiRuntimeScope, pi: ExtensionAPI, command: string): string | undefined {
  const ownSpec = ownerRegistration(pi).specs.get(command);
  if (ownSpec !== undefined) return commandGroup(ownSpec);
  for (const owner of scope.owners) {
    const spec = owner.specs.get(command);
    if (spec !== undefined) return commandGroup(spec);
  }
  return undefined;
}

function commandGroup(spec: CommandUiLifecycleSpec | undefined): string | undefined {
  if (spec === undefined) return undefined;
  return spec.group ?? spec.command;
}

function clearStatus(ctx: ExtensionContext, key: string): void {
  try {
    ctx.ui.setStatus(key, undefined);
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
  }
}

function clearWidget(ctx: ExtensionContext, key: string): boolean {
  try {
    ctx.ui.setWidget(key, undefined);
    return true;
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
    return false;
  }
}

function latestDismissibleView(scope: CommandUiRuntimeScope): CommandWidgetPresentation | undefined {
  let latest: CommandWidgetPresentation | undefined;
  for (const presentation of scope.widgets.values()) {
    if (presentation.surface === "VIEW" && !presentation.hidden && !isTransientKeyPinned(scope, presentation.key))
      latest = presentation;
  }
  return latest;
}

/** True when the existing passive VIEW handler can consume Escape. WARNs do not claim Escape. */
export function hasDismissibleCommandView(ctx: ExtensionContext): boolean {
  const scope = commandUiRegistry().byUi.get(ctx.ui);
  return scope?.terminalInputUnsubscribe !== undefined && latestDismissibleView(scope) !== undefined;
}

function installTerminalInputListener(ctx: ExtensionContext, scope: CommandUiRuntimeScope): void {
  const onTerminalInput = ctx.ui.onTerminalInput;
  if (typeof onTerminalInput !== "function") return;

  // Pi clears raw listeners when an extension session is rebound.
  scope.terminalInputUnsubscribe?.();
  scope.terminalInputUnsubscribe = onTerminalInput.call(ctx.ui, (data) => {
    if (!isEscapePress(data)) return undefined;
    const presentation = latestDismissibleView(scope);
    if (presentation !== undefined && clearCommandWidgetPresentation(ctx, presentation)) return { consume: true };
    return undefined;
  });
}

function stopTerminalInputListenerWhenIdle(scope: CommandUiRuntimeScope): void {
  for (const presentation of scope.widgets.values()) if (presentation.surface === "VIEW") return;
  scope.terminalInputUnsubscribe?.();
  scope.terminalInputUnsubscribe = undefined;
}

export function isEscapePress(data: string): boolean {
  return !isKeyRelease(data) && (matchesKey(data, "escape") || data === "escape");
}

function bindOwnerToUi(pi: ExtensionAPI, ctx: ExtensionContext): CommandUiRuntimeScope {
  const scope = runtimeScope(ctx);
  // Specs, pins, and owner callbacks register before a command has a runtime
  // context. Binding the per-API owner here merges only entrypoints that share
  // this concrete host UI; unrelated sessions and harnesses stay isolated.
  scope.owners.add(ownerRegistration(pi));
  return scope;
}

function runtimeScope(ctx: ExtensionContext): CommandUiRuntimeScope {
  const registry = commandUiRegistry();
  const existing = registry.byUi.get(ctx.ui);
  if (existing !== undefined) return existing;
  const created: CommandUiRuntimeScope = {
    owners: new Set<CommandUiOwnerRegistration>(),
    widgets: new Map(),
    terminalInputUnsubscribe: undefined,
  };
  registry.byUi.set(ctx.ui, created);
  return created;
}

function ownerRegistration(pi: ExtensionAPI): CommandUiOwnerRegistration {
  const registry = commandUiRegistry();
  const existing = registry.pendingByPi.get(pi);
  if (existing !== undefined) return existing;

  const created: CommandUiOwnerRegistration = {
    specs: new Map<string, CommandUiLifecycleSpec>(),
    inputCleanupInstalled: false,
    pinnedKeys: new Set<string>(),
    cleanupByKey: new Map<string, Set<(ctx: ExtensionContext) => void>>(),
  };
  registry.pendingByPi.set(pi, created);
  return created;
}

function commandUiRegistry(): CommandUiRegistry {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[COMMAND_UI_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const created: CommandUiRegistry = {
      version: 3,
      pendingByPi: new WeakMap<ExtensionAPI, CommandUiOwnerRegistration>(),
      byUi: new WeakMap<object, CommandUiRuntimeScope>(),
    };
    globalRecord[COMMAND_UI_REGISTRY_SYMBOL] = created;
    return created;
  }

  if (!isCommandUiRegistry(existing)) {
    throw new Error("Incompatible global command UI registry at locus-pi.command-ui-lifecycle.v3");
  }
  return existing;
}

function isCommandUiRegistry(value: unknown): value is CommandUiRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommandUiRegistry>;
  return candidate.version === 3 && candidate.pendingByPi instanceof WeakMap && candidate.byUi instanceof WeakMap;
}
