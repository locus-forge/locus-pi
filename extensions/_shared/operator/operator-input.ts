import * as piHost from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { getSessionId } from "../host/pi-api.js";
import type { CustomUiComponent, CustomUiFactory, EditorFactory, ExtensionContext } from "../host/pi-api.js";

export type OperatorInputResult =
  { status: "submitted"; value: string } | { status: "cancelled" } | { status: "unavailable"; reason: "no-ui" };

export type OperatorInputSpec =
  { kind: "input"; title: string; placeholder?: string } | { kind: "editor"; title: string; prefill?: string };

interface LegacyDialogResult {
  value: string;
  cancelled?: boolean;
}

type HostDialogResult = string | undefined | LegacyDialogResult;
type HostInput = (title: string, placeholder?: string) => Promise<HostDialogResult>;
type HostEditor = (title: string, prefill?: string) => Promise<HostDialogResult>;

/**
 * Call Pi's official free-text dialog signatures and project their result into
 * one local contract. The object-result branch is retained only for older
 * partial hosts and the repository test harness.
 */
export async function requestOperatorInput(
  ctx: ExtensionContext,
  spec: OperatorInputSpec,
): Promise<OperatorInputResult> {
  if (ctx.mode !== "tui" || ctx.hasUI === false) {
    return { status: "unavailable", reason: "no-ui" };
  }

  const raw =
    spec.kind === "input"
      ? await (ctx.ui.input as unknown as HostInput)(spec.title, spec.placeholder)
      : await (ctx.ui.editor as unknown as HostEditor)(spec.title, spec.prefill);

  return normalizeHostDialogResult(raw);
}

function normalizeHostDialogResult(raw: HostDialogResult): OperatorInputResult {
  if (raw === undefined) return { status: "cancelled" };
  if (typeof raw === "string") return { status: "submitted", value: raw };
  if (!isLegacyDialogResult(raw)) {
    throw new TypeError("Unsupported Pi dialog result; expected string, undefined, or { value, cancelled }");
  }
  if (raw.cancelled === true) return { status: "cancelled" };
  return { status: "submitted", value: raw.value };
}

function isLegacyDialogResult(value: unknown): value is LegacyDialogResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { value?: unknown; cancelled?: unknown };
  return (
    typeof candidate.value === "string" &&
    (candidate.cancelled === undefined || typeof candidate.cancelled === "boolean")
  );
}

interface FocusTui {
  getFocusedComponent(): unknown;
  requestRender(): void;
}

export interface CommandUiFocus {
  tui: FocusTui;
  localTargets: WeakSet<object>;
  mainEditor?: { component: object; factory: EditorFactory };
}

export function observeFocus(
  previous: CommandUiFocus | undefined,
  tui: unknown,
  component?: object,
  factory?: EditorFactory,
): CommandUiFocus | undefined {
  const host = tui as Partial<FocusTui> | undefined;
  if (typeof host?.getFocusedComponent !== "function" || typeof host.requestRender !== "function") return previous;
  const focus: CommandUiFocus = previous ?? { tui: host as FocusTui, localTargets: new WeakSet() };
  focus.tui = host as FocusTui;
  if (component !== undefined) {
    if (factory !== undefined) focus.mainEditor = { component, factory };
    else focus.localTargets.add(component);
  }
  return focus;
}

const nativeEscapeTargetNames = [
  "ExtensionSelectorComponent",
  "ExtensionInputComponent",
  "ExtensionEditorComponent",
  "SettingsSelectorComponent",
  "ModelSelectorComponent",
  "TreeSelectorComponent",
  "SessionSelectorComponent",
  "UserMessageSelectorComponent",
  "ThemeSelectorComponent",
  "ThinkingSelectorComponent",
  "ShowImagesSelectorComponent",
  "OAuthSelectorComponent",
  "LoginDialogComponent",
] as const;

function isPiEditor(component: unknown): component is piHost.CustomEditor {
  return Object.hasOwn(piHost, "CustomEditor") && component instanceof piHost.CustomEditor;
}

type FocusClaim = { kind: "local"; deliver(): void } | { kind: "primary" | "unknown" };

export function captureFocus(ctx: ExtensionContext, focus: CommandUiFocus | undefined): FocusClaim {
  const component = focus?.tui.getFocusedComponent();
  if (focus === undefined || typeof component !== "object" || component === null) return { kind: "unknown" };
  const tui = focus.tui;
  if (isPiEditor(component)) {
    if (component.isShowingAutocomplete()) {
      return {
        kind: "local",
        deliver() {
          Editor.prototype.handleInput.call(component, "\x1b");
          tui.requestRender();
        },
      };
    }
    // CustomEditor can forward Escape to native interrupt even when embedded.
    if (focus.localTargets.has(component)) return { kind: "unknown" };
    if (ctx.ui.getEditorComponent !== undefined) {
      const factory = ctx.ui.getEditorComponent();
      if (
        factory === undefined ||
        (focus.mainEditor?.factory === factory && focus.mainEditor.component === component)
      ) {
        return { kind: "primary" };
      }
    }
    return { kind: "unknown" };
  }
  const knownLocal =
    focus.localTargets.has(component) ||
    nativeEscapeTargetNames.some((name) => {
      const target = Object.hasOwn(piHost, name) ? piHost[name] : undefined;
      return typeof target === "function" && component instanceof target;
    });
  const local = component as Partial<CustomUiComponent>;
  if (!knownLocal || typeof local.handleInput !== "function") return { kind: "unknown" };
  const handle = local.handleInput.bind(local);
  return {
    kind: "local",
    deliver() {
      void handle("\x1b");
      tui.requestRender();
    },
  };
}

type CustomUi = NonNullable<ExtensionContext["ui"]["custom"]>;

/** Record the actual component mounted via Pi's custom API, including peer extensions. */
export function observeCustomMounts(
  ctx: ExtensionContext,
  custom: CustomUi,
  record: (tui: unknown, component: CustomUiComponent, sessionId: string) => void,
): CustomUi {
  return <T>(factory: CustomUiFactory<T>, options?: Parameters<CustomUi>[1]): Promise<T> => {
    const sessionId = getSessionId(ctx);
    const observe: CustomUiFactory<T> = (tui, theme, keys, done) => {
      const component = factory(tui, theme, keys, done);
      const mounted = (view: CustomUiComponent) => {
        record(tui, view, sessionId);
        return view;
      };
      return component instanceof Promise ? component.then(mounted) : mounted(component);
    };
    return custom.call(ctx.ui, observe as CustomUiFactory<unknown>, options) as Promise<T>;
  };
}
