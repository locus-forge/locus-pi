import { guardCommandCenterInput } from "./command-center-editor.js";
import { AgentsCommandCenter } from "./command-center.js";
import { activityStore, renderActivityStrip, type AgentActivity } from "../../_shared/agent-runtime/activity-store.js";
import {
  renderStatusLines,
  paintStatusLines,
  formatStatusCwd,
} from "../../_shared/agent-runtime/status-line-render.js";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../../_shared/host/render-profile.js";
import { NativeAgentConversation } from "./native-conversation.js";
import {
  matchesKey,
  Editor,
  ScrollView,
  VStack,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveRow,
} from "../../_shared/agent-runtime/agent-live-store.js";

interface AgentView {
  execution: AgentLiveExecutionHandle;
  input: Editor;
  transcript: ScrollView;
  root: VStack;
  notice: string;
}

/** One independent viewport and draft per execution. Group rows are never agents. */
export class AgentScreen {
  #views = new Map<string, AgentView>();
  #active: string | undefined;
  #generation = 0;
  #closed = false;
  #center: AgentsCommandCenter | undefined;
  #unsubscribe: () => void;

  constructor(
    private readonly tui: TUI & { setLayoutRoot(component: Component): void },
    private readonly returnMain: () => void,
    private readonly reportError: (message: string) => void = () => {},
    private readonly theme?: ThemeLike,
  ) {
    const changed = () => {
      if (!this.#closed) this.tui.requestRender();
    };
    activityStore.emitter.on("change", changed);
    this.#unsubscribe = () => activityStore.emitter.off("change", changed);
  }

  async select(id: string): Promise<void> {
    ++this.#generation;
    if (id === "main") {
      this.returnMain();
      return;
    }
    const rows = [...agentLiveStore.rows.values()].filter(isAgentScreenRow);
    if (id === "last") id = rows.at(-1)?.id ?? id;
    if (!agentLiveStore.rows.has(id)) {
      const matches = rows.filter((row) => row.displayName === id || row.agentName === id || row.childSessionId === id);
      if (matches.length === 1) id = matches[0]!.id;
      else if (matches.length > 1) {
        this.list(`Ambiguous agent: ${id}; use an exact ID.`);
        return;
      }
    }
    const execution = agentLiveStore.captureExecutionAuthority(id);
    const row = execution === undefined ? undefined : agentLiveStore.rowForExecution(execution);
    if (execution === undefined || row === undefined || !isAgentScreenRow(row)) {
      this.list(`Unknown agent: ${id}`);
      return;
    }
    let view = this.#views.get(id);
    if (view?.execution !== execution) {
      const input = new Editor(this.tui, {
        borderColor: (text) => {
          const level = agentLiveStore.sessionDisplay(execution).thinking;
          const color = level === undefined ? "borderMuted" : `thinking${level[0]!.toUpperCase()}${level.slice(1)}`;
          return this.theme?.fg?.(color, text) ?? text;
        },
        selectList: getSelectListTheme(),
      });
      const conversation = new NativeAgentConversation(
        () => agentLiveStore.conversation(execution) ?? [],
        this.tui,
        row.currentPath ?? process.cwd(),
        () => row.request ?? agentLiveStore.sessionDisplay(execution).task,
      );
      const transcript = new ScrollView(conversation, { primary: true, follow: "end", scrollbar: "auto" });
      const status: Component = {
        invalidate() {},
        render: (width) => {
          const current = agentLiveStore.rowForExecution(execution);
          const display = agentLiveStore.sessionDisplay(execution);
          return paintStatusLines(
            renderStatusLines(
              {
                cwd: formatStatusCwd(display.cwd ?? "cwd:?"),
                model: display.model ?? "model:?",
                effort: display.thinking ?? "effort:?",
                controls: `sub-agent ${current?.displayName ?? id} · ${current?.status ?? "exited"} · Esc main · ← agents`,
                contextTokens: display.contextTokens ?? null,
                contextWindow: display.contextWindow ?? 0,
                contextPercent: display.contextPercent ?? null,
                compaction: { kind: "unknown" },
              },
              width,
            ),
            width,
          );
        },
      };
      const strip: Component = {
        invalidate() {},
        render: (width) => [
          ...renderActivityStrip(width),
          ...(view?.notice ? [truncateToWidth(view.notice, width)] : []),
        ],
      };
      const root = new VStack([
        { component: transcript, basis: 0, grow: 1, minSize: 1 },
        { component: input, grow: 0, shrink: 0, minSize: 1 },
        { component: status, grow: 0, shrink: 1, minSize: 0 },
        { component: strip, grow: 0, shrink: 1, minSize: 0 },
      ]);
      view = { execution, input, transcript, root, notice: "" };
      input.onSubmit = (text) => {
        void this.submit(id, text).catch((error) => this.reportError(String(error)));
      };
      const handleInput = input.handleInput.bind(input);
      input.handleInput = (data) => {
        if (matchesKey(data, "escape")) this.returnMain();
        else if (matchesKey(data, "ctrl+c")) agentLiveStore.cancel(id);
        else handleInput(data);
      };
      guardCommandCenterInput(input, () => this.list());
      this.#views.set(id, view);
    }
    this.#center = undefined;
    this.#active = id;
    this.tui.setLayoutRoot(view.root);
    this.tui.setFocus(view.input);
    this.tui.requestRender(true);
  }

  suspend(): void {
    this.#active = undefined;
    this.#center = undefined;
    ++this.#generation;
  }

  list(notice = ""): void {
    ++this.#generation;
    activityStore.capture();
    if (notice) this.reportError(notice);
    const prior = this.#active === undefined ? undefined : this.#views.get(this.#active);
    const dismiss = () => {
      this.#center = undefined;
      if (prior === undefined) this.returnMain();
      else {
        this.tui.setLayoutRoot(prior.root);
        this.tui.setFocus(prior.input);
        this.tui.requestRender(true);
      }
    };
    this.#center = new AgentsCommandCenter(
      () => this.tui.terminal?.rows ?? 24,
      (entry) => {
        if (entry.current && agentLiveStore.isExecutionAuthorityCurrent(entry.execution)) {
          void this.select(entry.row.id).catch((error) => this.reportError(String(error)));
        } else this.history(entry);
      },
      dismiss,
      () => this.tui.requestRender(),
      activityStore,
      [...activityStore.agents.values()].find((a) => a.row.id === this.#active && a.current)?.key,
    );
    this.tui.setLayoutRoot(this.#center);
    this.tui.setFocus(this.#center);
    this.tui.requestRender(true);
  }

  private history(entry: AgentActivity): void {
    const center = this.#center;
    const conversation = new NativeAgentConversation(
      () => entry.conversation,
      this.tui,
      entry.display.cwd ?? entry.row.currentPath ?? process.cwd(),
      () => entry.row.request,
    );
    const transcript = new ScrollView(conversation, { primary: true, follow: "none", scrollbar: "auto" });
    const controls: Component = {
      invalidate() {},
      render: (width) => [
        truncateToWidth(`${entry.row.displayName ?? "Agent"} · historical snapshot · read-only · Esc back`, width),
      ],
      handleInput: (data) => {
        if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
          if (center) {
            this.tui.setLayoutRoot(center);
            this.tui.setFocus(center);
            this.tui.requestRender(true);
          } else this.returnMain();
        } else if (matchesKey(data, "up")) transcript.scrollBy(-1);
        else if (matchesKey(data, "down")) transcript.scrollBy(1);
        else if (matchesKey(data, "pageUp")) transcript.scrollBy(-10);
        else if (matchesKey(data, "pageDown")) transcript.scrollBy(10);
        this.tui.requestRender();
      },
    };
    this.tui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, minSize: 1 },
        { component: controls, grow: 0, shrink: 0 },
      ]),
    );
    this.tui.setFocus(controls);
    this.tui.requestRender(true);
  }

  private async submit(id: string, text: string): Promise<void> {
    const view = this.#views.get(id);
    if (view === undefined || this.#closed) return;
    const command = text.trim();
    if (command === "/ps") {
      view.input.setText("");
      this.list();
      return;
    }
    if (command.startsWith("/ps ")) {
      view.input.setText("");
      await this.select(command.slice(4).trim());
      return;
    }
    if (command === "/cancel") {
      agentLiveStore.cancel(id);
      view.input.setText("");
      return;
    }
    if (command === "/exit") {
      try {
        await agentLiveStore.exitAgent(id);
      } finally {
        this.returnMain();
      }
      return;
    }
    const submission = ++this.#generation;
    view.input.addToHistory(text);
    view.transcript.scrollToEnd();
    view.input.setText("");
    const result = await agentLiveStore.sendInputForExecution(view.execution, text);
    if (this.#closed) return;
    view.notice = result.ok ? "" : result.reason;
    if (!result.ok && submission === this.#generation && view.input.getText() === "") view.input.setText(text);

    this.tui.requestRender();
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    ++this.#generation;
    this.#unsubscribe();
    this.#views.clear();
  }
}

/** Workflow slot/group rows are projections, never separate agent runtimes. */
export function isAgentScreenRow(row: AgentLiveRow): boolean {
  return row.groupKind === undefined && !row.id.startsWith("workflow:");
}
