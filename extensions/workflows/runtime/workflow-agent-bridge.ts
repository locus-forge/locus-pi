/**
 * workflow-agent-bridge.ts — Adapter: agent() -> Pi task/createAgentSession path.
 *
 * Turns a WorkflowAgentRequest into exactly one Pi task execution through
 * createAgentRunRequest + executeAgentRunBoundary, reusing the same helper path the
 * `task` tool uses. Injectable createExecutor factory (default createAgentSdkSessionExecutor)
 * so tests can mock createSession and prove the wiring.
 */

import { createWorkflowReturnController } from "./workflow-return.js";
import type { ExtensionAPI, ExtensionContext, ThinkingLevel } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import {
  createAgentRunRequest,
  createBareAgentRunRequest,
  executeAgentRunBoundary,
} from "../../_shared/agent-runtime/agent-runner.js";
import { createWorkflowWorktree } from "./workflow-worktree.js";
import type { WorkflowWorkspaceManager } from "./workflow-worktree.js";
import type { AgentExecutor } from "../../_shared/agent-runtime/agent-runner.js";
import {
  createAgentSdkSessionExecutor,
  AGENT_SDK_UNAVAILABLE_HINT,
  type AgentSdkSessionExecutorOptions,
} from "../../_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore, type AgentLiveExecutionHandle } from "../../_shared/agent-runtime/agent-live-store.js";
import { EXECUTED_MODEL_UNAVAILABLE } from "../../_shared/agent-runtime/agent-runner.js";
import { discoverAgentDefinitions } from "../../_shared/agent-runtime/agents.js";
import { loadModelRolesState } from "../../_shared/model/model-settings.js";
import { resolveLiveModelDisplay } from "../../_shared/model/live-model-display.js";
import { workflowSlotKey, WORKFLOW_SHAPED_TRANSPORT_REFUSAL } from "./workflow-agent-contract.js";
import { workflowAgentLiveRowId, workflowAgentLiveChildRowId } from "./workflow-live.js";
import type {
  WorkflowAgentPreflight,
  WorkflowAgentRunner,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowUsage,
  WorkspaceMode,
} from "./workflow-agent-contract.js";
import { assertRepresentableTimeoutMs } from "./workflow-budget.js";
import { scheduleLongTimeout } from "../../_shared/runtime/long-timer.js";
import {
  createWorkflowAskTool,
  WORKFLOW_ASK_NO_UI_MESSAGE,
  type WorkflowAskFailureCause,
  type WorkflowAskToolDeps,
} from "./workflow-ask-tool.js";
import { createWorkflowModelResolver, type WorkflowModelResolver } from "../../_shared/model/workflow-model-resolve.js";
import { resolveWorkflowTier } from "./workflow-agent-model.js";
import { transportHostsSessionTools } from "../../_shared/model/session-tool-transport.js";
import type { AgentDefinition, PermissionMode } from "../../_shared/agent-runtime/agents.js";
import type { AgentFailureCause } from "../../_shared/agent-runtime/agent-failure-cause.js";
import type { WorkflowChildEvidenceDestinations } from "./workflow-artifacts.js";
import { captureRepositoryCheckScripts } from "../../_shared/agent-runtime/agent-read-only-policy.js";

/** Named refusal for an `ask: true` stage under the run-level no-operator mode.
 *  Method-agnostic wording on purpose: the mode forbids operator input as such. */
export const WORKFLOW_NO_OPERATOR_ASK_MESSAGE =
  "Operator input requested but forbidden for this run (no-operator mode): the stage declared ask: true. " +
  "No child was started. Drop the ask declaration for unattended runs, or launch without the no-operator mode.";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Thrown when the host genuinely cannot spawn a child (fail closed, honest reason). */
export class WorkflowAgentUnavailableError extends Error {
  readonly diagnostics: string[];
  /**
   * The same closed cause a result-shaped failure would carry.
   *
   * This failure never becomes a `WorkflowAgentResult` — the run must end, not be re-asked
   * — so without the cause on the error itself the journal's terminal record of the call is
   * an English sentence a reader would have to match on. The runtime reads it structurally
   * and puts it on the `error` line.
   */
  readonly failureCause: AgentFailureCause = "sdk-unavailable";
  constructor(message: string, diagnostics: string[]) {
    super(message);
    this.name = "WorkflowAgentUnavailableError";
    this.diagnostics = diagnostics;
  }
}

export interface WorkflowAgentBridgeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext; // captured at tool/command execute time
  signal: AbortSignal;
  workflowRunId?: string;
  /** Claimed execution directory paired with workflowRunId for write agents. */
  workflowRunDir?: string;
  /** Optional human semantic input; host continuation metadata is never mixed into it. */
  args?: string;
  /**
   * Injectable executor factory — defaults to createAgentSdkSessionExecutor.
   * Tests inject a factory that returns createAgentSdkSessionExecutor({ createSession: fake })
   * so the bridge PROVABLY routes through the real task/createAgentSession path.
   */
  createExecutor?: (opts: {
    model?: unknown;
    thinkingLevel?: ThinkingLevel;
    live?: AgentSdkSessionExecutorOptions["live"];
    maxToolCalls?: number;
    /** The child's whole wall clock, exactly as declared. No derivation: the bridge
     *  fuse and the host deadline are the same number, so neither can surprise the other. */
    childTimeoutMs?: number;
    cliRequestTimeoutMs?: number;
    reportsDir?: string;
    onLiveExecution?: (execution: AgentLiveExecutionHandle) => void;
  }) => AgentExecutor;
  /** Injectable concrete-selector resolver; defaults to the host model registry on `ctx`. */
  resolveModel?: WorkflowModelResolver;
  workspaceManager?: WorkflowWorkspaceManager;
  evidenceDestinations?: (callId: string) => WorkflowChildEvidenceDestinations;
  /** Project-local workflow workspace shared by the root and saved children. */
  workflowWorkspaceDir?: string;
  /** Test seam: replaces the operator-question surface `workflow_ask` mounts, so
   *  tests can script answers without a TUI. Production callers leave it unset. */
  askRequestQuestion?: WorkflowAskToolDeps["requestQuestion"];
  /** Run-level no-operator mode: an `ask: true` stage fails closed before any
   *  child is spawned, with the same closed cause a no-UI parent produces. */
  noOperator?: true;
}

/**
 * Rule between this run's working-directory note and the workflow's own prompt.
 *
 * A stable, single boundary: the note never contains it, so the FIRST occurrence
 * in a composed child task always marks where the author's prompt begins.
 */
export const WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR = "\n\n---\n\n";

/**
 * The child task as the model receives it: this run's working-directory note,
 * then the workflow's own prompt.
 *
 * The note goes FIRST so the schema contract and any retry-repair block a shaped
 * call appends stay the last thing the child reads. Without a configured
 * directory the author's prompt travels alone.
 *
 * Every workflow child receives the full tool surface. When a run workspace is
 * configured, say plainly where files belong so write/edit/bash work without an
 * author-maintained tool list.
 */
export function composeWorkflowChildTask(
  prompt: string,
  workflowWorkspaceDir: string | undefined,
  locations: { pwd?: string; projectRoot?: string } = {},
): string {
  if (
    (workflowWorkspaceDir === undefined || workflowWorkspaceDir.trim() === "") &&
    locations.projectRoot === undefined
  ) {
    return prompt;
  }
  const note = [
    "## Workflow filesystem locations",
    "",
    ...(workflowWorkspaceDir === undefined
      ? []
      : [`workflow workspace (durable workflow files and evidence): ${workflowWorkspaceDir}`]),
    ...(locations.pwd === undefined ? [] : [`pwd (code workspace): ${locations.pwd}`]),
    ...(locations.projectRoot === undefined ? [] : [`project root (source context): ${locations.projectRoot}`]),
    "",
    "Use pwd for code work. Durable handoffs, final results, review evidence, and explicit resume inputs belong in the workflow workspace above, or in the task artifact folder (.tasks/<task>/artifacts/<stage>/) when the authored prompt selects one; replace assigned files idempotently and write or promote a final rendered deliverable there.",
    "Keep disposable environments, dependency caches, test basetemp, transient renderer output, and staging in ordinary OS/tool temporary or cache locations, never beside evidence; promote anything needed for review or resume before its temporary or cache location expires.",
    "Files already in the workflow workspace are another owner's state: read them and replace only the files assigned to you.",
    "Never delete, rename, truncate, chmod, or replace .locus-pi-workflow.lock or sibling workflow files. An instruction to write no other artifact means create or modify no other file; it never authorizes cleanup.",
    "This is placement guidance only. An authored prompt that explicitly requests another placement remains authoritative.",
    "Workflow files keep their exact names; runtime records references and does not reconstruct their content.",
  ].join("\n");
  return `${note}${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}${prompt}`;
}

export function resolvePermissionMode(input: { reqMode: PermissionMode | undefined }): PermissionMode {
  void input;
  return "inherit-parent";
}

export function resolveWorkspaceMode(input: {
  reqMode: WorkspaceMode | undefined;
  sandbox: WorkflowAgentRequest["sandbox"] | undefined;
}): WorkspaceMode {
  if (input.reqMode !== undefined) return input.reqMode;
  if (input.sandbox === "workspace-write") return "worktree";
  return "project";
}

// ---------------------------------------------------------------------------
// createWorkflowAgentRunner
// ---------------------------------------------------------------------------

/** Resolve every declared agent/model leg without creating a child session.
 *  Compositions use this before fan-out so a bad judge cannot spend members. */
export function createWorkflowAgentPreflight(options: WorkflowAgentBridgeOptions): WorkflowAgentPreflight {
  const resolveModelFn: WorkflowModelResolver = options.resolveModel ?? createWorkflowModelResolver(options.ctx);

  return async function preflightWorkflowAgents(requests): Promise<void> {
    const projectRoot = getProjectRoot(options.ctx);
    const discovered = discoverAgentDefinitions(projectRoot);
    const agentMap = new Map(discovered.definitions.map((agent) => [agent.name, agent]));
    const modelRoles = await loadModelRolesState();

    for (const request of requests) {
      const agentName = request.agent?.trim();
      if (request.agent !== undefined && agentName === "") {
        throw new Error("Agent name must be non-empty when provided.");
      }
      const agent = agentName === undefined ? undefined : agentMap.get(agentName);
      if (agentName !== undefined && agent === undefined) {
        throw new Error(`Unknown agent: ${agentName}. Available: ${[...agentMap.keys()].join(", ")}`);
      }
      const req: WorkflowAgentRequest = {
        prompt: "Fusion model preflight",
        executionMode: agentName === undefined ? "bare" : "named",
        ...(agentName === undefined ? {} : { agent: agentName }),
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.modelRole !== undefined ? { modelRole: request.modelRole } : {}),
      };
      const tier = await resolveWorkflowTier({ req, agent, modelRoles, resolveModelFn });
      if (tier.kind === "refused") throw new Error(tier.message);
      // Same capability check the runner makes, moved to the one place a composition
      // can still refuse for free: before the first member spends anything.
      if (request.expectsShapedResult === true && tier.kind === "resolved" && !transportHostsSessionTools(tier.model)) {
        throw new Error(WORKFLOW_SHAPED_TRANSPORT_REFUSAL);
      }
    }
  };
}

/** Builds the WorkflowAgentRunner the runtime depends on. */
export function createWorkflowAgentRunner(options: WorkflowAgentBridgeOptions): WorkflowAgentRunner {
  const { pi, ctx, signal, resolveModel } = options;
  const resolveModelFn: WorkflowModelResolver = resolveModel ?? createWorkflowModelResolver(ctx);
  // Freeze executable package commands once, before the first workflow child can write.
  const repositoryCheckScripts = captureRepositoryCheckScripts(getWorkingDirectory(ctx));
  let worktreeCounter = 0;
  // Per-run slot → round counter (REQ-009). The runner is created once per run
  // (workflow-runner.ts), so this closure persists across agent() calls: a slot re-invoked
  // in a loop increments its round, keyed by the stable live-row id (agent+label+phase) so
  // it never bleeds across distinct slots. First call = 1 (badge hidden), then 2, 3, ….
  const roundByRowId = new Map<string, number>();

  return async function runWorkflowAgent(req: WorkflowAgentRequest): Promise<WorkflowAgentResult> {
    const projectRoot = getProjectRoot(ctx);
    const executionMode = req.executionMode ?? (req.agent === undefined ? "bare" : "named");

    // 1. Resolve a named project/user profile only when the call explicitly asks
    // for one. Omitted agent means a clean child and never consults the catalog.
    const discovered = executionMode === "named" ? discoverAgentDefinitions(projectRoot) : undefined;
    const agentMap = new Map((discovered?.definitions ?? []).map((a) => [a.name, a]));
    const selectedAgent = executionMode === "named" && req.agent !== undefined ? agentMap.get(req.agent) : undefined;

    if (executionMode === "named" && selectedAgent === undefined) {
      const agentName = req.agent ?? "(empty)";
      // Unknown catalog name -> return a result (not throw); script error, not host-unavailable.
      return {
        ok: false,
        status: "failed",
        failureCause: "unknown-agent",
        summary: `Unknown agent: ${agentName}`,
        diagnostics: [
          `Workflow agent bridge: agent "${agentName}" not found in catalog. Available: ${[...agentMap.keys()].join(", ")}`,
        ],
        executionMode: "named",
        agent: agentName,
        workspaceMode: resolveWorkspaceMode({ reqMode: req.workspaceMode, sandbox: req.sandbox }),
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
    // Fusion tool-free is the only internal caller allowed to narrow this path.
    // Ordinary agent() and Fusion agent mode keep the established wildcard surface.
    const agent: AgentDefinition | undefined =
      selectedAgent === undefined
        ? undefined
        : req.capabilityMode === "tool-free"
          ? {
              ...selectedAgent,
              allowedTools: [],
              tools: [],
              readOnly: true,
              permissionMode: "inherit-parent",
            }
          : {
              ...selectedAgent,
              allowedTools: ["*"],
              tools: ["*"],
              readOnly: false,
              permissionMode: "inherit-parent",
            };

    // 2. Pi still owns operator approval. Workflow source cannot maintain a
    //    second capability policy; only the runtime-owned Fusion marker selects
    //    the closed tool-free shape above.
    const approvalTier: "allow" = "allow";
    const permissionMode = resolvePermissionMode({ reqMode: req.permissionMode });
    const workspaceMode = resolveWorkspaceMode({ reqMode: req.workspaceMode, sandbox: req.sandbox });
    const executionName = agent?.name ?? "sub-agent";
    const resultIdentity =
      executionMode === "named"
        ? ({ executionMode: "named", agent: executionName } as const)
        : ({ executionMode: "bare" } as const);

    if (req.operatorAsk === true && options.noOperator === true) {
      // Run-level no-operator mode (T-165). Refused BEFORE tier resolution and
      // before any child exists, so the declaration costs nothing. Result-shaped
      // (not thrown) so a script may branch on the refusal explicitly; the cause
      // stays inside the closed set — operator input genuinely is unavailable in
      // this run, by launch policy rather than by missing UI.
      return {
        ok: false,
        status: "failed",
        failureCause: "ask-unavailable",
        summary: WORKFLOW_NO_OPERATOR_ASK_MESSAGE,
        diagnostics: [WORKFLOW_NO_OPERATOR_ASK_MESSAGE],
        ...resultIdentity,
        workspaceMode,
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }

    // 3. Tier resolution. This is the one place that decides which model the child
    //    runs on, and it decides it BEFORE any child is spawned so a refusal costs
    //    nothing. `modelRoleResolution` continues to travel into the request capsule
    //    and the run-result artifact exactly as it did before.
    const modelRoles = await loadModelRolesState();
    const tier = await resolveWorkflowTier({ req, agent, modelRoles, resolveModelFn });
    if (tier.kind === "refused") {
      return {
        ok: false,
        status: "failed",
        // Permanent configuration fault. Explicitly non-retryable; kept inside the
        // closed cause set instead of widening it on no evidence of a new class.
        failureCause: "unclassified",
        // The SUMMARY carries the whole reason, not a headline. `diagnostics` does not
        // reach `agent_end` or the result envelope — a live run proved the actionable
        // half ("provider X has no model Y", the pi/<role> migration hint) was being
        // dropped and the operator was left with a quoted selector and no next step.
        summary: tier.message,
        diagnostics: [tier.message],
        ...resultIdentity,
        workspaceMode,
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
    // 3b. CAPABILITY, decided on the model this call just resolved and BEFORE any
    //     child exists. A shaped result travels as a `workflow_return` receipt on the
    //     child session; a transport that never hosts Pi tools cannot register it or
    //     read the tool set back, so the call would be paid for and then refused at
    //     the end for a reason that was knowable at the start. The refusal is the
    //     same cause and the same sentence the host emits later, so a script that
    //     branches on `output-contract-unavailable` sees one behaviour, not two.
    if (req.returnContract !== undefined && tier.kind === "resolved" && !transportHostsSessionTools(tier.model)) {
      return {
        ok: false,
        status: "failed",
        failureCause: "output-contract-unavailable",
        summary: WORKFLOW_SHAPED_TRANSPORT_REFUSAL,
        diagnostics: [
          WORKFLOW_SHAPED_TRANSPORT_REFUSAL,
          `Refused before the child started: ${tier.selector} routes through a transport that does not host session tools.`,
        ],
        ...resultIdentity,
        workspaceMode,
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
    const modelRoleResolution = tier.roleResolution;
    const liveModel = resolveLiveModelDisplay({
      pi,
      ctx,
      ...(tier.kind === "resolved" ? { requestedModel: tier.selector } : {}),
      assignment: modelRoleResolution.assignment,
    });

    let worktreePath: string | undefined;
    let worktreeId: string | undefined;
    if (req.workspaceHandle !== undefined) {
      if (options.workspaceManager === undefined) {
        const message = "Workflow workspace handle was supplied without a workspace manager.";
        return {
          ok: false,
          status: "failed",
          failureCause: "workspace-allocation",
          summary: message,
          diagnostics: [message],
          ...resultIdentity,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
      try {
        const workspace = options.workspaceManager.resolve(req.workspaceHandle);
        worktreePath = workspace.path;
        worktreeId = workspace.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: "failed",
          failureCause: "workspace-allocation",
          summary: message,
          diagnostics: [message],
          ...resultIdentity,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
    } else if (workspaceMode === "worktree" || workspaceMode === "temporary-worktree") {
      if (
        options.workflowRunId === undefined ||
        options.workflowRunId.trim() === "" ||
        options.workflowRunDir === undefined
      ) {
        const message = "Workflow write agent requires workflowRunId for isolated git worktree allocation.";
        return {
          ok: false,
          status: "failed",
          failureCause: "workspace-allocation",
          summary: message,
          diagnostics: [message],
          ...resultIdentity,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
      try {
        const callId = `${executionName}-${req.label ?? "agent"}-${++worktreeCounter}`;
        const worktree = createWorkflowWorktree({
          projectRoot,
          runId: options.workflowRunId,
          runDir: options.workflowRunDir,
          safeCallId: callId,
        });
        worktreePath = worktree.path;
        worktreeId = worktree.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: "failed",
          failureCause: "workspace-allocation",
          summary: message,
          diagnostics: [message],
          ...resultIdentity,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
    }

    // 4. Build the request
    // No fallback. A turn budget nobody declared is unbounded, and the host says so
    // in its own header rather than inheriting a number invisible to the author.
    const maxTurns = req.maxTurns;
    const childTask = composeWorkflowChildTask(req.prompt, options.workflowWorkspaceDir, {
      pwd: worktreePath ?? projectRoot,
      projectRoot,
    });
    // Resolved before the request exists: the live-ask tool below records evidence
    // into these destinations from inside the child's pending tool call.
    const evidenceDestinations =
      options.evidenceDestinations !== undefined && req.callId !== undefined
        ? options.evidenceDestinations(req.callId)
        : undefined;
    // Live operator questions (owner decision, `.locus/soul.md` direction log
    // 2026-08-19). The tool closure executes in THIS process while the boundary
    // call below is in flight; its fuse and abort hooks are late-bound `let`
    // bindings because the fuse they drive is created further down, next to the
    // abort controller it shares.
    let askWaitStarted: () => void = () => {};
    let askWaitEnded: () => void = () => {};
    let failAskCall: (message: string, cause: WorkflowAskFailureCause) => void = () => {};
    const askNotes: string[] = [];
    let askEvidenceCounter = 0;
    const askTool =
      req.operatorAsk === true && req.capabilityMode !== "tool-free"
        ? createWorkflowAskTool({
            ctx,
            contextText: workflowAskContextText({
              runId: options.workflowRunId,
              agent: executionName,
              label: req.label,
            }),
            onWaitStart: () => askWaitStarted(),
            onWaitEnd: () => askWaitEnded(),
            failCall: (message, cause) => failAskCall(message, cause),
            ...(options.askRequestQuestion !== undefined ? { requestQuestion: options.askRequestQuestion } : {}),
            recordEvidence: (record) => {
              const sequence = ++askEvidenceCounter;
              if (evidenceDestinations === undefined || req.callId === undefined) {
                throw new Error("workflow artifact store is not configured for operator-answer evidence");
              }
              const ref = evidenceDestinations.recordOperatorAskEvidence(
                req.callId,
                record.toolCallId,
                sequence,
                record,
              );
              const answered = record.entries.filter((entry) => entry.status === "answered").length;
              askNotes.push(
                `workflow_ask: operator answered ${answered}/${record.entries.length}` +
                  `${record.declined ? ", declined the rest" : ""}; artifact ${ref.artifactId}`,
              );
            },
          })
        : undefined;
    const returnController =
      req.returnContract === undefined
        ? undefined
        : createWorkflowReturnController(req.returnContract, req.returnValidate);
    const customTools = [
      ...(askTool === undefined ? [] : [askTool]),
      ...(returnController === undefined ? [] : [returnController.tool]),
    ];
    const requestInput = {
      ...(maxTurns === undefined ? {} : { maxTurns }),
      approvalTier,
      allowedTools: req.capabilityMode === "tool-free" ? [] : ["*"],
      ...(req.capabilityMode === undefined ? {} : { capabilityMode: req.capabilityMode }),
      modelRoleResolution,
      // Travels on the REQUEST because the run-result artifact is written from the
      // request, inside the boundary, before this bridge ever sees a result.
      ...(tier.kind === "inherit" && tier.fallback !== undefined ? { modelRoleFallback: tier.fallback } : {}),
      repositoryCheckScripts,
      // The stock `ask` is excluded from EVERY workflow child: a headless child
      // receives its refusal as model-visible text (the recorded fabrication
      // probe) and its option timeout answers for the operator. Live questions
      // travel only through the injected `workflow_ask` when the stage declared
      // `ask: true`.
      additionalExcludeTools: ["ask"],
      ...(customTools.length === 0 ? {} : { customTools }),
      ...(returnController === undefined ? {} : { responseAcceptance: returnController.acceptance }),
      ...(worktreePath !== undefined ? { workingDirectory: worktreePath } : {}),
      ...(options.args !== undefined || worktreePath !== undefined
        ? {
            metadata: {
              ...(options.args !== undefined ? { workflowArgs: options.args } : {}),
              ...(worktreePath !== undefined
                ? {
                    workflowWorktree: {
                      id: worktreeId,
                      path: worktreePath,
                      runId: options.workflowRunId,
                      ...(req.workspaceHandle !== undefined ? { handle: req.workspaceHandle } : {}),
                    },
                  }
                : {}),
              permissionMode,
              workspaceMode,
            },
          }
        : { metadata: { permissionMode, workspaceMode } }),
      // depth defaults to 0, maxDepth defaults to 1 (children are leaves)
    };
    const request =
      agent === undefined
        ? createBareAgentRunRequest(childTask, requestInput)
        : createAgentRunRequest(agent, childTask, requestInput);

    // 5. Build the executor via the injectable factory
    const createExecutorFn = options.createExecutor ?? createAgentSdkSessionExecutor;
    const workflowParentRowId =
      options.workflowRunId !== undefined
        ? workflowAgentLiveRowId({
            runId: options.workflowRunId,
            ...resultIdentity,
            ...(req.label !== undefined ? { label: req.label } : {}),
            ...(req.phase !== undefined ? { phase: req.phase } : {}),
          })
        : undefined;
    // Slot anchoring (REQ-009, D-006): a workflow agent with a `label` is a repeatable slot.
    // Give its live row a STABLE id derived from (runId, agent, label, phase), plus the
    // runtime-owned mapped occurrence when present. A loop re-invoke in one member therefore
    // REUSES its row (round++), while sibling members cannot collapse into that row.
    // No label ⇒ not a slot: leave rowId unset (fresh-row-per-call legacy behaviour, no rounds).
    const baseSlotKey = req.label === undefined ? undefined : workflowSlotKey({ phase: req.phase, label: req.label });
    const slotKey = req.workflowSlot?.key ?? baseSlotKey;
    const rowOccurrence = req.workflowSlot?.rowOccurrence;
    const slotRowId =
      options.workflowRunId !== undefined && req.label !== undefined
        ? `${workflowAgentLiveChildRowId({
            runId: options.workflowRunId,
            ...resultIdentity,
            label: req.label,
            ...(req.phase !== undefined ? { phase: req.phase } : {}),
          })}${rowOccurrence === undefined ? "" : `:${rowOccurrence.groupId}:${rowOccurrence.memberIndex}`}`
        : undefined;
    const round = slotRowId !== undefined ? nextRound(roundByRowId, slotRowId) : undefined;
    const live: AgentSdkSessionExecutorOptions["live"] = {
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(slotRowId !== undefined ? { rowId: slotRowId } : {}),
      ...(workflowParentRowId !== undefined ? { parentRowId: workflowParentRowId } : {}),
      ...(options.workflowRunId !== undefined ? { workflowRunId: options.workflowRunId } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
      ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
      isolated: workspaceMode !== "project",
      noMcp: permissionMode === "restricted",
    };
    let liveExecution: AgentLiveExecutionHandle | undefined;
    // ONE wall clock per child, and the host receives THE SAME NUMBER the author wrote.
    //
    // What used to happen here: the declared fuse was divided by the turn count, a
    // five-second margin was added per turn, the host multiplied it back, and an
    // `ask: true` call added a 24-hour allowance on top. That product overflowed Node's
    // maximum delay for ordinary inputs — the defect L50 names — and it bought nothing,
    // because the host never applied the per-turn value per turn: it multiplied it into
    // one deadline immediately. So there is no derivation left. The declared timeout is
    // the deadline, here and in the host.
    //
    // Checked BEFORE the child starts, so an unusable number is an authoring error the
    // operator reads at once rather than a child that dies on a clamped timer.
    if (req.timeoutMs !== undefined) assertRepresentableTimeoutMs(req.timeoutMs, "agent timeoutMs");
    const childTimeoutMs = req.timeoutMs;
    const executor = createExecutorFn({
      // `perCallModel ?? resolvedRoleModel ?? ctx.model`, collapsed into the one term
      // `resolveWorkflowTier` already computed. The parent model is reachable only
      // through `kind: "inherit"` — i.e. the call declared no tier, or declared one
      // that no layer assigns and the degradation was recorded.
      model: tier.kind === "resolved" ? tier.model : (ctx as { model?: unknown }).model,
      ...(tier.kind === "resolved" && tier.thinking !== undefined
        ? { thinkingLevel: tier.thinking }
        : tier.kind === "inherit" && liveModel?.thinking !== undefined
          ? { thinkingLevel: liveModel.thinking }
          : {}),
      live,
      onLiveExecution: (execution) => {
        liveExecution = execution;
      },
      ...(req.maxToolCalls !== undefined ? { maxToolCalls: req.maxToolCalls } : {}),
      ...(childTimeoutMs !== undefined ? { childTimeoutMs } : {}),
      ...(req.timeoutMs !== undefined ? { cliRequestTimeoutMs: req.timeoutMs } : {}),
      ...(evidenceDestinations !== undefined ? { reportsDir: evidenceDestinations.transcriptDir } : {}),
    });

    // 6. Execute through the boundary (same as task tool).
    // A per-call fuse aborts the child itself rather than abandoning it: a timeout
    // that only stops waiting would leave a child burning tokens with nothing left
    // to read its answer. The run-level signal still aborts everything.
    const callAbort = new AbortController();
    // Run cancellation, the per-call fuse and the live-ask fail-closed path share
    // one child signal. Whichever source aborts it first owns the durable outcome;
    // the other sources must not relabel it while the executor unwinds.
    let abortOwner: "run" | "timeout" | WorkflowAskFailureCause | undefined;
    let askFailureMessage: string | undefined;
    const abortFromRun = (): void => {
      if (abortOwner !== undefined) return;
      abortOwner = "run";
      callAbort.abort(signal.reason);
    };
    if (signal.aborted) abortFromRun();
    else signal.addEventListener("abort", abortFromRun, { once: true });
    // ONE deadline, and it is WALL CLOCK: a declared `timeoutMs` includes the time a
    // human spends answering `workflow_ask`.
    //
    // The fuse used to pause during that wait while the host backstop could not,
    // which is why the backstop needed a 24-hour allowance on top and why the
    // resulting product overflowed Node's timer. Two clocks that disagree about what
    // time it is cannot both be the authority, and only one of them can be paused
    // from this process. So the wait counts, the journal records how long it was, and
    // an author who wants thinking time excluded declares a timeout that allows for
    // it — or declares none, which is genuinely unbounded.
    let cancelFuse: (() => void) | undefined;
    let askWaitStartedAt: number | undefined;
    const fireFuse = (): void => {
      if (abortOwner !== undefined) return;
      abortOwner = "timeout";
      callAbort.abort(new Error(`workflow agent call exceeded its ${String(req.timeoutMs)} ms timeout`));
    };
    // A span longer than Node's maximum delay runs as a chain of representable waits
    // rather than being clamped to one millisecond or refused by a policy ceiling.
    if (req.timeoutMs !== undefined) cancelFuse = scheduleLongTimeout(req.timeoutMs, fireFuse, "agent timeoutMs");
    askWaitStarted = (): void => {
      askWaitStartedAt ??= Date.now();
    };
    askWaitEnded = (): void => {
      if (askWaitStartedAt === undefined) return;
      const waitedMs = Date.now() - askWaitStartedAt;
      askWaitStartedAt = undefined;
      // The evidence for the rule above: the operator's wait is visible in the run's
      // diagnostics, so a call that died on its deadline while a human was thinking
      // says so instead of looking like a slow model.
      askNotes.push(`workflow_ask: operator wait of ${String(waitedMs)} ms counted against the call deadline`);
    };
    failAskCall = (message: string, cause: WorkflowAskFailureCause): void => {
      if (abortOwner !== undefined) return;
      abortOwner = cause;
      askFailureMessage = message;
      callAbort.abort(new Error(message));
    };
    let boundary;
    try {
      boundary = await executeAgentRunBoundary({
        pi,
        ctx,
        request,
        executor,
        signal: callAbort.signal,
        // The fuse below is THIS module's, so the host can only report the cancellation
        // it observed — or return a late success after the fuse already fired. Finalize
        // both status and cause before the envelope is written.
        finalizeResult: (result) => {
          if (
            abortOwner !== "timeout" &&
            abortOwner !== "ask-unavailable" &&
            abortOwner !== "ask-evidence-persistence"
          ) {
            return result;
          }
          const { text: _lateText, ...resultWithoutText } = result;
          return {
            ...resultWithoutText,
            status: "failed",
            reason:
              abortOwner === "timeout"
                ? `Agent call exceeded its ${String(req.timeoutMs)} ms timeout and was aborted.`
                : (askFailureMessage ?? WORKFLOW_ASK_NO_UI_MESSAGE),
            failureCause: abortOwner === "timeout" ? "call-timeout" : abortOwner,
          };
        },
        ...(evidenceDestinations !== undefined ? { resultArtifactsDir: evidenceDestinations.resultArtifactsDir } : {}),
      });
    } finally {
      cancelFuse?.();
      signal.removeEventListener("abort", abortFromRun);
    }
    const displayName =
      liveExecution === undefined ? undefined : agentLiveStore.rowForExecution(liveExecution)?.displayName;
    if (abortOwner === "timeout" || abortOwner === "ask-unavailable" || abortOwner === "ask-evidence-persistence") {
      // Name the fuse (or the fail-closed ask refusal). Without this the operator
      // reads only the host's generic abort reason and cannot tell them apart.
      const message =
        abortOwner === "timeout"
          ? `Agent call exceeded its ${String(req.timeoutMs)} ms timeout and was aborted.`
          : (askFailureMessage ?? WORKFLOW_ASK_NO_UI_MESSAGE);
      return {
        ok: false,
        status: "failed",
        // These are typed bridge failures: the child was aborted, not answered badly.
        // Runtime retry policy still decides each cause separately.
        failureCause: abortOwner === "timeout" ? "call-timeout" : abortOwner,
        summary: message,
        diagnostics: [...boundary.diagnostics, ...askNotes, message],
        ...resultIdentity,
        ...(displayName !== undefined ? { displayName } : {}),
        permissionMode,
        workspaceMode,
        readOnly: agent?.readOnly ?? false,
        ...(boundary.activeToolNames === undefined ? {} : { activeToolNames: boundary.activeToolNames }),
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(boundary.executedModel !== undefined ? { executedModel: boundary.executedModel } : {}),
        // Same gate as the settled path below, for the same reason: the note is past
        // tense, and a call the fuse killed before kickoff has no child to speak of.
        // `executedModel` is set only after the child is prompted, so it is the one
        // honest proof of execution on every path — including this early return.
        ...(tier.kind === "inherit" && tier.fallback !== undefined && boundary.executedModel !== undefined
          ? { modelRoleFallback: tier.fallback }
          : {}),
        ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
        ...(boundary.childTrace !== undefined ? { childTrace: boundary.childTrace } : {}),
        // Carried for the same reason the transcript is, and it is NOT cosmetic: a fresh
        // child that reports a session id and no result envelope makes evidence adoption
        // throw (`workflow-artifacts.ts`, "did not persist a result envelope"), which ends
        // the call by THROWING — past the retry loop, which only ever sees a returned
        // result. Dropping it here turned every artifact-backed timeout into an unretryable
        // run death, silently disabling the very option `attempts` exists to provide.
        ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
      };
    }
    if (req.workspaceHandle !== undefined) {
      options.workspaceManager?.resolve(req.workspaceHandle);
    }

    // 7. Fail-closed mapping: SDK host unavailable -> throw WorkflowAgentUnavailableError
    //
    // Keyed on the typed cause the host declares where it knows it, not on a substring of
    // English diagnostic prose. The two agreed on every path the moment the cause existed,
    // which is exactly why the prose check had to go: it made the machine-readable channel
    // decorative, and re-wording one diagnostic would silently downgrade a run-ending
    // failure into a blocked result the script could read as an answer.
    if (boundary.failureCause === "sdk-unavailable") {
      throw new WorkflowAgentUnavailableError(
        `${AGENT_SDK_UNAVAILABLE_HINT}: ${boundary.reason}`,
        boundary.diagnostics,
      );
    }

    // 8. Success / other outcomes -> map to WorkflowAgentResult
    // Round journal payload (REQ-009): the accumulated child-session tokens land on the live
    // row (applySessionStats); project them into the agent_end usage so the drill shows a
    // per-round token count. No usage on the row ⇒ omit (never a fabricated 0).
    const usage =
      slotRowId !== undefined && liveExecution !== undefined ? usageFromExecution(liveExecution) : undefined;
    // The host readback, or nothing. `unavailable` is carried through verbatim so the
    // evidence distinguishes "the peer told us" from "the peer had nothing to tell",
    // and neither is ever replaced by the selector this bridge asked for.
    const executedModel = boundary.executedModel;
    // An unassigned role is an INTENT to degrade; it becomes a DEGRADATION only once a
    // child actually RAN on the parent's model. The note is phrased in the past tense
    // ("the child inherited the parent session model"), so emitting it for a call that
    // never reached `createSession` — or that built a session and was cancelled before
    // the child was ever prompted — would put a claim about a child that never ran into
    // `agent_end`, the result envelope and the run-result artifact: invented execution
    // evidence in the surfaces this task exists to make trustworthy. `executedModel` is
    // set only after child kickoff (agent-sdk-host), so it is the honest gate; a created
    // -but-never-prompted session has an id and must not qualify.
    const degradationConfirmed =
      tier.kind === "inherit" && tier.fallback !== undefined && boundary.executedModel !== undefined;
    const result: WorkflowAgentResult = {
      ok: boundary.status === "completed",
      // A workflow journal status is a closed four-way set. `storage-failed` is the
      // boundary's honest third notion (finished, unstored) and it lands here as a
      // failure — the whole sentence, including the answer's whereabouts, is in
      // `summary`, which is what the operator reads.
      status: (boundary.status === "storage-failed" ? "failed" : boundary.status) as WorkflowAgentResult["status"],
      summary: boundary.reason,
      // Carried, never re-derived: the host declared the cause where it was known.
      ...(boundary.failureCause !== undefined ? { failureCause: boundary.failureCause } : {}),
      ...(boundary.text !== undefined ? { text: boundary.text } : {}),
      ...(boundary.outputAcceptance === undefined ? {} : { outputAcceptance: boundary.outputAcceptance }),
      diagnostics: [...(degradationConfirmed ? [tier.fallback!] : []), ...boundary.diagnostics, ...askNotes],
      ...(boundary.evidence !== undefined ? { evidence: boundary.evidence } : {}),
      ...resultIdentity,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
      ...(boundary.childTrace !== undefined ? { childTrace: boundary.childTrace } : {}),
      ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      // The request lives on `agent_start`; result evidence contains only host readback.
      ...(executedModel !== undefined && executedModel !== EXECUTED_MODEL_UNAVAILABLE ? { model: executedModel } : {}),
      ...(executedModel !== undefined ? { executedModel } : {}),
      ...(degradationConfirmed ? { modelRoleFallback: tier.fallback! } : {}),
      ...(boundary.executedThinking !== undefined ? { thinking: boundary.executedThinking } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(usage !== undefined ? { usage } : {}),
      permissionMode,
      workspaceMode,
      readOnly: agent?.readOnly ?? false,
      ...(boundary.activeToolNames === undefined ? {} : { activeToolNames: boundary.activeToolNames }),
    };
    return result;
  };
}

/** Who is asking, in the operator's terms — rendered above the question body so
 *  the operator can tell which of several running things stopped for an answer. */
function workflowAskContextText(input: {
  runId?: string | undefined;
  agent: string;
  label?: string | undefined;
}): string {
  const stage = input.label !== undefined ? `, stage "${input.label}"` : "";
  const run = input.runId !== undefined ? `run ${input.runId}` : "an unsaved run";
  return `Workflow ${run} — agent "${input.agent}"${stage} is asking:`;
}

/** Increment and return the round for a slot row id (first call → 1). */
function nextRound(counter: Map<string, number>, rowId: string): number {
  const round = (counter.get(rowId) ?? 0) + 1;
  counter.set(rowId, round);
  return round;
}

/**
 * Project the exact execution's accumulated child tokens, or omit when its slot was
 * replaced.
 *
 * No `costTotal`. The host gives this bridge a token count and no price, and the
 * previous hardcoded `0` stated the one thing nobody knows: that the run cost
 * nothing. An absent field says "unknown" and every reader prints it that way.
 */
function usageFromExecution(execution: AgentLiveExecutionHandle): WorkflowUsage | undefined {
  const row = agentLiveStore.rowForExecution(execution);
  if (row?.tokenCount === undefined) return undefined;
  const { input, output } = row.tokenCount;
  return { input, output, totalTokens: input + output };
}
