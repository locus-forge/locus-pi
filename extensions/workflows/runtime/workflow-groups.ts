/**
 * workflow-groups.ts — `parallel()` / `pipeline()`: branch identity, the per-group
 * scheduler, the fail-closed barrier, and the typed partial result a barrier raises.
 *
 * The scheduler here bounds width PER group operation. It is NOT the run's leaf-agent
 * gate — that one lives in `workflow-execution-state.ts` and bounds simultaneously
 * executing children across the whole run. Both bounds exist on purpose: a nested
 * `dsl.agent()` inside a `parallel()` wrapper takes a leaf permit, while its wrapper
 * holds only a slot in this group's own pool, so a group never waits on itself.
 *
 * Branch identity — phase, member path, business keys, row occurrence — travels in an
 * `AsyncLocalStorage`, so a branch-local `phase()` never leaks into a sibling or the
 * parent. The DSL core reads that context READ-ONLY when it builds an agent request.
 *
 * Pure host-agnostic execution, no fs / process / network: part of the DSL core's
 * `node:fs`-free value closure that rule 7 of `scripts/check-extension-layers.ts` proves.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "./workflow-schema.js";
import { classifyWorkflowReturnedFailure, prepareWorkflowResult } from "./workflow-outcome.js";
import { isRunLevelWorkflowFailure, type WorkflowSharedExecutionState } from "./workflow-execution-state.js";
import type { WorkflowJournalLine } from "./workflow-journal-format.js";

/** Which live row and journal correlation key a grouped agent call occupies. */
export interface WorkflowAgentRowOccurrence {
  readonly groupId: string;
  readonly memberIndex: number;
}

export const WORKFLOW_GROUP_FAILURE = "WORKFLOW_GROUP_FAILURE" as const;

export type WorkflowStage<T> = (item: T, index: number) => Promise<unknown>;

export type WorkflowGroupKind = "parallel" | "pipeline";

/** Bounds branch wrappers, never the global leaf-agent gate. Keys are declared before any branch starts. */
export interface WorkflowParallelOptions {
  concurrency?: number;
  title?: string;
  keys?: readonly string[];
}

interface WorkflowGroupContext {
  readonly group: { id: string; kind: WorkflowGroupKind; label: string };
  readonly member?: WorkflowAgentRowOccurrence;
  /** Branch-local phase changes never leak into sibling branches or their parent. */
  phase: string | undefined;
  readonly memberPath: readonly string[];
  readonly hasBusinessKeys: boolean;
}

export interface WorkflowBranchFailure {
  index: number;
  kind: "thrown" | "returned-failure";
  message: string;
  stageIndex?: number;
  status?: string;
}

export type WorkflowGroupSlot<T> =
  | { index: number; status: "completed"; value: T }
  | { index: number; status: "failed"; failure: WorkflowBranchFailure; value?: T };

export type WorkflowGroupEnvelopeSlot =
  { index: number; status: "completed" } | { index: number; status: "failed"; failure: WorkflowBranchFailure };

/** JSON-safe run/result projection for an unhandled group failure. */
export interface WorkflowGroupFailureEnvelope {
  ok: false;
  kind: "workflow_group_failure";
  code: typeof WORKFLOW_GROUP_FAILURE;
  groupKind: WorkflowGroupKind;
  groupId: string;
  total: number;
  completed: number;
  failed: number;
  slots: WorkflowGroupEnvelopeSlot[];
  failures: WorkflowBranchFailure[];
}

/**
 * Fail-closed barrier result for thrown or explicitly failed branches.
 *
 * Successful siblings finish. `slots` is the unambiguous in-memory truth;
 * `partialResults` is a convenience view where thrown positions are null while
 * returned failed values remain inspectable. A script must catch this stable
 * typed error explicitly to accept a deliberate partial outcome.
 */
export class WorkflowGroupFailureError<T = unknown> extends Error {
  readonly code = WORKFLOW_GROUP_FAILURE;
  readonly groupKind: WorkflowGroupKind;
  readonly groupId: string;
  readonly slots: Array<WorkflowGroupSlot<T>>;
  readonly partialResults: Array<T | null>;
  readonly failures: WorkflowBranchFailure[];
  readonly total: number;
  readonly completed: number;
  readonly failed: number;

  constructor(groupKind: WorkflowGroupKind, groupId: string, slots: Array<WorkflowGroupSlot<T>>) {
    const failures = slots
      .filter((slot): slot is Extract<WorkflowGroupSlot<T>, { status: "failed" }> => slot.status === "failed")
      .map((slot) => slot.failure);
    const total = slots.length;
    const failed = failures.length;
    const preview = failures
      .slice(0, 3)
      .map(
        (failure) =>
          `branch ${failure.index}${failure.stageIndex === undefined ? "" : ` stage ${failure.stageIndex}`}: ${failure.message}`,
      )
      .join("; ");
    const suffix = failures.length > 3 ? `; +${failures.length - 3} more` : "";
    super(`${groupKind} failed in ${failed}/${total} branch(es): ${preview}${suffix}`);
    this.name = "WorkflowGroupFailureError";
    this.groupKind = groupKind;
    this.groupId = groupId;
    this.slots = slots.map((slot) =>
      slot.status === "completed" ? { ...slot } : { ...slot, failure: { ...slot.failure } },
    );
    this.partialResults = this.slots.map((slot) => {
      if (slot.status === "completed") return slot.value;
      return Object.prototype.hasOwnProperty.call(slot, "value") ? (slot.value ?? null) : null;
    });
    this.failures = failures.map((failure) => ({ ...failure }));
    this.total = total;
    this.completed = Math.max(0, total - failed);
    this.failed = failed;
  }

  toEnvelope(): WorkflowGroupFailureEnvelope {
    return {
      ok: false,
      kind: "workflow_group_failure",
      code: this.code,
      groupKind: this.groupKind,
      groupId: this.groupId,
      total: this.total,
      completed: this.completed,
      failed: this.failed,
      slots: this.slots.map((slot) =>
        slot.status === "completed"
          ? { index: slot.index, status: "completed" }
          : { index: slot.index, status: "failed", failure: { ...slot.failure } },
      ),
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }
}

export function workflowGroupFailureEnvelope(value: unknown): WorkflowGroupFailureEnvelope | undefined {
  return value instanceof WorkflowGroupFailureError ? value.toEnvelope() : undefined;
}

class CapturedWorkflowBranchFailure<T = unknown> extends Error {
  constructor(
    readonly value: T,
    readonly failure: WorkflowBranchFailure,
  ) {
    super(failure.message);
    this.name = "CapturedWorkflowBranchFailure";
  }
}

// ---------------------------------------------------------------------------
// THE single concurrency seam
// ---------------------------------------------------------------------------

/**
 * THE single concurrency seam for the whole runtime. Every agent execution —
 * agent(), parallel(), pipeline() — funnels through here.
 *
 * Bounded per-call concurrency seam. Real concurrency with git-worktree
 * isolation for parallel writes can be dropped in HERE without touching any
 * workflow script.
 *
 * `width` is REQUIRED and has no local default. It used to have a private
 * `SCHEDULER_WIDTH = 4` that nobody could see, sitting beside a `budget.concurrency`
 * of 4 that meant the same thing: two constants, one meaning, and an operator who
 * narrowed the visible one still got groups of four. The run's single effective
 * concurrency is the only width now, and a local one exists only when a
 * `parallel()`/`pipeline()` author passes it explicitly.
 *
 * // TODO(concurrency): add git-worktree isolation. Keep this signature stable.
 */
export async function runScheduled<T>(thunks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(thunks.length);
  let next = 0;
  const workerCount = Math.min(width, thunks.length);
  // This bounds width PER runScheduled call, not globally.
  // Nested orchestration wrappers create their OWN pool, so nested dsl.agent()
  // inside a parallel() wrapper does NOT deadlock against leaf agent slots.
  // Global leaf-agent concurrency is enforced separately by AgentConcurrencyGate.
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      out[i] = await thunks[i]!();
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

/**
 * A display name and a `parallel` key have to be a name: non-blank, and free of control
 * characters that would corrupt a journal line, a terminal row or a path component.
 *
 * The former 240-character ceiling is gone. A key is part of branch IDENTITY and enters the
 * replay key, so control characters are REFUSED rather than encoded — encoding them would
 * silently rewrite the identity of already-recorded branches — but length was never an
 * identity property, and a title long enough to be awkward is a display problem the renderer
 * already solves by clipping what it draws.
 */
export function assertWorkflowDisplayTitle(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} must be non-blank text without control characters`);
  }
}

function normalizeWorkflowParallelOptions(
  value: WorkflowParallelOptions | undefined,
  count: number,
): WorkflowParallelOptions {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => !["concurrency", "title", "keys"].includes(key))) {
    throw new Error("parallel options accept only concurrency, title, and keys");
  }
  if (
    value.concurrency !== undefined &&
    (typeof value.concurrency !== "number" || !Number.isSafeInteger(value.concurrency) || value.concurrency < 1)
  ) {
    throw new Error("parallel concurrency must be a positive safe integer");
  }
  if (value.title !== undefined) assertWorkflowDisplayTitle(value.title, "parallel title");
  if (value.keys !== undefined) {
    if (!Array.isArray(value.keys) || value.keys.length !== count)
      throw new Error("parallel keys must name every branch exactly once");
    for (const key of value.keys) assertWorkflowDisplayTitle(key, "parallel key");
    if (new Set(value.keys).size !== value.keys.length)
      throw new Error("parallel keys must be unique within the group");
  }
  return { ...value, ...(value.keys === undefined ? {} : { keys: [...value.keys] }) };
}

function classifyReturnedGroupFailure(
  value: unknown,
  index: number,
  stageIndex?: number,
): WorkflowBranchFailure | undefined {
  const prepared = prepareWorkflowResult(value);
  if (prepared.diagnostic !== undefined) {
    return {
      index,
      kind: "returned-failure",
      message: workflowErrorMessage(prepared.diagnostic.message),
      ...(stageIndex !== undefined ? { stageIndex } : {}),
    };
  }
  const returnedFailure = classifyWorkflowReturnedFailure(prepared.value);
  if (returnedFailure === undefined) return undefined;
  const record = isRecord(value) ? value : {};
  const firstDiagnostic = Array.isArray(record.diagnostics)
    ? record.diagnostics.find((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : undefined;
  const fallback =
    returnedFailure.status !== undefined
      ? `branch returned status=${returnedFailure.status}`
      : returnedFailure.kind === "partial"
        ? "branch returned partial:true"
        : "branch returned ok:false";
  const message = workflowErrorMessage(returnedFailure.summary ?? firstDiagnostic ?? fallback);
  return {
    index,
    kind: "returned-failure",
    message,
    ...(stageIndex !== undefined ? { stageIndex } : {}),
    ...(returnedFailure.status !== undefined ? { status: returnedFailure.status } : {}),
  };
}

function workflowErrorMessage(value: unknown): string {
  try {
    const raw = value instanceof Error ? value.message : String(value);
    const compact = raw.replace(/\s+/gu, " ").trim();
    return compact === "" ? "unknown branch failure" : compact.slice(0, 240);
  } catch {
    return "unknown branch failure";
  }
}

/** Everything the group machinery needs from the run it belongs to. The edge is one-way:
 *  nothing here imports the DSL core back. */
export interface WorkflowGroupExecutionDeps {
  readonly runId: string;
  readonly now: () => string;
  /** The runtime's one journal fan-out (mirror + sink + progress callback). */
  readonly emit: (line: WorkflowJournalLine) => void;
  /** The run's ONE leaf-agent width, used as the default group width. */
  readonly sharedExecution: WorkflowSharedExecutionState;
  /** Run-level phase, read and written only when no branch context is active. */
  readonly rootPhase: () => string | undefined;
  readonly setRootPhase: (name: string) => void;
}

/** The read-only branch view an agent call gets. Deliberately narrower than the stored
 *  context: a call may read its identity, never rewrite a sibling's phase. */
export interface WorkflowGroupBranchView {
  readonly member?: WorkflowAgentRowOccurrence;
  readonly memberPath: readonly string[];
  readonly hasBusinessKeys: boolean;
}

export interface WorkflowGroupExecution {
  parallel<T>(thunks: Array<() => Promise<T>>, input?: WorkflowParallelOptions): Promise<T[]>;
  pipeline<T>(items: readonly T[], ...stages: Array<WorkflowStage<unknown>>): Promise<unknown[]>;
  /** Branch phase when a branch is running, run phase otherwise. */
  currentPhase(): string | undefined;
  /** Records a branch-local phase and answers whether a branch owned it; `false` means
   *  the caller's run-level phase is the one that changed. */
  setBranchPhase(name: string): boolean;
  /** Group correlation fields for any journal line emitted inside a group. */
  activeGroupFields(): Pick<WorkflowJournalLine, "groupId" | "groupKind" | "groupLabel">;
  /** Read-only branch identity for the agent call path. */
  branchContext(): WorkflowGroupBranchView | undefined;
}

export function createWorkflowGroupExecution(deps: WorkflowGroupExecutionDeps): WorkflowGroupExecution {
  const { runId, sharedExecution } = deps;
  const nowFn = deps.now;
  const emit = deps.emit;
  let groupCounter = 0;
  const groupContext = new AsyncLocalStorage<WorkflowGroupContext>();

  const currentPhase = (): string | undefined => {
    const context = groupContext.getStore();
    return context === undefined ? deps.rootPhase() : context.phase;
  };

  function setBranchPhase(name: string): boolean {
    const context = groupContext.getStore();
    if (context === undefined) {
      deps.setRootPhase(name);
      return false;
    }
    context.phase = name;
    return true;
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>, input?: WorkflowParallelOptions): Promise<T[]> {
    const groupOptions = normalizeWorkflowParallelOptions(input, thunks.length);
    return runGrouped(
      "parallel",
      thunks.length,
      () => runGroupBranches("parallel", thunks, groupOptions),
      groupOptions,
    );
  }

  async function pipeline<T>(items: readonly T[], ...stages: Array<WorkflowStage<unknown>>): Promise<unknown[]> {
    const itemThunks: Array<() => Promise<unknown>> = items.map((_item, itemIndex) => {
      const item = _item;
      return async () => {
        let acc: unknown = item;
        for (const [_si, stage] of stages.entries()) {
          const si = _si;
          try {
            const next = await stage(acc, itemIndex * stages.length + si);
            const returnedFailure = classifyReturnedGroupFailure(next, itemIndex, si);
            if (returnedFailure !== undefined) {
              throw new CapturedWorkflowBranchFailure(next, returnedFailure);
            }
            acc = next;
          } catch (err) {
            if (isRunLevelWorkflowFailure(err) || err instanceof CapturedWorkflowBranchFailure) throw err;
            throw new CapturedWorkflowBranchFailure(undefined, {
              index: itemIndex,
              stageIndex: si,
              kind: "thrown",
              message: workflowErrorMessage(err),
            });
          }
        }
        return acc;
      };
    });
    return runGrouped("pipeline", itemThunks.length, () => runGroupBranches("pipeline", itemThunks));
  }

  async function runGroupBranches<T>(
    kind: WorkflowGroupKind,
    thunks: Array<() => Promise<T>>,
    groupOptions?: WorkflowParallelOptions,
  ): Promise<T[]> {
    const groupId = groupContext.getStore()!.group.id;
    const wrapped: Array<() => Promise<WorkflowGroupSlot<T>>> = thunks.map((thunk, index) => async () => {
      const currentContext = groupContext.getStore();
      const memberContext: WorkflowGroupContext = {
        group: currentContext!.group,
        member: { groupId, memberIndex: index },
        phase: currentPhase(),
        memberPath: [...currentContext!.memberPath, groupOptions?.keys?.[index] ?? `#${index}`],
        hasBusinessKeys: currentContext!.hasBusinessKeys || groupOptions?.keys !== undefined,
      };
      try {
        const value = await groupContext.run(memberContext, thunk);
        const returnedFailure = classifyReturnedGroupFailure(value, index);
        if (returnedFailure === undefined) return { index, status: "completed", value };
        emitGroupBranchFailure(returnedFailure);
        return { index, status: "failed", value, failure: returnedFailure };
      } catch (err) {
        // The invocation cap and the run deadline are hard RUN-level failures and
        // keep their own public error types instead of being converted into a
        // partial group: a bound on the whole run is not one branch's problem.
        if (isRunLevelWorkflowFailure(err)) throw err;
        const failure =
          err instanceof CapturedWorkflowBranchFailure
            ? err.failure
            : { index, kind: "thrown" as const, message: workflowErrorMessage(err) };
        emitGroupBranchFailure(failure);
        return {
          index,
          status: "failed",
          ...(err instanceof CapturedWorkflowBranchFailure && err.failure.kind === "returned-failure"
            ? { value: err.value as T }
            : {}),
          failure,
        };
      }
    });
    // The run's ONE effective concurrency, unless this group's author narrowed it
    // explicitly. There is no second hidden package width any more.
    const slots = await runScheduled(wrapped, groupOptions?.concurrency ?? sharedExecution.concurrency);
    if (slots.some((slot) => slot.status === "failed")) {
      throw new WorkflowGroupFailureError(kind, groupId, slots);
    }
    return slots.map((slot) => (slot as Extract<WorkflowGroupSlot<T>, { status: "completed" }>).value);
  }

  function emitGroupBranchFailure(failure: WorkflowBranchFailure): void {
    emit({
      ts: nowFn(),
      runId,
      kind: "error",
      message: failure.message,
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
      ...activeGroupFields(),
    });
  }

  async function runGrouped<T extends unknown[]>(
    kind: "parallel" | "pipeline",
    total: number,
    run: () => Promise<T>,
    groupOptions?: WorkflowParallelOptions,
  ): Promise<T> {
    const id = `${kind}-${++groupCounter}`;
    const label = groupOptions?.title ?? `${kind} ${total}`;
    const parentContext = groupContext.getStore();
    emit({
      ts: nowFn(),
      runId,
      kind: "group_start",
      groupId: id,
      groupKind: kind,
      groupLabel: label,
      groupTotal: total,
      ...(groupOptions?.keys === undefined ? {} : { groupKeys: [...groupOptions.keys] }),
      ...(parentContext === undefined ? {} : { parentGroupId: parentContext.group.id }),
      ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
    });
    const currentContext: WorkflowGroupContext = {
      group: { id, kind, label },
      phase: currentPhase(),
      memberPath: parentContext?.memberPath ?? [],
      hasBusinessKeys: parentContext?.hasBusinessKeys ?? false,
      ...(parentContext?.member === undefined ? {} : { member: parentContext.member }),
    };
    return groupContext.run(currentContext, async () => {
      const start = Date.now();
      try {
        const results = await run();
        emit({
          ts: nowFn(),
          runId,
          kind: "group_end",
          status: "completed",
          groupId: id,
          groupKind: kind,
          groupLabel: label,
          groupTotal: total,
          groupCompleted: total,
          groupFailed: 0,
          ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
          durationMs: Date.now() - start,
        });
        return results;
      } catch (err) {
        const groupFailure = err instanceof WorkflowGroupFailureError ? err : undefined;
        emit({
          ts: nowFn(),
          runId,
          kind: "group_end",
          status: "failed",
          groupId: id,
          groupKind: kind,
          groupLabel: label,
          groupTotal: total,
          groupCompleted: groupFailure?.completed ?? 0,
          groupFailed: groupFailure?.failed ?? total,
          ...(currentPhase() !== undefined ? { phase: currentPhase()! } : {}),
          message: workflowErrorMessage(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    });
  }

  function activeGroupFields(): Pick<WorkflowJournalLine, "groupId" | "groupKind" | "groupLabel"> {
    const group = groupContext.getStore()?.group;
    if (group === undefined) return {};
    return { groupId: group.id, groupKind: group.kind, groupLabel: group.label };
  }

  return {
    parallel,
    pipeline,
    currentPhase,
    setBranchPhase,
    activeGroupFields,
    branchContext: () => groupContext.getStore(),
  };
}
