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
  dismissibleViews: string[];
  terminalInputUnsubscribe: (() => void) | undefined;
}

interface CommandUiRegistry {
  version: 2;
  pendingByPi: WeakMap<ExtensionAPI, CommandUiOwnerRegistration>;
  byUi: WeakMap<object, CommandUiRuntimeScope>;
}

const COMMAND_UI_REGISTRY_SYMBOL = Symbol.for("locus-pi.command-ui-lifecycle.v2");
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
      clearTransientCommandUi(pi, ctx, spec.command, { preserveCurrentGroup: false });
      return options.handler(args, ctx);
    },
  });
}

export function clearTransientCommandUi(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  currentCommand?: string,
  options: { preserveCurrentGroup?: boolean } = {},
): void {
  const scope = bindOwnerToUi(pi, ctx);
  const currentGroup = currentCommand === undefined ? undefined : commandGroupForCommand(scope, pi, currentCommand);
  const transientStatuses = new Set<string>();
  const transientWidgets = new Set<string>();
  for (const owner of scope.owners) {
    for (const spec of owner.specs.values()) {
      if (options.preserveCurrentGroup === true && currentGroup !== undefined && commandGroup(spec) === currentGroup)
        continue;
      for (const key of spec.transientStatuses ?? []) transientStatuses.add(key);
      for (const key of spec.transientWidgets ?? []) transientWidgets.add(key);
    }
  }

  const clearedKeys = new Set<string>();
  for (const key of transientStatuses) {
    if (isTransientKeyPinned(scope, key)) continue;
    clearStatus(ctx, key);
    clearedKeys.add(key);
  }
  for (const key of transientWidgets) {
    if (isTransientKeyPinned(scope, key)) continue;
    clearWidget(ctx, key);
    removeDismissibleView(scope, key);
    clearedKeys.add(key);
  }
  stopTerminalInputListenerWhenIdle(scope);
  for (const key of clearedKeys) runTransientCleanup(scope, key, ctx);
}

export function clearTransientUiKey(ctx: ExtensionContext, key: string): void {
  clearStatus(ctx, key);
  clearWidget(ctx, key);
  forgetDismissibleView(ctx, key);
}

/** Track the latest passive VIEW so Escape can dismiss it from the editor. */
export function setDismissibleView(ctx: ExtensionContext, key: string, dismissible: boolean): void {
  if (ctx.mode !== "tui" || ctx.hasUI === false) return;
  const scope = runtimeScope(ctx);
  removeDismissibleView(scope, key);
  if (!dismissible) {
    stopTerminalInputListenerWhenIdle(scope);
    return;
  }

  scope.dismissibleViews.push(key);
  installTerminalInputListener(ctx, scope);
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
    clearTransientCommandUi(pi, ctx, command, { preserveCurrentGroup: true });
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

function runTransientCleanup(scope: CommandUiRuntimeScope, key: string, ctx: ExtensionContext): void {
  for (const owner of scope.owners) {
    for (const cleanup of owner.cleanupByKey.get(key) ?? []) {
      try {
        cleanup(ctx);
      } catch {
        // UI cleanup stays best-effort; an owner callback cannot break input.
      }
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

function clearWidget(ctx: ExtensionContext, key: string): void {
  try {
    ctx.ui.setWidget(key, undefined);
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
  }
}

function forgetDismissibleView(ctx: ExtensionContext, key: string): void {
  const scope = commandUiRegistry().byUi.get(ctx.ui);
  if (scope === undefined) return;
  removeDismissibleView(scope, key);
  stopTerminalInputListenerWhenIdle(scope);
}

/** True when Escape belongs to a transient command view instead of app.interrupt. */
export function hasDismissibleCommandView(ctx: ExtensionContext): boolean {
  return (commandUiRegistry().byUi.get(ctx.ui)?.dismissibleViews.length ?? 0) > 0;
}

function installTerminalInputListener(ctx: ExtensionContext, scope: CommandUiRuntimeScope): void {
  const onTerminalInput = ctx.ui.onTerminalInput;
  if (typeof onTerminalInput !== "function") return;

  // Pi clears raw listeners when an extension session is rebound. Refreshing
  // on every VIEW presentation keeps the registry aligned with the host.
  scope.terminalInputUnsubscribe?.();
  scope.terminalInputUnsubscribe = onTerminalInput.call(ctx.ui, (data) => {
    if (!isEscapeInput(data)) return undefined;
    const key = scope.dismissibleViews.pop();
    if (key === undefined) return undefined;
    clearWidget(ctx, key);
    runTransientCleanup(scope, key, ctx);
    stopTerminalInputListenerWhenIdle(scope);
    return { consume: true };
  });
}

function removeDismissibleView(scope: CommandUiRuntimeScope, key: string): void {
  scope.dismissibleViews = scope.dismissibleViews.filter((candidate) => candidate !== key);
}

function stopTerminalInputListenerWhenIdle(scope: CommandUiRuntimeScope): void {
  if (scope.dismissibleViews.length > 0) return;
  scope.terminalInputUnsubscribe?.();
  scope.terminalInputUnsubscribe = undefined;
}

function isEscapeInput(data: string): boolean {
  return data === "escape" || data === "\x1b";
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
    dismissibleViews: [],
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
      version: 2,
      pendingByPi: new WeakMap<ExtensionAPI, CommandUiOwnerRegistration>(),
      byUi: new WeakMap<object, CommandUiRuntimeScope>(),
    };
    globalRecord[COMMAND_UI_REGISTRY_SYMBOL] = created;
    return created;
  }

  if (!isCommandUiRegistry(existing)) {
    throw new Error("Incompatible global command UI registry at locus-pi.command-ui-lifecycle.v2");
  }
  return existing;
}

function isCommandUiRegistry(value: unknown): value is CommandUiRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommandUiRegistry>;
  return candidate.version === 2 && candidate.pendingByPi instanceof WeakMap && candidate.byUi instanceof WeakMap;
}
