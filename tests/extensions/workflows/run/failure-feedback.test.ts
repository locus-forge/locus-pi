import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import workflows from "../../../../extensions/workflows/index.js";
import { WorkflowFailureNotices } from "../../../../extensions/workflows/operator/operator-surface.js";
import { openWorkflowRunViewer } from "../../../../extensions/workflows/command/workflow-editor-handoff.js";
import { WORKFLOW_RUN_CUSTOM_TYPE } from "../../../../extensions/workflows/command/receipts.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];
const first = "20261120-000001-aaaa";
const second = "20261120-000002-aaaa";
function setup() {
  initTheme("dark");
  const root = mkdtempSync(path.join(tmpdir(), "wf-feedback-"));
  roots.push(root);
  const h = createHarness(root, { mode: "tui" });
  h.ctx.hasUI = true;
  return { root, h };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  ["run alpha --input-json {", "--input-json requires"],
  ["run task --", "group-only"],
])("keeps one visible reason and a recoverable receipt for %s", async (command, reason) => {
  const { h } = setup();
  workflows(h.pi);
  await h.commands.get("workflows")!.handler(command, h.ctx);
  const msg = h.sentMessages.at(-1)!.message;
  expect(msg.details?.eventKind).toBe("workflow_rejected");
  expect(msg.details?.runId).toBeUndefined();
  const render = h.messageRenderers.get(WORKFLOW_RUN_CUSTOM_TYPE)!;
  const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t };
  const card = (expanded: boolean) => render(msg, { expanded, outputPad: 0 }, theme)!.render(120).join("\n");
  expect(card(false)).toContain("Workflow not started");
  expect(card(false)).not.toContain(reason);
  expect(h.widgets.get("workflows")).toContain(reason);
  expect(card(true)).toContain(reason);
});

it("shows the selected recorded reason and acknowledges only that full ID", async () => {
  const { root, h } = setup();
  const notices = new WorkflowFailureNotices();
  for (const id of [first, second]) {
    writeFileSync(
      workflowResultFile(ensureWorkflowRunDir(root, id)),
      JSON.stringify({ runId: id, ok: false, error: `line one\nreason for ${id}` }),
    );
    notices.publish(h.ctx, id, "earlier live summary");
  }
  expect(h.widgets.get("workflows-failure-notice")).toContain("(+1)");
  expect(h.widgets.get("workflows-failure-notice")).toContain(first);
  h.customInputQueue.push("e");
  await openWorkflowRunViewer(h.ctx, root, second, notices);
  expect(h.customRenderFrames.flat().join("\n")).toContain(`reason for ${second}`);
  expect(h.ctx.ui.getEditorText?.()).toContain(second);
  expect(h.sentUserMessages).toHaveLength(0);
  expect(notices.reason(second)).toBeUndefined();
  expect(notices.reason(first)).toBe("earlier live summary");
  notices.reset();
  expect(notices.reason(first)).toBeUndefined();
});

it("keeps a draft and identifies a session-only failure when no valid result can be read", async () => {
  const { root, h } = setup();
  const notices = new WorkflowFailureNotices();
  writeFileSync(
    workflowResultFile(ensureWorkflowRunDir(root, first)),
    JSON.stringify({ runId: second, ok: false, error: "wrong run" }),
  );
  notices.publish(h.ctx, first, "observed here");
  h.ctx.ui.setEditorText?.("draft to keep");
  h.customInputQueue.push("e", "\x1b", "\x1b", "\x1b");
  await openWorkflowRunViewer(h.ctx, root, first, notices);
  const screen = h.customRenderFrames.flat().join("\n");
  expect(screen).toContain("Saved result unavailable");
  expect(screen).toContain("observed here");
  expect(screen).not.toContain("wrong run");
  expect(h.ctx.ui.getEditorText?.()).toBe("draft to keep");
  expect(h.sentUserMessages).toHaveLength(0);
});
