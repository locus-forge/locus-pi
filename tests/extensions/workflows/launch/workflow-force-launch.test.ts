import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRunCommand } from "../../../../extensions/workflows/command/command-parser.js";
import workflows from "../../../../extensions/workflows/index.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";

async function waitForBackground(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await Promise.resolve();
}

describe("workflow force launch surfaces", () => {
  it("parses force without consuming option values or semantic input", () => {
    expect(parseRunCommand("run plan --force --workspace-dir tmp/auto ship the fix")).toEqual({
      scriptRef: "plan",
      workspaceDir: "tmp/auto",
      force: true,
      input: "ship the fix",
    });
    expect(parseRunCommand("run plan --force -- --force stays input")).toEqual({
      scriptRef: "plan",
      force: true,
      input: "--force stays input",
    });
    expect(parseRunCommand("run plan --workspace-dir --force")).toEqual({
      scriptRef: "plan",
      missingWorkspaceDir: true,
    });
  });

  it("forwards force from the slash command to the runner", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-force-command-"));
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".locus-pi", "workflows", "force.workflow.mjs"), 'export default () => "ok";\n');
    const h = createHarness(root);
    workflows(h.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-force-command",
      runDir: "/tmp/run-force-command",
      ok: true,
      result: "ok",
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-force-command/result.json" },
    });
    try {
      await h.commands.get("workflows")!.handler("run force --force", h.ctx);
      await waitForBackground(() => spy.mock.calls.length === 1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "force", force: true });
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards force from the structured workflow tool to the runner", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-force-tool-"));
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".locus-pi", "workflows", "force.workflow.mjs"), 'export default () => "ok";\n');
    const h = createHarness(root);
    workflows(h.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-force-tool", runDir: "/tmp/run-force-tool" });
      return {
        runId: "run-force-tool",
        runDir: "/tmp/run-force-tool",
        ok: true,
        result: "ok",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-force-tool/result.json" },
      };
    });
    try {
      await h.tools
        .get("workflow")!
        .execute("force-tool", { name: "force", force: true }, new AbortController().signal, () => void 0, h.ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "force", force: true });
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
