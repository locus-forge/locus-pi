import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cleanupReplayProjects,
  temporaryProject,
  writeWorkflow,
  runWorkflow,
} from "../../../../fixtures/workflow-replay-project.js";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
afterEach(cleanupReplayProjects);

it.each([
  "unchanged",
  "value",
  "schema",
  "child-source",
  "parent-source",
  "items",
  "missing",
  "malformed",
  "mixed",
  "downgrade",
  "downgrade-missing",
  "fresh-root",
  "never-executed",
  "different-target",
  "different-key",
  "resume-of-resume",
  "resume-missing",
  "navigation-delete",
  "navigation-empty",
  "navigation-failed",
  "navigation-null",
  "navigation-mixed",
  "navigation-status",
  "projection-stripped",
  "snapshot-removed",
  "cycle",
])("typed saved-child completion preserves identity and fresh-work distinctions: %s", async (mode) => {
  const root = temporaryProject();
  const file = path.join(root, "invocation.json");
  const invocation = {
    name: "child",
    key: "unit",
    value: "original",
    items: ["A"],
    typed: true,
    run: mode !== "never-executed",
  };
  const save = () => writeFileSync(file, JSON.stringify(invocation));
  const parent = `import {readFileSync} from "node:fs"; export default async function run({invokeWorkflow}) {
    const v=JSON.parse(readFileSync(${JSON.stringify(file)},"utf8")); if(!v.run)return "unused";
    return invokeWorkflow({name:v.name,key:v.key,keys:[v.key],...(v.typed?{inputValue:v.value}:{input:v.value}),items:v.items});
  }`;
  const child =
    'export const meta={inputSchema:{type:"string"}};export default async function run({agent},input){return agent(input,{label:"child"});}';
  save();
  writeWorkflow(root, "parent", parent);
  writeWorkflow(root, "child", child);
  writeWorkflow(root, "other", child);
  const options = { workspaceDir: "same" };
  const first = await runWorkflow(root, "parent", options);
  expect(first.ok, first.error).toBe(true);
  expect(first.executedPrompts).toHaveLength(mode === "never-executed" ? 0 : 1);
  const same = await runWorkflow(root, "parent", {
    ...options,
    resumeFromRunId: first.runId,
  });
  expect(same.ok, same.error).toBe(true);
  expect(same.executedPrompts).toHaveLength(0);
  if (mode === "value") invocation.value = "changed";
  if (mode === "items") invocation.items = ["B"];
  if (mode === "different-target") invocation.name = "other";
  if (mode === "different-key") invocation.key = "other";
  if (mode === "never-executed") invocation.run = true;
  if (mode === "schema") writeWorkflow(root, "child", child.replace('type:"string"', 'type:"string",minLength:1'));
  if (mode === "child-source") writeWorkflow(root, "child", child + "\n// changed child\n");
  if (mode === "parent-source") writeWorkflow(root, "parent", parent + "\n// changed parent\n");
  if (mode.startsWith("downgrade")) {
    invocation.typed = false;
    writeWorkflow(root, "child", child.replace('export const meta={inputSchema:{type:"string"}};', ""));
  }
  save();
  const checkpoints = readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.includes("checkpoints/v4/") && name.endsWith(".json"));
  const checkpoint = path.join(root, checkpoints[0] ?? "absent");
  if (mode === "malformed") writeFileSync(checkpoint, "{broken");
  if (mode === "mixed") {
    const value = JSON.parse(readFileSync(checkpoint, "utf8"));
    writeFileSync(checkpoint, JSON.stringify({ ...value, schema: "locus-pi.workflow-checkpoint.v3" }));
  }
  const missing = [
    "missing",
    "downgrade-missing",
    "resume-missing",
    "navigation-delete",
    "navigation-empty",
    "navigation-failed",
    "navigation-null",
    "navigation-mixed",
    "navigation-status",
    "projection-stripped",
    "snapshot-removed",
    "cycle",
  ].includes(mode);
  if (missing) unlinkSync(checkpoint);
  if (mode.startsWith("navigation-")) {
    const result = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8"));
    if (mode === "navigation-delete") delete result.childRuns;
    if (mode === "navigation-empty") result.childRuns = [];
    if (mode === "navigation-failed") result.childRuns[0].status = "failed";
    if (mode === "navigation-null") result.childRuns = null;
    if (mode === "navigation-mixed") result.childRuns.push(null);
    if (mode === "navigation-status") result.childRuns[0].status = "unknown";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(result));
  }
  if (["projection-stripped", "snapshot-removed"].includes(mode)) {
    const childDir = first.raw.childRuns![0]!.runDir!;
    const result = JSON.parse(readFileSync(workflowResultFile(childDir), "utf8"));
    delete result.typedInput;
    if (mode === "snapshot-removed") unlinkSync(result.scriptIdentity.snapshotPath);
    writeFileSync(workflowResultFile(childDir), JSON.stringify(result));
  }
  if (mode === "cycle") {
    const result = JSON.parse(readFileSync(workflowResultFile(same.runDir), "utf8"));
    result.resumeFromRunId = same.runId;
    writeFileSync(workflowResultFile(same.runDir), JSON.stringify(result));
  }
  const fresh = ["fresh-root", "never-executed", "different-target", "different-key"].includes(mode);
  const source = ["resume-of-resume", "resume-missing", "cycle"].includes(mode) ? same : first;
  const result = await runWorkflow(root, "parent", {
    ...options,
    ...(mode === "fresh-root" ? {} : { resumeFromRunId: source.runId }),
  });
  expect(result.ok, result.error).toBe(fresh || ["unchanged", "resume-of-resume"].includes(mode));
  expect(result.executedPrompts).toHaveLength(fresh ? 1 : 0);
});
