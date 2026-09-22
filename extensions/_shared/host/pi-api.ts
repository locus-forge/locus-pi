import type { TSchema } from "@sinclair/typebox";

export interface ToolResultText {
  type: "text";
  text: string;
}
export interface ToolResultImage {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ToolResultResource {
  type: "resource";
  uri: string;
  title?: string;
}
export type ToolResultContent = ToolResultText | ToolResultImage | ToolResultResource;

export interface ToolResult {
  content: ToolResultContent[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface ExtensionMessage {
  customType: string;
  content: string | ToolResultContent[];
  display?: boolean;
  details?: Record<string, unknown>;
}

export interface MessageRenderOptions {
  expanded: boolean;
  /** Horizontal padding configured by the host outputPad setting. */
  outputPad: number;
}

export type MessageRenderer = (
  message: ExtensionMessage,
  options: MessageRenderOptions,
  theme: ThemeLike,
) => CustomUiComponent | undefined;

export interface SendMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface ToolExecuteOptions {
  signal: AbortSignal;
  update: (partial: Partial<ToolResult>) => void;
  ctx: ExtensionContext;
}

export interface ToolRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

export interface ToolRenderContext<TArgs = unknown, TState = Record<string, unknown>> {
  args: TArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: CustomUiComponent | undefined;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

export type ToolUpdate = (partial: Partial<ToolResult>) => void;
export type ToolApprovalTier = "read" | "write" | "exec";
export type ToolApprovalDecision = ToolApprovalTier | { tier: ToolApprovalTier; override?: boolean; reason?: string };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

export interface ToolDefinition {
  name: string;
  label?: string;
  description?: string;
  parameters: TSchema;
  /** Let a custom renderer own the complete tool surface instead of Pi's default shell. */
  renderShell?: "default" | "self";
  /** Prepares raw tool-call arguments before Pi applies schema conversion. */
  prepareArguments?: (args: unknown) => unknown;
  approval?: ToolApproval;
  formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    update: ToolUpdate,
    ctx: ExtensionContext,
  ) => Promise<ToolResult> | ToolResult;
  /**
   * Optional/additive: a tool result renderer so the finished tool can redraw a
   * persistent transcript card from `result.details` instead of collapsing to a
   * one-line string. The real host (`@earendil-works/pi-coding-agent`
   * ToolDefinition) already exposes `renderResult`/`renderCall`; this models that
   * seam in the shim. The host requires a renderable component here; returning
   * raw `string[]` crashes the live TUI after a tool completes.
   */
  renderCall?: (args: unknown, theme: ThemeLike, context: ToolRenderContext) => CustomUiComponent;
  renderResult?: (
    result: ToolResult,
    options: ToolRenderResultOptions,
    theme: ThemeLike,
    context: ToolRenderContext,
  ) => CustomUiComponent;
}

export interface CommandOptions {
  description?: string;
  args?: unknown[];
  /**
   * Pi replaces the entire argument buffer with `value`; providers therefore
   * return complete argument strings, not token fragments.
   */
  getArgumentCompletions?: (prefix: string) => CommandArgumentCompletion[] | null;
  handler: (args: CommandArgs, ctx: ExtensionCommandContext) => Promise<void> | void;
}

export interface CommandArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

export type CommandArgs =
  | string
  | {
      text?: string;
      args: Record<string, string>;
    };

export type LifecycleEvent =
  | "session_start"
  | "session_shutdown"
  | "session_before_compact"
  | "session_compact"
  | "resources_discover"
  | "input"
  | "before_agent_start"
  | "context"
  | "tool_call"
  | "tool_execution_start"
  | "tool_result"
  | "turn_start"
  | "turn_end"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "stop";

export interface EventPayload {
  type: LifecycleEvent;
  sessionId?: string;
  toolName?: string;
  input?: unknown;
  toolArgs?: unknown;
  systemPrompt?: string;
  messages?: Array<{ role: string; content: string; hidden?: boolean }>;
  reason?: string;
  /** `tool_result` event fields (real Pi: ToolResultEvent). */
  toolCallId?: string;
  content?: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface EventResult {
  action?: "continue" | "transform" | "handled";
  text?: string;
  images?: unknown[];
  block?: boolean;
  reason?: string;
  modify?: Partial<EventPayload>;
  systemPrompt?: string;
  /**
   * `tool_result` rewrite shape (real Pi: ToolResultEventResult). Returning
   * `content` from a `tool_result` handler rewrites BOTH the stored and the
   * sent tool result in one shot, because `tool_result` fires once before storage.
   */
  content?: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
  message?: {
    customType: string;
    content: string;
    display?: boolean;
  };
  /**
   * `injectContext` was used by earlier local-only harnesses.
   * Real Pi currently supports `systemPrompt` and `message` return shapes for this hook.
   */
  injectContext?: Array<{ role: string; content: string; hidden?: boolean }>;
}

export type EventHandler = (
  event: EventPayload,
  ctx: ExtensionContext,
) => Promise<EventResult | void> | EventResult | void;

export interface SelectOption {
  label: string;
  value: string;
}
export type SelectChoice = SelectOption | string;
export interface SelectResult {
  value: string;
  label?: string;
  cancelled?: boolean;
}
export type SelectReturn = SelectResult | string | undefined;
export interface InputResult {
  value: string;
  cancelled?: boolean;
}
export interface EditorResult {
  value: string;
  cancelled?: boolean;
}

export interface CustomUiComponent {
  render(width: number): string[];
  handleInput?(data: string): void | Promise<void>;
  invalidate(): void;
  dispose?(): void;
}

export interface CustomUiTui {
  requestRender(force?: boolean): void;
  terminal?: { rows: number; columns: number };
}

export interface WidgetFactoryTui extends CustomUiTui {
  terminal?: { rows: number; columns: number };
}

export type CustomUiFactory<T> = (
  tui: CustomUiTui,
  theme: unknown,
  keybindings: unknown,
  done: (result: T) => void,
) => CustomUiComponent | Promise<CustomUiComponent>;

export interface CustomUiOverlayOptions {
  width?: number | `${number}%`;
  maxHeight?: number | `${number}%`;
  row?: number | `${number}%`;
  col?: number | `${number}%`;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

/**
 * Minimal slice of Pi's interactive `Theme` exposed to extensions via
 * `ctx.ui.theme`. Methods return ANSI-wrapped strings. The real Theme has many
 * more members; we type only what we style with. Undefined outside interactive
 * mode (and in the test harness unless injected).
 */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** A border-colorizer: wraps a border string in ANSI color (real Pi: Editor.borderColor). */
export type EditorBorderColor = (str: string) => string;

/**
 * Factory for a custom input editor component (real Pi: `EditorFactory`).
 * Pi calls it synchronously with the live TUI, a reduced EditorTheme (only
 * `borderColor`), and the keybindings manager, and expects an editor instance
 * back. Typed loosely because the editor base class lives in the host package,
 * not in this shim — see `setEditorComponent`.
 */
export type EditorFactory = (tui: unknown, theme: { borderColor: EditorBorderColor }, keybindings: unknown) => unknown;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
  thinking?: boolean | string[];
  [key: string]: unknown;
}

export interface ProviderConfigLike {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: string | boolean;
  models?: ModelLike[];
  oauth?: unknown;
  [key: string]: unknown;
}

export type ModelRequestAuthLike =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string | null>;
      env?: Record<string, string>;
    }
  | { ok: false; error: string };

export interface ModelRegistryLike {
  refresh?(): void;
  getError?(): string | undefined;
  getAll?(): ModelLike[] | Promise<ModelLike[]>;
  getAvailable?(): ModelLike[] | Promise<ModelLike[]>;
  find?(provider: string, id: string): ModelLike | undefined | Promise<ModelLike | undefined>;
  getApiKeyAndHeaders?(model: ModelLike): Promise<ModelRequestAuthLike>;
  registerProvider?(name: string, config: ProviderConfigLike): void | Promise<void>;
  unregisterProvider?(name: string): void | Promise<void>;
}

export interface ReplacementSessionEntryLike {
  type?: string;
  customType?: string;
  role?: string;
  content?: string;
  text?: string;
  message?: unknown;
  data?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

export interface ReplacementSessionManagerLike {
  getEntries(opts?: {
    type?: string;
    limit?: number;
  }): Promise<ReplacementSessionEntryLike[]> | ReplacementSessionEntryLike[];
  getBranch?(): Promise<ReplacementSessionEntryLike[]> | ReplacementSessionEntryLike[];
  getSessionId?(): string;
  getSessionFile?(): string | undefined;
  getCwd?(): string;
  getSessionName?(): string | undefined;
}

/** Live context-budget signal (real Pi: ContextUsage). */
export interface ContextUsage {
  /** Estimated context tokens, or null right after compaction until the next LLM response. */
  tokens: number | null;
  contextWindow: number;
  /** Usage as percentage of the window, or null when tokens is null. */
  percent: number | null;
}

/** Compaction result handed to CompactOptions callbacks (real Pi: CompactionResult). */
export interface CompactionResultLike {
  summary: string;
  tokensBefore?: number;
  [key: string]: unknown;
}

/** Options for ctx.compact() (real Pi: CompactOptions). */
export interface CompactOptions {
  customInstructions?: string;
  onComplete?: (result: CompactionResultLike) => void;
  onError?: (error: Error) => void;
}

export interface ExtensionContext {
  cwd?: string;
  hasUI?: boolean;
  /** Real Pi run mode. Terminal component factories/custom UI are valid only in `tui`. */
  mode?: "tui" | "rpc" | "json" | "print";
  model?: ModelLike;
  /** Current host thinking level. */
  thinkingLevel?: ThinkingLevel;
  modelRegistry?: ModelRegistryLike;
  /** Models resolved from enabledModels/--models for the current session. */
  scopedModels?: ReadonlyArray<{ model: ModelLike; thinkingLevel?: ThinkingLevel }>;
  /** Real Pi ctx.isIdle(): false through runs, retries, compaction retries, and queued continuation. */
  isIdle(): boolean;
  /** Abort the active parent agent turn (real Pi: ctx.abort()). */
  abort?(): void;
  /** Active parent-agent abort signal when a turn is running (real Pi: ctx.signal). */
  signal?: AbortSignal;
  /** Current context usage for the active model (real Pi: ctx.getContextUsage()). */
  getContextUsage?(): ContextUsage | undefined;
  /** Trigger compaction without awaiting completion (real Pi: ctx.compact()). */
  compact?(options?: CompactOptions): void;
  setModel?(model: ModelLike): boolean | Promise<boolean>;
  setThinkingLevel?(level: ThinkingLevel): void;
  ui: {
    select(
      title: string,
      options: SelectChoice[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ): Promise<SelectReturn>;
    input(title: string, opts?: { default?: string; placeholder?: string }): Promise<InputResult>;
    editor(title: string, content: string, opts?: { language?: string }): Promise<EditorResult>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
    /** Listen to raw terminal input in interactive mode. Returns an unsubscribe function. */
    onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
    /** Replace/read the current editor text (real Pi extension UI). */
    setEditorText?(text: string): void;
    getEditorText?(): string;
    setStatus(key: string, text: string | undefined): void;
    setWidget(
      key: string,
      content: string[] | WidgetFactory | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
    /** Replace Pi's interactive footer. Last registered factory owns the single footer slot. */
    setFooter?(factory: FooterFactory | undefined): void;
    setTitle(title: string): void;
    setWorkingIndicator(active: boolean): void;
    custom?<T>(
      factory: CustomUiFactory<T>,
      options?: { overlay?: boolean; overlayOptions?: CustomUiOverlayOptions },
    ): Promise<T>;
    /** Live interactive theme for styling status/badges. Undefined outside interactive mode. */
    readonly theme?: ThemeLike;
    /** Install a custom input-editor component, or undefined to restore the default. */
    setEditorComponent?(factory: EditorFactory | undefined): void;
    /** The currently-installed custom editor factory, or undefined when using the default. */
    getEditorComponent?(): EditorFactory | undefined;
  };
  session?: {
    id: string;
    projectRoot: string;
    workingDirectory: string;
  };
  sessionManager?: ReplacementSessionManagerLike;
  // settings is not part of Pi's ExtensionContext; the test harness provides it.
  // At runtime ctx.settings is undefined. Fall back to file-based config.
  settings?: {
    get(key: string): unknown;
    set(key: string, value: unknown): Promise<void>;
  };
}

export interface ReplacementSessionContext extends ExtensionContext {
  sendMessage?(message: string, opts?: Record<string, unknown>): Promise<void> | void;
  sendUserMessage?(message: string, opts?: Record<string, unknown>): Promise<void> | void;
  waitForIdle?(opts?: Record<string, unknown>): Promise<void> | void;
}

export interface NewSessionOptionsLike {
  parentSession?: string;
  setup?: (sessionManager: unknown) => Promise<void> | void;
  withSession?: (ctx: ReplacementSessionContext) => Promise<void> | void;
}

export interface NewSessionResultLike {
  cancelled: boolean;
  reason?: string;
}

export interface ExtensionCommandContext extends ExtensionContext {
  reload?(): Promise<void> | void;
  newSession?(opts?: NewSessionOptionsLike): Promise<NewSessionResultLike> | NewSessionResultLike;
  fork?(opts?: NewSessionOptionsLike): Promise<NewSessionResultLike> | NewSessionResultLike;
  switchSession?(sessionId: string): Promise<void> | void;
  sendMessage?(message: string, opts?: Record<string, unknown>): Promise<void> | void;
  sendUserMessage?(message: string, opts?: Record<string, unknown>): Promise<void> | void;
  /** Real Pi command primitive; optional in the shim so older/partial hosts fail closed at runtime. */
  waitForIdle?(): Promise<void>;
}

export type WidgetFactory = (...args: unknown[]) => unknown;

export interface FooterDataProviderLike {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
}

export type FooterFactory = (
  tui: WidgetFactoryTui,
  theme: ThemeLike,
  footerData: FooterDataProviderLike,
) => CustomUiComponent;

export interface CustomEntry {
  type: string;
  data: unknown;
  timestamp?: string;
}

export interface ShortcutOptions {
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

export interface ExtensionAPI {
  registerCommand(name: string, opts: CommandOptions): void;
  /** Current session command inventory; duplicate extension commands may be namespaced by Pi. */
  getCommands?(): Array<{ name: string; description?: string; source?: string; sourceInfo?: unknown }>;
  registerTool(tool: ToolDefinition): void;
  /** Custom TUI rendering for model-visible extension messages. */
  registerMessageRenderer?(customType: string, renderer: MessageRenderer): void;
  /**
   * Register a keyboard shortcut (real Pi: ExtensionAPI.registerShortcut).
   * Optional because the test harness and minimal hosts may not implement it.
   * NOTE: Pi drops shortcuts whose chord is a reserved built-in (e.g. `shift+tab`
   * is reserved for `app.thinking.cycle`); free the chord via the user
   * keybindings.json before relying on it.
   */
  registerShortcut?(shortcut: string, opts: ShortcutOptions): void;
  registerProvider?(name: string, config: ProviderConfigLike): void | Promise<void>;
  unregisterProvider?(name: string): void | Promise<void>;
  on(event: LifecycleEvent, handler: EventHandler): void;
  appendEntry(type: string, data: unknown): Promise<void>;
  sendMessage?(message: ExtensionMessage, opts?: SendMessageOptions): Promise<void> | void;
  sendUserMessage(message: string, opts?: Record<string, unknown>): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  setModel?(model: ModelLike): boolean | Promise<boolean>;
  setThinkingLevel?(level: ThinkingLevel): void;
  getThinkingLevel?(): ThinkingLevel;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Pi ignores a returned isError; its tool_result hook is the lossless error boundary. */
export function registerToolWithErrorResults(pi: ExtensionAPI, tool: ToolDefinition): void {
  const failedCalls = new Set<string>();
  pi.on("session_shutdown", () => failedCalls.clear());
  pi.on("tool_result", (event) => {
    if (event.toolName === tool.name && typeof event.toolCallId === "string" && failedCalls.delete(event.toolCallId)) {
      return { isError: true };
    }
    return undefined;
  });
  pi.registerTool({
    ...tool,
    async execute(...args) {
      failedCalls.delete(args[0]);
      const result = await tool.execute(...args);
      if (result.isError === true) failedCalls.add(args[0]);
      return result;
    },
  });
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return details === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], details };
}

export function errorResult(text: string, details?: Record<string, unknown>): ToolResult {
  return details === undefined
    ? { isError: true, content: [{ type: "text", text }] }
    : { isError: true, content: [{ type: "text", text }], details };
}

export function setTextWidget(
  ctx: ExtensionContext,
  key: string,
  content: string,
  options?: { placement?: "aboveEditor" | "belowEditor" },
): void {
  ctx.ui.setWidget(key, content.split(/\r?\n/), options);
}

export function getProjectRoot(ctx: ExtensionContext): string {
  return ctx.session?.projectRoot ?? ctx.cwd ?? process.cwd();
}

export function getWorkingDirectory(ctx: ExtensionContext): string {
  return ctx.session?.workingDirectory ?? ctx.cwd ?? process.cwd();
}

export function getSessionId(ctx: ExtensionContext): string {
  return ctx.session?.id ?? ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
}

/**
 * True for the one-shot host modes, whose session is disposed when the turn
 * ends and which have no operator to reach: `print` and `json`. `tui` and
 * `rpc` both deliver operator input — `rpc` to the protocol client — so they
 * are not one-shot here.
 */
export function isOneShotHostMode(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "print" || ctx.mode === "json";
}

export function getCommandText(args: CommandArgs): string {
  return typeof args === "string" ? args : (args.text ?? "");
}
