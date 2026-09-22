/**
 * workflow-run-admission.ts — The ordered pre-execution admission of one run.
 *
 * ORDER IS THE CONTRACT, and it is the reason this is one module instead of four
 * helpers the runner could call in any sequence:
 *
 *   1. target binding      — what workflow was asked for, resolved once by the host
 *   2. source snapshot     — the exact bytes that will execute, hashed and retained
 *   3. workspace identity  — which workspace this run may write, and whether resume
 *                            or an operator handoff proves the right to reuse it
 *   4. launch binding      — the independent persisted authority a later resume reads
 *
 * Each step may only read what an earlier step established: a workspace is never
 * admitted before the script identity it is bound to exists, and the launch binding
 * is written only after both.
 *
 * What this module is NOT allowed to do, so that "refused" stays refused:
 *   - it never calls the runner and never starts execution;
 *   - it never claims the run or writes the journal prelude — those happen BEFORE
 *     admission, so a refused run still leaves a visible run directory and journal;
 *   - it never acquires the root lease or builds shared execution state — the runner
 *     does that AFTER a successful admission, so no `agent_start` can precede one.
 *
 * It may import `workflow-run-resume.ts` (the resume authority); that module must
 * not import this one, and neither imports the runner.
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import type { WorkflowContinuation } from "./workflow-artifacts.js";
import type { WorkflowBudget } from "./workflow-budget.js";
import {
  assertResolvedWorkflowTargetBinding,
  resolveWorkflowTarget,
  WORKFLOW_ENTRY_SUFFIX,
  type ResolvedWorkflowTarget,
} from "./workflow-discovery.js";
import { assertWorkflowHandoffClaimEligibility, type WorkflowHandoffClaimLease } from "./workflow-handoff.js";
import { readInterruptedWorkflowResumeBinding, workflowRecoveryInputHash } from "./workflow-interrupted-recovery.js";
import { readWorkflowRunResult } from "./workflow-journal.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingExists,
  workflowLaunchBindingMatchesResult,
  writeWorkflowLaunchBinding,
  type WorkflowLaunchBinding,
} from "./workflow-launch-binding.js";
import {
  assertWorkflowRunName,
  assertFreshWorkflowOutputNamespace,
  assertFreshWorkflowOutputNamespacePath,
  ensureWorkflowWorkspaceFile,
  isLegacyWorkflowWorkspacePath,
  resolveWorkflowOutputDirectory,
  resolveWorkflowOutputDirectoryPath,
  resolveWorkflowOutputDirectoryForReuse,
  resolveNamedWorkflowWorkspacePath,
  type WorkflowOutputDirectory,
} from "./workflow-output.js";
import { verifyWorkflowPersistedSnapshot } from "./workflow-persisted-binding.js";
import {
  isTaskWorkspaceName,
  WORKFLOW_PLANS_DIRNAME,
  WORKFLOW_ROOT_DIRNAME,
  WORKFLOW_WORKSPACES_DIRNAME,
} from "./workflow-run-layout.js";
import {
  isPostCodeReviewTarget,
  persistedTargetIdentityKey,
  readWorkflowResumeSemanticInputIdentity,
  readWorkflowResumeWorkspaceIdentityFromResult,
  assertWorkflowHandoffWorkspaceReuse,
  targetIdentityKey,
  type WorkflowHandoffWorkspaceReuseBinding,
  type WorkflowResumeSourceBinding,
  type WorkflowResumeWorkspaceIdentity,
  type WorkflowSemanticInputIdentity,
} from "./workflow-run-resume.js";
import { isPostCodeReviewTargetProjection } from "./workflow-saved-name.js";
import { createWorkflowScriptSnapshot, type WorkflowScriptIdentity } from "./workflow-script-identity.js";
import type { WorkflowRunnerCoordination } from "./workflow-saved-child.js";

/** Validate a host-owned target binding before any snapshot or import. */
export function assertWorkflowTargetBinding(
  binding: unknown,
  request: { name?: string; scriptPath?: string; script?: string },
  projectRoot: string,
  workingDirectory = projectRoot,
): ResolvedWorkflowTarget {
  return assertResolvedWorkflowTargetBinding(binding, request, projectRoot, workingDirectory);
}

function workflowDefaultOutputName(target: ResolvedWorkflowTarget): string {
  return target.kind === "name" ? target.ref : path.basename(target.path, WORKFLOW_ENTRY_SUFFIX);
}

/** The launch request fields admission reads. Deliberately narrower than the runner's options. */
export interface WorkflowRunAdmissionLaunch {
  targetBinding?: ResolvedWorkflowTarget;
  name?: string;
  scriptPath?: string;
  script?: string;
  input?: string;
  outputDir?: string;
  runName?: string;
  continuation?: WorkflowContinuation;
  operatorHandoffClaim?: WorkflowHandoffClaimLease;
  operatorHandoffWorkspaceReuse?: WorkflowHandoffWorkspaceReuseBinding;
  recoverInterrupted?: boolean;
}

export interface WorkflowRunAdmissionRequest {
  projectRoot: string;
  workingDirectory: string;
  runId: string;
  runDir: string;
  /** Where the retained script snapshot is written for this run. */
  runtimeDir: string;
  items: readonly string[];
  budget: WorkflowBudget;
  noOperator?: true;
  /** Whether the caller asked for a resume at all, before the run id was validated. */
  hasResume: boolean;
  /** The validated source run id, when this launch is a resume. */
  resumeFromRunId?: string;
  requestedSemanticInput: WorkflowSemanticInputIdentity;
  inheritedCoordination?: WorkflowRunnerCoordination;
  launch: WorkflowRunAdmissionLaunch;
}

/**
 * What admission established before it finished, admitted or not.
 *
 * A refusal still reports this: the run's terminal result must project the same
 * workspace and handoff facts a refusal already committed to, exactly as it did
 * when these locals lived in the runner.
 */
export interface WorkflowRunAdmissionState {
  interruptedRecovery: boolean;
  resumeSourceWorkspace?: WorkflowResumeWorkspaceIdentity;
  resumeSourceBinding?: WorkflowResumeSourceBinding;
  handoffReuseOutput?: WorkflowOutputDirectory;
  stableOutput?: WorkflowOutputDirectory;
}

export type WorkflowRunAdmissionOutcome =
  | (WorkflowRunAdmissionState & {
      admitted: true;
      target: ResolvedWorkflowTarget;
      scriptIdentity: WorkflowScriptIdentity;
      stableOutput: WorkflowOutputDirectory;
    })
  | (WorkflowRunAdmissionState & {
      admitted: false;
      error: string;
      /** Present only once the step that establishes it has passed. */
      target?: ResolvedWorkflowTarget;
      scriptIdentity?: WorkflowScriptIdentity;
    });

/**
 * Run the four admission steps in order and return the validated data, or the
 * first refusal with exactly the evidence that was established when it happened.
 */
export function admitWorkflowRun(request: WorkflowRunAdmissionRequest): WorkflowRunAdmissionOutcome {
  const {
    projectRoot,
    workingDirectory,
    runId,
    runDir,
    runtimeDir,
    items,
    budget,
    noOperator,
    hasResume,
    resumeFromRunId,
    requestedSemanticInput,
    inheritedCoordination,
    launch: opts,
  } = request;

  let selectedOutputDir = opts.outputDir;
  let interruptedRecovery = false;
  let resumeSourceWorkspace: WorkflowResumeWorkspaceIdentity | undefined;
  let resumeSourceBinding: WorkflowResumeSourceBinding | undefined;
  let handoffReuseOutput: WorkflowOutputDirectory | undefined;
  let stableOutput: WorkflowOutputDirectory | undefined = inheritedCoordination?.output;
  const state = (): WorkflowRunAdmissionState => ({
    interruptedRecovery,
    ...(resumeSourceWorkspace === undefined ? {} : { resumeSourceWorkspace }),
    ...(resumeSourceBinding === undefined ? {} : { resumeSourceBinding }),
    ...(handoffReuseOutput === undefined ? {} : { handoffReuseOutput }),
    ...(stableOutput === undefined ? {} : { stableOutput }),
  });

  // --- 1. target binding ---------------------------------------------------
  let target: ResolvedWorkflowTarget;
  try {
    if (opts.targetBinding !== undefined) {
      target = assertWorkflowTargetBinding(
        opts.targetBinding,
        {
          ...(opts.name === undefined ? {} : { name: opts.name }),
          ...(opts.scriptPath === undefined ? {} : { scriptPath: opts.scriptPath }),
          ...(opts.script === undefined ? {} : { script: opts.script }),
        },
        projectRoot,
        workingDirectory,
      );
    } else {
      const targetInput: { name?: string; scriptPath?: string; script?: string } = {};
      if (opts.name !== undefined) targetInput.name = opts.name;
      if (opts.scriptPath !== undefined) targetInput.scriptPath = opts.scriptPath;
      if (opts.script !== undefined) targetInput.script = opts.script;
      target = resolveWorkflowTarget(targetInput, projectRoot, workingDirectory);
    }
    if (opts.runName !== undefined) {
      if (opts.outputDir !== undefined) {
        throw new Error("workflow runName and outputDir are mutually exclusive");
      }
      assertWorkflowRunName(opts.runName);
    }
  } catch (err) {
    return { admitted: false, error: err instanceof Error ? err.message : String(err), ...state() };
  }

  // --- 2. source snapshot / script identity --------------------------------
  let scriptIdentity: WorkflowScriptIdentity;
  try {
    scriptIdentity = createWorkflowScriptSnapshot(target.path, runtimeDir);
    if (inheritedCoordination?.expectedChildSource !== undefined) {
      const actualCanonicalPath = realpathSync(target.path);
      const expected = inheritedCoordination.expectedChildSource;
      if (actualCanonicalPath !== expected.canonicalPath || scriptIdentity.scriptSha256 !== expected.scriptSha256) {
        throw new Error(
          `saved child workflow source changed before execution: ${JSON.stringify(target.ref)} ` +
            `(expected ${expected.canonicalPath}#${expected.scriptSha256}, ` +
            `got ${actualCanonicalPath}#${scriptIdentity.scriptSha256})`,
        );
      }
    }
  } catch (err) {
    return { admitted: false, error: err instanceof Error ? err.message : String(err), target, ...state() };
  }

  const missingTaskPlanInput =
    target.source === "package" && target.kind === "name" && target.ref === "task/plan" && !opts.input?.trim();
  if (missingTaskPlanInput) {
    return {
      admitted: false,
      error:
        "task/plan requires the complete accepted draft as non-empty semantic input; no agent was started and no workflow.mjs was published.",
      target,
      scriptIdentity,
      ...state(),
    };
  }

  // --- 3. workspace identity + admission, then 4. launch binding -----------
  try {
    if (opts.recoverInterrupted !== undefined && typeof opts.recoverInterrupted !== "boolean")
      throw new Error("recoverInterrupted must be boolean");
    if (opts.recoverInterrupted === true && resumeFromRunId === undefined)
      throw new Error("recoverInterrupted requires resumeFromRunId");
    if (opts.operatorHandoffWorkspaceReuse !== undefined) {
      if (opts.operatorHandoffClaim === undefined || opts.continuation === undefined) {
        throw new Error("Workflow handoff workspace reuse requires a validated claim and continuation");
      }
      assertWorkflowHandoffClaimEligibility(opts.operatorHandoffClaim, { target, scriptIdentity });
      handoffReuseOutput = assertWorkflowHandoffWorkspaceReuse(
        projectRoot,
        opts.operatorHandoffWorkspaceReuse,
        opts.operatorHandoffClaim,
        opts.continuation,
        target,
      );
    }
    if (resumeFromRunId !== undefined) {
      let sourceResult = readWorkflowRunResult(projectRoot, resumeFromRunId);
      if (opts.recoverInterrupted === true) {
        sourceResult = readInterruptedWorkflowResumeBinding(projectRoot, resumeFromRunId, {
          target: { kind: target.kind, ref: target.ref, source: target.source },
          scriptSha256: scriptIdentity.scriptSha256,
          recoveryInputSha256: workflowRecoveryInputHash({
            ...(opts.input === undefined ? {} : { input: opts.input }),
            items,
            budget,
            ...(noOperator === undefined ? {} : { noOperator }),
          }),
        });
        interruptedRecovery = true;
      }
      let sourceLaunchBinding: WorkflowLaunchBinding | undefined;
      const currentOwner = isPostCodeReviewTarget(target, projectRoot);
      // Every root now writes a launch binding, but only owner resume and explicit
      // interrupted recovery treat it as admission authority. Ordinary resume keeps
      // reading the persisted result envelope, including pre-binding runs.
      const sourceLaunchBindingPresent =
        (currentOwner || interruptedRecovery) && workflowLaunchBindingExists(projectRoot, resumeFromRunId);
      if (sourceLaunchBindingPresent) {
        if (sourceResult === null) {
          throw new Error(`Cannot resume workflow: source run ${resumeFromRunId} has no readable result.`);
        }
        sourceLaunchBinding = readWorkflowLaunchBinding(projectRoot, resumeFromRunId) ?? undefined;
        if (
          sourceLaunchBinding === undefined ||
          !workflowLaunchBindingMatchesResult(sourceLaunchBinding, sourceResult)
        ) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no valid host launch binding.`,
          );
        }
        const sourceOwner = isPostCodeReviewTargetProjection(sourceLaunchBinding.target, {
          projectRoot,
          resolvedPath: sourceLaunchBinding.scriptIdentity.sourcePath,
        });
        if (sourceOwner !== currentOwner) {
          throw new Error(
            `Cannot resume workflow: source/current post-code-review ownership differs ` +
              `(source=${sourceOwner}, current=${currentOwner}).`,
          );
        }
        sourceResult = {
          ...sourceResult,
          target: sourceLaunchBinding.target,
          scriptIdentity: sourceLaunchBinding.scriptIdentity,
          workspaceDir: sourceLaunchBinding.workspace.absolutePath,
          workspaceDirRelative: sourceLaunchBinding.workspace.relativePath,
          workspacePhysicalIdentity: sourceLaunchBinding.workspace.physicalIdentity,
          workspacePhysicalIdentitySchemaVersion: 1,
          workspaceDirExplicit: sourceLaunchBinding.workspace.explicit,
          semanticInputPresent: sourceLaunchBinding.semanticInput.present,
          semanticInputSha256: sourceLaunchBinding.semanticInput.sha256,
        };
      } else if (currentOwner) {
        if (sourceResult === null) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no readable result.`,
          );
        }
        throw new Error(
          `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no valid host launch binding.`,
        );
      }
      if (sourceResult?.runIdInvalid !== undefined || sourceResult?.runUnbound !== undefined) {
        throw new Error(
          `Cannot resume workflow: source run ${resumeFromRunId} is not bound to its persisted result envelope.`,
        );
      }
      if (sourceResult?.scriptIdentityInvalid !== undefined) {
        throw new Error(
          `Cannot resume workflow: source run ${resumeFromRunId} has malformed script identity: ${sourceResult.scriptIdentityInvalid}.`,
        );
      }
      if (sourceResult?.scriptIdentity?.executionSource === "snapshot") {
        try {
          verifyWorkflowPersistedSnapshot(projectRoot, resumeFromRunId, sourceResult.scriptIdentity);
        } catch (error) {
          throw new Error(
            `Cannot resume workflow: source run ${resumeFromRunId} has unusable retained snapshot: ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }
      if (sourceResult === null) {
        if (isPostCodeReviewTarget(target, projectRoot)) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no readable result.`,
          );
        }
      } else if (sourceResult.targetInvalid !== undefined) {
        if (isPostCodeReviewTarget(target, projectRoot)) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has malformed persisted target: ${sourceResult.targetInvalid}.`,
          );
        }
      } else if (sourceResult.target === undefined) {
        if (isPostCodeReviewTarget(target, projectRoot)) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no persisted target.`,
          );
        }
      } else {
        const sourceOwner = isPostCodeReviewTargetProjection(sourceResult.target, {
          projectRoot,
          resolvedPath: sourceResult.scriptIdentity?.sourcePath,
        });
        if (sourceOwner !== currentOwner) {
          throw new Error(
            `Cannot resume workflow: source/current post-code-review ownership differs ` +
              `(source=${sourceOwner}, current=${currentOwner}).`,
          );
        }
        if (
          (sourceOwner || currentOwner) &&
          persistedTargetIdentityKey(sourceResult.target, projectRoot, sourceResult.scriptIdentity?.sourcePath) !==
            targetIdentityKey(target, projectRoot)
        ) {
          throw new Error(
            `Cannot resume post-code-review workflow: persisted source target does not match current target ` +
              `${JSON.stringify({ kind: target.kind, ref: target.ref, source: target.source })}.`,
          );
        }
        resumeSourceBinding = {
          result: sourceResult,
          owner: sourceOwner,
          workspace: readWorkflowResumeWorkspaceIdentityFromResult(projectRoot, sourceResult, resumeFromRunId),
          ...(sourceLaunchBinding === undefined ? {} : { launchBinding: sourceLaunchBinding }),
        };
      }
      if (resumeSourceBinding === undefined) {
        if (sourceResult === null) {
          throw new Error(`Cannot resume workflow: source run ${resumeFromRunId} has no persisted workspace identity.`);
        }
        resumeSourceBinding = {
          result: sourceResult,
          owner: false,
          workspace: readWorkflowResumeWorkspaceIdentityFromResult(projectRoot, sourceResult, resumeFromRunId),
        };
      }
      resumeSourceWorkspace = resumeSourceBinding.workspace;
    }
    if (
      resumeSourceWorkspace?.explicit === true &&
      selectedOutputDir === undefined &&
      !(target.kind === "name" && isTaskWorkspaceName(target.ref))
    ) {
      throw new Error(
        "Cannot resume workflow: the source workspace was selected explicitly; repeat it with outputDir.",
      );
    }
    const resumeSourceTargetMatches =
      resumeSourceBinding?.result.target !== undefined &&
      persistedTargetIdentityKey(
        resumeSourceBinding.result.target,
        projectRoot,
        resumeSourceBinding.result.scriptIdentity?.sourcePath,
      ) === targetIdentityKey(target, projectRoot);
    if (opts.runName !== undefined && resumeSourceWorkspace !== undefined) {
      const expectedCurrent = [WORKFLOW_ROOT_DIRNAME, WORKFLOW_WORKSPACES_DIRNAME, opts.runName].join("/");
      const expectedLegacy = [WORKFLOW_ROOT_DIRNAME, WORKFLOW_PLANS_DIRNAME, opts.runName].join("/");
      if (
        resumeSourceWorkspace.relativePath !== expectedCurrent &&
        resumeSourceWorkspace.relativePath !== expectedLegacy
      ) {
        throw new Error(
          `Cannot resume workflow: runName ${JSON.stringify(opts.runName)} does not match the source workspace ` +
            `${JSON.stringify(resumeSourceWorkspace.relativePath)}.`,
        );
      }
    }
    const resumeReuseOutput =
      resumeSourceWorkspace !== undefined && selectedOutputDir === undefined && resumeSourceTargetMatches
        ? resolveWorkflowOutputDirectoryForReuse(projectRoot, resumeSourceWorkspace, { create: false })
        : undefined;
    if (
      opts.runName !== undefined &&
      resumeSourceWorkspace === undefined &&
      handoffReuseOutput === undefined &&
      inheritedCoordination === undefined
    ) {
      selectedOutputDir = resolveNamedWorkflowWorkspacePath(projectRoot, opts.runName);
    }
    const candidateOutputPath =
      handoffReuseOutput ??
      resumeReuseOutput ??
      resolveWorkflowOutputDirectoryPath(
        projectRoot,
        selectedOutputDir,
        workflowDefaultOutputName(target),
        workingDirectory,
        { runId },
      );
    const reusesLegacyWorkspace = isLegacyWorkflowWorkspacePath(candidateOutputPath.relativePath);
    if (
      resumeSourceWorkspace !== undefined &&
      candidateOutputPath.relativePath !== resumeSourceWorkspace.relativePath
    ) {
      throw new Error(
        `Cannot resume workflow: outputDir must equal the source workspace ` +
          `${JSON.stringify(resumeSourceWorkspace.relativePath)} ` +
          `(got ${JSON.stringify(candidateOutputPath.relativePath)}).`,
      );
    }
    const freshOwnerLaunch =
      inheritedCoordination === undefined &&
      !hasResume &&
      handoffReuseOutput === undefined &&
      isPostCodeReviewTarget(target, projectRoot);
    if (freshOwnerLaunch) {
      assertFreshWorkflowOutputNamespacePath({ projectRoot, output: candidateOutputPath });
    }
    const resolvedOutput =
      handoffReuseOutput ??
      resumeReuseOutput ??
      resolveWorkflowOutputDirectory(
        projectRoot,
        selectedOutputDir,
        workflowDefaultOutputName(target),
        workingDirectory,
        {
          create: !hasResume && !reusesLegacyWorkspace,
          runId,
        },
      );
    if (freshOwnerLaunch) {
      assertFreshWorkflowOutputNamespace({ projectRoot, output: resolvedOutput });
    }
    if (
      inheritedCoordination !== undefined &&
      (resolvedOutput.identity !== inheritedCoordination.output.identity ||
        resolvedOutput.physicalPath !== inheritedCoordination.output.physicalPath)
    ) {
      throw new Error(
        `saved child outputDir must equal the root outputDir ${JSON.stringify(inheritedCoordination.output.relativePath)}`,
      );
    }
    if (resumeFromRunId !== undefined) {
      if (resumeSourceBinding === undefined) {
        throw new Error(`Cannot resume workflow: source run ${resumeFromRunId} has no validated binding.`);
      }
      if (resumeSourceBinding.owner || interruptedRecovery) {
        const sourceInput =
          resumeSourceBinding.launchBinding?.semanticInput ??
          readWorkflowResumeSemanticInputIdentity(resumeSourceBinding.result, resumeFromRunId);
        if (
          sourceInput.present !== requestedSemanticInput.present ||
          sourceInput.sha256 !== requestedSemanticInput.sha256
        ) {
          throw new Error("Cannot resume post-code-review: semantic input differs from the source run.");
        }
      }
    }
    if (
      resumeSourceWorkspace !== undefined &&
      (resumeSourceWorkspace.relativePath !== resolvedOutput.relativePath ||
        resumeSourceWorkspace.physicalPath !== resolvedOutput.physicalPath ||
        resumeSourceWorkspace.physicalIdentity !== resolvedOutput.identity)
    ) {
      throw new Error(
        `Cannot resume workflow: outputDir must equal the source workspace ` +
          `${JSON.stringify(resumeSourceWorkspace.relativePath)} ` +
          `(got ${JSON.stringify(resolvedOutput.relativePath)}).`,
      );
    }
    stableOutput = inheritedCoordination?.output ?? resolvedOutput;
    if (inheritedCoordination === undefined && isPostCodeReviewTarget(target, projectRoot)) {
      ensureWorkflowWorkspaceFile(stableOutput, "style.md");
    }
    // Persist the independent owner binding before acquiring the lease or
    // starting any child work. The result envelope written at terminal time is
    // only a projection and cannot be the source of resume/handoff authority.
    if (inheritedCoordination === undefined) {
      const launchBinding: WorkflowLaunchBinding = {
        schema: "locus-pi.workflow-launch-binding.v1",
        runId,
        recoveryInputSha256: workflowRecoveryInputHash({
          ...(opts.input === undefined ? {} : { input: opts.input }),
          items,
          budget,
          ...(noOperator === undefined ? {} : { noOperator }),
        }),
        target: { kind: target.kind, ref: target.ref, source: target.source },
        scriptIdentity,
        workspace: {
          absolutePath: stableOutput.absolutePath,
          relativePath: stableOutput.relativePath,
          physicalPath: stableOutput.physicalPath,
          physicalIdentity: stableOutput.identity,
          physicalIdentitySchemaVersion: 1,
          explicit:
            handoffReuseOutput === undefined
              ? opts.outputDir !== undefined
              : opts.operatorHandoffWorkspaceReuse?.explicit === true,
        },
        semanticInput: requestedSemanticInput,
      };
      try {
        writeWorkflowLaunchBinding(runDir, launchBinding);
      } catch (error) {
        return {
          admitted: false,
          error: `Workflow launch binding was not persisted: ${error instanceof Error ? error.message : String(error)}`,
          target,
          scriptIdentity,
          ...state(),
        };
      }
    }
    return { admitted: true, target, scriptIdentity, ...state(), stableOutput };
  } catch (err) {
    return {
      admitted: false,
      error: err instanceof Error ? err.message : String(err),
      target,
      scriptIdentity,
      ...state(),
    };
  }
}
