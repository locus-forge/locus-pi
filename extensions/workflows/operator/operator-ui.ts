/**
 * extensions/workflows/operator/operator-ui.ts — Pure operator presentation for the
 * workflows extension.
 *
 * Holds the `OperatorBlock` builders that need no Pi handle, no
 * `ExtensionContext` and no disk access, plus the line/tone formatters those
 * blocks and the disk-backed evidence blocks share. Nothing here performs I/O:
 * a caller supplies the values, this module decides how they read.
 */

import path from "node:path";
import type { OperatorBlock, OperatorTone } from "../../_shared/operator/operator-ui.js";
import { formatWorkflowFailureDiagnosticLines } from "../runtime/workflow-failure.js";
import type { WorkflowRunStatus } from "../runtime/workflow-journal.js";
import {
  projectWorkflowDisposition,
  type WorkflowDispositionProjection,
  type WorkflowProjectedStatus,
} from "../runtime/workflow-outcome.js";
import { packagedWorkflowNames } from "../runtime/workflow-discovery.js";
import type { RunWorkflowScriptResult } from "../runtime/workflow-runner.js";
import type { WorkflowBackgroundStopResult } from "../run/background-run-registry.js";
import { workflowRunUsage } from "../command/command-parser.js";
import { WORKFLOW_SOURCE_LEGEND, workflowSourceBadge } from "../catalog/workflow-catalog.js";
import { compactOperatorLine } from "../../_shared/operator/operator-ui.js";
import { copyDestinationLabel, type WorkflowCopyResult } from "../catalog/workflow-copy.js";

/** Package names shared with resolution and catalog enumeration, scanned per call. */
export function listExampleNames(): string[] {
  return packagedWorkflowNames();
}

export function workflowHelpBlock(): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Workflow commands",
    primary: "Choose a workflow command directly; the interactive menu is available in a Pi TUI.",
    body: [
      "Dashboard: /workflows dashboard",
      "Catalog: /workflows list [query]",
      "Info: /workflows info [exact-name]",
      "History: /workflows status [runId]",
      "Result: /workflows result [runId|last]",
      `Run: ${workflowRunUsage()}`,
      "Continue: /workflows continue <runId> [--answer <text>]",
      "Stop: /workflows stop [runId|last]",
      "External agent skills: /workflows skills <sync|status|remove> [--host codex|claude|all] [--scope user|project]",
    ],
    metadata: [
      "Emergency compatibility alias: /workflow-stop. Use /workflows <subcommand> for every other operation.",
      "A command starts execution only when the Pi session is provably idle.",
    ],
  };
}

export function workflowUnknownCommandBlock(text: string, available: string[]): OperatorBlock {
  return {
    type: "WARN",
    subject: "Workflow command",
    primary: `Unknown workflow command: ${text}`,
    body: available.length === 0 ? [] : [`Available curated Package workflows: ${available.join(", ")}`],
    controls: [
      `Usage: /workflows | dashboard | list [query] | info [name] | status [runId] | result [runId|last] | ${workflowRunUsage("<name|path>", "run")} | continue <runId> [--answer <text>] | stop [runId|last] | skills <sync|status|remove> [--host codex|claude|all] [--scope user|project]`,
    ],
  };
}

export function workflowRunConflictBlock(runId: string): OperatorBlock {
  return {
    type: "WARN",
    subject: "Workflow run",
    primary: `Workflow not started: slash-launched workflow ${runId} is still running or stopping.`,
    metadata: ["Only one slash-launched workflow may run in this project session at a time."],
    controls: [`Inspect: /workflows status ${runId}`, `Stop: /workflows stop ${runId}`],
  };
}

export function workflowStopBlock(selector: string, result: WorkflowBackgroundStopResult): OperatorBlock {
  if (result.status === "unknown") {
    return {
      type: "ERROR",
      subject: "Workflow stop",
      primary: `No active or recorded workflow matched ${selector}.`,
      controls: ["Inspect durable runs: /workflows status", "Stop the current run: /workflows stop last"],
    };
  }
  const runId = result.run.runId ?? result.run.launchId;
  if (result.status === "settled") {
    return {
      type: "WARN",
      subject: "Workflow stop",
      primary: `Workflow ${runId} has already settled; no stop signal was sent.`,
      controls: [`Inspect: /workflows status ${runId}`],
    };
  }
  return {
    type: "VIEW",
    subject: "Workflow stop",
    primary:
      result.status === "requested"
        ? `Stop requested for workflow ${runId}. Settlement is still pending.`
        : `Workflow ${runId} is already stopping. Settlement is still pending.`,
    metadata: ["A stop request is not a completion claim; durable result evidence remains authoritative."],
    controls: [`Inspect: /workflows status ${runId}`],
  };
}

export function workflowBackgroundFailureBlock(error: unknown): OperatorBlock {
  return {
    type: "ERROR",
    subject: "Workflow run",
    primary: `Workflow background runner rejected: ${errorMessage(error)}.`,
    metadata: ["The rejection was observed by the workflow run registry."],
    controls: ["Inspect durable evidence: /workflows status"],
  };
}

export function workflowWarningBlock(primary: string, recovery: string): OperatorBlock {
  return {
    type: "WARN",
    subject: "Workflow run",
    primary,
    metadata: ["No workflow execution was started."],
    controls: [recovery],
  };
}

export function workflowNotFoundBlock(name: string): OperatorBlock {
  const names = listExampleNames();
  const available = names.length > 0 ? names.join(", ") : "(none)";
  return {
    type: "ERROR",
    subject: "Workflow run",
    primary: `Workflow not found: ${name}`,
    body: [`Available curated Package workflows: ${available}`],
    metadata: ["No workflow execution was started."],
    controls: ["Recovery: /workflows list [query]"],
  };
}

export function workflowCopyBlock(result: WorkflowCopyResult): OperatorBlock {
  const destination = copyDestinationLabel(result.destination);
  if (result.status === "exists") {
    return {
      type: "WARN",
      subject: "Workflow copy",
      primary: `${destination} workflow ${JSON.stringify(result.rootName)} already exists. Nothing was copied.`,
      metadata: [`conflict: ${result.conflictPath}`],
      controls: ["Rename or remove the existing namespace manually, then retry from /workflows list."],
    };
  }
  return {
    type: "VIEW",
    subject: "Workflow copy",
    primary: `Copied workflow ${JSON.stringify(result.rootName)} to ${destination}.`,
    metadata: [
      `namespace: ${result.destinationPath}`,
      "The complete root namespace, direct children, and resources were copied without changing the Package source.",
    ],
    controls: ["Reopen /workflows list to inspect the new first-wins source."],
  };
}

/** One wording for a short run id that names more than one run. */
export function ambiguousWorkflowRunBlock(
  selector: string,
  resolved: { matched: number; candidates: string[] },
): OperatorBlock {
  return workflowWarningBlock(
    `Run id ${selector} matches ${resolved.matched} runs.`,
    resolved.matched > resolved.candidates.length
      ? `Retry with a full id; ${resolved.candidates.length} of ${resolved.matched} shown: ${resolved.candidates.join(" · ")}`
      : `Retry with a full id: ${resolved.candidates.join(" · ")}`,
  );
}

// ---------------------------------------------------------------------------
// Rendering — single run final result
// ---------------------------------------------------------------------------

export function buildWorkflowResultBlock(res: RunWorkflowScriptResult, compact = false): OperatorBlock {
  const source = res.target?.source;
  const disposition = workflowResultDisposition(res);
  const primary = `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${disposition.summary}`;
  const type = disposition.status === "completed" ? "RESULT" : disposition.status === "failed" ? "ERROR" : "WARN";
  return {
    type,
    subject: "Workflow run",
    primary: compact ? compactWorkflowLine(primary) : primary,
    badges: [
      { text: `status:${disposition.status}`, tone: workflowStatusTone(disposition.status) },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    metadata: [
      WORKFLOW_SOURCE_LEGEND,
      `runId: ${res.runId}`,
      `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
      compact ? compactWorkflowLine(`runDir: ${res.runDir}`) : `runDir: ${res.runDir}`,
      ...(res.scriptIdentity === undefined
        ? []
        : [
            compact
              ? compactWorkflowLine(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref))
              : formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref),
          ]),
      compact
        ? compactWorkflowLine(`resultPath: ${res.resultPersistence.path}`)
        : `resultPath: ${res.resultPersistence.path}`,
      ...(res.resultPersistence.ok
        ? []
        : [
            compact
              ? compactWorkflowLine(`persistence: ${res.resultPersistence.code}`)
              : `persistence: ${res.resultPersistence.code}`,
          ]),
      // Actionable failure evidence, including the copyable repair request. Kept
      // whole even in compact mode: a clipped path or request cannot be acted on.
      ...(res.failureDiagnostic === undefined
        ? []
        : formatWorkflowFailureDiagnosticLines(res.failureDiagnostic, { repairRequest: true })),
    ],
    controls: [compactWorkflowLine(`Detail: /workflows status ${res.runId}`)],
  };
}

export function compactWorkflowLine(value: string): string {
  return compactOperatorLine(value, 72);
}

export function workflowStatusTone(status: WorkflowRunStatus | WorkflowProjectedStatus): OperatorTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "accent";
    case "awaiting_operator":
    case "cancelled":
      return "warning";
    case "unknown":
      return "muted";
    default:
      return assertNever(status);
  }
}

export function workflowResultDisposition(res: RunWorkflowScriptResult): WorkflowDispositionProjection {
  return projectWorkflowDisposition({
    ok: res.ok,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
  });
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled workflow status: ${String(value)}`);
}

export interface OperatorScriptIdentityInput {
  snapshotPath: string;
  scriptSha256: string;
  identityCoverage?: string;
  executionSource?: string;
  nodeVersion?: string;
  builtinImports?: readonly string[];
  unboundDependencies?: readonly string[];
}

export function formatOperatorScriptIdentity(identity: OperatorScriptIdentityInput, sourceRef?: string): string {
  const source = safeOperatorSourceRef(sourceRef);
  const coverage = identity.identityCoverage ?? "entry-only-legacy";
  const execution = identity.executionSource ?? "source";
  const dependencySummary =
    coverage === "self-contained-static"
      ? `builtins=${identity.builtinImports?.length ?? 0}`
      : coverage === "entry-only-legacy"
        ? "unbound=unknown"
        : `unbound=${identity.unboundDependencies?.length ?? "?"}`;
  const node = identity.nodeVersion === undefined ? "" : ` · node=${identity.nodeVersion}`;
  return `script: ${source} · coverage=${coverage} · exec=${execution} · ${dependencySummary} · snapshot=${path.basename(identity.snapshotPath)} · sha256=${identity.scriptSha256.slice(0, 12)}${node}`;
}

export function safeOperatorSourceRef(sourceRef: string | undefined): string {
  if (sourceRef === undefined || sourceRef === "") return "workflow";
  if (!path.isAbsolute(sourceRef)) return sourceRef;
  return path.basename(sourceRef) || "workflow";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
