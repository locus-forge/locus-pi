import { errorMessage } from "../../_shared/host/error-text.js";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getSessionId } from "../../_shared/host/pi-api.js";
import { notifyOperator } from "../../_shared/operator/operator-notify.js";
import type { WorkflowContinuation } from "../runtime/workflow-artifacts.js";
import type { WorkflowHandoffClaimLease } from "../runtime/workflow-handoff.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import {
  runWorkflowScript,
  type RunWorkflowScriptOptions,
  type RunWorkflowScriptResult,
} from "../runtime/workflow-runner.js";
import type { WorkflowHandoffWorkspaceReuseBinding } from "../runtime/workflow-run-resume.js";
import type { ResolvedWorkflowTarget } from "../runtime/workflow-discovery.js";
import {
  workflowBackgroundRunRegistry,
  type WorkflowBackgroundLaunchResult,
  type WorkflowBackgroundRunContext,
  type WorkflowBackgroundRunRegistry,
  type WorkflowBackgroundRunSnapshot,
  type WorkflowBackgroundStopResult,
  type WorkflowSessionLease,
} from "../run/background-run-registry.js";
import { readWorkflowMeta, type WorkflowMetaPhase } from "../catalog/workflow-meta.js";

export interface WorkflowCommandLaunchRequest {
  ctx: ExtensionContext;
  scriptRef: string;
  target?: ResolvedWorkflowTarget;
  /** Preserves name/path intent when preflight failed and the runner must persist the canonical failure. */
  targetKind?: ResolvedWorkflowTarget["kind"];
  input?: string;
  outputDir?: string;
  runName?: string;
  budget?: RunWorkflowScriptOptions["budget"];
  resumeFromRunId?: string;
  recoverInterrupted?: boolean;
  /** Run-level no-operator mode (operator input fails closed). */
  noOperator?: true;
  continuation?: WorkflowContinuation;
  operatorHandoffClaim?: WorkflowHandoffClaimLease;
  operatorHandoffWorkspaceReuse?: WorkflowHandoffWorkspaceReuseBinding;
  waitForIdle?: () => Promise<void>;
}

export type WorkflowCommandLaunchResult =
  { status: "started" } | { status: "busy"; owner: string } | { status: "stale" };

export interface WorkflowCommandLaunchPreparation {
  /** Stage titles plus their planned detail, read statically from `meta.phases`. */
  declaredStages: WorkflowMetaPhase[];
  hasUI: boolean;
}

export interface WorkflowCommandLaunchObserver {
  onRunStart(run: { runId: string; runDir: string }): void;
  onEvent(line: WorkflowJournalLine): void;
  onResult(result: RunWorkflowScriptResult, isCurrent: () => boolean): void | Promise<void>;
  onError(error: unknown, isCurrent: () => boolean): void | Promise<void>;
  onFinally(): void;
  onRejected(): void;
}

export interface WorkflowCommandLauncherOptions {
  pi: ExtensionAPI;
  createObserver(
    request: WorkflowCommandLaunchRequest,
    preparation: WorkflowCommandLaunchPreparation,
  ): WorkflowCommandLaunchObserver;
  onTerminal(request: WorkflowCommandLaunchRequest, isCurrent: () => boolean): void;
  backgroundRuns?: WorkflowBackgroundRunRegistry;
  runScript?: (options: RunWorkflowScriptOptions) => Promise<RunWorkflowScriptResult>;
}

export interface WorkflowCommandLauncher {
  startSession(ctx: ExtensionContext): WorkflowSessionLease;
  currentLease(ctx: ExtensionContext): WorkflowSessionLease | undefined;
  isCurrent(lease: WorkflowSessionLease): boolean;
  hasActiveCommandRun(): boolean;
  launch(request: WorkflowCommandLaunchRequest): WorkflowCommandLaunchResult;
  /**
   * Resolve once the most recently launched command run has settled AND its
   * observer/terminal callbacks have run. A caller with no live surface to watch
   * the run must await this before returning: the host disposes the session at
   * the end of the turn, and a detached run loses the ctx its child sessions
   * need. Resolves immediately when nothing was launched.
   */
  awaitActive(): Promise<void>;
  attach<T>(
    ctx: ExtensionContext,
    hostSignal: AbortSignal,
    execute: (background: WorkflowBackgroundRunContext) => Promise<T>,
  ): WorkflowBackgroundLaunchResult<T>;
  unsettled(lease: WorkflowSessionLease): WorkflowBackgroundRunSnapshot<unknown>[];
  stop(lease: WorkflowSessionLease, selector?: string): WorkflowBackgroundStopResult;
  shutdown(): Promise<void>;
}

export function createWorkflowCommandLauncher(options: WorkflowCommandLauncherOptions): WorkflowCommandLauncher {
  const backgroundRuns = options.backgroundRuns ?? workflowBackgroundRunRegistry();
  let sessionLease: WorkflowSessionLease | undefined;
  let sessionRevoked = false;
  let activeTerminal: Promise<void> | undefined;
  let callbackLease: WorkflowSessionLease | undefined;

  const startSession = (ctx: ExtensionContext): WorkflowSessionLease => {
    sessionRevoked = false;
    sessionLease = backgroundRuns.startSession(getProjectRoot(ctx), workflowSessionId(ctx));
    return sessionLease;
  };
  const currentLease = (ctx: ExtensionContext): WorkflowSessionLease | undefined => {
    if (sessionRevoked) return undefined;
    if (sessionLease === undefined || !backgroundRuns.isCurrent(sessionLease)) return startSession(ctx);
    return sessionLease;
  };

  return {
    startSession,
    currentLease,
    isCurrent: (lease) => backgroundRuns.isCurrent(lease),
    hasActiveCommandRun: () =>
      sessionLease !== undefined &&
      backgroundRuns.isCurrent(sessionLease) &&
      ((callbackLease !== undefined && backgroundRuns.isCurrent(callbackLease)) ||
        backgroundRuns.active(sessionLease) !== undefined),
    launch(request) {
      const lease = currentLease(request.ctx);
      if (lease === undefined) return { status: "stale" };
      if (callbackLease !== undefined && backgroundRuns.isCurrent(callbackLease)) {
        return { status: "busy", owner: "settling workflow callbacks" };
      }
      const active = backgroundRuns.active(lease);
      if (active !== undefined) return { status: "busy", owner: active.runId ?? active.launchId };

      const observer = options.createObserver(request, {
        hasUI: request.ctx.hasUI === true,
        declaredStages: request.target === undefined ? [] : readWorkflowMeta(request.target.path).phases,
      });
      const launched = backgroundRuns.launch<RunWorkflowScriptResult>(lease, async (background) => {
        const isCurrent = (): boolean => background.isCurrent();
        const targetKind = request.target?.kind ?? request.targetKind ?? "name";
        const scriptInput =
          targetKind === "scriptPath" ? { scriptPath: request.scriptRef } : { name: request.scriptRef };
        return await (options.runScript ?? runWorkflowScript)({
          pi: options.pi,
          ctx: request.ctx,
          signal: background.signal,
          ...scriptInput,
          ...(request.input === undefined ? {} : { input: request.input }),
          ...(request.outputDir === undefined ? {} : { outputDir: request.outputDir }),
          ...(request.runName === undefined ? {} : { runName: request.runName }),
          ...(request.budget === undefined ? {} : { budget: request.budget }),
          ...(request.resumeFromRunId === undefined ? {} : { resumeFromRunId: request.resumeFromRunId }),
          ...(request.recoverInterrupted === undefined ? {} : { recoverInterrupted: request.recoverInterrupted }),
          ...(request.noOperator === undefined ? {} : { noOperator: request.noOperator }),
          ...(request.continuation === undefined ? {} : { continuation: request.continuation }),
          ...(request.operatorHandoffClaim === undefined ? {} : { operatorHandoffClaim: request.operatorHandoffClaim }),
          ...(request.operatorHandoffWorkspaceReuse === undefined
            ? {}
            : { operatorHandoffWorkspaceReuse: request.operatorHandoffWorkspaceReuse }),
          ...(request.target === undefined ? {} : { targetBinding: request.target }),
          onRunStart: ({ runId, runDir }) => {
            background.setRunId(runId);
            if (isCurrent()) observer.onRunStart({ runId, runDir });
          },
          onEvent: (line) => {
            if (isCurrent()) observer.onEvent(line);
          },
        });
      });
      if (!launched.ok) {
        observer.onRejected();
        return launched.reason === "stale-lease"
          ? { status: "stale" }
          : { status: "busy", owner: launched.active?.runId ?? launched.active?.launchId ?? "current run" };
      }
      callbackLease = lease;
      activeTerminal = launched.run.terminal.then(async (settlement) => {
        const isCurrent = (): boolean => backgroundRuns.isCurrent(lease);
        let terminalReceiptPublished = false;
        try {
          if (!isCurrent()) return;
          if (settlement.status === "fulfilled") await observer.onResult(settlement.value, isCurrent);
          else await observer.onError(settlement.error, isCurrent);
          terminalReceiptPublished = true;
        } finally {
          try {
            if (isCurrent()) observer.onFinally();
          } finally {
            try {
              // A command handoff may pump only after its observer confirms
              // that the authoritative terminal receipt was published.
              if (terminalReceiptPublished && isCurrent()) options.onTerminal(request, isCurrent);
            } finally {
              if (callbackLease === lease) callbackLease = undefined;
            }
          }
        }
      });
      void activeTerminal.catch((error) => {
        if (backgroundRuns.isCurrent(lease)) {
          notifyOperator(request.ctx, `Workflow terminal callback failed: ${errorMessage(error)}`, "error");
        }
      });
      return { status: "started" };
    },
    async awaitActive() {
      // A detached handler above owns unhandled-rejection safety. Attached
      // callers still observe callback failure through this original promise.
      await activeTerminal;
    },
    attach<T>(
      ctx: ExtensionContext,
      hostSignal: AbortSignal,
      execute: (background: WorkflowBackgroundRunContext) => Promise<T>,
    ) {
      const lease = currentLease(ctx);
      return lease === undefined
        ? ({ ok: false, reason: "stale-lease" } as const)
        : backgroundRuns.attach(lease, hostSignal, execute);
    },
    unsettled: (lease) => backgroundRuns.unsettled(lease),
    stop: (lease, selector) => backgroundRuns.stop(lease, selector),
    async shutdown() {
      sessionRevoked = true;
      const unsettled = sessionLease === undefined ? [] : backgroundRuns.unsettled(sessionLease);
      if (sessionLease !== undefined) backgroundRuns.shutdown(sessionLease);
      // Pi awaits session_shutdown before exiting. Revocation cancels children
      // and suppresses stale UI callbacks; keep the host alive until the runner
      // has persisted its terminal result, including tool-owned attached runs.
      await Promise.all(unsettled.map((run) => run.terminal));
    },
  };
}

function workflowSessionId(ctx: ExtensionContext): string {
  const sessionId = getSessionId(ctx);
  return sessionId.trim() === "" ? "unknown-session" : sessionId;
}
