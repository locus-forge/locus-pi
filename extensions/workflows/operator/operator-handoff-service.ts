import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import {
  assertWorkflowHandoffContinuationEligibility,
  claimWorkflowOperatorHandoff,
  projectWorkflowHandoffState,
  readCurrentWorkflowScriptIdentity,
  readPersistedWorkflowOperatorHandoff,
  releaseWorkflowHandoffClaim,
  workflowContinuationForHandoff,
  type WorkflowOperatorHandoffEnvelope,
  type WorkflowOperatorQuestion,
} from "../runtime/workflow-handoff.js";
import { sameWorkflowArtifactRef } from "../runtime/workflow-artifact-format.js";
import { readWorkflowArtifactRecord, type WorkflowArtifactRef } from "../runtime/workflow-artifacts.js";
import {
  listWorkflowRuns,
  readWorkflowRunResult,
  workflowPersistedResultInvalidity,
} from "../runtime/workflow-journal.js";
import {
  readWorkflowResumeWorkspaceIdentity,
  type WorkflowHandoffWorkspaceReuseBinding,
} from "../runtime/workflow-run-resume.js";
import { resolveWorkflowTarget } from "../runtime/workflow-discovery.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { safeToolText } from "../../_shared/host/safe-output.js";
import type {
  ActionableWorkflowHandoff,
  WorkflowHandoffLaunchResult,
  WorkflowHandoffScanItem,
} from "./operator-handoff-controller.js";
import type { WorkflowCommandLauncher } from "../launch/workflow-command-launcher.js";

export interface WorkflowOperatorHandoffService {
  scan(projectRoot: string): WorkflowHandoffScanItem[];
  read(projectRoot: string, runId: string): ActionableWorkflowHandoff | { message: string } | undefined;
  launch(item: ActionableWorkflowHandoff, answer: string, ctx: ExtensionContext): Promise<WorkflowHandoffLaunchResult>;
}

export function createWorkflowOperatorHandoffService(
  launcher: Pick<WorkflowCommandLauncher, "launch">,
): WorkflowOperatorHandoffService {
  return {
    scan(projectRoot) {
      const items: WorkflowHandoffScanItem[] = [];
      for (const run of listWorkflowRuns(projectRoot)) {
        const { runId, runDir } = run;
        const read = readPersistedWorkflowOperatorHandoff(projectRoot, runId, runDir);
        if (read.status === "absent") continue;
        if (read.status === "invalid") {
          items.push({ status: "invalid", runId, message: read.message });
          continue;
        }
        const invalidity = workflowPersistedResultInvalidity(readWorkflowRunResult(projectRoot, runId, runDir));
        if (invalidity !== undefined) {
          items.push({
            status: "invalid",
            runId,
            message: `Workflow run ${runId} has malformed persisted metadata (${invalidity}).`,
          });
          continue;
        }
        try {
          readWorkflowResumeWorkspaceIdentity(projectRoot, runId, runDir);
        } catch (error) {
          items.push({ status: "invalid", runId, message: errorMessage(error) });
          continue;
        }
        try {
          const state = projectWorkflowHandoffState(projectRoot, read.handoff);
          switch (state.status) {
            case "pending":
              items.push({
                status: "actionable",
                handoff: actionableWorkflowHandoff(projectRoot, read.handoff),
                state: "pending",
              });
              break;
            case "retryable":
              // Answerable again, but only on an explicit operator ask: its previous
              // continuation consumed an answer and then failed or was cancelled.
              items.push({
                status: "actionable",
                handoff: actionableWorkflowHandoff(projectRoot, read.handoff),
                state: "retryable",
              });
              break;
            case "running":
              items.push({
                status: "nonactionable",
                runId,
                message:
                  state.childRunId === undefined
                    ? "Workflow continuation is starting."
                    : `Workflow continuation ${state.childRunId} is still running.`,
              });
              break;
            case "resolved":
              items.push({
                status: "nonactionable",
                runId,
                message: `Workflow handoff was resolved by continuation ${state.childRunId}.`,
              });
              break;
            default:
              assertNever(state);
          }
        } catch (error) {
          items.push({ status: "invalid", runId, message: errorMessage(error) });
        }
      }
      return items;
    },
    read(projectRoot, runId) {
      const read = readPersistedWorkflowOperatorHandoff(projectRoot, runId);
      if (read.status === "absent") return undefined;
      if (read.status === "invalid") return { message: read.message };
      const invalidity = workflowPersistedResultInvalidity(readWorkflowRunResult(projectRoot, runId));
      if (invalidity !== undefined) {
        return { message: `Workflow run ${runId} has malformed persisted metadata (${invalidity}).` };
      }
      try {
        readWorkflowResumeWorkspaceIdentity(projectRoot, runId);
      } catch (error) {
        return { message: errorMessage(error) };
      }
      try {
        const state = projectWorkflowHandoffState(projectRoot, read.handoff);
        if (state.status === "running") {
          return {
            message:
              state.childRunId === undefined
                ? "Workflow continuation is starting."
                : `Workflow continuation ${state.childRunId} is still running.`,
          };
        }
        if (state.status === "resolved") {
          return { message: `Workflow handoff was resolved by continuation ${state.childRunId}.` };
        }
        return actionableWorkflowHandoff(projectRoot, read.handoff);
      } catch (error) {
        return { message: errorMessage(error) };
      }
    },
    async launch(item, answer, ctx) {
      const handoff = item.value;
      let target;
      let workspace: WorkflowHandoffWorkspaceReuseBinding;
      try {
        const targetInput =
          handoff.target.kind === "scriptPath" ? { scriptPath: handoff.target.ref } : { name: handoff.target.ref };
        target = resolveWorkflowTarget(targetInput, getProjectRoot(ctx), getWorkingDirectory(ctx));
        assertWorkflowHandoffContinuationEligibility(
          handoff,
          {
            target,
            scriptIdentity: readCurrentWorkflowScriptIdentity(target.path),
          },
          getProjectRoot(ctx),
        );
        const invalidity = workflowPersistedResultInvalidity(
          readWorkflowRunResult(getProjectRoot(ctx), handoff.originRunId),
        );
        if (invalidity !== undefined) {
          throw new Error(
            `Workflow handoff source run ${handoff.originRunId} has malformed persisted metadata (${invalidity}).`,
          );
        }
        workspace = {
          sourceRunId: handoff.originRunId,
          ...readWorkflowResumeWorkspaceIdentity(getProjectRoot(ctx), handoff.originRunId),
        };
      } catch (error) {
        return { status: "invalid", message: errorMessage(error) };
      }
      const claimed = claimWorkflowOperatorHandoff(getProjectRoot(ctx), handoff);
      if (claimed.status !== "claimed") {
        return {
          status: claimed.status === "active" ? "busy" : "invalid",
          message: claimed.message,
        };
      }
      const waitForIdle = contextIdleWaiter(ctx);
      let launched;
      try {
        launched = launcher.launch({
          ctx,
          scriptRef: handoff.target.ref,
          target,
          input: answer,
          continuation: workflowContinuationForHandoff(handoff),
          operatorHandoffClaim: claimed.claim,
          operatorHandoffWorkspaceReuse: workspace,
          ...(waitForIdle === undefined ? {} : { waitForIdle }),
        });
      } catch (error) {
        const launchFailure = `Workflow continuation launch failed before start: ${errorMessage(error)}`;
        const releaseFailure = releaseUnboundClaim(claimed.claim, launchFailure);
        return releaseFailure ?? { status: "failed", message: launchFailure };
      }
      if (launched.status === "started") return launched;
      const releaseFailure = releaseUnboundClaim(claimed.claim, "Workflow continuation did not start.");
      if (releaseFailure !== undefined) return releaseFailure;
      return launched.status === "busy"
        ? { status: "busy", message: `Workflow ${launched.owner} is still running or stopping.` }
        : { status: "failed", message: "Workflow continuation did not start because this extension session is stale." };
    },
  };
}

function releaseUnboundClaim(
  claim: Parameters<typeof releaseWorkflowHandoffClaim>[0],
  launchFailure: string,
): { status: "failed"; message: string } | undefined {
  try {
    if (releaseWorkflowHandoffClaim(claim)) return undefined;
    return {
      status: "failed",
      message: `${launchFailure} Its unbound claim was already absent when release was attempted.`,
    };
  } catch (error) {
    return {
      status: "failed",
      message: `${launchFailure} Its unbound claim could not be released: ${errorMessage(error)}`,
    };
  }
}

function actionableWorkflowHandoff(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
): ActionableWorkflowHandoff {
  return {
    runId: handoff.originRunId,
    title: handoff.title,
    questions: handoff.questions.map((question) => actionableQuestion(projectRoot, question)),
    value: handoff,
  };
}

function actionableQuestion(
  projectRoot: string,
  question: WorkflowOperatorQuestion,
): ActionableWorkflowHandoff["questions"][number] {
  const ref = question.detailArtifactRef;
  if (ref === undefined) return question;
  const read = readWorkflowArtifactRecord(projectRoot, ref.runId, ref.artifactId);
  if (read.status !== "ready") {
    throw new Error(`Workflow handoff question detail is unavailable: ${read.message}`);
  }
  if (!sameWorkflowArtifactRef(read.record, ref)) {
    throw new Error("Workflow handoff question detail does not match its artifact reference.");
  }
  if (!read.record.mediaType.startsWith("text/")) {
    throw new Error("Workflow handoff question detail must be a text artifact.");
  }
  const safe = safeToolText(read.bytes.toString("utf8"), 4096).text;
  const lines = safe.split(/\r?\n/u);
  const detailText = lines.length <= 12 ? safe : [...lines.slice(0, 12), `… more detail in ${ref.name}`].join("\n");
  return { ...question, detailText };
}

function contextIdleWaiter(ctx: ExtensionContext): (() => Promise<void>) | undefined {
  const waitForIdle = (ctx as ExtensionContext & { waitForIdle?: () => Promise<void> }).waitForIdle;
  return typeof waitForIdle === "function" ? () => waitForIdle.call(ctx) : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow handoff state: ${String(value)}`);
}
