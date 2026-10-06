import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import askUserQuestion from "../../../../extensions/ask-user-question/index.js";
import { sessionJsonlPath } from "../../../../extensions/_shared/host/files.js";
import { clearDevEvents, getDevEvents } from "../../../../extensions/_shared/runtime/event-bus.js";
import { createHarness, renderToolResult, runTool } from "../../../test-harness.js";

const cases = ["select", "multi-select", "custom-select", "custom-multi-select", "text", "editor"] as const;

describe.each(["tui", "rpc"] as const)("%s secret question outcomes", (mode) => {
  const roots: string[] = [];
  beforeEach(() => {
    process.env.LOCUS_PI_SESSION_STORE = "jsonl";
    clearDevEvents();
  });
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    delete process.env.LOCUS_PI_SESSION_STORE;
    clearDevEvents();
  });

  it.each(cases.filter((kind) => mode === "tui" || (kind !== "text" && kind !== "editor")))(
    "masks %s before either journal receives an answer",
    async (scenario) => {
      const root = mkdtempSync(path.join(tmpdir(), "locus-question-secret-"));
      roots.push(root);
      const h = createHarness(root, { mode });
      h.ctx.hasUI = true;
      askUserQuestion(h.pi);
      const secret = `SYNTHETIC_ONLY_${mode}_${scenario}_ANSWER`;
      const custom = scenario.startsWith("custom-");
      const kind = scenario.replace("custom-", "") as "select" | "multi-select" | "text" | "editor";
      const options = custom ? ["one", "two"] : [secret, "two"];
      h.ctx.ui.input = async () => ({ value: secret, cancelled: false });
      h.ctx.ui.editor = async () => ({ value: secret, cancelled: false });
      if (mode === "rpc") {
        h.selectQueue.push(
          ...(custom
            ? ["Other (type your own)"]
            : kind === "multi-select"
              ? [`[ ] ${secret}`, "Done selecting"]
              : [secret]),
        );
      } else if (custom) {
        h.customInputQueue.push("\x1b[B", "\x1b[B", "\r", secret, "\r");
      } else if (kind === "multi-select") {
        h.customInputQueue.push(" ", "\x1b[B", "\x1b[B", "\r");
      } else {
        h.customInputQueue.push("\r");
      }
      // Capture at the actual append boundary: mutating a record afterwards cannot
      // make a previously transmitted secret pass this assertion.
      const writes: string[] = [];
      const appendEntry = h.pi.appendEntry.bind(h.pi);
      h.pi.appendEntry = async (type, data) => {
        writes.push(JSON.stringify({ type, data }));
        return appendEntry(type, data);
      };

      const result = await runTool(h, "ask", { question: "Secret answer?", kind, options, sensitivity: "secret" });
      const jsonl = readFileSync(sessionJsonlPath(root), "utf8");
      const rendered = renderToolResult(h.tools.get("ask")!, result, h.ctx).render(100).join("\n");
      const surfaces = { result, writes, jsonl, rendered, events: getDevEvents(), notifications: h.notifications };
      for (const [name, surface] of Object.entries(surfaces)) {
        expect.soft(JSON.stringify(surface), name).not.toContain(secret);
      }
      expect(result.isError).not.toBe(true);
      expect(result.details?.value).toBeUndefined();
      expect(JSON.stringify(result.details?.visibleValue)).toContain("[REDACTED:secret-answer]");
      expect(writes).toHaveLength(1);
      expect(jsonl.split("\n").filter((line) => line.includes('"type":"decision"'))).toHaveLength(1);
      expect(h.entries[0]).toMatchObject({ data: { answer: "[REDACTED:secret-answer]", status: "answered" } });
      expect(getDevEvents().filter((event) => event.type === "ask:answered")).toHaveLength(1);
    },
  );
});
