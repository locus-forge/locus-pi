/** End-to-end explicit typed intake, source admission and serialized replay controls. */
import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runner from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowReplayFile } from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { parseRunCommand } from "../../../../../extensions/workflows/command/command-parser.js";
import { createHarness } from "../../../../test-harness.js";
import { executor } from "../../../../fixtures/workflow-durable-project.js";
import {
  cleanupReplayProjects,
  temporaryProject,
  writeWorkflow,
} from "../../../../fixtures/workflow-replay-project.js";
afterEach(cleanupReplayProjects);

describe("typed inline workflow input", () => {
  it("validates and freezes the descriptor before calling the owned subfunction", async () => {
    const runtime = createWorkflowRuntime({
      runId: "typed-inline",
      agentRunner: async () => {
        throw new Error("unused");
      },
    });
    const fn = vi.fn(async (_dsl, value) => value);
    const descriptor = { inputValue: [" original "], inputSchema: { type: "array", items: { type: "string" } } };
    const pending = runtime.dsl.workflow(fn, descriptor as never);
    descriptor.inputValue[0] = "changed";
    expect(await pending).toEqual([" original "]);
    expect(Object.isFrozen(fn.mock.calls[0]?.[1])).toBe(true);
    await expect(
      runtime.dsl.workflow(fn, { inputValue: [7], inputSchema: descriptor.inputSchema } as never),
    ).rejects.toThrow(/typed input/u);
    await expect(runtime.dsl.workflow(fn, { ...descriptor, extra: true } as never)).rejects.toThrow(/closed/u);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("explicit typed workflow input", () => {
  const schema = {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"],
    additionalProperties: false,
  };
  const source = `export const meta = { inputSchema: ${JSON.stringify(schema)} };
export default async function runWorkflow(dsl, input) {
  await dsl.agent("typed", { label: "typed" });
  return { input, frozen: Object.isFrozen(input) };
}`;
  const createExecutor = executor(() => "ok");

  it("admits destructuring in fresh trusted JavaScript without granting checked replay proof", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "typed",
      `export const meta={inputSchema:${JSON.stringify(schema)}};
export default function run(dsl,{target}){return target;}`,
    );
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: { target: "fresh" },
      createExecutor,
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toBe("fresh");
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: { target: "fresh" },
      resumeFromRunId: result.runId,
      createExecutor,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/proven callable coverage/u);
  });

  it("detaches before presentation callbacks and persists typed authority rather than discarding the value", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "typed", source);
    const harness = createHarness(root);
    const inputValue = { target: "original" };
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue,
      createExecutor,
      onRunStart: () => {
        inputValue.target = "mutated";
      },
    } as unknown as runner.RunWorkflowScriptOptions);
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toEqual({ input: { target: "original" }, frozen: true });
    expect(readWorkflowLaunchBinding(root, result.runId)).toMatchObject({
      schema: "locus-pi.workflow-launch-binding.v4",
      typedInput: { value: { target: "original" }, schema },
    });
  });

  it.each([
    { inputValue: { target: 7 } },
    { inputValue: { target: "x", extra: true } },
    { inputValue: undefined },
    { inputValue: { target: "x" }, input: undefined },
    { inputValue: { target: "x" }, input: "text" },
    {},
  ])("refuses missing, invalid or conflicting schema input before importing or starting work: %j", async (fields) => {
    const root = temporaryProject();
    const marker = path.join(root, "imported");
    writeWorkflow(
      root,
      "typed",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");\n${source}`,
    );
    const harness = createHarness(root);
    let calls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      ...fields,
      createExecutor: () => ({
        async run() {
          calls++;
          throw new Error("unexpected work");
        },
      }),
    } as unknown as runner.RunWorkflowScriptOptions);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inputValue|typed input|inputSchema/u);
    expect(calls).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(readWorkflowLaunchBinding(root, result.runId)).toBeNull();
  });

  it("never invokes a typed payload getter", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "typed", source);
    const harness = createHarness(root);
    let reads = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: {
        get target() {
          reads++;
          return "secret";
        },
      },
      createExecutor,
    } as unknown as runner.RunWorkflowScriptOptions);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON data properties/u);
    expect(reads).toBe(0);
  });

  it("refuses an own inputValue getter without evaluating it", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "typed", source);
    const harness = createHarness(root);
    let reads = 0;
    const options = {
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      createExecutor,
    };
    Object.defineProperty(options, "inputValue", {
      enumerable: true,
      get() {
        reads++;
        return { target: "secret" };
      },
    });
    const result = await runWorkflowScript(options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON data properties/u);
    expect(reads).toBe(0);
  });

  it.each(["inputSchema", "inputSchema(){ return {type:'null'}; }"])(
    "refuses visible unsupported schema syntax before import: %s",
    async (declaration) => {
      const root = temporaryProject();
      const marker = path.join(root, "imported");
      writeWorkflow(
        root,
        "typed",
        `import {writeFileSync} from "node:fs"; const inputSchema={type:"null"}; export const meta={${declaration}}; writeFileSync(${JSON.stringify(marker)},"imported"); export default function run(){return null;}`,
      );
      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "typed",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/explicit static schema/u);
      expect(() => readFileSync(marker)).toThrow();
    },
  );

  it.each(["intact", "missing", "empty", "malformed", "truncated", "zero", "clock", "clock-missing"])(
    "binds typed replay to complete historical work: %s",
    async (mode) => {
      const root = temporaryProject();
      writeWorkflow(
        root,
        "typed",
        `export const meta={inputSchema:{type:"null"}}; export default async function run(dsl,input){${mode.startsWith("clock") ? "dsl.now();" : mode === "zero" ? "" : 'await dsl.agent("first",{label:"first"}); await dsl.agent("second",{label:"second"});'}return input;}`,
      );
      const harness = createHarness(root);
      const execute = vi.fn(createExecutor().run);
      const options = {
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "typed",
        inputValue: null,
        createExecutor: () => ({ run: execute }),
      };
      const first = await runWorkflowScript(options);
      expect(first.ok, first.error).toBe(true);
      expect(statSync(workflowLaunchBindingFile(first.runDir)).mode & 0o777).toBe(0o600);
      const log = workflowReplayFile(first.runDir);
      if (mode === "missing" || mode === "clock-missing") unlinkSync(log);
      if (mode === "empty") writeFileSync(log, "");
      if (mode === "malformed") writeFileSync(log, "{damaged\n");
      if (mode === "truncated") writeFileSync(log, readFileSync(log, "utf8").split("\n")[0] + "\n");
      execute.mockClear();
      const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
      expect(execute).not.toHaveBeenCalled();
      if (["intact", "zero", "clock"].includes(mode)) {
        expect(resumed.ok, resumed.error).toBe(true);
        expect(resumed.result).toBe(null);
      } else {
        expect(resumed.ok).toBe(false);
        expect(resumed.error).toMatch(/replay evidence/u);
      }
    },
  );

  it("refuses a changed typed value on resume instead of replaying or silently starting new work", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "typed", source);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: { target: "original" },
      createExecutor,
    } as unknown as runner.RunWorkflowScriptOptions);
    expect(first.ok, first.error).toBe(true);
    let calls = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "typed",
      inputValue: { target: "changed" },
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          calls++;
          throw new Error("unexpected work");
        },
      }),
    } as unknown as runner.RunWorkflowScriptOptions);
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/typed input/u);
    expect(calls).toBe(0);
  });
});

describe("terminal typed JSON command input", () => {
  it("preserves JSON kinds and treats the whole remaining tail as one JSON value", () => {
    expect(parseRunCommand('run typed --run-name exact --input-json {"value": [null, " a ", 7]}')).toEqual({
      scriptRef: "typed",
      runName: "exact",
      inputValue: { value: [null, " a ", 7] },
    });
    expect(parseRunCommand("run typed --input-json null")).toEqual({ scriptRef: "typed", inputValue: null });
    expect(parseRunCommand("run typed -- --input-json null")).toEqual({
      scriptRef: "typed",
      input: "--input-json null",
    });
  });
  it.each([
    "run typed --input-json",
    'run typed --input-json {"a":1} --input-json {}',
    "run typed text --input-json {}",
    "run typed --input-json NaN",
  ])("refuses invalid or mixed JSON input: %s", (command) => {
    expect(parseRunCommand(command)).toMatchObject({ inputJSONError: expect.any(String) });
  });
});

describe("typed canonical identity and hostile intake", () => {
  it.each([null, true, 17, "  exact  ", [null, "x"], { z: [1], a: "x" }])(
    "preserves JSON value %j across canonical resume",
    async (inputValue) => {
      const root = temporaryProject();
      const type = inputValue === null ? "null" : Array.isArray(inputValue) ? "array" : typeof inputValue;
      writeWorkflow(
        root,
        "kinds",
        `export const meta={inputSchema:{type:${JSON.stringify(type)}}}; export default function run(dsl,input){return input;}`,
      );
      const harness = createHarness(root);
      const options = {
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "kinds",
        inputValue,
      };
      const first = await runWorkflowScript(options);
      expect(first.ok, first.error).toBe(true);
      const canonical = type === "object" ? { a: "x", z: [1] } : inputValue;
      const resumed = await runWorkflowScript({ ...options, inputValue: canonical, resumeFromRunId: first.runId });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.result).toEqual(inputValue);
    },
  );
  it.each([
    ["nonfinite", () => NaN],
    ["infinity", () => Infinity],
    ["function", () => () => "x"],
    ["symbol", () => Symbol("x")],
    ["sparse", () => new Array(2)],
    ["date", () => new Date()],
    [
      "cycle",
      () => {
        const value: unknown[] = [];
        value.push(value);
        return value;
      },
    ],
  ])("rejects non-JSON %s before import and child execution", async (_label, factory) => {
    const root = temporaryProject(),
      marker = path.join(root, "imported");
    writeWorkflow(
      root,
      "hostile",
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},"ran"); export const meta={inputSchema:{type:"object"}}; export default function run(dsl,input){return input;}`,
    );
    const harness = createHarness(root),
      execute = vi.fn();
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "hostile",
      inputValue: (factory as () => unknown)(),
      createExecutor: () => ({ run: execute }),
    } as runner.RunWorkflowScriptOptions);
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(() => readFileSync(marker)).toThrow();
    expect(readWorkflowLaunchBinding(root, result.runId)).toBeNull();
  });
  it("uses the full retained schema beyond catalog prefix and checks materialized metadata before entry", async () => {
    const root = temporaryProject(),
      marker = path.join(root, "entry");
    const prefix = "// padding\n".repeat(7000);
    writeWorkflow(
      root,
      "late",
      `${prefix}const S={type:"null"}; export const meta={inputSchema:S}; export default function run(dsl,input){return input;}`,
    );
    const harness = createHarness(root),
      options = {
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "late",
        inputValue: null,
      };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(true);
    expect(first.result).toBe(null);
    writeWorkflow(
      root,
      "late",
      `import {writeFileSync} from "node:fs"; export const meta={inputSchema:{type:"null"}}; meta.inputSchema={type:"string"}; export default function run(){writeFileSync(${JSON.stringify(marker)},"ran");return null;}`,
    );
    const changed = await runWorkflowScript(options);
    expect(changed.ok).toBe(false);
    expect(changed.error).toMatch(/inputSchema.*statically admitted/u);
    expect(() => readFileSync(marker)).toThrow();
  });
  it.each(["missing", "downgrade", "identity", "extra", "projection", "schema"])(
    "refuses damaged typed authority: %s",
    async (mode) => {
      const root = temporaryProject();
      writeWorkflow(
        root,
        "authority",
        'export const meta={inputSchema:{type:"null"}};export default async function run(dsl,input){await dsl.agent("x",{label:"x"});return input;}',
      );
      const harness = createHarness(root),
        execute = vi.fn(executor(() => "ok")().run);
      const options = {
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "authority",
        inputValue: null,
        createExecutor: () => ({ run: execute }),
      };
      const first = await runWorkflowScript(options);
      expect(first.ok, first.error).toBe(true);
      const file = workflowLaunchBindingFile(first.runDir),
        value = JSON.parse(readFileSync(file, "utf8"));
      if (mode === "missing") unlinkSync(file);
      else if (mode === "projection") {
        const resultFile = workflowResultFile(first.runDir),
          result = JSON.parse(readFileSync(resultFile, "utf8"));
        result.typedInput.valueSha256 = "0".repeat(64);
        writeFileSync(resultFile, JSON.stringify(result));
      } else {
        if (mode === "downgrade") value.schema = "locus-pi.workflow-launch-binding.v3";
        if (mode === "identity") value.typedInput.identity.valueSha256 = "0".repeat(64);
        if (mode === "extra") value.typedInput.extra = true;
        if (mode === "schema") value.typedInput.schema = { type: "string" };
        writeFileSync(file, JSON.stringify(value));
      }
      execute.mockClear();
      const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
      expect(resumed.ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each(["now", "random"])("does not mistake a JSON data field %s for a DSL call", async (key) => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "names",
      `export const meta={inputSchema:{type:"object",properties:{${key}:{type:"string"}},required:["${key}"]}};export default function run(dsl,input){return input.${key};}`,
    );
    const harness = createHarness(root),
      options = {
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "names",
        inputValue: { [key]: "ordinary data" },
      };
    const first = await runWorkflowScript(options);
    expect(first.ok, first.error).toBe(true);
    const resumed = await runWorkflowScript({ ...options, resumeFromRunId: first.runId });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.result).toBe("ordinary data");
  });
});
