import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionJsonlPath } from "../../../../extensions/_shared/host/files.js";
import { getProjectRoot, getSessionId } from "../../../../extensions/_shared/host/pi-api.js";
import { JsonlSessionStore } from "../../../../extensions/_shared/runtime/session-core.js";
import askUserQuestion from "../../../../extensions/ask-user-question/index.js";
import { clearDevEvents, getDevEvents } from "../../../../extensions/_shared/runtime/event-bus.js";
import { createHarness, renderToolResult, runTool, type Harness } from "../../../test-harness.js";

function leavePromptOpen(h: Harness): void {
  h.ctx.hasUI = true;
  h.ctx.ui.select = () => new Promise(() => {});
  h.ctx.ui.custom = (factory) =>
    new Promise((resolve, reject) => {
      Promise.resolve(factory({ requestRender() {} }, {}, {}, resolve)).catch(reject);
    });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearDevEvents();
});

describe.each(["memory", "jsonl"] as const)("%s decision backend", (backend) => {
  beforeEach(() => {
    vi.stubEnv("LOCUS_PI_SESSION_STORE", backend);
  });
  function expectJournalMatches(h: Harness): void {
    if (backend !== "jsonl") return;
    const reopened = new JsonlSessionStore({ filePath: sessionJsonlPath(getProjectRoot(h.ctx)) });
    expect(reopened.latestEntry(getSessionId(h.ctx), "decision")?.payload).toEqual(h.entries[0]?.data);
    expect(reopened.diagnostics).toEqual([]);
  }

  describe.each(["tui", "rpc"] as const)("%s timeout provenance", (mode) => {
    it.each([false, true])("keeps OMP multi=%s automatic choices distinct from human answers", async (multi) => {
      vi.useFakeTimers();
      const h = createHarness(undefined, { mode });
      leavePromptOpen(h);
      askUserQuestion(h.pi);
      const pending = runTool(h, "ask", {
        questions: [
          {
            id: "release",
            question: "Release?",
            options: [{ label: "yes" }, { label: "no" }],
            recommended: 1,
            timeoutMs: 1000,
            multi,
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.details).toMatchObject({
        selectedOptions: ["no"],
        status: "timed-out",
        timedOut: true,
        answerSource: "automatic",
      });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("automatically") });
      expect(JSON.stringify(result.content)).not.toContain("User selected");
      expect(h.entries).toHaveLength(1);
      expectJournalMatches(h);
      expect(h.entries[0]).toMatchObject({
        data: {
          status: "timed-out",
          answer: { selectedOptions: ["no"] },
          metadata: { timedOut: true, answerSource: "automatic" },
        },
      });
      expect(renderToolResult(h.tools.get("ask")!, result, h.ctx).render(100).join("\n")).toContain("timed out");
      expect(getDevEvents().filter((event) => event.type === "ask:answered")).toHaveLength(0);
    });

    it.each(["select", "multi-select"] as const)(
      "honors rich %s auto-cancel without inventing an answer",
      async (kind) => {
        vi.useFakeTimers();
        const h = createHarness(undefined, { mode });
        leavePromptOpen(h);
        askUserQuestion(h.pi);
        const pending = runTool(h, "ask", {
          question: "Release?",
          kind,
          options: ["yes", "no"],
          default: "yes",
          timeoutMs: 1000,
        });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await pending;

        expect(result.details).toMatchObject({
          status: "timed-out",
          timedOut: true,
          cancelled: true,
          answerSource: "none",
        });
        expect(result.details?.value).toBeUndefined();
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining("timed out") });
        expect(h.entries).toHaveLength(1);
        expectJournalMatches(h);
        expect(h.entries[0]).toMatchObject({
          data: { status: "timed-out", metadata: { timedOut: true, answerSource: "none" } },
        });
        expect(h.entries[0]?.data).not.toHaveProperty("answer");
        expect(getDevEvents().filter((event) => event.type === "ask:answered")).toHaveLength(0);
      },
    );
  });
});

it.each(["answered", "timed-out", "cancelled", "deferred"] as const)(
  "reads historical and current %s decision statuses",
  (status) => {
    const h = createHarness();
    const filePath = sessionJsonlPath(getProjectRoot(h.ctx));
    const store = new JsonlSessionStore({ filePath });
    store.createSession({ id: "history" });
    store.appendEntry("history", { type: "decision", payload: { status } });
    const reopened = new JsonlSessionStore({ filePath });
    expect(reopened.latestEntry("history", "decision")?.payload).toEqual({ status });
    expect(reopened.diagnostics).toEqual([]);
  },
);
