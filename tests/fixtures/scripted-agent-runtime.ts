/** Scripted child answers, and the throwaway run directory a scripted runtime writes into. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * Build a runtime whose child answers come from a scripted list; records every request.
 *
 * The host it stands in for is one that CAN carry a shaped result: for a request that
 * declares a return contract it reports the `workflow_return` tool receipt the runtime
 * requires, so acceptance under test is the production receipt path rather than text
 * parsing. A request with no contract is answered with the scripted text and nothing else.
 *
 * Answers are consumed in order; once the list runs out the LAST answer repeats, so a
 * suite that scripts one answer for a call that may be attempted twice needs no padding.
 */
export function scriptedRuntime(runId: string, answers: string[]) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      const text = answers[requests.length - 1] ?? answers.at(-1) ?? "";
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
      };
    },
  });
  return { ...runtime, requests };
}

/**
 * The success envelope one scripted child reports for one request.
 *
 * Separate from `scriptedRuntime` because several runtime contract suites build their own
 * `agentRunner` — counting side effects, asserting on the request, answering by label — and
 * need only the result shape to be the production one.
 */
export const completed = (request: WorkflowAgentRequest, text: string): WorkflowAgentResult => ({
  ok: true,
  status: "completed",
  summary: "done",
  text,
  diagnostics: [],
  ...(request.executionMode === undefined ? {} : { executionMode: request.executionMode }),
});

/** The run directory a runtime, journal sink or replay controller expects under a project root. */
export function tempRun(root: string, id: string): string {
  const dir = path.join(root, ".locus-pi", "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run `run` against a throwaway project root, remove it afterwards, and return its value. */
export async function temporaryValue<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-contract-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `temporaryValue` for a body that asserts rather than returns. */
export async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  await temporaryValue(run);
}
