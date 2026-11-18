import type { ExtensionContext, ToolResult } from "../../_shared/host/pi-api.js";
import { errorResult } from "../../_shared/host/pi-api.js";
import { readWorkflowResumeWorkspaceIdentity } from "../runtime/workflow-run-resume.js";
import { resolveNamedWorkflowWorkspacePath } from "../runtime/workflow-output.js";
import { WORKFLOW_WORKSPACES_STORAGE_PREFIX } from "../runtime/workflow-run-layout.js";
import { resolveWorkflowBudget, WORKFLOW_BUDGET_AXES } from "../runtime/workflow-budget.js";
import { canonicalWorkflowJSON } from "../runtime/structured-results/schema.js";

export const WORKFLOW_LAUNCH_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const WORKFLOW_INPUT_JSON_PREVIEW_MAX_CHARS = 4096;

/** Current-call visibility only: persisted run/result projections retain identities, not the typed value. */
export function workflowInputJSON(record: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(record, "inputValue")) return undefined;
  const property = Object.getOwnPropertyDescriptor(record, "inputValue");
  if (property === undefined || !("value" in property)) return "<unavailable: inputValue is not a data property>";
  try {
    const canonical = canonicalWorkflowJSON(property.value);
    if (canonical.length <= WORKFLOW_INPUT_JSON_PREVIEW_MAX_CHARS) return canonical;
    const omitted = canonical.length - WORKFLOW_INPUT_JSON_PREVIEW_MAX_CHARS;
    return `${canonical.slice(0, WORKFLOW_INPUT_JSON_PREVIEW_MAX_CHARS)}… (+${omitted} chars)`;
  } catch (error) {
    return `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

export function workflowConfirmationDetails(args: unknown, projectRoot: string): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const target = String(record.name ?? record.scriptPath ?? record.script ?? "unspecified");
  let workspace: string;
  if (typeof record.effectiveWorkspaceDir === "string") {
    workspace = record.effectiveWorkspaceDir;
  } else if (typeof record.workspaceDir === "string") {
    workspace = record.workspaceDir;
  } else if (typeof record.resumeFromRunId === "string") {
    try {
      workspace = readWorkflowResumeWorkspaceIdentity(projectRoot, record.resumeFromRunId).relativePath;
    } catch (error) {
      workspace =
        `recorded source workspace unavailable for run ${record.resumeFromRunId}: ` +
        `${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (typeof record.runName === "string") {
    try {
      workspace = resolveNamedWorkflowWorkspacePath(projectRoot, record.runName);
    } catch (error) {
      workspace = `selection blocked: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    workspace = `${WORKFLOW_WORKSPACES_STORAGE_PREFIX}<generated-run-name>`;
  }
  const declaredBudget =
    record.budget !== null && typeof record.budget === "object"
      ? (record.budget as Parameters<typeof resolveWorkflowBudget>[0])
      : undefined;
  const resolvedBudget = declaredBudget && resolveWorkflowBudget(declaredBudget).budget;
  const inputJSON = workflowInputJSON(record);
  return [
    `Workflow: ${target}`,
    ...(typeof record.sourceLocator === "string" ? [`Source: ${record.sourceLocator}`] : []),
    ...(typeof record.scriptSha256 === "string" ? [`Entry SHA-256: ${record.scriptSha256}`] : []),
    `Items: ${Array.isArray(record.items) ? String(record.items.length) : "none"}`,
    `Workflow workspace: ${workspace}`,
    ...(inputJSON === undefined ? [] : [`Input (JSON): ${inputJSON}`]),
    ...(declaredBudget !== undefined && Object.keys(declaredBudget).length > 0
      ? [
          `Budget overrides: ${WORKFLOW_BUDGET_AXES.filter((axis) => declaredBudget?.[axis] !== undefined)
            .map((axis) => `${axis}=${resolvedBudget?.[axis]}`)
            .join(" ")}; other axes use launch defaults`,
        ]
      : []),
    ...(record.recoverInterrupted === true
      ? ["Recovery: explicit hard-crash recovery of a confirmed serial prefix; no unresolved child effects allowed"]
      : []),
    ...(record.force === true
      ? ["Lease recovery: force only with a complete matching terminal result; active/unverifiable owners stay fenced"]
      : []),
    "Surface: trusted-file workflow runner",
    "Trust: reviewed JavaScript with full Node.js/module access in the Pi host process",
    "Isolation: none — confirmation is consent, not a sandbox",
  ];
}

function cancelledWorkflowLaunch(workflowName: string, reason: "aborted" | "declined" | "timed-out"): ToolResult {
  const explanation =
    reason === "aborted"
      ? "parent tool call was aborted"
      : reason === "timed-out"
        ? "interactive confirmation timed out"
        : "operator declined interactive confirmation";
  return errorResult(`workflow launch cancelled before execution: ${explanation}`, {
    owner: "workflows",
    workflowName,
    status: "cancelled",
    cancellationReason: reason,
    disposition: { status: "cancelled" },
  });
}

/** Return undefined only after a positive confirmation; cancellation settles locally even for a broken adapter. */
export async function confirmWorkflowLaunch(
  ctx: ExtensionContext,
  signal: AbortSignal,
  workflowName: string,
  details: string[],
): Promise<ToolResult | undefined> {
  if (signal.aborted) return cancelledWorkflowLaunch(workflowName, "aborted");
  const timeoutController = new AbortController();
  let onAbort: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new Promise<"aborted" | "timed-out">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      resolve("timed-out");
      timeoutController.abort(new Error("workflow confirmation timed out"));
    }, WORKFLOW_LAUNCH_CONFIRM_TIMEOUT_MS);
  });
  const confirmationSignal = AbortSignal.any([signal, timeoutController.signal]);
  let confirmation: Promise<{ kind: "confirmed" | "declined" } | { kind: "failed"; error: unknown }>;
  try {
    confirmation = Promise.resolve(
      ctx.ui.confirm(`Run trusted workflow ${JSON.stringify(workflowName)}?`, details.join("\n"), {
        signal: confirmationSignal,
        timeout: WORKFLOW_LAUNCH_CONFIRM_TIMEOUT_MS,
      }),
    ).then(
      (confirmed) => ({ kind: confirmed ? ("confirmed" as const) : ("declined" as const) }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  } catch (error) {
    confirmation = Promise.resolve({ kind: "failed", error });
  }
  try {
    const outcome = await Promise.race([confirmation, cancellation.then((kind) => ({ kind }))]);
    if (outcome.kind === "confirmed") return undefined;
    if (outcome.kind === "aborted" || signal.aborted) return cancelledWorkflowLaunch(workflowName, "aborted");
    if (outcome.kind === "timed-out") return cancelledWorkflowLaunch(workflowName, "timed-out");
    if (outcome.kind === "declined") return cancelledWorkflowLaunch(workflowName, "declined");
    if (outcome.kind === "failed") {
      return errorResult(
        `workflow: interactive confirmation could not be opened: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        { owner: "workflows" },
      );
    }
    return errorResult("workflow: interactive confirmation returned an unknown outcome", { owner: "workflows" });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
