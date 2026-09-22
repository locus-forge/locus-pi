/**
 * extensions/workflows/index.ts — Extension entrypoint.
 *
 * Registers the `workflow` tool (./workflow-tool.js) and the `/workflows`
 * command plus the emergency `/workflow-stop` alias (./command-router.js). Owns only
 * the per-session wiring those two need: the live progress panels, the
 * completed-run bookkeeping, the command launcher, and the operator handoff
 * controller. Every surface it renders lives in a submodule.
 */

import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory, setTextWidget } from "../_shared/host/pi-api.js";
import { pinTransientUiKey, registerTransientUiCleanup, unpinTransientUiKey } from "../_shared/operator/command-ui.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  pruneCompletedWorkflowRunLiveRows,
  resetWorkflowLiveExecutions,
} from "./runtime/workflow-live.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import { registerWorkflowCommands } from "./command/command-router.js";
import {
  WorkflowOperatorHandoffController,
  type WorkflowHandoffPumpResult,
} from "./operator/operator-handoff-controller.js";
import { createWorkflowOperatorHandoffService } from "./operator/operator-handoff-service.js";
import {
  clearWorkflowRunStatus,
  clearWorkflowWidget,
  presentWorkflowHandoffPumpResult,
  setWorkflowEventStatus,
  setWorkflowLaunchStatus,
} from "./operator/operator-surface.js";
import { buildWorkflowResultBlock, errorMessage, workflowBackgroundFailureBlock } from "./operator/operator-ui.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  installWorkflowProgress,
  renderAgentLiveRowsText,
  type WorkflowProgressComponent,
} from "./operator/progress-widget.js";
import { createWorkflowCommandLauncher } from "./launch/workflow-command-launcher.js";
import { registerWorkflowTool } from "./tool/workflow-tool.js";
import { registerWorkflowSourceCheckTool } from "./tool/workflow-source-check-tool.js";
import { registerFusionSurface } from "./fusion/surface.js";
import {
  announceCommandWorkflowStart,
  persistCommandWorkflowRejection,
  persistCommandWorkflowTranscript,
} from "./command/receipts.js";
import { createWorkflowTranscript, registerWorkflowTranscriptRenderers } from "./transcript/workflow-transcript.js";

export default function workflows(pi: ExtensionAPI): void {
  registerWorkflowTranscriptRenderers(pi);
  const completedRunIds = new Set<string>();
  /**
   * Runs THIS Pi session launched — command, tool, and continuations alike.
   *
   * The automatic pump answers only for these. A question published by an
   * earlier session is durable evidence the operator can open on request; it is
   * not an interruption a fresh session gets to raise on its own, whether at
   * session start or at the first `agent_settled` after it.
   */
  const sessionRunIds = new Set<string>();
  const sessionPanels = new Set<WorkflowProgressComponent>();
  let completionProjectRoot = process.cwd();
  let completionWorkingDirectory = completionProjectRoot;
  const rememberCompletionContext = (ctx: ExtensionContext): void => {
    completionProjectRoot = getProjectRoot(ctx);
    completionWorkingDirectory = getWorkingDirectory(ctx);
  };
  const disposePanel = (panel: WorkflowProgressComponent): void => {
    panel.dispose();
    sessionPanels.delete(panel);
  };
  const disposeSessionPanels = (): void => {
    for (const panel of sessionPanels) panel.dispose();
    sessionPanels.clear();
  };
  let handoffController: WorkflowOperatorHandoffController;
  const observeHandoffPump = (ctx: ExtensionContext, start: () => Promise<WorkflowHandoffPumpResult>): void => {
    void Promise.resolve()
      .then(start)
      .then((result) => {
        if (result.status === "invalid" || result.status === "failed" || result.status === "deferred") {
          presentWorkflowHandoffPumpResult(ctx, result);
        }
      })
      .catch((error) => {
        presentWorkflowHandoffPumpResult(ctx, {
          status: "invalid",
          message: `Workflow handoff pump failed: ${errorMessage(error)}`,
        });
      });
  };
  const commandLauncher = createWorkflowCommandLauncher({
    pi,
    createObserver(request, preparation) {
      clearWorkflowWidget(request.ctx, WORKFLOW_LIVE_WIDGET_KEY);
      setWorkflowLaunchStatus(request.ctx, request.target?.kind ?? "script", request.target?.ref ?? request.scriptRef);
      if (preparation.hasUI) pinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
      let panel: WorkflowProgressComponent | undefined;
      const cleanupPanel = (): void => {
        if (panel !== undefined) disposePanel(panel);
      };
      const transcript = createWorkflowTranscript(request.ctx, request.scriptRef, "command", {
        ...(request.input === undefined ? {} : { input: request.input }),
      });
      let startedRun: { runId: string; runDir: string } | undefined;
      return {
        onRunStart({ runId, runDir }) {
          startedRun = { runId, runDir };
          sessionRunIds.add(runId);
          const announcement = transcript.start(runId, runDir);
          // The run boundary is published while the session is still idle from
          // the launch check; a busy session gets no banner rather than a
          // steered parent agent.
          if (announcement !== undefined) announceCommandWorkflowStart(pi, request.ctx, announcement);
          if (preparation.hasUI && !panel) {
            panel = installWorkflowProgress(request.ctx, WORKFLOW_LIVE_WIDGET_KEY, request.scriptRef, runId, {
              scope: "workflow",
              declaredStages: preparation.declaredStages,
              ...(request.continuation === undefined
                ? {}
                : { continuationSourceRunId: request.continuation.originRunId }),
            });
            sessionPanels.add(panel);
          }
        },
        onEvent(line) {
          applyWorkflowJournalLineToAgentLiveStore(line, getProjectRoot(request.ctx));
          if (preparation.hasUI) panel?.push(line);
          else setTextWidget(request.ctx, "workflows", renderAgentLiveRowsText());
          transcript.event(line);
          setWorkflowEventStatus(request.ctx, line);
        },
        async onResult(result, isCurrent) {
          completedRunIds.add(result.runId);
          const transcriptCompletion = transcript.finish(result);
          if (preparation.hasUI && panel) {
            panel.finish(result);
            cleanupPanel();
          } else {
            setOperatorWidget(request.ctx, "workflows", buildWorkflowResultBlock(result, request.ctx.mode !== "tui"));
          }
          const published = await persistCommandWorkflowTranscript(pi, request.ctx, transcriptCompletion, isCurrent);
          if (!published && isCurrent()) throw new Error("Workflow terminal receipt was not published.");
        },
        async onError(error, isCurrent) {
          cleanupPanel();
          setOperatorWidget(request.ctx, "workflows", workflowBackgroundFailureBlock(error));
          if (startedRun === undefined) {
            const published = await persistCommandWorkflowRejection(
              pi,
              request.ctx,
              {
                code: "runner_prestart_failed",
                target: request.scriptRef,
                text: `Workflow not started: ${errorMessage(error)}`,
              },
              isCurrent,
            );
            if (!published && isCurrent()) throw new Error("Workflow rejection receipt was not published.");
            return;
          }
          completedRunIds.add(startedRun.runId);
          const published = await persistCommandWorkflowTranscript(
            pi,
            request.ctx,
            transcript.fail(error, startedRun.runId, startedRun.runDir),
            isCurrent,
          );
          if (!published && isCurrent()) throw new Error("Workflow terminal receipt was not published.");
        },
        onFinally() {
          cleanupPanel();
          if (preparation.hasUI) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
        },
        onRejected() {
          if (preparation.hasUI) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
        },
      };
    },
    onTerminal(request, isCurrent) {
      observeHandoffPump(request.ctx, async () => {
        if (!isCurrent()) return { status: "stale" };
        try {
          await request.waitForIdle?.();
        } catch {
          return { status: "busy" };
        }
        return handoffController.pumpAfterActive(request.ctx, { isCurrent, originRunIds: sessionRunIds });
      });
    },
  });
  const handoffService = createWorkflowOperatorHandoffService(commandLauncher);
  handoffController = new WorkflowOperatorHandoffController({
    scan: handoffService.scan,
    read: handoffService.read,
    launch: handoffService.launch,
  });
  const cleanupCompletedRuns = (_ctx: ExtensionContext): boolean => {
    if (completedRunIds.size === 0) return false;
    for (const runId of completedRunIds) pruneCompletedWorkflowRunLiveRows(runId);
    completedRunIds.clear();
    return true;
  };
  const cleanupCompletedSurface = (ctx: ExtensionContext): void => {
    if (commandLauncher.hasActiveCommandRun()) return;
    if (cleanupCompletedRuns(ctx)) clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
    clearWorkflowRunStatus(ctx);
  };
  const cleanupTransientSurface = (ctx: ExtensionContext): void => {
    if (commandLauncher.hasActiveCommandRun()) return;
    cleanupCompletedRuns(ctx);
    clearWorkflowRunStatus(ctx);
  };
  /** Explicit operator surfaces: project-wide, exactly as before. */
  const pumpCurrentHandoffs = (
    ctx: ExtensionContext,
    options: { runId?: string; answer?: string } = {},
  ): Promise<WorkflowHandoffPumpResult> => {
    const lease = commandLauncher.currentLease(ctx);
    if (lease === undefined) return Promise.resolve({ status: "stale" });
    return handoffController.pump(ctx, {
      ...options,
      isCurrent: () => commandLauncher.isCurrent(lease),
    });
  };
  /** Lifecycle surfaces: only the runs this session launched may open a question. */
  const pumpSessionHandoffs = (ctx: ExtensionContext): Promise<WorkflowHandoffPumpResult> => {
    const lease = commandLauncher.currentLease(ctx);
    if (lease === undefined) return Promise.resolve({ status: "stale" });
    return handoffController.pump(ctx, {
      isCurrent: () => commandLauncher.isCurrent(lease),
      originRunIds: sessionRunIds,
    });
  };
  registerTransientUiCleanup(pi, "workflows", cleanupTransientSurface);
  registerTransientUiCleanup(pi, WORKFLOW_LIVE_WIDGET_KEY, cleanupTransientSurface);
  pi.on("turn_end", (_event, ctx) => cleanupCompletedSurface(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    observeHandoffPump(ctx, () => pumpSessionHandoffs(ctx));
  });
  // No handoff pump here on purpose, and the run scope resets to empty: a session
  // opens on the operator's terms. An unanswered question from an earlier session
  // stays readable in its run's evidence and is reopened only when the operator
  // asks (bare `/workflows`, then `continue`, or `/workflows continue <runId>`) —
  // never as a modal the new session starts with, and never on its first settled
  // turn either.
  pi.on("session_start", (_event, ctx) => {
    resetWorkflowLiveExecutions();
    disposeSessionPanels();
    sessionRunIds.clear();
    rememberCompletionContext(ctx);
    commandLauncher.startSession(ctx);
  });
  pi.on("session_shutdown", async (_event, _ctx) => {
    resetWorkflowLiveExecutions();
    disposeSessionPanels();
    await commandLauncher.shutdown();
    unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
  });

  registerWorkflowTool(pi, {
    commandLauncher,
    onRunStarted: (runId) => sessionRunIds.add(runId),
    onRunCompleted: (runId) => completedRunIds.add(runId),
  });
  registerWorkflowSourceCheckTool(pi);
  registerFusionSurface(pi);

  registerWorkflowCommands(pi, {
    commandLauncher,
    pumpCurrentHandoffs,
    rememberCompletionContext,
    completionContext: () => ({
      projectRoot: completionProjectRoot,
      workingDirectory: completionWorkingDirectory,
    }),
    actionableRunIds: (projectRoot) => handoffController.eligibleRunIds(projectRoot),
  });
}
