/**
 * Shared temporary-project setup for the replay/resume test family.
 *
 * Extracted so the replay suite and the resume-authority suite run the SAME
 * scripted child. The child answer is a pure function of the prompt, so a
 * difference between two runs can only come from the replay/resume machinery,
 * never from the fake model.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../extensions/_shared/agent-runtime/agent-runner.js";
import { WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR } from "../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { runWorkflowScript } from "../../extensions/workflows/runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../test-harness.js";
import { acceptWorkflowReturn } from "./workflow-return-acceptance.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../model-roles-fixture.js";

const roots: string[] = [];

/** Register a root a test built itself, so the shared cleanup still removes it. */
export function registerReplayProject(root: string): string {
  roots.push(root);
  return root;
}

/** Remove every project this module created. Call from the suite's `afterEach`. */
export function cleanupReplayProjects(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  restoreGlobalModelRolesHome();
}

export function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-replay-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Replay test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

export function writeWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  ok: boolean;
  result: unknown;
  error?: string;
  replay: NonNullable<Awaited<ReturnType<typeof runWorkflowScript>>["replay"]>;
  /** Prompts that reached a real child. A replayed call never appears here. */
  executedPrompts: string[];
  journal: WorkflowJournalLine[];
  raw: Awaited<ReturnType<typeof runWorkflowScript>>;
}

/** The workflow's own prompt, without the run working-directory note the bridge prepends. */
export function workflowPrompt(task: string): string {
  const at = task.indexOf(WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR);
  return at === -1 ? task : task.slice(at + WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR.length);
}

/** What a scripted child passes to `workflow_return` for a shaped call. */
function scriptedSubmission(prompt: string, answer: string): string {
  try {
    JSON.parse(answer);
    return answer;
  } catch {
    // not canonical JSON; fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(prompt)?.[1]?.trim();
  if (fenced !== undefined) {
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // not canonical JSON; fall through
    }
  }
  return JSON.stringify(answer);
}

/**
 * Run one saved workflow with a scripted child. The child answer is a pure
 * function of the prompt, so a difference between two runs can only come from
 * the replay machinery, never from the fake model.
 */
export async function runWorkflow(
  root: string,
  name: string,
  options: {
    input?: string;
    resumeFromRunId?: string;
    outputDir?: string;
    roles?: Record<string, string>;
    /** Exact work units for `dsl.items()`, separate from semantic input. */
    items?: readonly string[];
    /** Override the scripted child's answer for a prompt; may throw to fail that child. */
    answer?: (prompt: string) => string;
  } = {},
): Promise<RunOutcome> {
  process.env.PI_MODEL_ROLES_HOME = path.join(root, ".pi-user");
  const harness = createHarness(root, { sessionId: `replay-${name}` });
  if (options.roles !== undefined) writeGlobalModelRoles(root, options.roles);
  const executedPrompts: string[] = [];
  const createExecutor = (): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      // The bridge prepends this run's working-directory note, whose path carries
      // the run id. The scripted child answers on the workflow's own prompt so a
      // recorded answer stays comparable across runs.
      const prompt = workflowPrompt(request.task);
      executedPrompts.push(prompt);
      const text = options.answer === undefined ? `answer(${prompt})` : options.answer(prompt);
      // A shaped call is carried by a workflow_return receipt, never by parsed final
      // text, so a scripted child SUBMITS through the real acceptance tool. The value it
      // submits is the scripted answer when that is already canonical JSON, otherwise the
      // JSON the prompt asked for, otherwise the answer as a JSON string — the same three
      // intentions the fixtures expressed before, now stated as a tool argument.
      const accepted = acceptWorkflowReturn(request, scriptedSubmission(prompt, text));
      return {
        status: "completed" as const,
        agentName: request.agent?.name ?? "sub-agent",
        reason: "answered",
        ...(accepted === undefined ? { text } : accepted),
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
  const res = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name,
    createExecutor,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.items !== undefined ? { items: options.items } : {}),
    ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
    ...(options.resumeFromRunId !== undefined ? { resumeFromRunId: options.resumeFromRunId } : {}),
  });
  expect(res.replay, "every run that reached its script identity reports a replay envelope").toBeDefined();
  return {
    runId: res.runId,
    runDir: res.runDir,
    ok: res.ok,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    replay: res.replay!,
    executedPrompts,
    journal: res.journal,
    raw: res,
  };
}

export const THREE_STAGE_WORKFLOW = `export const meta = { name: "stages", description: "three sequential stages" };
export default async function runWorkflow(dsl, input) {
  const one = await dsl.agent("stage-1");
  const two = await dsl.agent("stage-2 " + String(input ?? ""));
  const three = await dsl.agent("stage-3");
  return { summary: [one, two, three].join(" | ") };
}
`;
