import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type {
  CommandOptions,
  CustomEntry,
  CustomUiComponent,
  CustomUiFactory,
  EditorFactory,
  EventHandler,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionMessage,
  LifecycleEvent,
  ModelLike,
  MessageRenderer,
  ProviderConfigLike,
  FooterFactory,
  SendMessageOptions,
  ShortcutOptions,
  ThemeLike,
  ThinkingLevel,
  ToolDefinition,
  ToolResult,
} from "../extensions/_shared/host/pi-api.js";

const MAX_WIDGET_LINES = 10;

const PLAIN_THEME: ThemeLike = {
  fg: (_tone, text) => text,
  bg: (_tone, text) => text,
  bold: (text) => text,
};

export function renderToolResult(
  tool: ToolDefinition,
  result: ToolResult,
  ctx: ExtensionCommandContext,
  args: Record<string, unknown> = {},
  options: { expanded?: boolean; isPartial?: boolean } = {},
): CustomUiComponent {
  const expanded = options.expanded ?? true;
  const isPartial = options.isPartial ?? false;
  return tool.renderResult!(result, { expanded, isPartial }, ctx.ui.theme ?? PLAIN_THEME, {
    args,
    toolCallId: "test-tool-call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: ctx.cwd ?? process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial,
    expanded,
    showImages: true,
    isError: result.isError === true,
  });
}

/**
 * Parent directory for every default harness project root, removed when the
 * worker exits.
 */
let harnessRootParent: string | undefined;

/**
 * Default project root for a harness: a fresh empty temp directory, never the
 * repository checkout.
 *
 * `process.cwd()` used to be the default, which let repository-local state —
 * an interrupted `.locus-pi/runs/<runId>/` left behind by a real
 * local run, a developer's `.locus-pi/workflows/` scripts — leak into assertions and
 * fail tests that never wrote that state. A test that wants the repository
 * root must now ask for it explicitly by passing `process.cwd()`.
 */
function defaultProjectRoot(): string {
  if (harnessRootParent === undefined) {
    harnessRootParent = mkdtempSync(path.join(tmpdir(), "pi-harness-roots-"));
    const parent = harnessRootParent;
    process.on("exit", () => rmSync(parent, { recursive: true, force: true }));
  }
  return mkdtempSync(path.join(harnessRootParent, "root-"));
}

export interface Harness {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  commands: Map<string, CommandOptions>;
  tools: Map<string, ToolDefinition>;
  shortcuts: Map<string, ShortcutOptions>;
  handlers: Map<LifecycleEvent, EventHandler[]>;
  notifications: string[];
  notificationEvents: Array<{ message: string; level?: "info" | "warning" | "error" }>;
  sentMessages: Array<{ message: ExtensionMessage; options?: SendMessageOptions }>;
  messageRenderers: Map<string, MessageRenderer>;
  /** Pi sendCustomMessage routing: streaming defaults to steer; idle/no-trigger appends. */
  customMessageDeliveries: Array<"steer" | "followUp" | "nextTurn" | "turn" | "append">;
  isStreaming: boolean;
  waitForIdleCalls: number;
  setStreaming(value: boolean): void;
  sentUserMessages: Array<{ message: string; options?: Record<string, unknown> }>;
  widgets: Map<string, string>;
  widgetPayloads: Map<string, unknown>;
  widgetOptions: Map<string, { placement?: "aboveEditor" | "belowEditor" } | undefined>;
  statuses: Map<string, string>;
  activeTools: string[];
  entries: CustomEntry[];
  selectedModel?: ModelLike;
  thinkingLevel?: ThinkingLevel;
  registeredProviders: Map<string, ProviderConfigLike>;
  selectQueue: string[];
  selectCalls: Array<{ title: string; options: Array<string | { value: string; label?: string }> }>;
  customInputQueue: string[];
  customRenderFrames: string[][];
  customComponents: CustomUiComponent[];
  customOptions: Array<{ overlay?: boolean } | undefined>;
  terminalInputHandlers: Set<(data: string) => { consume?: boolean; data?: string } | undefined>;
  confirmQueue: boolean[];
  confirmCalls: Array<{ title: string; message: string }>;
  abortCalls: number;
  editorText: string;
  /** The latest custom editor factory installed via ctx.ui.setEditorComponent. */
  editorFactory?: EditorFactory;
  /** The latest custom footer factory installed via ctx.ui.setFooter. */
  footerFactory?: FooterFactory;
}

export function createHarness(
  projectRoot = defaultProjectRoot(),
  opts: {
    models?: ModelLike[];
    sessionId?: string;
    customTheme?: unknown;
    theme?: ThemeLike;
    mode?: "tui" | "rpc" | "json" | "print";
    isStreaming?: boolean;
  } = {},
): Harness {
  const commands = new Map<string, CommandOptions>();
  const tools = new Map<string, ToolDefinition>();
  const shortcuts = new Map<string, ShortcutOptions>();
  const handlers = new Map<LifecycleEvent, EventHandler[]>();
  const notifications: string[] = [];
  const notificationEvents: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
  const sentMessages: Array<{ message: ExtensionMessage; options?: SendMessageOptions }> = [];
  const messageRenderers = new Map<string, MessageRenderer>();
  const customMessageDeliveries: Array<"steer" | "followUp" | "nextTurn" | "turn" | "append"> = [];
  const sentUserMessages: Array<{ message: string; options?: Record<string, unknown> }> = [];
  const widgets = new Map<string, string>();
  const widgetPayloads = new Map<string, unknown>();
  const widgetOptions = new Map<string, { placement?: "aboveEditor" | "belowEditor" } | undefined>();
  const statuses = new Map<string, string>();
  const entries: CustomEntry[] = [];
  const settings = new Map<string, unknown>();
  const registeredProviders = new Map<string, ProviderConfigLike>();
  const selectQueue: string[] = [];
  const selectCalls: Array<{ title: string; options: Array<string | { value: string; label?: string }> }> = [];
  const customInputQueue: string[] = [];
  const customRenderFrames: string[][] = [];
  const customComponents: CustomUiComponent[] = [];
  const customOptions: Array<{ overlay?: boolean } | undefined> = [];
  const terminalInputHandlers = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  const confirmQueue: boolean[] = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const models = opts.models ?? [
    { provider: "test", id: "fast", name: "Test Fast" },
    { provider: "test", id: "strong", name: "Test Strong" },
  ];
  const sessionId = opts.sessionId ?? "test-session";
  const mode = opts.mode ?? "tui";
  let isStreaming = opts.isStreaming === true;
  const idleWaiters: Array<() => void> = [];
  let activeTools: string[] = [];
  let selectedModel: ModelLike | undefined;
  let thinkingLevel: ThinkingLevel | undefined;
  let editorFactory: EditorFactory | undefined;
  let footerFactory: FooterFactory | undefined;
  let editorText = "";
  let harness: Harness;
  const ctx: ExtensionCommandContext = {
    mode,
    isIdle() {
      return !isStreaming;
    },
    abort() {
      harness.abortCalls += 1;
    },
    async waitForIdle() {
      harness.waitForIdleCalls += 1;
      if (!isStreaming) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    modelRegistry: {
      getAll() {
        return models;
      },
      getAvailable() {
        return models;
      },
      find(provider, id) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
      registerProvider(name, config) {
        registeredProviders.set(name, config);
      },
      unregisterProvider(name) {
        registeredProviders.delete(name);
      },
    },
    setModel(model) {
      selectedModel = model;
      ctx.model = model;
      harness.selectedModel = model;
      return true;
    },
    setThinkingLevel(level) {
      thinkingLevel = level;
      harness.thinkingLevel = level;
    },
    ui: {
      async select(_title, options) {
        selectCalls.push({ title: _title, options });
        const queued = selectQueue.shift();
        const selected =
          queued === undefined ? options[0] : options.find((option) => optionMatchesQueue(option, queued));
        if (typeof selected === "string") return selected;
        return selected
          ? { value: selected.value, label: selected.label, cancelled: false }
          : { value: "", cancelled: true };
      },
      async input(_title, opts) {
        return { value: opts?.default ?? "typed", cancelled: false };
      },
      async editor(_title, content) {
        return { value: content || "edited", cancelled: false };
      },
      async confirm(title, message) {
        confirmCalls.push({ title, message });
        return confirmQueue.shift() ?? true;
      },
      notify(message, level) {
        notifications.push(message);
        notificationEvents.push(level === undefined ? { message } : { message, level });
      },
      onTerminalInput(handler) {
        terminalInputHandlers.add(handler);
        return () => terminalInputHandlers.delete(handler);
      },
      setEditorText(text) {
        editorText = text;
        harness.editorText = text;
      },
      getEditorText() {
        return editorText;
      },
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      setFooter(factory) {
        footerFactory = factory;
        if (factory === undefined) delete harness.footerFactory;
        else harness.footerFactory = factory;
      },
      setWidget(key, content, options) {
        widgetPayloads.set(key, content);
        widgetOptions.set(key, options);
        if (typeof content === "function") {
          // Real RPC mode ignores terminal component factories. Tests must prove
          // production code sends string-array passive widgets instead.
          if (mode === "rpc") {
            widgets.set(key, "");
            return;
          }
          const component = content({ requestRender: () => {} }, {}) as CustomUiComponent;
          widgets.set(key, typeof component.render === "function" ? component.render(80).join("\n") : "");
          return;
        }
        if (Array.isArray(content)) {
          const visible = content.slice(0, MAX_WIDGET_LINES);
          if (content.length > MAX_WIDGET_LINES) visible.push("... (widget truncated)");
          widgets.set(key, visible.join("\n"));
          return;
        }
        widgets.set(key, String(content ?? ""));
      },
      setTitle() {},
      setWorkingIndicator() {},
      ...(opts.theme ? { theme: opts.theme } : {}),
      setEditorComponent(factory) {
        editorFactory = factory;
        if (factory === undefined) delete harness.editorFactory;
        else harness.editorFactory = factory;
      },
      getEditorComponent() {
        return editorFactory;
      },
      async custom<T>(factory: CustomUiFactory<T>, options?: { overlay?: boolean }): Promise<T> {
        let component: CustomUiComponent | undefined;
        let completed = false;
        let result: unknown;
        customOptions.push(options);
        const render = () => {
          if (component) customRenderFrames.push(component.render(80));
        };
        component = await factory({ requestRender: render }, opts.customTheme ?? {}, {}, (value) => {
          completed = true;
          result = value;
        });
        customComponents.push(component);
        render();
        while (!completed && customInputQueue.length > 0) {
          await component.handleInput?.(customInputQueue.shift() ?? "");
        }
        if (!completed) throw new Error("Custom UI did not complete before harness input queue was exhausted");
        return result as T;
      },
    },
    session: { id: sessionId, projectRoot, workingDirectory: projectRoot },
    sessionManager: {
      getEntries() {
        return entries
          .slice()
          .reverse()
          .map((entry) => ({
            type: "custom",
            customType: entry.type,
            data: entry.data,
            timestamp: entry.timestamp,
          }));
      },
      getSessionId() {
        return sessionId;
      },
      getSessionFile() {
        return undefined;
      },
      getCwd() {
        return projectRoot;
      },
      getSessionName() {
        return undefined;
      },
    },
    settings: {
      get(key) {
        return settings.get(key);
      },
      async set(key, value) {
        settings.set(key, value);
      },
    },
  };
  if (mode !== "tui") delete ctx.ui.custom;
  const pi: ExtensionAPI = {
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(customType, renderer) {
      messageRenderers.set(customType, renderer);
    },
    registerShortcut(shortcut, opts) {
      shortcuts.set(shortcut, opts);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async appendEntry(type, data) {
      entries.unshift({ type, data, timestamp: new Date().toISOString() });
    },
    async sendMessage(message, options) {
      sentMessages.push(options === undefined ? { message } : { message, options });
      if (options?.deliverAs === "nextTurn") customMessageDeliveries.push("nextTurn");
      else if (isStreaming) customMessageDeliveries.push(options?.deliverAs === "followUp" ? "followUp" : "steer");
      else if (options?.triggerTurn === true) customMessageDeliveries.push("turn");
      else customMessageDeliveries.push("append");
    },
    async sendUserMessage(message, options) {
      sentUserMessages.push(options === undefined ? { message } : { message, options });
      notifications.push(message);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames) {
      activeTools = toolNames;
      harness.activeTools = activeTools;
    },
    setModel(model) {
      selectedModel = model;
      ctx.model = model;
      harness.selectedModel = model;
      return true;
    },
    setThinkingLevel(level) {
      thinkingLevel = level;
      harness.thinkingLevel = level;
    },
    getThinkingLevel() {
      return thinkingLevel ?? "off";
    },
    registerProvider(name, config) {
      registeredProviders.set(name, config);
    },
    unregisterProvider(name) {
      registeredProviders.delete(name);
    },
  };
  harness = {
    pi,
    ctx,
    commands,
    tools,
    shortcuts,
    handlers,
    notifications,
    notificationEvents,
    sentMessages,
    messageRenderers,
    customMessageDeliveries,
    isStreaming,
    waitForIdleCalls: 0,
    setStreaming(value) {
      isStreaming = value;
      harness.isStreaming = value;
      if (!value) {
        for (const resolve of idleWaiters.splice(0)) resolve();
      }
    },
    sentUserMessages,
    widgets,
    widgetPayloads,
    widgetOptions,
    statuses,
    activeTools,
    entries,
    registeredProviders,
    selectQueue,
    selectCalls,
    customInputQueue,
    customRenderFrames,
    customComponents,
    customOptions,
    terminalInputHandlers,
    confirmQueue,
    confirmCalls,
    abortCalls: 0,
    editorText,
  };
  if (footerFactory) harness.footerFactory = footerFactory;
  if (selectedModel) harness.selectedModel = selectedModel;
  if (thinkingLevel) harness.thinkingLevel = thinkingLevel;
  return harness;
}

function optionMatchesQueue(option: string | { value: string; label?: string }, queued: string | undefined): boolean {
  if (queued === undefined) return false;
  if (typeof option === "string")
    return option === queued || option.startsWith(`${queued} `) || option.startsWith(`${queued} -`);
  return option.value === queued || option.label === queued;
}

export async function runTool(harness: Harness, name: string, params: unknown) {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute(`test-${name}`, params, new AbortController().signal, () => {}, harness.ctx);
}

export async function emit(harness: Harness, event: LifecycleEvent, payload: Record<string, unknown> = {}) {
  const results = [];
  const base =
    harness.ctx.session?.id === undefined ? { type: event } : { type: event, sessionId: harness.ctx.session.id };
  for (const handler of harness.handlers.get(event) ?? [])
    results.push(await handler({ ...base, ...payload }, harness.ctx));
  return results;
}
