/** Direct, package-owned Fusion execution with ordinary Workflow evidence. */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory, isOneShotHostMode } from "../../_shared/host/pi-api.js";
import type { WorkflowAgentBridgeOptions } from "../runtime/workflow-agent-bridge.js";
import { createWorkflowAgentPreflight, createWorkflowAgentRunner } from "../runtime/workflow-agent-bridge.js";
import { workflowArtifactRef } from "../runtime/workflow-artifact-format.js";
import { createWorkflowArtifactStore, type WorkflowArtifactRef } from "../runtime/workflow-artifacts.js";
import {
  formatWorkflowBudgetPrelude,
  resolveWorkflowBudget,
  workflowBudgetEnvelope,
} from "../runtime/workflow-budget.js";
import { claimNewWorkflowRun } from "../runtime/workflow-journal.js";
import {
  acquireWorkflowRootLease,
  releaseWorkflowRootLease,
  resolveWorkflowOutputDirectory,
} from "../runtime/workflow-output.js";
import { writeWorkflowRunReport } from "../runtime/workflow-run-report.js";
import {
  prepareWorkflowResult,
  workflowDispositionForCompletion,
  workflowResultFile,
  workflowResultText,
  writeWorkflowResultJson,
  writeWorkflowResultText,
  type WorkflowDisposition,
  type WorkflowResultPersistence,
} from "../runtime/workflow-result.js";
import {
  type WorkflowFusionContext,
  type WorkflowFusionJudge,
  type WorkflowFusionMember,
  type WorkflowFusionMode,
} from "../runtime/workflow-fusion.js";
import { createWorkflowRuntime, type WorkflowJournalLine } from "../runtime/workflow-runtime.js";

export interface DirectFusionRunOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  question: string;
  mode: WorkflowFusionMode;
  members: readonly WorkflowFusionMember[];
  judge: WorkflowFusionJudge;
  context?: WorkflowFusionContext;
  output?: string;
  onEvent?: (line: WorkflowJournalLine) => void;
  createExecutor?: WorkflowAgentBridgeOptions["createExecutor"];
}

export interface DirectFusionRunResult {
  runId: string;
  runDir: string;
  workspaceDir: string;
  ok: boolean;
  disposition: WorkflowDisposition;
  result?: string;
  error?: string;
  journal: WorkflowJournalLine[];
  resultPersistence: WorkflowResultPersistence;
  resultTextPath?: string;
  primaryOutputPath?: string;
  artifactRefs?: WorkflowArtifactRef[];
}

export async function runDirectFusion(options: DirectFusionRunOptions): Promise<DirectFusionRunResult> {
  const budget = resolveWorkflowBudget(undefined, isOneShotHostMode(options.ctx)).budget;
  const projectRoot = getProjectRoot(options.ctx);
  const workingDirectory = getWorkingDirectory(options.ctx);
  const {
    runId,
    runDir,
    journal: journalSink,
    firstLine: prelude,
  } = claimNewWorkflowRun(projectRoot, (mintedRunId) => ({
    ts: new Date().toISOString(),
    runId: mintedRunId,
    kind: "log",
    source: "runtime",
    message: formatWorkflowBudgetPrelude(budget),
  }));
  options.onEvent?.(prelude);

  const workspace = resolveWorkflowOutputDirectory(projectRoot, undefined, "fusion", workingDirectory, { runId });
  const artifactStore = createWorkflowArtifactStore({ projectRoot, runId, runDir });
  const bridgeOptions: WorkflowAgentBridgeOptions = {
    pi: options.pi,
    ctx: options.ctx,
    signal: options.signal,
    workflowRunId: runId,
    workflowRunDir: runDir,
    workflowWorkspaceDir: workspace.absolutePath,
    evidenceDestinations: (callId) => artifactStore.childEvidenceDestinations(callId),
    ...(options.createExecutor === undefined ? {} : { createExecutor: options.createExecutor }),
  };
  const runtime = createWorkflowRuntime({
    runId,
    projectRoot,
    outputDir: workspace.relativePath,
    agentRunner: createWorkflowAgentRunner(bridgeOptions),
    preflightAgentRequests: createWorkflowAgentPreflight(bridgeOptions),
    artifactPorts: artifactStore,
    journal: journalSink,
    maxConcurrentAgents: budget.concurrency,
    ...(budget.totalAgents === undefined ? {} : { maxTotalAgentInvocations: budget.totalAgents }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  const workspaceLease = acquireWorkflowRootLease({ projectRoot, output: workspace, rootRunId: runId });

  let answer: string | undefined;
  let error: string | undefined;
  const failureLines: WorkflowJournalLine[] = [];
  try {
    answer = await runtime.dsl.fusion(options.question, {
      mode: options.mode,
      members: options.members,
      judge: options.judge,
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.output === undefined ? {} : { output: options.output }),
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    const failureLine: WorkflowJournalLine = {
      ts: new Date().toISOString(),
      runId,
      kind: "error",
      source: "runtime",
      message: error,
    };
    journalSink.write(failureLine);
    options.onEvent?.(failureLine);
    failureLines.push(failureLine);
  } finally {
    try {
      releaseWorkflowRootLease(workspaceLease);
    } catch (cause) {
      const releaseMessage = `Fusion workflow workspace lease release failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      error ??= releaseMessage;
      const line: WorkflowJournalLine = {
        ts: new Date().toISOString(),
        runId,
        kind: "error",
        source: "runtime",
        message: releaseMessage,
      };
      journalSink.write(line);
      options.onEvent?.(line);
      failureLines.push(line);
    }
  }

  const prepared = prepareWorkflowResult(answer).value;
  let finalError = error;
  let finalOk = error === undefined && !options.signal.aborted;
  let disposition = workflowDispositionForCompletion({
    ok: finalOk,
    aborted: options.signal.aborted,
    ...(options.signal.aborted ? { abortReason: options.signal.reason } : {}),
  });
  const journal = [prelude, ...runtime.getJournal(), ...failureLines];
  const resultTextPath = finalOk ? writeWorkflowResultText(runDir, prepared) : undefined;
  if (finalOk && workflowResultText(prepared) !== undefined && resultTextPath === undefined) {
    finalError = `Fusion terminal output was not persisted under ${path.join(runDir, "outputs")}.`;
    finalOk = false;
    disposition = { status: "failed" };
    const line: WorkflowJournalLine = {
      ts: new Date().toISOString(),
      runId,
      kind: "error",
      source: "runtime",
      message: finalError,
    };
    journalSink.write(line);
    options.onEvent?.(line);
    journal.push(line);
  }
  const report = writeWorkflowRunReport(
    {
      projectRoot,
      runId,
      runDir,
      workspaceDir: workspace.absolutePath,
      status: disposition.status,
      result: prepared,
      ...(finalError === undefined ? {} : { error: finalError }),
      journal,
      budget: { applied: budget, peakConcurrency: runtime.peakAgentConcurrency() },
    },
    artifactStore,
  );
  if (!report.ok) {
    const line: WorkflowJournalLine = {
      ts: new Date().toISOString(),
      runId,
      kind: "error",
      source: "runtime",
      message: `Fusion run report was not written: ${report.message}`,
    };
    journalSink.write(line);
    options.onEvent?.(line);
    journal.push(line);
  }
  const artifactRefs = artifactStore
    .list()
    .filter((record) => record.kind === "answer" || record.kind === "published" || record.kind === "primary")
    .slice(-20)
    .map((record) => workflowArtifactRef(record));
  const intendedPersistence: WorkflowResultPersistence = { ok: true, path: workflowResultFile(runDir) };
  const resultPersistence = writeWorkflowResultJson(runDir, {
    runId,
    ok: finalOk,
    disposition,
    result: prepared,
    workspaceDir: workspace.absolutePath,
    workspaceDirRelative: workspace.relativePath,
    ...(finalError === undefined ? {} : { error: finalError }),
    journal,
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    resultPersistence: intendedPersistence,
    budget: workflowBudgetEnvelope(budget),
  });
  const persistenceError = resultPersistence.ok ? undefined : resultPersistence.message;
  const returnedError = finalError ?? persistenceError;

  return {
    runId,
    runDir,
    workspaceDir: workspace.absolutePath,
    ok: finalOk && resultPersistence.ok,
    disposition: resultPersistence.ok ? disposition : { status: "failed" },
    ...(answer === undefined ? {} : { result: answer }),
    ...(returnedError === undefined ? {} : { error: returnedError }),
    journal,
    resultPersistence,
    ...(resultTextPath === undefined ? {} : { resultTextPath }),
    ...(report.ok && report.primaryOutputPath !== undefined ? { primaryOutputPath: report.primaryOutputPath } : {}),
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
  };
}
