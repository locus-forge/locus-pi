import { dataflowWorkflowSourceDiagnostics } from "../../../../../extensions/workflows/source/profiles/workflow-source-dataflow.js";
import {
  standardWorkflowSourceShapeDiagnostics,
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
} from "../../../../../extensions/workflows/tool/workflow-source-shape.js";
import { assessWorkflowStructuredReplayCoverage } from "../../../../../extensions/workflows/runtime/workflow-script-identity.js";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowReplayFile } from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { createStructuredSdkExecutor, rawTurn } from "../../../../fixtures/agent-runtime/structured-sdk.js";
import { workflowJournalFile } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  runWorkflowScript,
  type RunWorkflowScriptOptions,
} from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { executor } from "../../../../fixtures/workflow-durable-project.js";
import {
  cleanupReplayProjects,
  temporaryProject,
  writeWorkflow,
} from "../../../../fixtures/workflow-replay-project.js";
import { createHarness } from "../../../../test-harness.js";

afterEach(cleanupReplayProjects);

it.each([
  "missing-logical-id",
  "awaiting-downgrade",
  "failed-downgrade",
  "false-failure",
  "clock-tail",
  "random-tail",
  "agent-key",
  "agent-failed",
  "caught-failure",
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
  let fail = mode === "failed-retry" || mode === "caught-failure";
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
  expect(first.ok, first.error).toBe(mode !== "failed-retry");
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
  if (mode === "agent-key" || mode === "caught-agent" || mode.endsWith("downgrade"))
    remaining.find((row) => row.kind === "agent").key = "0".repeat(64);
  if (mode === "agent-failed" || mode === "false-failure") remaining.find((row) => row.kind === "agent").ok = false;
  if (mode === "unused-value") remaining.push({ v: 4, seq: 0, kind: "clock", value: 123 });
  writeFileSync(file, remaining.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (mode.endsWith("downgrade") || mode === "false-failure") {
    const resultFile = workflowResultFile(first.runDir);
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    result.disposition =
      mode === "awaiting-downgrade" ? { status: "awaiting_operator", detail: "forged" } : { status: "failed" };
    result.ok = mode === "awaiting-downgrade";
    writeFileSync(resultFile, JSON.stringify(result));
  }
  if (mode === "missing-logical-id") {
    const file = workflowJournalFile(first.runDir);
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const row of rows) {
      delete row.logicalCallId;
      delete row.attempt;
      delete row.attempts;
    }
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  freshCalls = 0;
  fail = false;
  const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
  expect(resumed.ok, resumed.error).toBe(mode === "parallel" || mode === "failed-retry");
  expect(freshCalls).toBe(mode === "failed-retry" ? 1 : 0);
  if (!resumed.ok) expect(resumed.error).toMatch(/[Tt]yped (?:input )?replay/u);
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

it.each([
  ["serial", ["good0", "bad1"], ["bad1"]],
  ["serial", ["bad0", "good1"], ["bad0", "good1"]],
  ["parallel", ["bad0", "good1"], ["bad0"]],
  ["parallel", ["good0", "bad1"], ["bad1"]],
  ["parallel", ["good0", "bad1", "good2"], ["bad1"]],
] as const)("retries only corroborated failures in %s %j", async (mode, labels, expectedFresh) => {
  const root = temporaryProject();
  const call = (label: string) => `dsl.agent("${label}",{label:"${label}"})`;
  const body =
    mode === "serial"
      ? labels.map((label) => `await ${call(label)};`).join("")
      : `await dsl.parallel([${labels.map((label) => `()=>${call(label)}`).join(",")}]);`;
  writeWorkflow(
    root,
    "typed",
    `export const meta={inputSchema:{type:"null"}};export default async function run(dsl,input){${body}return input;}`,
  );
  const harness = createHarness(root);
  let fail = true;
  const prompts: string[] = [];
  const options = {
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name: "typed",
    inputValue: null,
    createExecutor: executor((prompt) => {
      prompts.push(prompt);
      if (fail && prompt.startsWith("bad")) throw new Error("scripted failed call");
      return "ok";
    }),
  };
  const first = await runWorkflowScript(options);
  expect(first.ok).toBe(false);
  prompts.length = 0;
  fail = false;
  const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
  expect(resumed.ok, resumed.error).toBe(true);
  expect(prompts).toEqual(expectedFresh);
});

it.each([
  ['for(let input=0;input<1;input+=1)agent("Tick");return input;', false, false],
  ['for(let i=0;i<1;i+=1)agent("Tick");return input;', false, true],
  ['for(let context=0;context<1;context+=1)agent("Tick");return input;', true, false],
  [
    'if(context!==undefined){for(let context=0;context<1;context+=1)agent("Tick");if(context.operatorAnswer==="deploy")return agent("Deploy");}return input;',
    true,
    false,
  ],
  [
    'if(context!==undefined){for(let context=0;context<1;context+=1)agent("Tick");return context.operatorAnswer;}return input;',
    true,
    false,
  ],
  [
    'if(context!==undefined){for(const context of ["local"])agent(context);if(context.operatorAnswer==="deploy")return agent("Deploy");}return input;',
    true,
    false,
  ],
  [
    'if(context!==undefined){var context={operatorAnswer:"local"};return context.operatorAnswer;}return input;',
    true,
    false,
  ],
  [
    'if(context!==undefined){const context={operatorAnswer:"local"};agent(context.operatorAnswer);}if(context!==undefined)return agent(context.operatorAnswer);return input;',
    true,
    true,
  ],
  ['if(true){const input="local";agent(input);}return input;', false, true],
  ['if(true){const input="local";agent(input);}if(input==="deploy")return agent("Deploy");return input;', false, false],
])("keeps literal-shadow exemptions within actual lexical ownership: %s", (body, typed, accepted) => {
  const source = `export const meta={profile:"standard"${typed ? ',inputSchema:{type:"string"}' : ""}};export default function run({agent},input${typed ? ",context" : ""}){${body}}`;
  expect(standardWorkflowSourceShapeDiagnostics(source).some((item) => item.severity === "error")).toBe(!accepted);
});

it.each([false, true])(
  "uses the last successful transport attempt, never an earlier failure: corrupt=%s",
  async (corrupt) => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "typed",
      'export const meta={inputSchema:{type:"null"}};export default async function run(dsl,input){return dsl.agent("retry",{label:"retry",attempts:2});}',
    );
    const harness = createHarness(root);
    let calls = 0;
    const options = {
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: null,
      createExecutor: () => ({
        async run() {
          calls++;
          return calls === 1
            ? {
                status: "failed" as const,
                reason: "scripted transport failure",
                failureCause: "host-turn-timeout" as const,
                diagnostics: [],
                lifecycleEntryIds: [],
              }
            : { status: "completed" as const, reason: "answered", text: "ok", diagnostics: [], lifecycleEntryIds: [] };
        },
      }),
    };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(true);
    expect(calls).toBe(2);
    if (corrupt) {
      const replayFile = workflowReplayFile(first.runDir);
      const row = JSON.parse(readFileSync(replayFile, "utf8"));
      writeFileSync(replayFile, JSON.stringify({ ...row, ok: false }) + "\n");
      const resultFile = workflowResultFile(first.runDir);
      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      writeFileSync(resultFile, JSON.stringify({ ...result, ok: false, disposition: { status: "failed" } }));
    }
    calls = 0;
    const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
    expect(resumed.ok, resumed.error).toBe(!corrupt);
    expect(calls).toBe(0);
  },
);

it.each(["intact-success", "real-failed-retry", "swapped-failure-proof"] as const)(
  "correlates mixed structured replay by logical identity: %s",
  async (mode) => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "typed",
      `export const meta={inputSchema:{type:"null"}};
export default async function run(dsl,input){await dsl.parallel([
()=>dsl.agent("shape",{label:"shape",schema:{type:"string"}}),
()=>dsl.agent("good",{label:"good"}),()=>dsl.agent("bad",{label:"bad"})]);return input;}`,
    );
    const sdk = await createStructuredSdkExecutor(root, [rawTurn([JSON.stringify({ value: "answer shape" })])]);
    const harness = createHarness(root);
    let shouldFail = mode !== "intact-success";
    const prompts: string[] = [];
    const options: RunWorkflowScriptOptions = {
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: null,
      createExecutor(executorOptions) {
        return {
          async run(request, signal) {
            const separator = "\n\n---\n\n";
            const prompt = request.task.slice(request.task.lastIndexOf(separator) + separator.length);
            prompts.push(prompt);
            if (shouldFail && prompt === "bad")
              return {
                status: "failed",
                agentName: "default",
                reason: "scripted failure",
                diagnostics: [],
                lifecycleEntryIds: [],
              };
            if (request.responseAcceptance !== undefined)
              return sdk.createExecutor(executorOptions).run(request, signal);
            return {
              status: "completed",
              agentName: "default",
              reason: "answered",
              text: `answer ${prompt}`,
              diagnostics: [],
              lifecycleEntryIds: [],
            };
          },
        };
      },
    };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(!shouldFail);
    prompts.length = 0;
    const second = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
    expect(second.ok, second.error).toBe(!shouldFail);
    expect(prompts).toEqual(shouldFail ? ["bad"] : []);
    const journal = readFileSync(workflowJournalFile(second.runDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = journal.filter((line) => line.kind === "agent_start");
    expect(starts.map((line) => line.label)).toEqual(["good", "bad", "shape"]);
    expect(starts.map((line) => line.logicalCallId)).toEqual(["logical-0002", "logical-0003", "logical-0001"]);
    if (mode === "swapped-failure-proof") {
      const file = workflowReplayFile(second.runDir);
      const rows = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const good = rows.find((row) => row.seq === 1),
        bad = rows.find((row) => row.seq === 2);
      expect(good.ok).toBe(true);
      expect(bad.ok).toBe(false);
      good.ok = false;
      delete good.text;
      bad.ok = true;
      bad.text = "forged successful bad";
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
    shouldFail = false;
    prompts.length = 0;
    const third = await runWorkflowScript({ ...options, resumeFromRunId: second.runId });
    expect(third.ok, third.error).toBe(mode !== "swapped-failure-proof");
    expect(prompts).toEqual(mode === "real-failed-retry" ? ["bad"] : []);
    if (mode === "swapped-failure-proof") expect(third.error).toMatch(/typed input replay evidence/u);
    expect(sdk.counters.generations).toBe(1);
  },
);
