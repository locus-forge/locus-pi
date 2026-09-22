/**
 * workflow-agent-contract.ts — the shared agent-call contract: what a workflow asks a
 * child for (`WorkflowAgentRequest`), what a child hands back (`WorkflowAgentResult`),
 * what an author may declare at a callsite (`WorkflowAgentOptions` and its shaped
 * variants), the closed failure-cause reading, the typed refusals, and the pure identity
 * projections both halves of a call derive from.
 *
 * The point of this module is that the two execution owners and the host bridge share ONE
 * definition of each of those without importing the composition root: the logical call
 * (`workflow-agent-call.ts`), the physical attempt (`workflow-agent-attempt.ts`),
 * `workflow-agent-bridge.ts` and `workflow-runtime.ts` all read the names from here, so
 * every error identity and every request key has exactly one definition.
 *
 * Types and pure helpers only. Nothing here runs a child, emits a journal line, touches a
 * counter or reaches a host: it is part of the DSL core's `node:fs`-free value closure
 * that rule 7 of `scripts/check-extension-layers.ts` proves transitively.
 */

import type { AgentOutputAcceptance } from "../../_shared/agent-runtime/agent-runner.js";
import type { EvidenceEvaluation } from "../../_shared/agent-runtime/agent-evidence-evaluator.js";
import type { PermissionMode } from "../../_shared/agent-runtime/agents.js";
// Read as a VALUE so a thrown cause is validated against the one closed list rather than a
// second copy of it. `agent-failure-cause.ts` has no imports at all, so nothing host-bound
// enters this module's closure through it.
import { AGENT_FAILURE_CAUSES } from "../../_shared/agent-runtime/agent-failure-cause.js";
import { assertRepresentableTimeoutMs } from "./workflow-budget.js";
import type {
  WorkflowAgentChildTrace,
  WorkflowAgentFailureCause,
  WorkflowFusionMode,
  WorkflowSchemaValidation,
  WorkflowUsage,
  WorkspaceMode,
} from "./workflow-journal-format.js";
// Two journal-format types the request and the result carry in their own fields, re-exported
// here so a consumer of the agent contract reads the whole callsite vocabulary from one
// module. These stay DEFINED by `workflow-journal-format.ts`; this is a name, not a copy.
export type { WorkflowUsage, WorkspaceMode } from "./workflow-journal-format.js";
import type { WorkflowAgentRowOccurrence } from "./workflow-groups.js";
import type { WorkflowInvocationReservation } from "./workflow-execution-state.js";
import type {
  WorkflowOutputRepair,
  WorkflowReturnContract,
  WorkflowReturnValidate,
  WorkflowStringOutput,
} from "./workflow-return.js";

/** The single agent-execution callback the runtime depends on. The bridge supplies
 *  the real implementation; tests supply a fake. The runtime never imports the SDK. */
export type WorkflowAgentRunner = (req: WorkflowAgentRequest) => Promise<WorkflowAgentResult>;

/** Read-only host validation used by compositions that must validate every leg
 *  before the first model call. It resolves declarations but spawns no child. */
export interface WorkflowAgentPreflightRequest {
  agent?: string;
  model?: string;
  modelRole?: string;
  /**
   * This leg will ask for a shaped result, so its transport must be able to host
   * session tools. Declared here because preflight runs before the legs exist: a
   * Fusion judge with a `schema` is the case that matters, and discovering its
   * transport cannot carry the shape only after every member has answered wastes
   * the whole panel.
   */
  expectsShapedResult?: boolean;
}

export type WorkflowAgentPreflight = (requests: readonly WorkflowAgentPreflightRequest[]) => Promise<void>;

export interface WorkflowAgentSlotDescriptor {
  readonly key: string;
  readonly rowOccurrence?: WorkflowAgentRowOccurrence;
}

/** The ONLY causes `attempts` re-asks: the child never got to answer, or lost the channel
 *  while answering. It is an allowlist, not "everything the never-retry list forgot" — an
 *  unnamed cause reads as `unclassified` and fails closed. */
export const TRANSPORT_RETRYABLE_FAILURE_CAUSES: ReadonlySet<WorkflowAgentFailureCause> = new Set([
  "host-turn-timeout",
  "call-timeout",
]);

/** A result written before the cause field existed is `unclassified`, never retryable.
 *  Absence is read here, once, instead of being inferred at each call site. */
export function workflowAgentFailureCause(
  result: Pick<WorkflowAgentResult, "failureCause">,
): WorkflowAgentFailureCause {
  return result.failureCause ?? "unclassified";
}

/** True only for a named transport cause. */
export function isTransportRetryableFailure(result: Pick<WorkflowAgentResult, "failureCause">): boolean {
  return TRANSPORT_RETRYABLE_FAILURE_CAUSES.has(workflowAgentFailureCause(result));
}

const AGENT_FAILURE_CAUSE_NAMES: ReadonlySet<string> = new Set(AGENT_FAILURE_CAUSES);

/**
 * The declared cause on a THROWN transport failure, or `undefined` when the throw carries
 * none.
 *
 * Some failures never reach a result at all: the bridge throws
 * `WorkflowAgentUnavailableError` when the SDK substrate is gone, because a run whose
 * children cannot be spawned must end rather than be re-asked. That throw still knows its
 * cause, and without this the journal's terminal record of the call is an English sentence
 * — exactly the prose-matching the closed list exists to remove.
 *
 * Read structurally rather than by `instanceof`, because the thrower is host-side and this
 * module may not import it, and validated against the closed list so an unrelated error
 * that happens to carry a `failureCause` property can never write an unreadable journal
 * line.
 */
export function thrownAgentFailureCause(err: unknown): WorkflowAgentFailureCause | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const declared = (err as { failureCause?: unknown }).failureCause;
  return typeof declared === "string" && AGENT_FAILURE_CAUSE_NAMES.has(declared)
    ? (declared as WorkflowAgentFailureCause)
    : undefined;
}

export interface WorkflowAgentRequest {
  /** Host-owned immutable contract; only the bridge injects its return tool. */
  returnContract?: WorkflowReturnContract;
  /** Author cross-field rules the acceptance tool applies in-session. Never canonicalized. */
  returnValidate?: WorkflowReturnValidate;
  prompt: string;
  executionMode?: "bare" | "named";
  agent?: string | undefined; // project/user catalog name; absent in bare mode
  /** @deprecated ignored by the workflow bridge; every child receives all tools. */
  readOnly?: true;
  /** Runtime-owned invariant: every workflow child request carries `["*"]`. */
  tools?: string[];
  /** Stage-declared live operator questions: the bridge injects the `workflow_ask`
   *  custom tool and this child may block on a human answer. */
  operatorAsk?: true;
  /** Fail-closed per-child tool-call safety fuse. The first over-budget start aborts the child. */
  maxToolCalls?: number;
  /** Per-call concrete model selector, e.g. "provider/id" or "provider/id:high". */
  model?: string;
  /** Per-call tier: a name in the roles table, never a provider selector. */
  modelRole?: string;
  /** Refuse an unassigned per-call modelRole instead of inheriting the session model. */
  requireModelRole?: true;
  /** Runtime-owned resolved value. Workflow source cannot override it. */
  permissionMode?: PermissionMode;
  /** Wall-clock fuse for this attempt; the bridge aborts the child when it expires. */
  timeoutMs?: number;
  /** Assistant turns this child attempt may take. Also the multiplier the SDK host
   *  uses for its own child deadline, which is why it is a budget axis and not a detail. */
  maxTurns?: number;
  label?: string;
  /** Human display only; not a callsite or replay identity. */
  title?: string;
  /** Runtime-owned business path from keyed parallel groups. */
  itemPath?: readonly string[];
  phase?: string;
  /** @deprecated use permissionMode / workspaceMode (P2-2) — this field remains a compatible alias; worktree isolation only, not a security boundary */
  sandbox?: "read-only" | "workspace-write";
  /** Workspace isolation intent for the child run. Worktrees isolate file changes for review, not security. */
  workspaceMode?: WorkspaceMode;
  /** Opaque runtime-owned workspace identity. The bridge resolves it to cwd. */
  workspaceHandle?: string;
  /** Runtime-owned stable identity allocated before this attempt is scheduled. */
  callId?: string;
  /** @internal Runtime/bridge transport for live-row identity. Workflow source cannot set it. */
  workflowSlot?: WorkflowAgentSlotDescriptor;
  /** Runtime-owned and reachable only from Fusion's internal invocation path. */
  capabilityMode?: WorkflowFusionMode;
}

export interface WorkflowAgentResult {
  outputAcceptance?: AgentOutputAcceptance;
  ok: boolean; // true when status === "completed"
  status: "completed" | "failed" | "cancelled" | "blocked";
  summary: string;
  /** Machine-readable origin of a non-completed call. Absent means the cause was never
   *  declared, which reads as `unclassified` — see `workflowAgentFailureCause`. */
  failureCause?: WorkflowAgentFailureCause;
  /** Exact final child text when status is completed. */
  text?: string;
  diagnostics: string[];
  evidence?: EvidenceEvaluation;
  executionMode?: "bare" | "named";
  agent?: string | undefined;
  /** Session-scoped petname from the live execution row; additive to durable `agent`. */
  displayName?: string;
  label?: string;
  title?: string;
  itemPath?: readonly string[];
  childSessionId?: string;
  childTrace?: WorkflowAgentChildTrace;
  resultArtifact?: string;
  worktreePath?: string;
  /** Executed model selector read back from the child; absent when unavailable. */
  model?: string;
  /** Executed reasoning effort read back from the child; absent when unavailable. */
  thinking?: string;
  /**
   * What the CHILD SESSION reported it ran on, read back from the host after the
   * session was created — not the selector this bridge asked for. `"unavailable"`
   * when the peer exposes no model on its session; never back-filled from the
   * request, because repeating a request back proves only that we remember it.
   */
  executedModel?: string;
  /**
   * Set when a declared tier had no assignment in the global config and the child therefore
   * inherited the parent session model. One sentence names the role and global
   * config that was read. Quiet fallback, loud record.
   */
  modelRoleFallback?: string;
  /** Opaque effective slot key set by the runtime/bridge; readers compare the whole value and never parse it (REQ-009). */
  slotKey?: string;
  /** Loop round for the slot (≥1); the bridge increments it per slot re-invoke (REQ-009). */
  round?: number;
  /** Token usage for this run, projected from the child session stats for the round journal (D-004/D-006). */
  usage?: WorkflowUsage;
  permissionMode?: PermissionMode;
  workspaceMode?: WorkspaceMode;
  /** Resolved host-enforced read-only capability boundary. */
  readOnly?: boolean;
  /** Exact pre-prompt host readback. Absent on replay and unavailable live hosts. */
  activeToolNames?: string[];
}

export interface WorkflowAgentOptions {
  /** Report mode has its own plain-text overload. */
  result?: never;
  /** @deprecated Redundant and ignored. Every shaped call is carried by same-session
   *  acceptance now, so `"tool"` says nothing; it is accepted for one release and journaled
   *  as a deprecation. `"text"` names a transport that no longer exists and is refused. */
  returnVia?: "tool";
  output?: WorkflowStringOutput;
  repair?: WorkflowOutputRepair;
  agent?: string; // project/user catalog name; omit for a clean child session
  /** @deprecated ignored; workflow children always receive all tools and can write. */
  readOnly?: true;
  /** @deprecated ignored; workflow children always receive `allowedTools: ["*"]`. */
  tools?: string[];
  /**
   * Let THIS child ask the operator live clarifying questions through the
   * `workflow_ask` tool: the question renders in the parent session, the answer
   * returns as the tool result, and the same child continues (owner decision,
   * soul direction log 2026-08-19). Off unless declared — the tool is simply not
   * injected, and the stock `ask` is excluded from every workflow child either
   * way. Interactive parents only: with no UI the call fails closed with the
   * named `ask-unavailable` cause instead of parking or degrading.
   */
  ask?: true;
  /** Maximum tool calls per child attempt; defaults to the runtime safety fuse. */
  maxToolCalls?: number;
  /**
   * Concrete model for this call, always `provider/id` with an optional
   * `:off|minimal|low|medium|high|xhigh` child reasoning-effort suffix. A selector
   * no configured provider can serve fails the call by name; it never silently
   * runs on the session model.
   */
  model?: string;
  /**
   * Tier for this call: a name in the roles table (`smol`, `slow`, `task`, …), never
   * a provider selector. The package ships no assignments, so the global user
   * `~/.pi/agent/model-roles/config.json` has to say what the name means. A role the
   * global config does not assign degrades to the parent session model, and the
   * degradation is recorded on `agent_end`, in the run-result artifact and in the
   * run report. `model` and `modelRole` each have exactly one meaning — the option
   * chosen at the call site says which one the author meant.
   */
  modelRole?: string;
  /**
   * Require this call's explicit `modelRole` to resolve from the global model-roles config.
   * Normal calls retain the portable recorded fallback. Evidence-critical stages
   * can opt into fail-closed routing without pinning a provider-specific model.
   */
  requireModelRole?: true;
  /**
   * Wall-clock fuse for one child attempt, in milliseconds. `maxToolCalls` bounds
   * tool usage and cannot end a stalled child. On expiry the child is aborted and
   * the call fails closed; it never resolves to a partial answer.
   */
  timeoutMs?: number;
  /**
   * SDK model cycles for one child attempt, including ordinary tool use and
   * output clarification. Positive safe integer, not a restart count. The
   * computed timeout/turn pair must fit the host timer.
   */
  maxTurns?: number;
  /**
   * Physical child attempts for this ONE logical call when the TRANSPORT failed — the child
   * never got to answer, or lost the channel while answering. Default 1, no ceiling; refused,
   * never clamped, when it is not a positive integer.
   *
   * It never re-asks because an answer was weak: that is a critic agent's job, and an answer
   * whose SHAPE is wrong already has its own bounded repair (`schema` + `validate`). Refused
   * at declaration time for ordinary project calls because every workflow child can write,
   * and a child that timed out mid-edit may already have changed the repository.
   */
  attempts?: number;
  label?: string;
  /** Human display only; use a literal label for callsite identity. */
  title?: string;
  /** Logical name for the exact returned answer in the run artifact index. */
  artifact?: string;
  phase?: string;
  /** @deprecated use permissionMode / workspaceMode (P2-2) — this field remains a compatible alias; worktree isolation only, not a security boundary */
  sandbox?: "read-only" | "workspace-write";
  /** @deprecated ignored; workflow children always inherit the parent permission mode. */
  permissionMode?: PermissionMode;
  /** Workspace isolation intent for the child run. Worktrees isolate file changes for review, not security. */
  workspaceMode?: WorkspaceMode;
  /** Reuse a runtime-owned workspace allocated by workspace(). */
  workspaceHandle?: string;
  /** A choice selects WorkflowAgentChoiceOptions instead of the exact-text overload. */
  choice?: never;
  /** A choice fallback is valid only with WorkflowAgentChoiceOptions. */
  choiceFallback?: never;
  /** Handoffs select WorkflowAgentHandoffOptions instead of the exact-text overload. */
  handoffs?: never;
  /** A schema selects WorkflowAgentSchemaOptions instead of the exact-text overload. */
  schema?: never;
  /** validate needs a parsed value, which only the shaped overload has. */
  validate?: never;
}

/**
 * Script-supplied cross-field validation for one shaped answer.
 *
 * Receives the parsed, schema-valid value; returns the violations it found, empty
 * for a pass. It must be pure, synchronous and deterministic, must not throw to
 * signal a violation, must not transform the value, and must not call back into
 * the DSL. Its strings are spliced into the retry prompt and therefore enter the
 * canonical replay key, so an unstable message is a replay defect.
 */
export type WorkflowAgentValidate = (value: unknown) => readonly string[];

/** Options for the standard machine-routing form. The runtime desugars this to
 *  the existing string-enum schema path, including its repair, replay and journal
 *  semantics. Narrative output remains exact text. */
export interface WorkflowAgentChoiceOptions<Choices extends readonly string[] = readonly string[]> extends Omit<
  WorkflowAgentOptions,
  "choice" | "choiceFallback" | "handoffs" | "schema" | "validate"
> {
  choice: Choices;
  /** Exact declared route used only after the normal schema-repair budget is exhausted. */
  choiceFallback?: Choices[number];
  handoffs?: never;
  schema?: never;
  validate?: never;
}

/**
 * What an author may still declare about a discovered work queue.
 *
 * Both fields are optional and both are the CONSUMER's contract, not a budget: `minItems`
 * says "this stage failed if it found nothing", `maxItems` says "this consumer genuinely
 * cannot take more than N". A discovery stage that knows neither declares `{}` and every
 * complete unit it finds is accepted, at any length and any count.
 */
export interface WorkflowAgentHandoffBounds {
  minItems?: number;
  maxItems?: number;
}

/** Standard dynamic-decomposition form. Each returned string is one complete,
 * non-blank, unique downstream handoff. The runtime desugars this to the existing
 * array-of-strings schema path, including repair, replay and journal semantics. */
export interface WorkflowAgentHandoffOptions extends Omit<
  WorkflowAgentOptions,
  "choice" | "choiceFallback" | "handoffs" | "output" | "schema" | "validate"
> {
  choice?: never;
  choiceFallback?: never;
  handoffs: WorkflowAgentHandoffBounds;
  /** A string-only contract; a shaped tool return carries its shape in handoffs. */
  output?: never;
  schema?: never;
  validate?: never;
}

/** Options for the shaped overload. The schema property cannot be smuggled through
 *  WorkflowAgentOptions, so a shaped call can never be typed as Promise<string>. */
export interface WorkflowAgentSchemaOptions extends Omit<
  WorkflowAgentOptions,
  "choice" | "choiceFallback" | "handoffs" | "output" | "schema" | "validate"
> {
  choice?: never;
  choiceFallback?: never;
  handoffs?: never;
  /** A string-only contract; a shaped tool return carries its shape in schema. */
  output?: never;
  schema: Record<string, unknown>;
  /** Cross-field rules the schema subset cannot declare. Runs only after schema
   *  validation succeeds; a non-empty return asks the SAME child to correct the value
   *  in its own labelled block instead of ending the run. */
  validate?: WorkflowAgentValidate;
}

/** Host observation, not review or task acceptance. Shaped outputs are deliberately excluded. */
export interface WorkflowAgentReportOptions extends Omit<
  WorkflowAgentOptions,
  "result" | "returnVia" | "output" | "repair"
> {
  result: "report";
  returnVia?: never;
  output?: never;
  repair?: never;
}

export type WorkflowAgentAnyOptions =
  | WorkflowAgentOptions
  | WorkflowAgentReportOptions
  | WorkflowAgentChoiceOptions
  | WorkflowAgentHandoffOptions
  | WorkflowAgentSchemaOptions;

export const FUSION_INVOCATION_RESERVATION = Symbol("fusion-invocation-reservation");
export const FUSION_REPLAY_REQUIRED = Symbol("fusion-replay-required");
export const FUSION_CAPABILITY_MODE = Symbol("fusion-capability-mode");
export const WORKFLOW_RETURN_CONTRACT = Symbol("workflow-return-contract");
/** Author cross-field rules for a shaped call. Deliberately NOT part of the canonical
 *  request: a function has no stable serialization, and the contract VERSION is what marks
 *  a replay boundary. */
export const WORKFLOW_RETURN_VALIDATE = Symbol("workflow-return-validate");

export type WorkflowInternalAgentOptions = WorkflowAgentAnyOptions & {
  [WORKFLOW_RETURN_CONTRACT]?: WorkflowReturnContract;
  [WORKFLOW_RETURN_VALIDATE]?: WorkflowReturnValidate;
  [FUSION_INVOCATION_RESERVATION]?: WorkflowInvocationReservation;
  [FUSION_REPLAY_REQUIRED]?: true;
  [FUSION_CAPABILITY_MODE]?: WorkflowFusionMode;
};

export function normalizeMaxToolCalls(maxToolCalls: number, field: string): number {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return maxToolCalls;
}

/**
 * A fuse of zero would abort before the child starts; that is a bug, not a bound.
 *
 * Length is NOT refused. A 48-hour deadline an operator chose is honoured as a
 * chain of representable waits (`scheduleLongTimeout`), so the former policy
 * ceiling — which existed only because a single `setTimeout` clamps — is gone.
 */
export function normalizeTimeoutMs(timeoutMs: number): number {
  assertRepresentableTimeoutMs(timeoutMs, "agent timeoutMs");
  return timeoutMs;
}

/** Refuse unrepresentable assistant-turn counts before spending on a child. */
export function normalizeMaxTurns(maxTurns: number): number {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new Error("agent maxTurns must be a positive safe integer");
  }
  return maxTurns;
}

/**
 * Default 1: a package-wide retry default is a budget decision nobody has taken yet.
 *
 * There is no upper bound any more. The former ceiling of three existed because the
 * deleted text-repair loop MULTIPLIED it (`attempts x SCHEMA_MAX_ATTEMPTS` children per
 * logical call); with one same-session acceptance path, an explicitly requested retry
 * count is one physical child each and the run's own invocation budget is what bounds it.
 */
export function normalizeAgentAttempts(attempts: number | undefined): number {
  if (attempts === undefined) return 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("agent attempts must be a positive safe integer");
  }
  return attempts;
}

/** Typed failure for one child execution. Public agent() callers receive text only;
 * runtime status and diagnostics remain available on this internal error and journal. */
export class WorkflowAgentExecutionError extends Error {
  readonly result: WorkflowAgentResult;

  constructor(result: WorkflowAgentResult) {
    super(result.summary);
    this.name = "WorkflowAgentExecutionError";
    this.result = result;
  }
}

/**
 * Thrown when a second agent call would occupy a `(phase, label)` slot that another call of
 * the same run is still executing. One slot is one live row and one journal correlation key,
 * so two concurrent occupants would collapse two branches into a single row. Sequential
 * re-entry of the same slot — a loop round, `r<N>` — is untouched: the slot is released when
 * the first call ends. A BRANCH-level failure by design: unlike the run cap and the run
 * deadline it does not bubble past a grouped context, because only this branch is refused.
 */
export class WorkflowAgentSlotConflictError extends Error {
  readonly phase: string | undefined;
  readonly label: string;
  constructor(phase: string | undefined, label: string) {
    super(
      `workflow agent slot is already running: phase ${phase === undefined ? "(none)" : `"${phase}"`}, label "${label}"; ` +
        "two concurrent calls sharing one (phase, label) would write one live row, so the second is refused before it starts",
    );
    this.name = "WorkflowAgentSlotConflictError";
    this.phase = phase;
    this.label = label;
  }
}

/**
 * The one sentence a shaped call gets when the TRANSPORT cannot carry a shaped result.
 *
 * The host refuses before it prompts the child (`agent-sdk-host.ts`: no
 * `setActiveToolsByName`, no tool readback, or the return tool was never registered), so
 * nothing is spent on work that could not be returned. There is deliberately no fallback:
 * the text transport that used to parse a structured value out of a final message is gone,
 * and silently reverting to it would be the hidden degradation this refusal exists to stop.
 */
export const WORKFLOW_SHAPED_TRANSPORT_REFUSAL =
  "Transport cannot carry a shaped result: this host did not accept a workflow_return receipt for the call. " +
  "Same-session acceptance needs a registered return tool plus tool-set readback, and there is no text fallback. " +
  "Use a plain agent(prompt) call on this transport, or run the shaped call on a host that supports it.";

/** Thrown instead of a generic execution failure when the refusal above is the cause, so a
 *  script or operator reads "this route cannot do shaped results", never "bad answer". */
export class WorkflowOutputCapabilityError extends Error {
  readonly result: WorkflowAgentResult;
  constructor(result: WorkflowAgentResult) {
    super(WORKFLOW_SHAPED_TRANSPORT_REFUSAL);
    this.name = "WorkflowOutputCapabilityError";
    this.result = result;
  }
}

/** The DSL's "declared shape not met" failure: the child completed and its ACCEPTED value
 *  still fails the contract when the boundary re-reads it. Carries the validator errors and
 *  the attempt count. A child RUN failure stays WorkflowAgentExecutionError; this error means
 *  the child ran and the value it submitted is not the value its consumer declared. */
export class SchemaValidationError extends Error {
  readonly errors: string[];
  readonly attempts: number;
  constructor(errors: string[], attempts: number) {
    super(`schema mismatch after ${attempts} attempt(s): ${errors.join("; ")}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
    this.attempts = attempts;
  }
}

/** Shape verdict for ONE child attempt of agent({schema}). */
export interface AgentSchemaCheck {
  validation: WorkflowSchemaValidation;
  /** Present only when `validation.status === "valid"`. */
  value?: unknown;
}

/** Result of ONE child execution: the exact child text plus, for a shaped call, its verdict. */
export interface AgentAttemptOutcome {
  text: string;
  callId: string;
  replayed: boolean;
  outputAcceptance?: AgentOutputAcceptance;
  schemaCheck?: AgentSchemaCheck;
}

/** What one PHYSICAL child execution hands back to its logical call. A failure is returned,
 *  not thrown, so the logical call can read its cause and decide whether it may repeat. */
export type PhysicalAgentAttempt =
  | { ok: true; text: string; outcome: AgentAttemptOutcome }
  | { ok: false; result: WorkflowAgentResult; callId: string; replayed: boolean };

export interface PhysicalAgentAttemptInput {
  /** The fully resolved request, minus the per-attempt `callId`. */
  req: WorkflowAgentRequest;
  permissionMode: PermissionMode;
  workspaceMode: WorkspaceMode;
  opts: WorkflowInternalAgentOptions | undefined;
  checkSchema?: (text: string) => AgentSchemaCheck;
  /** Present only when the logical call was served from a record; no child then runs. */
  replayedText?: string;
  /** 1-based position of this physical attempt, and the bound it was drawn from. */
  attempt: number;
  attempts: number;
  /** Stable identity of the ONE logical call every attempt here belongs to. */
  logicalCallId: string;
}

/**
 * Stable slot descriptor `(phase, label)` for a workflow agent (REQ-009, D-006). A loop
 * that re-invokes `agent()` with the same (phase,label) resolves to the same slot, so its
 * rounds anchor to one live row / one journal correlation key. Pure and host-agnostic; the
 * bridge (live row) and the runtime (agent_start journal line) both derive it from here so
 * they never drift. The `` unit separator keeps phase/label unambiguous.
 */
export function workflowSlotKey(input: { phase?: string | undefined; label?: string | undefined }): string {
  return `${input.phase ?? ""}${input.label ?? ""}`;
}

// The two request fields a callsite never gets to decide for itself, resolved from the
// declared options: workflow children always inherit the parent permission mode, and the
// workspace intent is read from `workspaceMode` or its deprecated `sandbox` alias. They sit
// beside the request they resolve INTO, so the translation has one definition.
export function defaultWorkflowPermissionMode(): PermissionMode {
  return "inherit-parent";
}

function workspaceModeFromSandbox(sandbox: WorkflowAgentOptions["sandbox"]): WorkspaceMode {
  return sandbox === "workspace-write" ? "worktree" : "project";
}

export function defaultWorkflowWorkspaceMode(opts: WorkflowAgentAnyOptions | undefined): WorkspaceMode {
  if (opts?.workspaceMode !== undefined) return opts.workspaceMode;
  if (opts?.sandbox !== undefined) return workspaceModeFromSandbox(opts.sandbox);
  return "project";
}

// Pure naming and display projections over one request: the artifact slug a call's answer
// is filed under when the author declared none, and the live-row split of a "provider/id"
// selector into the model and the reasoning effort it asked for. They sit beside
// `workflowSlotKey` and `workflowAgentDisplayName` — every name a reader sees for a call is
// derived in one place.
export function defaultArtifactName(label: string, callId: string): string {
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return safe === "" ? `${callId}-answer` : safe;
}

export function liveModelFromSelector(selector: string | undefined): { model: string; thinking?: string } | undefined {
  if (selector === undefined) return undefined;
  const trimmed = selector.trim();
  if (!trimmed.includes("/")) return undefined;
  const colon = trimmed.lastIndexOf(":");
  if (colon > -1) {
    const suffix = trimmed.slice(colon + 1);
    if (isThinkingSuffix(suffix)) return { model: trimmed.slice(0, colon), thinking: suffix };
  }
  return { model: trimmed };
}

export function isThinkingSuffix(value: string): boolean {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "thinking"
  );
}

type WorkflowExecutionIdentity = { executionMode: "bare"; agent?: never } | { executionMode: "named"; agent: string };

export function workflowExecutionIdentity(req: WorkflowAgentRequest): WorkflowExecutionIdentity {
  const mode = req.executionMode ?? (req.agent === undefined ? "bare" : "named");
  if (mode === "bare") return { executionMode: "bare" };
  if (req.agent === undefined || req.agent.trim() === "") {
    throw new Error("named workflow execution requires a non-empty agent name");
  }
  return { executionMode: "named", agent: req.agent };
}

export function workflowAgentDisplayName(req: WorkflowAgentRequest): string {
  return (req.executionMode ?? (req.agent === undefined ? "bare" : "named")) === "named"
    ? (req.agent ?? "named-agent")
    : "sub-agent";
}
