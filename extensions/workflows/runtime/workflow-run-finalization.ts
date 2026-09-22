/**
 * workflow-run-finalization.ts — the ONE terminal sequence of a workflow run.
 *
 * Every route out of `runWorkflowScript` — a refused launch, a thrown script, a
 * clean return — funnels through the finalizer built here. The ORDER below is the
 * contract, and each step states its own mandatory/best-effort status in code
 * rather than hiding behind a generic "run these steps and swallow the errors"
 * pipeline:
 *
 *   1. lease fencing check   (mandatory; a stale lease fails the run)
 *   2. workspace evidence    (mandatory; an unreadable manager fails the run)
 *   3. artifact projection   (mandatory; an unreadable index fails the run)
 *   4. operator handoff      (mandatory when declared; a malformed envelope fails the run)
 *   5. disposition           (a controlling abort beats waiting AND success)
 *   6. unbound claim release (mandatory; a leaked claim fails the run)
 *   7. failure diagnostic    (projection of a failed envelope; never a verdict)
 *   8. terminal prose        (mandatory; an unpersisted result fails the run)
 *   9. lease release         (mandatory, EXACTLY ONCE; a failed release fails the run)
 *  10. Markdown report       (BEST EFFORT; recorded in `finalizationErrors`, never a
 *                            change of semantic success)
 *  11. result.json           (mandatory; a failed write fails the RETURNED run and
 *                            re-renders the report from the now-failed envelope so
 *                            the readable surface cannot keep claiming success)
 *
 * Direction: runner → finalization → outcome / result / report / artifacts /
 * handoff / workspace-state / journal-format. This module starts no workflow and
 * never imports the runner; `RunWorkflowScriptResult` keeps its public identity by
 * being re-exported from `workflow-runner.ts`, where every caller already asks for it.
 */
import { appendProjectError } from "../../_shared/host/error-journal.js";

import { workflowArtifactRef } from "./workflow-artifact-format.js";
import type { WorkflowArtifactRef, WorkflowContinuationJournal } from "./workflow-artifacts.js";
import { workflowBudgetEnvelope, type WorkflowBudget } from "./workflow-budget.js";
import type { ResolvedWorkflowTarget } from "./workflow-discovery.js";
import {
  buildWorkflowFailureDiagnostic,
  type BuildWorkflowFailureDiagnosticInput,
  type WorkflowFailureDiagnostic,
  type WorkflowFailureOrigin,
} from "./workflow-failure.js";
import type { WorkflowAwaitOperatorDeclaration } from "./workflow-handoff-contract.js";
import {
  createWorkflowOperatorHandoffEnvelope,
  releaseWorkflowHandoffClaim,
  type WorkflowHandoffClaimLease,
  type WorkflowOperatorHandoffEnvelope,
} from "./workflow-handoff.js";
import type { WorkflowJournalLine, WorkflowJournalSink } from "./workflow-journal-format.js";
import { workflowJournalFile, type WorkflowRunSummary } from "./workflow-journal.js";
import {
  workflowDispositionForCompletion,
  workflowFinalizationError,
  type WorkflowDisposition,
  type WorkflowFinalizationError,
  type WorkflowResultDiagnosticSentinel,
} from "./workflow-outcome.js";
import type { WorkflowPrimaryFileReference } from "./workflow-output.js";
import type { WorkflowReplayEnvelope } from "./workflow-replay.js";
import type { WorkflowResourceEvidence } from "./workflow-resources.js";
import {
  workflowResultFile,
  workflowResultText,
  writeWorkflowResultJson,
  writeWorkflowResultText,
  type WorkflowResultPersistence,
} from "./workflow-result.js";
import {
  workflowReportDir,
  writeWorkflowRunReport,
  type WorkflowRunReportEvidenceSource,
  type WorkflowRunReportInput,
} from "./workflow-run-report.js";
import type { WorkflowChildRunEvidence, WorkflowRunLineage } from "./workflow-saved-child.js";
import type { WorkflowScriptIdentity } from "./workflow-script-identity.js";
import {
  assertWorkflowRootLease,
  releaseWorkflowRootLease,
  type WorkflowRootLease,
} from "./workflow-workspace-state.js";
import type { WorkflowWorkspaceEvidence } from "./workflow-worktree.js";

// ---------------------------------------------------------------------------
// The terminal result
// ---------------------------------------------------------------------------

/**
 * One in-process workflow execution, as the finalizer returns it.
 *
 * Deliberately NOT the tolerant `WorkflowRunResultEnvelope` that
 * `workflow-result.ts` reads back off disk: a live return is complete, a persisted
 * envelope may be legacy or partial, and the two must stay separate types.
 */
export interface RunWorkflowScriptResult {
  runId: string;
  runDir: string;
  storageRootRunId?: string;
  ok: boolean;
  /** Runtime-owned terminal meaning. Optional only for legacy/test envelopes. */
  disposition?: WorkflowDisposition;
  result: unknown; // detached JSON value or explicit diagnostic sentinel
  resultDiagnostic?: WorkflowResultDiagnosticSentinel;
  resultPersistence: WorkflowResultPersistence;
  /** Path of the verbatim text copy of a prose result, when the run produced one. */
  resultTextPath?: string;
  /** Semantic named document whose newest revision equals the terminal prose. */
  primaryOutputPath?: string;
  /** Project-local workflow workspace, distinct from run evidence. */
  workspaceDir?: string;
  workspaceDirRelative?: string;
  /** Canonical physical workspace identity, project-relative and portable. */
  workspacePhysicalIdentity?: string;
  workspacePhysicalIdentitySchemaVersion?: 1;
  /** Whether the caller supplied outputDir instead of accepting the default. */
  workspaceDirExplicit?: boolean;
  /** Exact semantic input identity, persisted for the owner-specific resume contract. */
  semanticInputPresent?: boolean;
  semanticInputSha256?: string;
  /** @deprecated Use workspaceDir. */
  stableOutputDir?: string;
  /** @deprecated Use workspaceDirRelative. */
  stableOutputDirRelative?: string;
  primaryFile?: WorkflowPrimaryFileReference;
  lineage?: WorkflowRunLineage;
  childRuns?: WorkflowChildRunEvidence[];
  journal: WorkflowJournalLine[];
  error?: string;
  /** Who failed, when the run failed. Presentation-only; wording, not truth. */
  failureOrigin?: WorkflowFailureOrigin;
  /** Actionable projection of a failed run: stage, script, evidence, repair request. */
  failureDiagnostic?: WorkflowFailureDiagnostic;
  target?: ResolvedWorkflowTarget;
  scriptIdentity?: WorkflowScriptIdentity;
  resourceEvidence?: WorkflowResourceEvidence[];
  workspaceEvidence?: WorkflowWorkspaceEvidence[];
  /** Bounded reader-facing output refs (answers and workflow-published text),
   *  newest slice when a run produced more than the projection limit. */
  artifactRefs?: WorkflowArtifactRef[];
  artifactRefsOmitted?: number;
  /** Bounded late failures persisted independently from the best-effort journal sink. */
  finalizationErrors?: WorkflowFinalizationError[];
  resumeFromRunId?: string;
  resumeSourceRunSummary?: WorkflowRunSummary | null;
  continuation?: WorkflowContinuationJournal;
  operatorHandoff?: WorkflowOperatorHandoffEnvelope;
  /** What this run did about recorded-call replay. Absent only when the run
   *  failed before its script identity was established. */
  replay?: WorkflowReplayEnvelope;
}

/**
 * What a terminal route hands the finalizer: the whole result minus the three
 * fields only the finalizer may decide — run identity and persistence outcome.
 */
export type RunResultFields = Omit<RunWorkflowScriptResult, "runId" | "runDir" | "resultPersistence">;

const MAX_PROJECTED_WORKFLOW_ARTIFACT_REFS = 20;

// ---------------------------------------------------------------------------
// The ports the sequence reads
// ---------------------------------------------------------------------------

/**
 * Narrow typed inputs. Live run state that is still being assigned while the run
 * executes arrives as an accessor, so the sequence reads the value the run
 * actually reached instead of the one it had when the finalizer was built.
 */
export interface WorkflowRunFinalizationPorts {
  readonly projectRoot: string;
  readonly runId: string;
  readonly runDir: string;
  /** The launched reference, as named in the project error index. */
  readonly requestedWorkflow: string | undefined;
  /** What this run was allowed to spend; persisted whole in the result envelope. */
  readonly budget: WorkflowBudget;
  /** The controlling signal. An abort beats both waiting and a successful return. */
  readonly signal: AbortSignal;
  readonly journal: WorkflowJournalSink;
  /** Presentation only. A throwing callback never changes durable truth. */
  readonly onEvent?: (line: WorkflowJournalLine) => void;
  /**
   * The workspace lease THIS run owns, or undefined when it owns none. A saved
   * child inherits its root's lease and must neither fence-check nor release it.
   */
  readonly ownedRootLease: () => WorkflowRootLease | undefined;
  /** The source-handoff claim this launch consumed, when it consumed one. */
  readonly operatorHandoffClaim?: WorkflowHandoffClaimLease;
  /** Whether the run got far enough to bind that claim to itself. */
  readonly handoffClaimBound: () => boolean;
  /** The run's single `awaitOperator()` declaration, when the script made one. */
  readonly awaitOperator: () => WorkflowAwaitOperatorDeclaration | undefined;
  /** The verified artifact index; absent before the store is constructed. */
  readonly artifacts: () => WorkflowRunReportEvidenceSource | undefined;
  /** Throws for an unreadable manager; returns undefined when the run has none. */
  readonly workspaceEvidence: () => WorkflowWorkspaceEvidence[] | undefined;
  readonly resourceEvidence: () => WorkflowResourceEvidence[] | undefined;
  readonly replay: () => WorkflowReplayEnvelope | undefined;
  /** Gate-owned high-water mark; the journal cannot reproduce it. */
  readonly peakAgentConcurrency: () => number;
  readonly failedChild: () => BuildWorkflowFailureDiagnosticInput["failedChild"];
  readonly unhandledGroupFailure: () => boolean;
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

/**
 * Build the one finalizer for one run. The returned function is called on
 * whichever terminal route the run takes; the lease-release bit it closes over is
 * what keeps the release exactly-once across the two places in the sequence that
 * can consume it — the stale-lease check and the release itself.
 */
export function createWorkflowRunFinalizer(
  ports: WorkflowRunFinalizationPorts,
): (fields: RunResultFields) => RunWorkflowScriptResult {
  const { projectRoot, runId, runDir, budget, journal } = ports;
  const outputDir = workflowReportDir(projectRoot, runId);
  let leaseReleased = false;

  /** Attach the actionable diagnostic to a failed envelope; other outcomes pass through. */
  function withFailureDiagnostic(
    fields: RunResultFields,
    artifactSource: WorkflowRunReportEvidenceSource | undefined,
  ): RunResultFields {
    // A script that deliberately returns `{ ok: false }` reported a domain
    // verdict, not a defect: it already owns its own summary and needs no repair
    // request. Only a thrown/transport failure earns a diagnostic.
    if (fields.disposition?.status !== "failed" || fields.error === undefined) return fields;
    let artifacts: readonly { kind: string; stage?: string; relativePath: string; callId?: string }[] = [];
    try {
      artifacts = artifactSource?.list() ?? [];
    } catch {
      // An unreadable artifact index costs the evidence pointer, never the verdict.
    }
    const prior = fields.failureDiagnostic;
    const errorIndex =
      prior?.errorLogPath === undefined
        ? appendProjectError(projectRoot, {
            ts: new Date().toISOString(),
            source: "workflow",
            event: "workflow_result",
            status: "failed",
            runId,
            workflow: ports.requestedWorkflow,
            message: fields.error,
            journalPath: workflowJournalFile(runDir),
          })
        : { path: prior.errorLogPath, warning: prior.errorLogWarning };
    const failedChild = ports.failedChild();
    return {
      ...fields,
      failureDiagnostic: buildWorkflowFailureDiagnostic({
        errorLogPath: errorIndex.path,
        ...(errorIndex.warning === undefined ? {} : { errorLogWarning: errorIndex.warning }),
        projectRoot,
        runDir,
        journalPath: workflowJournalFile(runDir),
        journal: fields.journal,
        ...(fields.failureOrigin === undefined ? {} : { origin: fields.failureOrigin }),
        ...(failedChild === undefined ? {} : { failedChild }),
        ...(ports.unhandledGroupFailure() ? { unhandledGroupFailure: true } : {}),
        ...(fields.error === undefined ? {} : { error: fields.error }),
        ...(fields.target === undefined ? {} : { target: fields.target }),
        ...(fields.scriptIdentity === undefined ? {} : { scriptIdentity: fields.scriptIdentity }),
        artifacts,
      }),
    };
  }

  /**
   * The ONE hand-built projection of a terminal envelope into report input. Both
   * report writes below use it; only the status fallback differs, because the
   * second one runs after `result.json` has already failed.
   */
  const reportInput = (fields: RunResultFields, fallbackStatus: string): WorkflowRunReportInput => ({
    projectRoot,
    runId,
    runDir,
    ...(fields.workspaceDir === undefined ? {} : { workspaceDir: fields.workspaceDir }),
    status: fields.disposition?.status ?? fallbackStatus,
    ...(fields.target === undefined
      ? {}
      : {
          target: {
            kind: fields.target.kind,
            ref: fields.target.ref,
            source: fields.target.source,
          },
        }),
    result: fields.result,
    ...(fields.error === undefined ? {} : { error: fields.error }),
    journal: fields.journal,
    budget: { applied: budget, peakConcurrency: ports.peakAgentConcurrency() },
  });

  return function finishRun(fields: RunResultFields): RunWorkflowScriptResult {
    let primaryOutputPath: string | undefined;
    const finalizationErrors: WorkflowFinalizationError[] = [];
    const artifactStore = ports.artifacts();
    const awaitOperatorDeclaration = ports.awaitOperator();
    const ownedRootLease = ports.ownedRootLease();
    const resourceEvidence = ports.resourceEvidence();
    const replay = ports.replay();
    // Complete published/primary identity set for this run; the operator handoff is
    // admitted from this, never from the display projection below.
    let allOutputRefs: WorkflowArtifactRef[] = [];
    let enrichedFields: RunResultFields = {
      ...fields,
      ...(resourceEvidence === undefined ? {} : { resourceEvidence }),
      ...(replay === undefined ? {} : { replay }),
    };
    if (ownedRootLease !== undefined) {
      try {
        assertWorkflowRootLease(ownedRootLease);
      } catch (error) {
        leaseReleased = true;
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? (error instanceof Error ? error.message : String(error)),
        };
      }
    }
    try {
      const workspaceEvidence = ports.workspaceEvidence();
      if (workspaceEvidence !== undefined) enrichedFields = { ...enrichedFields, workspaceEvidence };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      enrichedFields = {
        ...enrichedFields,
        ok: false,
        error: enrichedFields.error ?? message,
      };
    }
    if (artifactStore !== undefined) {
      try {
        const outputRecords = artifactStore
          .list()
          .filter((record) => record.kind === "published" || record.kind === "primary");
        // The COMPLETE verified output set. It is what the operator handoff is built
        // from, so a run that published more than the display projection shows can
        // still hand every one of its artifacts to a continuation.
        allOutputRefs = outputRecords.map((record) => workflowArtifactRef(record));
        // Display projection only: the newest few, with `artifactRefsOmitted` saying
        // how many the summary did not print. It admits nothing and gates nothing —
        // `consumeText` resolves any artifact through the source run's full index.
        const artifactRefs = allOutputRefs.slice(-MAX_PROJECTED_WORKFLOW_ARTIFACT_REFS);
        enrichedFields = {
          ...enrichedFields,
          ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
          ...(outputRecords.length > artifactRefs.length
            ? { artifactRefsOmitted: outputRecords.length - artifactRefs.length }
            : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? message,
        };
      }
    }
    if (awaitOperatorDeclaration?.operatorHandoff !== undefined && enrichedFields.ok) {
      try {
        if (enrichedFields.target === undefined || enrichedFields.scriptIdentity === undefined) {
          throw new Error("Workflow operator handoff requires persisted target and script identity.");
        }
        enrichedFields = {
          ...enrichedFields,
          operatorHandoff: createWorkflowOperatorHandoffEnvelope({
            declaration: awaitOperatorDeclaration.operatorHandoff,
            runId,
            target: enrichedFields.target,
            scriptIdentity: enrichedFields.scriptIdentity,
            terminalArtifactRefs: allOutputRefs,
          }),
        };
      } catch (error) {
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? (error instanceof Error ? error.message : String(error)),
        };
      }
    }
    const disposition = workflowDispositionForCompletion({
      ok: enrichedFields.ok,
      aborted: ports.signal.aborted,
      ...(ports.signal.aborted ? { abortReason: ports.signal.reason } : {}),
      ...(awaitOperatorDeclaration !== undefined ? { awaitOperatorReason: awaitOperatorDeclaration.reason } : {}),
    });
    if (disposition.status === "cancelled") {
      const cancellationMessage = `[workflow:cancelled] reason=${disposition.reason}`;
      const alreadyRecorded = enrichedFields.journal.some(
        (line) => line.kind === "log" && line.source === "runtime" && line.message === cancellationMessage,
      );
      if (!alreadyRecorded) {
        const cancellationLine: WorkflowJournalLine = {
          ts: new Date().toISOString(),
          runId,
          kind: "log",
          source: "runtime",
          message: cancellationMessage,
        };
        journal.write(cancellationLine);
        try {
          ports.onEvent?.(cancellationLine);
        } catch {
          // Presentation callbacks cannot change durable cancellation truth.
        }
        enrichedFields = { ...enrichedFields, journal: [...enrichedFields.journal, cancellationLine] };
      }
    }
    enrichedFields = {
      ...enrichedFields,
      ok: disposition.status === "completed" || disposition.status === "awaiting_operator",
      disposition,
    };
    if (ports.operatorHandoffClaim !== undefined && !ports.handoffClaimBound()) {
      try {
        releaseWorkflowHandoffClaim(ports.operatorHandoffClaim);
      } catch (error) {
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          disposition: { status: "failed" },
          error: enrichedFields.error ?? `Workflow handoff claim release failed: ${String(error)}`,
        };
      }
    }
    // One choke point for actionable failure text: every terminal route above
    // funnels here, so the operator gets the same stage/script/evidence pointer
    // whether the trusted script threw or the runtime around it did.
    enrichedFields = withFailureDiagnostic(enrichedFields, artifactStore);
    // Human-visible terminal prose is mandatory. Persist it once before the
    // best-effort report so every later surface can point at one owned file.
    const terminalText = workflowResultText(enrichedFields.result);
    const resultTextPath = writeWorkflowResultText(runDir, enrichedFields.result);
    if (terminalText !== undefined && resultTextPath === undefined) {
      const message = `Workflow terminal output was not persisted under ${outputDir}.`;
      const outputFailure: WorkflowJournalLine = {
        ts: new Date().toISOString(),
        runId,
        kind: "error",
        source: "runtime",
        message,
      };
      journal.write(outputFailure);
      finalizationErrors.push(workflowFinalizationError("terminal-output", message));
      enrichedFields = withFailureDiagnostic(
        {
          ...enrichedFields,
          ok: false,
          disposition: { status: "failed" },
          error: enrichedFields.error ?? message,
          journal: [...enrichedFields.journal, outputFailure],
        },
        artifactStore,
      );
    }
    // No workflow-workspace mutation follows this point. Release before writing the
    // run report/result envelope so a release failure becomes terminal evidence
    // instead of escaping after a persisted success.
    if (ownedRootLease !== undefined && !leaseReleased) {
      try {
        releaseWorkflowRootLease(ownedRootLease);
        leaseReleased = true;
      } catch (error) {
        const message = `Workflow workspace lease release failed: ${error instanceof Error ? error.message : String(error)}`;
        const leaseFailure: WorkflowJournalLine = {
          ts: new Date().toISOString(),
          runId,
          kind: "error",
          source: "runtime",
          message,
        };
        journal.write(leaseFailure);
        finalizationErrors.push(workflowFinalizationError("lease-release", message));
        leaseReleased = true;
        enrichedFields = withFailureDiagnostic(
          {
            ...enrichedFields,
            ok: false,
            disposition: { status: "failed" },
            error: enrichedFields.error ?? message,
            journal: [...enrichedFields.journal, leaseFailure],
          },
          artifactStore,
        );
      }
    }
    // The run's human outputs under <runDir>/outputs/: table of contents, task,
    // result, budget-versus-spend, and workflow-published documents under their
    // semantic names. Agent call answers remain evidence under runtime/ unless
    // the workflow explicitly publishes one. Files agents wrote themselves stay
    // under their own names in the separate project-local workflow workspace.
    // The envelope below stays the durable truth, and a report failure never fails
    // the run. It runs BEFORE result.json so a failed write can still enter the
    // bounded finalizationErrors projection even if its journal append also fails.
    if (artifactStore !== undefined) {
      const reportOutcome = writeWorkflowRunReport(
        reportInput(enrichedFields, enrichedFields.ok ? "completed" : "failed"),
        artifactStore,
      );
      if (reportOutcome.ok) primaryOutputPath = reportOutcome.primaryOutputPath;
      if (!reportOutcome.ok) {
        // The run disposition is deliberately unchanged — reversing that is the
        // evidence contract's call, not this one's. What changes is the silence:
        // without this line the budget evidence could simply not exist and
        // nothing would say so, which `evidence-over-claim` cannot live with.
        const reportFailure: WorkflowJournalLine = {
          ts: new Date().toISOString(),
          runId,
          kind: "error",
          source: "runtime",
          message: `Workflow run report was not written to ${outputDir}: ${reportOutcome.message}`,
        };
        journal.write(reportFailure);
        finalizationErrors.push(
          workflowFinalizationError("report", reportFailure.message ?? "Workflow run report failed."),
        );
        try {
          ports.onEvent?.(reportFailure);
        } catch {
          // A presentation callback cannot change what the durable journal records.
        }
        enrichedFields = { ...enrichedFields, journal: [...enrichedFields.journal, reportFailure] };
      }
    }
    const intendedPersistence: WorkflowResultPersistence = { ok: true, path: workflowResultFile(runDir) };
    const { journal: _inMemoryJournal, ...persistedFields } = enrichedFields;
    const finalizationProjection =
      finalizationErrors.length === 0 ? {} : { finalizationErrors: [...finalizationErrors] };
    const resultPersistence = writeWorkflowResultJson(runDir, {
      runId,
      ...persistedFields,
      ...finalizationProjection,
      // Every axis, undeclared ones included, so a later reader of this envelope
      // learns what the run was allowed to spend without inferring it from silence.
      budget: workflowBudgetEnvelope(budget),
      resultPersistence: intendedPersistence,
    });
    if (resultPersistence.ok) {
      return {
        runId,
        runDir,
        ...enrichedFields,
        ...finalizationProjection,
        resultPersistence,
        ...(resultTextPath === undefined ? {} : { resultTextPath }),
        ...(primaryOutputPath === undefined ? {} : { primaryOutputPath }),
      };
    }

    const persistenceError: WorkflowJournalLine = {
      ts: new Date().toISOString(),
      runId,
      kind: "error",
      source: "runtime",
      message: resultPersistence.message,
    };
    journal.write(persistenceError);
    try {
      ports.onEvent?.(persistenceError);
    } catch {
      // Presentation callbacks cannot recover durable evidence and must not hide
      // the typed persistence failure returned below.
    }
    const failedFields: RunResultFields = withFailureDiagnostic(
      {
        ...enrichedFields,
        ok: false,
        disposition: workflowDispositionForCompletion({
          ok: false,
          aborted: ports.signal.aborted,
          ...(ports.signal.aborted ? { abortReason: ports.signal.reason } : {}),
        }),
        error: enrichedFields.error ?? resultPersistence.message,
        journal: [...enrichedFields.journal, persistenceError],
      },
      artifactStore,
    );
    // result.json is the durable machine envelope, but its own write can fail.
    // Re-project the human README from the now-failed fields so the readable
    // surface cannot keep claiming success after that failure. A SECOND write with
    // its own outcome: the first one above already ran against the then-current
    // envelope, and a failure there is already recorded in finalizationErrors.
    if (artifactStore !== undefined) {
      const failedReport = writeWorkflowRunReport(reportInput(failedFields, "failed"), artifactStore);
      if (failedReport.ok) primaryOutputPath = failedReport.primaryOutputPath;
    }
    const failed = {
      runId,
      runDir,
      ...failedFields,
      ...finalizationProjection,
      resultPersistence,
      ...(resultTextPath === undefined ? {} : { resultTextPath }),
      ...(primaryOutputPath === undefined ? {} : { primaryOutputPath }),
    };
    return failed;
  };
}
