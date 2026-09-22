const MAX_TRANSCRIPT_BLOCKS = 120;
const MAX_ASSISTANT_CONTENT_ITEMS = 100;
const MAX_RESULT_CONTENT_ITEMS = 100;
const MAX_TRANSCRIPT_BYTES = 512_000;
const MAX_TRANSCRIPT_NODES = 5_000;
const MAX_ASSISTANT_TEXT_LENGTH = 4_000;
const MAX_TOOL_VALUE_LENGTH = 32_000;
const REDACTED = "[redacted]";

export interface AgentTranscriptContent {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface AgentTranscriptAssistantMessage {
  role: "assistant";
  content: AgentTranscriptContent[];
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface AgentTranscriptToolResult {
  content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError: boolean;
}

export interface AgentTranscriptAssistantBlock {
  id: string;
  kind: "assistant";
  message: AgentTranscriptAssistantMessage;
  complete: boolean;
}

export interface AgentTranscriptToolBlock {
  id: string;
  kind: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: AgentTranscriptToolResult;
  isPartial: boolean;
}

export type AgentTranscriptBlock = AgentTranscriptAssistantBlock | AgentTranscriptToolBlock;

export interface AgentLiveTranscriptSnapshot {
  blocks: AgentTranscriptBlock[];
  omittedBlockCount: number;
  cwd: string;
  /** Pure projection of `blocks`; never a second timeline. */
  latestMessage?: string;
}

/**
 * Canonical, bounded semantic projection for one live agent row.
 * It owns complete assistant snapshots and structured tool lifecycle state;
 * renderers consume snapshots and never parse raw event/stdout lines.
 */
export class AgentLiveTranscript {
  readonly #blocks: AgentTranscriptBlock[] = [];
  readonly #toolIndexes = new Map<string, number>();
  #activeAssistantId: string | undefined;
  #nextAssistantId = 0;
  #omittedBlockCount = 0;
  #cwd: string;

  constructor(cwd = "") {
    this.#cwd = boundedString(cwd, MAX_TOOL_VALUE_LENGTH);
  }

  ingest(event: unknown, cwd = this.#cwd): AgentLiveTranscriptSnapshot {
    this.#cwd = boundedString(cwd, MAX_TOOL_VALUE_LENGTH);
    const type = eventType(event);
    if (type === "agent_end" && isRecord(event) && Array.isArray(event.messages)) {
      return this.replaceMessages(event.messages, this.#cwd);
    }
    if ((type === "message_start" || type === "message_update" || type === "message_end") && isRecord(event)) {
      this.#ingestMessage(event.message, type === "message_end");
    } else if (type === "tool_execution_start") {
      this.#startTool(event);
    } else if (type === "tool_execution_update") {
      this.#updateTool(event);
    } else if (type === "tool_execution_end") {
      this.#endTool(event);
    }
    this.#trim();
    return this.snapshot();
  }

  replaceMessages(messages: readonly unknown[], cwd = this.#cwd): AgentLiveTranscriptSnapshot {
    this.#blocks.length = 0;
    this.#toolIndexes.clear();
    this.#activeAssistantId = undefined;
    this.#nextAssistantId = 0;
    this.#omittedBlockCount = 0;
    this.#cwd = boundedString(cwd, MAX_TOOL_VALUE_LENGTH);
    for (const message of messages) this.#appendCanonicalMessage(message);
    this.#trim();
    return this.snapshot();
  }

  snapshot(): AgentLiveTranscriptSnapshot {
    const blocks = this.#blocks.map(cloneBlock);
    const latestMessage = latestVisibleAssistantText(blocks);
    return {
      blocks,
      omittedBlockCount: this.#omittedBlockCount,
      cwd: this.#cwd,
      ...(latestMessage === undefined ? {} : { latestMessage }),
    };
  }

  #ingestMessage(value: unknown, complete: boolean): void {
    if (!isRecord(value)) return;
    if (value.role === "toolResult") {
      this.#applyToolResult(value);
      return;
    }
    if (value.role !== "assistant") return;
    const message = assistantMessage(value, complete);
    const id = this.#activeAssistantId ?? `assistant:${++this.#nextAssistantId}`;
    const existing = this.#blocks.findIndex((block) => block.id === id);
    const block: AgentTranscriptAssistantBlock = { id, kind: "assistant", message, complete };
    if (existing < 0) this.#blocks.push(block);
    else this.#blocks[existing] = block;
    for (const content of message.content) {
      if (content.type === "toolCall") this.#upsertToolFromCall(content);
    }
    this.#activeAssistantId = complete ? undefined : id;
  }

  #appendCanonicalMessage(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.role === "assistant") {
      this.#ingestMessage(value, true);
      return;
    }
    if (value.role === "toolResult") this.#applyToolResult(value);
  }

  #upsertToolFromCall(content: AgentTranscriptContent): void {
    const toolCallId = content.id;
    if (toolCallId === undefined) return;
    const current = this.#tool(toolCallId);
    const block: AgentTranscriptToolBlock = {
      id: `tool:${toolCallId}`,
      kind: "tool",
      toolCallId,
      toolName: content.name ?? "tool",
      args: boundedValue(content.arguments ?? {}),
      cwd: this.#cwd,
      executionStarted: current?.executionStarted ?? false,
      argsComplete: true,
      ...(current?.result === undefined ? {} : { result: current.result }),
      isPartial: current?.isPartial ?? true,
    };
    this.#setTool(toolCallId, block);
  }

  #startTool(event: unknown): void {
    const toolCallId = eventToolCallId(event);
    if (toolCallId === undefined) return;
    const current = this.#tool(toolCallId);
    this.#setTool(toolCallId, {
      id: `tool:${toolCallId}`,
      kind: "tool",
      toolCallId,
      toolName: eventToolName(event) ?? current?.toolName ?? "tool",
      args: boundedValue(eventToolArgs(event) ?? current?.args ?? {}),
      cwd: this.#cwd,
      executionStarted: true,
      argsComplete: eventArgsComplete(event),
      ...(current?.result === undefined ? {} : { result: current.result }),
      isPartial: current?.isPartial ?? true,
    });
  }

  #updateTool(event: unknown): void {
    const toolCallId = eventToolCallId(event);
    if (toolCallId === undefined) return;
    if (this.#tool(toolCallId) === undefined) this.#startTool(event);
    const current = this.#tool(toolCallId);
    if (current === undefined) return;
    const args = eventToolArgs(event);
    const partial = toolResult(isRecord(event) ? event.partialResult : undefined, false);
    this.#setTool(toolCallId, {
      ...current,
      ...(args === undefined ? {} : { args: boundedValue(args) }),
      argsComplete: eventArgsComplete(event) || current.argsComplete,
      ...(partial === undefined ? {} : { result: partial }),
      isPartial: true,
    });
  }

  #endTool(event: unknown): void {
    const toolCallId = eventToolCallId(event);
    if (toolCallId === undefined) return;
    if (this.#tool(toolCallId) === undefined) this.#startTool(event);
    const current = this.#tool(toolCallId);
    if (current === undefined) return;
    const result = toolResult(isRecord(event) ? event.result : undefined, isRecord(event) && event.isError === true);
    this.#setTool(toolCallId, {
      ...current,
      executionStarted: true,
      argsComplete: true,
      ...(result === undefined ? {} : { result }),
      isPartial: false,
    });
  }

  #applyToolResult(message: Record<string, unknown>): void {
    const toolCallId = fieldMessage(message.toolCallId);
    if (toolCallId === undefined) return;
    const current = this.#tool(toolCallId) ?? {
      id: `tool:${toolCallId}`,
      kind: "tool" as const,
      toolCallId,
      toolName: fieldMessage(message.toolName) ?? "tool",
      args: {},
      cwd: this.#cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
    };
    const result = toolResult(message, message.isError === true);
    this.#setTool(toolCallId, {
      ...current,
      ...(result === undefined ? {} : { result }),
      isPartial: false,
    });
  }

  #tool(toolCallId: string): AgentTranscriptToolBlock | undefined {
    const index = this.#toolIndexes.get(toolCallId);
    const block = index === undefined ? undefined : this.#blocks[index];
    return block?.kind === "tool" ? block : undefined;
  }

  #setTool(toolCallId: string, block: AgentTranscriptToolBlock): void {
    const index = this.#toolIndexes.get(toolCallId);
    if (index === undefined) {
      this.#toolIndexes.set(toolCallId, this.#blocks.length);
      this.#blocks.push(block);
    } else {
      this.#blocks[index] = block;
    }
  }

  #trim(): void {
    let removed = 0;
    while (this.#blocks.length > 0) {
      const budget = transcriptBudget(this.#blocks);
      if (
        this.#blocks.length <= MAX_TRANSCRIPT_BLOCKS &&
        budget.bytes <= MAX_TRANSCRIPT_BYTES &&
        budget.nodes <= MAX_TRANSCRIPT_NODES
      )
        break;
      this.#blocks.shift();
      removed += 1;
    }
    if (removed === 0) return;
    this.#omittedBlockCount += removed;
    this.#reindexTools();
  }

  #reindexTools(): void {
    this.#toolIndexes.clear();
    this.#blocks.forEach((block, index) => {
      if (block.kind === "tool") this.#toolIndexes.set(block.toolCallId, index);
    });
  }
}

export function latestVisibleAssistantText(blocks: readonly AgentTranscriptBlock[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== "assistant") continue;
    for (let contentIndex = block.message.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      const content = block.message.content[contentIndex];
      if (content?.type !== "text") continue;
      const text = compactVisibleText(content.text, !block.complete);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function assistantMessage(value: Record<string, unknown>, complete: boolean): AgentTranscriptAssistantMessage {
  const content = Array.isArray(value.content)
    ? value.content.flatMap((item) => assistantContent(item, !complete)).slice(0, MAX_ASSISTANT_CONTENT_ITEMS)
    : [];
  const errorMessage = fieldMessage(value.errorMessage);
  return {
    role: "assistant",
    content,
    api: fieldMessage(value.api) ?? "unknown",
    provider: fieldMessage(value.provider) ?? "unknown",
    model: fieldMessage(value.model) ?? "unknown",
    usage: usage(value.usage),
    stopReason: stopReason(value.stopReason),
    ...(errorMessage === undefined ? {} : { errorMessage: boundedString(errorMessage, MAX_ASSISTANT_TEXT_LENGTH) }),
    timestamp: finiteNumber(value.timestamp) ?? Date.now(),
  };
}

function assistantContent(value: unknown, streaming: boolean): AgentTranscriptContent[] {
  if (!isRecord(value)) return [];
  if (value.type === "text")
    return [
      { type: "text", text: boundedString(fieldMessage(value.text) ?? "", MAX_ASSISTANT_TEXT_LENGTH, streaming) },
    ];
  if (value.type === "thinking")
    return [
      { type: "thinking", thinking: boundedString(fieldMessage(value.thinking) ?? "", MAX_ASSISTANT_TEXT_LENGTH) },
    ];
  if (value.type !== "toolCall") return [];
  const id = fieldMessage(value.id);
  return [
    {
      type: "toolCall",
      ...(id === undefined ? {} : { id }),
      name: fieldMessage(value.name) ?? "tool",
      arguments: boundedValue(value.arguments ?? {}),
    },
  ];
}

function toolResult(value: unknown, isError: boolean): AgentTranscriptToolResult | undefined {
  if (value === undefined) return undefined;
  const record = isRecord(value) ? value : undefined;
  const rawContent = record?.content ?? value;
  const content = resultContent(rawContent);
  const details = record?.details;
  return {
    content,
    ...(details === undefined ? {} : { details: boundedValue(details) }),
    isError: record?.isError === true || isError,
  };
}

function resultContent(value: unknown): AgentTranscriptToolResult["content"] {
  if (Array.isArray(value)) return value.flatMap(resultContentItem).slice(0, MAX_RESULT_CONTENT_ITEMS);
  return resultContentItem(value);
}

function resultContentItem(value: unknown): AgentTranscriptToolResult["content"] {
  if (typeof value === "string") return [{ type: "text", text: boundedString(value, MAX_TOOL_VALUE_LENGTH) }];
  if (!isRecord(value)) return [{ type: "text", text: boundedString(stringify(value), MAX_TOOL_VALUE_LENGTH) }];
  if (value.type === "image") {
    return [{ type: "image", data: REDACTED, mimeType: fieldMessage(value.mimeType) ?? "application/octet-stream" }];
  }
  if (value.type === "text")
    return [{ type: "text", text: boundedString(fieldMessage(value.text) ?? "", MAX_TOOL_VALUE_LENGTH) }];
  if (value.content !== undefined) return resultContent(value.content);
  return [{ type: "text", text: boundedString(stringify(boundedValue(value)), MAX_TOOL_VALUE_LENGTH) }];
}

function cloneBlock(block: AgentTranscriptBlock): AgentTranscriptBlock {
  return structuredClone(block);
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string") return boundedString(value, MAX_TOOL_VALUE_LENGTH);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundedValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = isSensitiveKey(key) ? REDACTED : boundedValue(item, depth + 1);
  }
  return output;
}

function transcriptBudget(blocks: readonly AgentTranscriptBlock[]): { bytes: number; nodes: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify(blocks);
  } catch {
    serialized = String(blocks);
  }
  return { bytes: Buffer.byteLength(serialized, "utf8"), nodes: countNodes(blocks) };
}

function countNodes(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) return 1 + value.reduce((total, item) => total + countNodes(item), 0);
  return 1 + Object.values(value).reduce((total, item) => total + countNodes(item), 0);
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[-_]?key|authorization|cookie|password|secret|token)/iu.test(key);
}

function usage(value: unknown): AgentTranscriptAssistantMessage["usage"] {
  const record = isRecord(value) ? value : {};
  const cost = isRecord(record.cost) ? record.cost : {};
  return {
    input: finiteNumber(record.input) ?? 0,
    output: finiteNumber(record.output) ?? 0,
    cacheRead: finiteNumber(record.cacheRead) ?? 0,
    cacheWrite: finiteNumber(record.cacheWrite) ?? 0,
    totalTokens: finiteNumber(record.totalTokens) ?? 0,
    cost: {
      input: finiteNumber(cost.input) ?? 0,
      output: finiteNumber(cost.output) ?? 0,
      cacheRead: finiteNumber(cost.cacheRead) ?? 0,
      cacheWrite: finiteNumber(cost.cacheWrite) ?? 0,
      total: finiteNumber(cost.total) ?? 0,
    },
  };
}

function stopReason(value: unknown): AgentTranscriptAssistantMessage["stopReason"] {
  return value === "length" || value === "toolUse" || value === "error" || value === "aborted" ? value : "stop";
}

function eventToolCallId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  return fieldMessage(event.toolCallId) ?? (isRecord(event.toolCall) ? fieldMessage(event.toolCall.id) : undefined);
}

function eventToolName(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  return (
    fieldMessage(event.toolName) ??
    fieldMessage(event.tool) ??
    fieldMessage(event.name) ??
    (isRecord(event.toolCall) ? fieldMessage(event.toolCall.name ?? event.toolCall.toolName) : undefined)
  );
}

function eventToolArgs(event: unknown): unknown {
  if (!isRecord(event)) return undefined;
  for (const key of ["args", "arguments", "input"] as const) if (event[key] !== undefined) return event[key];
  if (!isRecord(event.toolCall)) return undefined;
  for (const key of ["args", "arguments", "input"] as const)
    if (event.toolCall[key] !== undefined) return event.toolCall[key];
  return undefined;
}

function eventArgsComplete(event: unknown): boolean {
  return isRecord(event) && (event.argsComplete === true || event.argumentsComplete === true);
}

function compactVisibleText(value: string | undefined, streaming: boolean): string | undefined {
  const text = value?.replace(/\s+/gu, " ").trim();
  return text === undefined || text === "" ? undefined : boundedString(text, 300, streaming);
}

function boundedString(value: string, max: number, keepTail = false): string {
  if (value.length <= max) return value;
  // Live snapshots follow new output; completed reports keep their opening.
  return keepTail ? `…${value.slice(-(max - 1))}` : `${value.slice(0, max - 1)}…`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fieldMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (value instanceof Error && value.message.trim() !== "") return value.message;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventType(event: unknown): string {
  return isRecord(event) ? (fieldMessage(event.type) ?? "unknown") : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
