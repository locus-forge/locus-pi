import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CustomEntry } from "../host/pi-api.js";

export const SESSION_ENTRY_TYPES = [
  "session_init",
  "message",
  "custom",
  "custom_message",
  "decision",
  "compact_summary",
  "branch_summary",
  "child_run",
  "artifact",
] as const;

export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number];
export type SessionRole = "system" | "user" | "assistant" | "tool";

export interface SessionRecord {
  id: string;
  createdAt: string;
  projectRoot?: string;
  workingDirectory?: string;
  parentSessionId?: string;
  metadata: Record<string, unknown>;
}

export type SessionEntryPayloadByType = {
  session_init: {
    projectRoot?: string;
    workingDirectory?: string;
    parentSessionId?: string;
    metadata?: Record<string, unknown>;
  };
  message: {
    role: SessionRole;
    content: string;
    hidden?: boolean;
    metadata?: Record<string, unknown>;
  };
  custom: {
    type: string;
    data: unknown;
  };
  custom_message: {
    role?: SessionRole;
    content: string;
    hidden?: boolean;
    metadata?: Record<string, unknown>;
  };
  decision: {
    decisionId?: string;
    question?: string;
    answer?: unknown;
    status: "answered" | "cancelled" | "deferred";
    metadata?: Record<string, unknown>;
  };
  compact_summary: {
    summary: string;
    sourceEntryIds?: string[];
    metadata?: Record<string, unknown>;
  };
  branch_summary: {
    branch: string;
    summary: string;
    sourceEntryIds?: string[];
    metadata?: Record<string, unknown>;
  };
  child_run: {
    childSessionId: string;
    status: "created" | "running" | "completed" | "failed" | "cancelled";
    metadata?: Record<string, unknown>;
  };
  artifact: {
    path: string;
    kind?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
};

export type SessionEntryPayload<T extends SessionEntryType = SessionEntryType> = SessionEntryPayloadByType[T];

export type SessionEntryInput<T extends SessionEntryType = SessionEntryType> = T extends SessionEntryType
  ? {
      type: T;
      payload: SessionEntryPayloadByType[T];
      createdAt?: string;
      id?: string;
    }
  : never;

export interface SessionEntry<T extends SessionEntryType = SessionEntryType> {
  id: string;
  sessionId: string;
  type: T;
  payload: SessionEntryPayloadByType[T];
  createdAt: string;
  sequence: number;
}

export interface CreateSessionInput {
  id?: string;
  projectRoot?: string;
  workingDirectory?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionQuery {
  sessionId?: string;
  type?: SessionEntryType;
  limit?: number;
}

export interface SessionIdFactory {
  nextSessionId(parentSessionId?: string): string;
  nextEntryId(sessionId: string, type: SessionEntryType): string;
}

export interface MemorySessionStoreOptions {
  idFactory?: SessionIdFactory;
  now?: () => string;
}

export interface JsonlSessionStoreOptions extends MemorySessionStoreOptions {
  filePath: string;
}

export interface HandoffSummaryOptions {
  includeTypes?: SessionEntryType[];
  limit?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export type SessionStoreJsonlRecord =
  { kind: "session"; session: SessionRecord } | { kind: "entry"; entry: SessionEntry };

const ENTRY_TYPE_SET: ReadonlySet<string> = new Set(SESSION_ENTRY_TYPES);

export function isSessionEntryType(type: string): type is SessionEntryType {
  return ENTRY_TYPE_SET.has(type);
}

export function createDeterministicSessionIdFactory(prefix = "test"): SessionIdFactory {
  let sessionCount = 0;
  let entryCount = 0;
  return {
    nextSessionId(parentSessionId) {
      sessionCount += 1;
      return parentSessionId === undefined
        ? `${prefix}-session-${sessionCount}`
        : `${prefix}-session-${sessionCount}-child-of-${parentSessionId}`;
    },
    nextEntryId(_sessionId, type) {
      entryCount += 1;
      return `${prefix}-entry-${entryCount}-${type}`;
    },
  };
}

export class MemorySessionStore {
  protected readonly sessions = new Map<string, SessionRecord>();
  protected readonly entries: SessionEntry[] = [];
  protected readonly idFactory: SessionIdFactory;
  protected readonly now: () => string;
  protected sequence = 0;

  constructor(options: MemorySessionStoreOptions = {}) {
    this.idFactory = options.idFactory ?? createDeterministicSessionIdFactory("memory");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = input.id ?? this.idFactory.nextSessionId(input.parentSessionId);
    if (this.sessions.has(id)) throw new Error(`Session already exists: ${id}`);

    const createdAt = this.now();
    const session: SessionRecord = {
      id,
      createdAt,
      metadata: input.metadata ?? {},
    };
    if (input.projectRoot !== undefined) session.projectRoot = input.projectRoot;
    if (input.workingDirectory !== undefined) session.workingDirectory = input.workingDirectory;
    if (input.parentSessionId !== undefined) session.parentSessionId = input.parentSessionId;
    this.sessions.set(id, session);
    const payload: SessionEntryPayloadByType["session_init"] = {};
    if (input.projectRoot !== undefined) payload.projectRoot = input.projectRoot;
    if (input.workingDirectory !== undefined) payload.workingDirectory = input.workingDirectory;
    if (input.parentSessionId !== undefined) payload.parentSessionId = input.parentSessionId;
    if (input.metadata !== undefined) payload.metadata = input.metadata;
    this.appendEntry(id, {
      type: "session_init",
      payload,
      createdAt,
    });
    return session;
  }

  createChildSession(parentSessionId: string, input: Omit<CreateSessionInput, "parentSessionId"> = {}): SessionRecord {
    this.requireSession(parentSessionId);
    const child = this.createSession({ ...input, parentSessionId });
    this.appendEntry(parentSessionId, {
      type: "child_run",
      payload: {
        childSessionId: child.id,
        status: "created",
      },
    });
    return child;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  appendEntry<T extends SessionEntryType>(sessionId: string, input: SessionEntryInput<T>): SessionEntry<T> {
    this.requireSession(sessionId);
    const validation = validateSessionEntryInput(input);
    if (!validation.ok) throw new Error(`Invalid ${input.type} entry: ${validation.errors.join("; ")}`);

    const entry = {
      id: input.id ?? this.idFactory.nextEntryId(sessionId, input.type),
      sessionId,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? this.now(),
      sequence: ++this.sequence,
    } as SessionEntry<T>;
    this.entries.push(entry);
    return entry;
  }

  listEntries(query: SessionQuery = {}): SessionEntry[] {
    const filtered = this.entries.filter((entry) => {
      if (query.sessionId !== undefined && entry.sessionId !== query.sessionId) return false;
      if (query.type !== undefined && entry.type !== query.type) return false;
      return true;
    });
    const ordered = filtered.sort((left, right) => left.sequence - right.sequence);
    return query.limit === undefined ? ordered : ordered.slice(Math.max(0, ordered.length - query.limit));
  }

  latestEntry<T extends SessionEntryType>(sessionId: string, type?: T): SessionEntry<T> | undefined {
    const entries = this.listEntries({ sessionId, ...(type === undefined ? {} : { type }) });
    return entries.at(-1) as SessionEntry<T> | undefined;
  }

  summarizeForHandoff(sessionId: string, options: HandoffSummaryOptions = {}): string {
    const session = this.requireSession(sessionId);
    const includeTypes = new Set(options.includeTypes ?? SESSION_ENTRY_TYPES);
    const entries = this.listEntries({ sessionId }).filter((entry) => includeTypes.has(entry.type));
    const bounded = options.limit === undefined ? entries : entries.slice(Math.max(0, entries.length - options.limit));
    const lines = [
      `Session: ${session.id}`,
      ...(session.parentSessionId === undefined ? [] : [`Parent: ${session.parentSessionId}`]),
      `Entries: ${bounded.length}`,
    ];
    for (const entry of bounded) {
      lines.push(`- ${entry.sequence} ${entry.type}: ${summarizePayload(entry.payload)}`);
    }
    return lines.join("\n");
  }

  protected hydrateSession(session: SessionRecord): void {
    this.sessions.set(session.id, session);
  }

  protected hydrateEntry(entry: SessionEntry): void {
    this.entries.push(entry);
    this.sequence = Math.max(this.sequence, entry.sequence);
  }

  protected requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }
}

export class JsonlSessionStore extends MemorySessionStore {
  readonly filePath: string;
  readonly diagnostics: string[] = [];

  constructor(options: JsonlSessionStoreOptions) {
    super(options);
    this.filePath = options.filePath;
    this.load();
  }

  override createSession(input: CreateSessionInput = {}): SessionRecord {
    const session = super.createSession(input);
    this.appendJsonlRecord({ kind: "session", session });
    return session;
  }

  override appendEntry<T extends SessionEntryType>(sessionId: string, input: SessionEntryInput<T>): SessionEntry<T> {
    const entry = super.appendEntry(sessionId, input);
    this.appendJsonlRecord({ kind: "entry", entry });
    return entry;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.diagnostics.push(`line ${index + 1}: malformed JSON`);
        continue;
      }
      const record = parseJsonlRecord(parsed);
      if (record === undefined) {
        this.diagnostics.push(`line ${index + 1}: unsupported session JSONL record`);
        continue;
      }
      if (record.kind === "session") this.hydrateSession(record.session);
      else this.hydrateEntry(record.entry);
    }
  }

  private appendJsonlRecord(record: SessionStoreJsonlRecord): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(record)}\n`, { flag: "a" });
  }
}

export function validateSessionEntryInput(input: SessionEntryInput): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["entry must be an object"] };
  if (!isSessionEntryType(input.type)) errors.push(`unknown entry type: ${String(input.type)}`);
  if (!isRecord(input.payload)) errors.push("payload must be an object");
  if (errors.length) return { ok: false, errors };

  const payload = input.payload as Record<string, unknown>;
  switch (input.type) {
    case "session_init":
      requireOptionalString(payload, "projectRoot", errors);
      requireOptionalString(payload, "workingDirectory", errors);
      requireOptionalString(payload, "parentSessionId", errors);
      break;
    case "message":
      requireRole(payload, "role", errors, true);
      requireString(payload, "content", errors);
      break;
    case "custom":
      requireString(payload, "type", errors);
      if (!("data" in payload)) errors.push("payload.data is required");
      break;
    case "custom_message":
      requireRole(payload, "role", errors, false);
      requireString(payload, "content", errors);
      break;
    case "decision":
      requireEnum(payload, "status", ["answered", "cancelled", "deferred"], errors);
      break;
    case "compact_summary":
      requireString(payload, "summary", errors);
      break;
    case "branch_summary":
      requireString(payload, "branch", errors);
      requireString(payload, "summary", errors);
      break;
    case "child_run":
      requireString(payload, "childSessionId", errors);
      requireEnum(payload, "status", ["created", "running", "completed", "failed", "cancelled"], errors);
      break;
    case "artifact":
      requireString(payload, "path", errors);
      requireOptionalString(payload, "kind", errors);
      requireOptionalString(payload, "title", errors);
      break;
  }

  return { ok: errors.length === 0, errors };
}

export function sessionEntryInputFromPiCustomEntry(entry: CustomEntry): SessionEntryInput {
  if (isSessionEntryType(entry.type) && isRecord(entry.data)) {
    const input = { type: entry.type, payload: entry.data } as SessionEntryInput;
    const validation = validateSessionEntryInput(input);
    if (validation.ok) return input;
  }
  return {
    type: "custom",
    payload: {
      type: entry.type,
      data: entry.data,
    },
  };
}

export function sessionEntryToPiCustomEntry(entry: SessionEntry): CustomEntry {
  if (entry.type === "custom") {
    const payload = entry.payload as SessionEntryPayloadByType["custom"];
    return {
      type: payload.type,
      data: payload.data,
      timestamp: entry.createdAt,
    };
  }
  return {
    type: entry.type,
    data: entry.payload,
    timestamp: entry.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonlRecord(value: unknown): SessionStoreJsonlRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "session" && isSessionRecord(value.session)) return { kind: "session", session: value.session };
  if (value.kind === "entry" && isSessionEntry(value.entry)) return { kind: "entry", entry: value.entry };
  return undefined;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    isRecord(value) && typeof value.id === "string" && typeof value.createdAt === "string" && isRecord(value.metadata)
  );
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string") return false;
  if (
    !isSessionEntryType(String(value.type)) ||
    typeof value.createdAt !== "string" ||
    typeof value.sequence !== "number"
  )
    return false;
  const input = { type: value.type, payload: value.payload } as SessionEntryInput;
  return validateSessionEntryInput(input).ok;
}

function requireString(payload: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof payload[key] !== "string" || payload[key] === "") errors.push(`payload.${key} must be a non-empty string`);
}

function requireOptionalString(payload: Record<string, unknown>, key: string, errors: string[]): void {
  if (payload[key] !== undefined && typeof payload[key] !== "string")
    errors.push(`payload.${key} must be a string when provided`);
}

function requireRole(payload: Record<string, unknown>, key: string, errors: string[], required: boolean): void {
  if (!required && payload[key] === undefined) return;
  requireEnum(payload, key, ["system", "user", "assistant", "tool"], errors);
}

function requireEnum(payload: Record<string, unknown>, key: string, allowed: string[], errors: string[]): void {
  const value = payload[key];
  if (typeof value !== "string" || !allowed.includes(value))
    errors.push(`payload.${key} must be one of: ${allowed.join(", ")}`);
}

function summarizePayload(payload: unknown): string {
  if (!isRecord(payload)) return JSON.stringify(payload);
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.path === "string") return payload.path;
  if (typeof payload.childSessionId === "string")
    return `${payload.childSessionId} ${String(payload.status ?? "")}`.trim();
  if (typeof payload.type === "string") return payload.type;
  return JSON.stringify(payload);
}
