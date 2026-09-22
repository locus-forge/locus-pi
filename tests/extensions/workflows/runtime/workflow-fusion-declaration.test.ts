/**
 * What a Fusion panel REFUSES, and when — every check that fires before the first
 * child starts. The owner is `workflow-fusion.ts`: `prepareWorkflowFusion` normalizes
 * and rejects the declaration, and the all-legs host preflight runs on top of it, so a
 * bad judge selector is refused before any member is paid for.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "workflow-fusion-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function success(request: WorkflowAgentRequest, text: string): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary: "done",
    text,
    diagnostics: [],
    agent: request.agent,
    ...(request.returnContract === undefined
      ? {}
      : { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }),
    ...(request.capabilityMode === undefined
      ? {}
      : { activeToolNames: request.capabilityMode === "tool-free" ? [] : ["read"] }),
    ...(request.model !== undefined ? { model: request.model, executedModel: request.model } : {}),
    ...(request.modelRole !== undefined ? { executedModel: `resolved/${request.modelRole}` } : {}),
  };
}

const BASE = {
  mode: "agent",
  members: [
    { label: "alpha", model: "test/alpha" },
    { label: "beta", model: "test/beta" },
  ],
  judge: { label: "synthesizer", model: "test/judge" },
} as const;

describe("dsl.fusion", () => {
  it.each([
    // A panel needs two independent answers to be a panel. It has no upper member
    // count: an eleventh opinion is a spend decision, bounded by the run's own budget.
    ["too few members", { ...BASE, members: [BASE.members[0]] }, /requires at least 2 members/u],
    [
      "selectorless member",
      { ...BASE, members: [{ label: "none" }, BASE.members[1]] },
      /exactly one non-empty model or modelRole/u,
    ],
    [
      "duplicate members",
      { ...BASE, members: [BASE.members[0], { label: "copy", model: "test/alpha" }] },
      /duplicates declared selector/u,
    ],
    ["member as judge", { ...BASE, judge: { model: "test/alpha" } }, /judge duplicates declared member/u],
    ["missing role lens", { ...BASE, strategy: "roles" }, /lens must be a non-empty string/u],
    [
      "lens in replicate mode",
      { ...BASE, members: [{ ...BASE.members[0], lens: "extra" }, BASE.members[1]] },
      /lens is allowed only/u,
    ],
    [
      "text in prompt-only mode",
      { ...BASE, context: { mode: "prompt-only", text: "silently discarded" } },
      /context\.text is allowed only/u,
    ],
    ["provider selector used as a role", { ...BASE, judge: { modelRole: "test/judge" } }, /bare role name/u],
    ["role used as a concrete model", { ...BASE, judge: { model: "judge" } }, /provider\/id selector/u],
  ])("refuses %s before spending", async (_name, options, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "fusion-invalid",
      agentRunner: async (request) => {
        calls += 1;
        return success(request, "unused");
      },
    });

    await expect(dsl.fusion("question", options as never)).rejects.toThrow(message as RegExp);
    expect(calls).toBe(0);
  });

  it("preflights the remaining invocation budget, and bounds nothing else", async () => {
    let calls = 0;
    const runner = async (request: WorkflowAgentRequest) => {
      calls += 1;
      return success(request, "unused");
    };
    // A real budget: the run cannot pay for the panel it was asked to convene.
    const budgeted = createWorkflowRuntime({ runId: "fusion-cap", agentRunner: runner, maxTotalAgentInvocations: 2 });
    await expect(budgeted.dsl.fusion("question", BASE)).rejects.toThrow(/only 2 remain/u);
    expect(calls).toBe(0);

    // What used to be refused here and no longer is: a large question, a large provided
    // context, a large output instruction and twenty members. The former ceiling was the
    // product of per-member answer ceilings that no longer exist, and a prompt too large
    // for the selected model is that model's capability answer, not a number invented here.
    const large = createWorkflowRuntime({ runId: "fusion-input", agentRunner: runner });
    await expect(
      large.dsl.fusion("q".repeat(40_000), {
        mode: "agent",
        members: Array.from({ length: 20 }, (_, index) => ({
          label: `m${String(index)}`,
          model: `test/m${String(index)}`,
        })),
        judge: { model: "test/judge" },
        context: { mode: "provided", text: "c".repeat(40_000) },
        output: "o".repeat(40_000),
      }),
    ).resolves.toBe("unused");
    expect(calls).toBe(21);
  });

  it("refuses a removed per-call size option by name", async () => {
    const { dsl } = createWorkflowRuntime({
      runId: "fusion-removed-option",
      agentRunner: async () => {
        throw new Error("must not run");
      },
    });
    await expect(
      dsl.fusion("question", { ...BASE, memberLimits: { maxAnswerChars: 12_000 } } as never),
    ).rejects.toThrow(/fusion memberLimits: agent maxAnswerChars was removed/u);
  });

  it("reserves the complete invocation budget across overlapping Fusion calls", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "fusion-reservation",
      maxTotalAgentInvocations: 5,
      agentRunner: async (request) => {
        requests.push(request);
        if (request.model !== "test/judge") await new Promise((resolve) => setTimeout(resolve, 10));
        return success(request, request.model === "test/judge" ? "final" : "candidate");
      },
    });

    const first = dsl.fusion("first", BASE);
    const second = dsl.fusion("second", {
      mode: "agent",
      members: [
        { label: "gamma", model: "test/gamma" },
        { label: "delta", model: "test/delta" },
      ],
      judge: { model: "test/other-judge" },
    });
    const results = await Promise.allSettled([first, second]);

    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(requests.map(({ model }) => model).sort()).toEqual(["test/alpha", "test/beta", "test/judge"]);
  });

  it("runs host selector preflight for every leg before spending", async () => {
    let calls = 0;
    const preflighted: string[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "fusion-model-preflight",
      preflightAgentRequests: async (requests) => {
        preflighted.push(...requests.map(({ model, modelRole }) => model ?? `role:${modelRole}`));
        throw new Error("judge model is unavailable on this host");
      },
      agentRunner: async (request) => {
        calls += 1;
        return success(request, "unused");
      },
    });

    await expect(dsl.fusion("question", BASE)).rejects.toThrow(/judge model is unavailable/u);
    expect(preflighted).toEqual(["test/alpha", "test/beta", "test/judge"]);
    expect(calls).toBe(0);
  });

  it("is callable from a real workflow script through the public runner", async () => {
    const root = temporaryRoot("workflow-fusion-script-");
    const agentsDir = path.join(root, ".agents", "agents");
    const workflowsDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "default.md"),
      "---\nname: default\ndescription: Fusion test agent\nreadOnly: true\nevidence:\n  mode: none\n---\nAnswer the task.\n",
      "utf8",
    );
    const scriptPath = path.join(workflowsDir, "fusion-proof.workflow.mjs");
    writeFileSync(
      scriptPath,
      `export const meta = { name: "fusion-proof", description: "Exercise the public Fusion primitive." };
export default async function runWorkflow(dsl, input) {
  return await dsl.fusion(String(input ?? ""), {
    mode: "agent",
    members: [
      { label: "evidence", model: "test/evidence" },
      { label: "risk", model: "test/risk" },
    ],
    judge: { model: "test/judge" },
    output: "Return one direct paragraph.",
  });
}
`,
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "fusion-script" });
    const executed: string[] = [];
    const resolved: string[] = [];
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath,
      input: "Which migration is safer?",
      resolveModel: (selector) => {
        resolved.push(selector);
        const [provider, id] = selector.split("/");
        return { ok: true, selector, provider: provider!, id: id!, model: { provider, id } as never };
      },
      createExecutor: ({ model }): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          const id = (model as { id?: string } | undefined)?.id ?? "unknown";
          executed.push(id);
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: id === "judge" ? "Use the reversible migration." : `${id} evidence`,
            executedModel: `test/${id}`,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBe("Use the reversible migration.");
    expect(resolved.slice(0, 3)).toEqual(["test/evidence", "test/risk", "test/judge"]);
    expect(executed.slice(0, 2).sort()).toEqual(["evidence", "risk"]);
    expect(executed[2]).toBe("judge");
    expect(result.artifactRefs?.map(({ name }) => name)).toContain("fusion-0001-packet.md");
    expect(result.journal.filter((line) => line.kind === "agent_end").map((line) => line.answerArtifact?.name)).toEqual(
      expect.arrayContaining([
        "fusion-0001-member-01-evidence.md",
        "fusion-0001-member-02-risk.md",
        "fusion-0001-result.md",
      ]),
    );

    const toolFreeScriptPath = path.join(workflowsDir, "fusion-tool-free.workflow.mjs");
    writeFileSync(
      toolFreeScriptPath,
      `export const meta = { name: "fusion-tool-free", description: "Exercise tool-free Fusion through the public runner." };
export default async function runWorkflow(dsl) {
  return await dsl.fusion("question", {
    mode: "tool-free",
    members: [
      { label: "evidence", model: "test/evidence" },
      { label: "risk", model: "test/risk" },
    ],
    judge: { model: "test/judge" },
  });
}
`,
      "utf8",
    );
    let toolFreeExecutions = 0;
    const toolFreeResult = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: toolFreeScriptPath,
      resolveModel: (selector) => {
        const [provider, id] = selector.split("/");
        return { ok: true, selector, provider: provider!, id: id!, model: { provider, id } as never };
      },
      createExecutor: ({ model }): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          expect(request).toMatchObject({ capabilityMode: "tool-free", allowedTools: [] });
          toolFreeExecutions += 1;
          const id = (model as { id?: string } | undefined)?.id ?? "unknown";
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: id === "judge" ? "Tool-free judge answer." : `${id} evidence`,
            activeToolNames: [],
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    expect(toolFreeResult).toMatchObject({ ok: true, result: "Tool-free judge answer." });
    expect(toolFreeExecutions).toBe(3);

    const invalidScriptPath = path.join(workflowsDir, "fusion-invalid-model.workflow.mjs");
    writeFileSync(
      invalidScriptPath,
      `export const meta = { name: "fusion-invalid-model", description: "Reject an unavailable judge before spend." };
export default async function runWorkflow(dsl) {
  return await dsl.fusion("question", {
    mode: "agent",
    members: [
      { label: "evidence", model: "test/evidence" },
      { label: "risk", model: "test/risk" },
    ],
    judge: { model: "test/unavailable" },
  });
}
`,
      "utf8",
    );
    let invalidExecutions = 0;
    const invalidResult = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: invalidScriptPath,
      resolveModel: (selector) => {
        if (selector === "test/unavailable") {
          return {
            ok: false,
            selector,
            reason: "unknown-model",
            message: "the model is not configured on this host",
          };
        }
        const [provider, id] = selector.split("/");
        return { ok: true, selector, provider: provider!, id: id!, model: { provider, id } as never };
      },
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          invalidExecutions += 1;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "unexpected",
            text: "unexpected",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.error).toContain("the model is not configured on this host");
    expect(invalidExecutions).toBe(0);

    const invalidAgentScriptPath = path.join(workflowsDir, "fusion-invalid-agent.workflow.mjs");
    writeFileSync(
      invalidAgentScriptPath,
      `export const meta = { name: "fusion-invalid-agent", description: "Reject an unavailable catalog agent before spend." };
export default async function runWorkflow(dsl) {
  return await dsl.fusion("question", {
    mode: "tool-free",
    members: [
      { agent: "missing-agent", label: "evidence", model: "test/evidence" },
      { label: "risk", model: "test/risk" },
    ],
    judge: { model: "test/judge" },
  });
}
`,
      "utf8",
    );
    let invalidAgentExecutions = 0;
    const invalidAgentResult = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: invalidAgentScriptPath,
      resolveModel: (selector) => {
        const [provider, id] = selector.split("/");
        return { ok: true, selector, provider: provider!, id: id!, model: { provider, id } as never };
      },
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          invalidAgentExecutions += 1;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "unexpected",
            text: "unexpected",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    expect(invalidAgentResult.ok).toBe(false);
    expect(invalidAgentResult.error).toContain("Unknown agent: missing-agent");
    expect(invalidAgentExecutions).toBe(0);

    const invalidModeScriptPath = path.join(workflowsDir, "fusion-invalid-mode.workflow.mjs");
    writeFileSync(
      invalidModeScriptPath,
      `export const meta = { name: "fusion-invalid-mode", description: "Reject an invalid Fusion mode before spend." };
export default async function runWorkflow(dsl) {
  return await dsl.fusion("question", {
    mode: "mixed",
    members: [
      { label: "evidence", model: "test/evidence" },
      { label: "risk", model: "test/risk" },
    ],
    judge: { model: "test/judge" },
  });
}
`,
      "utf8",
    );
    let invalidModeExecutions = 0;
    const invalidModeResult = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: invalidModeScriptPath,
      resolveModel: (selector) => {
        const [provider, id] = selector.split("/");
        return { ok: true, selector, provider: provider!, id: id!, model: { provider, id } as never };
      },
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          invalidModeExecutions += 1;
          return {
            status: "completed",
            agentName: request.agent?.name ?? "sub-agent",
            reason: "unexpected",
            text: "unexpected",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    expect(invalidModeResult.ok).toBe(false);
    expect(invalidModeResult.error).toContain('fusion mode must be "tool-free" or "agent"');
    expect(invalidModeExecutions).toBe(0);
  });
});
