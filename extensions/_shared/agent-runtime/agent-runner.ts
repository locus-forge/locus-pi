import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ThinkingLevel } from "../host/pi-api.js";
import { getProjectRoot, getSessionId, getWorkingDirectory } from "../host/pi-api.js";
import type { AgentDefinition } from "./agents.js";
import type { AgentFailureCause } from "./agent-failure-cause.js";
import type { EvidenceEvaluation } from "./agent-evidence-evaluator.js";
import type { CreateSessionInput, MemorySessionStore, SessionRecord } from "../runtime/session-core.js";
import { createSessionStore, type SessionStore } from "../runtime/runtime-capabilities.js";
import type { ModelRoleResolution } from "../model/model-settings.js";
import { modelRoleResolutionRecord } from "../model/model-settings.js";
import type { RuntimeArtifact } from "../runtime/artifacts.js";
import { FileRuntimeArtifactStore, createRuntimeArtifactStore } from "../runtime/artifacts.js";
import type { ReadOnlyAgentCustomTool, RepositoryCheckScripts } from "./agent-read-only-policy.js";

/**
 * Three separate notions, and this union keeps the third one visible.
 *
 * `completed` / `failed` / `cancelled` / `blocked` / `running` say how the EXECUTION
 * ended. `storage-failed` says the execution ended — the child answered and the answer is
 * in this result — but the run's own result envelope could not be stored. It used to be
 * reported as `completed` with a diagnostic appended, so an operator was told the run had
 * succeeded and would go looking for a record that does not exist. The execution outcome
 * it replaces is preserved in `resultStorage.executionStatus`, so nothing is lost.
 */
export type AgentRunStatus = "blocked" | "running" | "completed" | "failed" | "cancelled" | "storage-failed";
export type ApprovalTier = "allow" | "prompt" | "deny";
export type AgentCapabilityMode = "tool-free" | "agent";

/**
 * The closed failure-cause list, owned by this envelope and defined in the zero-import
 * `agent-failure-cause.ts` so the host-agnostic workflow core can validate against the same
 * value without importing a module that reaches for `node:crypto` or `node:fs`. Re-exported
 * here because this is the envelope that first carries it.
 */
export { AGENT_FAILURE_CAUSES } from "./agent-failure-cause.js";
export type { AgentFailureCause } from "./agent-failure-cause.js";

export interface AgentParentContext {
  inline?: string;
  artifactPath?: string;
}

export type AgentExecutionMode = "bare" | "named";

export type AgentRunIdentity =
  { executionMode: "bare"; agent?: never } | { executionMode: "named"; agent: AgentDefinition };

/** Caller-owned output acceptance; the SDK host owns session lifecycle and cumulative budgets. */
export interface AgentResponseAcceptance {
  toolNames: readonly string[];
  bindToolRestriction(restrict: () => void): void;
  inspect():
    | { status: "accepted"; text: string; attempts: number; toolName: string }
    | { status: "retry"; prompt: string }
    | { status: "failed"; reason: string; failureCause?: AgentFailureCause };
}

export interface AgentOutputAcceptance {
  source: "tool";
  attempts: number;
  toolName: string;
}

export interface AgentRunRequestBase {
  task: string;
  parentSessionId: string;
  projectRoot?: string;
  workingDirectory?: string;
  /**
   * Explicit assistant-turn budget. There is no package default: absent means the
   * axis is UNBOUNDED and every surface that prints it says `unbounded`. A caller
   * that wants a stop names one at its own call site, where the person who owns
   * that surface can see it.
   */
  maxTurns?: number;
  depth: number;
  /**
   * Direct-child nesting depth for THIS scheduler. It keeps one managed spawn tree
   * accountable; it is not a sandbox and it is not protection against arbitrary
   * subprocesses a child may start through its own tools.
   */
  maxDepth: number;
  allowedTools: string[];
  approvalTier: ApprovalTier;
  /** Runtime-owned Fusion capability intent. Ordinary agent calls leave this absent. */
  capabilityMode?: AgentCapabilityMode;
  modelRoleResolution?: ModelRoleResolution;
  /**
   * Set when the caller declared a tier that no layer assigns, so the child ran on
   * the parent session model instead. Request-side by construction: the caller knows
   * it before the child starts, and the run-result artifact is written from the
   * request, so this is the only shape that reaches the artifact at all.
   */
  modelRoleFallback?: string;
  parentContext?: AgentParentContext;
  /** Exact package scripts frozen by a workflow before any writer child runs. */
  repositoryCheckScripts?: RepositoryCheckScripts;
  /** Custom tools registered for the child session; their closures execute in the
   *  PARENT process (the workflow bridge uses this for `workflow_ask`). */
  customTools?: ReadOnlyAgentCustomTool[];
  /** Opt-in same-session acceptance; absent for ordinary agents and legacy schemas. */
  responseAcceptance?: AgentResponseAcceptance;
  /** Tool names excluded on top of the host defaults (e.g. the stock `ask`, which a
   *  headless child can only mis-serve: its no-UI refusal is model-visible text and
   *  its option timeout auto-answers for the operator). */
  additionalExcludeTools?: string[];
  metadata?: Record<string, unknown>;
}

export type AgentRunRequest = AgentRunRequestBase & AgentRunIdentity;
export type AgentRunRequestWithoutContext = Omit<AgentRunRequestBase, "parentSessionId" | "projectRoot"> &
  AgentRunIdentity;
export type AgentRunRequestInput = Partial<Omit<AgentRunRequestBase, "task" | "parentSessionId" | "projectRoot">>;

/**
 * Recorded when a child session was created but the host exposes no model on it —
 * an older peer, or a structural mock. A literal value beats an absent field
 * because absence is ambiguous, and it beats echoing the request because a request
 * repeated back is not evidence of anything.
 */
export const EXECUTED_MODEL_UNAVAILABLE = "unavailable";

/**
 * What a budget axis reads as in session metadata, result envelopes and run
 * headers when no caller declared one. A literal beats an omitted key: absence
 * would be indistinguishable from an older record that never had the field.
 */
export const AGENT_BUDGET_UNBOUNDED = "unbounded" as const;

export interface AgentRunResult {
  errorLogPath?: string;
  errorLogWarning?: string;
  errorId?: string;
  outputAcceptance?: AgentOutputAcceptance;
  status: AgentRunStatus;
  executionMode?: AgentExecutionMode;
  agentName?: string;
  reason: string;
  /** Why this run did not complete. Absent on success, and on results written before
   *  the field existed — a reader treats absence as `unclassified`, never as retryable. */
  failureCause?: AgentFailureCause;
  /**
   * What the CHILD SESSION reported it ran on, read back from the host after the
   * session was created, formatted as `provider/id`. `EXECUTED_MODEL_UNAVAILABLE`
   * when the host exposes nothing; absent when no child session was ever created.
   * Never derived from the requested selector.
   */
  executedModel?: string;
  executedThinking?: ThinkingLevel;
  /** Exact pre-prompt host readback. Absent means no live readback was available. */
  activeToolNames?: string[];
  evidence?: EvidenceEvaluation;
  childSession?: SessionRecord;
  diagnostics: string[];
  lifecycleEntryIds: string[];
  /** Exact non-empty final child message on successful completion. */
  text?: string;
  childOutputStats?: AgentChildOutputStats;
  childTrace?: AgentChildTrace;
  resultArtifact?: RuntimeArtifact;
  /**
   * Present only when the result envelope could NOT be stored. The run still finished and
   * `text` still carries whatever the child answered; what is missing is the durable
   * record of it.
   */
  resultStorage?: AgentResultStorageFailure;
  worktreePath?: string;
}

/** Why a finished run has no stored result envelope, and what survived anyway. */
export interface AgentResultStorageFailure {
  /** The execution outcome the run actually reached, before storage was attempted. */
  executionStatus: AgentRunStatus;
  /** The store's own message, unmodified. */
  reason: string;
  /** Whether the child's answer text is still readable in this result. */
  answerAvailable: boolean;
}

export interface AgentChildTrace {
  path: string;
  format: "pi-session-jsonl";
  childSessionId: string;
  /**
   * Readable render of the same session, written beside the JSONL and VERIFIED
   * before it is named here. Absent means no render exists — the reason is a
   * named warning in `diagnostics`, so absence is never a silent skip and this
   * field is never a claim nobody checked.
   */
  htmlPath?: string;
}

export interface AgentChildOutputStats {
  entryCount: number;
  assistantMessageCount: number;
  assistantToolCallCount: number;
  toolResultCount: number;
  recordedToolCallCount?: number;
  recordedToolResultCount?: number;
  recordedToolNames?: string[];
  transcriptToolBlockCount?: number;
  transcriptToolNames?: string[];
  hasWorkloadProof: boolean;
}

export interface AgentExecutor {
  run(request: AgentRunRequest, signal: AbortSignal): Promise<AgentExecutorResult>;
}

export type AgentExecutorResult = Omit<AgentRunResult, "executionMode" | "agentName"> &
  Partial<Pick<AgentRunResult, "executionMode" | "agentName">>;

export interface AgentRunBoundaryOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  request: AgentRunRequestWithoutContext;
  sessionStore?: SessionStore;
  executor?: AgentExecutor;
  signal?: AbortSignal;
  /** Explicit workflow-call-local destination for the result envelope. */
  resultArtifactsDir?: string;
  /**
   * Asked once, after the executor returns and BEFORE the envelope is written: does the
   * CALLER own a final transport outcome the host cannot observe?
   *
   * A caller that aborts the child itself — the workflow bridge's per-call `timeoutMs` is
   * the only one today — knows a fact the host cannot: the host sees a cancellation and
   * says so honestly, while the caller knows it fired the fuse. A late executor can even
   * return `completed` after that fuse fired. Without this finalizer the envelope can
   * durably record a cancellation — or a success — while the caller's journal records a
   * call timeout. The hook returns the exact result the envelope must persist.
   */
  finalizeResult?: (result: AgentRunResult) => AgentRunResult;
}

// T-119 PRE-CHECK: getBranch UNREACHABLE
//
// `ctx.sessionManager.getBranch?()` exists only as an optional structural type in
// pi-api.ts. Repo call sites never invoke it, the local test harness does not
// implement it, and this boundary receives no proven parent-turn branch from a
// tool-context `execute()` call. Do not synthesize parent context here: the honest
// ER-4 fork is explicit-artifact / message-passing. A parent flow should write or
// pass the exact context artifact/message it wants the child to read, and the
// child kickoff should reference that explicit payload instead of pretending the
// host supplied conversation history.
export async function executeAgentRunBoundary(options: AgentRunBoundaryOptions): Promise<AgentRunResult> {
  const projectRoot = getProjectRoot(options.ctx);
  const parentSessionId = getSessionId(options.ctx);
  const request: AgentRunRequest = {
    ...options.request,
    parentSessionId,
    projectRoot,
    workingDirectory: options.request.workingDirectory ?? getWorkingDirectory(options.ctx),
  };
  const policyBlock = validateRunPolicy(request);
  if (policyBlock !== undefined) return blockedResult(request, policyBlock, "run-policy-blocked", []);

  const store = options.sessionStore ?? createSessionStore({ projectRoot });
  const childSession = createAgentChildSession(store, request);
  const lifecycleEntryIds: string[] = [];
  const startEntry = store.appendEntry(childSession.id, {
    type: "message",
    payload: {
      role: "system",
      content: `Sub-agent run requested${request.executionMode === "named" ? ` for ${request.agent.name}` : ""}.`,
      metadata: {
        source: "agent-runner",
        executionMode: request.executionMode,
        ...(request.executionMode === "named" ? { agentName: request.agent.name } : {}),
        task: request.task,
      },
    },
  });
  lifecycleEntryIds.push(startEntry.id);

  if (options.executor === undefined) {
    const failed = store.appendEntry(request.parentSessionId, {
      type: "child_run",
      payload: {
        childSessionId: childSession.id,
        status: "failed",
        metadata: {
          source: "agent-runner",
          reason: "No agent executor is configured.",
          executionMode: request.executionMode,
          ...(request.executionMode === "named" ? { agentName: request.agent.name } : {}),
        },
      },
    });
    lifecycleEntryIds.push(failed.id);
    return writeAgentRunResultArtifact(
      projectRoot,
      request,
      blockedResult(request, "No agent executor is configured.", "run-policy-blocked", lifecycleEntryIds, childSession),
      options.resultArtifactsDir,
    );
  }

  const observed = await options.executor.run(request, options.signal ?? new AbortController().signal);
  const result: AgentRunResult = { ...observed, ...agentRunResultIdentity(request) };
  // Finalized before the envelope is written, so the durable record and the caller's
  // journal cannot disagree about one transport outcome.
  const finalized = options.finalizeResult?.(result) ?? result;
  return writeAgentRunResultArtifact(projectRoot, request, finalized, options.resultArtifactsDir);
}

export function validateRunPolicy(request: AgentRunRequest): string | undefined {
  // Validated only when the caller declared one. An absent budget is an unbounded
  // axis, not an invalid request.
  if (request.maxTurns !== undefined && (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1))
    return "maxTurns must be a positive safe integer when declared.";
  if (request.depth < 0) return "depth must be non-negative.";
  if (request.depth >= request.maxDepth)
    return "Direct child-agent nesting depth for this scheduler is reached; no deeper managed child is started.";
  if (request.executionMode === "named" && !isAllowedToolSubset(request.agent.allowedTools, request.allowedTools))
    return "Requested tools exceed the agent definition allow-list.";
  return undefined;
}

export function createAgentRunRequest(
  agent: AgentDefinition,
  task: string,
  input: AgentRunRequestInput = {},
): AgentRunRequestWithoutContext {
  const request: AgentRunRequestWithoutContext = {
    executionMode: "named",
    agent,
    task,
    depth: input.depth ?? 0,
    maxDepth: input.maxDepth ?? 1,
    allowedTools: input.allowedTools ?? agent.allowedTools,
    approvalTier: input.approvalTier ?? "prompt",
  };
  copyOptionalRunFields(request, input);
  return request;
}

export function createBareAgentRunRequest(
  task: string,
  input: AgentRunRequestInput = {},
): AgentRunRequestWithoutContext {
  const request: AgentRunRequestWithoutContext = {
    executionMode: "bare",
    task,
    depth: input.depth ?? 0,
    maxDepth: input.maxDepth ?? 1,
    allowedTools: input.allowedTools ?? ["*"],
    approvalTier: input.approvalTier ?? "prompt",
  };
  copyOptionalRunFields(request, input);
  return request;
}

function copyOptionalRunFields(request: AgentRunRequestWithoutContext, input: AgentRunRequestInput): void {
  // Both builders are allowlists. Keep every optional field in one place so a
  // named and a bare child cannot silently diverge in artifacts or host policy.
  if (input.maxTurns !== undefined) request.maxTurns = input.maxTurns;
  if (input.metadata !== undefined) request.metadata = input.metadata;
  if (input.modelRoleResolution !== undefined) request.modelRoleResolution = input.modelRoleResolution;
  if (input.modelRoleFallback !== undefined) request.modelRoleFallback = input.modelRoleFallback;
  if (input.capabilityMode !== undefined) request.capabilityMode = input.capabilityMode;
  if (input.parentContext !== undefined) request.parentContext = input.parentContext;
  if (input.repositoryCheckScripts !== undefined) request.repositoryCheckScripts = input.repositoryCheckScripts;
  if (input.customTools !== undefined) request.customTools = input.customTools;
  if (input.responseAcceptance !== undefined) request.responseAcceptance = input.responseAcceptance;
  if (input.additionalExcludeTools !== undefined) request.additionalExcludeTools = input.additionalExcludeTools;
  if (input.workingDirectory !== undefined) request.workingDirectory = input.workingDirectory;
}

function createAgentChildSession(store: MemorySessionStore, request: AgentRunRequest): SessionRecord {
  if (store.getSession(request.parentSessionId) === undefined) {
    const parentInput: CreateSessionInput = {
      id: request.parentSessionId,
      metadata: { source: "agent-runner" },
    };
    if (request.projectRoot !== undefined) parentInput.projectRoot = request.projectRoot;
    if (request.workingDirectory !== undefined) parentInput.workingDirectory = request.workingDirectory;
    store.createSession(parentInput);
  }
  const childInput: Omit<CreateSessionInput, "parentSessionId"> = {
    metadata: {
      source: "agent-runner",
      executionMode: request.executionMode,
      ...(request.executionMode === "named" ? { agentName: request.agent.name } : {}),
      maxTurns: request.maxTurns ?? AGENT_BUDGET_UNBOUNDED,
      depth: request.depth,
      maxDepth: request.maxDepth,
      ...(request.modelRoleResolution === undefined
        ? {}
        : { modelRole: modelRoleResolutionRecord(request.modelRoleResolution) }),
    },
  };
  if (request.projectRoot !== undefined) childInput.projectRoot = request.projectRoot;
  if (request.workingDirectory !== undefined) childInput.workingDirectory = request.workingDirectory;
  return store.createChildSession(request.parentSessionId, childInput);
}

function blockedResult(
  request: AgentRunRequest,
  reason: string,
  failureCause: AgentFailureCause,
  lifecycleEntryIds: string[],
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "blocked",
    ...agentRunResultIdentity(request),
    reason,
    failureCause,
    diagnostics: [reason],
    lifecycleEntryIds,
  };
  if (childSession !== undefined) result.childSession = childSession;
  return result;
}

export function writeAgentRunResultArtifact(
  projectRoot: string,
  request: AgentRunRequest,
  result: AgentRunResult,
  resultArtifactsDir?: string,
): AgentRunResult {
  if (result.resultArtifact !== undefined) return result;
  const store =
    resultArtifactsDir === undefined
      ? createRuntimeArtifactStore(projectRoot)
      : new FileRuntimeArtifactStore({ rootDir: resultArtifactsDir });
  const body = {
    version: "locus.agent.run-result.v2",
    status: result.status,
    reason: result.reason,
    // The machine-readable half of `reason`. Without it the only durable record of WHY a
    // child failed is English prose, which is exactly the matching W1 exists to remove —
    // and a consumer reading envelopes back (an operator, a report, a later run) would have
    // to re-derive the classification the host already made. Undefined on success, and on
    // envelopes written before the field existed; a reader treats absence as unclassified.
    failureCause: result.failureCause,
    executionMode: result.executionMode,
    agentName: result.agentName,
    parentSessionId: request.parentSessionId,
    childSessionId: result.childSession?.id,
    projectRoot: request.projectRoot,
    workingDirectory: request.workingDirectory,
    maxTurns: request.maxTurns ?? AGENT_BUDGET_UNBOUNDED,
    depth: request.depth,
    maxDepth: request.maxDepth,
    allowedTools: request.allowedTools,
    modelRole:
      request.modelRoleResolution === undefined ? undefined : modelRoleResolutionRecord(request.modelRoleResolution),
    // Requested and executed values stay distinct; execution comes from host readback.
    executedModel: result.executedModel,
    executedThinking: result.executedThinking,
    capabilityMode: request.capabilityMode,
    activeToolNames: result.activeToolNames,
    // The note is written before the child exists and says "the child inherited the
    // parent session model" — a PAST-TENSE claim about a child. It is only true once a
    // child actually RAN, so a call that died in `createSession` (unavailable
    // substrate, bad model, abort) — or that built a session and was cancelled before
    // the child was ever prompted — must not carry it: that would be fabricated
    // execution evidence in the one artifact meant to prove execution. `executedModel`
    // is published only after child kickoff, which makes it the honest gate; a created
    // -but-never-prompted session has an id and must not qualify. Undefined keys are
    // dropped by `JSON.stringify`, so this omits the field rather than writing a null.
    modelRoleFallback: result.executedModel === undefined ? undefined : request.modelRoleFallback,
    diagnostics: result.diagnostics,
    lifecycleEntryIds: result.lifecycleEntryIds,
    evidence: result.evidence,
    text: result.text,
    childOutputStats: result.childOutputStats,
    childTrace: result.childTrace,
    metadata: request.metadata,
    worktreePath: result.worktreePath ?? request.workingDirectory,
  };
  try {
    const artifact = store.writeArtifact({
      id: `agent-run-${result.childSession?.id ?? randomUUID()}`,
      kind: "json",
      content: `${JSON.stringify(body, null, 2)}\n`,
      sessionId: request.parentSessionId,
      title: `Sub-agent run result${result.agentName === undefined ? "" : `: ${result.agentName}`}`,
      metadata: {
        source: "agent-runner",
        executionMode: result.executionMode,
        agentName: result.agentName,
        status: result.status,
        childSessionId: result.childSession?.id,
        modelRole:
          request.modelRoleResolution === undefined
            ? undefined
            : modelRoleResolutionRecord(request.modelRoleResolution),
      },
    });
    return { ...result, resultArtifact: artifact };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // FINISHED, not stored. Returning the execution status here told the caller the run
    // had succeeded, and the launcher printed `done` over a record that was never
    // written. The status now says what actually happened to the storage, the execution
    // outcome is kept beside it, and the answer itself travels on untouched — an
    // unstorable result is still a received one.
    const answerAvailable = typeof result.text === "string" && result.text !== "";
    const summary =
      `Agent run ${result.status} but its result envelope was not written: ${reason}. ` +
      (answerAvailable
        ? "The answer is in this result and in the child transcript; only the durable record is missing."
        : "This run produced no answer text either.");
    return {
      ...result,
      status: "storage-failed",
      reason: summary,
      resultStorage: { executionStatus: result.status, reason, answerAvailable },
      diagnostics: [...result.diagnostics, summary],
    };
  }
}

export function agentRunDisplayName(request: AgentRunRequest): string {
  return request.executionMode === "named" ? request.agent.name : "sub-agent";
}

export function agentRunResultIdentity(request: AgentRunRequest): Pick<AgentRunResult, "executionMode" | "agentName"> {
  return request.executionMode === "named"
    ? { executionMode: "named", agentName: request.agent.name }
    : { executionMode: "bare" };
}

function isAllowedToolSubset(agentTools: string[], requestedTools: string[]): boolean {
  if (agentTools.includes("*")) return true;
  const allowed = new Set(agentTools);
  return requestedTools.every((tool) => allowed.has(tool));
}
