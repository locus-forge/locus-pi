/**
 * workflow-runtime.ts — DSL core (agent/fusion/phase/log) + journal mirror. The two
 * scheduling owners it composes sit beside it: the run's ONE execution budget — counter,
 * leaf-agent gate, deadline — in `workflow-execution-state.ts`, and `parallel()`/`pipeline()`
 * with their own per-group scheduler in `workflow-groups.ts`. Both moved out whole; every
 * public name they took is re-exported below under the identifier it has always had. The
 * SHAPED half of `agent()` — declaration dispatch and acceptance from the confirmed
 * `workflow_return` receipt — is `workflow-agent-output.ts`, composed the same way, and
 * `fusion()` — the panel's declaration, its member and judge prompts, and the order its
 * legs run in — is `workflow-fusion.ts`, which composes the `agent()` below rather than
 * running anything of its own.
 *
 * Pure host-agnostic core. Talks to agents ONLY through an injected WorkflowAgentRunner.
 * No fs / process / require / shell / network anywhere. Unit-testable in isolation.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

import { formatWorkflowBudgetRaise, formatWorkflowBudgetStop, type WorkflowBudget } from "./workflow-budget.js";
import type { WorkflowRunSummary } from "./workflow-journal-format.js";
import type { WorkflowReplayController } from "./workflow-replay.js";
import type { WorkflowResourceLoader } from "./workflow-resources.js";
import type { WorkflowWorkspaceManager } from "./workflow-worktree.js";
import type {
  WorkflowArtifactPorts,
  WorkflowArtifactRef,
  WorkflowBoundContinuation,
  WorkflowConsumedTextArtifact,
  WorkflowContinuationArtifact,
  WorkflowContinuationJournal,
} from "./workflow-artifacts.js";
import {
  normalizeWorkflowAwaitOperatorDeclaration,
  type WorkflowAwaitOperatorDeclaration,
  type WorkflowOperatorHandoffDeclaration,
  type WorkflowOperatorQuestion,
} from "./workflow-handoff-contract.js";
import type { PermissionMode } from "../../_shared/agent-runtime/agents.js";
import type { WorkflowPrimaryFileReference } from "./workflow-output.js";
// Every value this core reaches for a CONTRACT is the fs-free half of a pair, never its
// durable counterpart: operator handoff declarations come from `workflow-handoff-contract.ts`
// and not `workflow-handoff.ts`, the returned-outcome classification `workflow-groups.ts`
// performs comes from `workflow-outcome.ts` and not `workflow-result.ts`, and the closed
// agent failure-cause list is read inside `workflow-agent-contract.ts`, whose own source has
// no imports at all. Rule 7 of `scripts/check-extension-layers.ts` verifies transitively, so
// every module extracted below stays inside the same `node:fs`-free proof.
export type { PermissionMode } from "../../_shared/agent-runtime/agents.js";

// The journal EVENT CONTRACT — the line shape, every payload type it carries, and the
// strict codec that reads one back — is owned by `workflow-journal-format.ts`, the same
// lower-half split `workflow-artifact-format.ts` makes for the artifact index. This core
// writes lines against those types, so the edge is type-only in both directions: the
// format module never imports this one, and nothing it reaches enters this module's value
// closure, which rule 7 of `scripts/check-extension-layers.ts` still holds to `node:fs`-free.
// The names are re-exported one by one under the identifiers callers have always imported
// from here, so the move is invisible to every importer.
import type {
  WorkflowAgentChildTrace,
  WorkflowAgentFailureCause,
  WorkflowFusionMode,
  WorkflowJournalLine,
  WorkflowJournalSink,
  WorkflowSchemaValidation,
  WorkflowUsage,
  WorkspaceMode,
} from "./workflow-journal-format.js";
export type {
  WorkflowAgentChildTrace,
  WorkflowAgentFailureCause,
  WorkflowChoiceCoercion,
  WorkflowChoiceDecision,
  WorkflowFusionMode,
  WorkflowJournalLine,
  WorkflowJournalSink,
  WorkflowSchemaValidation,
  WorkflowUsage,
  WorkspaceMode,
} from "./workflow-journal-format.js";

export type {
  WorkflowAwaitOperatorDeclaration,
  WorkflowOperatorHandoffDeclaration,
  WorkflowOperatorQuestion,
} from "./workflow-handoff-contract.js";

// The RUN-level execution budget — the one fresh-invocation counter, the one leaf-agent
// concurrency gate, the one deadline, and the two typed refusals those axes raise — is owned
// by `workflow-execution-state.ts`. `workflow-runner.ts` creates exactly ONE of those objects
// per root run and hands the same object to this core and to every saved-child runtime.
import {
  createWorkflowSharedExecutionState,
  WorkflowInvocationCapError,
  WorkflowRunDeadlineError,
  type WorkflowSharedExecutionState,
} from "./workflow-execution-state.js";
export {
  createWorkflowSharedExecutionState,
  WorkflowInvocationCapError,
  WorkflowRunDeadlineError,
} from "./workflow-execution-state.js";
export type { WorkflowSharedExecutionState } from "./workflow-execution-state.js";

// `parallel()` / `pipeline()` — branch identity, the PER-GROUP scheduler, the fail-closed
// barrier and the typed partial result it raises — are owned by `workflow-groups.ts`. That
// scheduler is NOT the leaf gate above: it bounds the width of one group operation, which is
// exactly why a nested `dsl.agent()` inside a wrapper cannot deadlock against leaf slots.
// This core keeps the DSL assembly and hands the agent call a read-only view of branch identity.
import {
  createWorkflowGroupExecution,
  type WorkflowGroupExecution,
  type WorkflowParallelOptions,
  type WorkflowStage,
} from "./workflow-groups.js";
export { WORKFLOW_GROUP_FAILURE, WorkflowGroupFailureError, workflowGroupFailureEnvelope } from "./workflow-groups.js";
export type {
  WorkflowBranchFailure,
  WorkflowGroupEnvelopeSlot,
  WorkflowGroupFailureEnvelope,
  WorkflowGroupKind,
  WorkflowGroupSlot,
  WorkflowParallelOptions,
  WorkflowStage,
} from "./workflow-groups.js";

// ONE agent call is two owners, and this core composes them rather than containing them.
//
// `workflow-agent-contract.ts` holds the shared vocabulary — request, result, callsite
// options, the closed failure-cause reading, every typed refusal and the pure identity
// projections — so the two owners and `workflow-agent-bridge.ts` agree on one definition of
// each without importing this composition root.
//
// `workflow-agent-call.ts` owns the LOGICAL call: the per-run ordinal, the `(phase,label)`
// occurrence map, the live-row slot claim, the canonical request key, the replay envelope
// and the transport-retry loop. `workflow-agent-attempt.ts` owns ONE PHYSICAL child: the
// invocation charge, its `callId`, the leaf permit, the journal pair and evidence adoption.
// The split is what keeps a retry of one call from ever reading as two calls.
//
// Every public name they took is re-exported below under the identifier it has always had,
// and both are value-imported here, so rule 7 of `scripts/check-extension-layers.ts` holds
// them to this core's `node:fs`-free proof transitively.
import { createWorkflowAgentAttempt } from "./workflow-agent-attempt.js";
import { createWorkflowAgentCall } from "./workflow-agent-call.js";
import {
  normalizeMaxToolCalls,
  normalizeMaxTurns,
  normalizeTimeoutMs,
  type WorkflowAgentAnyOptions,
  type WorkflowAgentChoiceOptions,
  type WorkflowAgentHandoffOptions,
  type WorkflowAgentOptions,
  type WorkflowAgentPreflight,
  type WorkflowAgentReportOptions,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
  type WorkflowAgentSchemaOptions,
} from "./workflow-agent-contract.js";
export {
  SchemaValidationError,
  WORKFLOW_SHAPED_TRANSPORT_REFUSAL,
  WorkflowAgentExecutionError,
  WorkflowAgentSlotConflictError,
  WorkflowOutputCapabilityError,
  workflowSlotKey,
} from "./workflow-agent-contract.js";
export type {
  WorkflowAgentChoiceOptions,
  WorkflowAgentHandoffBounds,
  WorkflowAgentHandoffOptions,
  WorkflowAgentOptions,
  WorkflowAgentPreflight,
  WorkflowAgentPreflightRequest,
  WorkflowAgentReportOptions,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowAgentRunner,
  WorkflowAgentSchemaOptions,
  WorkflowAgentValidate,
} from "./workflow-agent-contract.js";

// The SHAPED-OUTPUT half of a call — turning `choice`/`handoffs`/`schema`/`output`/
// `validate` into the request, and accepting a value ONLY from the confirmed
// `workflow_return` receipt — is owned by `workflow-agent-output.ts`. It is its own owner
// rather than part of the call because "what shape was declared, and was this answer
// accepted" is a different question from "which call is this, and may it repeat". The
// core value-imports it, so rule 7 of `scripts/check-extension-layers.ts` holds it to the
// same `node:fs`-free proof transitively, and every public name it took is re-exported
// below under the identifier it has always had.
// Every name it took was module-private here, so there is no re-export to keep: the
// identifiers importers use — `SchemaValidationError`, `WorkflowOutputCapabilityError`,
// the option types — are the contract's and are still re-exported above, unchanged.
import { createWorkflowAgentOutput } from "./workflow-agent-output.js";

export class WorkflowRunWorkspaceRemovedError extends Error {
  readonly code = "WORKFLOW_RUN_WORKSPACE_REMOVED";

  constructor() {
    super(
      "runWorkspaceDir() was removed: use outputDir() for the project-local workflow workspace; run evidence now contains no writable workspace directory",
    );
    this.name = "WorkflowRunWorkspaceRemovedError";
  }
}

/** Journal prelude for the run-level no-operator mode. Deliberately names the
 *  guarantee ("operator input"), not any one method: `awaitOperator` and a
 *  stage's `agent({ ask: true })` obey the same mode. */
export const WORKFLOW_NO_OPERATOR_PRELUDE = "[workflow:no-operator] operator input is forbidden for this run";

/**
 * The same prelude for a headless (`print`/`json`) launch, where the mode is
 * the default rather than a typed flag. A reader who never asked for the mode
 * still has to be able to explain a refused `awaitOperator`, so the line says
 * that this launch has no operator to reach. The opt-out is named per surface
 * in REFERENCE, not here.
 */
export const WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE = `${WORKFLOW_NO_OPERATOR_PRELUDE} (headless launch: no operator can be reached)`;

/** Named fail-closed refusal for an operator-input request under the mode.
 *  The author's own reason travels inside so the terminal error stays actionable. */
export function workflowOperatorInputForbiddenError(reason: string): string {
  return `Operator input requested but forbidden for this run (no-operator mode): ${reason}`;
}

// Fusion — the panel's declaration, its member and judge prompts, and the order its legs
// run in — is owned by `workflow-fusion.ts`. It is a COMPOSITION of calls this DSL already
// makes rather than a second execution path, so it reaches the run only through named
// ports this root hands it: the same `agent()`, the same group scheduler, the same
// reservation and the same journal. It never imports this composition root and creates no
// artifact store of its own, and this root value-imports it, so rule 7 of
// `scripts/check-extension-layers.ts` holds it to the same `node:fs`-free proof
// transitively. Every public name it took is re-exported below under the identifier it has
// always had, so `fusion/runner.ts`, `fusion/config.ts` and every script importer are
// unaffected by the move.
import {
  createWorkflowFusion,
  type WorkflowFusionOptions,
  type WorkflowFusionSchemaOptions,
} from "./workflow-fusion.js";
export { WORKFLOW_FUSION_MIN_MEMBERS } from "./workflow-fusion.js";
export type {
  WorkflowFusionCallLimits,
  WorkflowFusionContext,
  WorkflowFusionJudge,
  WorkflowFusionMember,
  WorkflowFusionModelSelector,
  WorkflowFusionOptions,
  WorkflowFusionSchemaOptions,
} from "./workflow-fusion.js";

export interface WorkflowDsl {
  /** Observe an exact answer or an eligible terminal failure as opaque host-rendered text. */
  agent(prompt: string, opts: WorkflowAgentReportOptions): Promise<string>;
  /** Run one child agent under a small runtime-owned exact-choice contract. */
  agent<const Choices extends readonly [string, string, ...string[]]>(
    prompt: string,
    opts: WorkflowAgentChoiceOptions<Choices>,
  ): Promise<Choices[number]>;
  /** Dynamic choice lists keep runtime validation but cannot expose a literal union. */
  agent(prompt: string, opts: WorkflowAgentChoiceOptions): Promise<string>;
  /** Discover a bounded runtime list of complete text handoffs for downstream fan-out. */
  agent(prompt: string, opts: WorkflowAgentHandoffOptions): Promise<string[]>;
  /** Run one child agent under a declared answer shape. Success resolves to the
   *  VALIDATED value (not text); exhausting the retry budget throws SchemaValidationError. */
  agent(prompt: string, opts: WorkflowAgentSchemaOptions): Promise<unknown>;
  /** Run one child agent. Success resolves to its exact non-empty final text. */
  agent(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  /** Ask a bounded panel of explicitly selected models, then have a separate judge
   *  synthesize their ordered answers under the existing schema contract. */
  fusion(question: string, opts: WorkflowFusionSchemaOptions): Promise<unknown>;
  /** Ask a bounded panel of explicitly selected models and return the judge's exact text. */
  fusion(question: string, opts: WorkflowFusionOptions): Promise<string>;
  /** Render one neighboring .prompt.md resource from the original workflow source. */
  promptFile(path: string, variables?: Record<string, string>): Promise<string>;
  /** Allocate one retained runtime-owned linked worktree at an exact Git ref. */
  workspace(label: string, ref: string): Promise<string>;
  /** Absolute project root captured by the workflow runner. */
  projectRoot(): string;
  /** @deprecated Removed. Use outputDir(); calling this throws WorkflowRunWorkspaceRemovedError. */
  runWorkspaceDir(): string;
  /** Project-relative workflow workspace, shared by this execution tree. */
  outputDir(): string;
  /** Persist deterministic workflow-authored text and return its complete digest-bound reference. */
  publishArtifact(name: string, text: string): WorkflowArtifactRef;
  /** Publish exact text, or host-check and retain a workspace workflow source file. */
  publishPrimaryArtifact(name: string, text: string | { workflowSource: string }, stage?: string): WorkflowArtifactRef;
  /** Validate and publish one non-empty regular file by reference without copying its content. */
  publishPrimaryFile(relativePath: string): WorkflowPrimaryFileReference;
  /** Verify and copy one complete prior-run text reference into this run. */
  consumeTextArtifact(ref: WorkflowArtifactRef): WorkflowConsumedTextArtifact;
  /** Host-verified continuation artifacts bound before trusted workflow code starts. */
  continuationArtifacts(): readonly WorkflowContinuationArtifact[];
  /** Caller-supplied exact text work units as an immutable snapshot. */
  items(): readonly string[];
  /** Run independent branches behind one fail-closed barrier and preserve input order. */
  parallel<T>(thunks: Array<() => Promise<T>>, options?: WorkflowParallelOptions): Promise<T[]>;
  /** Run ordered stages for every item; a failed item stops before its later stages. */
  pipeline<T>(items: readonly T[], ...stages: Array<WorkflowStage<unknown>>): Promise<unknown[]>;
  /** Change the current reader-visible stage and append a phase line to the run journal. */
  phase(name: string): void;
  /** Append a script-owned journal message tagged with the current phase. */
  log(msg: string): void;
  /** Declare that a successful run is waiting for bounded operator input.
   *  This is runtime control state; it never changes the script's returned value. */
  awaitOperator(input: WorkflowAwaitOperatorDeclaration): void;
  /** Replay-safe wall clock. Records its value on the first run and returns the
   *  recorded one on `--resume`; a direct `Date.now()` is neither banned nor replayable. */
  now(): number;
  /** Replay-safe randomness with the same record/replay contract as `now()`. */
  random(): number;
  /** Run a nested workflow function with the same typed DSL handle. */
  workflow<T = unknown>(subFn: (dsl: WorkflowDsl, input?: string) => Promise<T>, input?: string): Promise<T>;
  /** Start one reviewed saved child workflow under the root execution's coordination context. */
  invokeWorkflow(input: WorkflowSavedChildInvocation): Promise<WorkflowSavedChildResult>;
}

interface WorkflowSavedChildInvocationFields {
  input?: string;
  items?: readonly string[];
  /** Stable semantic identity for this item. Opaque payload does not redefine it. */
  key: string;
  /** Complete key set, validated before the first child starts. */
  keys: readonly string[];
  /** Must equal this execution tree's project-relative workflow workspace. */
  outputDir: string;
}

type WorkflowSavedChildSelector =
  | { child: string; name?: never; scriptPath?: never; packageName?: never }
  | { child?: never; name: string; scriptPath?: never; packageName?: never }
  | { child?: never; name?: never; scriptPath: string; packageName?: never }
  | { child?: never; name?: never; scriptPath?: never; packageName: string };

/** One target selector plus the shared child-run contract. */
export type WorkflowSavedChildInvocation = WorkflowSavedChildInvocationFields & WorkflowSavedChildSelector;

export interface WorkflowSavedChildResult {
  status: "completed" | "skipped";
  key: string;
  outputDir: string;
  runId?: string;
  /** Completed run whose checkpoint caused this invocation to skip. */
  sourceRunId?: string;
  primaryFile?: WorkflowPrimaryFileReference;
}

export type WorkflowSavedChildRunner = (input: WorkflowSavedChildInvocation) => Promise<WorkflowSavedChildResult>;

export interface WorkflowRuntimeOptions {
  runId: string;
  agentRunner: WorkflowAgentRunner;
  args?: string;
  /** Exact text work units supplied by the invocation boundary. */
  items?: readonly string[];
  /** Already consumed and digest-bound by the runner before workflow code starts. */
  continuation?: WorkflowBoundContinuation;
  projectRoot?: string;
  /** Project-relative workflow workspace. */
  outputDir?: string;
  /** Host-owned confined source read and syntax/orchestration-only check. */
  readCheckedWorkflowSource?: (relativePath: string) => string;
  /** Host-owned regular-file validator/reference publisher. */
  publishPrimaryFile?: (relativePath: string) => WorkflowPrimaryFileReference;
  /** Host-owned saved-child runner. Absent in bare runtime embeddings. */
  invokeWorkflow?: WorkflowSavedChildRunner;
  /** Root-owned physical-agent counter, concurrency gate, and deadline.
   *  Required by runWorkflowScript; optional only for direct host-agnostic runtime embeddings. */
  sharedExecution?: WorkflowSharedExecutionState;
  resourceLoader?: WorkflowResourceLoader;
  workspaceManager?: WorkflowWorkspaceManager;
  /** Global simultaneous leaf agents; also the default parallel()/pipeline() width.
   *  Defaults to DEFAULT_WORKFLOW_CONCURRENCY — the ONE width in the runtime. */
  maxConcurrentAgents?: number;
  /** Default per-child tool-call safety fuse. Absent means the axis is unbounded:
   *  no counter refuses a tool start and the run header prints `unbounded`. */
  defaultMaxToolCalls?: number;
  /** Default wall-clock fuse for one child attempt. Absent means a call that
   *  declares none arms no workflow-level fuse and is bounded only by the SDK host. */
  defaultTimeoutMs?: number;
  /** Default cumulative SDK model cycles per child attempt.
   *  Absent leaves the bridge's own default in place. */
  defaultMaxTurns?: number;
  /**
   * Wall clock over the agent chain, in milliseconds, armed once at construction.
   * The deadline is checked when a child STARTS, so a run is bounded by this value
   * plus at most one child's own `timeoutMs`. Absent means no run deadline.
   */
  runtimeMs?: number;
  /** Injectable numeric clock for the run deadline; defaults to `Date.now`. Separate
   *  from `now()`, which produces ISO strings for journal lines. */
  nowMs?: () => number;
  // Global per-run cap across FRESH agent() calls; absent means unbounded.
  // Cyclic workflows are allowed up to the cap; exceeding it throws
  // WorkflowInvocationCapError before the next child starts and exits the run.
  maxTotalAgentInvocations?: number;
  /** Optional host-side declaration resolver. Fusion uses it for all members and
   *  the judge before any child call; bare runtime embedders may omit it. */
  preflightAgentRequests?: WorkflowAgentPreflight;
  journal?: WorkflowJournalSink; // default: no-op sink
  /** Recorded-call store for `--resume`. Absent means neither record nor replay. */
  replay?: WorkflowReplayController;
  artifactPorts?: WorkflowArtifactPorts;
  replaySourceRunId?: string;
  now?: () => string; // default () => new Date().toISOString()
  onEvent?: (line: WorkflowJournalLine) => void; // progress callback (UI streaming)
  /** Runner-owned sink for one out-of-band operator handoff declaration. */
  onAwaitOperator?: (declaration: WorkflowAwaitOperatorDeclaration) => void;
  /** Run-level no-operator mode: `awaitOperator` fails closed at the call site
   *  with a named reason instead of declaring a pause. Method-agnostic — the
   *  same run mode makes the agent bridge refuse `agent({ ask: true })`. */
  operatorInputForbidden?: boolean;
}

export interface WorkflowRuntime {
  dsl: WorkflowDsl;
  getJournal(): WorkflowJournalLine[]; // in-memory mirror (for tests / final render)
  /** Append one host-owned runtime record in exact order with script events. */
  recordRuntimeLog(message: string): void;
  getArgs(): string | undefined;
  currentPhase(): string | undefined;
  /** Gate-owned high-water mark of simultaneously executing leaf agents. The only
   *  honest source for this number; the journal cannot produce it (see AgentConcurrencyGate). */
  peakAgentConcurrency(): number;
}

export function assertWorkflowInput(value: unknown, field = "workflow input"): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
}

const EMPTY_WORKFLOW_ITEMS: readonly string[] = Object.freeze([]);

/** Validate external item transport and detach it from caller-owned mutation. */
export function snapshotWorkflowItems(value: unknown, field = "workflow items"): readonly string[] {
  if (value === undefined) return EMPTY_WORKFLOW_ITEMS;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings when provided`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw new Error(`${field}[${index}] must be a string`);
  }
  return Object.freeze([...value]);
}

// ---------------------------------------------------------------------------
// createWorkflowRuntime
// ---------------------------------------------------------------------------

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const { runId, agentRunner } = options;
  assertWorkflowInput(options.args);
  const items = snapshotWorkflowItems(options.items);
  assertBoundContinuation(options.continuation, runId);
  const args = options.args;
  // No package fallback on any of the three per-call axes: absent means unbounded,
  // and the run header says so in one word rather than leaving an operator to guess
  // which invisible number their child is running under.
  const defaultMaxToolCalls =
    options.defaultMaxToolCalls === undefined
      ? undefined
      : normalizeMaxToolCalls(options.defaultMaxToolCalls, "defaultMaxToolCalls");
  const defaultTimeoutMs =
    options.defaultTimeoutMs === undefined ? undefined : normalizeTimeoutMs(options.defaultTimeoutMs);
  const defaultMaxTurns =
    options.defaultMaxTurns === undefined ? undefined : normalizeMaxTurns(options.defaultMaxTurns);
  // Direct runtime embeddings predate saved-child execution and own no runner
  // coordination object, so they retain a private scheduler. runWorkflowScript
  // always supplies the root-owned state and fails before constructing a runtime
  // if that invariant is broken.
  const sharedExecution =
    options.sharedExecution ??
    createWorkflowSharedExecutionState({
      ...(options.maxConcurrentAgents === undefined ? {} : { maxConcurrentAgents: options.maxConcurrentAgents }),
      ...(options.maxTotalAgentInvocations === undefined
        ? {}
        : { maxTotalAgentInvocations: options.maxTotalAgentInvocations }),
      ...(options.runtimeMs === undefined ? {} : { runtimeMs: options.runtimeMs }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    });

  let totalFusionCalls = 0;
  const journal = options.journal;
  const nowFn = options.now ?? (() => new Date().toISOString());
  const onEvent = options.onEvent;

  const journalMirror: WorkflowJournalLine[] = [];
  let _currentPhase: string | undefined;
  /** Set while a script `validate` callback is running. The callback sits between the
   *  child answer and agent_end, before artifact recording and replay journaling, so a
   *  nested child call there has no defined position in either sequence. */
  let insideValidate = false;
  const groups: WorkflowGroupExecution = createWorkflowGroupExecution({
    runId,
    now: nowFn,
    emit,
    sharedExecution,
    rootPhase: () => _currentPhase,
    setRootPhase: (name) => {
      _currentPhase = name;
    },
  });
  const currentPhase = (): string | undefined => groups.currentPhase();

  function emit(line: WorkflowJournalLine): void {
    journalMirror.push(line);
    try {
      journal?.write(line);
    } catch {
      // never throw into the DSL
    }
    try {
      onEvent?.(line);
    } catch {
      // never throw into the DSL
    }
  }

  /**
   * One runtime-source journal line per per-call axis raised above the value the run
   * would otherwise have applied. An axis the run never bounded (no default configured)
   * cannot be "raised", so it is skipped rather than reported against nothing.
   */
  function journalPerCallRaises(
    axes: Partial<Record<keyof WorkflowBudget, { requested: number | undefined; applied: number | undefined }>>,
  ): void {
    for (const [axis, values] of Object.entries(axes) as Array<
      [keyof WorkflowBudget, { requested: number | undefined; applied: number | undefined }]
    >) {
      const { requested, applied } = values;
      if (requested === undefined || applied === undefined || requested <= applied) continue;
      emit({
        ts: nowFn(),
        runId,
        kind: "log",
        source: "runtime",
        message: formatWorkflowBudgetRaise({ axis, applied, requested }, "call"),
        ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
      });
    }
  }

  /**
   * Run one budget check and, if it stops the run, say so in the journal in the
   * operator's terms before the error leaves the runtime.
   *
   * This exists because the three notions the run separates elsewhere collapse here
   * otherwise. A run that ends on `totalAgents` or `runtimeMs` did not produce a bad
   * answer and did not lose anything: the limit its operator set was reached, every
   * answer already received is stored, and the only thing that did not happen is the
   * next child. The journal line names the axis and says the data is kept, so an
   * operator reading the tail of a headless log is not left to read a cap as a
   * failure of the work.
   */
  function journalBudgetStop<T>(check: () => T, phase: string | undefined): T {
    try {
      return check();
    } catch (error) {
      const axis: keyof WorkflowBudget | undefined =
        error instanceof WorkflowInvocationCapError
          ? "totalAgents"
          : error instanceof WorkflowRunDeadlineError
            ? "runtimeMs"
            : undefined;
      if (axis !== undefined) {
        emit({
          ts: nowFn(),
          runId,
          kind: "log",
          source: "runtime",
          message: formatWorkflowBudgetStop(axis, (error as Error).message),
          ...(phase !== undefined ? { phase } : {}),
        });
      }
      throw error;
    }
  }

  // The two halves of one agent call, composed in dependency order: the physical executor
  // first, because the logical call drives it. Each owns its own state — the attempt owns
  // nothing that survives it, the call owns the ordinal, the occurrence map and the slot
  // claim — and this root holds neither, so there is exactly one of each per runtime.
  const runPhysicalAgentAttempt = createWorkflowAgentAttempt({
    runId,
    now: nowFn,
    emit,
    agentRunner,
    sharedExecution,
    currentPhase,
    activeGroupFields: () => groups.activeGroupFields(),
    journalBudgetStop,
    ...(options.artifactPorts === undefined ? {} : { artifactPorts: options.artifactPorts }),
    ...(options.replaySourceRunId === undefined ? {} : { replaySourceRunId: options.replaySourceRunId }),
  });

  const { runAgentAttempt } = createWorkflowAgentCall({
    runId,
    now: nowFn,
    emit,
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    currentPhase,
    branchContext: () => groups.branchContext(),
    insideValidate: () => insideValidate,
    workspaceManagerConfigured: () => options.workspaceManager !== undefined,
    defaults: { maxToolCalls: defaultMaxToolCalls, timeoutMs: defaultTimeoutMs, maxTurns: defaultMaxTurns },
    journalPerCallRaises,
    runPhysicalAgentAttempt,
  });

  // The SHAPED-OUTPUT owner. It sees exactly four named capabilities — the journal
  // fan-out, branch identity, the validator re-entrancy latch and the ONE logical call —
  // and never this root, so the acceptance of a shaped answer has a single definition
  // that cannot reach back into the DSL it decides for.
  const shapedOutput = createWorkflowAgentOutput({
    runId,
    now: nowFn,
    emit,
    currentPhase,
    branchContext: () => groups.branchContext(),
    activeGroupFields: () => groups.activeGroupFields(),
    runScriptValidate: (run) => {
      insideValidate = true;
      try {
        return run();
      } finally {
        insideValidate = false;
      }
    },
    runAgentAttempt,
  });

  // The Fusion COMPOSITION owner, assembled from this root's existing capabilities rather
  // than given a context bag: the journal fan-out, the run's one budget, the per-group
  // scheduler, the named budget-stop wrapper and the ONE `agent()` below. Nothing here is
  // a second resolver, a second scheduler or a second acceptance path — a panel leg is an
  // ordinary DSL agent call, which is exactly why replay, evidence and the leaf gate all
  // treat it as one.
  const { fusion: fusionDsl } = createWorkflowFusion({
    runId,
    now: nowFn,
    emit,
    currentPhase,
    insideValidate: () => insideValidate,
    journalBudgetStop,
    sharedExecution,
    runParallel: groups.parallel,
    runAgentCall: agentDsl,
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.replaySourceRunId === undefined ? {} : { replaySourceRunId: options.replaySourceRunId }),
    ...(options.artifactPorts === undefined ? {} : { artifactPorts: options.artifactPorts }),
    ...(options.preflightAgentRequests === undefined ? {} : { preflightAgentRequests: options.preflightAgentRequests }),
  });

  /**
   * `agent()` — exact text by default, one shaped acceptance path for everything else.
   *
   * Without a shape this is one child run resolving to the child's EXACT final text: no
   * prompt augmentation, no parsing, no length policy, unchanged journal. A complete
   * report comes back complete, however long it is.
   *
   * With `choice`, `handoffs`, `schema` or `output` the value is accepted inside the
   * child's own session through the `workflow_return` tool (see `workflow-agent-output.ts`).
   * There is exactly ONE structured path now: the former text transport — which appended
   * a shape block to the prompt, parsed the final message, and spawned a FRESH child to
   * fix the format of an answer the previous child had already found — is deleted. A
   * fresh session cannot repair a form it has no memory of producing, and the two
   * dialects of "how a structured answer travels" could drift apart.
   *
   * `validate` extends the accepted contract to rules a schema cannot declare —
   * referential integrity, cross-field agreement, graph shape. It now runs inside the
   * same session, so a violation is a clarification the child can answer rather than a
   * new child that starts from nothing.
   *
   * `returnVia` is no longer needed: `"tool"` is accepted for one release and diagnosed
   * as redundant, and `"text"` is refused by name.
   */
  function agentDsl<const Choices extends readonly [string, string, ...string[]]>(
    prompt: string,
    opts: WorkflowAgentChoiceOptions<Choices>,
  ): Promise<Choices[number]>;
  function agentDsl(prompt: string, opts: WorkflowAgentChoiceOptions): Promise<string>;
  function agentDsl(prompt: string, opts: WorkflowAgentHandoffOptions): Promise<string[]>;
  function agentDsl(prompt: string, opts: WorkflowAgentSchemaOptions): Promise<unknown>;
  function agentDsl(prompt: string, opts: WorkflowAgentReportOptions): Promise<string>;
  function agentDsl(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  async function agentDsl(prompt: string, opts?: WorkflowAgentAnyOptions): Promise<unknown> {
    // Declaration dispatch, every refusal it fires, and the whole shaped acceptance belong
    // to `workflow-agent-output.ts`. This root only routes the two paths it names, so the
    // plain call keeps returning the child's exact full text through the logical call.
    if (shapedOutput.dispatchWorkflowAgentShape(opts) === "shaped") return shapedOutput.runShapedAgent(prompt, opts!);
    return (await runAgentAttempt(prompt, opts)).text;
  }

  function phase(name: string): void {
    // A branch owns its own phase; only an ungrouped call moves the run-level one.
    groups.setBranchPhase(name);
    emit({ ts: nowFn(), runId, kind: "phase", phase: name, ...groups.activeGroupFields() });
  }

  function log(msg: string): void {
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "script",
      message: msg,
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
  }

  function awaitOperator(input: WorkflowAwaitOperatorDeclaration): void {
    const declaration = normalizeWorkflowAwaitOperatorDeclaration(input);
    if (options.operatorInputForbidden === true) {
      // Fail closed at the call site: no pause envelope, no auto-answer. The
      // refusal is journalled before the throw so a script that catches it
      // cannot turn the request into silence.
      const message = workflowOperatorInputForbiddenError(declaration.reason);
      emit({
        ts: nowFn(),
        runId,
        kind: "log",
        source: "runtime",
        message: `[workflow:no-operator] ${message}`,
        ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
      });
      throw new Error(message);
    }
    if (options.onAwaitOperator === undefined) {
      throw new Error("awaitOperator is not configured by the workflow runner");
    }
    options.onAwaitOperator(declaration);
  }

  async function workflowDsl<T = unknown>(
    subFn: (dsl: WorkflowDsl, input?: string) => Promise<T>,
    input?: string,
  ): Promise<T> {
    assertWorkflowInput(input, "nested workflow input");
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:enter]",
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
    const result = await subFn(dsl, input);
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:exit]",
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
    return result;
  }

  async function invokeWorkflow(input: WorkflowSavedChildInvocation): Promise<WorkflowSavedChildResult> {
    if (options.invokeWorkflow === undefined) {
      throw new Error("saved child workflow invocation is not configured by the workflow runner");
    }
    return options.invokeWorkflow(input);
  }

  function recordRuntimeLog(message: string): void {
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message,
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
  }

  async function promptFile(path: string, variables?: Record<string, string>): Promise<string> {
    if (options.resourceLoader === undefined) {
      throw new Error("workflow resource loader is not configured");
    }
    return options.resourceLoader.renderPrompt(path, variables);
  }

  async function workspace(label: string, ref: string): Promise<string> {
    if (options.workspaceManager === undefined) {
      throw new Error("workflow workspace manager is not configured");
    }
    return options.workspaceManager.allocate(label, ref);
  }

  function projectRoot(): string {
    if (options.projectRoot === undefined || options.projectRoot.trim() === "") {
      throw new Error("workflow project root is not configured");
    }
    return options.projectRoot;
  }

  function runWorkspaceDir(): never {
    throw new WorkflowRunWorkspaceRemovedError();
  }

  function outputDir(): string {
    if (options.outputDir === undefined || options.outputDir.trim() === "") {
      throw new Error("workflow output directory is not configured");
    }
    return options.outputDir;
  }

  function publishArtifact(name: string, text: string): WorkflowArtifactRef {
    if (options.artifactPorts === undefined) throw new Error("workflow artifact store is not configured");
    return options.artifactPorts.publishText(name, text, currentPhase());
  }

  let primaryArtifactPublished = false;
  function publishPrimaryArtifact(
    name: string,
    text: string | { workflowSource: string },
    stage?: string,
  ): WorkflowArtifactRef {
    if (primaryArtifactPublished) throw new Error("workflow already published its primary output");
    if (options.artifactPorts === undefined) throw new Error("workflow artifact store is not configured");
    if (typeof text !== "string") {
      if (
        text === null ||
        typeof text !== "object" ||
        Object.keys(text).length !== 1 ||
        typeof text.workflowSource !== "string" ||
        options.readCheckedWorkflowSource === undefined
      ) {
        throw new Error("workflow source publication requires a configured host and { workflowSource: relativePath }");
      }
      text = options.readCheckedWorkflowSource(text.workflowSource);
    }
    const ref = options.artifactPorts.publishText(name, text, stage ?? currentPhase(), "primary");
    primaryArtifactPublished = true;
    return ref;
  }

  let primaryFilePublished = false;
  function publishPrimaryFile(relativePath: string): WorkflowPrimaryFileReference {
    if (primaryFilePublished) throw new Error("workflow already published its primary file");
    if (options.publishPrimaryFile === undefined) {
      throw new Error("workflow primary-file publication is not configured");
    }
    const reference = options.publishPrimaryFile(relativePath);
    primaryFilePublished = true;
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message: `[workflow:primary-file] path=${JSON.stringify(reference.relativePath)} sha256=${reference.sha256} bytes=${reference.bytes}`,
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
    return reference;
  }

  function consumeTextArtifact(ref: WorkflowArtifactRef): WorkflowConsumedTextArtifact {
    if (options.artifactPorts === undefined) throw new Error("workflow artifact store is not configured");
    return options.artifactPorts.consumeText(ref, currentPhase());
  }

  function continuationArtifacts(): readonly WorkflowContinuationArtifact[] {
    return options.continuation?.artifacts ?? [];
  }

  /**
   * The DSL's answer to replay determinism: supply the nondeterministic value
   * instead of banning the call. Without a replay store these are exactly
   * `Date.now()` / `Math.random()`; with one they are recorded on the first run
   * and returned from the record on a resumed run, until the prefix diverges.
   */
  function nowMs(): number {
    return options.replay === undefined ? Date.now() : options.replay.resolveValue("clock", () => Date.now());
  }

  function random(): number {
    return options.replay === undefined ? Math.random() : options.replay.resolveValue("random", () => Math.random());
  }

  const dsl: WorkflowDsl = {
    agent: agentDsl,
    fusion: fusionDsl,
    promptFile,
    workspace,
    projectRoot,
    runWorkspaceDir,
    outputDir,
    publishArtifact,
    publishPrimaryArtifact,
    publishPrimaryFile,
    consumeTextArtifact,
    continuationArtifacts,
    items: () => items,
    parallel: groups.parallel,
    pipeline: groups.pipeline,
    phase,
    log,
    awaitOperator,
    now: nowMs,
    random,
    workflow: workflowDsl,
    invokeWorkflow,
  };

  return {
    dsl,
    getJournal: () => [...journalMirror],
    recordRuntimeLog,
    getArgs: () => args,
    currentPhase,
    peakAgentConcurrency: () => sharedExecution.peakAgentConcurrency(),
  };
}

function assertBoundContinuation(binding: WorkflowBoundContinuation | undefined, runId: string): void {
  if (binding === undefined) return;
  if (typeof binding.originRunId !== "string" || binding.originRunId.trim() === "") {
    throw new Error("workflow continuation binding has an invalid originRunId");
  }
  // At least one artifact, and no upper bound: a continuation carries the evidence the
  // origin run actually produced, and refusing the ninth complete reference would drop
  // work the operator already paid for. Identity, origin and completeness stay enforced.
  if (!Array.isArray(binding.artifacts) || binding.artifacts.length < 1) {
    throw new Error("workflow continuation binding must contain at least one artifact");
  }
  const identities = new Set<string>();
  for (const pair of binding.artifacts) {
    if (!isRecord(pair) || !isRecord(pair.sourceRef) || !isRecord(pair.consumedArtifact)) {
      throw new Error("workflow continuation binding has an invalid artifact pair");
    }
    const sourceRef = pair.sourceRef as unknown as WorkflowArtifactRef;
    const consumed = pair.consumedArtifact as unknown as WorkflowConsumedTextArtifact;
    if (sourceRef.runId !== binding.originRunId || consumed.source?.runId !== binding.originRunId) {
      throw new Error("workflow continuation binding does not match its origin run");
    }
    if (!isRecord(consumed.ref) || consumed.ref.runId !== runId) {
      throw new Error("workflow continuation consumed artifact does not belong to the current run");
    }
    const identity = `${sourceRef.runId}\u001f${sourceRef.artifactId}`;
    if (identities.has(identity)) throw new Error("workflow continuation binding has a duplicate artifact identity");
    identities.add(identity);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
