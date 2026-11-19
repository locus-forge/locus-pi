import { isEscapePress } from "./operator-keys.js";
import type { OperatorSurfaceType } from "./operator-ui.js";
import { getSessionId } from "../host/pi-api.js";
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

type PrepareCleanup = (ctx: ExtensionContext) => (() => void) | undefined;

interface CommandUiOwnerRegistration {
  specs: Map<string, CommandUiLifecycleSpec>;
  inputCleanupInstalled: boolean;
  pinnedKeys: Map<string, number>;
  cleanupByKey: Map<string, Set<PrepareCleanup>>;
}

interface CommandUiRuntimeScope {
  sessionId: string;
  owners: Set<CommandUiOwnerRegistration>;
  widgets: Map<string, CommandWidgetPresentation>;
  viewUnsubscribe: (() => void) | undefined;
  widgetWrites: Map<string, { next?: WidgetWrite }>;
}

export interface CommandWidgetPresentation {
  readonly key: string;
  readonly surface: OperatorSurfaceType | undefined;
  hidden?: boolean;
}

interface CommandUiRegistry {
  version: 5;
  pendingByPi: WeakMap<ExtensionAPI, CommandUiOwnerRegistration>;
  byUi: WeakMap<object, CommandUiRuntimeScope>;
}

const COMMAND_UI_REGISTRY_SYMBOL = Symbol.for("locus-pi.command-ui-lifecycle.v5");
// Transient widget/status keys that are "pinned" while a live run owns them.
// clearTransientCommandUi skips pinned keys so a chat message or unrelated slash
// command does not dispose a still-running task/spawn_agent progress widget.

/** Pin a transient UI key so clearTransientCommandUi leaves it alone until unpinned.
 *  Used while a task/spawn_agent run is live so typing in chat cannot vanish its
 *  progress widget mid-flight. ALWAYS pair with unpinTransientUiKey in a finally. */
export function pinTransientUiKey(pi: ExtensionAPI, key: string): void {
  const pins = ownerRegistration(pi).pinnedKeys;
  pins.set(key, (pins.get(key) ?? 0) + 1);
}

/** Release a previously pinned transient UI key so normal lifecycle clearing resumes. */
export function unpinTransientUiKey(pi: ExtensionAPI, key: string): void {
  const pins = ownerRegistration(pi).pinnedKeys;
  const owners = pins.get(key) ?? 0;
  if (owners > 1) pins.set(key, owners - 1);
  else pins.delete(key);
}

/**
 * Register owner cleanup that must run when a transient UI key is actually
 * cleared. Capture the owner's cleanup before any host UI writes. The returned
 * callback applies only to the state that was selected at that point.
 */
export function registerTransientUiCleanup(pi: ExtensionAPI, key: string, cleanup: PrepareCleanup): void {
  const registration = ownerRegistration(pi);
  const callbacks = registration.cleanupByKey.get(key) ?? new Set<PrepareCleanup>();
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

  // Select the old widgets and owner state before a host write can publish replacements.
  const selected = new Map(scope.widgets);
  const candidates = new Set<PrepareCleanup>();
  const statusOnly = new Set<PrepareCleanup>();
  for (const key of new Set([...transientStatuses, ...transientWidgets])) {
    const absent = acceptedCommandWidgets.has(key) && !selected.has(key) && !isTransientKeyPinned(scope, key);
    collectTransientCleanup(scope, key, absent ? statusOnly : candidates);
  }
  for (const candidate of candidates) statusOnly.delete(candidate);
  const prepared = prepareTransientCleanup(ctx, new Set([...candidates, ...statusOnly]));
  const cleared = statusOnly;
  for (const key of transientStatuses) {
    if (isTransientKeyPinned(scope, key)) continue;
    clearStatus(ctx, key);
    collectTransientCleanup(scope, key, cleared);
  }
  for (const key of transientWidgets) {
    const presentation = selected.get(key);
    if (presentation !== undefined) {
      if (clearCommandWidgetPresentation(ctx, presentation)) collectTransientCleanup(scope, key, cleared);
    } else if (!acceptedCommandWidgets.has(key) && !scope.widgets.has(key) && !isTransientKeyPinned(scope, key)) {
      // Older publishers of unrelated widgets still use the host's key-only API.
      if (clearWidget(ctx, key)) collectTransientCleanup(scope, key, cleared);
    }
  }
  runTransientCleanup(prepared, cleared);
}

type HostWidgetArgs = Parameters<ExtensionContext["ui"]["setWidget"]>;
interface WidgetWrite {
  content: HostWidgetArgs[1];
  options: HostWidgetArgs[2];
  surface: OperatorSurfaceType | undefined;
  onPublished?: ((presentation: CommandWidgetPresentation) => void) | undefined;
}

export function setCommandWidget(
  ctx: ExtensionContext,
  key: string,
  content: HostWidgetArgs[1],
  options?: HostWidgetArgs[2],
  surface?: OperatorSurfaceType,
  onPublished?: (presentation: CommandWidgetPresentation) => void,
): void {
  writeCommandWidget(ctx, runtimeScope(ctx), key, { content, options, surface, onPublished });
}

function writeCommandWidget(
  ctx: ExtensionContext,
  scope: CommandUiRuntimeScope,
  key: string,
  first: WidgetWrite,
): boolean {
  const active = scope.widgetWrites.get(key);
  if (active !== undefined) {
    // Pi can call dispose before deleting/replacing the key. Publish the newest
    // nested write after the outer host mutation finishes.
    active.next = first;
    return false;
  }

  scope.widgetWrites.set(key, {});
  let superseded = false;
  let refreshView = false;
  try {
    let write: WidgetWrite | undefined = first;
    while (write !== undefined) {
      try {
        ctx.ui.setWidget(key, write.content, write.options);
        scope.widgets.delete(key);
        if (write.content !== undefined) {
          const presentation = { key, surface: write.surface };
          scope.widgets.set(key, presentation);
          write.onPublished?.(presentation);
        }
        refreshView = write.content !== undefined && write.surface === "VIEW";
      } catch (error) {
        if (scope.widgetWrites.get(key)?.next === undefined) throw error;
      }
      write = scope.widgetWrites.get(key)?.next;
      if (write !== undefined) {
        superseded = true;
        scope.widgetWrites.set(key, {});
      }
    }
  } finally {
    scope.widgetWrites.delete(key);
    synchronizeViewListener(ctx, scope, refreshView);
  }
  return !superseded;
}

export function currentCommandWidgetPresentation(
  ctx: ExtensionContext,
  key: string,
): CommandWidgetPresentation | undefined {
  return currentScope(ctx)?.widgets.get(key);
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

/** Clear only this version. Completion and command admission own their separate cleanup effects. */
export function clearCommandWidgetPresentation(
  ctx: ExtensionContext,
  presentation: CommandWidgetPresentation,
): boolean {
  const scope = currentScope(ctx);
  const { key } = presentation;
  if (scope === undefined || scope.widgets.get(key) !== presentation || isTransientKeyPinned(scope, key)) return false;
  if (scope.widgetWrites.has(key)) return false;
  try {
    return writeCommandWidget(ctx, scope, key, { content: undefined, options: undefined, surface: undefined });
  } catch {
    // A host can throw after applying part of the clear. Do not report success.
    return false;
  }
}

function rememberCommandUiSpec(pi: ExtensionAPI, spec: CommandUiLifecycleSpec): void {
  ownerRegistration(pi).specs.set(spec.command, spec);
}

function installInputCleanup(pi: ExtensionAPI): void {
  const registration = ownerRegistration(pi);
  if (registration.inputCleanupInstalled) return;
  registration.inputCleanupInstalled = true;
  pi.on("session_shutdown", (_event, ctx) => {
    const registry = commandUiRegistry();
    const scope = currentScope(ctx);
    if (scope === undefined) return;
    registry.byUi.delete(ctx.ui);
    scope.viewUnsubscribe?.();
  });
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

function collectTransientCleanup(scope: CommandUiRuntimeScope, key: string, callbacks: Set<PrepareCleanup>): void {
  for (const owner of scope.owners) {
    for (const cleanup of owner.cleanupByKey.get(key) ?? []) callbacks.add(cleanup);
  }
}

function prepareTransientCleanup(ctx: ExtensionContext, callbacks: Set<PrepareCleanup>) {
  const prepared = new Map<PrepareCleanup, () => void>();
  for (const prepare of callbacks) {
    try {
      const cleanup = prepare(ctx);
      if (cleanup !== undefined) prepared.set(prepare, cleanup);
    } catch {
      // UI cleanup stays best-effort; an owner callback cannot break input.
    }
  }
  return prepared;
}

function runTransientCleanup(prepared: Map<PrepareCleanup, () => void>, cleared: Set<PrepareCleanup>): void {
  for (const prepare of cleared) {
    try {
      prepared.get(prepare)?.();
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

function newestView(scope: CommandUiRuntimeScope): CommandWidgetPresentation | undefined {
  return [...scope.widgets.values()]
    .reverse()
    .find(
      ({ key, surface, hidden }) => surface === "VIEW" && !hidden && !isTransientKeyPinned(scope, key) && !scope.widgetWrites.has(key),
    );
}

/** The agents guard defers only to a VIEW that this subscription can close. */
export function hasDismissibleCommandView(ctx: ExtensionContext): boolean {
  const scope = currentScope(ctx);
  return scope?.viewUnsubscribe !== undefined && newestView(scope) !== undefined;
}

function synchronizeViewListener(ctx: ExtensionContext, scope: CommandUiRuntimeScope, refresh: boolean): void {
  if (currentScope(ctx) !== scope) return;
  if (refresh || ![...scope.widgets.values()].some(({ surface }) => surface === "VIEW")) {
    scope.viewUnsubscribe?.();
    scope.viewUnsubscribe = undefined;
  }
  if (!refresh || ctx.mode !== "tui" || ctx.hasUI === false || ctx.ui.onTerminalInput === undefined) return;
  // Pi resets raw listeners when the host rebinds. Refresh on each VIEW publication.
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!isEscapePress(data) || currentScope(ctx) !== scope || scope.viewUnsubscribe !== unsubscribe) return undefined;
    const presentation = newestView(scope);
    if (presentation === undefined) return undefined;
    const callbacks = new Set<PrepareCleanup>();
    collectTransientCleanup(scope, presentation.key, callbacks);
    const prepared = prepareTransientCleanup(ctx, callbacks);
    if (clearCommandWidgetPresentation(ctx, presentation)) runTransientCleanup(prepared, callbacks);
    // This VIEW owned the press, even if the host failed to clear it.
    return { consume: true };
  });
  scope.viewUnsubscribe = unsubscribe;
}

function bindOwnerToUi(pi: ExtensionAPI, ctx: ExtensionContext): CommandUiRuntimeScope {
  const scope = runtimeScope(ctx);
  // Specs, pins, and owner callbacks register before a command has a runtime
  // context. Binding the per-API owner here merges only entrypoints that share
  // this concrete host UI; unrelated sessions and harnesses stay isolated.
  scope.owners.add(ownerRegistration(pi));
  return scope;
}

function currentScope(ctx: ExtensionContext): CommandUiRuntimeScope | undefined {
  const scope = commandUiRegistry().byUi.get(ctx.ui);
  return scope?.sessionId === getSessionId(ctx) ? scope : undefined;
}

function runtimeScope(ctx: ExtensionContext): CommandUiRuntimeScope {
  const registry = commandUiRegistry();
  const existing = registry.byUi.get(ctx.ui);
  const sessionId = getSessionId(ctx);
  if (existing?.sessionId === sessionId) return existing;
  existing?.viewUnsubscribe?.();
  const created: CommandUiRuntimeScope = {
    sessionId,
    owners: new Set<CommandUiOwnerRegistration>(),
    widgets: new Map(),
    viewUnsubscribe: undefined,
    widgetWrites: new Map(),
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
    pinnedKeys: new Map<string, number>(),
    cleanupByKey: new Map<string, Set<PrepareCleanup>>(),
  };
  registry.pendingByPi.set(pi, created);
  return created;
}

function commandUiRegistry(): CommandUiRegistry {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[COMMAND_UI_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const created: CommandUiRegistry = {
      version: 5,
      pendingByPi: new WeakMap<ExtensionAPI, CommandUiOwnerRegistration>(),
      byUi: new WeakMap<object, CommandUiRuntimeScope>(),
    };
    globalRecord[COMMAND_UI_REGISTRY_SYMBOL] = created;
    return created;
  }

  if (!isCommandUiRegistry(existing)) {
    throw new Error("Incompatible global command UI registry at locus-pi.command-ui-lifecycle.v5");
  }
  return existing;
}

function isCommandUiRegistry(value: unknown): value is CommandUiRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommandUiRegistry>;
  return candidate.version === 5 && candidate.pendingByPi instanceof WeakMap && candidate.byUi instanceof WeakMap;
}
