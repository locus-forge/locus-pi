import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowCatalogViewer } from "../../../../extensions/workflows/catalog/catalog-viewer.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogModel,
} from "../../../../extensions/workflows/catalog/workflow-catalog.js";

const roots: string[] = [];
const previousHome = process.env.HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rowFor(source: string, name = "review"): ReturnType<typeof buildWorkflowCatalogModel>["current"][number] {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-action-prompt-"));
  roots.push(root);
  process.env.HOME = path.join(root, "home");
  const workflowDir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, `${name}.workflow.mjs`), source);
  return buildWorkflowCatalogModel(root, root).current.find((row) => row.name === name)!;
}

function startPrompt(row: ReturnType<typeof rowFor>): string {
  return buildWorkflowActionPrompt({
    action: "start",
    row,
    sourceState: { kind: "ready", row, path: row.target.path, source: readFileSync(row.target.path, "utf8") },
  });
}

describe("workflow Start editor handoff", () => {
  it("keeps an untyped workflow as a direct editable command", () => {
    expect(startPrompt(rowFor("export default () => null;\n"))).toBe("/workflows run review");
  });

  it("requests one native typed-tool launch without requiring a skill command", () => {
    const prompt = startPrompt(
      rowFor(
        'export const meta={inputSchema:{type:"object",properties:{mode:{type:"string"}},required:["mode"],additionalProperties:false}}; export default()=>null;\n',
      ),
    );

    expect(prompt).toMatch(/^Start the exact current workflow "review"/u);
    expect(prompt).toContain("explicit programmatic run request from the interactive Pi catalog");
    expect(prompt).toContain('call the native workflow tool with name "review" and that inputValue');
    expect(prompt).toContain("interactive confirmation is the user's review step");
    expect(prompt).toContain("Do not invoke Pi, use a shell, emit or execute a /workflows command");
    expect(prompt).not.toContain("--input-json");
    expect(prompt).not.toContain("/skill:");
    expect(prompt).not.toContain("preparation-only");
  });

  it("describes typed Start as an editor handoff instead of a direct launch", () => {
    const row = rowFor(
      'export const meta={inputSchema:{type:"object",properties:{task:{type:"string"}},required:["task"]}}; export default()=>null;\n',
      "typed",
    );
    const root = path.resolve(path.dirname(row.target.path), "..", "..");
    const model = buildWorkflowCatalogModel(root, root);
    const viewer = new WorkflowCatalogViewer(
      { requestRender() {}, terminal: { rows: 12, columns: 120 } },
      {},
      {},
      model,
      root,
      root,
      () => {},
    );

    viewer.handleInput("enter");
    const rendered = viewer.render(120).join("\n");
    expect(rendered).toContain("Start fills editor; Edit/Review handoff");
    expect(rendered).not.toContain("Start direct");
  });
});
