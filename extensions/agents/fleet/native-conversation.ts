import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  UserMessageComponent,
  ToolExecutionComponent,
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Render the SDK-owned conversation, not the bounded roster preview. Never writes the session. */
export class NativeAgentConversation implements Component {
  #components = new Map<string, Component>();
  #toolsExpanded = false;
  readonly #tools = new Map<string, NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>>();
  constructor(
    private readonly read: () => readonly unknown[],
    private readonly tui: TUI,
    private readonly cwd: string,
    private readonly initialTask?: () => string | undefined,
  ) {
    // Display definitions only: these tools are never registered or executed by the viewer.
    for (const definition of [
      createBashToolDefinition(cwd),
      createReadToolDefinition(cwd),
      createWriteToolDefinition(cwd),
      createEditToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createGrepToolDefinition(cwd),
      createLsToolDefinition(cwd),
      createPowerShellToolDefinition(cwd),
    ])
      this.#tools.set(definition.name, definition);
  }
  toggleToolsExpanded(): void {
    this.#toolsExpanded = !this.#toolsExpanded;
    for (const component of this.#components.values()) {
      if (component instanceof ToolExecutionComponent) component.setExpanded(this.#toolsExpanded);
    }
    this.tui.requestRender();
  }
  invalidate(): void {
    for (const component of this.#components.values()) component.invalidate();
  }
  render(width: number): string[] {
    const messages = this.read().filter(record);
    const results = new Map(
      messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]),
    );
    const firstUser = messages.findIndex((message) => message.role === "user");
    const live = new Set<string>();
    const lines: string[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      const key = `${index}:${String(message.role)}`;
      if (message.role === "user") {
        const text =
          index === firstUser && this.initialTask?.() !== undefined
            ? this.initialTask()!
            : typeof message.content === "string"
              ? message.content
              : Array.isArray(message.content)
                ? message.content
                    .filter(record)
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                : "";
        // User messages are immutable, while assistant snapshots may stream in place.
        let component = this.#components.get(key);
        if (component === undefined) {
          component = new UserMessageComponent(text);
          this.#components.set(key, component);
        }
        live.add(key);
        lines.push(...component.render(width));
      } else if (message.role === "assistant") {
        let component = this.#components.get(key) as AssistantMessageComponent | undefined;
        if (component === undefined) {
          component = new AssistantMessageComponent(
            message as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0],
          );
          this.#components.set(key, component);
        } else component.updateContent(message as unknown as Parameters<AssistantMessageComponent["updateContent"]>[0]);
        live.add(key);
        lines.push(...component.render(width));
        for (const call of Array.isArray(message.content) ? message.content.filter(record) : []) {
          if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
          const toolKey = `tool:${call.id}`;
          let tool = this.#components.get(toolKey) as ToolExecutionComponent | undefined;
          if (tool === undefined) {
            tool = new ToolExecutionComponent(
              call.name,
              call.id,
              call.arguments,
              { showImages: false },
              this.#tools.get(call.name),
              this.tui,
              this.cwd,
            );
            tool.setExpanded(this.#toolsExpanded);
            this.#components.set(toolKey, tool);
          }
          tool.updateArgs(call.arguments);
          const result = results.get(call.id);
          if (result !== undefined) {
            tool.setArgsComplete();
            tool.updateResult(result as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0], false);
          }
          live.add(toolKey);
          lines.push(...tool.render(width));
        }
      }
    }
    for (const key of this.#components.keys()) if (!live.has(key)) this.#components.delete(key);
    return lines;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
