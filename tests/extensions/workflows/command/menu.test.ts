import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];
const ROOT_WORKFLOW_OPTIONS = [
  "list — browse available workflows",
  "dashboard — inspect persisted runs and evidence",
  "info — inspect one workflow's details",
  "status — view recent run progress",
  "result — read a finished run's output",
  "run — fill the editor for a workflow launch",
  "continue — answer a pending handoff",
  "stop — stop an active run",
  "skills — install workflow skills for external agents",
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-command-menu-"));
  roots.push(root);
  return root;
}

describe("/workflows root menu", () => {
  it("shows exactly the nine real verbs with readable descriptions", async () => {
    const h = createHarness(makeRoot());
    h.customInputQueue.push("\x1b");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);

    expect(h.selectCalls[0]?.options).toEqual([...ROOT_WORKFLOW_OPTIONS]);
    expect(h.selectCalls[0]?.options.every((option) => typeof option === "string")).toBe(true);
  });

  it("opens the project workflow and focuses Start through the default Enter path", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "alpha.workflow.mjs"),
      'export const meta = { name: "alpha", description: "Alpha workflow" };\nexport default async function run() {}\n',
      "utf8",
    );
    const h = createHarness(root);
    h.customInputQueue.push("enter", "enter");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);

    expect(h.selectCalls[0]?.options[0]).toBe("list — browse available workflows");
    expect(h.customRenderFrames[0]?.join("\n")).toContain("[Project 1]");
    expect(h.customRenderFrames[1]?.join("\n")).toContain("› [Start] Back Edit Review");
    expect(h.editorText).toBe("/workflows run alpha");
    expect(existsSync(path.join(root, ".locus-pi", "runs"))).toBe(false);
  });

  it("routes a descriptive root selection back to its exact verb", async () => {
    const h = createHarness(makeRoot());
    h.selectQueue.push("status — view recent run progress");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);

    expect(h.widgets.get("workflows") ?? "").toContain("No workflow runs yet.");
  });

  it("opens the root chooser after a stale status view", async () => {
    const h = createHarness(makeRoot());
    h.ctx.hasUI = true;
    workflows(h.pi);
    const handler = h.commands.get("workflows")!.handler;

    await handler("status", h.ctx);
    expect(typeof h.widgetPayloads.get("workflows")).toBe("function");
    await handler("", h.ctx);

    expect(h.selectCalls.at(-1)?.options).toEqual([...ROOT_WORKFLOW_OPTIONS]);
    expect(h.notifications).toEqual([]);
  });
});
