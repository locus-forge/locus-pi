import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionJsonlPath } from "../../../extensions/_shared/host/files.js";
import {
  createSessionStore,
  formatRuntimeCapabilityReport,
  getRuntimeCapabilityReport,
} from "../../../extensions/_shared/runtime/runtime-capabilities.js";
import {
  JsonlSessionStore,
  MemorySessionStore,
  createDeterministicSessionIdFactory,
} from "../../../extensions/_shared/runtime/session-core.js";

const now = () => "2026-06-02T00:00:00.000Z";
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.LOCUS_PI_SESSION_STORE;
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-pi-session-"));
  tempRoots.push(root);
  return root;
}

describe("JsonlSessionStore", () => {
  it("appends session state and reloads it from JSONL", () => {
    const root = tempRoot();
    const filePath = sessionJsonlPath(root);
    const store = new JsonlSessionStore({ filePath, idFactory: createDeterministicSessionIdFactory("m2"), now });
    const session = store.createSession({ projectRoot: root });
    store.appendEntry(session.id, { type: "message", payload: { role: "user", content: "Persist this" } });

    const reloaded = new JsonlSessionStore({ filePath, idFactory: createDeterministicSessionIdFactory("unused"), now });

    expect(readFileSync(filePath, "utf8").trim().split(/\r?\n/)).toHaveLength(3);
    expect(reloaded.getSession(session.id)).toMatchObject({ id: session.id, projectRoot: root });
    expect(reloaded.listEntries({ sessionId: session.id }).map((entry) => entry.type)).toEqual([
      "session_init",
      "message",
    ]);
    expect(reloaded.latestEntry(session.id, "message")).toMatchObject({
      payload: { role: "user", content: "Persist this" },
    });
  });

  it("skips legacy todo_write records without dropping adjacent valid records", () => {
    const root = tempRoot();
    const filePath = sessionJsonlPath(root);
    const validSession = {
      kind: "session",
      session: { id: "manual-session", createdAt: now(), metadata: {} },
    };
    const legacyTodoEntry = {
      kind: "entry",
      entry: {
        id: "legacy-todo-entry",
        sessionId: "manual-session",
        type: "todo_write",
        payload: { phases: [{ name: "Execution", tasks: [] }] },
        createdAt: now(),
        sequence: 1,
      },
    };
    const validMessageEntry = {
      kind: "entry",
      entry: {
        id: "manual-message-entry",
        sessionId: "manual-session",
        type: "message",
        payload: { role: "user", content: "Still loads" },
        createdAt: now(),
        sequence: 2,
      },
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify(validSession)}\n${JSON.stringify(legacyTodoEntry)}\n${JSON.stringify(validMessageEntry)}\n`,
    );

    const store = new JsonlSessionStore({ filePath, idFactory: createDeterministicSessionIdFactory("m2"), now });

    expect(store.diagnostics).toEqual(["line 2: unsupported session JSONL record"]);
    expect(store.getSession("manual-session")).toBeDefined();
    expect(store.listEntries({ sessionId: "manual-session" }).map((entry) => entry.type)).toEqual(["message"]);
    expect(store.latestEntry("manual-session", "message")).toMatchObject({
      payload: { role: "user", content: "Still loads" },
    });
  });

  it("keeps malformed JSONL diagnostics without dropping valid records", () => {
    const root = tempRoot();
    const filePath = sessionJsonlPath(root);
    const validSession = {
      kind: "session",
      session: { id: "manual-session", createdAt: now(), metadata: {} },
    };
    const validEntry = {
      kind: "entry",
      entry: {
        id: "manual-entry",
        sessionId: "manual-session",
        type: "message",
        payload: { role: "user", content: "Still loads" },
        createdAt: now(),
        sequence: 1,
      },
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(validSession)}\nnot-json\n${JSON.stringify(validEntry)}\n`);

    const store = new JsonlSessionStore({ filePath, idFactory: createDeterministicSessionIdFactory("m2"), now });

    expect(store.diagnostics).toEqual(["line 2: malformed JSON"]);
    expect(store.getSession("manual-session")).toBeDefined();
    expect(store.latestEntry("manual-session", "message")).toMatchObject({
      payload: { role: "user", content: "Still loads" },
    });
  });

  it("creates forced memory or JSONL stores through the runtime factory", () => {
    const root = tempRoot();
    const memory = createSessionStore({ projectRoot: root, backend: "memory", now });
    const jsonl = createSessionStore({ projectRoot: root, backend: "jsonl", now });

    expect(memory).toBeInstanceOf(MemorySessionStore);
    expect(jsonl).toBeInstanceOf(JsonlSessionStore);
  });

  it("selects JSONL through LOCUS_PI_SESSION_STORE and reports runtime capabilities", () => {
    const root = tempRoot();
    process.env.LOCUS_PI_SESSION_STORE = "jsonl";

    const store = createSessionStore({ projectRoot: root, now });
    const report = getRuntimeCapabilityReport(root);

    expect(store).toBeInstanceOf(JsonlSessionStore);
    expect(report).toMatchObject({
      sessionStoreBackend: "jsonl",
      durableSessionStore: true,
      sessionStorePath: sessionJsonlPath(root),
      sessionStoreWritable: true,
      diagnostics: [],
    });
    expect(formatRuntimeCapabilityReport(report)).toContain("sessionStore: jsonl");
  });
});
