import { describe, expect, it } from "vitest";
import askUserQuestion from "../../../../extensions/ask-user-question/index.js";
import { SupersededInlineOperatorInteractionError } from "../../../../extensions/_shared/operator/operator-interaction.js";
import { createHarness, runTool } from "../../../test-harness.js";

const questions = [
  { id: "first", question: "First?", options: [{ label: "one" }, { label: "two" }] },
  { id: "second", question: "Second?", options: [{ label: "red" }, { label: "blue" }] },
];

describe("ask outcome finalization", () => {
  it("writes only final answers once after back/forward navigation", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r", "\x1b[D", "\x1b[B", "\r", "\r");
    const result = await runTool(h, "ask", { questions });
    expect(result.details?.results).toMatchObject([
      { selectedOptions: ["two"], status: "answered", timedOut: false, answerSource: "human" },
      { selectedOptions: ["red"], status: "answered", timedOut: false, answerSource: "human" },
    ]);
    expect(h.entries).toHaveLength(2);
    expect(h.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ decisionId: "ask-first", answer: { selectedOptions: ["two"] } }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({ decisionId: "ask-second", answer: { selectedOptions: ["red"] } }),
        }),
      ]),
    );
  });

  it("does not persist provisional answers when a later question is cancelled", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r", "\x1b");
    const result = await runTool(h, "ask", { questions });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: "cancelled", timedOut: false, answerSource: "none" });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ data: { decisionId: "ask-second", status: "cancelled" } });
    expect(h.entries[0]?.data).not.toHaveProperty("answer");
  });

  it.each(["select", "multi-select", "text", "editor"] as const)(
    "does not write partial secret %s input on cancellation",
    async (kind) => {
      const h = createHarness();
      askUserQuestion(h.pi);
      h.customInputQueue.push(" ", "\x1b");
      // Single-select submits on space, so cancel before selecting there.
      if (kind === "select") h.customInputQueue.splice(0, 1);
      h.ctx.ui.input = async () => ({ value: "SYNTHETIC_CANCELLED", cancelled: true });
      h.ctx.ui.editor = async () => ({ value: "SYNTHETIC_CANCELLED", cancelled: true });
      const result = await runTool(h, "ask", {
        question: "Cancel?",
        kind,
        options: ["SYNTHETIC_CANCELLED", "other"],
        sensitivity: "secret",
      });
      expect(result.details).toMatchObject({
        status: "cancelled",
        timedOut: false,
        cancelled: true,
        answerSource: "none",
      });
      expect(h.entries).toHaveLength(1);
      expect(h.entries[0]?.data).not.toHaveProperty("answer");
      expect(JSON.stringify({ result, entries: h.entries })).not.toContain("SYNTHETIC_CANCELLED");
    },
  );

  it.each(["select", "multi-select", "text", "editor"] as const)(
    "masks secret %s host errors without writing a decision",
    async (kind) => {
      const h = createHarness();
      askUserQuestion(h.pi);
      const fail = async (): Promise<never> => {
        throw new Error("SYNTHETIC_HOST_ERROR_SECRET");
      };
      h.ctx.ui.custom = fail;
      h.ctx.ui.input = fail;
      h.ctx.ui.editor = fail;
      const result = await runTool(h, "ask", { question: "Secret?", kind, options: ["one"], sensitivity: "secret" });
      expect(result.details?.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_HOST_ERROR_SECRET");
      expect(h.entries).toHaveLength(0);
    },
  );

  it("keeps a superseded rich selection distinct from cancellation and writes nothing", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.ctx.ui.custom = async () => {
      throw new SupersededInlineOperatorInteractionError();
    };
    const result = await runTool(h, "ask", {
      question: "Secret?",
      kind: "select",
      options: ["one"],
      sensitivity: "secret",
    });
    expect(result.details?.status).toBe("superseded");
    expect(h.entries).toHaveLength(0);
  });

  it("returns the custom rich multi-select answer instead of an empty selection", async () => {
    const h = createHarness(undefined, { mode: "rpc" });
    h.ctx.hasUI = true;
    askUserQuestion(h.pi);
    h.selectQueue.push("Other (type your own)");
    h.ctx.ui.input = async () => ({ value: "custom answer", cancelled: false });
    const result = await runTool(h, "ask", { question: "Which?", kind: "multi-select", options: ["one"] });
    expect(result.details).toMatchObject({ value: ["custom answer"], status: "answered", answerSource: "human" });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({
      data: { answer: { selectedOptions: [], customInput: "custom answer" }, status: "answered" },
    });
  });
});

describe("late question outcomes", () => {
  it("does not finalize a superseded question when its old callback later answers", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    const components: Array<{ handleInput?: (input: string) => void | Promise<void> }> = [];
    let mounted!: () => void;
    let nextMount = new Promise<void>((resolve) => {
      mounted = resolve;
    });
    h.ctx.ui.custom = (factory) =>
      new Promise((resolve, reject) => {
        Promise.resolve(factory({ requestRender() {} }, {}, {}, resolve)).then((component) => {
          components.push(component);
          mounted();
        }, reject);
      });
    const first = runTool(h, "ask", { question: "Old?", kind: "select", options: ["old"] });
    await nextMount;
    expect(h.entries).toHaveLength(0);
    nextMount = new Promise<void>((resolve) => {
      mounted = resolve;
    });
    const second = runTool(h, "ask", { question: "New?", kind: "select", options: ["new"] });
    await nextMount;
    expect((await first).details?.status).toBe("superseded");
    await components[0]!.handleInput?.("\r");
    expect(h.entries).toHaveLength(0);
    await components[1]!.handleInput?.("\r");
    expect((await second).details).toMatchObject({ value: "new", status: "answered", answerSource: "human" });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ data: { question: "New?", status: "answered" } });
  });

  it("leaves collected batch answers unpersisted until the last prompt completes", async () => {
    const h = createHarness(undefined, { mode: "rpc" });
    h.ctx.hasUI = true;
    askUserQuestion(h.pi);
    let complete!: (value: { value: string; cancelled: false }) => void;
    let mounted!: () => void;
    const nextMount = new Promise<void>((resolve) => {
      mounted = resolve;
    });
    let calls = 0;
    h.ctx.ui.select = async () => {
      if (++calls === 1) return { value: "one", cancelled: false };
      return new Promise((resolve) => {
        complete = resolve;
        mounted();
      });
    };
    const pending = runTool(h, "ask", { questions });
    await nextMount;
    expect(h.entries).toHaveLength(0);
    complete({ value: "red", cancelled: false });
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(h.entries).toHaveLength(2);
  });
});
