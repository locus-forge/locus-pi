import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  createDeterministicSessionIdFactory,
  sessionEntryInputFromPiCustomEntry,
  sessionEntryToPiCustomEntry,
  validateSessionEntryInput,
} from "../../../extensions/_shared/runtime/session-core.js";

const now = () => "2026-06-02T00:00:00.000Z";

describe("MemorySessionStore", () => {
  it("creates sessions with deterministic ids and a session_init entry", () => {
    const store = new MemorySessionStore({ idFactory: createDeterministicSessionIdFactory("m1"), now });

    const session = store.createSession({ projectRoot: "/repo", workingDirectory: "/repo/pkg" });

    expect(session).toMatchObject({
      id: "m1-session-1",
      projectRoot: "/repo",
      workingDirectory: "/repo/pkg",
      createdAt: now(),
    });
    expect(store.latestEntry(session.id, "session_init")).toMatchObject({
      id: "m1-entry-1-session_init",
      sessionId: session.id,
      type: "session_init",
      payload: {
        projectRoot: "/repo",
        workingDirectory: "/repo/pkg",
      },
      sequence: 1,
    });
  });

  it("appends, queries, limits, and reads latest entries by type", () => {
    const store = new MemorySessionStore({ idFactory: createDeterministicSessionIdFactory("m1"), now });
    const session = store.createSession();

    store.appendEntry(session.id, { type: "message", payload: { role: "user", content: "Build runtime" } });
    store.appendEntry(session.id, { type: "custom_message", payload: { role: "assistant", content: "Reading files" } });
    store.appendEntry(session.id, { type: "artifact", payload: { path: "artifacts/runtime.md", kind: "markdown" } });

    expect(store.listEntries({ sessionId: session.id }).map((entry) => entry.type)).toEqual([
      "session_init",
      "message",
      "custom_message",
      "artifact",
    ]);
    expect(store.listEntries({ sessionId: session.id, limit: 2 }).map((entry) => entry.type)).toEqual([
      "custom_message",
      "artifact",
    ]);
    expect(store.latestEntry(session.id, "message")).toMatchObject({
      type: "message",
      payload: { role: "user", content: "Build runtime" },
    });
    expect(store.latestEntry(session.id, "artifact")).toMatchObject({
      type: "artifact",
      payload: { path: "artifacts/runtime.md", kind: "markdown" },
    });
  });

  it("creates child sessions and records parent child_run entries", () => {
    const store = new MemorySessionStore({ idFactory: createDeterministicSessionIdFactory("m1"), now });
    const parent = store.createSession({ projectRoot: "/repo" });

    const child = store.createChildSession(parent.id, { workingDirectory: "/repo/sub" });

    expect(child).toMatchObject({
      id: "m1-session-2-child-of-m1-session-1",
      parentSessionId: parent.id,
      workingDirectory: "/repo/sub",
    });
    expect(store.latestEntry(parent.id, "child_run")).toMatchObject({
      type: "child_run",
      payload: {
        childSessionId: child.id,
        status: "created",
      },
    });
    expect(store.latestEntry(child.id, "session_init")).toMatchObject({
      payload: {
        workingDirectory: "/repo/sub",
        parentSessionId: parent.id,
      },
    });
  });

  it("builds deterministic handoff summaries", () => {
    const store = new MemorySessionStore({ idFactory: createDeterministicSessionIdFactory("m1"), now });
    const session = store.createSession();
    store.appendEntry(session.id, { type: "message", payload: { role: "user", content: "Need a prompt" } });
    store.appendEntry(session.id, {
      type: "decision",
      payload: { status: "answered", question: "Proceed?", answer: "yes" },
    });
    store.appendEntry(session.id, {
      type: "artifact",
      payload: { path: ".tasks/T-104/artifacts/draft.md", kind: "markdown" },
    });

    expect(store.summarizeForHandoff(session.id, { includeTypes: ["message", "decision", "artifact"] })).toBe(
      [
        "Session: m1-session-1",
        "Entries: 3",
        "- 2 message: Need a prompt",
        '- 3 decision: {"status":"answered","question":"Proceed?","answer":"yes"}',
        "- 4 artifact: .tasks/T-104/artifacts/draft.md",
      ].join("\n"),
    );
  });

  it("validates invalid entry payloads before append", () => {
    const store = new MemorySessionStore({ idFactory: createDeterministicSessionIdFactory("m1"), now });
    const session = store.createSession();

    expect(validateSessionEntryInput({ type: "message", payload: { role: "user", content: "" } })).toEqual({
      ok: false,
      errors: ["payload.content must be a non-empty string"],
    });
    expect(() => store.appendEntry(session.id, { type: "artifact", payload: { path: "" } })).toThrow(
      "payload.path must be a non-empty string",
    );
  });

  it("converts Pi custom entries into session entries and back", () => {
    const artifactInput = sessionEntryInputFromPiCustomEntry({
      type: "artifact",
      data: { path: "artifacts/runtime.md", kind: "markdown" },
      timestamp: now(),
    });
    expect(artifactInput).toEqual({
      type: "artifact",
      payload: { path: "artifacts/runtime.md", kind: "markdown" },
    });

    const unknownInput = sessionEntryInputFromPiCustomEntry({
      type: "legacy-event",
      data: { ok: true },
      timestamp: now(),
    });
    expect(unknownInput).toEqual({
      type: "custom",
      payload: { type: "legacy-event", data: { ok: true } },
    });

    const store = new MemorySessionStore({ idFactory: createDeterministicSessionIdFactory("m1"), now });
    const session = store.createSession();
    const entry = store.appendEntry(session.id, unknownInput);
    expect(sessionEntryToPiCustomEntry(entry)).toEqual({
      type: "legacy-event",
      data: { ok: true },
      timestamp: now(),
    });
  });
});
