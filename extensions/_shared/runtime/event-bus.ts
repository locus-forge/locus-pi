import { safeToolText } from "../host/safe-output.js";

export interface DevEvent {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

const events: DevEvent[] = [];
const MAX_EVENTS = 500;

export function emitDevEvent(type: string, payload: Record<string, unknown> = {}): DevEvent {
  const sanitizedPayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    sanitizedPayload[key] = typeof value === "string" ? safeToolText(value).text : value;
  }
  const event = { timestamp: new Date().toISOString(), type, payload: sanitizedPayload };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return event;
}

export function getDevEvents(limit = 50): DevEvent[] {
  return events.slice(Math.max(0, events.length - limit));
}

export function clearDevEvents(): void {
  events.splice(0, events.length);
}
