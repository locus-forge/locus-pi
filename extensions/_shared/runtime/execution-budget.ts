/** The root's one physical-launch ledger. No host, scheduler, or feature imports. */
export interface ExecutionReservation {
  readonly remaining: number;
  readonly active: boolean;
}

export interface ExecutionBudgetOptions {
  totalAgents?: number;
  runtimeMs?: number;
  nowMs?: () => number;
  capError: (cap: number, requested?: number, remaining?: number) => Error;
  deadlineError: (runtimeMs: number, elapsedMs: number) => Error;
}

export function createExecutionBudget(options: ExecutionBudgetOptions) {
  for (const [axis, value] of [
    ["totalAgents", options.totalAgents],
    ["runtimeMs", options.runtimeMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`${axis} must be a positive safe integer`);
    }
  }
  const now = options.nowMs ?? Date.now;
  const started = now();
  let sequence = 0;
  let charged = 0;
  let replayed = 0;
  let reserved = 0;
  const reservations = new WeakMap<ExecutionReservation, { remaining: number; active: boolean }>();
  const remaining = () => (options.totalAgents === undefined ? undefined : options.totalAgents - charged - reserved);
  function owned(reservation: ExecutionReservation) {
    const record = reservations.get(reservation);
    if (record === undefined) throw new Error("execution reservation belongs to another root");
    return record;
  }
  function consume(reservation: ExecutionReservation) {
    const record = owned(reservation);
    if (!record.active || record.remaining < 1) throw options.capError(options.totalAgents ?? 0);
    record.remaining -= 1;
    reserved -= 1;
  }
  return {
    reserve(count: number): ExecutionReservation {
      if (!Number.isSafeInteger(count) || count < 1)
        throw new Error("reservation count must be a positive safe integer");
      const left = remaining();
      if (left !== undefined && count > left) throw options.capError(options.totalAgents!, count, left);
      const record = { remaining: count, active: true };
      const reservation = Object.freeze({
        get remaining() {
          return record.remaining;
        },
        get active() {
          return record.active;
        },
      });
      reservations.set(reservation, record);
      reserved += count;
      return reservation;
    },
    release(reservation: ExecutionReservation): void {
      const record = owned(reservation);
      if (!record.active) return;
      reserved -= record.remaining;
      record.remaining = 0;
      record.active = false;
    },
    allocate(kind: "fresh" | "replayed", reservation?: ExecutionReservation): number {
      if (kind === "replayed") {
        if (reservation !== undefined) consume(reservation);
        replayed += 1;
      }
      return ++sequence;
    },
    charge(reservation?: ExecutionReservation): void {
      if (reservation !== undefined) consume(reservation);
      else if (options.totalAgents !== undefined && charged + reserved >= options.totalAgents) {
        throw options.capError(options.totalAgents);
      }
      charged += 1;
    },
    remaining,
    counts: () => ({ fresh: charged, replayed }),
    assertDeadline(): void {
      if (options.runtimeMs === undefined) return;
      const elapsed = now() - started;
      // Preserve the workflow's start-deadline contract, including its exact boundary.
      if (elapsed > options.runtimeMs) throw options.deadlineError(options.runtimeMs, elapsed);
    },
  };
}
