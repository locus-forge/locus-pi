import { describe, expect, it, vi } from "vitest";
import askUserQuestion from "../../../../extensions/ask-user-question/index.js";
import { createHarness, renderToolResult, runTool } from "../../../test-harness.js";

/**
 * Characterization coverage for the ask surfaces the existing suite never
 * reaches: the timeout auto-answer, the checkbox fallback loop, the legacy
 * kinds other than `text`, and the inline panel's cursor and custom-input
 * validation. Written against the pre-split entrypoint so the split can be
 * proved behavior-preserving rather than asserted to be.
 */
describe("ask-user-question uncovered surfaces", () => {
  it("auto-answers with the recommended option when the select prompt times out", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    await h.ctx.settings!.set("ask.timeout", 0.05);
    h.ctx.ui.select = (() => new Promise(() => {})) as never;
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      questions: [
        {
          id: "deploy",
          question: "Deploy?",
          options: [{ label: "ship" }, { label: "hold" }],
          recommended: 1,
        },
      ],
    });

    // A timeout is not a cancellation: the recommended option is recorded as
    // the answer and the tool reports success.
    expect(result.isError).not.toBe(true);
    expect(result.details?.selectedOptions).toEqual(["hold"]);
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: { decisionId: "ask-deploy", answer: { selectedOptions: ["hold"] }, status: "answered" },
    });
  });

  it("auto-answers with the first option when a timed-out question recommends nothing", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    await h.ctx.settings!.set("ask.timeout", 0.05);
    h.ctx.ui.select = (() => new Promise(() => {})) as never;
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      questions: [{ id: "deploy", question: "Deploy?", options: [{ label: "ship" }, { label: "hold" }] }],
    });

    expect(result.details?.selectedOptions).toEqual(["ship"]);
  });

  it("toggles checkbox choices and finishes on Done in the native select fallback", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    h.selectQueue.push("[ ] one", "[ ] two", "Done selecting");
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      questions: [
        {
          id: "multi",
          question: "Pick many",
          options: [{ label: "one" }, { label: "two" }, { label: "three" }],
          multi: true,
        },
      ],
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "User selected: one, two" });
    expect(result.details?.selectedOptions).toEqual(["one", "two"]);
    // The running count is part of the prompt title, and Done only appears once
    // something is selected.
    expect(h.selectCalls[0]?.title).toBe("[SELECT] Ask — Pick many");
    expect(h.selectCalls[1]?.title).toBe("[SELECT] Ask — (1 selected) Pick many");
    expect(h.selectCalls[0]?.options).toEqual(["[ ] one", "[ ] two", "[ ] three", "Other (type your own)"]);
    expect(h.selectCalls[1]?.options).toEqual([
      "[x] one",
      "[ ] two",
      "[ ] three",
      "Done selecting",
      "Other (type your own)",
    ]);
  });

  it("indents a multi-line custom answer in the single-question result text", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    h.selectQueue.push("Other (type your own)");
    h.ctx.ui.input = (async () => "first line\nsecond line") as never;
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      questions: [{ id: "notes", question: "Notes?", options: [{ label: "none" }], multi: true }],
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "User provided custom input:\n  first line\n  second line",
    });
    const rendered = renderToolResult(h.tools.get("ask")!, result, h.ctx);
    // The redrawn card collapses the same answer onto one line.
    expect(rendered.render(80).join("\n")).toContain("(o) (custom) first line second line");
  });

  it("reports a question skipped by forward navigation as cancelled in the answer list", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\x1b[C", "\x1b[C");

    const result = await runTool(h, "ask", {
      questions: [
        { id: "first", question: "First?", options: [{ label: "one" }] },
        { id: "second", question: "Second?", options: [{ label: "red" }] },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "User answers:\nfirst: (cancelled)\nsecond: (cancelled)",
    });
  });

  it("moves the inline panel cursor with home, end, and vim keys", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    // G -> last choice (Other), up -> "three", space toggles it, g -> first
    // choice, space toggles "one", then j three times lands on Done.
    h.customInputQueue.push("G", "\x1b[A", " ", "g", " ", "j", "j", "j", "\r");

    const result = await runTool(h, "ask", {
      questions: [
        {
          id: "multi",
          question: "Pick many",
          options: [{ label: "one" }, { label: "two" }, { label: "three" }],
          multi: true,
        },
      ],
    });

    expect(result.details?.selectedOptions).toEqual(["three", "one"]);
  });

  it("refuses an empty custom answer in the inline panel and keeps the prompt open", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\x1b[B", "\x1b[B", "\x1b[B", "\r", "\r", "note", "\r");

    const result = await runTool(h, "ask", {
      questions: [
        {
          id: "multi",
          question: "Pick many",
          options: [{ label: "one" }, { label: "two" }, { label: "three" }],
          multi: true,
        },
      ],
    });

    expect(h.customRenderFrames.some((frame) => frame.join("\n").includes("Response must not be empty."))).toBe(true);
    expect(result.details).toMatchObject({ selectedOptions: [], customInput: "note" });
  });

  it("answers a legacy select question through the recommended default", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    h.selectQueue.push("beta");
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      question: "Which release?",
      kind: "select",
      options: ["alpha", "beta"],
      default: "beta",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "Answer: beta" });
    expect(result.details).toMatchObject({ kind: "select", value: "beta", cancelled: false });
    // The legacy default is projected as the recommended option.
    expect(h.selectCalls[0]?.options).toEqual(["alpha", "beta (Recommended)", "Other (type your own)"]);
  });

  it("answers a legacy multi-select question with the whole selection", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    h.selectQueue.push("[ ] red", "Done selecting");
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      question: "Which colors?",
      kind: "multi-select",
      options: ["red", "blue"],
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "Answer: red" });
    expect(result.details?.value).toEqual(["red"]);
    expect(result.details?.kind).toBe("multi-select");
  });

  it("prefills the legacy editor dialog with a joined array default", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    const editor = vi.fn(async (_title: string, prefill?: string) => prefill ?? "");
    h.ctx.ui.editor = editor as never;
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      question: "Edit the note",
      kind: "editor",
      default: ["one", "two"],
      reason: "needs review",
    });

    // The reason is appended as its own paragraph, so collapsing the title to a
    // single line leaves the blank line behind as a double space.
    expect(editor).toHaveBeenCalledWith("[INPUT] Ask — Edit the note  Reason: needs review", "one, two");
    expect(result.details?.value).toBe("one, two");
    expect(result.details?.kind).toBe("editor");
  });

  it("fails the legacy tool honestly when the host cannot prompt", async () => {
    const h = createHarness(process.cwd(), { mode: "json" });
    h.ctx.hasUI = false;
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", { question: "Answer?", kind: "text" });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: "unavailable", reason: "no-ui", source: "ask" });
    expect(h.tools.has("askUserQuestion")).toBe(false);
    expect(h.entries).toEqual([]);
  });
});
