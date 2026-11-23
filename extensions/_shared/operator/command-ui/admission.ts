import type { ExtensionContext } from "../../host/pi-api.js";
import type {
  CommandUiLifecycleSpec,
  CommandUiRuntimeScope,
  CommandWidgetPresentation,
  PrepareCleanup,
} from "../command-ui.js";

export function clearTransientSelection(
  scope: CommandUiRuntimeScope,
  ctx: ExtensionContext,
  currentGroup: string | undefined,
  fromInput: boolean,
  clearPresentation: (ctx: ExtensionContext, presentation: CommandWidgetPresentation) => boolean,
): void {
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
      if (clearPresentation(ctx, presentation)) collectTransientCleanup(scope, key, cleared);
    } else if (!acceptedCommandWidgets.has(key) && !scope.widgets.has(key) && !isTransientKeyPinned(scope, key)) {
      // Older publishers of unrelated widgets still use the host's key-only API.
      if (clearWidget(ctx, key)) collectTransientCleanup(scope, key, cleared);
    }
  }
  runTransientCleanup(prepared, cleared);
}

export function collectTransientCleanup(
  scope: CommandUiRuntimeScope,
  key: string,
  callbacks: Set<PrepareCleanup>,
): void {
  for (const owner of scope.owners) {
    for (const cleanup of owner.cleanupByKey.get(key) ?? []) callbacks.add(cleanup);
  }
}

export function prepareTransientCleanup(ctx: ExtensionContext, callbacks: Set<PrepareCleanup>) {
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

export function runTransientCleanup(prepared: Map<PrepareCleanup, () => void>, cleared: Set<PrepareCleanup>): void {
  for (const prepare of cleared) {
    try {
      prepared.get(prepare)?.();
    } catch {
      // UI cleanup stays best-effort; an owner callback cannot break input.
    }
  }
}

export function isTransientKeyPinned(scope: CommandUiRuntimeScope, key: string): boolean {
  for (const owner of scope.owners) {
    if (owner.pinnedKeys.has(key)) return true;
  }
  return false;
}

export function commandGroup(spec: CommandUiLifecycleSpec | undefined): string | undefined {
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
