import { dataflowWorkflowSourceDiagnostics } from "../../../../../extensions/workflows/source/profiles/workflow-source-dataflow.js";
import {
  standardWorkflowSourceShapeDiagnostics,
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
} from "../../../../../extensions/workflows/tool/workflow-source-shape.js";
import { assessWorkflowStructuredReplayCoverage } from "../../../../../extensions/workflows/runtime/workflow-script-identity.js";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { workflowReplayFile } from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { executor } from "../../../../fixtures/workflow-durable-project.js";
import {
  cleanupReplayProjects,
  temporaryProject,
  writeWorkflow,
} from "../../../../fixtures/workflow-replay-project.js";
import { createHarness } from "../../../../test-harness.js";

afterEach(cleanupReplayProjects);

it.each([
  "clock-tail",
  "random-tail",
  "agent-key",
  "agent-failed",
  "caught-clock",
  "caught-agent",
  "unused-value",
  "parallel",
  "failed-retry",
])("completed typed replay preserves evidence and valid retry distinctions: %s", async (mode) => {
  const root = temporaryProject();
  const values = mode.includes("clock")
    ? "dsl.now();dsl.now();"
    : mode === "random-tail"
      ? "dsl.random();dsl.random();"
      : "";
  const calls =
    mode === "parallel"
      ? 'await dsl.parallel([()=>dsl.agent("slow",{label:"slow"}),()=>dsl.agent("fast",{label:"fast"})]);'
      : 'await dsl.agent("x",{label:"x"});';
  const body = values + calls;
  writeWorkflow(
    root,
    "typed",
    `export const meta={inputSchema:{type:"null"}};
export default async function run(dsl,input){${mode.startsWith("caught-") ? `try{${body}}catch{}` : body}return input;}`,
  );
  const harness = createHarness(root);
  let freshCalls = 0;
  let fail = mode === "failed-retry";
  const options = {
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name: "typed",
    inputValue: null,
    createExecutor: executor(async (prompt) => {
      freshCalls++;
      if (fail) throw new Error("scripted failed attempt");
      if (prompt.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 30));
      return "ok";
    }),
  };
  const first = await runWorkflowScript(options);
  expect(first.ok, first.error).toBe(!fail);
  const file = workflowReplayFile(first.runDir);
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (mode === "parallel") expect(rows.filter((row) => row.kind === "agent").map((row) => row.seq)).toEqual([1, 0]);
  const remaining = rows.filter(
    (row) =>
      !(
        row.seq === 1 &&
        ((mode.includes("clock") && row.kind === "clock") || (mode === "random-tail" && row.kind === "random"))
      ),
  );
  if (mode === "agent-key" || mode === "caught-agent")
    remaining.find((row) => row.kind === "agent").key = "0".repeat(64);
  if (mode === "agent-failed") remaining.find((row) => row.kind === "agent").ok = false;
  if (mode === "unused-value") remaining.push({ v: 4, seq: 0, kind: "clock", value: 123 });
  writeFileSync(file, remaining.map((row) => JSON.stringify(row)).join("\n") + "\n");
  freshCalls = 0;
  fail = false;
  const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
  expect(resumed.ok, resumed.error).toBe(mode === "parallel" || mode === "failed-retry");
  expect(freshCalls).toBe(mode === "failed-retry" ? 1 : 0);
  if (!resumed.ok) expect(resumed.error).toMatch(/typed replay/u);
});

it.each(["{text}", "{text: value}", "{...value}", "value = {}"])(
  "does not assign the entire typed schema to parameter pattern %s",
  (pattern) => {
    const schema = '{type:"object",properties:{text:{type:"string"}},required:["text"]}';
    const bound = pattern === "{text}" ? "text" : "value";
    const sources = [
      `export const meta={inputSchema:${schema}};export default function run(dsl,${pattern}){return ${bound}.text;}`,
      `export default function run(dsl){return dsl.workflow((inner,${pattern})=>${bound}.text,{inputValue:{text:"x"},inputSchema:${schema}});}`,
    ];
    for (const source of sources) {
      for (const diagnostics of [
        standardWorkflowSourceShapeDiagnostics,
        orchestrationOnlyWorkflowSourceShapeDiagnostics,
        dataflowWorkflowSourceDiagnostics,
      ])
        expect(diagnostics(source).some((item) => item.severity === "error")).toBe(true);
      expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
    }
  },
);
