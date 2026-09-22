import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

/** T-120 — workflow semantic input is one optional bounded string. */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-input-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Input test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

function writeWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

/** Reports back exactly what the second parameter of runWorkflow() was. */
const ECHO_INPUT_WORKFLOW = `export const meta = { name: "echo-input", description: "Report the received input shape." };
export default async function runWorkflow(dsl, input) {
  await dsl.agent("inspect");
  return {
    ok: true,
    receivedType: Array.isArray(input) ? "array" : typeof input,
    received: input,
    items: dsl.items(),
    itemsFrozen: Object.isFrozen(dsl.items()),
  };
}
`;

interface RunOutcome {
  ok: boolean;
  result: unknown;
  /** Per-child request metadata, where the runner surfaces the run's `args`. */
  metadata: Array<Record<string, unknown> | undefined>;
}

async function runEcho(root: string, input?: string, items?: readonly string[]): Promise<RunOutcome> {
  const harness = createHarness(root, { sessionId: "workflow-input" });
  const metadata: Array<Record<string, unknown> | undefined> = [];
  const createExecutor = (): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      metadata.push(request.metadata as Record<string, unknown> | undefined);
      return {
        status: "completed" as const,
        agentName: request.agent?.name ?? "sub-agent",
        reason: "answered",
        text: "ok",
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
  const res = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name: "echo-input",
    createExecutor,
    ...(input !== undefined ? { input } : {}),
    ...(items !== undefined ? { items } : {}),
  });
  return { ok: res.ok, result: res.result, metadata };
}

function registerTool() {
  const harness = createHarness();
  workflows(harness.pi);
  return { harness, tool: harness.tools.get("workflow")! };
}

describe("string-only workflow input", () => {
  it.each([undefined, "", "  \n\t  "])(
    "fails Package task/plan input %j at admission with zero child calls and no workflow source",
    async (input) => {
      const root = temporaryProject();
      const harness = createHarness(root, { sessionId: "task-plan-required-input" });
      let childCalls = 0;
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "task/plan",
        createExecutor: () => ({
          async run() {
            childCalls += 1;
            throw new Error("must not run");
          },
        }),
        ...(input === undefined ? {} : { input }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "task/plan requires the complete accepted draft as non-empty semantic input; no agent was started and no workflow.mjs was published.",
      );
      expect(childCalls).toBe(0);
      expect(result.primaryFile).toBeUndefined();
      expect(result.journal.some((line) => line.kind === "agent_start")).toBe(false);
      expect(JSON.parse(readFileSync(result.resultPersistence.path, "utf8"))).toMatchObject({
        ok: false,
        error: expect.stringContaining("requires the complete accepted draft"),
      });
    },
  );

  it("persists awaiting_operator beside the workflow's unchanged prepared result", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "await-operator",
      `export default async function runWorkflow(dsl) {
  dsl.awaitOperator({ reason: "review clarification required" });
  return { mode: "prepared", token: "unchanged" };
}
`,
    );
    const harness = createHarness(root, { sessionId: "workflow-await-operator" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "await-operator",
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ mode: "prepared", token: "unchanged" });
    expect(result.disposition).toEqual({
      status: "awaiting_operator",
      detail: "review clarification required",
    });
    expect(JSON.parse(readFileSync(result.resultPersistence.path, "utf8"))).toMatchObject({
      ok: true,
      result: { mode: "prepared", token: "unchanged" },
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
    });
  });

  it("rejects an object at the runner boundary before any child runs", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const harness = createHarness(root, { sessionId: "workflow-input-object" });
    let childCalls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "echo-input",
      createExecutor: () => ({
        async run() {
          childCalls += 1;
          throw new Error("must not run");
        },
      }),
      // Runtime guard for untyped JavaScript/direct callers.
      input: { target: "src/auth" },
    } as unknown as runner.RunWorkflowScriptOptions);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("workflow input must be a string");
    expect(childCalls).toBe(0);
  });

  it("leaves the free-text path byte-for-byte as it was", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);

    const outcome = await runEcho(root, "review the auth module");

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      receivedType: "string",
      received: "review the auth module",
    });
    expect(outcome.metadata[0]).toMatchObject({ workflowArgs: "review the auth module" });
  });

  it("accepts only absent or bounded string input in the tool schema", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;

    expect(Value.Check(schema, { name: "demo", input: "free text" })).toBe(true);
    expect(Value.Check(schema, { name: "demo" })).toBe(true);
    expect(Value.Check(schema, { name: "demo", input: { target: "src", depth: 2 } })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: ["a", "b"] })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: 7 })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: null })).toBe(false);
    expect(Value.Check(schema, { name: "demo", unexpected: true })).toBe(false);
  });

  it("uses the exact saved-name policy in the programmatic tool schema", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;

    expect(Value.Check(schema, { name: "alpha workflow" })).toBe(true);
    expect(Value.Check(schema, { name: "alpha/beta" })).toBe(true);
    expect(Value.Check(schema, { name: "a".repeat(200) })).toBe(true);
    for (const name of [
      "",
      " alpha",
      "alpha ",
      "alpha\u0001control",
      "alpha/beta/gamma",
      String.raw`alpha\beta`,
      "alpha.mjs",
      "alpha.MJS",
      "a".repeat(201),
    ]) {
      expect(Value.Check(schema, { name }), name).toBe(false);
    }
  });

  it("documents confined workflow workspaces while leaving path confinement to runtime preflight", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;
    const outputDirDescription = (schema as { properties?: Record<string, { description?: string }> }).properties
      ?.outputDir?.description;
    expect(outputDirDescription).toContain(
      "Fresh workflows default to unique .locus-pi/workspaces/<generated-run-name>",
    );
    expect(outputDirDescription).toContain("resume repeats the source workspace");
    expect(outputDirDescription).toContain(".tasks/<task>/artifacts is a legal explicit workspace");
    expect(outputDirDescription).not.toMatch(/defaults to tmp\/<workflow-name> beneath the Pi working directory\.$/u);

    expect(Value.Check(schema, { name: "demo", outputDir: "outputs/demo" })).toBe(true);
    expect(Value.Check(schema, { name: "demo", outputDir: "results.v2/task_1" })).toBe(true);
    expect(
      Value.Check(schema, {
        name: "task/plan",
        outputDir: ".locus-pi/workspaces/20260819-120000-a1b2-task-draft",
      }),
    ).toBe(true);
    expect(Value.Check(schema, { name: "demo", outputDir: ".tasks/T-144-2026-09-08-workflow/artifacts" })).toBe(true);
    // No aggregate character cap on the whole path: each component is still checked
    // against the safe alphabet and the path must stay confined, and the real length
    // limits belong to the filesystem, which reports them in its own words.
    expect(Value.Check(schema, { name: "demo", outputDir: `${"a".repeat(199)}/${"b".repeat(200)}` })).toBe(true);
    expect(Value.Check(schema, { name: "demo", outputDir: `${"a".repeat(200)}/${"b".repeat(200)}` })).toBe(true);
    for (const outputDir of ["/tmp/demo", "./demo", "../demo", "outputs/../demo"]) {
      expect(Value.Check(schema, { name: "demo", outputDir })).toBe(true);
    }
  });

  it("accepts only safe workflow run ids for tool resume metadata", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;

    expect(Value.Check(schema, { name: "demo", resumeFromRunId: "20260812-123456-abcd" })).toBe(true);
    expect(Value.Check(schema, { name: "demo", resumeFromRunId: "a".repeat(128) })).toBe(true);
    for (const resumeFromRunId of [
      "../outside",
      "runs/outside",
      String.raw`runs\\outside`,
      "/tmp/outside",
      "C:/outside",
      "a".repeat(129),
    ]) {
      expect(Value.Check(schema, { name: "demo", resumeFromRunId })).toBe(false);
    }
  });

  it("rejects an unsafe workflow workspace before the workflow runner is called", async () => {
    const { harness, tool } = registerTool();
    const spy = vi.spyOn(runner, "runWorkflowScript").mockRejectedValue(new Error("must not call runner"));
    try {
      const result = await tool.execute(
        "tool-output-invalid",
        { name: "live-smoke", outputDir: "../escape" },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("outputDir escapes the project root"),
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards an explicit task workspace without requiring a run id during tool preflight", async () => {
    const { harness, tool } = registerTool();
    const outputDir = ".locus-pi/workspaces/tool-selected-plan";
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "task-plan-explicit-output",
      runDir: "/tmp/task-plan-explicit-output",
      ok: true,
      result: "planned",
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/task-plan-explicit-output/runtime/result.json" },
    });
    try {
      const result = await tool.execute(
        "tool-task-plan-explicit-output",
        { name: "task/plan", outputDir },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

      expect(result.isError).not.toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "task/plan", outputDir });
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts any string list in the closed tool schema without content or quantity policy", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;
    const large = Array.from({ length: 10_000 }, (_, index) => ` item ${String(index)} \n`);

    expect(Value.Check(schema, { name: "demo", items: [] })).toBe(true);
    expect(Value.Check(schema, { name: "demo", items: ["", "  ", "same", "same"] })).toBe(true);
    expect(Value.Check(schema, { name: "demo", items: large })).toBe(true);
    expect(Value.Check(schema, { name: "demo", items: "one" })).toBe(false);
    expect(Value.Check(schema, { name: "demo", items: ["one", 2] })).toBe(false);
    expect(Value.Check(schema, { name: "demo", items: [["nested"]] })).toBe(false);
    expect(Value.Check(schema, { name: "demo", items: null })).toBe(false);
    expect(Value.Check(schema, { name: "demo", Items: ["typo"] })).toBe(false);
  });

  it.each([
    ["number member", { name: "live-smoke", items: ["alpha", 7] }],
    ["null member", { name: "live-smoke", items: ["alpha", null] }],
    ["nested member", { name: "live-smoke", items: ["alpha", ["nested"]] }],
    ["unknown top-level field", { name: "live-smoke", items: ["alpha"], unexpected: true }],
  ])("rejects raw %s before Pi can coerce the tool arguments", (_label, raw) => {
    const { tool } = registerTool();

    expect(() => tool.prepareArguments?.(raw)).toThrow("Validation failed");
  });

  it("returns valid raw tool arguments unchanged before Pi conversion", () => {
    const { tool } = registerTool();
    const raw = { name: "live-smoke", input: " exact input ", items: ["alpha", "", "alpha"] };

    const prepared = tool.prepareArguments?.(raw);

    expect(prepared).toBe(raw);
    expect(prepared).toEqual(raw);
  });

  it.each([
    ["number member", { name: "live-smoke", items: ["alpha", 7] }],
    ["null member", { name: "live-smoke", items: ["alpha", null] }],
    ["nested member", { name: "live-smoke", items: ["alpha", ["nested"]] }],
    ["unknown top-level field", { name: "live-smoke", items: ["alpha"], unexpected: true }],
  ])("rejects direct execute %s before the workflow runner is called", async (_label, raw) => {
    const { harness, tool } = registerTool();
    const spy = vi.spyOn(runner, "runWorkflowScript").mockRejectedValue(new Error("must not call runner"));
    try {
      const result = await tool.execute(
        "tool-items-invalid",
        raw,
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Validation failed") });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards tool items to the runner without normalizing their values or order", async () => {
    const { harness, tool } = registerTool();
    const items = ["", "  spaced  ", "same", "same", "line 1\nline 2"];
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "items-forwarding",
      runDir: "/tmp/items-forwarding",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/items-forwarding/runtime/result.json" },
    });
    try {
      await tool.execute(
        "tool-items",
        { name: "live-smoke", items },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0].items).toEqual(items);
    } finally {
      spy.mockRestore();
    }
  });

  it("starts a run for a long semantic request instead of refusing it", async () => {
    // The removed 16 000-character input ceiling. The input IS the operator's task, and
    // refusing to start because the task is long is a size policy over work.
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const oversized = "x".repeat(20_000);

    const outcome = await runEcho(root, oversized);

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ received: oversized });
  });

  it("keeps the exact supplied text instead of trimming or parsing it", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const exact = "  review auth\nwith rollback focus  ";

    const outcome = await runEcho(root, exact);

    expect(outcome.result).toMatchObject({ received: exact });
    expect(outcome.metadata[0]).toMatchObject({ workflowArgs: exact });
  });

  it("carries exact items separately from semantic input without child-list metadata", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const items = ["", "  blank-looking  ", "same", "same", "line 1\nline 2\u0000tail"];

    const outcome = await runEcho(root, "semantic request", items);

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ received: "semantic request", items, itemsFrozen: true });
    expect(outcome.metadata[0]).toMatchObject({ workflowArgs: "semantic request" });
    expect(outcome.metadata[0]).not.toHaveProperty("workflowItems");
    expect(JSON.stringify(outcome.metadata[0])).not.toContain("blank-looking");
  });

  it("revalidates invalid direct runner items before any child runs", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const harness = createHarness(root, { sessionId: "workflow-items-invalid" });
    let childCalls = 0;
    let startCalls = 0;

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "echo-input",
      items: ["valid", 2],
      onRunStart() {
        startCalls += 1;
      },
      createExecutor: () => ({
        async run() {
          childCalls += 1;
          throw new Error("must not run");
        },
      }),
    } as unknown as runner.RunWorkflowScriptOptions);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("workflow items[1] must be a string");
    expect(result.journal).toContainEqual(expect.objectContaining({ kind: "error", message: result.error }));
    expect(result.resultPersistence.ok).toBe(true);
    expect(startCalls).toBe(0);
    expect(childCalls).toBe(0);
  });

  it("snapshots direct runner items before onRunStart can mutate the caller array", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "items-on-start", `export default function runWorkflow(dsl) { return dsl.items(); }\n`);
    const harness = createHarness(root, { sessionId: "workflow-items-on-start" });
    const source = [" first ", "same", "same"];
    let startCalls = 0;

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "items-on-start",
      items: source,
      onRunStart() {
        startCalls += 1;
        source[0] = "mutated";
        source.push("later");
      },
    });

    expect(startCalls).toBe(1);
    expect(source).toEqual(["mutated", "same", "same", "later"]);
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toEqual([" first ", "same", "same"]);
  });

  it("revalidates direct runtime callers and exposes a detached frozen snapshot", () => {
    const agentRunner = async (): Promise<WorkflowAgentResult> => ({
      ok: true,
      status: "completed",
      summary: "unused",
      text: "unused",
      diagnostics: [],
      agent: "default",
    });
    const source = [" first ", "", "duplicate", "duplicate"];
    const runtime = createWorkflowRuntime({ runId: "items-snapshot", agentRunner, items: source });
    source[0] = "mutated";
    source.push("later");

    expect(runtime.dsl.items()).toEqual([" first ", "", "duplicate", "duplicate"]);
    expect(Object.isFrozen(runtime.dsl.items())).toBe(true);
    expect(() => (runtime.dsl.items() as string[]).push("blocked")).toThrow(TypeError);

    const absent = createWorkflowRuntime({ runId: "items-absent", agentRunner });
    expect(absent.dsl.items()).toEqual([]);
    expect(Object.isFrozen(absent.dsl.items())).toBe(true);
    expect(() =>
      createWorkflowRuntime({ runId: "items-invalid", agentRunner, items: ["ok", null] as unknown as string[] }),
    ).toThrow("workflow items[1] must be a string");
  });

  it("transports 10,000 items through a no-agent workflow unchanged", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "many-items", `export default function runWorkflow(dsl) { return dsl.items(); }\n`);
    const harness = createHarness(root, { sessionId: "workflow-many-items" });
    const items = Array.from({ length: 10_000 }, (_, index) =>
      index % 3 === 0 ? "" : ` ${String(index)}\n${String(index)} `,
    );

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "many-items",
      items,
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.result).toEqual(items);
    expect(result.journal.some((line) => JSON.stringify(line).includes("9998"))).toBe(false);
    expect(result).not.toHaveProperty("items");
  });

  it("uses supplied items in one ordered per-item mini-workflow and preserves result order", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "item-pipeline",
      `async function processItem(dsl, item) {
  const finding = await dsl.agent("inspect:" + item);
  return dsl.agent("write:" + item + ":" + finding);
}
export default function runWorkflow(dsl) {
  return dsl.pipeline(dsl.items(), (item) => dsl.workflow((nested) => processItem(nested, item)));
}
`,
    );
    const harness = createHarness(root, { sessionId: "workflow-item-pipeline" });
    const calls: string[] = [];
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "item-pipeline",
      items: ["alpha", "beta", "gamma"],
      createExecutor: () => ({
        async run(request) {
          const prompt = request.task.slice(request.task.lastIndexOf("\n\n") + 2);
          calls.push(prompt);
          const item = prompt.split(":")[1] ?? "missing";
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: prompt.startsWith("inspect:") ? `finding:${item}` : `written:${item}`,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.result).toEqual(["written:alpha", "written:beta", "written:gamma"]);
    for (const item of ["alpha", "beta", "gamma"]) {
      expect(calls.indexOf(`inspect:${item}`)).toBeLessThan(calls.indexOf(`write:${item}:finding:${item}`));
    }
  });

  it("keeps supplied-item pipelines fail-closed when one mini-workflow fails", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "item-failure",
      `async function processItem(dsl, item) {
  const finding = await dsl.agent("inspect:" + item);
  return dsl.agent("write:" + item + ":" + finding);
}
export default function runWorkflow(dsl) {
  return dsl.pipeline(dsl.items(), (item) => dsl.workflow((nested) => processItem(nested, item)));
}
`,
    );
    const harness = createHarness(root, { sessionId: "workflow-item-failure" });
    const calls: string[] = [];
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "item-failure",
      items: ["good", "bad", "also-good"],
      createExecutor: () => ({
        async run(request) {
          const prompt = request.task.slice(request.task.lastIndexOf("\n\n") + 2);
          calls.push(prompt);
          if (prompt === "inspect:bad") {
            return {
              status: "failed" as const,
              agentName: request.agent?.name ?? "sub-agent",
              reason: "scripted failure",
              diagnostics: ["bad item"],
              lifecycleEntryIds: [],
            };
          }
          const item = prompt.split(":")[1] ?? "missing";
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: prompt.startsWith("inspect:") ? `finding:${item}` : `written:${item}`,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("pipeline failed in 1/3 branch(es)");
    expect(calls).not.toContain("write:bad:undefined");
    expect(calls.some((prompt) => prompt.startsWith("write:bad:"))).toBe(false);
  });

  it("lets request-keyed replay distinguish changed item text without item identity metadata", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "item-replay",
      `export default async function runWorkflow(dsl) { return dsl.agent("item:" + dsl.items()[0]); }\n`,
    );

    const run = async (items: readonly string[], resumeFromRunId?: string) => {
      const harness = createHarness(root, { sessionId: `workflow-item-replay-${items[0]}` });
      const calls: string[] = [];
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "item-replay",
        items,
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor: () => ({
          async run(request) {
            const prompt = request.task.slice(request.task.lastIndexOf("\n\n") + 2);
            calls.push(prompt);
            return {
              status: "completed" as const,
              agentName: request.agent?.name ?? "sub-agent",
              reason: "answered",
              text: `answer:${prompt}`,
              diagnostics: [],
              lifecycleEntryIds: [],
            };
          },
        }),
      });
      return { result, calls };
    };

    const first = await run(["alpha"]);
    expect(first.result.ok, first.result.error).toBe(true);
    expect(first.calls).toEqual(["item:alpha"]);

    const identical = await run(["alpha"], first.result.runId);
    expect(identical.calls).toEqual([]);
    expect(identical.result.replay).toMatchObject({ replayedCalls: 1, freshCalls: 0 });

    const changed = await run(["beta"], first.result.runId);
    expect(changed.calls).toEqual(["item:beta"]);
    expect(changed.result.replay).toMatchObject({ replayedCalls: 0, freshCalls: 1, divergedAtCall: 0 });
  });
});
