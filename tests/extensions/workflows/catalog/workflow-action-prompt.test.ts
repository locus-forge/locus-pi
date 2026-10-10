import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("prepares typed JSON for a separate explicit launch", () => {
    const prompt = startPrompt(
      rowFor(
        'export const meta={inputSchema:{type:"object",properties:{mode:{type:"string"}},required:["mode"],additionalProperties:false}}; export default()=>null;\n',
      ),
    );

    expect(prompt).toContain('Request: Prepare typed input for the exact current workflow "review"');
    expect(prompt).toContain("Skill: locus-pi-workflow-run");
    expect(prompt).toContain('beginning "/workflows run review --input-json "');
    expect(prompt).toContain("Do not call the workflow tool, submit the command, or start the workflow");
    expect(prompt).toContain("launches in a separate action");
    expect(prompt).not.toContain("Prepare and start");
  });
});
