import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness, emit } from "../../../test-harness.js";

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

  it("correlates a typed Run selection until consumption and then releases its name guard", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    const sourcePath = path.join(workflowDir, "typed.workflow.mjs");
    writeFileSync(
      sourcePath,
      'export const meta={inputSchema:{type:"object",properties:{mode:{type:"string"}},required:["mode"]}}; export default()=>"selected";\n',
    );
    writeFileSync(path.join(workflowDir, "other.workflow.mjs"), 'export default()=>"other";\n');
    const h = createHarness(root);
    h.selectQueue.push("run", "typed");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);
    const catalogSelectionId = /catalogSelectionId "([^"]+)"/u.exec(h.editorText)?.[1];
    expect(catalogSelectionId).toBeDefined();

    const unrelated = await h.tools
      .get("workflow")!
      .execute("unrelated", { name: "other" }, new AbortController().signal, () => void 0, h.ctx);
    expect(unrelated.isError).not.toBe(true);

    const missingId = await h.tools
      .get("workflow")!
      .execute(
        "missing-id",
        { name: "typed", inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(missingId.content[0]).toMatchObject({ text: expect.stringContaining("catalogSelectionId is required") });

    const mismatch = await h.tools
      .get("workflow")!
      .execute("mismatch", { name: "other", catalogSelectionId }, new AbortController().signal, () => void 0, h.ctx);
    expect(mismatch.content[0]).toMatchObject({ text: expect.stringContaining("does not match") });

    writeFileSync(
      sourcePath,
      'export const meta={inputSchema:{type:"object",properties:{mode:{type:"string"}},required:["mode"]}}; export default()=>"changed";\n',
    );
    const result = await h.tools
      .get("workflow")!
      .execute(
        "selected-drift",
        { name: "typed", catalogSelectionId, inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );

    expect(h.editorText).toMatch(/^Start the exact current workflow "typed"/u);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("entry bytes changed") });

    const independent = await h.tools
      .get("workflow")!
      .execute(
        "independent",
        { name: "typed", inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(independent.isError).not.toBe(true);

    const reused = await h.tools
      .get("workflow")!
      .execute(
        "reused",
        { name: "typed", catalogSelectionId, inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(reused.content[0]).toMatchObject({ text: expect.stringContaining("unknown or used") });
  });

  it("retires superseded and abandoned typed Start handoffs on the real input lifecycle", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "typed.workflow.mjs"),
      'export const meta={inputSchema:{type:"object",properties:{mode:{type:"string"}},required:["mode"]}}; export default()=>"selected";\n',
    );
    const h = createHarness(root);
    h.selectQueue.push("run", "typed", "run", "typed");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);
    const firstId = /catalogSelectionId "([^"]+)"/u.exec(h.editorText)?.[1];
    await h.commands.get("workflows")!.handler("", h.ctx);
    const secondId = /catalogSelectionId "([^"]+)"/u.exec(h.editorText)?.[1];
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);

    await emit(h, "input", { text: h.editorText, source: "interactive" });
    const superseded = await h.tools
      .get("workflow")!
      .execute(
        "superseded",
        { name: "typed", catalogSelectionId: firstId, inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(superseded.content[0]).toMatchObject({ text: expect.stringContaining("unknown or used") });

    const current = await h.tools
      .get("workflow")!
      .execute(
        "current",
        { name: "typed", catalogSelectionId: secondId, inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(current.isError).not.toBe(true);

    h.selectQueue.push("run", "typed");
    await h.commands.get("workflows")!.handler("", h.ctx);
    const abandonedId = /catalogSelectionId "([^"]+)"/u.exec(h.editorText)?.[1];
    await emit(h, "input", { text: "Run typed independently.", source: "interactive" });
    const independent = await h.tools
      .get("workflow")!
      .execute(
        "independent-after-abandon",
        { name: "typed", inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(independent.isError).not.toBe(true);

    const abandoned = await h.tools
      .get("workflow")!
      .execute(
        "abandoned",
        { name: "typed", catalogSelectionId: abandonedId, inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
    expect(abandoned.content[0]).toMatchObject({ text: expect.stringContaining("unknown or used") });
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
