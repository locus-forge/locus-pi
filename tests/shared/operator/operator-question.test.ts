import { describe, expect, it, vi } from "vitest";
import {
  renderOperatorQuestionAnswer,
  requestOperatorQuestion,
} from "../../../extensions/_shared/operator/operator-question.js";
import { createHarness } from "../../test-harness.js";

describe("operator question", () => {
  it("keeps custom entry in the same inline TUI component", async () => {
    const harness = createHarness();
    const input = vi.fn();
    const editor = vi.fn();
    harness.ctx.ui.input = input as never;
    harness.ctx.ui.editor = editor as never;
    harness.customInputQueue.push("\x1b[B", "\r", "custom answer", "\r");

    const result = await requestOperatorQuestion(harness.ctx, {
      subject: "Workflow",
      question: "Choose scope",
      options: [{ label: "Current changes" }],
    });

    expect(result).toEqual({ status: "answered", kind: "custom", answer: "custom answer" });
    expect(renderOperatorQuestionAnswer(result)).toBe("custom answer");
    expect(harness.customComponents).toHaveLength(1);
    expect(harness.customOptions).toEqual([{ overlay: false }]);
    expect(input).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  });

  it("returns cancelled on Escape without selecting a default", async () => {
    const harness = createHarness();
    harness.customInputQueue.push("\x1b");

    await expect(
      requestOperatorQuestion(harness.ctx, {
        question: "Continue?",
        options: [{ label: "Yes", recommended: true }],
      }),
    ).resolves.toEqual({ status: "cancelled" });
  });

  it("starts a text-only question directly in inline custom entry", async () => {
    const harness = createHarness();
    harness.customInputQueue.push("typed answer", "\r");

    const result = await requestOperatorQuestion(harness.ctx, {
      subject: "Workflow",
      question: "Describe the desired scope",
      options: [],
      allowCustom: true,
    });

    expect(result).toEqual({ status: "answered", kind: "custom", answer: "typed answer" });
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("[INPUT] Workflow");
  });

  it("uses native RPC input directly for a text-only question", async () => {
    const harness = createHarness(process.cwd(), { mode: "rpc" });
    harness.ctx.hasUI = true;
    const input = vi.fn(async () => "rpc text");
    harness.ctx.ui.input = input as never;

    const result = await requestOperatorQuestion(
      harness.ctx,
      {
        subject: "Workflow",
        question: "Describe the desired scope",
        options: [],
        allowCustom: true,
      },
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({ status: "answered", kind: "custom", answer: "rpc text" });
    expect(input).toHaveBeenCalledWith("[INPUT] Workflow — Describe the desired scope", "Type a response", {
      signal: expect.any(AbortSignal),
    });
    expect(harness.selectCalls).toEqual([]);
  });

  it("fails honestly in JSON mode", async () => {
    const harness = createHarness(process.cwd(), { mode: "json" });

    await expect(
      requestOperatorQuestion(harness.ctx, {
        question: "Continue?",
        options: [{ label: "Yes" }],
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "no-ui" });
    expect(harness.selectCalls).toEqual([]);
    expect(harness.customComponents).toEqual([]);
  });

  it("rejects ambiguous option contracts before mounting UI", async () => {
    const harness = createHarness();

    await expect(
      requestOperatorQuestion(harness.ctx, {
        question: "Continue?",
        options: [
          { label: "Same", value: "one" },
          { label: "Same", value: "two" },
        ],
      }),
    ).rejects.toThrow("labels and values must be unique");
    expect(harness.customComponents).toEqual([]);
  });

  it("rejects an RPC option whose normalized label collides with the custom choice", async () => {
    const harness = createHarness(process.cwd(), { mode: "rpc" });
    harness.ctx.hasUI = true;

    await expect(
      requestOperatorQuestion(harness.ctx, {
        question: "Continue?",
        options: [{ label: " Other " }],
        allowCustom: true,
        customLabel: "Other",
      }),
    ).rejects.toThrow("custom label must not duplicate");
    expect(harness.selectCalls).toEqual([]);
  });

  it("preserves a literal recommended suffix selected in TUI", async () => {
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    const result = await requestOperatorQuestion(harness.ctx, {
      question: "Choose",
      options: [{ label: "Literal (Recommended)", value: "literal-value" }],
      allowCustom: false,
    });

    expect(result).toEqual({
      status: "answered",
      kind: "option",
      answer: "literal-value",
      label: "Literal (Recommended)",
    });
  });

  it("rejects colliding rendered option labels before mounting TUI", async () => {
    const harness = createHarness();

    await expect(
      requestOperatorQuestion(harness.ctx, {
        question: "Choose",
        options: [
          { label: "Alpha", value: "recommended-alpha", recommended: true },
          { label: "Alpha (Recommended)", value: "literal-alpha" },
        ],
        allowCustom: false,
      }),
    ).rejects.toThrow("rendered option labels must be unique");
    expect(harness.customComponents).toEqual([]);
  });

  it("preserves a literal recommended suffix selected through RPC", async () => {
    const harness = createHarness(process.cwd(), { mode: "rpc" });
    harness.ctx.hasUI = true;
    harness.selectQueue.push("Literal (Recommended)");

    const result = await requestOperatorQuestion(harness.ctx, {
      question: "Choose",
      options: [{ label: "Literal (Recommended)", value: "literal-value" }],
      allowCustom: false,
    });

    expect(result).toEqual({
      status: "answered",
      kind: "option",
      answer: "literal-value",
      label: "Literal (Recommended)",
    });
    expect(harness.selectCalls[0]?.options).toEqual(["Literal (Recommended)"]);
  });

  it("rejects colliding rendered option labels before sending an RPC request", async () => {
    const harness = createHarness(process.cwd(), { mode: "rpc" });
    harness.ctx.hasUI = true;

    await expect(
      requestOperatorQuestion(harness.ctx, {
        question: "Choose",
        options: [
          { label: "Alpha", value: "recommended-alpha", recommended: true },
          { label: "Alpha (Recommended)", value: "literal-alpha" },
        ],
        allowCustom: false,
      }),
    ).rejects.toThrow("rendered option labels must be unique");
    expect(harness.selectCalls).toEqual([]);
  });
});
