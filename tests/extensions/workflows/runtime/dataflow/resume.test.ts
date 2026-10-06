import { createWorkflowOperatorHandoffService } from "../../../../../extensions/workflows/operator/operator-handoff-service.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../../test-harness.js";
import { executor } from "../../../../fixtures/workflow-durable-project.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupReplayProjects,
  runWorkflow,
  temporaryProject,
  writeWorkflow,
} from "../../../../fixtures/workflow-replay-project.js";

const workflow = `export const meta = {profile:"dataflow-v1"};
function prefix(value) { return "Review: " + value; }
export default async function run({agent,log}, input) { log("entered-dataflow"); return await agent(prefix(input), {label:"review"}); }`;
afterEach(cleanupReplayProjects);

async function refusedAttempt(root: string, input: string, resumeFromRunId: string) {
  const harness = createHarness(root);
  const executedPrompts: string[] = [];
  const result = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name: "dataflow",
    input,
    workspaceDir: "same",
    resumeFromRunId,
    createExecutor: () => ({
      run: async (request) => {
        executedPrompts.push(request.task);
        throw new Error("unexpected child start");
      },
    }),
  });
  return { ...result, executedPrompts };
}

describe("full retained source fence before dataflow effects", () => {
  it.each(["root", "saved-child"])(
    "distinguishes visible-profile refusal and opaque legacy import in %s",
    async (mode) => {
      const root = temporaryProject();
      const sentinel = path.join(root, "import-sentinel");
      const declarations = [
        ['export const meta={profile:true ? "dataflow-v1" : "legacy"};', false, false],
        ['export const meta={profile:"dataflow-" + "v1"};', false, false],
        ['function metadata(){return {profile:"dataflow-v1"};} export const meta=metadata();', true, false],
        ['function metadata(){return {profile:"dataflow-v1"};} export const meta={...metadata()};', true, false],
        [
          'function metadata(){return {profile:"legacy",details:{profile:"dataflow-v1"}};} export const meta=metadata();',
          true,
          true,
        ],
      ] as const;
      for (const [declaration, imported, admitted] of declarations) {
        rmSync(sentinel, { force: true });
        writeWorkflow(
          root,
          "dataflow",
          `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)},"imported"); ${declaration} export default async function run({agent,log}){log("profile-entry");return agent("profile-child",{label:"profile-child"});}`,
        );
        writeWorkflow(
          root,
          "parent",
          'export default async function run({invokeWorkflow}){return invokeWorkflow({name:"dataflow",key:"child",keys:["child"]});}',
        );
        const harness = createHarness(root);
        let childCalls = 0;
        const result = await runWorkflowScript({
          pi: harness.pi,
          ctx: harness.ctx,
          signal: new AbortController().signal,
          name: mode === "root" ? "dataflow" : "parent",
          workspaceDir: "same",
          createExecutor: executor(() => {
            childCalls += 1;
            return "profile-child";
          }),
        });
        expect(result.ok, result.error).toBe(admitted);
        if (!imported) expect(() => readFileSync(sentinel)).toThrow();
        if (imported) expect(readFileSync(sentinel, "utf8")).toBe("imported");
        expect(childCalls).toBe(admitted ? 1 : 0);
        if (!admitted) expect(JSON.stringify(result)).not.toContain("profile-entry");
        if (!admitted) expect(JSON.stringify(result)).toContain("dataflow-v1");
      }
    },
  );

  it.each([
    ["return input.trim();", "  untyped raw text  ", "untyped raw text"],
    ["return JSON.parse(input).message;", '{"message":"explicit decoded text"}', "explicit decoded text"],
    [
      'try {return JSON.parse(input).message;} catch (error) {return "ordinary parse error";}',
      "{broken",
      "ordinary parse error",
    ],
  ])("executes explicit data semantics without a schema stamp: %s", async (body, input, expected) => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "dataflow",
      `export const meta={profile:"dataflow-v1"}; export default function run({log},input){${body}}`,
    );
    const result = await runWorkflow(root, "dataflow", { input, workspaceDir: "same" });
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toBe(expected);
    expect(result.executedPrompts).toEqual([]);
  });
  it("reports malformed explicit JSON as an ordinary script error", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "dataflow",
      'export const meta={profile:"dataflow-v1"}; export default function run({log},input){return JSON.parse(input).message;}',
    );
    const result = await runWorkflow(root, "dataflow", { input: "{broken", workspaceDir: "same" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON|property name/u);
    expect(result.error).not.toContain("Output contract");
    expect(result.executedPrompts).toEqual([]);
  });
  it("executes and replays a documented nested workflow DSL without a new child", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "dataflow",
      'export const meta={profile:"dataflow-v1"}; export default function run({workflow},input){return workflow(async(dsl,request)=>{const {agent}=dsl; return agent(request,{label:"nested-review"});},input);}',
    );
    const first = await runWorkflow(root, "dataflow", { input: "Complete nested task", workspaceDir: "same" });
    expect(first.ok, first.error).toBe(true);
    expect(first.executedPrompts).toEqual(["Complete nested task"]);
    const next = await runWorkflow(root, "dataflow", {
      input: "Complete nested task",
      workspaceDir: "same",
      resumeFromRunId: first.runId,
    });
    expect(next.ok, next.error).toBe(true);
    expect(next.result).toBe(first.result);
    expect(next.executedPrompts).toEqual([]);
  });
  it("replays unchanged supported source without starting another child", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "dataflow", workflow);
    const first = await runWorkflow(root, "dataflow", { input: "Task", workspaceDir: "same" });
    expect(first.ok).toBe(true);
    const next = await runWorkflow(root, "dataflow", {
      input: "Task",
      workspaceDir: "same",
      resumeFromRunId: first.runId,
    });
    expect(next.ok).toBe(true);
    expect(next.result).toBe(first.result);
    expect(next.executedPrompts).toEqual([]);
    expect(next.replay.replayedCalls).toBe(1);
  });
  it.each([
    (value: string) => value + "\n// changed comment",
    (value: string) => value.replace('"Review: "', '"Changed: "'),
    (value: string) => value.replace('profile:"dataflow-v1"', 'profile:"legacy"'),
    (value: string) => value.replace('profile:"dataflow-v1"', 'name:"removed-profile"'),
  ])("refuses helper, comment and profile edits before workflow code or child start", async (edit) => {
    const root = temporaryProject();
    writeWorkflow(root, "dataflow", workflow);
    const first = await runWorkflow(root, "dataflow", { input: "Task", workspaceDir: "same" });
    expect(first.ok).toBe(true);
    writeWorkflow(root, "dataflow", edit(workflow));
    const next = await refusedAttempt(root, "Task", first.runId);
    expect(next.ok).toBe(false);
    expect(next.error).toMatch(/dataflow-v1 resume refused.*retained source identity/u);
    expect(next.executedPrompts).toEqual([]);
    expect(JSON.stringify(next.journal)).not.toContain("entered-dataflow");
  });
  it("sees the recorded profile before a downgraded entry-only import can evaluate", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "dataflow", workflow);
    const first = await runWorkflow(root, "dataflow", { input: "Task", workspaceDir: "same" });
    const sentinel = path.join(root, "evaluated");
    writeWorkflow(
      root,
      "dataflow",
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n` +
        workflow.replace('profile:"dataflow-v1"', 'profile:"legacy"'),
    );
    const next = await refusedAttempt(root, "Task", first.runId);
    expect(next.ok).toBe(false);
    expect(next.error).toContain("dataflow-v1 resume refused");
    expect(existsSync(sentinel)).toBe(false);
    expect(next.executedPrompts).toEqual([]);
  });
  it("refuses a retained snapshot mismatch against its persisted hash", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "dataflow", workflow);
    const first = await runWorkflow(root, "dataflow", { input: "Task", workspaceDir: "same" });
    const identity = first.raw.scriptIdentity!;
    // Recorded bytes may not declare themselves legacy while keeping their old authority.
    const changed = readFileSync(identity.snapshotPath, "utf8").replace('profile:"dataflow-v1"', 'profile:"legacy"');
    const fs = await import("node:fs");
    fs.chmodSync(identity.snapshotPath, 0o600);
    writeFileSync(identity.snapshotPath, changed);
    const next = await refusedAttempt(root, "Task", first.runId);
    expect(next.ok).toBe(false);
    expect(next.error).toMatch(/snapshot.*hash mismatch/u);
    expect(next.executedPrompts).toEqual([]);
  });
  it.each([
    "value.map",
    'value["map"]',
    "value.flat",
    "value.push",
    "value.toString",
    "value.charAt",
    "value.replace",
    'value["replace"]',
  ])("refuses unknown receiver extraction before earlier plain work: %s", async (read) => {
    const root = temporaryProject();
    const source = `export const meta={profile:"dataflow-v1"}; function pick(value){return ${read};} export default async function run({agent,log},input){log("entered-extraction");await agent("plain-first",{label:"plain"});return String(pick(["x"]));}`;
    writeWorkflow(root, "dataflow", source);
    const first = await runWorkflow(root, "dataflow", { input: "Task", workspaceDir: "same" });
    expect(first.ok, first.error).toBe(true);
    expect(first.executedPrompts).toEqual(["plain-first"]);
    const next = await refusedAttempt(root, "Task", first.runId);
    expect(next.ok).toBe(false);
    expect(next.error).toContain("structured callable coverage is unproven");
    expect(next.executedPrompts).toEqual([]);
    expect(JSON.stringify(next.journal)).not.toContain("entered-extraction");
  });
  it("refuses valid but unproven coverage before even an earlier plain child", async () => {
    const root = temporaryProject();
    const source = `export const meta = {profile:"dataflow-v1"}; export default async function run({agent,log}, input) {log("entered-unproven"); await agent("plain-first", {label:"plain"}); const values=["A","B"]; return values[input];}`;
    writeWorkflow(root, "dataflow", source);
    const first = await runWorkflow(root, "dataflow", { input: "0", workspaceDir: "same" });
    expect(first.ok).toBe(true);
    const next = await refusedAttempt(root, "0", first.runId);
    expect(next.ok).toBe(false);
    expect(next.error).toContain("source is valid for fresh execution but structured callable coverage is unproven");
    expect(next.executedPrompts).toEqual([]);
    expect(JSON.stringify(next.journal)).not.toContain("entered-unproven");
  });
});

describe("typed saved-child input authority", () => {
  it("validates the child's own schema before a source-bound checkpoint and preserves a detached value", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "typed-child",
      `export const meta = {inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}};
export default async function run(dsl,input) { await dsl.agent(input.text,{label:"child"}); return input; }`,
    );
    writeWorkflow(
      root,
      "typed-parent",
      `export default async function run(dsl) { return dsl.invokeWorkflow({name:"typed-child",key:"item",keys:["item"],inputValue:{text:" exact "}}); }`,
    );
    const harness = createHarness(root);
    const calls: string[] = [];
    const options = {
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed-parent",
      createExecutor: executor((prompt) => {
        calls.push(prompt);
        return "ok";
      }),
    };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(true);
    expect(calls).toEqual([" exact "]);
    calls.length = 0;
    const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual([]);
    expect(resumed.childRuns?.[0]?.status).toBe("skipped");
    writeWorkflow(
      root,
      "typed-parent",
      `export default async function run(dsl) { return dsl.invokeWorkflow({name:"typed-child",key:"item",keys:["item"],inputValue:{text:7}}); }`,
    );
    const invalid = await runWorkflowScript(options);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/typed input/u);
    expect(calls).toEqual([]);
  });
});

describe("typed operator continuation authority", () => {
  it("preserves original JSON and exact ordinary answer across continuation, resume and resume-of-resume", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "typed",
      `export const meta = {profile:"dataflow-v1",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}};
export default async function run(dsl,input,context) {
  if (context === undefined) {
    const intent = dsl.publishArtifact("intent.md","intent");
    dsl.awaitOperator({reason:"decision",operatorHandoff:{title:"Decision",questions:[{kind:"select",id:"decision",prompt:"Choose",options:[{label:"Proceed"}],recommended:"Proceed",allowCustom:true}],continuationArtifactRefs:[intent]}});
    return "waiting";
  }
  return {input,answer:context.operatorAnswer};
}`,
    );
    const harness = createHarness(root);
    const options = {
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: { id: "original" },
    };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(true);
    const originBytes = readFileSync(workflowLaunchBindingFile(first.runDir), "utf8");
    let terminal: ReturnType<typeof runWorkflowScript> | undefined;
    const service = createWorkflowOperatorHandoffService({
      launch(request) {
        const { inputValue: _original, ...base } = options;
        terminal = runWorkflowScript({
          ...base,
          ...request,
          targetBinding: request.target,
          ...(Object.hasOwn(request, "inputValue") ? { inputValue: request.inputValue } : { input: request.input }),
        } as Parameters<typeof runWorkflowScript>[0]);
        return { status: "started" };
      },
    });
    const item = service.scan(root).find((item) => item.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected typed handoff");
    const answer = " exact accepted answer\n ";
    expect(await service.launch(item.handoff, answer, harness.ctx)).toMatchObject({ status: "started" });
    const continued = await terminal!;
    expect(continued.ok, continued.error).toBe(true);
    expect(continued.result).toEqual({ input: { id: "original" }, answer });
    expect(readWorkflowLaunchBinding(root, continued.runId)?.typedInput?.operatorContext).toEqual({
      originRunId: first.runId,
      operatorAnswer: answer,
    });
    expect(readFileSync(workflowLaunchBindingFile(first.runDir), "utf8")).toBe(originBytes);
    for (const source of [continued, await runWorkflowScript({ ...options, resumeFromRunId: continued.runId })]) {
      const resumed = await runWorkflowScript({ ...options, resumeFromRunId: source.runId });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.result).toEqual(continued.result);
      expect(JSON.stringify(resumed.typedInput)).not.toContain(answer);
    }
  });
});
