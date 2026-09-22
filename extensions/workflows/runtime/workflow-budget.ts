/**
 * workflow-budget.ts — ONE place that says what a workflow run is allowed to
 * spend, on every axis the host can actually enforce.
 *
 * The approved defaults are concurrency=4 (queueing width), plus totalAgents=10_000
 * for headless root launches. All other stop axes require an explicit declaration.
 * The applied values, including `unbounded`, are printed in the header, journal
 * and result. Policy: docs/workflows/budgets.md#run-budget.
 *
 * Pure data and pure functions. No fs / process / network; no import of the
 * runtime, so the runtime can import this without a cycle.
 *
 * What this module is NOT: an enforcement point. It declares the axes and the
 * override arithmetic; `workflow-runner.ts` applies them to a run and
 * `workflow-runtime.ts` enforces them before each spend.
 */

import { NODE_TIMER_MAX_DELAY_MS, assertRepresentableDelayMs } from "../../_shared/runtime/long-timer.js";

export { NODE_TIMER_MAX_DELAY_MS };

/**
 * The six axes a workflow run is bounded on.
 *
 * One is a queueing width (`concurrency`), two more are run-level (`totalAgents`,
 * `runtimeMs`) and three are per-call (`timeoutMs`, `toolCalls`, `turns`). Every
 * one of them bounds SPEND — time, work, fan-out — and none of them judges an
 * answer.
 *
 * In a resolved budget, optional axes left `undefined` mean UNBOUNDED: no timer
 * is armed, no counter refuses a child, and the axis prints as `unbounded`.
 *
 * `answerChars` was the seventh and is deliberately gone: it refused a completed
 * child's answer for its length, which is a size policy over a result already paid
 * for rather than a budget over what a run may spend. A consumer that genuinely
 * needs a bounded value declares it as a contract (`output.maxLength`, a schema
 * `maxLength`/`maxItems`), where the child is told and can correct it in-session.
 *
 * Tokens and cost are absent for a different reason: the host reports no price, so
 * a limit over them would be a gate that reports "under budget" forever. Observed
 * token usage is recorded; cost is reported as unknown rather than as zero.
 */
export interface WorkflowBudget {
  /** Global simultaneous leaf-agent executions across the whole run. Queues, never refuses. */
  concurrency: number;
  /** Total FRESH `agent()` invocations one run may make, or unbounded when unset. */
  totalAgents?: number;
  /** Wall clock over the agent chain, in milliseconds. Checked before a child starts. */
  runtimeMs?: number;
  /** Wall-clock fuse for ONE child attempt, in milliseconds. */
  timeoutMs?: number;
  /** Tool calls one child attempt may start. */
  toolCalls?: number;
  /** Assistant turns one child attempt may take. */
  turns?: number;
}

/** One run-wide queueing width; local groups only narrow it when explicitly asked. */
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
/** Finite fresh-child allowance for print/json root runs, shared by saved children. */
export const DEFAULT_HEADLESS_WORKFLOW_TOTAL_AGENTS = 10_000;

/** Every axis name, in the order the header, the journal and the run report print them. */
export const WORKFLOW_BUDGET_AXES: readonly (keyof WorkflowBudget)[] = Object.freeze([
  "concurrency",
  "totalAgents",
  "runtimeMs",
  "timeoutMs",
  "toolCalls",
  "turns",
] as const);

/** The literal an undeclared axis prints as. One word, everywhere, so an operator
 *  scanning a headless log cannot mistake absence for a number they did not read. */
export const WORKFLOW_BUDGET_UNBOUNDED = "unbounded";

/** Representable assistant-turn counts; wall-clock timers have their own bounds. */
export const WORKFLOW_AGENT_MAX_TURNS = Number.MAX_SAFE_INTEGER;

/**
 * Refuse a deadline no clock could honour, before the child it would bound starts.
 *
 * There is no policy ceiling here any more. A span longer than Node's maximum
 * delay is run as a CHAIN of representable waits (`scheduleLongTimeout`), so an
 * operator who asks for 48 hours gets 48 hours instead of the former refusal — and
 * never the one-millisecond clamp that refusal existed to prevent.
 */
export function assertRepresentableTimeoutMs(timeoutMs: number, field = "timeoutMs"): void {
  // A fuse of zero is not a tight budget, it is a bug that aborts before the child
  // starts; one message covers both that and an uncountable value.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  assertRepresentableDelayMs(timeoutMs, field);
}

/** One axis a caller asked to raise above the value that would otherwise apply. */
export interface WorkflowBudgetRaise {
  axis: keyof WorkflowBudget;
  /** The value that would have applied — only an axis with a package or run-level
   *  value can be raised; an unbounded axis cannot, because narrowing is all an
   *  explicit value on it can do. */
  applied: number;
  /** What the caller asked for. */
  requested: number;
}

export interface ResolvedWorkflowBudget {
  budget: WorkflowBudget;
  /** Empty when every supplied value narrowed or matched. Never silent otherwise. */
  raises: WorkflowBudgetRaise[];
}

/**
 * Build the budget one run applies from what its launch declared.
 *
 * Headless is host mode, independent of noOperator or UI availability. A saved
 * child inherits its root's resolved budget rather than resolving defaults again.
 * Explicit numbers replace defaults; increases are returned for journaling.
 *
 * `undefined` on an axis means "unstated", which is not the same as a value: an
 * explicit invalid value is refused rather than ignored. The same rule reaches the
 * key set: the object is closed over the axes, so a typo or a removed option is
 * named rather than quietly dropped.
 */
export function resolveWorkflowBudget(override?: Partial<WorkflowBudget>, headless = false): ResolvedWorkflowBudget {
  const budget: WorkflowBudget = {
    concurrency: DEFAULT_WORKFLOW_CONCURRENCY,
    ...(headless ? { totalAgents: DEFAULT_HEADLESS_WORKFLOW_TOTAL_AGENTS } : {}),
  };
  const raises: WorkflowBudgetRaise[] = [];
  if (override === undefined) return { budget, raises };
  assertClosedWorkflowBudgetKeys(override);
  for (const axis of WORKFLOW_BUDGET_AXES) {
    const requested = override[axis];
    if (requested === undefined) continue;
    assertWorkflowBudgetValue(axis, requested);
    const applied = budget[axis];
    if (applied !== undefined && requested > applied) raises.push({ axis, applied, requested });
    budget[axis] = requested;
  }
  return { budget, raises };
}

/**
 * Options this object REPLACED, mapped to the axis that now carries them.
 *
 * `RunWorkflowScriptOptions.maxTotalAgentInvocations` became `budget.totalAgents`.
 * TypeScript catches the old spelling on an object literal, but an embedder in
 * plain JS — or one whose value passed through a widened variable — would have
 * had its explicit bound dropped on the floor. A removed option that still reads
 * as configuration is worse than a missing one, so it is named at the boundary.
 */
const REMOVED_WORKFLOW_BUDGET_KEYS: Readonly<Record<string, keyof WorkflowBudget | null>> = Object.freeze({
  maxTotalAgentInvocations: "totalAgents",
  // Removed outright rather than renamed: there is no replacement AXIS, because the
  // runtime no longer refuses an answer for its size. Named here so an override that
  // still sets it hears why instead of having it silently dropped.
  answerChars: null,
});

/**
 * The override is a CLOSED six-key object. An unrecognised key with a real
 * value is a bound its author believed was applied; ignoring it is the silent
 * fallback `resolveWorkflowBudget` exists to refuse, and it would be invisible
 * in the journal because a bound that was never read cannot be reported.
 *
 * An unknown key whose value is `undefined` asks for nothing, so it is allowed —
 * the same "unstated is not a value" rule the axes themselves follow, and it
 * keeps a spread-built override from failing over a key nobody set.
 */
/**
 * The named sentence a REMOVED budget key earns, or `undefined` when the key was
 * never an axis of this budget at all.
 *
 * Exported because the schema in front of the `workflow` tool is a second door
 * into the same object, and a closed-property schema answers `answerChars` with
 * "unexpected property" — a shape complaint that tells its reader nothing about
 * why the option is gone or what to declare instead. The tool consults this table
 * before validating so both doors give the same answer.
 */
export function removedWorkflowBudgetKeyMessage(key: string): string | undefined {
  if (!Object.hasOwn(REMOVED_WORKFLOW_BUDGET_KEYS, key)) return undefined;
  const replacement = REMOVED_WORKFLOW_BUDGET_KEYS[key];
  return replacement === null
    ? `workflow budget axis ${key} was removed: a workflow run no longer bounds the SIZE of an answer. ` +
        "Declare a consumer contract on the call instead (output.maxLength, or maxLength/maxItems inside a schema)"
    : `workflow budget option ${key} was removed; use budget.${replacement} instead`;
}

function assertClosedWorkflowBudgetKeys(override: Partial<WorkflowBudget>): void {
  const axes = new Set<string>(WORKFLOW_BUDGET_AXES);
  for (const [key, value] of Object.entries(override)) {
    if (axes.has(key) || value === undefined) continue;
    const removed = removedWorkflowBudgetKeyMessage(key);
    if (removed === undefined)
      throw new Error(`workflow budget has no axis ${key}; the axes are ${WORKFLOW_BUDGET_AXES.join(", ")}`);
    throw new Error(removed);
  }
}

/**
 * Fail closed on a value that could never bound a real run. A zero or negative
 * axis is not a tight budget, it is a bug that would refuse the first child; a
 * fractional one would compare unpredictably against integer counters.
 *
 * Length is no longer a reason to refuse a timeout: an explicit long deadline is
 * run as a chain of representable waits rather than clamped or rejected.
 */
export function assertWorkflowBudgetValue(axis: keyof WorkflowBudget, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`workflow budget ${axis} must be a positive safe integer`);
  }
}

/** One axis as an operator reads it: the declared value, or the word that says
 *  nothing was declared and nothing will stop this run on that axis. */
export function formatWorkflowBudgetAxis(budget: WorkflowBudget, axis: keyof WorkflowBudget): string {
  const value = budget[axis];
  return value === undefined ? WORKFLOW_BUDGET_UNBOUNDED : String(value);
}

/**
 * The one header line a run emits before any workflow code runs. It lists ALL six
 * axes, including the ones nobody declared, because that line is the only place a
 * launch states which stops apply and which axes remain unbounded. It is a
 * `log` line rather than a new journal kind on purpose: a new kind would touch
 * every journal reader for a string.
 */
export function formatWorkflowBudgetPrelude(budget: WorkflowBudget): string {
  const fields = WORKFLOW_BUDGET_AXES.map((axis) => `${axis}=${formatWorkflowBudgetAxis(budget, axis)}`).join(" ");
  return `[workflow:budget] applied ${fields}`;
}

/** The line one raise emits. Names the axis, the value that would have applied,
 *  and what was asked for, so the raise is auditable from the journal alone. */
export function formatWorkflowBudgetRaise(raise: WorkflowBudgetRaise, scope: "run" | "call"): string {
  return (
    `[workflow:budget] ${scope} raised ${raise.axis} above the applied default: ` +
    `default=${String(raise.applied)} requested=${String(raise.requested)}`
  );
}

/**
 * The applied budget as a machine envelope: every axis present, an undeclared one
 * carrying the same word an operator reads in the header.
 *
 * `result.json` is what a later reader (a resume, a report, another tool) uses to
 * learn what this run was allowed to spend. Omitting the unbounded axes there would
 * make "nobody declared it" indistinguishable from "this envelope predates the
 * field", which is exactly the ambiguity the printed word removes.
 */
export function workflowBudgetEnvelope(
  budget: WorkflowBudget,
): Record<keyof WorkflowBudget, number | typeof WORKFLOW_BUDGET_UNBOUNDED> {
  const envelope = {} as Record<keyof WorkflowBudget, number | typeof WORKFLOW_BUDGET_UNBOUNDED>;
  for (const axis of WORKFLOW_BUDGET_AXES) envelope[axis] = budget[axis] ?? WORKFLOW_BUDGET_UNBOUNDED;
  return envelope;
}

/**
 * The line an applied budget emits when it actually stops a run.
 *
 * The wording is the decision, not decoration. A budget stop means the operator's
 * applied limit was reached; it says nothing about whether the work so far was any
 * good, and every answer already received stays stored and readable. Calling it a
 * failed or invalid answer would destroy that distinction, so the journal never
 * does.
 */
export function formatWorkflowBudgetStop(axis: keyof WorkflowBudget, detail: string): string {
  return `[workflow:budget] stopped by budget ${axis}: ${detail}. Data received so far is kept.`;
}
