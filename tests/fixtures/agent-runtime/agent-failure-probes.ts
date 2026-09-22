/**
 * Shared substrate for the agent-failure-cause family.
 *
 * One copy of the host fakes, the bridge project, the scripted runtime and the retry
 * probe, so the self-contained cause matrix
 * (`tests/extensions/workflows/runtime/workflow-agent-failure-causes.test.ts`), the
 * shared-host cases (`tests/shared/agent-runtime/agent-failure-cause-host.test.ts`)
 * and the transport suite all drive the SAME fakes. Two copies would let one suite
 * drift into proving something the others no longer prove.
 *
 * Everything here is insurance, not proof: the SDK boundary and the child are faked,
 * while `createAgentSdkSessionExecutor`, the bridge, the runtime and the journal
 * codec on the other side of them are the real ones.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { AgentFailureCause, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createAgentSdkSessionExecutor,
  type CreateAgentSessionFactory,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentDefinition } from "../../../extensions/_shared/agent-runtime/agents.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReturnController,
  normalizeWorkflowReturnContract,
} from "../../../extensions/workflows/runtime/workflow-return.js";

// ---------------------------------------------------------------------------
// Host-level fakes (the same insurance-not-proof shape as agent-sdk-host.test.ts)
// ---------------------------------------------------------------------------

export const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "search", "yield"],
  tools: ["read", "search", "yield"],
  risk: "medium",
  readOnly: true,
  source: "project",
  filePath: "/repo/.agents/agents/reviewer.md",
};

export function hostRequest(): AgentRunRequest {
  return {
    executionMode: "named",
    agent: reviewer,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: ["read", "search", "yield"],
    approvalTier: "allow",
  };
}

export interface FakeSessionConfig {
  lastAssistantText: string | undefined;
  toolCalls?: number;
  toolResults?: number;
  /** prompt() resolves but the terminal turn event never fires: only the fuse ends the turn. */
  neverEnds?: boolean;
  /** prompt() rejects, which lands in the catch around the whole turn. */
  promptError?: string;
  messages?: readonly unknown[];
  events?: SdkAgentSessionEventLike[];
}

export function fakeSession(config: FakeSessionConfig): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-transport-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  return {
    sessionId: "sdk-child",
    ...(config.messages !== undefined ? { messages: config.messages } : {}),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      if (config.promptError !== undefined) throw new Error(config.promptError);
      for (const event of config.events ?? []) listener?.(event);
      if (config.neverEnds !== true) listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "sdk-child", toolCalls: config.toolCalls ?? 0, toolResults: config.toolResults ?? 0 };
    },
    getLastAssistantText() {
      return config.lastAssistantText;
    },
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose: vi.fn(),
    abort: vi.fn(async () => {}),
  };
}

export function tmpReportsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "locus-transport-reports-"));
}

export async function runHost(
  config: FakeSessionConfig,
  options: { childTimeoutMs?: number; maxToolCalls?: number; aborted?: boolean; reportsDir?: string } = {},
) {
  const session = fakeSession(config);
  const createSession: CreateAgentSessionFactory = async () => ({ session });
  const executor = createAgentSdkSessionExecutor({
    createSession,
    reportsDir: options.reportsDir ?? tmpReportsDir(),
    now: () => "fixed",
    ...(options.childTimeoutMs !== undefined ? { childTimeoutMs: options.childTimeoutMs } : {}),
    ...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
  });
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  return await executor.run(hostRequest(), controller.signal);
}

// ---------------------------------------------------------------------------
// Bridge-level project (a real catalog, a fake child)
// ---------------------------------------------------------------------------

export function bridgeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-transport-bridge-"));
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Transport test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

// ---------------------------------------------------------------------------
// Runtime-level scripting and the retry probe
// ---------------------------------------------------------------------------

/** One runtime over a scripted agent runner, with the results it actually served. */
export function runtimeOver(runId: string, results: WorkflowAgentResult[]) {
  const seen: WorkflowAgentResult[] = [];
  let index = 0;
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (): Promise<WorkflowAgentResult> => {
      const next = results[Math.min(index, results.length - 1)]!;
      index += 1;
      seen.push(next);
      return next;
    },
  });
  return { ...runtime, seen };
}

export function completed(text: string): WorkflowAgentResult {
  return { ok: true, status: "completed", summary: "done", text, diagnostics: [], agent: "default" };
}

/** Drive a runtime over a scripted sequence of results and count the child calls. */
export function scriptedRuntime(runId: string, results: WorkflowAgentResult[], extra: Record<string, unknown> = {}) {
  const requests: Array<{ prompt: string; callId?: string; tools?: string[] }> = [];
  let index = 0;
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push({
        prompt: request.prompt,
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
      });
      const next = results[Math.min(index, results.length - 1)]!;
      index += 1;
      return next;
    },
    ...extra,
  });
  return { ...runtime, requests };
}

let retryProbes = 0;

/**
 * Does the RUNTIME re-ask on this cause?
 *
 * Asked through the public DSL, never through a classifier helper: the retry policy is a
 * BEHAVIOUR of the package, and an exported predicate a test can pin is not the same thing —
 * it can keep answering correctly while the loop that was supposed to consult it stops
 * doing so. Two children means the cause is in the transport class; one means it is not.
 */
export async function retriesOn(cause: AgentFailureCause | undefined): Promise<boolean> {
  retryProbes += 1;
  const failure: WorkflowAgentResult = {
    ok: false,
    status: "failed",
    summary: "scripted failure for the retry probe",
    diagnostics: [],
    agent: "default",
    ...(cause === undefined ? {} : { failureCause: cause }),
  };
  const { dsl, requests } = scriptedRuntime(`retry-probe-${String(retryProbes)}`, [failure, completed("second")]);
  await dsl.agent("work", { attempts: 2 }).catch(() => undefined);
  return requests.length > 1;
}

// ---------------------------------------------------------------------------
// Same-session output acceptance, driven by the REAL return controller
// ---------------------------------------------------------------------------

/**
 * One real return controller per call: the output-contract causes are produced by the
 * production acceptance object, not by a stub that merely names them.
 */
export async function runAcceptanceHost(config: {
  submissions?: (readonly unknown[])[];
  maxAttempts?: number;
  maxTurns?: number;
  workTurns?: number[];
  withRestriction?: boolean;
}) {
  const contract = normalizeWorkflowReturnContract({
    output: { type: "string", singleLine: true },
    repair: { maxAttempts: config.maxAttempts ?? 1 },
  });
  const { tool, acceptance } = createWorkflowReturnController(contract);
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-transport-acceptance-"));
  let active = ["read", tool.name];
  let prompts = 0;
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  const session: SdkAgentSessionLike = {
    sessionId: "sdk-child",
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      const submission = config.submissions?.[prompts];
      prompts += 1;
      for (let i = 0; i < (config.workTurns?.[prompts - 1] ?? 1); i += 1) listener?.({ type: "turn_start" });
      if (submission !== undefined) {
        listener?.({ type: "tool_execution_start", toolName: tool.name, toolCallId: `t${prompts}` });
        for (const value of submission) {
          await tool.execute(`t${prompts}`, { value }, new AbortController().signal);
        }
      }
      listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats: () => ({ sessionId: "sdk-child", toolCalls: prompts, toolResults: prompts }),
    getLastAssistantText: () => "narrative the host must not accept",
    getActiveToolNames: () => active,
    ...(config.withRestriction === false
      ? {}
      : {
          setActiveToolsByName(names: string[]) {
            active = [...names];
          },
        }),
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, `${JSON.stringify({ type: "session", id: "sdk-child" })}\n`, "utf8");
      return target;
    },
    dispose: vi.fn(),
    abort: vi.fn(async () => {}),
  };
  const executor = createAgentSdkSessionExecutor({
    createSession: async () => ({ session }),
    reportsDir: tmpReportsDir(),
    now: () => "fixed",
  });
  const result = await executor.run(
    {
      ...hostRequest(),
      ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
      customTools: [tool],
      responseAcceptance: acceptance,
    },
    new AbortController().signal,
  );
  return { result, prompts: () => prompts };
}
