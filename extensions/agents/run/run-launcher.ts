/**
 * extensions/agents/run/run-launcher.ts — the single start-a-run pipeline behind both
 * agent triggers: `runAgentLiveTask` (the live row + SDK child + terminal patch)
 * plus the `/agent run` slash wrapper that installs the progress panel around it.
 * The `spawn_agent` tool is the other client (see task-tool.ts).
 */
import {
  createBareAgentRunRequest,
  createAgentRunRequest,
  executeAgentRunBoundary,
  type ApprovalTier,
} from "../../_shared/agent-runtime/agent-runner.js";
import { createAgentSdkSessionExecutor } from "../../_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../_shared/agent-runtime/agent-live-store.js";
import {
  formatAgentFinishedEventLine,
  formatAgentStartedEventLine,
} from "../../_shared/agent-runtime/agent-live-panel.js";
import { pinTransientUiKey, unpinTransientUiKey } from "../../_shared/operator/command-ui.js";
import { resolveLiveModelDisplay } from "../../_shared/model/live-model-display.js";
import {
  formatAssignment,
  loadModelRolesState,
  resolveAgentModelPreference,
  malformedRoleAssignmentNote,
  unassignedAgentTierNote,
  type ModelRoleResolution,
} from "../../_shared/model/model-settings.js";
import { resolveWorkflowModel } from "../../_shared/model/workflow-model-resolve.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../_shared/host/pi-api.js";
import type { AgentDefinition } from "../../_shared/agent-runtime/agents.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import { appendProjectError } from "../../_shared/host/error-journal.js";
import { getProjectRoot, getSessionId } from "../../_shared/host/pi-api.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { installWorkflowProgress } from "../../workflows/operator/progress-widget.js";
import { resolveAgentSelection } from "../catalog/catalog.js";
import type { CommandApprovalTier } from "../command/command-parser.js";
import { AGENTS_WIDGET_KEY, emitAgentEventLine } from "../operator/operator-surface.js";
import { agentRunBoundaryBlock } from "../operator/operator-ui.js";
import { createUnknownAgentReport } from "./unknown-agent-report.js";

/** Monotonic suffix so repeated `/agent run` of the same agent get distinct rows. */
let agentRunSeq = 0;

/** Shared by both triggers so a task row and a run row can never collide. */
export function nextAgentRunSequence(): number {
  return ++agentRunSeq;
}

/** One hour for a standalone task; turns and tool calls remain unbounded.
 * The SDK receives this runtime budget as its single child wall-clock deadline.
 * Policy: docs/workflows/budgets.md#run-budget.
 */
export const INTERACTIVE_AGENT_RUNTIME_MS = 60 * 60 * 1000;

interface AgentLiveTaskBaseInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  rowId: string;
  label: string;
  title: string;
  task: string;
  approvalTier: ApprovalTier;
  liveModel: { model?: string; thinking?: string } | undefined;
  /** Explicit wall clock for this whole interactive child. */
  childTimeoutMs: number;
  onStarted?: (line: string) => void;
  parentContext?: { inline?: string; artifactPath?: string };
}

export type AgentLiveTaskInput = AgentLiveTaskBaseInput &
  (
    | { executionMode: "bare"; agent?: never; resolvedAgent?: never; modelRoleResolution?: never }
    | {
        executionMode: "named";
        agent: AgentDefinition;
        resolvedAgent: string;
        modelRoleResolution: ModelRoleResolution;
      }
  );

/**
 * Single source of truth for running ONE catalog agent as a live row (T-188 W2).
 * Both the `task`/`spawn_agent` tool loop and the `/agent run` slash command call
 * this, so the two triggers produce identical `agentLiveStore` rows and panel
 * output (Q8 parity is structural, not incidental). It creates/updates the row,
 * drives the SDK headless child through the shared boundary, and patches the
 * terminal state. It does NOT own the widget/panel or the aggregation — callers do.
 */
export async function runAgentLiveTask(
  input: AgentLiveTaskInput,
): Promise<Awaited<ReturnType<typeof executeAgentRunBoundary>>> {
  const { ctx, rowId, label, title, liveModel } = input;
  const execution = agentLiveStore.beginExecution({
    id: rowId,
    ...(input.executionMode === "named" ? { agentName: input.resolvedAgent } : {}),
    label,
    title,
    request: input.task,
    ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
    ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
    isolated: false,
    noMcp: false,
  });
  const startedRow = agentLiveStore.rowForExecution(execution);
  // REQ-011: append-only transcript event line at kickoff.
  if (startedRow !== undefined) {
    const startedLine = formatAgentStartedEventLine(startedRow);
    input.onStarted?.(startedLine);
    emitAgentEventLine(ctx, startedLine, "info");
  }
  // Parity with the workflow bridge (OD2): `/agent run reviewer` and a workflow stage
  // naming `reviewer` resolve their model the same way, so the same agent cannot run
  // on two different models with nothing in the evidence to explain why. The
  // precedence is identical — the agent's resolved tier, then the parent session
  // model — and an unresolvable CONCRETE selector fails the run by name rather than
  // silently inheriting. This is the one call site both interactive triggers share.
  const tier =
    input.executionMode === "named" ? await resolveAgentExecutorModel(ctx, input.agent, input.modelRoleResolution) : {};
  if (tier.refusal !== undefined) {
    if (input.executionMode !== "named") throw new Error("bare execution cannot produce a profile refusal");
    // The refusal lands before any session is created, so the row's seeded
    // `model`/`thinking` are the REQUEST talking to itself. Leaving them on a terminal
    // row shows an operator a model that never ran and cannot be told apart from one
    // that ran and failed, so the labels go with the same model-free patch the host
    // uses for its own pre-execution exits.
    agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
      status: "error",
      errors: [tier.refusal],
      finalAnswer: tier.refusal,
    });
    return recordStandaloneFailure(input, {
      status: "failed",
      executionMode: "named",
      agentName: input.agent.name,
      reason: tier.refusal,
      diagnostics: [tier.refusal],
      lifecycleEntryIds: [],
    });
  }
  const executor = createAgentSdkSessionExecutor({
    model: tier.model ?? (ctx as { model?: unknown }).model,
    childTimeoutMs: input.childTimeoutMs,
    live: {
      rowId,
      label,
      title,
      ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
      ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
    },
    liveExecution: execution,
  });
  const requestInput = {
    approvalTier: input.approvalTier,
    // Travels on the request for the same reason it does in the bridge: the
    // run-result artifact is written inside the boundary. `writeAgentRunResultArtifact`
    // only promotes it once `executedModel` is set — i.e. after the child was actually
    // prompted — so a run that died in setup records no degradation it cannot prove.
    ...(tier.fallback !== undefined ? { modelRoleFallback: tier.fallback } : {}),
    ...(input.parentContext !== undefined ? { parentContext: input.parentContext } : {}),
  };
  const request =
    input.executionMode === "named"
      ? createAgentRunRequest(input.agent, input.task, {
          ...requestInput,
          modelRoleResolution: input.modelRoleResolution,
        })
      : createBareAgentRunRequest(input.task, requestInput);
  let boundary: Awaited<ReturnType<typeof executeAgentRunBoundary>>;
  try {
    boundary = await executeAgentRunBoundary({ pi: input.pi, ctx, request, executor, signal: input.signal });
  } catch (err) {
    recordStandaloneFailure(input, {
      status: "failed",
      reason: errorMessage(err),
      diagnostics: [],
      lifecycleEntryIds: [],
    });
    throw err;
  }
  if (boundary.status !== "completed") boundary = recordStandaloneFailure(input, boundary);
  // A run whose envelope could not be stored is NOT a done run — it prints as the storage
  // failure it is, through the same failure receipt as every other non-completion. What it
  // is also not is a lost answer: the child answered, so the row keeps that answer and the
  // storage reason travels in `errors` beside it, instead of overwriting the one copy of
  // the result the operator still has.
  const answerSurvivedStorageFailure = boundary.status === "storage-failed" && boundary.resultStorage?.answerAvailable;
  const finishedRow = agentLiveStore.patchExecution(execution, {
    status: boundary.status === "completed" ? "done" : boundary.status === "cancelled" ? "cancelled" : "error",
    ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
    ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
    finalAnswer: answerSurvivedStorageFailure === true && boundary.text !== undefined ? boundary.text : boundary.reason,
    errors: boundary.status === "completed" ? [] : [boundary.reason, ...boundary.diagnostics],
  });
  // REQ-011: append-only transcript event line at completion (finished / error).
  if (finishedRow !== undefined && boundary.status === "completed") {
    emitAgentEventLine(ctx, formatAgentFinishedEventLine(finishedRow), "info");
  }
  return boundary;
}

/** Final standalone facts only. Workflow children are indexed by their own journal owner. */
function recordStandaloneFailure(
  input: AgentLiveTaskInput,
  result: Awaited<ReturnType<typeof executeAgentRunBoundary>>,
): Awaited<ReturnType<typeof executeAgentRunBoundary>> {
  const row = agentLiveStore.rows.get(input.rowId);
  const parentSessionId = getSessionId(input.ctx);
  const receipt = appendProjectError(getProjectRoot(input.ctx), {
    ts: new Date().toISOString(),
    source: "agent",
    event: "agent_result",
    status: result.status,
    message: result.reason,
    cause: result.failureCause,
    agent: result.agentName ?? input.resolvedAgent,
    displayName: row?.displayName,
    title: input.title,
    callId: input.rowId,
    sessionId: result.childSession?.id,
    parentSessionId: parentSessionId === "unknown-session" ? undefined : parentSessionId,
    resultPath: result.resultArtifact?.path,
    transcriptPath: result.childTrace?.path,
  });
  const details = result.resultArtifact?.path ?? result.childTrace?.path;
  emitAgentEventLine(
    input.ctx,
    [
      `Agent ${row?.displayName ?? result.agentName ?? "(unnamed)"} ${result.status}: ${result.reason}`,
      `task: ${input.title}`,
      ...(result.failureCause === undefined ? [] : [`cause: ${result.failureCause}`]),
      ...(details === undefined ? [] : [`details: ${details}`]),
      `errors: ${receipt.path}`,
      ...(receipt.warning === undefined ? [] : [receipt.warning]),
    ].join("\n"),
    result.status === "cancelled" ? "warning" : "error",
  );
  return {
    ...result,
    errorLogPath: receipt.path,
    ...(receipt.id === undefined ? {} : { errorId: receipt.id }),
    ...(receipt.warning === undefined ? {} : { errorLogWarning: receipt.warning }),
  };
}

/**
 * The interactive half of the tier chain.
 *
 * The workflow bridge owns the full three-term precedence because only a workflow
 * call can declare a per-call `model` / `modelRole`. An interactive child has no
 * call site to declare one, so the chain here is the agent's own resolved tier, then
 * the session model. The two asymmetric outcomes are the same as the bridge's: a
 * concrete selector that does not resolve refuses by name, an unassigned role
 * inherits (OD5).
 */
async function resolveAgentExecutorModel(
  ctx: ExtensionContext,
  agent: AgentDefinition,
  resolution: ModelRoleResolution,
): Promise<{ model?: unknown; refusal?: string; fallback?: string }> {
  if (resolution.malformed !== undefined) {
    // Same rule as the bridge (OD2 parity): a malformed assignment is a config error
    // and refuses, only a genuinely unassigned role degrades.
    return {
      refusal: malformedRoleAssignmentNote(
        agent.model?.[0] ?? resolution.role,
        `agent "${agent.name}" frontmatter model`,
        resolution.malformed,
      ),
    };
  }
  if (resolution.assignment === undefined) {
    // OD5's other half: the degrade is quiet, the RECORD is loud. An interactive
    // child that silently drops to the session model with nothing written down is
    // the same unexplained-model problem OD2 asked us to close for `/agent run` and
    // `spawn_agent`, so the note the bridge writes is written here too. The roles
    // state is re-read only on this path, so the common case pays nothing.
    const declared = agent.model?.[0];
    if (declared === undefined) return {};
    return {
      fallback: unassignedAgentTierNote(agent.name, declared, resolution, await loadModelRolesState()),
    };
  }
  const resolved = await resolveWorkflowModel(formatAssignment(resolution.assignment), ctx);
  if (resolved.ok) return { model: resolved.model };
  return {
    refusal:
      `Agent "${agent.name}" declares the model ${JSON.stringify(agent.model?.[0] ?? resolution.role)}, ` +
      `resolved to ${JSON.stringify(formatAssignment(resolution.assignment))} by the ${resolution.source} layer, ` +
      `but that ${resolved.message}`,
  };
}

/**
 * Resolve the live-row title (REQ-003): explicit `title` wins, else the UI label,
 * else the first words of the prompt; the result is clamped to ≤128 characters.
 * Narrow surfaces (fleet rows) truncate further at render time, so the stored
 * title can stay long enough for the transcript card and drill header.
 */
export function resolveAgentTitle(explicit: string | undefined, fallbackLabel: string, prompt: string): string {
  const fromExplicit = explicit?.trim();
  if (fromExplicit !== undefined && fromExplicit !== "") return clampTitle(fromExplicit);
  const fromLabel = fallbackLabel.trim();
  if (fromLabel !== "") return clampTitle(fromLabel);
  return clampTitle(headOfPrompt(prompt));
}

const AGENT_TITLE_MAX_COLS = 128;

function clampTitle(value: string): string {
  if (value.length <= AGENT_TITLE_MAX_COLS) return value;
  return `${value.slice(0, AGENT_TITLE_MAX_COLS - 1).trimEnd()}…`;
}

function headOfPrompt(prompt: string): string {
  const firstLine = (prompt.split(/\r?\n/, 1)[0] ?? "").trim();
  return firstLine
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 8)
    .join(" ");
}

/**
 * `/agent run` — the single-agent slash trigger. T-188 W2: it is now a client of
 * the shared live-row model (agentLiveStore + the AgentLivePanel installed by
 * installWorkflowProgress), exactly like the `task`/`spawn_agent` tool. There is
 * no replacement-session transcript switch (the T-187 root cause of "who is
 * working?", the upward jump, and `drill last → not found`): the run streams into
 * the live panel above the editor, its row survives for `/agent drill`, and the
 * detailed flow goes through drill + the JSONL journal.
 */
export async function executeAgentRunCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
  task: string,
  approvalTier: CommandApprovalTier = "prompt",
  title?: string,
): Promise<void> {
  const resolution = resolveAgentSelection(name);
  if (resolution === undefined) {
    const report = createUnknownAgentReport(ctx, "agent-run", name);
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, report.block);
    return;
  }
  const { agent, resolvedAgent } = resolution;
  const modelRoles = await loadModelRolesState();
  const modelRoleResolution = resolveAgentModelPreference(modelRoles, agent.model ?? []);
  const liveModel = resolveLiveModelDisplay({ pi, ctx, assignment: modelRoleResolution.assignment });
  const hasUI = ctx.hasUI === true;
  const panel = hasUI ? installWorkflowProgress(ctx, AGENTS_WIDGET_KEY, `run ${resolvedAgent}`, "agent") : undefined;
  if (hasUI) pinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  const controller = new AbortController();
  try {
    const boundary = await runAgentLiveTask({
      pi,
      ctx,
      signal: controller.signal,
      executionMode: "named",
      agent,
      resolvedAgent,
      rowId: `run:${resolvedAgent}:${nextAgentRunSequence()}`,
      label: task,
      title: resolveAgentTitle(title, "", task),
      task,
      approvalTier,
      liveModel,
      modelRoleResolution,
      childTimeoutMs: INTERACTIVE_AGENT_RUNTIME_MS,
    });
    if (hasUI) {
      panel?.render(80);
      panel?.finish({
        ok: boundary.status === "completed",
        result: { status: boundary.status, summary: boundary.reason },
      });
    } else {
      // Headless host: no live panel, so surface the honest settled result.
      setOperatorWidget(ctx, AGENTS_WIDGET_KEY, agentRunBoundaryBlock(boundary));
    }
  } catch (err) {
    const message = errorMessage(err);
    if (hasUI) panel?.finish({ ok: false, error: message });
    else
      setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
        type: "ERROR",
        subject: "Agent run",
        primary: `Agent ${resolvedAgent}: error`,
        body: [`Reason: ${message}`],
        controls: ["Recovery: inspect the live row with /agent drill last, then retry."],
      });
    throw err;
  } finally {
    if (hasUI) unpinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  }
}
