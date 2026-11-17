import { performance } from "node:perf_hooks";
import { scheduleLongTimeout } from "../../runtime/long-timer.js";

import type { AgentStartupMark, AgentStartupStage } from "./startup-format.js";
export type { AgentStartupMark, AgentStartupStage } from "./startup-format.js";

export const WORKFLOW_STARTUP_TIMEOUT_ENV = "LOCUS_PI_WORKFLOW_STARTUP_TIMEOUT_MS";
export const DEFAULT_WORKFLOW_STARTUP_TIMEOUT_MS = 120_000;

export function workflowStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WORKFLOW_STARTUP_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_WORKFLOW_STARTUP_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${WORKFLOW_STARTUP_TIMEOUT_ENV} must be a positive safe integer in milliseconds`);
  }
  return value;
}

export class AgentStartupTimeoutError extends Error {
  readonly failureCause = "startup-timeout" as const;
  constructor(
    timeoutMs: number,
    readonly lastStage: AgentStartupStage | undefined,
  ) {
    super(`Agent startup exceeded its ${timeoutMs} ms limit; last completed stage: ${lastStage ?? "none"}.`);
    this.name = "AgentStartupTimeoutError";
  }
}

/** One physical launch owns its deadline, process measurements and late-work fencing. */
export class AgentStartup {
  readonly marks: AgentStartupMark[] = [];
  private readonly started = performance.now();
  private previous = this.started;
  private cpu = process.cpuUsage();
  private sampledAt = this.started;
  private maxDelay = 0;
  private ready = false;
  private closed = false;
  private expired: AgentStartupTimeoutError | undefined;
  private readonly deadline: Promise<never>;
  private rejectDeadline!: (reason: AgentStartupTimeoutError) => void;
  private readonly cancelDeadline: () => void;
  private readonly sampler: ReturnType<typeof setInterval>;

  constructor(
    private readonly timeoutMs: number,
    private readonly onMark?: (mark: AgentStartupMark) => void,
  ) {
    this.deadline = new Promise((_, reject) => {
      this.rejectDeadline = reject;
    });
    // Expiry can occur during synchronous work, before the next bounded await.
    void this.deadline.catch(() => {});
    this.cancelDeadline = scheduleLongTimeout(timeoutMs, () => this.expire(), "agent startup timeout");
    this.sampler = setInterval(() => {
      const now = performance.now();
      this.maxDelay = Math.max(this.maxDelay, now - this.sampledAt - 10);
      this.sampledAt = now;
    }, 10);
    this.sampler.unref();
    try {
      this.mark("agent_start");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private expire(): void {
    this.expired ??= new AgentStartupTimeoutError(this.timeoutMs, this.marks.at(-1)?.stage);
    this.rejectDeadline(this.expired);
  }

  private check(): void {
    if (!this.ready && performance.now() - this.started >= this.timeoutMs) this.expire();
    if (this.expired !== undefined) throw this.expired;
  }

  mark(stage: AgentStartupStage): void {
    this.check();
    if (this.closed || this.marks.some((mark) => mark.stage === stage)) return;
    const first = this.marks.length === 0;
    const now = first ? this.started : performance.now();
    const cpu = process.cpuUsage();
    const mark: AgentStartupMark = {
      stage,
      ts: new Date().toISOString(),
      elapsedMs: first ? 0 : now - this.started,
      wallMs: first ? 0 : now - this.previous,
      cpuUserMs: first ? 0 : (cpu.user - this.cpu.user) / 1000,
      cpuSystemMs: first ? 0 : (cpu.system - this.cpu.system) / 1000,
      // Sample also at the mark: a blocked loop may not have run its timer yet.
      eventLoopDelayMs: first ? 0 : Math.max(0, this.maxDelay, now - this.sampledAt - 10),
    };
    this.previous = now;
    this.cpu = cpu;
    this.sampledAt = now;
    this.maxDelay = 0;
    this.marks.push(mark);
    if (stage === "session_ready") {
      this.ready = true;
      this.cancelDeadline();
    }
    this.onMark?.(mark);
  }

  async wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    void pending.catch(() => {});
    this.check();
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([pending, this.deadline, aborted]);
      this.check();
      signal?.throwIfAborted();
      return result;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    this.closed = true;
    this.cancelDeadline();
    clearInterval(this.sampler);
  }
}
