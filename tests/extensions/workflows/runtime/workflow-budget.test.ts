import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  DEFAULT_WORKFLOW_CONCURRENCY,
  DEFAULT_HEADLESS_WORKFLOW_TOTAL_AGENTS,
  WORKFLOW_BUDGET_AXES,
  WORKFLOW_BUDGET_UNBOUNDED,
  formatWorkflowBudgetPrelude,
  formatWorkflowBudgetRaise,
  resolveWorkflowBudget,
  workflowBudgetEnvelope,
  type WorkflowBudget,
} from "../../../../extensions/workflows/runtime/workflow-budget.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowJournalFile } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  WorkflowRunDeadlineError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

/** Approved launch defaults and explicit overrides, checked through persisted evidence. */

describe("the applied budget", () => {
  it("defaults only the queueing width outside headless mode", () => {
    expect(resolveWorkflowBudget().budget).toEqual({ concurrency: DEFAULT_WORKFLOW_CONCURRENCY });
    expect(DEFAULT_WORKFLOW_CONCURRENCY).toBe(4);
  });

  it("defaults only the fresh-child allowance in headless mode", () => {
    expect(DEFAULT_HEADLESS_WORKFLOW_TOTAL_AGENTS).toBe(10_000);
    expect(resolveWorkflowBudget(undefined, true)).toEqual({
      budget: { concurrency: 4, totalAgents: 10_000 },
      raises: [],
    });
    expect(
      resolveWorkflowBudget({ totalAgents: undefined } as unknown as Partial<WorkflowBudget>, true).budget.totalAgents,
    ).toBe(10_000);
    expect(resolveWorkflowBudget({ totalAgents: 2 }, true)).toEqual({
      budget: { concurrency: 4, totalAgents: 2 },
      raises: [],
    });
    expect(resolveWorkflowBudget({ totalAgents: 20_000 }, true)).toEqual({
      budget: { concurrency: 4, totalAgents: 20_000 },
      raises: [{ axis: "totalAgents", applied: 10_000, requested: 20_000 }],
    });
  });

  it("names every axis exactly once in WORKFLOW_BUDGET_AXES", () => {
    expect([...WORKFLOW_BUDGET_AXES].sort()).toEqual(
      ["concurrency", "runtimeMs", "timeoutMs", "toolCalls", "totalAgents", "turns"].sort(),
    );
    expect(new Set(WORKFLOW_BUDGET_AXES).size).toBe(WORKFLOW_BUDGET_AXES.length);
  });

  it("prints an undeclared axis as one word rather than omitting it", () => {
    expect(workflowBudgetEnvelope(resolveWorkflowBudget().budget)).toEqual({
      concurrency: 4,
      totalAgents: WORKFLOW_BUDGET_UNBOUNDED,
      runtimeMs: WORKFLOW_BUDGET_UNBOUNDED,
      timeoutMs: WORKFLOW_BUDGET_UNBOUNDED,
      toolCalls: WORKFLOW_BUDGET_UNBOUNDED,
      turns: WORKFLOW_BUDGET_UNBOUNDED,
    });
  });
});

describe("resolveWorkflowBudget", () => {
  it("keeps an explicit value on every axis the caller named", () => {
    const resolved = resolveWorkflowBudget({ concurrency: 1, totalAgents: 3, turns: 7 });
    expect(resolved.budget).toEqual({ concurrency: 1, totalAgents: 3, turns: 7 });
    expect(resolved.raises).toEqual([]);
  });

  it("treats an explicit value on an unbounded axis as a narrowing, never a raise", () => {
    const resolved = resolveWorkflowBudget({ runtimeMs: 172_800_000, turns: 10_000 });
    expect(resolved.raises).toEqual([]);
    expect(resolved.budget.runtimeMs).toBe(172_800_000);
  });

  it("records an explicit raise of the concurrency default", () => {
    const resolved = resolveWorkflowBudget({ concurrency: 16 });
    expect(resolved.budget.concurrency).toBe(16);
    expect(resolved.raises).toEqual([{ axis: "concurrency", applied: 4, requested: 16 }]);
  });

  it("accepts a deadline far longer than one Node timer instead of refusing it", () => {
    const fortyEightHours = 48 * 60 * 60 * 1000;
    expect(resolveWorkflowBudget({ timeoutMs: fortyEightHours }).budget.timeoutMs).toBe(fortyEightHours);
    expect(() => resolveWorkflowBudget({ turns: 1.5 })).toThrow(/positive safe integer/u);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a value that could never bound a run (%s)", (value) => {
    expect(() => resolveWorkflowBudget({ concurrency: value })).toThrow(
      /workflow budget concurrency must be a positive safe integer/u,
    );
  });

  it("names the option it replaced instead of silently dropping the bound it carries", () => {
    expect(() => resolveWorkflowBudget({ maxTotalAgentInvocations: 5 } as unknown as Partial<WorkflowBudget>)).toThrow(
      /workflow budget option maxTotalAgentInvocations was removed; use budget\.totalAgents instead/u,
    );
  });

  it("refuses a key that is not an axis rather than ignoring the bound it carries", () => {
    expect(() => resolveWorkflowBudget({ tolCalls: 40 } as unknown as Partial<WorkflowBudget>)).toThrow(
      /workflow budget has no axis tolCalls/u,
    );
  });

  it("still accepts an unknown key that states nothing, so a spread-built override survives", () => {
    const resolved = resolveWorkflowBudget({
      turns: 2,
      somethingElse: undefined,
    } as unknown as Partial<WorkflowBudget>);
    expect(resolved.budget.turns).toBe(2);
    expect(resolved.raises).toEqual([]);
  });
});

describe("budget journal text", () => {
  it("prints all six axes, undeclared ones included, in one header line", () => {
    const line = formatWorkflowBudgetPrelude(resolveWorkflowBudget({ totalAgents: 2 }).budget);
    expect(line).toContain("concurrency=4");
    expect(line).toContain("totalAgents=2");
    for (const axis of ["runtimeMs", "timeoutMs", "toolCalls", "turns"] as const) {
      expect(line).toContain(`${axis}=${WORKFLOW_BUDGET_UNBOUNDED}`);
    }
  });

  it("names axis, applied default and requested value on a raise", () => {
    const line = formatWorkflowBudgetRaise({ axis: "timeoutMs", applied: 600_000, requested: 900_000 }, "call");
    expect(line).toContain("timeoutMs");
    expect(line).toContain("default=600000");
    expect(line).toContain("requested=900000");
    expect(line).toContain("call");
  });
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-budget-run-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Budget test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

function saveWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

interface ChildObservation {
  /** What the executor factory was handed for this child — the resolved fuses. */
  factory: { maxToolCalls?: number; childTimeoutMs?: number };
  request: AgentRunRequest;
}

/** Scripted execution captures child bounds; callbacks observe concurrency. */
async function runSaved(
  root: string,
  name: string,
  options: {
    budget?: Partial<WorkflowBudget>;
    mode?: "tui" | "rpc" | "print" | "json";
    noOperator?: true;
    input?: string;
    answer?: (request: AgentRunRequest) => string;
    onEnter?: () => void;
    onExit?: () => void;
    hold?: () => Promise<void>;
  } = {},
) {
  const harness = createHarness(root, {
    sessionId: `budget-${name}`,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  const children: ChildObservation[] = [];
  const createExecutor = (factory: { maxToolCalls?: number; childTimeoutMs?: number }): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      children.push({ factory: { ...factory }, request });
      options.onEnter?.();
      if (options.hold !== undefined) await options.hold();
      options.onExit?.();
      return {
        status: "completed" as const,
        agentName: request.agent?.name ?? "sub-agent",
        reason: "answered",
        text: options.answer?.(request) ?? `answer(${request.task})`,
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
  const result = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name,
    createExecutor,
    ...(options.noOperator === undefined ? {} : { noOperator: options.noOperator }),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return { result, children };
}

/** Read durable evidence, independently of the in-memory result journal. */
function persistedJournal(runDir: string): WorkflowJournalLine[] {
  return readFileSync(workflowJournalFile(runDir), "utf8")
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row) => JSON.parse(row) as WorkflowJournalLine);
}

const NO_LIMITS_WORKFLOW = `export const meta = { name: "no-limits", description: "declares no limit of any kind" };
export default async function runWorkflow(dsl) {
  return { answer: await dsl.agent("say something") };
}
`;

/** Four branches, each running its OWN parallel() of three: twelve leaf children.
 *  A FLAT parallel() of twelve is already held to four by the group width, so it
 *  would go green with the global gate switched off and prove nothing. */
const NESTED_FANOUT_WORKFLOW = `export const meta = { name: "nested-fanout", description: "four branches of three" };
export default async function runWorkflow(dsl) {
  const branch = (n) => () => dsl.parallel([
    () => dsl.agent("leaf " + n + "-1"),
    () => dsl.agent("leaf " + n + "-2"),
    () => dsl.agent("leaf " + n + "-3"),
  ]);
  const out = await dsl.parallel([branch(1), branch(2), branch(3), branch(4)]);
  return { branches: out.length };
}
`;

const LOOP_WORKFLOW = `export const meta = { name: "loop", description: "calls agent() until something stops it" };
export default async function runWorkflow(dsl) {
  let calls = 0;
  for (let i = 0; i < 50; i += 1) {
    await dsl.agent("call " + String(i));
    calls += 1;
  }
  return { calls };
}
`;

const ATOMIC_DECOMPOSITION_WORKFLOW = `export const meta = { name: "atomic-decomposition", description: "exceeds the old ordinary-workload cap" };
export default async function runWorkflow(dsl) {
  for (let i = 0; i < 201; i += 1) await dsl.agent("atomic call " + String(i));
  return { calls: 201 };
}
`;

describe("the runner applies the budget contract", () => {
  it.each(["print", "json", "tui", "rpc"] as const)(
    "persists the applied %s host policy without child limits",
    async (mode) => {
      const root = scratchProject();
      saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);
      const { result, children } = await runSaved(root, "no-limits", { mode, noOperator: true });
      expect(result.ok, result.error).toBe(true);
      const cap = mode === "print" || mode === "json" ? 10_000 : "unbounded";
      expect(persistedJournal(result.runDir)[0]?.message).toContain(`totalAgents=${cap}`);
      const stored = JSON.parse(readFileSync(workflowResultFile(result.runDir), "utf8"));
      expect(stored.budget).toEqual({
        concurrency: 4,
        totalAgents: cap,
        runtimeMs: "unbounded",
        timeoutMs: "unbounded",
        toolCalls: "unbounded",
        turns: "unbounded",
      });
      expect(children).toHaveLength(1);
      expect(children[0]?.factory.childTimeoutMs).toBeUndefined();
      expect(children[0]?.factory.maxToolCalls).toBeUndefined();
      expect(children[0]?.request.maxTurns).toBeUndefined();
    },
  );

  it("journals an explicit headless raise over the default", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);
    const { result } = await runSaved(root, "no-limits", { mode: "print", budget: { totalAgents: 20_000 } });
    expect(result.ok, result.error).toBe(true);
    const messages = persistedJournal(result.runDir)
      .map((line) => line.message)
      .join("\n");
    expect(messages).toContain("totalAgents=20000");
    expect(messages).toContain("run raised totalAgents above the applied default: default=10000 requested=20000");
  });

  it("runs 201 children when nobody declared a cap, because there is no cap", async () => {
    const root = scratchProject();
    saveWorkflow(root, "atomic-decomposition", ATOMIC_DECOMPOSITION_WORKFLOW);

    const { result, children } = await runSaved(root, "atomic-decomposition");

    expect(result.ok, result.error).toBe(true);
    expect(result.result).toEqual({ calls: 201 });
    expect(children).toHaveLength(201);
  }, 30_000);

  it("runs a three-child chain with no budgets declared and prints six axes in the header", async () => {
    const root = scratchProject();
    saveWorkflow(
      root,
      "chain",
      `export const meta = { name: "chain", description: "three children, no limits" };
export default async function runWorkflow(dsl) {
  const a = await dsl.agent("one");
  const b = await dsl.agent("two");
  const c = await dsl.agent("three");
  return { a, b, c };
}
`,
    );

    const { result, children } = await runSaved(root, "chain");

    expect(result.ok, result.error).toBe(true);
    expect(children).toHaveLength(3);
    const header = persistedJournal(result.runDir)[0];
    expect(header?.message).toContain("concurrency=4");
    for (const axis of ["totalAgents", "runtimeMs", "timeoutMs", "toolCalls", "turns"] as const) {
      expect(header?.message).toContain(`${axis}=${WORKFLOW_BUDGET_UNBOUNDED}`);
    }
  });

  it("stops the third child before it starts on an explicit totalAgents=2, keeping both answers", async () => {
    const root = scratchProject();
    saveWorkflow(
      root,
      "three-children",
      `export const meta = { name: "three-children", description: "asks for three, is allowed two" };
export default async function runWorkflow(dsl) {
  const answers = [];
  answers.push(await dsl.agent("one"));
  answers.push(await dsl.agent("two"));
  answers.push(await dsl.agent("three"));
  return { answers };
}
`,
    );

    const { result, children } = await runSaved(root, "three-children", { mode: "json", budget: { totalAgents: 2 } });

    expect(result.ok).toBe(false);
    // Two children ran; the third never reached the child runner, so no work was
    // done and then thrown away.
    expect(children).toHaveLength(2);
    const journal = persistedJournal(result.runDir);
    const stop = journal.find((line) => line.message?.includes("stopped by budget"));
    expect(stop).toMatchObject({ kind: "log", source: "runtime" });
    expect(stop?.message).toContain("stopped by budget totalAgents");
    expect(stop?.message).toContain("Data received so far is kept");
    // The two answers that DID arrive are still in the run evidence, and neither is
    // marked failed. A budget stop is not a verdict on the work.
    const ends = journal.filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(end.status).toBe("completed");
    // And the stop is not reported as a bad answer anywhere.
    expect(journal.some((line) => line.message?.includes("stopped by budget"))).toBe(true);
  });

  it("holds nested fan-out to the one effective concurrency", async () => {
    const root = scratchProject();
    saveWorkflow(root, "nested-fanout", NESTED_FANOUT_WORKFLOW);
    let active = 0;
    let peak = 0;

    const { result, children } = await runSaved(root, "nested-fanout", {
      onEnter: () => {
        active += 1;
        peak = Math.max(peak, active);
      },
      onExit: () => {
        active -= 1;
      },
      // Long enough that every child the scheduler is willing to start has started.
      hold: () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
    });

    expect(result.ok, result.error).toBe(true);
    expect(children).toHaveLength(12);
    // Without the global gate these twelve overlap: four branch pools of three.
    expect(peak).toBeLessThanOrEqual(DEFAULT_WORKFLOW_CONCURRENCY);
  });

  it("passes a half-megabyte answer through instead of failing the run on its size", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);
    const long = "x".repeat(600_000);

    const { result } = await runSaved(root, "no-limits", { answer: () => long });

    expect(result.ok, result.error).toBe(true);
  });

  it("refuses a budget override on the removed axis by name, with the reason", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const failure = await runSaved(root, "no-limits", { budget: { answerChars: 500_000 } as never })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("answerChars");
    expect((failure as Error).message).toContain("no longer bounds the SIZE of an answer");
  });

  it("routes a per-run narrowing through to the invocation cap", async () => {
    const root = scratchProject();
    saveWorkflow(root, "loop", LOOP_WORKFLOW);

    const { result, children } = await runSaved(root, "loop", { budget: { totalAgents: 3 } });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("maxTotalAgentInvocations cap of 3");
    // The call that breached the cap is counted and never reaches a child.
    expect(children).toHaveLength(3);
  });

  it("routes a per-run narrowing through to the run wall clock", async () => {
    const root = scratchProject();
    saveWorkflow(root, "loop", LOOP_WORKFLOW);

    // Import may itself exceed 1 ms; assert a stop, not a timing-dependent ordinal.
    const { result, children } = await runSaved(root, "loop", {
      budget: { runtimeMs: 1 },
      hold: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("runtimeMs");
    expect(children.length).toBeLessThan(50);
  });

  it("opens the journal of a run that sets nothing with the applied budget", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const { result } = await runSaved(root, "no-limits");

    const prelude = result.journal[0];
    expect(prelude).toMatchObject({ kind: "log", source: "runtime" });
    const applied = resolveWorkflowBudget().budget;
    for (const axis of WORKFLOW_BUDGET_AXES) {
      expect(prelude?.message).toContain(`${axis}=${String(applied[axis] ?? WORKFLOW_BUDGET_UNBOUNDED)}`);
    }
    expect(result.journal.filter((line) => line.message?.includes("raised"))).toEqual([]);
    expect(persistedJournal(result.runDir)[0]?.message).toBe(prelude?.message);
  });

  it("journals a per-run raise naming the axis, the default and the requested value", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    // TUI has only a concurrency default; explicit runtimeMs narrows silently.
    const { result } = await runSaved(root, "no-limits", {
      budget: { concurrency: 8, runtimeMs: 60_000 },
    });

    const raises = result.journal.filter((line) => line.message?.includes("raised"));
    expect(raises).toHaveLength(1);
    expect(raises[0]).toMatchObject({ kind: "log", source: "runtime" });
    expect(raises[0]?.message).toContain("run raised concurrency");
    expect(raises[0]?.message).toContain("default=4");
    expect(raises[0]?.message).toContain("requested=8");
    // The narrowing on the same call stays silent.
    expect(result.journal.some((line) => line.message?.includes("runtimeMs") && line.message.includes("raised"))).toBe(
      false,
    );
    // The durable record, not the mirror: this is what makes the raise auditable.
    const persisted = persistedJournal(result.runDir).filter((line) => line.message?.includes("raised"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "log", source: "runtime", message: raises[0]?.message });
  });

  it("journals a per-call raise above a run-level value, and stays silent with no value to exceed", async () => {
    const root = scratchProject();
    saveWorkflow(
      root,
      "raising",
      `export const meta = { name: "raising", description: "asks for more than the run declared" };
export default async function runWorkflow(dsl) {
  const narrowed = await dsl.agent("narrow", { maxToolCalls: 10 });
  const raised = await dsl.agent("raise", { timeoutMs: 180000 });
  return { narrowed, raised };
}
`,
    );

    const { result } = await runSaved(root, "raising", { budget: { timeoutMs: 60_000, toolCalls: 100 } });

    expect(result.ok, result.error).toBe(true);
    const raises = result.journal.filter((line) => line.message?.includes("raised"));
    expect(raises).toHaveLength(1);
    expect(raises[0]?.message).toContain("call raised timeoutMs");
    expect(raises[0]?.message).toContain("default=60000");
    expect(raises[0]?.message).toContain("requested=180000");
    // A per-call raise travels the runtime's own emit() rather than the runner's
    // prelude, so its durability is a separate claim and gets its own assertion.
    const persisted = persistedJournal(result.runDir).filter((line) => line.message?.includes("raised"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "log", source: "runtime", message: raises[0]?.message });
  });

  it("refuses a per-run override that could never bound a run", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    await expect(runSaved(root, "no-limits", { budget: { concurrency: 0 } })).rejects.toThrow(
      /workflow budget concurrency must be a positive safe integer/u,
    );
  });
  // These runs schedule hundreds of real async agent calls against real timers,
  // so their wall clock tracks machine load rather than the code under test.
}, 30_000);
// ---------------------------------------------------------------------------
// W6 — the run wall clock
// ---------------------------------------------------------------------------

function clockFrom(start: number): { nowMs: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    nowMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function answeringRuntime(options: {
  runId: string;
  runtimeMs: number;
  nowMs: () => number;
  onRequest?: (request: WorkflowAgentRequest) => void;
}) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId: options.runId,
    runtimeMs: options.runtimeMs,
    nowMs: options.nowMs,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      options.onRequest?.(request);
      return {
        ok: true,
        status: "completed",
        summary: "done",
        text: "answer",
        diagnostics: [],
        agent: request.agent,
      };
    },
  });
  return { ...runtime, requests };
}

describe("run wall clock (runtimeMs)", () => {
  it("honours an explicit invocation cap for direct runtime embeddings without runner coordination", async () => {
    const runtime = createWorkflowRuntime({
      runId: "direct-embedding-private-scheduler",
      maxTotalAgentInvocations: 1,
      agentRunner: async (request): Promise<WorkflowAgentResult> => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: "answer",
        diagnostics: [],
        agent: request.agent,
      }),
    });

    await expect(runtime.dsl.agent("first")).resolves.toBe("answer");
    await expect(runtime.dsl.agent("second")).rejects.toThrow(/maxTotalAgentInvocations cap of 1/u);
  });

  it("refuses an already-expired attempt before it occupies a concurrency slot", async () => {
    const clock = clockFrom(0);
    const { dsl, requests, peakAgentConcurrency } = answeringRuntime({
      runId: "deadline-before-admission",
      runtimeMs: 10,
      nowMs: clock.nowMs,
    });

    clock.advance(11);
    await expect(dsl.agent("already late")).rejects.toThrow(WorkflowRunDeadlineError);
    expect(requests).toHaveLength(0);
    expect(peakAgentConcurrency()).toBe(0);
  });

  it("refuses the next child once the deadline has passed, naming the axis", async () => {
    const clock = clockFrom(1_000);
    const { dsl, requests } = answeringRuntime({ runId: "deadline-between", runtimeMs: 60_000, nowMs: clock.nowMs });

    await expect(dsl.agent("first")).resolves.toBe("answer");
    clock.advance(60_001);
    await expect(dsl.agent("second")).rejects.toThrow(WorkflowRunDeadlineError);
    await expect(dsl.agent("third")).rejects.toThrow(/runtimeMs/u);
    // Only the first call ever reached a child.
    expect(requests).toHaveLength(1);
  });

  it("refuses a child nested two groups deep on the same clock, and exits the run rather than failing one branch", async () => {
    const clock = clockFrom(0);
    let started = 0;
    const { dsl } = answeringRuntime({
      runId: "deadline-nested",
      runtimeMs: 10_000,
      nowMs: clock.nowMs,
      onRequest: () => {
        started += 1;
      },
    });

    // One ordinary child burns the whole run budget.
    await expect(dsl.agent("first")).resolves.toBe("answer");
    clock.advance(10_001);

    // A nested group does NOT get a fresh clock, and the refusal is not converted
    // into a per-branch group failure: it leaves the whole run.
    const nested = dsl.parallel([
      () => dsl.parallel([() => dsl.agent("a"), () => dsl.agent("b")]),
      () => dsl.parallel([() => dsl.agent("c"), () => dsl.agent("d")]),
    ]);
    await expect(nested).rejects.toThrow(WorkflowRunDeadlineError);
    await expect(nested).rejects.toThrow(/runtimeMs/u);
    expect(started).toBe(1);
  });

  it("rechecks the deadline after a queued child acquires the global concurrency slot", async () => {
    const clock = clockFrom(0);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const runtime = createWorkflowRuntime({
      runId: "deadline-after-queue",
      runtimeMs: 10,
      nowMs: clock.nowMs,
      maxConcurrentAgents: 1,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        started.push(request.prompt);
        if (request.prompt === "first") await firstBlocked;
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: "answer",
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    // Explicit group width of 2 against a global gate of 1: both calls enter the
    // runtime and the second waits at the GATE, which is the state under test. The
    // group pool would otherwise inherit the run's width of 1 and admit them one at
    // a time, so nothing would ever queue.
    const grouped = runtime.dsl.parallel([() => runtime.dsl.agent("first"), () => runtime.dsl.agent("queued")], {
      concurrency: 2,
    });
    // Both calls have entered the runtime; only the first owns the one execution
    // slot, so only it is started — the other is still queued at the gate.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.getJournal().filter((line) => line.kind === "agent_queued")).toHaveLength(2);
    expect(runtime.getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(1);
    expect(started).toEqual(["first"]);

    clock.advance(11);
    releaseFirst();
    await expect(grouped).rejects.toThrow(WorkflowRunDeadlineError);
    // The queued request is refused at admission and never reaches the child runner.
    expect(started).toEqual(["first"]);
  });

  it("arms the deadline once at construction, not per call", async () => {
    const clock = clockFrom(500);
    const { dsl } = answeringRuntime({ runId: "deadline-armed-once", runtimeMs: 5_000, nowMs: clock.nowMs });

    clock.advance(2_500);
    await expect(dsl.agent("still inside")).resolves.toBe("answer");
    clock.advance(2_500);
    // Exactly at the deadline the budget is spent but not exceeded.
    await expect(dsl.agent("exactly at the deadline")).resolves.toBe("answer");
    clock.advance(1);
    // 5_001 ms since CONSTRUCTION; a per-call clock would still allow this.
    await expect(dsl.agent("now outside")).rejects.toThrow(WorkflowRunDeadlineError);
  });

  it("does NOT bound a script that stops calling agent() — the accepted limit of this design", async () => {
    // Characterisation, not aspiration (D9 cases (a) and (b)). The deadline is a
    // check at agent-attempt start, so pure script work past it completes normally.
    // Asserted here so a later reader sees a chosen scope rather than an untested hole.
    const clock = clockFrom(0);
    const { dsl } = answeringRuntime({ runId: "deadline-script-only", runtimeMs: 1_000, nowMs: clock.nowMs });

    await expect(dsl.agent("one child")).resolves.toBe("answer");
    clock.advance(1_000_000);
    let loops = 0;
    for (let i = 0; i < 1_000; i += 1) {
      dsl.log(`script work ${String(i)}`);
      loops += 1;
    }
    expect(loops).toBe(1_000);
    // The run is still alive and can even finish successfully.
    await expect(dsl.workflow(async () => "done")).resolves.toBe("done");
  });

  it.each([0, -1, 1.5])("refuses a runtimeMs that could never bound a run (%s)", (runtimeMs) => {
    expect(() =>
      createWorkflowRuntime({
        runId: "deadline-invalid",
        runtimeMs,
        agentRunner: async () => {
          throw new Error("must not run");
        },
      }),
    ).toThrow(/workflow budget runtimeMs must be a positive safe integer/u);
  });

  it("leaves a runtime with no runtimeMs unbounded, so existing embedders are unchanged", async () => {
    const clock = clockFrom(0);
    const { dsl } = createWorkflowRuntime({
      runId: "deadline-absent",
      nowMs: clock.nowMs,
      agentRunner: async (request): Promise<WorkflowAgentResult> => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: "answer",
        diagnostics: [],
        agent: request.agent,
      }),
    });

    clock.advance(Number.MAX_SAFE_INTEGER - 1);
    await expect(dsl.agent("late but unbounded")).resolves.toBe("answer");
  });

  it("journals the axis when the deadline passes WHILE a call waits for a concurrency slot", async () => {
    // The pre-queue check is not the one that usually fires. A run with a narrow
    // concurrency spends most of its wall clock with calls queued, so the check that
    // actually stops such a run is the second one — and it was bare, ending the run
    // with an error and no line naming the axis or saying the answers are kept.
    const clock = clockFrom(0);
    const lines: WorkflowJournalLine[] = [];
    const started: string[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "deadline-after-queue-wait",
      runtimeMs: 100,
      // ONE leaf agent at a time, so the second call provably waits at the gate.
      maxConcurrentAgents: 1,
      nowMs: clock.nowMs,
      onEvent: (line) => lines.push(line),
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        started.push(request.prompt);
        // The first child outlives the run deadline; the second is still queued.
        clock.advance(150);
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: "answer",
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    // Group width 2 against a run concurrency of 1: both calls pass the pre-queue
    // check at t=0, then the second one waits for the gate.
    await expect(
      dsl.parallel([() => dsl.agent("first"), () => dsl.agent("queued")], { concurrency: 2 }),
    ).rejects.toThrow(WorkflowRunDeadlineError);

    // Only the first child ran; the queued one never reached the runner.
    expect(started).toEqual(["first"]);
    const stop = lines.find((line) => line.message?.includes("stopped by budget"));
    expect(stop).toMatchObject({ kind: "log", source: "runtime" });
    expect(stop?.message).toContain("stopped by budget runtimeMs");
    expect(stop?.message).toContain("Data received so far is kept");
  });

  it("journals a fusion that does not fit the remaining totalAgents as a budget stop", async () => {
    // Running out of declared invocations is not a broken panel: the request was
    // well-formed and the run simply has no room for it. It used to throw a bare
    // Error, so the journal said nothing about which axis ended the run.
    const lines: WorkflowJournalLine[] = [];
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "fusion-budget-stop",
      maxTotalAgentInvocations: 2,
      onEvent: (line) => lines.push(line),
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        calls += 1;
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: "answer",
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    await expect(
      dsl.fusion("which option is safer?", {
        mode: "agent",
        members: [
          { label: "alpha", model: "test/alpha" },
          { label: "beta", model: "test/beta" },
        ],
        judge: { label: "synthesizer", model: "test/judge" },
      }),
    ).rejects.toThrow(/only 2 remain/u);

    // Refused before the panel convened, so nothing was spent on it.
    expect(calls).toBe(0);
    const stop = lines.find((line) => line.message?.includes("stopped by budget"));
    expect(stop).toMatchObject({ kind: "log", source: "runtime" });
    expect(stop?.message).toContain("stopped by budget totalAgents");
    expect(stop?.message).toContain("only 2 remain in this run");
    expect(stop?.message).toContain("Data received so far is kept");
  });
  // Same reason as the runner suite above: real scheduling, real timers.
}, 30_000);
