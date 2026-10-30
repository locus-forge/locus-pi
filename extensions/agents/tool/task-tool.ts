import { Type } from "@sinclair/typebox";
import { safeToolText } from "../../_shared/host/safe-output.js";
import type { ToolResult } from "../../_shared/host/pi-api.js";
/**
 * extensions/agents/tool/task-tool.ts — the canonical spawn-a-subagent tool.
 * It routes through the createAgentSession host + honesty gate.
 */
import { AGENT_SDK_UNAVAILABLE_DIAGNOSTIC } from "../../_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import { pinTransientUiKey, unpinTransientUiKey } from "../../_shared/operator/command-ui.js";
import { resolveLiveModelDisplay } from "../../_shared/model/live-model-display.js";
import {
  loadModelRolesState,
  resolveAgentModelPreference,
  selectDeclaredModelRole,
} from "../../_shared/model/model-settings.js";
import type { ExtensionAPI, ToolUpdate } from "../../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, getSessionId, textResult } from "../../_shared/host/pi-api.js";
import { validateParams } from "../../_shared/host/validation.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { installWorkflowProgress } from "../../workflows/operator/progress-widget.js";
import { EmptyAgentToolCallComponent, renderAgentToolResultCard } from "./agent-tool-card.js";
import { refreshAgents, resolveAgentSelection, TaskParams } from "../catalog/catalog.js";
import { AGENTS_WIDGET_KEY } from "../operator/operator-surface.js";
import {
  INTERACTIVE_AGENT_RUNTIME_MS,
  nextAgentRunSequence,
  resolveAgentTitle,
  runAgentLiveTask,
  trackAgentLaunch,
} from "../run/run-launcher.js";
import { createUnknownAgentReport } from "../run/unknown-agent-report.js";

type TaskToolCtx = Parameters<ExtensionAPI["registerTool"]>[0]["execute"] extends (...args: infer Args) => unknown
  ? Args[4]
  : never;

export function registerAgentSpawnTools(pi: ExtensionAPI): void {
  const launches = new Map<string, { owner: string; terminal: Promise<ToolResult>; result?: ToolResult }>();
  const owner = (ctx: TaskToolCtx) => JSON.stringify([getProjectRoot(ctx), getSessionId(ctx)]);
  pi.on("session_start", () => launches.clear());
  pi.registerTool({
    name: "agent_status",
    description:
      "Read a background spawn handle. wait defaults false; true explicitly waits for that assignment. Never resumes or restarts an agent.",
    parameters: Type.Object({ handle: Type.String({ minLength: 1 }), wait: Type.Optional(Type.Boolean()) }),
    approval: "read",
    execute: async (_id, params, signal, _update, ctx) => {
      const valid = validateParams(
        Type.Object({ handle: Type.String({ minLength: 1 }), wait: Type.Optional(Type.Boolean()) }),
        params,
      );
      if (!valid.ok) return valid.result;
      const record = launches.get(valid.value.handle);
      if (record === undefined || record.owner !== owner(ctx))
        return errorResult("Unknown agent handle for this session.");
      if (valid.value.wait && record.result === undefined) {
        if (signal.aborted) return errorResult("Status wait cancelled; agent continues.");
        let remove = () => {};
        try {
          await Promise.race([
            record.terminal,
            new Promise<void>((resolve) => {
              const abort = () => resolve();
              signal.addEventListener("abort", abort, { once: true });
              remove = () => signal.removeEventListener("abort", abort);
            }),
          ]);
        } finally {
          remove();
        }
        if (signal.aborted) return errorResult("Status wait cancelled; agent continues.");
      }
      if (launches.get(valid.value.handle) !== record || record.owner !== owner(ctx))
        return errorResult("Agent handle expired while waiting; session changed.");
      if (record.result !== undefined)
        return {
          ...record.result,
          content: record.result.content.map((part) =>
            part.type === "text" ? { ...part, text: safeToolText(part.text).text } : part,
          ),
        };
      const row = agentLiveStore.rows.get(valid.value.handle);
      return textResult(`Agent ${valid.value.handle}: ${row?.dispatchedAt === undefined ? "queued" : row.status}.`, {
        handle: valid.value.handle,
        status: row?.dispatchedAt === undefined ? "queued" : row.status,
      });
    },
  });
  const spawnAgentExecute: Parameters<ExtensionAPI["registerTool"]>[0]["execute"] = async (
    _toolCallId,
    params,
    signal,
    update,
    ctx,
  ) => {
    const valid = validateParams(TaskParams, params);
    if (!valid.ok) return valid.result;
    refreshAgents(getProjectRoot(ctx));
    const background = valid.value.background ?? (ctx.mode === "tui" && agentLiveStore.retainSessions);
    const handle = `spawn_agent:${valid.value.agent ?? "bare"}:${nextAgentRunSequence()}`;
    const controller = background ? new AbortController() : undefined;
    if (signal.aborted) return errorResult("Agent launch cancelled before dispatch.");
    const run = runTaskTool(
      pi,
      ctx,
      controller?.signal ?? signal,
      background ? () => {} : update,
      valid.value.agent,
      valid.value.task,
      valid.value.title,
      valid.value.parentContext,
      valid.value.modelRole,
      valid.value.requireModelRole,
      handle,
    );
    if (!background) return run;
    const terminal = trackAgentLaunch(
      controller!,
      run.catch((error) => errorResult(errorMessage(error))),
    );
    const record: { owner: string; terminal: Promise<ToolResult>; result?: ToolResult } = {
      owner: owner(ctx),
      terminal,
    };
    launches.set(handle, record);
    void terminal.then((result) => {
      record.result = result;
      const settled = [...launches.entries()].filter(([, value]) => value.result !== undefined);
      for (const [id] of settled.slice(0, Math.max(0, settled.length - 200))) launches.delete(id);
    });
    return textResult(`Agent queued: ${handle}. Continue working; use agent_status to check or collect the result.`, {
      handle,
      rowId: handle,
      status: "queued",
    });
  };
  pi.registerTool({
    name: "spawn_agent",
    description:
      "Spawn one subagent to run one self-contained task in a headless child session. Omit agent for a clean session, or name a project/user catalog agent. Interactive launches return a queued handle without blocking. Use agent_status to collect; background:false or headless defaults await the child's final text.",
    parameters: TaskParams,
    approval: "exec",
    formatApprovalDetails: taskApprovalDetails,
    // Each spawned agent owns its own transcript block (never folded into another
    // tool's card): a LOCUS rail with petname, live status, task title, and the
    // returned answer marked with a left bar.
    renderShell: "self",
    renderCall: () => new EmptyAgentToolCallComponent(),
    renderResult: renderAgentToolResultCard,
    execute: spawnAgentExecute,
  });
}

function taskApprovalDetails(args: unknown): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const agent = record.agent === undefined ? "bare" : String(record.agent);
  return [`Agent: ${agent}`, "Tasks: 1"];
}

/**
 * Real single-task execution path for the `spawn_agent` tool. One invocation spawns one
 * genuine headless child agent session through the SDK host (the tool-context executor),
 * routed through the same `executeAgentRunBoundary` as the /agent command. Falls
 * back to the honest fail-closed `sdkUnavailableResult` surface only when the SDK
 * host is genuinely unavailable on this machine.
 */
async function runTaskTool(
  pi: ExtensionAPI,
  ctx: TaskToolCtx,
  signal: AbortSignal,
  update: ToolUpdate,
  agentName: string | undefined,
  task: string,
  title: string | undefined,
  parentContext?: { inline?: string; artifactPath?: string },
  modelRole?: string,
  requireModelRole?: boolean,
  suppliedRowId?: string,
) {
  const bare = agentName === undefined;
  const resolution = bare ? undefined : resolveAgentSelection(agentName);
  if (!bare && resolution === undefined) {
    const report = createUnknownAgentReport(ctx, "spawn_agent", agentName);
    return errorResult(report.text, report.details);
  }
  const agentDefault = resolution?.agent.parentContextDefault === true;
  if (requireModelRole === true && modelRole === undefined)
    return errorResult("requireModelRole: true requires modelRole.");
  let modelRoleResolution;
  try {
    if (modelRole !== undefined || resolution !== undefined) {
      const state = await loadModelRolesState(getProjectRoot(ctx));
      modelRoleResolution =
        modelRole !== undefined
          ? selectDeclaredModelRole(state, modelRole, requireModelRole)
          : resolveAgentModelPreference(state, resolution!.agent.model ?? []);
    }
  } catch (error) {
    return errorResult(errorMessage(error));
  }
  if (signal.aborted) return errorResult("Agent launch cancelled before dispatch.");
  const liveModel = resolveLiveModelDisplay({ pi, ctx, assignment: modelRoleResolution?.assignment });
  const executionLabel = resolution?.resolvedAgent ?? "sub-agent";
  const hasUI = ctx.hasUI === true;
  const panel = hasUI
    ? installWorkflowProgress(ctx, "agents", `spawn_agent ${executionLabel}`, "spawn_agent")
    : undefined;
  const rowId = suppliedRowId ?? `spawn_agent:${resolution?.resolvedAgent ?? "bare"}:${nextAgentRunSequence()}`;
  const resolvedTitle = resolveAgentTitle(title, "", task);
  let boundary: Awaited<ReturnType<typeof runAgentLiveTask>>;
  // Pin the "agents" progress key for the duration of the live run so a chat
  // message (which clears transient command UI) cannot dispose the progress
  // widget mid-flight. Unpinned in the finally below, even on throw.
  if (hasUI) pinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  try {
    // Pi native tool approval happens before this handler runs, so the child runs
    // under the already-approved bounds (approvalTier "allow").
    const parentContextBroker = summarizeParentContextBroker(parentContext, agentDefault);
    const common = {
      pi,
      ctx,
      signal,
      rowId,
      label: resolvedTitle,
      title: resolvedTitle,
      task,
      approvalTier: "allow",
      liveModel,
      ...(modelRole === undefined ? {} : { modelRole }),
      ...(modelRoleResolution === undefined ? {} : { modelRoleResolution }),
      childTimeoutMs: INTERACTIVE_AGENT_RUNTIME_MS,
      onStarted: (line: string) =>
        update({
          content: [{ type: "text", text: line }],
          // The card resolves the live row by id while the run is in flight, so
          // the partial update only needs the row identity + static labels.
          details: {
            rowId,
            executionMode: resolution === undefined ? "bare" : "named",
            ...(resolution === undefined ? {} : { agent: resolution.resolvedAgent }),
            title: resolvedTitle,
            status: "running",
          },
        }),
      ...(parentContextBroker.forwarded && parentContext !== undefined ? { parentContext } : {}),
    } as const;
    boundary =
      resolution === undefined
        ? await runAgentLiveTask({ ...common, executionMode: "bare" })
        : await runAgentLiveTask({
            ...common,
            executionMode: "named",
            agent: resolution.agent,
            resolvedAgent: resolution.resolvedAgent,
            modelRoleResolution: modelRoleResolution!,
          });
    if (hasUI) panel?.render(80);
    panel?.finish({ ok: boundary.status === "completed", result: boundary });
  } catch (err) {
    // Agent/host crash mid-run: stop the spinner AND surface a visible error
    // instead of leaving the panel spinning forever (no silent vanish). finish()
    // disposes the live timer and doneLines() renders the "error: <msg>" line.
    panel?.finish({ ok: false, error: errorMessage(err) });
    throw err;
  } finally {
    if (hasUI) unpinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  }
  if (boundary.status === "blocked" && diagnosticsInclude(boundary.diagnostics, AGENT_SDK_UNAVAILABLE_DIAGNOSTIC)) {
    return sdkUnavailableResult(
      resolution === undefined
        ? { executionMode: "bare" }
        : {
            executionMode: "named",
            requestedAgent: resolution.requestedAgent,
            resolvedAgent: resolution.resolvedAgent,
          },
      boundary,
    );
  }
  const parentContextBroker = summarizeParentContextBroker(parentContext, agentDefault);
  // Terminal row facts for the transcript card once the live row is pruned.
  const finishedRow = agentLiveStore.rows.get(rowId);
  const details = {
    owner: "agents-runtime",
    requestedSurface: "spawn_agent",
    executionMode: resolution === undefined ? "bare" : "named",
    ...(resolution === undefined ? {} : { requestedAgent: resolution.requestedAgent, agent: resolution.resolvedAgent }),
    taskCount: 1,
    executor: "agent-sdk-session-host",
    parentContextBroker,
    status: boundary.status,
    rowId,
    title: resolvedTitle,
    ...(finishedRow?.modelRole === undefined ? {} : { modelRole: finishedRow.modelRole }),
    ...(finishedRow?.model === undefined ? {} : { model: finishedRow.model }),
    ...(finishedRow?.thinking === undefined ? {} : { thinking: finishedRow.thinking }),
    ...(finishedRow?.modelConfirmed === undefined ? {} : { modelConfirmed: finishedRow.modelConfirmed }),
    ...(finishedRow?.modelRoleFallback === undefined ? {} : { modelRoleFallback: finishedRow.modelRoleFallback }),
    ...(finishedRow?.displayName === undefined ? {} : { displayName: finishedRow.displayName }),
    ...(finishedRow?.startedAt === undefined ? {} : { startedAt: finishedRow.startedAt }),
    ...(finishedRow?.elapsedMs === undefined ? {} : { elapsedMs: finishedRow.elapsedMs }),
    failureCause: boundary.failureCause,
    errorLogPath: boundary.errorLogPath,
    errorLogWarning: boundary.errorLogWarning,
    errorId: boundary.errorId,
    diagnostics: boundary.diagnostics,
    evidence: boundary.evidence,
    childSessionId: boundary.childSession?.id,
    childOutputStats: boundary.childOutputStats,
    resultArtifact: boundary.resultArtifact?.path,
  };
  // Finished, unstored, and the answer still exists: report the storage failure — this is
  // not a completed run — and hand the caller the answer anyway. Printing only the reason
  // would destroy the last copy of work that was already paid for.
  if (boundary.status === "storage-failed" && boundary.text !== undefined) {
    return errorResult(`${boundary.reason}\n\nAnswer (not stored):\n${boundary.text}`, details);
  }
  if (boundary.status !== "completed" || boundary.text === undefined) {
    return errorResult(boundary.reason, details);
  }
  return textResult(boundary.text, details);
}

function summarizeParentContextBroker(
  parentContext: { inline?: string; artifactPath?: string } | undefined,
  agentDefault: boolean,
) {
  const sources: string[] = [];
  if (parentContext?.inline !== undefined && parentContext.inline.length > 0) sources.push("inline");
  if (parentContext?.artifactPath !== undefined && parentContext.artifactPath.length > 0) sources.push("artifactPath");
  const forwarded = sources.length > 0;
  return { forwarded, sources, agentDefault };
}

function diagnosticsInclude(diagnostics: unknown, token: string): boolean {
  return Array.isArray(diagnostics) && diagnostics.some((entry) => typeof entry === "string" && entry.includes(token));
}

/**
 * Honest fail-closed surface for the `spawn_agent` tool when the installed Pi host
 * genuinely cannot spawn a child agent session (e.g. an older host that does not
 * export `createAgentSession`, or a stripped SDK namespace). The reason reflects
 * the real substrate gap and reuses the per-task diagnostics already gathered —
 * it never claims a replacement session was attempted.
 */
function sdkUnavailableResult(
  resolution:
    | { executionMode: "bare"; requestedAgent?: never; resolvedAgent?: never }
    | { executionMode: "named"; requestedAgent: string; resolvedAgent: string },
  result: Awaited<ReturnType<typeof runAgentLiveTask>>,
) {
  const reason = result.reason || "createAgentSession is unavailable on this host.";
  return errorResult(
    [`Sub-agent execution is unavailable: this Pi host cannot spawn the requested child session.`, reason].join("\n"),
    {
      owner: "agents-runtime",
      requestedSurface: "spawn_agent",
      executionMode: resolution.executionMode,
      ...(resolution.executionMode === "named"
        ? { requestedAgent: resolution.requestedAgent, agent: resolution.resolvedAgent }
        : {}),
      taskCount: 1,
      executor: "agent-sdk-session-host",
      errorLogPath: result.errorLogPath,
      errorLogWarning: result.errorLogWarning,
      resultArtifact: result.resultArtifact?.path,
      failureCause: result.failureCause,
      status: "blocked",
      hostCapability: "agent-sdk-session-unavailable",
      toolExecutorAvailable: false,
      result: {
        status: result.status,
        reason: result.reason,
        diagnostics: result.diagnostics,
        resultArtifact: result.resultArtifact?.path,
      },
      sources: resolution.executionMode === "named" ? ["project/user .agents/agents"] : [],
    },
  );
}
