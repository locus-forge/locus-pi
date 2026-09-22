/**
 * Process-global owner for slash- and tool-launched workflow lifetimes.
 *
 * Pi reloads extension modules between session generations while work started
 * by an old command callback may still be settling. This registry keeps every
 * detached terminal promise observed and gives callers a generation lease for
 * rejecting stale UI or transcript writes.
 */

const WORKFLOW_BACKGROUND_RUN_REGISTRY_SYMBOL = Symbol.for("locus-pi.workflow-background-runs.v1");
const SETTLED_RUN_LIMIT = 40;

export interface WorkflowSessionLease {
  projectRoot: string;
  sessionId: string;
  generation: number;
}

export type WorkflowBackgroundRunState = "running" | "stopping" | "settled";

export type WorkflowBackgroundRunSettlement<T = unknown> =
  { status: "fulfilled"; value: T } | { status: "rejected"; error: unknown };

export interface WorkflowBackgroundRunSnapshot<T = unknown> {
  launchId: string;
  runId?: string;
  state: WorkflowBackgroundRunState;
  stopRequested: boolean;
  terminal: Promise<WorkflowBackgroundRunSettlement<T>>;
  settlement?: WorkflowBackgroundRunSettlement<T>;
}

export interface WorkflowBackgroundRunContext {
  signal: AbortSignal;
  setRunId(runId: string): void;
  isCurrent(): boolean;
}

export type WorkflowBackgroundLaunchResult<T> =
  | { ok: true; run: WorkflowBackgroundRunSnapshot<T> }
  | { ok: false; reason: "stale-lease" | "active-run"; active?: WorkflowBackgroundRunSnapshot<unknown> };

export type WorkflowBackgroundStopResult =
  | { status: "requested" | "already-requested"; run: WorkflowBackgroundRunSnapshot<unknown> }
  | { status: "settled"; run: WorkflowBackgroundRunSnapshot<unknown> }
  | { status: "unknown" };

interface WorkflowBackgroundRunRecord<T = unknown> {
  launchId: string;
  lease: WorkflowSessionLease;
  controller: AbortController;
  state: WorkflowBackgroundRunState;
  stopRequested: boolean;
  /** Only slash-command runs reserve the one interactive command slot. */
  exclusive?: boolean;
  startedOrder: number;
  runId?: string;
  terminal: Promise<WorkflowBackgroundRunSettlement<T>>;
  settlement?: WorkflowBackgroundRunSettlement<T>;
}

interface WorkflowSessionGenerationRecord {
  generation: number;
  revoked: boolean;
}

interface WorkflowBackgroundRunRegistryState {
  version: 1;
  nextGeneration: number;
  nextRun: number;
  sessions: Map<string, WorkflowSessionGenerationRecord>;
  runs: Map<string, WorkflowBackgroundRunRecord<unknown>>;
}

export interface WorkflowBackgroundRunRegistry {
  startSession(projectRoot: string, sessionId: string): WorkflowSessionLease;
  isCurrent(lease: WorkflowSessionLease): boolean;
  launch<T>(
    lease: WorkflowSessionLease,
    execute: (context: WorkflowBackgroundRunContext) => Promise<T>,
  ): WorkflowBackgroundLaunchResult<T>;
  attach<T>(
    lease: WorkflowSessionLease,
    hostSignal: AbortSignal,
    execute: (context: WorkflowBackgroundRunContext) => Promise<T>,
  ): WorkflowBackgroundLaunchResult<T>;
  active(lease: WorkflowSessionLease): WorkflowBackgroundRunSnapshot<unknown> | undefined;
  unsettled(lease: WorkflowSessionLease): WorkflowBackgroundRunSnapshot<unknown>[];
  hasActiveSession(projectRoot: string, sessionId: string): boolean;
  stop(lease: WorkflowSessionLease, selector?: string): WorkflowBackgroundStopResult;
  shutdown(lease: WorkflowSessionLease): void;
}

export function workflowBackgroundRunRegistry(): WorkflowBackgroundRunRegistry {
  const state = registryState();
  return {
    startSession(projectRoot, sessionId) {
      const key = sessionKey(projectRoot, sessionId);
      const previous = state.sessions.get(key);
      if (previous !== undefined && !previous.revoked) revokeGeneration(state, key, previous.generation);
      const generation = state.nextGeneration++;
      state.sessions.set(key, { generation, revoked: false });
      return { projectRoot, sessionId, generation };
    },
    isCurrent(lease) {
      return isCurrentLease(state, lease);
    },
    launch<T>(lease: WorkflowSessionLease, execute: (context: WorkflowBackgroundRunContext) => Promise<T>) {
      if (!isCurrentLease(state, lease)) return { ok: false, reason: "stale-lease" as const };
      const active = findActiveExclusiveRun(state, lease);
      if (active !== undefined) {
        return { ok: false, reason: "active-run" as const, active: snapshot(active) };
      }
      return startRun(state, lease, execute, { exclusive: true });
    },
    attach<T>(
      lease: WorkflowSessionLease,
      hostSignal: AbortSignal,
      execute: (context: WorkflowBackgroundRunContext) => Promise<T>,
    ) {
      if (!isCurrentLease(state, lease)) return { ok: false, reason: "stale-lease" as const };
      return startRun(state, lease, execute, { exclusive: false, hostSignal });
    },
    active(lease) {
      if (!isCurrentLease(state, lease)) return undefined;
      const record = findActiveExclusiveRun(state, lease);
      return record === undefined ? undefined : snapshot(record);
    },
    unsettled(lease) {
      if (!isCurrentLease(state, lease)) return [];
      return findUnsettledRuns(state, lease).map((record) => snapshot(record));
    },
    hasActiveSession(projectRoot, sessionId) {
      const current = state.sessions.get(sessionKey(projectRoot, sessionId));
      if (current === undefined || current.revoked) return false;
      return [...state.runs.values()].some(
        (record) =>
          record.lease.projectRoot === projectRoot &&
          record.lease.sessionId === sessionId &&
          record.lease.generation === current.generation &&
          record.state !== "settled",
      );
    },
    stop(lease, selector = "last") {
      if (!isCurrentLease(state, lease)) return { status: "unknown" as const };
      const record = selectRun(state, lease, selector);
      if (record === undefined) return { status: "unknown" as const };
      if (record.state === "settled") return { status: "settled" as const, run: snapshot(record) };
      if (record.stopRequested) return { status: "already-requested" as const, run: snapshot(record) };
      record.stopRequested = true;
      record.state = "stopping";
      record.controller.abort({ kind: "operator_stop" });
      return { status: "requested" as const, run: snapshot(record) };
    },
    shutdown(lease) {
      const key = sessionKey(lease.projectRoot, lease.sessionId);
      const current = state.sessions.get(key);
      if (current?.generation !== lease.generation || current.revoked) return;
      revokeGeneration(state, key, lease.generation);
      // Session records exist only while their host lease is current. Run
      // records retain stable identity and settlement/stop truth independently,
      // so keeping revoked generations here would be unbounded history.
      state.sessions.delete(key);
    },
  };
}

function isCurrentLease(state: WorkflowBackgroundRunRegistryState, lease: WorkflowSessionLease): boolean {
  const current = state.sessions.get(sessionKey(lease.projectRoot, lease.sessionId));
  return current?.generation === lease.generation && current.revoked === false;
}

function startRun<T>(
  state: WorkflowBackgroundRunRegistryState,
  lease: WorkflowSessionLease,
  execute: (context: WorkflowBackgroundRunContext) => Promise<T>,
  options: { exclusive: boolean; hostSignal?: AbortSignal },
): WorkflowBackgroundLaunchResult<T> {
  const controller = new AbortController();
  const launchId = `pending-${state.nextRun++}`;
  let resolveTerminal: ((settlement: WorkflowBackgroundRunSettlement<T>) => void) | undefined;
  const terminal = new Promise<WorkflowBackgroundRunSettlement<T>>((resolve) => {
    resolveTerminal = resolve;
  });
  const record: WorkflowBackgroundRunRecord<T> = {
    launchId,
    lease,
    controller,
    state: "running",
    stopRequested: false,
    exclusive: options.exclusive,
    startedOrder: state.nextRun,
    terminal,
  };
  state.runs.set(launchId, record as WorkflowBackgroundRunRecord<unknown>);

  const forwardHostAbort = (): void => controller.abort(options.hostSignal?.reason);
  if (options.hostSignal?.aborted === true) forwardHostAbort();
  else options.hostSignal?.addEventListener("abort", forwardHostAbort, { once: true });

  const execution = Promise.resolve().then(() =>
    execute({
      signal: controller.signal,
      setRunId(runId) {
        if (runId.trim() !== "") record.runId = runId;
      },
      isCurrent: () => isCurrentLease(state, lease),
    }),
  );
  void execution.then(
    (value) => {
      options.hostSignal?.removeEventListener("abort", forwardHostAbort);
      settleRun(state, record, { status: "fulfilled", value }, resolveTerminal);
    },
    (error) => {
      options.hostSignal?.removeEventListener("abort", forwardHostAbort);
      settleRun(state, record, { status: "rejected", error }, resolveTerminal);
    },
  );
  return { ok: true, run: snapshot(record) };
}

function settleRun<T>(
  state: WorkflowBackgroundRunRegistryState,
  record: WorkflowBackgroundRunRecord<T>,
  settlement: WorkflowBackgroundRunSettlement<T>,
  resolveTerminal: ((settlement: WorkflowBackgroundRunSettlement<T>) => void) | undefined,
): void {
  record.state = "settled";
  record.settlement = settlement;
  resolveTerminal?.(settlement);
  pruneSettledRuns(state);
}

function revokeGeneration(state: WorkflowBackgroundRunRegistryState, key: string, generation: number): void {
  const current = state.sessions.get(key);
  if (current?.generation === generation) current.revoked = true;
  for (const record of state.runs.values()) {
    if (sessionKey(record.lease.projectRoot, record.lease.sessionId) !== key) continue;
    if (record.lease.generation !== generation || record.state === "settled") continue;
    record.stopRequested = true;
    record.state = "stopping";
    record.controller.abort({ kind: "session_shutdown" });
  }
}

function findActiveExclusiveRun(
  state: WorkflowBackgroundRunRegistryState,
  lease: WorkflowSessionLease,
): WorkflowBackgroundRunRecord<unknown> | undefined {
  return findUnsettledRuns(state, lease).find(
    // Records created by the v1 hot-reload shape predate this field and were
    // all slash-command runs, so absence remains exclusive.
    (record) => record.exclusive !== false,
  );
}

function findUnsettledRuns(
  state: WorkflowBackgroundRunRegistryState,
  lease: WorkflowSessionLease,
): WorkflowBackgroundRunRecord<unknown>[] {
  return [...state.runs.values()]
    .filter((record) => sameSession(record.lease, lease) && record.state !== "settled")
    .sort((left, right) => right.startedOrder - left.startedOrder);
}

function selectRun(
  state: WorkflowBackgroundRunRegistryState,
  lease: WorkflowSessionLease,
  selector: string,
): WorkflowBackgroundRunRecord<unknown> | undefined {
  const candidates = [...state.runs.values()]
    .filter((record) => sameSession(record.lease, lease))
    .sort((left, right) => right.startedOrder - left.startedOrder);
  if (selector === "last") return candidates.find((record) => record.state !== "settled") ?? candidates[0];
  return candidates.find((record) => record.runId === selector || record.launchId === selector);
}

function snapshot<T>(record: WorkflowBackgroundRunRecord<T>): WorkflowBackgroundRunSnapshot<T> {
  return {
    launchId: record.launchId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    state: record.state,
    stopRequested: record.stopRequested,
    terminal: record.terminal,
    ...(record.settlement === undefined ? {} : { settlement: record.settlement }),
  };
}

function sameSession(left: WorkflowSessionLease, right: WorkflowSessionLease): boolean {
  return left.projectRoot === right.projectRoot && left.sessionId === right.sessionId;
}

function sessionKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\u0000${sessionId}`;
}

function pruneSettledRuns(state: WorkflowBackgroundRunRegistryState): void {
  const settled = [...state.runs.values()]
    .filter((record) => record.state === "settled")
    .sort((left, right) => right.startedOrder - left.startedOrder);
  for (const record of settled.slice(SETTLED_RUN_LIMIT)) state.runs.delete(record.launchId);
}

function registryState(): WorkflowBackgroundRunRegistryState {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[WORKFLOW_BACKGROUND_RUN_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const created: WorkflowBackgroundRunRegistryState = {
      version: 1,
      nextGeneration: 1,
      nextRun: 1,
      sessions: new Map<string, WorkflowSessionGenerationRecord>(),
      runs: new Map<string, WorkflowBackgroundRunRecord<unknown>>(),
    };
    globalRecord[WORKFLOW_BACKGROUND_RUN_REGISTRY_SYMBOL] = created;
    return created;
  }
  if (!isRegistryState(existing)) {
    throw new Error("Incompatible global workflow run registry at locus-pi.workflow-background-runs.v1");
  }
  return existing;
}

function isRegistryState(value: unknown): value is WorkflowBackgroundRunRegistryState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkflowBackgroundRunRegistryState>;
  return (
    candidate.version === 1 &&
    typeof candidate.nextGeneration === "number" &&
    typeof candidate.nextRun === "number" &&
    candidate.sessions instanceof Map &&
    candidate.runs instanceof Map
  );
}
