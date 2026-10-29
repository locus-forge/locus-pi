import type { SdkSessionStatsLike, AgentLiveStatus, AgentLiveActivityState } from "../agent-live-store.js";
const MAX_AGENT_LIVE_EVENT_LINES = 200;
const MAX_AGENT_LIVE_EVENT_LINE_LENGTH = 300;
const MAX_AGENT_LIVE_REQUEST_LENGTH = 32_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolOrStepEvent(event: unknown): boolean {
  const type = eventTypeName(event).toLowerCase();
  return type.includes("tool") || type.includes("step");
}

export function isToolResultEvent(event: unknown): boolean {
  const type = eventTypeName(event).toLowerCase();
  return type.includes("result") || type.includes("end") || type.includes("finish");
}

export function eventToolName(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["toolName", "tool", "name"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const toolCall = event["toolCall"];
  if (isRecord(toolCall)) {
    const name = toolCall["name"] ?? toolCall["toolName"];
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return undefined;
}

export function eventPath(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["currentPath", "cwd", "workingDirectory", "path"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim() !== "") return compactAgentLiveValue(value);
  }
  return undefined;
}

export function eventToolArgs(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["args", "arguments", "input"]) {
    const value = event[key];
    const formatted = eventFieldValue(value);
    if (formatted !== undefined) return formatted;
  }
  const toolCall = event["toolCall"];
  if (isRecord(toolCall)) {
    for (const key of ["args", "arguments", "input"]) {
      const formatted = eventFieldValue(toolCall[key]);
      if (formatted !== undefined) return formatted;
    }
  }
  return undefined;
}

export function eventErrorMessage(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const nested of [event.message, event.error]) {
    if (!isRecord(nested)) continue;
    const message = eventFieldMessage(nested.errorMessage);
    if (message !== undefined) return message;
  }
  for (const key of ["error", "message", "reason"]) {
    const value = event[key];
    const message = eventFieldMessage(value);
    if (message !== undefined) return message;
  }
  return undefined;
}

/** Count one completed model turn. message_end carries the same message, so it is ignored. */
export function eventTurnUsage(event: unknown): { input: number; output: number } | undefined {
  if (!isRecord(event) || eventTypeName(event) !== "turn_end") return undefined;
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  const input = finiteNonNegativeNumber(usage.input);
  const output = finiteNonNegativeNumber(usage.output);
  return input === undefined || output === undefined ? undefined : { input, output };
}

export function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function eventTypeName(event: unknown): string {
  if (!isRecord(event)) return "unknown";
  const value = event.type;
  return typeof value === "string" && value.trim() !== "" ? value : "unknown";
}

export function formatAgentLiveEventLine(event: unknown): string {
  const parts = [`event type=${eventTypeName(event)}`];
  const tool = eventToolName(event);
  if (tool !== undefined) parts.push(`tool=${tool}`);
  if (isRecord(event)) {
    for (const key of ["error", "message", "reason"]) {
      const message = eventFieldMessage(event[key]);
      if (message !== undefined) parts.push(`${key}=${message}`);
    }
  }
  return boundedAgentLiveLine(parts.join(" "));
}

export function formatAgentLiveStatsLine(stats: SdkSessionStatsLike): string {
  return boundedAgentLiveLine(
    `stats sessionId=${stats.sessionId} toolCalls=${stats.toolCalls} toolResults=${stats.toolResults}`,
  );
}

export function appendAgentLiveEventLine(lines: string[], line: string): string[] {
  return [...lines, line].slice(-MAX_AGENT_LIVE_EVENT_LINES);
}

export function eventFieldMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return compactAgentLiveValue(value);
  if (value instanceof Error && value.message.trim() !== "") return compactAgentLiveValue(value.message);
  return undefined;
}

export function eventFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : boundedAgentLiveLine(value);
  try {
    return boundedAgentLiveLine(JSON.stringify(value));
  } catch {
    return boundedAgentLiveLine(String(value));
  }
}

export function boundedAgentLiveLine(value: string): string {
  const compacted = compactAgentLiveValue(value);
  if (compacted.length <= MAX_AGENT_LIVE_EVENT_LINE_LENGTH) return compacted;
  return `${compacted.slice(0, MAX_AGENT_LIVE_EVENT_LINE_LENGTH - 1)}…`;
}

export function compactAgentLiveValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function boundedAgentLiveRequest(value: string): string {
  if (value.length <= MAX_AGENT_LIVE_REQUEST_LENGTH) return value;
  const omitted = value.length - MAX_AGENT_LIVE_REQUEST_LENGTH;
  return `${value.slice(0, MAX_AGENT_LIVE_REQUEST_LENGTH)}\n\n… ${omitted} additional request character(s) omitted`;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function activityStateForStatus(status: AgentLiveStatus): AgentLiveActivityState {
  switch (status) {
    case "queued":
      return "waiting";
    case "working":
      return "active";
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}

export function isTerminalAgentLiveStatus(status: AgentLiveStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}
