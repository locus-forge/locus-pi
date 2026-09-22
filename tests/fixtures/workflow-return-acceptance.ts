import type { AgentOutputAcceptance, AgentRunRequest } from "../../extensions/_shared/agent-runtime/agent-runner.js";

/**
 * One shaped answer, reused by every suite that needs a non-trivial `workflow_return`
 * contract: an author-declared object with a closed property set, and a record that
 * satisfies it. Kept in one place so a repair case and a replay case argue about the
 * SAME schema rather than two look-alikes.
 */
export const SHAPED_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary"],
  properties: {
    decision: { type: "string", enum: ["complete", "needs-work", "unknown"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

/** The value that satisfies `SHAPED_RESULT_SCHEMA`. */
export const SHAPED_RESULT_RECORD = { decision: "complete", summary: "ok" };

/**
 * Minimal stand-in for the SDK host's same-session acceptance loop, for tests that
 * supply their own `AgentExecutor` and therefore never reach `agent-sdk-host.ts`.
 *
 * Since the text transport was deleted, a shaped call is carried ONLY by a
 * `workflow_return` receipt: a fake executor that just returns final text now
 * reproduces a transport that cannot carry shaped results, and the runtime correctly
 * refuses it. This helper makes such an executor behave like a host that CAN — it
 * submits the scripted answer through the real tool and reports the real receipt, so
 * the acceptance contract under test is the production one rather than a mock of it.
 *
 * Returns `undefined` for a call with no shaped contract; the caller then answers with
 * plain text exactly as before.
 */
export function acceptWorkflowReturn(
  request: AgentRunRequest,
  /** The child's submission, as canonical JSON text (what the scripted answer produces). */
  submission: string,
): { text: string; outputAcceptance: AgentOutputAcceptance } | undefined {
  const acceptance = request.responseAcceptance;
  const tool = request.customTools?.find((candidate) => candidate.name === "workflow_return");
  if (acceptance === undefined || tool === undefined) return undefined;
  acceptance.bindToolRestriction(() => {});
  let value: unknown;
  try {
    value = JSON.parse(submission);
  } catch {
    // A submission that is not JSON is a child that never produced a value; let the
    // acceptance loop report that rather than inventing one here.
    value = submission;
  }
  tool.execute("tool-call-1", { value }, new AbortController().signal);
  const decision = acceptance.inspect();
  if (decision.status !== "accepted") return undefined;
  return {
    text: decision.text,
    outputAcceptance: { source: "tool", attempts: decision.attempts, toolName: "workflow_return" },
  };
}
