import { describe, expect, it, vi } from "vitest";
import { requestOperatorInput } from "../../../extensions/_shared/operator/operator-input.js";
import { createHarness } from "../../test-harness.js";

describe("operator input host adapter", () => {
  it("calls the official input signature and accepts a string result", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    const input = vi.fn(async () => "ship it");
    harness.ctx.ui.input = input as never;

    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "input",
        title: "[INPUT] Plan request",
        placeholder: "Describe the plan request",
      }),
    ).resolves.toEqual({ status: "submitted", value: "ship it" });
    expect(input).toHaveBeenCalledWith("[INPUT] Plan request", "Describe the plan request");
  });

  it("calls the official editor signature and treats undefined as cancel", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    const editor = vi.fn(async () => undefined);
    harness.ctx.ui.editor = editor as never;

    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "editor",
        title: "[INPUT] Goal AI request",
        prefill: "keep this text",
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(editor).toHaveBeenCalledWith("[INPUT] Goal AI request", "keep this text");
  });

  it("normalizes the known legacy object result without changing its value", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;

    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "input",
        title: "[INPUT] Legacy host",
      }),
    ).resolves.toEqual({ status: "submitted", value: "typed" });

    harness.ctx.ui.input = async () => ({ value: "ignored", cancelled: true });
    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "input",
        title: "[INPUT] Legacy host",
      }),
    ).resolves.toEqual({ status: "cancelled" });
  });

  it.each(["json", "print"] as const)("returns unavailable in %s mode without calling the host", async (mode) => {
    const harness = createHarness(process.cwd(), { mode });
    harness.ctx.hasUI = false;
    const input = vi.fn();
    harness.ctx.ui.input = input as never;

    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "input",
        title: "[INPUT] Hidden",
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "no-ui" });
    expect(input).not.toHaveBeenCalled();
  });

  it("returns unavailable in RPC even when the host advertises UI methods", async () => {
    const harness = createHarness(process.cwd(), { mode: "rpc" });
    harness.ctx.hasUI = true;
    const input = vi.fn();
    const editor = vi.fn();
    harness.ctx.ui.input = input as never;
    harness.ctx.ui.editor = editor as never;

    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "input",
        title: "[INPUT] RPC must stay passive",
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "no-ui" });
    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "editor",
        title: "[INPUT] RPC must stay passive",
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "no-ui" });
    expect(input).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  });

  it("rejects an unknown object result instead of guessing a value", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    harness.ctx.ui.input = async () => ({ label: "not-a-dialog-result" }) as never;

    await expect(
      requestOperatorInput(harness.ctx, {
        kind: "input",
        title: "[INPUT] Broken host",
      }),
    ).rejects.toThrow("Unsupported Pi dialog result");
  });
});
