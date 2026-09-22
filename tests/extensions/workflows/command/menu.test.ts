import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];
const ROOT_WORKFLOW_OPTIONS = [
  "dashboard — inspect persisted runs and evidence",
  "list — browse available workflows",
  "info — inspect one workflow's details",
  "status — view recent run progress",
  "result — read a finished run's output",
  "run — start a workflow",
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
