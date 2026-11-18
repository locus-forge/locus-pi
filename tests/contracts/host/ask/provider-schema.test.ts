import type { TObject } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { normalizeContext, validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { registerAskTools } from "../../../../extensions/ask-user-question/tool/ask-tool.js";
import { createHarness } from "../../../test-harness.js";

// Real Pi serialization, intercepted before HTTP. This is not a live model run.
describe("ask provider schema", () => {
  it("exposes both argument shapes through Anthropic's non-strict adapter", async () => {
    const h = createHarness();
    registerAskTools(h.pi);
    const tool = h.tools.get("ask")! as unknown as Tool;
    const model = { ...getModel("anthropic", "claude-sonnet-4-5"), baseUrl: "https://provider.invalid" };
    let payload: { tools: Array<{ name: string; input_schema: Tool["parameters"] }> } | undefined;
    const fetch = vi.fn(async () => {
      throw new Error("Unexpected HTTP request");
    });
    const result = await stream(
      model,
      normalizeContext({ tools: [tool], messages: [{ role: "user", content: "Ask a question", timestamp: 0 }] }),
      {
        apiKey: "fixture-key",
        fetch,
        maxRetries: 0,
        onPayload(value) {
          payload = value as typeof payload;
          throw new Error("Captured schema before HTTP");
        },
      },
    ).result();
    expect(result.errorMessage).toContain("Captured schema before HTTP");
    expect(fetch).not.toHaveBeenCalled();
    const serialized = payload!.tools.find((entry) => entry.name === "ask")!.input_schema as unknown as TObject;
    expect(serialized.type).toBe("object");
    expect(Object.keys(serialized.properties ?? {}).sort()).toEqual(
      [
        "questions",
        "question",
        "kind",
        "options",
        "allowCustom",
        "default",
        "timeoutMs",
        "sensitivity",
        "reason",
      ].sort(),
    );
    expect(serialized.properties.questions).toMatchObject({
      type: "array",
      minItems: 1,
      items: { required: ["id", "question", "options"], properties: { options: { items: { required: ["label"] } } } },
    });
    expect(serialized.properties.kind!.anyOf.map((entry: { const: string }) => entry.const)).toEqual([
      "select",
      "multi-select",
      "text",
      "editor",
    ]);
    // The provider still receives usable nested constraints for both shapes.
    for (const args of [
      { question: "Name?", kind: "text" },
      { questions: [{ id: "choice", question: "Choose", options: [{ label: "one" }] }] },
    ]) {
      expect(
        validateToolArguments(
          { ...tool, parameters: serialized as unknown as Tool["parameters"] },
          { type: "toolCall", name: "ask", id: "1", arguments: args },
        ),
      ).toEqual(args);
    }
    // The registered schema retains the shape constraint even when the adapter drops it.
    expect(() => validateToolArguments(tool, { type: "toolCall", name: "ask", id: "1", arguments: {} })).toThrow();
  });
});
