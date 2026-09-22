import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import workflowsExt from "../../../../extensions/workflows/index.js";
import { WorkflowTextComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
import { createHarness, runTool } from "../../../test-harness.js";

describe("workflow identity operator projection", () => {
  it("shows coverage on tool and status surfaces without exposing sourcePath", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-projection-"));
    try {
      writeFileSync(
        path.join(root, "strict.workflow.mjs"),
        "export default () => ({ summary: 'identity projection' });\n",
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = false;
      workflowsExt(harness.pi);

      const absoluteScriptPath = path.join(root, "strict.workflow.mjs");
      const result = await runTool(harness, "workflow", { scriptPath: absoluteScriptPath });
      const text = result.content?.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
      expect(text).toContain("coverage=self-contained-static");
      expect(text).toContain("exec=snapshot");
      expect(text).toContain("builtins=0");
      expect(text).not.toContain(path.join(root, "strict.workflow.mjs"));

      const details = result.details as {
        runId: string;
        target: { kind: string; ref: string; source: string; path?: string };
        scriptIdentity: {
          sourceRef: string;
          snapshot: string;
          scriptSha256: string;
          identityCoverage: string;
          executionSource: string;
          nodeVersion: string;
          builtinImportCount: number | null;
          unboundDependencyCount: number | null;
        };
      };
      expect(details.target).toEqual({ kind: "scriptPath", ref: "strict.workflow.mjs", source: "project" });
      expect(details.scriptIdentity).toMatchObject({
        sourceRef: "strict.workflow.mjs",
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        nodeVersion: process.version,
        builtinImportCount: 0,
        unboundDependencyCount: 0,
      });
      expect(details.scriptIdentity.snapshot).toMatch(/^script-[a-f0-9]{64}\.workflow\.mjs$/u);
      expect(details.scriptIdentity.scriptSha256).toMatch(/^[a-f0-9]{64}$/u);

      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      await harness.commands.get("workflows")!.handler(`status ${details.runId}`, harness.ctx);
      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 60, columns: 240 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      const statusText = component.render(240).join("\n");
      expect(statusText).toContain("coverage=self-contained-static");
      expect(statusText).toContain("exec=snapshot");
      expect(statusText).toContain(`node=${process.version}`);
      expect(statusText).not.toContain(path.join(root, "strict.workflow.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
