import type { AgentSession } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type {
  AgentChildOutputStats,
  AgentChildTrace,
  AgentExecutor,
  AgentFailureCause,
  AgentRunRequest,
  AgentRunResult,
} from "./agent-runner.js";
import { agentRunDisplayName, agentRunResultIdentity } from "./agent-runner.js";
import { AGENT_BUDGET_UNBOUNDED, EXECUTED_MODEL_UNAVAILABLE } from "./agent-runner.js";
import { scheduleLongTimeout } from "../runtime/long-timer.js";
import { modelSelectorFromModel } from "../model/live-model-display.js";
import {
  createAgentExecutionPromptCapsule,
  formatAgentKickoffPrompt,
  parseAgentText,
} from "./agent-execution-prompt.js";
import type { SessionRecord } from "../runtime/session-core.js";
import { runtimeStateDir } from "../host/files.js";
import { evaluateEvidence, type EvidenceEvaluationInput } from "./agent-evidence-evaluator.js";
import { createReadOnlyAgentSessionCapabilities, type ReadOnlyAgentCustomTool } from "./agent-read-only-policy.js";
import type { ThinkingLevel } from "../host/pi-api.js";
import {
  agentLiveStore,
  boundedAgentLiveRequest,
  errorMessage,
  eventFieldMessage,
  eventToolName,
  eventTypeName,
  isRecord,
  unique,
} from "./agent-live-store.js";
import type {
  AgentLiveBeginOptions,
  AgentLiveExecutionHandle,
  AgentLiveRow,
  SdkSessionStatsLike,
} from "./agent-live-store.js";

/**
 * The live agent executor: this is the one the product runs.
 *
 * Earlier command-context replacement-session adapters could not keep the parent
 * session live while a tool-spawned child ran. They remain available in Git history
 * rather than in the shipped package. This executor spawns a real headless child agent
 * session through the public `createAgentSession` SDK and is the sole live child-session
 * executor. Prompt construction remains isolated in `agent-execution-prompt.ts`.
 */

/** Diagnostic token stamped on blocked results when the SDK host is unavailable. */
export const AGENT_SDK_UNAVAILABLE_DIAGNOSTIC = "agent-sdk-host:unavailable";

/** Stable substring shared by AgentSdkUnavailableError messages. */
export const AGENT_SDK_UNAVAILABLE_HINT = "Pi SDK host";

/** Public opt-in for readable child-session renders. JSONL evidence is unconditional. */
export const HTML_TRANSCRIPTS_ENV = "LOCUS_PI_HTML_TRANSCRIPTS";

const DEFAULT_AGENT_SDK_ABORT_TIMEOUT_MS = 5_000;

/** Raised when the installed Pi host cannot provide a usable `createAgentSession`. */
export class AgentSdkUnavailableError extends Error {
  constructor(message: string) {
    super(`${AGENT_SDK_UNAVAILABLE_HINT}: ${message}`);
    this.name = "AgentSdkUnavailableError";
  }
}

// Minimal structural shapes — we deliberately do NOT import the SDK types at module
// top level. The SDK is a peerDependency that may be missing or too old at import
// time; importing it eagerly would break the whole extension instead of degrading.
export interface SdkAgentSessionEventLike {
  type?: unknown;
  willRetry?: boolean;
  [key: string]: unknown;
}
export interface SdkAgentSessionLike {
  readonly sessionId: string;
  /** True while Pi can accept a steering message into the active child turn. */
  readonly isStreaming?: boolean;
  /**
   * The model this session actually runs on, as the host reports it.
   *
   * The real peer declares `get model(): Model<any> | undefined`
   * (`@earendil-works/pi-coding-agent` `core/agent-session.d.ts`). Optional here
   * because an older peer or a structural mock may not have it — and an absent
   * readback is recorded as `unavailable`, never back-filled from what we asked
   * for. Structurally opaque: `modelSelectorFromModel` formats it.
   */
  readonly model?: unknown;
  /** Current effective reasoning effort, as reported by the child session. */
  readonly thinkingLevel?: ThinkingLevel;
  /** Pi conversation history; optional for structural mocks. */
  readonly messages?: readonly unknown[];
  subscribe(listener: (event: SdkAgentSessionEventLike) => void): () => void;
  prompt(text: string, options?: { source?: string; streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  getSessionStats(): SdkSessionStatsLike;
  getLastAssistantText(): string | undefined;
  /**
   * Pi's `Agent` loop object. `beforeToolCall` and `shouldStopAfterTurn` are public
   * mutable admission hooks on it (`@earendil-works/pi-agent-core`, `agent.d.ts`), and
   * they are the only seam that can refuse the NEXT action rather than react to one that
   * already ran. Optional because a structural mock or an older peer may not expose it;
   * without it the budgets fall back to counting events and aborting, which stops the
   * child one action late.
   */
  readonly agent?: SdkAgentAdmissionHooksLike;
  /** Pi 0.83 host readback. Required for fresh tool-free Fusion sessions. */
  getActiveToolNames?(): string[];
  /** Pi AgentSession API; restriction applies at the next agent turn. */
  setActiveToolsByName?(names: string[]): void;
  exportToJsonl(outputPath?: string): string; // SYNC
  /**
   * Full readable render of the same session (`AgentSession.exportToHtml`,
   * present in the supported `@earendil-works/pi-coding-agent` host contract). Optional here because
   * an older peer or a structural mock may not have it — and its absence is
   * RECORDED as a named warning beside the transcript, never skipped silently.
   * The package's export map blocks a deep import of the renderer, so this
   * method and the `pi --export in.jsonl out.html` CLI are the only two doors.
   *
   * ASYNC on the real peer (`Promise<string>`), unlike `exportToJsonl` right
   * above it. The call site awaits, so a peer that ever returns the path
   * directly is handled by the same code rather than by a second branch.
   */
  exportToHtml?(outputPath?: string): Promise<string> | string;
  dispose(): void;
  abort?(): Promise<void>;
}
/** The two pre-dispatch admission hooks this host installs on a child's agent loop. */
export interface SdkAgentAdmissionHooksLike {
  /** Runs before a tool executes; `{ block: true }` means the tool never runs. */
  beforeToolCall?:
    | ((
        context: unknown,
        signal?: AbortSignal,
      ) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>)
    | undefined;
  /** Runs after a turn; `true` ends the loop before the next generation starts. */
  shouldStopAfterTurn?: ((context: unknown, signal?: AbortSignal) => boolean | Promise<boolean>) | undefined;
}

export interface SdkCreateSessionResultLike {
  session: SdkAgentSessionLike;
}
export interface SdkCreateSessionOptionsLike {
  cwd?: string;
  /** Host SessionManager. The default adapter supplies a run-scoped file-backed
   *  manager outside Pi's operator session catalog. */
  sessionManager?: unknown;
  /** Internal default-adapter input; stripped before createAgentSession. */
  evidenceSessionDir?: string;
  /** Internal CLI transport deadline; never applied to HTTP provider sessions. */
  cliRequestTimeoutMs?: number;
  tools?: string[];
  /** Host-level default suppression. Tool-free Fusion always requests `all`. */
  noTools?: "all" | "builtin";
  /** Tool names disabled after any allowlist is applied. */
  excludeTools?: string[];
  /** Custom tools registered for this child session. */
  customTools?: ReadOnlyAgentCustomTool[];
  /** A resolved Pi `Model` object (kept structurally opaque here). When set, the
   *  child session uses it instead of the host default — so the child inherits the
   *  caller's model rather than relying on settings (which may default to a weak or
   *  unauthenticated provider). */
  model?: unknown;
  /** Requested reasoning effort for the child session. */
  thinkingLevel?: ThinkingLevel;
  /** Additional child instructions generated from the selected catalog agent. The
   *  default host adapter appends this through DefaultResourceLoader so Pi keeps
   *  its normal base prompt, tool instructions, context files, and skills. */
  appendSystemPrompt?: string;
  /** Internal loader materialization contract; stripped before createAgentSession. */
  resourceLoaderOptions?: {
    noExtensions: true;
    noSkills: true;
    noPromptTemplates: true;
    noThemes: true;
    noContextFiles: true;
    systemPrompt: string;
    appendSystemPrompt: [];
  };
  resourceLoader?: unknown;
}

export type CreateAgentSessionFactory = (options: SdkCreateSessionOptionsLike) => Promise<SdkCreateSessionResultLike>;

/**
 * There is no package-default wall clock for a child agent. A caller that wants one
 * passes `childTimeoutMs`, and that value IS the deadline — one number, applied
 * once. Absent, the host arms no timer and the run header reads `unbounded`: the
 * previous `120_000 x (maxTurns ?? 5)` invented a ten-minute deadline nobody chose
 * and made two independent fuses race.
 *
 * The option was called `turnTimeoutMs` and was multiplied by the request's turn
 * count. It was never applied per turn — the host multiplied it into a single
 * deadline immediately — so the name described arithmetic rather than behaviour,
 * and the arithmetic is what overflowed Node's maximum delay once a caller derived
 * the per-turn value by dividing its own fuse. One number in, one deadline out.
 */

export interface AgentSdkSessionExecutorOptions {
  /** Inject a fake factory in unit tests; defaults to a guarded dynamic import. */
  createSession?: CreateAgentSessionFactory;
  /** Resolved parent `Model` to pass to the child session (e.g. `ctx.model`). When
   *  omitted, the child falls back to the host's default model resolution. */
  model?: unknown;
  /** Requested reasoning effort to pass to the child session. */
  thinkingLevel?: ThinkingLevel;
  /** Override the durable evidence directory (default .locus/runtime/reports). */
  reportsDir?: string;
  /** Deterministic timestamps in tests. */
  now?: () => string;
  /**
   * Explicit wall clock for the WHOLE child (ms), applied exactly as given. Omit it
   * and the child runs without a host deadline. Set a small value in tests to
   * exercise the timeout fail-closed path deterministically.
   *
   * A span longer than Node's maximum timer delay is honoured as a chain of
   * representable waits, so a deliberately long deadline is never clamped to 1 ms.
   */
  childTimeoutMs?: number;
  /** Exact caller deadline for a CLI-backed provider, separate from the SDK backstop. */
  cliRequestTimeoutMs?: number;
  /** Maximum wait for the SDK abort acknowledgement before evidence persistence continues. */
  abortTimeoutMs?: number;
  /** Optional fail-closed tool-call budget for this child. */
  maxToolCalls?: number;
  /** Optional live-row identity supplied by callers that already created a UI row. */
  live?: {
    rowId?: string;
    parentRowId?: string;
    workflowRunId?: string;
    label?: string;
    title?: string;
    /** Workflow slot descriptor (phase,label); anchors the row across loop rounds (REQ-009). */
    slotKey?: string;
    /** Loop round for the slot (≥1); the workflow bridge increments it per re-invoke. */
    round?: number;
    isolated?: boolean;
    noMcp?: boolean;
    model?: string;
    thinking?: string;
  };
  /** Exact row execution created by an outer owner; prevents a second begin for the same genuine run. */
  liveExecution?: AgentLiveExecutionHandle;
  /** Reports the one exact execution used by this run to callers that need post-boundary attribution. */
  onLiveExecution?: (execution: AgentLiveExecutionHandle) => void;
  /** Optional explicit env for prompt-building and child evidence settings; defaults to process.env. */
  promptEnv?: NodeJS.ProcessEnv;
}

export function createAgentSdkSessionExecutor(options: AgentSdkSessionExecutorOptions = {}): AgentExecutor {
  const sessionFactory = options.createSession ?? defaultCreateAgentSession;
  const createSession: CreateAgentSessionFactory = (sessionOptions) =>
    sessionFactory({
      ...sessionOptions,
      ...(options.cliRequestTimeoutMs === undefined ? {} : { cliRequestTimeoutMs: options.cliRequestTimeoutMs }),
    });
  const now = options.now ?? (() => new Date().toISOString());
  const childTimeoutMs = options.childTimeoutMs;
  if (childTimeoutMs !== undefined && (!Number.isSafeInteger(childTimeoutMs) || childTimeoutMs < 1)) {
    throw new Error("childTimeoutMs must be a positive safe integer when provided");
  }
  const abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_AGENT_SDK_ABORT_TIMEOUT_MS;
  if (!Number.isFinite(abortTimeoutMs) || abortTimeoutMs < 0) {
    throw new Error("abortTimeoutMs must be a non-negative finite number when provided");
  }
  const maxToolCalls = options.maxToolCalls;
  if (maxToolCalls !== undefined && (!Number.isInteger(maxToolCalls) || maxToolCalls < 0)) {
    throw new Error("maxToolCalls must be a non-negative integer when provided");
  }
  const model = options.model;
  const thinkingLevel = options.thinkingLevel;
  return {
    async run(request, signal) {
      const executionName = agentRunDisplayName(request);
      // A per-child controller lets the fleet menu stop exactly one selected row.
      // The caller's signal is still authoritative and is forwarded into the same
      // controller, so workflow/tool cancellation keeps its existing semantics.
      const childController = new AbortController();
      const forwardCallerAbort = () => childController.abort();
      if (signal.aborted) childController.abort();
      else signal.addEventListener("abort", forwardCallerAbort, { once: true });
      let unregisterCancel = () => {};
      try {
        const cwd = request.workingDirectory ?? request.projectRoot ?? process.cwd();
        const execution =
          options.liveExecution ??
          (options.live !== undefined
            ? agentLiveStore.beginExecution(
                liveBeginOptions(options.live.rowId, executionName, options.live, cwd, request.task),
              )
            : agentLiveStore.claimQueuedExecution(executionName, executionName));
        const boundedRequest = boundedAgentLiveRequest(request.task);
        if (agentLiveStore.rowForExecution(execution)?.request !== boundedRequest) {
          agentLiveStore.patchExecution(execution, { request: boundedRequest });
        }
        unregisterCancel = agentLiveStore.registerCancelForExecution(execution, () => childController.abort());
        try {
          options.onLiveExecution?.(execution);
        } catch (observerError) {
          const reason = errorMessage(observerError);
          const current = agentLiveStore.rowForExecution(execution);
          if (current !== undefined) {
            try {
              agentLiveStore.patchExecution(execution, {
                status: "error",
                finalAnswer: reason,
                errors: unique([...current.errors, reason]),
              });
            } catch {
              // The terminal row is already stored before a synchronous change
              // listener can throw. Preserve the original observer failure.
            }
          }
          throw observerError;
        }
        return await runWithSdkSession(
          request,
          childController.signal,
          createSession,
          now,
          options.reportsDir,
          childTimeoutMs,
          abortTimeoutMs,
          maxToolCalls,
          model,
          thinkingLevel,
          execution,
          options.promptEnv,
          options.live?.label,
        );
      } finally {
        unregisterCancel();
        signal.removeEventListener("abort", forwardCallerAbort);
      }
    },
  };
}

/** Filled by the child-session run once a session exists; empty when none was created. */
interface ExecutedModelObservation {
  executedModel?: string;
  executedThinking?: ThinkingLevel;
  activeToolNames?: string[];
}

/**
 * Stamp the host's own readback onto every outcome of one child run.
 *
 * The readback is taken once, from the created session, and then travels out on
 * `AgentRunResult` regardless of how the run ended — a failed or cancelled child
 * still ran on a model, and its evidence should say which. Results returned before
 * `createSession` succeeded carry nothing, because nothing ran.
 */
async function runWithSdkSession(
  request: AgentRunRequest,
  signal: AbortSignal,
  createSession: CreateAgentSessionFactory,
  now: () => string,
  reportsDirOverride: string | undefined,
  childTimeoutMs: number | undefined,
  abortTimeoutMs: number,
  maxToolCalls: number | undefined,
  model: unknown,
  thinkingLevel: ThinkingLevel | undefined,
  execution: AgentLiveExecutionHandle,
  promptEnv: NodeJS.ProcessEnv | undefined,
  liveLabel: string | undefined,
): Promise<AgentRunResult> {
  const observed: ExecutedModelObservation = {};
  const result = await runChildSession(
    request,
    signal,
    createSession,
    now,
    reportsDirOverride,
    childTimeoutMs,
    abortTimeoutMs,
    maxToolCalls,
    model,
    thinkingLevel,
    execution,
    promptEnv,
    liveLabel,
    observed,
  );
  return {
    ...result,
    ...(observed.executedModel === undefined ? {} : { executedModel: observed.executedModel }),
    ...(observed.executedThinking === undefined ? {} : { executedThinking: observed.executedThinking }),
    ...(observed.activeToolNames === undefined ? {} : { activeToolNames: observed.activeToolNames }),
  };
}

async function runChildSession(
  request: AgentRunRequest,
  signal: AbortSignal,
  createSession: CreateAgentSessionFactory,
  now: () => string,
  reportsDirOverride: string | undefined,
  childTimeoutMs: number | undefined,
  abortTimeoutMs: number,
  maxToolCalls: number | undefined,
  model: unknown,
  thinkingLevel: ThinkingLevel | undefined,
  execution: AgentLiveExecutionHandle,
  promptEnv: NodeJS.ProcessEnv | undefined,
  liveLabel: string | undefined,
  observed: ExecutedModelObservation,
): Promise<AgentRunResult> {
  // T-119 PRE-CHECK: getBranch UNREACHABLE
  //
  // This SDK executor is created from tool-context `execute()` without a
  // sessionManager parameter. The only prompt input available here is the already
  // explicit AgentRunRequest, so parent transcript inheritance would require an
  // unsupported hidden channel. Keep ER-4 honest: pass a deliberate artifact path,
  // message payload, or task text through the request instead of injecting a
  // fabricated parent_context block.
  // Pre-flight cancel: never create a child if we were already aborted.
  if (signal.aborted) {
    const reason = "Agent run was cancelled before child session creation.";
    // Clear the request-side display model: no session was ever built, so leaving the
    // selector on the row shows an operator a model that never ran (see the note on
    // the `createSession` failure paths below).
    agentLiveStore.patchExecutionWithoutReadback(execution, "model", { status: "cancelled", finalAnswer: reason });
    return cancelledResult(request, reason);
  }

  // Check the deadline before constructing a session. Length is no longer a reason
  // to refuse — a span above Node's maximum delay runs as a chain of representable
  // waits — so the only rejection left is a number no clock could count.
  // `undefined` is not a failure: it means no caller asked for a wall clock.
  const turnBudgetMs = childTimeoutMs;
  if (turnBudgetMs !== undefined && (!Number.isSafeInteger(turnBudgetMs) || turnBudgetMs < 1)) {
    const reason = "Child timer budget cannot be represented by Node timers; supply a positive whole childTimeoutMs.";
    agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
      status: "error",
      finalAnswer: reason,
      errors: [reason],
    });
    return failedResult(request, reason, "run-policy-blocked", [reason]);
  }

  const diagnostics: string[] = [];
  const capsule = createAgentExecutionPromptCapsule(request, diagnostics, promptEnv);
  const kickoff = formatAgentKickoffPrompt(capsule);

  const cwd = request.workingDirectory ?? request.projectRoot ?? process.cwd();
  const readOnlyCapabilities =
    request.executionMode === "named" && request.agent.readOnly
      ? createReadOnlyAgentSessionCapabilities(cwd, request.allowedTools, {
          ...(request.repositoryCheckScripts !== undefined
            ? { repositoryCheckScripts: request.repositoryCheckScripts }
            : {}),
        })
      : undefined;
  const effectiveTools =
    readOnlyCapabilities?.tools ?? (request.allowedTools.includes("*") ? undefined : [...request.allowedTools]);
  const baseExcludedTools = readOnlyCapabilities?.excludeTools ?? ["spawn_agent"];
  // Request-driven excludes stack on top of the defaults for BOTH capability
  // shapes: the workflow bridge excludes the stock `ask` from every child (its
  // no-UI refusal is model-visible text and its option timeout answers for the
  // operator — both fail-open), and read-only capability lists do not cover it.
  const excludedTools =
    request.additionalExcludeTools === undefined || request.additionalExcludeTools.length === 0
      ? baseExcludedTools
      : [...new Set([...baseExcludedTools, ...request.additionalExcludeTools])];
  // `tools: ["*"]` sends NO tool allowlist to the host, so "all tools" is what the
  // request looks like — while the excludes above still apply. Name them in the
  // run's diagnostics, which is the durable capability receipt written by
  // `writeAgentRunResultArtifact`, so "all tools" is never a claim the record
  // cannot support.
  if (effectiveTools === undefined && excludedTools.length > 0) {
    diagnostics.push(`Tool access "*" means every host tool except: ${[...excludedTools].sort().join(", ")}.`);
  }
  const sessionOptions: SdkCreateSessionOptionsLike = {
    cwd,
    evidenceSessionDir: path.join(
      reportsDirOverride ?? path.join(runtimeStateDir(request.projectRoot ?? process.cwd()), "reports"),
      ".sessions",
    ),
    // Write-capable children may run `workflow`, but no child can recursively
    // call the two direct child-session entrypoints. Read-only children receive
    // the stricter allowlist above. Pi applies excludes after `tools`.
    excludeTools: excludedTools,
  };
  if (effectiveTools !== undefined) sessionOptions.tools = effectiveTools;
  const customTools = [...(readOnlyCapabilities?.customTools ?? []), ...(request.customTools ?? [])];
  if (customTools.length > 0) sessionOptions.customTools = customTools;
  if (model !== undefined && model !== null) sessionOptions.model = model;
  if (thinkingLevel !== undefined) sessionOptions.thinkingLevel = thinkingLevel;
  const appendSystemPrompt = appendDirectSpawnBoundary(capsule.agentSystemPrompt);
  // The one tool a tool-free child may keep: the shaped-result receipt.
  //
  // "Tool-free" means the child cannot ACT — no host tools, no extensions, no skills, no
  // discovered resources. The return tool does nothing outside the session: it records the
  // value the caller declared a contract for. Clearing it too meant a tool-free Fusion with
  // a shaped judge ran every member, then failed the judge for a transport the run could
  // have known about before the first token, which is the outcome this refusal exists to
  // prevent. Pi's registry is built from the allowlist, so the name has to be in `tools`
  // as well as in `customTools`; the readback below still proves the child has nothing else.
  const toolFreeReturnToolNames =
    request.responseAcceptance === undefined ? [] : [...request.responseAcceptance.toolNames];
  if (request.capabilityMode === "tool-free") {
    sessionOptions.noTools = "all";
    sessionOptions.tools = toolFreeReturnToolNames;
    sessionOptions.customTools = customTools.filter((tool) => toolFreeReturnToolNames.includes(tool.name));
    sessionOptions.resourceLoaderOptions = {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: appendSystemPrompt,
      appendSystemPrompt: [],
    };
  } else if (appendSystemPrompt !== undefined) {
    sessionOptions.appendSystemPrompt = appendSystemPrompt;
  }
  let created: SdkCreateSessionResultLike;
  try {
    created = await createSession(sessionOptions);
  } catch (error) {
    if (error instanceof AgentSdkUnavailableError) {
      // Substrate genuinely unavailable -> blocked, with a detectable diagnostic
      // token the wiring keys its graceful fallback on. The reason is HONEST,
      // never the stale M11 replacement-session text.
      // The row was seeded with a REQUEST-side display selector before the child
      // existed, and no session was built, so there is nothing to replace it with.
      // Leaving it shows the operator a terminal row labelled with a model that never
      // ran — the live panel is the surface they actually watch, and a failed row
      // reading "test/fast" is indistinguishable from one that ran on test/fast and
      // errored. Clear it: absent is honest, invented is not.
      agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
        status: "error",
        errors: [error.message],
        finalAnswer: error.message,
      });
      return blockedResult(request, error.message, "sdk-unavailable", [
        ...diagnostics,
        AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
        error.message,
      ]);
    }
    const reason = errorMessage(error);
    agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
      status: "error",
      errors: [reason],
      finalAnswer: reason,
    });
    // Catch-all: this branch also carries a bad model id, a rejected tool allowlist and any
    // option-assembly bug. None of those is transient, so none of them may be retried.
    return failedResult(request, reason, "unclassified", [...diagnostics, reason]);
  }

  const session = created.session;
  let childSession = createSdkSessionRecord(request, session.sessionId);
  let activeToolNames: string[] | undefined;
  if (request.capabilityMode !== undefined) {
    try {
      const readback = session.getActiveToolNames?.();
      if (readback !== undefined && (!Array.isArray(readback) || !readback.every((name) => typeof name === "string"))) {
        throw new Error("AgentSession.getActiveToolNames() returned an unexpected shape.");
      }
      activeToolNames = readback === undefined ? undefined : [...readback];
      if (activeToolNames !== undefined) observed.activeToolNames = activeToolNames;
    } catch (error) {
      const reason = `Active tool readback failed before child prompt: ${errorMessage(error)}`;
      agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
        status: "error",
        errors: [reason],
        finalAnswer: reason,
      });
      disposeQuietly(session);
      return failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession);
    }
  }
  if (request.capabilityMode === "tool-free" && activeToolNames === undefined) {
    const reason = "Tool-free Fusion requires AgentSession.getActiveToolNames() before child prompt.";
    agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
      status: "error",
      errors: [reason],
      finalAnswer: reason,
    });
    disposeQuietly(session);
    return failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession);
  }
  const unexpectedToolFreeTools =
    request.capabilityMode === "tool-free"
      ? activeToolNames!.filter((name) => !toolFreeReturnToolNames.includes(name))
      : [];
  if (unexpectedToolFreeTools.length > 0) {
    const reason = `Tool-free Fusion child exposed active tools before prompt: ${unexpectedToolFreeTools.join(", ")}.`;
    agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
      status: "error",
      errors: [reason],
      finalAnswer: reason,
    });
    disposeQuietly(session);
    return failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession);
  }
  // The one honest source for "which model WOULD run": the session itself, after the
  // host built it. Anything computed before this line is the request talking to
  // itself. It is deliberately NOT `observed.executedModel` yet — a built session is
  // not an executed one, and the two terminal paths below (kickoff cancellation and
  // model mismatch) return without ever prompting the child. Publishing here would
  // put "executedModel" on a call that spent no tokens, which is the same
  // requested-vs-executed conflation this task exists to remove, one step later.
  const sessionModelSelector = modelSelectorFromModel(session.model) ?? EXECUTED_MODEL_UNAVAILABLE;
  const sessionThinkingLevel = session.thinkingLevel;
  const requestedSelector = modelSelectorFromModel(model);
  let childOutputStats: AgentChildOutputStats | undefined;
  let childTrace: AgentChildTrace | undefined;
  let childTraceAttempted = false;
  const preserveChildTrace = async (): Promise<AgentChildTrace | undefined> => {
    if (!childTraceAttempted) {
      childTraceAttempted = true;
      childTrace = await exportEvidence(
        session,
        request,
        now,
        reportsDirOverride,
        diagnostics,
        {
          ...(agentLiveStore.rowForExecution(execution)?.displayName === undefined
            ? {}
            : { displayName: agentLiveStore.rowForExecution(execution)!.displayName! }),
          ...(liveLabel === undefined ? {} : { label: liveLabel }),
        },
        promptEnv,
      );
    }
    return childTrace;
  };
  /**
   * Terminal row patch: a model stays only once one executed, an effort only once read back.
   *
   * `observed.executedModel` is this file's single proof of execution, so the row and
   * the result are held to the same evidence: a run that ends before the child was
   * dispatched — a rejected `prompt()`, a subscription that threw, an abort landing
   * while the prompt was in flight — drops the label the row was seeded with instead
   * of leaving an operator a terminal row indistinguishable from one that ran.
   */
  const patchTerminalRow = (patch: Partial<Omit<AgentLiveRow, "id" | "model" | "thinking">>): void => {
    if (observed.executedModel === undefined) agentLiveStore.patchExecutionWithoutReadback(execution, "model", patch);
    else if (observed.executedThinking === undefined)
      agentLiveStore.patchExecutionWithoutReadback(execution, "thinking", patch);
    else agentLiveStore.patchExecution(execution, patch);
  };
  try {
    agentLiveStore.patchExecution(execution, {
      status: "working",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      currentPath: cwd,
      // Make the full uuid available to an active drill immediately, rather than
      // only after the child has completed and its boundary result is parsed.
      childSessionId: session.sessionId,
      // The live row is where an operator actually watches a run, so it must show
      // what RAN as soon as that is knowable. The row was built before the child
      // existed and until this point carries a request-side display value; the
      // readback replaces it the moment the session reports one. When the peer
      // reports nothing the row keeps its display value rather than showing the
      // `unavailable` sentinel, which is evidence and not a model name (D6/D7).
      ...(sessionModelSelector !== EXECUTED_MODEL_UNAVAILABLE ? { model: sessionModelSelector } : {}),
      ...(sessionThinkingLevel !== undefined ? { thinking: sessionThinkingLevel } : {}),
    });

    // MUST guard the gap between session creation and prompting: an abort that
    // lands while createSession() was in flight must not kick off a real child.
    // It is still a real session, so preserve its identity and attempt evidence
    // export before returning the cancellation.
    if (signal.aborted) {
      const reason = "Agent run was cancelled before child session kickoff.";
      // Clear the label rather than leave the readback standing: the session was
      // BUILT on that model and never prompted, so a terminal row naming it claims an
      // execution that did not happen — the same conflation as echoing the request.
      agentLiveStore.patchExecutionWithoutReadback(execution, "model", { status: "cancelled", finalAnswer: reason });
      const preservedTrace = await preserveChildTrace();
      return withChildTrace(cancelledResult(request, reason, diagnostics, childSession), preservedTrace);
    }

    // A host that accepted a model and then built the session on a different one has
    // ignored the selection — precisely the failure this evidence exists to catch. Fail
    // before the first token is spent, and quote both values so the operator can see
    // which side moved. Unavailable readback is NOT a mismatch: it is the absence of
    // evidence, recorded as such, and it does not stop the run.
    if (
      requestedSelector !== undefined &&
      sessionModelSelector !== EXECUTED_MODEL_UNAVAILABLE &&
      sessionModelSelector !== requestedSelector
    ) {
      const reason =
        `Child session runs on ${sessionModelSelector} but the call resolved ${requestedSelector}; ` +
        "the host did not honour the selected model.";
      // Both values are in `reason`, which is where a mismatch belongs. The ROW gets
      // neither: the requested model did not run and the built-on model was never
      // prompted, so any label here names a model that executed nothing.
      agentLiveStore.patchExecutionWithoutReadback(execution, "model", {
        status: "error",
        errors: [reason],
        finalAnswer: reason,
      });
      await preserveChildTrace();
      // A host that ignored the resolved selector is a permanent configuration fault, not a
      // dropped channel: re-asking would land on the same wrong model. It stays `unclassified`
      // rather than earning its own member, because D1 promotes a cause out of `unclassified`
      // only on separate evidence that it is transient — and this one provably is not.
      return withChildTrace(
        failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession),
        childTrace,
      );
    }

    const acceptance = request.responseAcceptance;
    const restrictAcceptanceTools = (): void => {
      if (acceptance === undefined) return;
      session.setActiveToolsByName!([...acceptance.toolNames]);
      const active = session.getActiveToolNames!();
      if (
        active.length !== acceptance.toolNames.length ||
        acceptance.toolNames.some((name) => !active.includes(name))
      ) {
        throw new Error("Child host did not enforce output-only tool restriction");
      }
    };
    if (acceptance !== undefined) {
      const active = session.getActiveToolNames?.();
      if (
        session.setActiveToolsByName === undefined ||
        active === undefined ||
        acceptance.toolNames.some((name) => !active.includes(name))
      ) {
        // CAPABILITY, refused before the child is prompted: the session exists but has not
        // been given a single token of work, so nothing is spent on an answer this
        // transport could not carry back. There is deliberately no fallback — the text
        // transport that used to parse a shaped value out of a final message is gone, and
        // quietly reverting to it is exactly the silent degradation this refusal prevents.
        const reason =
          "Transport cannot carry a shaped result: same-session output acceptance requires the return tool to be " +
          "registered on the child session plus host tool-set readback (getActiveToolNames) and restriction " +
          "(setActiveToolsByName). This host provides neither, and there is no text fallback. " +
          "Use a plain text call on this transport, or run the shaped call on a host that supports it.";
        patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
        await preserveChildTrace();
        return withChildTrace(
          failedResult(
            request,
            reason,
            "output-contract-unavailable",
            [...diagnostics, reason],
            undefined,
            childSession,
          ),
          childTrace,
        );
      }
      acceptance.bindToolRestriction(restrictAcceptanceTools);
    }

    const ledger: ChildTurnLedger = { toolCalls: 0, admittedToolCalls: 0, assistantTurns: 0, toolNames: new Set() };
    const deadline = turnBudgetMs === undefined ? undefined : Date.now() + turnBudgetMs;
    let acceptedOutput:
      Extract<ReturnType<NonNullable<typeof acceptance>["inspect"]>, { status: "accepted" }> | undefined;
    let acceptanceFailure: string | undefined;
    let acceptanceFailureCause: AgentFailureCause = "output-contract-exhausted";
    let turn = await driveChildTurn(
      session,
      kickoff,
      signal,
      turnBudgetMs,
      maxToolCalls,
      execution,
      ledger,
      request.maxTurns,
    );
    if (turn.promptAccepted) {
      observed.executedModel = sessionModelSelector;
      if (sessionThinkingLevel !== undefined) observed.executedThinking = sessionThinkingLevel;
    }
    while (
      acceptance !== undefined &&
      turn.settlement === "completed" &&
      !signal.aborted &&
      assistantProviderFailure(session.messages) === undefined
    ) {
      const decision = acceptance.inspect();
      if (decision.status === "accepted") {
        acceptedOutput = decision;
        break;
      }
      if (decision.status === "failed") {
        acceptanceFailure = decision.reason;
        acceptanceFailureCause = decision.failureCause ?? "output-contract-exhausted";
        break;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        turn = { ...turn, settlement: "timed_out" };
        break;
      }
      if (request.maxTurns !== undefined && ledger.assistantTurns >= request.maxTurns) {
        turn = { ...turn, settlement: "turn_limit" };
        break;
      }
      restrictAcceptanceTools();
      turn = await driveChildTurn(
        session,
        decision.prompt,
        signal,
        deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
        maxToolCalls,
        execution,
        ledger,
        request.maxTurns,
      );
      if (turn.promptAccepted) {
        observed.executedModel = sessionModelSelector;
        if (sessionThinkingLevel !== undefined) observed.executedThinking = sessionThinkingLevel;
      }
    }
    if (signal.aborted) turn = { ...turn, settlement: "aborted" };

    // THIS is the first point at which "executed" is a true word, so it is the first
    // point the evidence may say it. Everything above returns without it: a session
    // built and then cancelled, or built on the wrong model, executed nothing — and
    // neither does one whose `prompt()` was REJECTED by the transport (no credentials,
    // no route) or whose subscription threw, both of which leave `driveChildTurn` by
    // exception and skip this line entirely. `promptAccepted` is the narrower gate for
    // the case that still returns normally: an abort or a timeout that lands while the
    // prompt is still in flight and no child event has ever arrived. A turn that was
    // dispatched and then timed out DID execute, which is why promotion sits here
    // rather than after the settlement branches.
    if (turn.promptAccepted) {
      observed.executedModel = sessionModelSelector;
      if (sessionThinkingLevel !== undefined) observed.executedThinking = sessionThinkingLevel;
    }

    if (
      turn.settlement === "aborted" ||
      turn.settlement === "timed_out" ||
      turn.settlement === "tool_limit" ||
      turn.settlement === "turn_limit"
    ) {
      // Stop the child, then still export evidence and dispose (finally below).
      await abortChild(session, abortTimeoutMs);
      await preserveChildTrace();
      if (turn.settlement === "timed_out") {
        const reason = `Child agent turn exceeded the ${String(turnBudgetMs)}ms budget and was aborted.`;
        patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, "host-turn-timeout", [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      if (turn.settlement === "turn_limit") {
        const reason = `Child exceeded its cumulative ${String(request.maxTurns)} assistant-turn budget`;
        patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, "assistant-turn-budget", [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      if (turn.settlement === "tool_limit") {
        const reason = `Child agent exceeded the ${maxToolCalls ?? 0} tool-call budget and was aborted.`;
        patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, "tool-call-budget", [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      const reason = "Agent run was cancelled.";
      patchTerminalRow({ status: "cancelled", finalAnswer: reason });
      return withChildTrace(cancelledResult(request, reason, diagnostics, childSession), childTrace);
    }

    const stats = session.getSessionStats();
    if (childSession.id === "" && stats.sessionId !== "")
      childSession = createSdkSessionRecord(request, stats.sessionId);
    agentLiveStore.applyExecutionStats(execution, stats);
    if (session.messages !== undefined) agentLiveStore.replaceExecutionTranscript(execution, session.messages);
    const text = acceptedOutput?.text ?? session.getLastAssistantText();
    await preserveChildTrace();

    childOutputStats = {
      // The SDK exposes aggregate counters, not an entry list, in this context.
      // entryCount is a defensible derived count from the genuine workload signals.
      entryCount: stats.toolCalls + stats.toolResults,
      assistantMessageCount: 0,
      assistantToolCallCount: stats.toolCalls,
      toolResultCount: stats.toolResults,
      recordedToolNames: turn.recordedToolNames,
      hasWorkloadProof: stats.toolCalls > 0 || stats.toolResults > 0,
    };

    const providerFailure = assistantProviderFailure(session.messages);
    if (providerFailure !== undefined) {
      const currentErrors = agentLiveStore.rowForExecution(execution)?.errors ?? [];
      patchTerminalRow({
        status: "error",
        childSessionId: childSession.id,
        errors: unique([...currentErrors, providerFailure]),
        finalAnswer: providerFailure,
      });
      return withChildTrace(
        failedResult(
          request,
          providerFailure,
          "provider-error",
          [...diagnostics, providerFailure],
          childOutputStats,
          childSession,
        ),
        childTrace,
      );
    }
    if (acceptance !== undefined && acceptedOutput === undefined) {
      const reason = acceptanceFailure ?? "No accepted output proposal at successful child completion";
      patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
      return withChildTrace(
        failedResult(request, reason, acceptanceFailureCause, [...diagnostics, reason], childOutputStats, childSession),
        childTrace,
      );
    }
    const parsed = parseAgentText(text ?? "");
    if (!parsed.ok) {
      patchTerminalRow({
        status: "error",
        childSessionId: childSession.id,
        finalAnswer: parsed.reason,
      });
      return withChildTrace(
        failedResult(
          request,
          parsed.reason,
          "unparseable-answer",
          [...diagnostics, parsed.reason],
          childOutputStats,
          childSession,
        ),
        childTrace,
      );
    }
    const evidenceInput: EvidenceEvaluationInput = {
      agentName: agentRunDisplayName(request),
      policy: request.executionMode === "named" ? (request.agent.evidence ?? { mode: "none" }) : { mode: "none" },
      toolCallCount: stats.toolCalls,
      toolResultCount: stats.toolResults,
      observedToolNames: childOutputStats.recordedToolNames ?? [],
      outputText: text ?? "",
      status: "completed",
    };
    const evidence = evaluateEvidence(evidenceInput);
    patchTerminalRow({
      status: "done",
      childSessionId: childSession.id,
      finalAnswer: parsed.text,
    });
    return {
      status: "completed",
      ...agentRunResultIdentity(request),
      reason: parsed.text,
      text: parsed.text,
      ...(acceptedOutput === undefined
        ? {}
        : {
            outputAcceptance: {
              source: "tool" as const,
              attempts: acceptedOutput.attempts,
              toolName: acceptedOutput.toolName,
            },
          }),
      evidence,
      diagnostics,
      lifecycleEntryIds: [],
      childOutputStats,
      childSession,
      ...(childTrace !== undefined ? { childTrace } : {}),
    };
  } catch (error) {
    const reason = errorMessage(error);
    const currentErrors = agentLiveStore.rowForExecution(execution)?.errors ?? [];
    // This catch takes both a transport rejection from `prompt()` (nothing ran) and a
    // failure after the child answered (something did), so the model label follows the
    // execution evidence rather than the code path.
    patchTerminalRow({
      status: "error",
      errors: unique([...currentErrors, reason]),
      finalAnswer: reason,
    });
    const preservedTrace = await preserveChildTrace();
    return withChildTrace(
      // Catch-all around the whole turn — parseAgentText, evidence evaluation, trace export
      // included. Nothing here proves the throw was transient, so it never retries.
      failedResult(request, reason, "unclassified", [...diagnostics, reason], childOutputStats, childSession),
      preservedTrace,
    );
  } finally {
    disposeQuietly(session);
  }
}

type ChildTurnSettlement = "completed" | "aborted" | "timed_out" | "tool_limit" | "turn_limit";
interface ChildTurnLedger {
  toolCalls: number;
  /**
   * Tool calls ADMITTED by the pre-dispatch hook, counted independently of the event
   * stream. `tool_execution_start` is emitted before the hook runs, so an event count
   * includes the call this host is about to refuse; admission is the number that decides
   * whether the next tool may run at all.
   */
  admittedToolCalls: number;
  assistantTurns: number;
  toolNames: Set<string>;
}
const SDK_TOOL_EVIDENCE_EVENT_TYPES = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface ChildTurnObservation {
  settlement: ChildTurnSettlement;
  recordedToolNames: string[];
  /**
   * Whether the child was actually dispatched: `prompt()` resolved (the SDK settles it
   * once the turn is QUEUED, not when it finishes) or the child emitted its first
   * event. Either one is proof the transport took the turn.
   *
   * A `prompt()` that REJECTS — no credentials, no route to the provider — leaves this
   * function by exception and never returns an observation at all, which is the
   * stronger half of the same rule. This flag covers what still returns normally: an
   * abort or a timeout that wins the race while the prompt is in flight and no child
   * event has ever arrived. Nothing ran then, and the caller must not record a model
   * as executed.
   */
  promptAccepted: boolean;
}

/**
 * Prompt the child and wait for its `agent_end`, racing against the abort signal
 * and a wall-clock timeout so neither a hung `prompt()` nor a missing `agent_end`
 * can pin the tool forever. The `prompt()` promise is part of the race because it
 * only resolves once the turn is queued, not when the turn finishes — completion
 * is signalled exclusively by the `agent_end` event.
 */
async function driveChildTurn(
  session: SdkAgentSessionLike,
  kickoff: string,
  signal: AbortSignal,
  turnBudgetMs: number | undefined,
  maxToolCalls: number | undefined,
  execution: AgentLiveExecutionHandle,
  ledger: ChildTurnLedger = { toolCalls: 0, admittedToolCalls: 0, assistantTurns: 0, toolNames: new Set() },
  maxAssistantTurns?: number,
): Promise<ChildTurnObservation> {
  // Subscribe BEFORE prompting so a fast agent_end is never missed.
  let resolveEnd: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  // The SDK invokes this listener on its OWN synchronous, detached emit path
  // (agent loop -> _handleAgentEvent -> _emit), NOT on a promise we await. A throw
  // here would escape every try/catch below and surface as an uncaught exception
  // that kills the host process. So the whole body is guarded: a malformed or late
  // event degrades to a recorded diagnostic, never a crash.
  const recordedToolNames = ledger.toolNames;
  // Set the moment the transport takes the turn — see ChildTurnObservation.
  let promptAccepted = false;
  let resolveToolLimit: () => void = () => {};
  const toolLimited = new Promise<"tool_limit">((resolve) => {
    resolveToolLimit = () => resolve("tool_limit");
  });
  let resolveTurnLimit: () => void = () => {};
  const turnLimited = new Promise<"turn_limit">((resolve) => {
    resolveTurnLimit = () => resolve("turn_limit");
  });
  // Admission BEFORE dispatch. The event counters below stay as they are — they are the
  // evidence, and the settlement they resolve is unchanged — but on their own they only
  // learn about the over-budget action once the child has already taken it. These hooks
  // refuse the next one instead: the (N+1)-th tool never executes, and the turn after the
  // last declared one is never generated. The named budget stop and everything received
  // so far are untouched either way.
  const restoreAdmission = installChildBudgetAdmission(session, ledger, {
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(maxAssistantTurns === undefined ? {} : { maxAssistantTurns }),
    onToolBudgetReached: () => resolveToolLimit(),
    onTurnBudgetReached: () => resolveTurnLimit(),
  });
  const unsubscribe = session.subscribe((event) => {
    try {
      // An event from the child is proof it is live, even if `prompt()` has not
      // settled yet: a host whose prompt promise only resolves at turn end would
      // otherwise look like a turn that never started.
      promptAccepted = true;
      const toolName = sdkToolEventName(event);
      if (toolName !== undefined) recordedToolNames.add(toolName);
      if (eventTypeName(event) === "tool_execution_start") {
        ledger.toolCalls += 1;
        if (maxToolCalls !== undefined && ledger.toolCalls > maxToolCalls) resolveToolLimit();
      }
      if (eventTypeName(event) === "turn_start") {
        ledger.assistantTurns += 1;
        if (maxAssistantTurns !== undefined && ledger.assistantTurns > maxAssistantTurns) resolveTurnLimit();
      }
      agentLiveStore.feedExecutionEvent(execution, event);
      // Pi emits `agent_end` after each model cycle, including a cycle followed
      // by queued steering input. The SDK prompt still owns the live run until
      // it settles, so keep the row active here; the terminal result path below
      // applies the genuine final status after prompt() returns.
      if (eventTypeName(event) === "agent_end" && session.isStreaming === true) {
        agentLiveStore.patchExecution(execution, { status: "working" });
      }
      if (isRecord(event) && event.type === "agent_end" && event.willRetry !== true) resolveEnd();
    } catch {
      // A malformed/late event must not crash the host from the SDK's emit path.
      // The genuine failure is still surfaced through the turn's timeout/abort and
      // the failedResult mapping; this guard only prevents an out-of-band throw.
    }
  });
  const unregisterInput =
    "isStreaming" in session
      ? agentLiveStore.registerInputForExecution(
          execution,
          async (text) => {
            if (session.isStreaming !== true) throw new Error("Agent turn is no longer accepting input.");
            await session.prompt(text, {
              source: "locus-pi-agent-viewer",
              streamingBehavior: "steer",
            });
          },
          () => session.isStreaming === true,
        )
      : () => {};

  let cancelTimer: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // No budget, no timer: an undeclared wall clock is unbounded, never a
    // zero-delay abort. A budget above Node's maximum delay is a chain of
    // representable waits, never a clamp to one millisecond.
    const timedOut = new Promise<"timed_out">((resolve) => {
      if (turnBudgetMs !== undefined) {
        cancelTimer = scheduleLongTimeout(turnBudgetMs, () => resolve("timed_out"), "childTimeoutMs");
      }
    });
    // A turn is "complete" only when agent_end fires; prompt() racing here means a
    // hung prompt() cannot block the abort/timeout branches from winning.
    const completed = (async (): Promise<"completed"> => {
      await session.prompt(kickoff, { source: "locus-pi-agent-sdk-host" });
      promptAccepted = true;
      await ended;
      return "completed";
    })();
    const settlement = await Promise.race([completed, aborted, timedOut, toolLimited, turnLimited]);
    return { settlement, recordedToolNames: [...recordedToolNames].sort(), promptAccepted };
  } finally {
    unregisterInput();
    unsubscribe();
    restoreAdmission();
    cancelTimer?.();
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Install the pre-dispatch budget admission on a child's agent loop, returning a
 * restore function.
 *
 * Both hooks CHAIN: Pi's own `beforeToolCall` bridges the `tool_call` extension event, so
 * replacing it outright would silence every extension handler on the child. An inherited
 * block wins, and only after it declines does the budget decide.
 *
 * A host without the loop object (a structural mock, an older peer) gets no hooks and
 * keeps the event-counted behaviour: the budget is still enforced, one action late.
 */
function installChildBudgetAdmission(
  session: SdkAgentSessionLike,
  ledger: ChildTurnLedger,
  budget: {
    maxToolCalls?: number;
    maxAssistantTurns?: number;
    onToolBudgetReached: () => void;
    onTurnBudgetReached: () => void;
  },
): () => void {
  const agent = session.agent;
  if (agent === undefined || typeof agent !== "object") return () => {};
  if (budget.maxToolCalls === undefined && budget.maxAssistantTurns === undefined) return () => {};
  const previousBeforeToolCall = agent.beforeToolCall;
  const previousShouldStop = agent.shouldStopAfterTurn;
  const maxToolCalls = budget.maxToolCalls;
  const maxAssistantTurns = budget.maxAssistantTurns;
  if (maxToolCalls !== undefined) {
    agent.beforeToolCall = async (context, abortSignal) => {
      const inherited =
        typeof previousBeforeToolCall === "function"
          ? await previousBeforeToolCall.call(agent, context, abortSignal)
          : undefined;
      if (inherited?.block === true) return inherited;
      if (ledger.admittedToolCalls >= maxToolCalls) {
        budget.onToolBudgetReached();
        return {
          block: true,
          reason:
            `Child agent reached its ${String(maxToolCalls)} tool-call budget; ` +
            "this call was refused before it ran. Everything already produced is kept.",
          terminate: true,
        };
      }
      ledger.admittedToolCalls += 1;
      return inherited;
    };
  }
  if (maxAssistantTurns !== undefined) {
    agent.shouldStopAfterTurn = async (context, abortSignal) => {
      const inherited =
        typeof previousShouldStop === "function" ? await previousShouldStop.call(agent, context, abortSignal) : false;
      if (inherited === true) return true;
      if (ledger.assistantTurns < maxAssistantTurns) return false;
      // Only when the loop WOULD continue. A final turn with no tool results ends on its
      // own, and calling this a turn-budget stop there would turn an ordinary completion
      // into a failure.
      const results = isRecord(context) ? context.toolResults : undefined;
      if (!Array.isArray(results) || results.length === 0) return false;
      budget.onTurnBudgetReached();
      return true;
    };
  }
  return () => {
    if (maxToolCalls !== undefined) agent.beforeToolCall = previousBeforeToolCall;
    if (maxAssistantTurns !== undefined) agent.shouldStopAfterTurn = previousShouldStop;
  };
}

function sdkToolEventName(event: unknown): string | undefined {
  if (!SDK_TOOL_EVIDENCE_EVENT_TYPES.has(eventTypeName(event))) return undefined;
  return eventToolName(event)?.trim() || undefined;
}

/** Best-effort child abort with a bounded acknowledgement wait. */
async function abortChild(session: SdkAgentSessionLike, timeoutMs: number): Promise<void> {
  const abort = session.abort;
  if (abort === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempted = Promise.resolve()
      .then(() => abort.call(session))
      .catch(() => undefined);
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([attempted, bounded]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function disposeQuietly(session: SdkAgentSessionLike): void {
  try {
    session.dispose();
  } catch {
    /* best effort */
  }
}

async function defaultCreateAgentSession(opts: SdkCreateSessionOptionsLike): Promise<SdkCreateSessionResultLike> {
  let mod: unknown;
  try {
    mod = await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    throw new AgentSdkUnavailableError(`Pi SDK module could not be imported: ${errorMessage(error)}`);
  }
  let create: unknown;
  try {
    create = (mod as { createAgentSession?: unknown }).createAgentSession;
  } catch (error) {
    // Some module shapes (e.g. strict ESM namespaces or test mocks) throw on a
    // missing-export access. Treat that as substrate-unavailable, not a run failure.
    throw new AgentSdkUnavailableError(`Installed Pi host does not expose createAgentSession: ${errorMessage(error)}`);
  }
  if (typeof create !== "function") {
    throw new AgentSdkUnavailableError("Installed Pi host does not export createAgentSession (host too old).");
  }
  const sessionOptions = await materializeSdkSessionOptions(mod, opts);
  const result = await (create as (o: unknown) => Promise<unknown>)(sessionOptions);
  if (!isRecord(result) || !isRecord(result.session)) {
    throw new AgentSdkUnavailableError("createAgentSession returned an unexpected shape.");
  }
  try {
    configureCliSessionDeadline(result.session as unknown as AgentSession, opts.cliRequestTimeoutMs);
  } catch (error) {
    disposeQuietly(result.session as unknown as SdkAgentSessionLike);
    throw error;
  }
  return result as unknown as SdkCreateSessionResultLike;
}

/** Internal host-adapter seam exported for contract tests. Injected factories bypass it. */
export async function materializeSdkSessionOptions(
  mod: unknown,
  opts: SdkCreateSessionOptionsLike,
): Promise<Record<string, unknown>> {
  const { appendSystemPrompt, resourceLoaderOptions, evidenceSessionDir, cliRequestTimeoutMs, ...sessionOptions } =
    opts;
  if (!isRecord(mod)) {
    throw new AgentSdkUnavailableError("Installed Pi host does not expose SessionManager for isolated child sessions.");
  }
  const SessionManager = mod.SessionManager as { create?: (cwd?: string, sessionDir?: string) => unknown } | undefined;
  if (typeof SessionManager?.create !== "function") {
    throw new AgentSdkUnavailableError(
      "Installed Pi host does not expose SessionManager.create for isolated child sessions.",
    );
  }
  const isolatedSessionManager = SessionManager.create(
    opts.cwd,
    evidenceSessionDir ?? path.join(runtimeStateDir(opts.cwd ?? process.cwd()), "reports", ".sessions"),
  );
  const isolatedSessionOptions: Record<string, unknown> = { ...sessionOptions, sessionManager: isolatedSessionManager };
  if (appendSystemPrompt === undefined && resourceLoaderOptions === undefined) return isolatedSessionOptions;
  if (!isRecord(mod) || typeof mod.DefaultResourceLoader !== "function") {
    throw new AgentSdkUnavailableError(
      "Installed Pi host does not expose DefaultResourceLoader for package-owned prompt resources.",
    );
  }
  const DefaultResourceLoader = mod.DefaultResourceLoader as new (options: Record<string, unknown>) => {
    reload?: () => Promise<void> | void;
  };
  const loaderOptions: Record<string, unknown> =
    resourceLoaderOptions === undefined
      ? {
          cwd: opts.cwd,
          ...(appendSystemPrompt === undefined
            ? {}
            : { appendSystemPromptOverride: (base: string[]) => [...base, appendSystemPrompt] }),
        }
      : {
          cwd: opts.cwd,
          ...resourceLoaderOptions,
          systemPromptOverride: () => resourceLoaderOptions.systemPrompt,
          appendSystemPromptOverride: () => [],
        };
  if (typeof mod.getAgentDir === "function") loaderOptions.agentDir = (mod.getAgentDir as () => string)();
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload?.();
  return { ...isolatedSessionOptions, resourceLoader: loader };
}

/** Keep SDK hooks while separating its HTTP idle default from CLI process deadlines. */
export function configureCliSessionDeadline(session: AgentSession, requestTimeoutMs?: number): void {
  if (typeof session.model?.baseUrl !== "string" || !session.model.baseUrl.startsWith("cli://")) return;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647)
  ) {
    throw new Error("cliRequestTimeoutMs must be a positive Node timer duration");
  }
  const suppliedTimeout = Symbol("CLI request timeout before SDK defaults");
  const stream = session.agent.streamFunction;
  const runtimeStream = session.modelRuntime.streamSimple.bind(session.modelRuntime);
  session.agent.streamFunction = (model, context, options) => {
    const marked = { ...options, [suppliedTimeout]: options?.timeoutMs };
    return stream.call(session.agent, model, context, marked);
  };
  session.modelRuntime.streamSimple = (model, context, options) => {
    if (!options || !(suppliedTimeout in options)) return runtimeStream(model, context, options);
    const { [suppliedTimeout]: supplied, ...forwarded } = options as typeof options & {
      [suppliedTimeout]?: number;
    };
    if (model.baseUrl.startsWith("cli://")) {
      const settings = session.settingsManager;
      const explicitHttp =
        settings.getProjectSettings().httpIdleTimeoutMs ?? settings.getGlobalSettings().httpIdleTimeoutMs;
      const configured =
        settings.getProviderRetrySettings().timeoutMs ??
        (explicitHttp === undefined ? undefined : settings.getHttpIdleTimeoutMs() || undefined);
      const deadline =
        requestTimeoutMs === undefined ? configured : Math.min(requestTimeoutMs, configured ?? requestTimeoutMs);
      // The original per-call option outranks settings, exactly as it does in Pi.
      const timeoutMs = supplied ?? deadline;
      if (timeoutMs !== undefined) forwarded.timeoutMs = timeoutMs;
      else delete forwarded.timeoutMs;
    }
    return runtimeStream(model, context, forwarded);
  };
}

async function exportEvidence(
  session: SdkAgentSessionLike,
  request: AgentRunRequest,
  now: () => string,
  reportsDirOverride: string | undefined,
  diagnostics: string[],
  identity: { displayName?: string; label?: string },
  env: NodeJS.ProcessEnv | undefined,
): Promise<AgentChildTrace | undefined> {
  const reportsDir = reportsDirOverride ?? path.join(runtimeStateDir(request.projectRoot ?? process.cwd()), "reports");
  const stamp = sanitizeStamp(now());
  try {
    if (session.sessionId.trim() === "") throw new Error("child session id is missing");
    mkdirSync(reportsDir, { recursive: true });
    const stem = agentEvidenceStem(request, identity);
    const exportedPath = session.exportToJsonl(path.join(reportsDir, `agent-sdk-${stem}-${stamp}.jsonl`));
    const realReportsDir = realpathSync(reportsDir);
    const realExportedPath = realpathSync(exportedPath);
    const relativePath = path.relative(realReportsDir, realExportedPath);
    if (relativePath === "" || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`exported path escaped reports root: ${realExportedPath}`);
    }
    if (path.extname(realExportedPath) !== ".jsonl") {
      throw new Error(`exported path is not JSONL: ${realExportedPath}`);
    }
    const firstLine = readFileSync(realExportedPath, "utf8").split("\n", 1)[0]?.trim() ?? "";
    if (firstLine === "") throw new Error("exported JSONL session header is missing");
    const header = JSON.parse(firstLine) as unknown;
    if (!isRecord(header) || header.type !== "session" || header.id !== session.sessionId) {
      throw new Error(`exported JSONL session header does not match child ${session.sessionId}`);
    }
    diagnostics.push(`JSONL evidence exported: ${realExportedPath}`);
    const htmlPath = htmlTranscriptsEnabled(env)
      ? await exportHtmlRender(
          session,
          realReportsDir,
          realExportedPath,
          diagnostics,
          agentEvidenceTitle(request, identity),
        )
      : undefined;
    return {
      path: realExportedPath,
      format: "pi-session-jsonl",
      childSessionId: session.sessionId,
      ...(htmlPath === undefined ? {} : { htmlPath }),
    };
  } catch (error) {
    diagnostics.push(`JSONL export failed: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Only the literal value `1` enables automatic HTML rendering. */
export function htmlTranscriptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HTML_TRANSCRIPTS_ENV]?.trim() === "1";
}

/** Named warning prefix for every reason a session has no readable render. */
const HTML_RENDER_WARNING = "HTML transcript render";

/**
 * The readable half of one child's evidence, beside its JSONL and named after it.
 *
 * Additive: the TUI reader stays the required surface and a missing render never
 * fails a run. It is not, however, allowed to be quiet — every reason lands in
 * `diagnostics`, which the per-call result envelope persists, and the path is
 * returned only after the file has been verified on disk. A host with no
 * `exportToHtml` is one of those reasons; `pi --export <transcript>.jsonl
 * <out>.html` re-renders any saved transcript afterwards.
 */
async function exportHtmlRender(
  session: SdkAgentSessionLike,
  realReportsDir: string,
  realExportedPath: string,
  diagnostics: string[],
  title: string,
): Promise<string | undefined> {
  if (typeof session.exportToHtml !== "function") {
    diagnostics.push(`${HTML_RENDER_WARNING} unavailable: the installed Pi host exposes no AgentSession.exportToHtml`);
    return undefined;
  }
  const target = `${realExportedPath.slice(0, -path.extname(realExportedPath).length)}.html`;
  try {
    // Awaited, not fired and forgotten: the run may finish the instant this
    // returns, and a render still in flight would leave the evidence claiming a
    // file that is not there yet.
    const written = await session.exportToHtml(target);
    if (typeof written !== "string" || written.trim() === "") {
      throw new Error("exportToHtml returned no path");
    }
    const realWritten = realpathSync(written);
    const relativePath = path.relative(realReportsDir, realWritten);
    if (relativePath === "" || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`rendered path escaped reports root: ${realWritten}`);
    }
    if (path.extname(realWritten) !== ".html") throw new Error(`rendered path is not HTML: ${realWritten}`);
    if (statSync(realWritten).size === 0) throw new Error(`rendered file is empty: ${realWritten}`);
    personalizeHtmlTitle(realWritten, title);
    diagnostics.push(`${HTML_RENDER_WARNING} exported: ${realWritten}`);
    return realWritten;
  } catch (error) {
    diagnostics.push(`${HTML_RENDER_WARNING} failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function agentEvidenceStem(request: AgentRunRequest, identity: { displayName?: string; label?: string }): string {
  return [agentRunDisplayName(request), identity.label, identity.displayName]
    .map((part) => evidenceSlug(part))
    .filter((part, index, parts) => part !== "" && parts.indexOf(part) === index)
    .join("-");
}

function agentEvidenceTitle(request: AgentRunRequest, identity: { displayName?: string; label?: string }): string {
  const agent = evidenceTitlePart(identity.displayName, 48) || agentRunDisplayName(request);
  const label = evidenceTitlePart(identity.label, 80);
  return `Agent transcript — ${agent}${label === undefined || label === "" ? "" : ` · ${label}`}`;
}

function evidenceTitlePart(value: string | undefined, maxChars: number): string | undefined {
  const bounded = value?.replace(/\s+/gu, " ").trim().slice(0, maxChars).trim();
  return bounded === undefined || bounded === "" ? undefined : bounded;
}

function evidenceSlug(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
}

function personalizeHtmlTitle(filePath: string, title: string): void {
  const html = readFileSync(filePath, "utf8");
  if (!/<title>[^<]*<\/title>/iu.test(html)) return;
  const escaped = title
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  writeFileSync(filePath, html.replace(/<title>[^<]*<\/title>/iu, `<title>${escaped}</title>`), "utf8");
}

function withChildTrace(result: AgentRunResult, childTrace: AgentChildTrace | undefined): AgentRunResult {
  return childTrace === undefined ? result : { ...result, childTrace };
}

function createSdkSessionRecord(request: AgentRunRequest, childSessionId: string): SessionRecord {
  const session: SessionRecord = {
    id: childSessionId,
    createdAt: "agent-sdk-session",
    metadata: {
      source: "agent-sdk-session-host",
      executionMode: request.executionMode,
      ...(request.executionMode === "named" ? { agentName: request.agent.name } : {}),
      maxTurns: request.maxTurns ?? AGENT_BUDGET_UNBOUNDED,
      depth: request.depth,
      maxDepth: request.maxDepth,
    },
  };
  if (request.parentSessionId !== undefined) session.parentSessionId = request.parentSessionId;
  if (request.projectRoot !== undefined) session.projectRoot = request.projectRoot;
  if (request.workingDirectory !== undefined) session.workingDirectory = request.workingDirectory;
  return session;
}

function blockedResult(
  request: AgentRunRequest,
  reason: string,
  failureCause: AgentFailureCause,
  diagnostics: string[],
): AgentRunResult {
  return {
    status: "blocked",
    ...agentRunResultIdentity(request),
    reason,
    failureCause,
    diagnostics,
    lifecycleEntryIds: [],
  };
}

function failedResult(
  request: AgentRunRequest,
  reason: string,
  failureCause: AgentFailureCause,
  diagnostics: string[] = [reason],
  childOutputStats?: AgentChildOutputStats,
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "failed",
    ...agentRunResultIdentity(request),
    reason,
    failureCause,
    diagnostics,
    lifecycleEntryIds: [],
  };
  if (childOutputStats !== undefined) result.childOutputStats = childOutputStats;
  if (childSession !== undefined) result.childSession = childSession;
  return result;
}

function cancelledResult(
  request: AgentRunRequest,
  reason: string,
  diagnostics: string[] = [reason],
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "cancelled",
    ...agentRunResultIdentity(request),
    reason,
    // Cancellation has exactly one origin, so the cause is a constant rather than a parameter.
    failureCause: "cancelled",
    diagnostics: diagnostics.length === 0 ? [reason] : diagnostics,
    lifecycleEntryIds: [],
  };
  if (childSession !== undefined) result.childSession = childSession;
  return result;
}

function sanitizeStamp(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function assistantProviderFailure(messages: readonly unknown[] | undefined): string | undefined {
  if (messages === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      return eventFieldMessage(message.errorMessage) ?? "Child assistant failed with stopReason=error.";
    }
    if (message.stopReason === "length") {
      return "Child assistant reached the provider output-token limit (stopReason=length); refusing the truncated answer.";
    }
    return undefined;
  }
  return undefined;
}

function appendDirectSpawnBoundary(systemPrompt: string | undefined): string {
  const boundary = [
    "# Delegation boundary",
    "Do not call `spawn_agent` directly; direct sub-agent nesting is disabled by the host.",
    "If multi-agent orchestration is necessary, you may author and run a workflow through `workflow` when that tool is available.",
  ].join("\n");
  return systemPrompt === undefined || systemPrompt.trim() === "" ? boundary : `${systemPrompt}\n\n${boundary}`;
}

function liveBeginOptions(
  rowId: string | undefined,
  agentName: string,
  live: NonNullable<AgentSdkSessionExecutorOptions["live"]>,
  cwd: string,
  request: string,
): AgentLiveBeginOptions {
  const options: AgentLiveBeginOptions = {
    agentName,
    label: live.label ?? agentName,
    currentPath: cwd,
    request,
  };
  if (rowId !== undefined) options.id = rowId;
  if (live.title !== undefined) options.title = live.title;
  if (live.slotKey !== undefined) options.slotKey = live.slotKey;
  if (live.round !== undefined) options.round = live.round;
  if (live.parentRowId !== undefined) options.parentRowId = live.parentRowId;
  if (live.workflowRunId !== undefined) options.workflowRunId = live.workflowRunId;
  if (live.model !== undefined) options.model = live.model;
  if (live.thinking !== undefined) options.thinking = live.thinking;
  if (live.isolated !== undefined) options.isolated = live.isolated;
  if (live.noMcp !== undefined) options.noMcp = live.noMcp;
  return options;
}
