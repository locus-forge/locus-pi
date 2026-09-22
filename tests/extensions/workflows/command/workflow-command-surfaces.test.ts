/**
 * Characterization of the `/workflows` operator surfaces that no other test
 * pinned: the help block, the unknown-command fallback, the disk-backed run
 * list (empty and populated, compact and wide), the explicit-stop block, and
 * the argument-parse rejections for `--resume` / `--answer`.
 *
 * Written against the pre-split tree so the T-126 move of these blocks out of
 * `extensions/workflows/index.ts` has evidence that the rendered text did not
 * change.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import * as workflowJournal from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { workflowBackgroundRunRegistry } from "../../../../extensions/workflows/run/background-run-registry.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowJournalFile } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { parseRunCommand, workflowRunUsage } from "../../../../extensions/workflows/command/command-parser.js";
import workflows from "../../../../extensions/workflows/index.js";
import { buildRunDetailBlock } from "../../../../extensions/workflows/run/run-evidence.js";
import {
  WORKFLOW_RESULT_CUSTOM_TYPE,
  WORKFLOW_RUN_CUSTOM_TYPE,
} from "../../../../extensions/workflows/command/receipts.js";
import { createHarness, emit, type Harness } from "../../../test-harness.js";

const roots: string[] = [];
const MALFORMED_RUN_SELECTORS = ["../outside", "bad/id", "запуск", "a".repeat(129)] as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-command-surfaces-"));
  roots.push(root);
  return root;
}

/** One finished run on disk: a journal Pi can replay and a persisted envelope. */
function writeRun(root: string, runId: string): void {
  const runDir = ensureWorkflowRunDir(root, runId);
  const journal = [
    { ts: "2026-07-26T21:27:52.000Z", runId, kind: "phase", phase: "review" },
    { ts: "2026-07-26T21:27:53.000Z", runId, kind: "agent_start", agent: "reviewer", label: "pass 1" },
    {
      ts: "2026-07-26T21:27:54.000Z",
      runId,
      kind: "agent_end",
      agent: "reviewer",
      status: "completed",
      durationMs: 1200,
    },
    { ts: "2026-07-26T21:27:55.000Z", runId, kind: "log", source: "script", message: "wrote findings" },
  ];
  writeFileSync(workflowJournalFile(runDir), `${journal.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  writeFileSync(
    workflowResultFile(runDir),
    `${JSON.stringify({ runId, ok: true, result: { summary: "review done" }, journal: [] }, null, 2)}\n`,
    "utf8",
  );
}

function widgetOf(h: Harness): string {
  return h.widgets.get("workflows") ?? "";
}

async function runCommand(h: Harness, text: string): Promise<string> {
  await h.commands.get("workflows")!.handler(text, h.ctx);
  return widgetOf(h);
}

/** A tui host with no custom UI: the wide, non-compact passive blocks. */
function wideHarness(root: string): Harness {
  const h = createHarness(root);
  delete h.ctx.ui.custom;
  workflows(h.pi);
  return h;
}

function compactHarness(root: string): Harness {
  const h = createHarness(root, { mode: "rpc" });
  workflows(h.pi);
  return h;
}

describe("/workflows help and unknown commands", () => {
  it("uses a workflow target chooser for run", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "alpha.workflow.mjs"),
      'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>null;\n',
      "utf8",
    );
    const runId = "20260726-212752-98cc";
    writeRun(root, runId);

    const run = createHarness(root);
    run.selectQueue.push("run", "alpha");
    workflows(run.pi);
    await run.commands.get("workflows")!.handler("", run.ctx);
    expect(run.editorText).toBe("/workflows run alpha");
    expect(run.selectCalls.flatMap((call) => call.options).every((option) => typeof option === "string")).toBe(true);
  });

  it("prefills post-code-review without a manual workspace", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "post-code-review.workflow.mjs"),
      'export const meta={name:"post-code-review",description:"Review workflow"}; export default async()=>null;\n',
      "utf8",
    );

    const run = createHarness(root);
    run.selectQueue.push("run", "post-code-review");
    workflows(run.pi);
    await run.commands.get("workflows")!.handler("", run.ctx);

    expect(run.editorText).toBe("/workflows run post-code-review");
  });

  it("waits for the native selector teardown before filling the editor", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "alpha.workflow.mjs"),
      'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>null;\n',
      "utf8",
    );
    const target = deferred<string>();
    const run = createHarness(root);
    const setEditorText = vi.fn();
    const setStatus = vi.spyOn(run.ctx.ui, "setStatus");
    run.ctx.ui.setEditorText = setEditorText;
    let selectCount = 0;
    run.ctx.ui.select = vi.fn(async () => {
      selectCount += 1;
      if (selectCount === 1) return "run — start a workflow";
      return target.promise;
    });
    workflows(run.pi);

    const pending = run.commands.get("workflows")!.handler("", run.ctx);
    while (selectCount < 2) await Promise.resolve();
    target.resolve("alpha");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(setEditorText).not.toHaveBeenCalled();
    await pending;
    expect(setEditorText).toHaveBeenCalledWith("/workflows run alpha");
    expect(setStatus).toHaveBeenCalledWith("workflows:editor-prefill-render", undefined);
  });

  it("registers distinct readable renderers for workflow lifecycle and result messages", () => {
    const h = createHarness(makeRoot());
    workflows(h.pi);

    expect([...h.messageRenderers.keys()].sort()).toEqual(
      [WORKFLOW_RESULT_CUSTOM_TYPE, WORKFLOW_RUN_CUSTOM_TYPE].sort(),
    );
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const runRenderer = h.messageRenderers.get(WORKFLOW_RUN_CUSTOM_TYPE)!;
    const start = runRenderer(
      {
        customType: WORKFLOW_RUN_CUSTOM_TYPE,
        content: "── workflow plan · run #1234 · started 05:03 ──",
        details: { eventKind: "workflow_start" },
      },
      { expanded: true, outputPad: 0 },
      theme,
    );
    const end = runRenderer(
      {
        customType: WORKFLOW_RUN_CUSTOM_TYPE,
        content: "── workflow plan · run #1234 · finished 05:06 ──",
        details: { eventKind: "workflow_end" },
      },
      { expanded: true, outputPad: 0 },
      theme,
    );
    expect(start?.render(100).join("\n")).toContain("Workflow started");
    expect(end?.render(100).join("\n")).toContain("Workflow finished");
  });

  it("routes info, result, and continue through contextual menu paths", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "alpha.workflow.mjs"),
      'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>null;\n',
      "utf8",
    );
    const runId = "20260726-212752-98cc";
    writeRun(root, runId);

    const info = createHarness(root);
    delete info.ctx.ui.custom;
    info.selectQueue.push("info", "alpha");
    workflows(info.pi);
    await info.commands.get("workflows")!.handler("", info.ctx);
    expect(info.selectCalls.map((call) => call.title)).toEqual(["[SELECT] Workflows", "[SELECT] Workflow to info"]);
    expect(info.selectCalls.flatMap((call) => call.options).every((option) => typeof option === "string")).toBe(true);
    expect(info.widgets.get("workflows") ?? "").toContain("Workflow info");

    const result = createHarness(root);
    delete result.ctx.ui.custom;
    result.selectQueue.push("result", runId);
    workflows(result.pi);
    await result.commands.get("workflows")!.handler("", result.ctx);
    expect(result.selectCalls.map((call) => call.title)).toEqual([
      "[SELECT] Workflows",
      "[SELECT] Workflow run to read result for",
    ]);
    expect(result.selectCalls.flatMap((call) => call.options).every((option) => typeof option === "string")).toBe(true);
    expect(result.widgets.get("workflows") ?? "").toContain(runId);

    const continuation = createHarness(root);
    continuation.selectQueue.push("continue");
    workflows(continuation.pi);
    await continuation.commands.get("workflows")!.handler("", continuation.ctx);
    expect(continuation.selectCalls.map((call) => call.title)).toEqual(["[SELECT] Workflows"]);
    expect(continuation.selectCalls.flatMap((call) => call.options).every((option) => typeof option === "string")).toBe(
      true,
    );
    expect(continuation.widgets.get("workflows") ?? "").toContain("No workflow handoff currently needs an answer.");
  });

  it("quotes an interior-whitespace workflow ref and parses it without an input tail", async () => {
    const root = makeRoot();
    const targetRef = "alpha workflow";
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, `${targetRef}.workflow.mjs`),
      'export const meta={description:"Whitespace target"}; export default async()=>null;\n',
      "utf8",
    );
    const h = createHarness(root);
    h.selectQueue.push("run", JSON.stringify(targetRef));
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);

    const command = `/workflows run ${JSON.stringify(targetRef)}`;
    expect(h.editorText).toBe(command);
    expect(parseRunCommand(command.slice("/workflows ".length))).toEqual({ scriptRef: targetRef });
  });

  it("parses a fresh output namespace and resume id before semantic input", () => {
    expect(parseRunCommand("run task/plan --run-name airflow-builder")).toEqual({
      scriptRef: "task/plan",
      runName: "airflow-builder",
    });
    expect(
      parseRunCommand(
        'run post-code-review --output-dir "tmp/post-code-review/review 1" --resume prior-run review commit HEAD',
      ),
    ).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/post-code-review/review 1",
      resumeFromRunId: "prior-run",
      input: "review commit HEAD",
    });
    expect(parseRunCommand("run post-code-review --resume prior-run --output-dir tmp/review-1")).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/review-1",
      resumeFromRunId: "prior-run",
    });
    expect(
      parseRunCommand(
        "run post-code-review --output-dir tmp/first --resume run-first --output-dir tmp/last --resume run-last",
      ),
    ).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/last",
      resumeFromRunId: "run-last",
    });
    expect(parseRunCommand("run post-code-review --output-dir tmp/fresh --resume")).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/fresh",
      missingResumeId: true,
    });
    expect(parseRunCommand("run task/draft --run-name")).toEqual({
      scriptRef: "task/draft",
      missingRunName: true,
    });
    // Run-level no-operator mode: value-less flag, composable with the value
    // options in any order, and never swallowed into semantic input.
    expect(parseRunCommand("run plan --no-operator")).toEqual({
      scriptRef: "plan",
      noOperator: true,
    });
    expect(parseRunCommand("run plan --no-operator --output-dir tmp/auto ship the fix")).toEqual({
      scriptRef: "plan",
      outputDir: "tmp/auto",
      noOperator: true,
      input: "ship the fix",
    });
    expect(parseRunCommand("run plan --output-dir tmp/auto --no-operator -- --no-operator stays input")).toEqual({
      scriptRef: "plan",
      outputDir: "tmp/auto",
      noOperator: true,
      input: "--no-operator stays input",
    });
    // The headless opt-out is the same kind of value-less flag, and the last
    // mode flag wins exactly like a repeated value option.
    expect(parseRunCommand("run plan --operator")).toEqual({
      scriptRef: "plan",
      noOperator: false,
    });
    expect(parseRunCommand("run plan --operator --output-dir tmp/auto ship the fix")).toEqual({
      scriptRef: "plan",
      outputDir: "tmp/auto",
      noOperator: false,
      input: "ship the fix",
    });
    expect(parseRunCommand("run plan --no-operator --operator")).toEqual({
      scriptRef: "plan",
      noOperator: false,
    });
    expect(parseRunCommand("run plan --operator --no-operator")).toEqual({
      scriptRef: "plan",
      noOperator: true,
    });
    expect(parseRunCommand("run plan -- --operator stays input")).toEqual({
      scriptRef: "plan",
      input: "--operator stays input",
    });
    // A value option cannot eat the flag as its value.
    expect(parseRunCommand("run plan --output-dir --no-operator")).toEqual({
      scriptRef: "plan",
      missingOutputDir: true,
    });
    expect(parseRunCommand("run plan --output-dir --operator")).toEqual({
      scriptRef: "plan",
      missingOutputDir: true,
    });
    expect(parseRunCommand("run post-code-review --resume run-old --output-dir")).toEqual({
      scriptRef: "post-code-review",
      resumeFromRunId: "run-old",
      missingOutputDir: true,
    });
    expect(parseRunCommand('run post-code-review --resume ""')).toEqual({
      scriptRef: "post-code-review",
      missingResumeId: true,
    });
    expect(parseRunCommand('run post-code-review --resume " "')).toEqual({
      scriptRef: "post-code-review",
      resumeFromRunId: " ",
    });
    expect(parseRunCommand("run post-code-review --output-dir tmp/first --output-dir")).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/first",
      missingOutputDir: true,
    });
    expect(parseRunCommand('run post-code-review --output-dir "tmp/first review" --output-dir')).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/first review",
      missingOutputDir: true,
    });
    expect(parseRunCommand("run post-code-review --resume run-first --resume")).toEqual({
      scriptRef: "post-code-review",
      resumeFromRunId: "run-first",
      missingResumeId: true,
    });
  });

  it.each(["\t", "\n", "\u00a0"])("recognizes run options separated by %j", (separator) => {
    expect(
      parseRunCommand(`run post-code-review --output-dir${separator}tmp/review --resume${separator}prior-run`),
    ).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/review",
      resumeFromRunId: "prior-run",
    });
  });

  it("forwards the exact remainder after the end-of-options delimiter", () => {
    expect(parseRunCommand("run post-code-review -- --resume --output-dir --")).toEqual({
      scriptRef: "post-code-review",
      input: "--resume --output-dir --",
    });
    expect(
      parseRunCommand("run post-code-review --output-dir tmp/review --resume run-old --   --resume  --output-dir"),
    ).toEqual({
      scriptRef: "post-code-review",
      outputDir: "tmp/review",
      resumeFromRunId: "run-old",
      input: "  --resume  --output-dir",
    });
    expect(parseRunCommand("run post-code-review -- --")).toEqual({ scriptRef: "post-code-review", input: "--" });
  });

  it("registers the complete run grammar only on the canonical command", () => {
    const h = createHarness(makeRoot());
    workflows(h.pi);

    // The palette description says what the command is for, in one line the same
    // length as its neighbours; the full grammar belongs to the help surfaces and
    // is asserted on them ("names an unknown subcommand and prints the usage line").
    const description = h.commands.get("workflows")?.description ?? "";
    expect(description).toBe("Open the workflow command menu, or run, inspect, continue, and stop workflow runs.");
    expect(description).not.toContain(workflowRunUsage("<name|path>", "run"));
    expect(workflowRunUsage()).toBe(
      "/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]",
    );
    expect(h.commands.has("workflow-run")).toBe(false);
    expect(h.commands.get("workflow-stop")?.description).toBe(
      "Compatibility alias for /workflows stop [runId|last]: /workflow-stop",
    );
  });

  it("limits stop-menu choices to unsettled runs owned by the current session lease", async () => {
    const root = makeRoot();
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "alpha.workflow.mjs"), "export default async()=>null;\n", "utf8");
    const finishedId = "20260726-212752-finished";
    writeRun(root, finishedId);

    const registry = workflowBackgroundRunRegistry();
    const priorGate = deferred<void>();
    const priorLease = registry.startSession(root, "prior-session");
    const prior = registry.launch(priorLease, async () => priorGate.promise);
    expect(prior.ok).toBe(true);
    if (!prior.ok) throw new Error("expected prior-session pending run");

    const currentGate = deferred<void>();
    const runScript = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async () => {
      await currentGate.promise;
      throw new Error("stop-menu test cleanup");
    });
    const h = createHarness(root, { sessionId: "current-session" });
    workflows(h.pi);
    await emit(h, "session_start");
    const runPromise = h.commands.get("workflows")!.handler("run alpha", h.ctx);
    try {
      await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(1));

      h.selectQueue.push("stop");
      await h.commands.get("workflows")!.handler("", h.ctx);

      const stopChoices = h.selectCalls.at(-1)?.options ?? [];
      const stopValues = stopChoices.map((choice) => (typeof choice === "string" ? choice : choice.value));
      expect(stopChoices.every((choice) => typeof choice === "string")).toBe(true);
      expect(stopValues).toContain("last");
      expect(stopValues.some((value) => value.startsWith("pending-"))).toBe(true);
      expect(stopValues).not.toContain(finishedId);
      expect(stopValues).not.toContain(prior.ok ? prior.run.launchId : "");
    } finally {
      currentGate.resolve();
      priorGate.resolve();
      await Promise.resolve(runPromise).catch(() => undefined);
    }
  });

  it("keeps bare /workflows as bounded help on RPC hosts", async () => {
    const widget = await runCommand(compactHarness(makeRoot()), "");

    expect(widget).toContain("Workflow commands");
    expect(widget).toContain("Dashboard: /workflows dashboard");
    expect(widget).toMatch(/interactive menu is available in a Pi\s+TUI/u);
    expect(widget).toContain("A command starts execution only when the Pi session is provably idle.");
  });

  it("keeps a headless/RPC bare command honest without claiming an interactive chooser", async () => {
    const h = compactHarness(makeRoot());

    await h.commands.get("workflows")!.handler("", h.ctx);

    expect(h.selectCalls).toEqual([]);
    expect(h.customComponents).toEqual([]);
    const widget = h.widgets.get("workflows") ?? "";
    expect(widget).toContain("Workflow commands");
    expect(widget.length).toBeGreaterThan(0);
  });

  it("falls back to bounded help on a TUI host without native select support", async () => {
    const h = createHarness(makeRoot());
    h.ctx.ui.select = undefined as unknown as typeof h.ctx.ui.select;
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("", h.ctx);

    expect(h.selectCalls).toEqual([]);
    expect(h.widgets.get("workflows") ?? "").toContain("Workflow commands");
  });

  it("names an unknown subcommand and prints the usage line", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "frobnicate");

    expect(widget).toContain("Unknown workflow command: frobnicate");
    expect(widget).toContain("Usage: /workflows | dashboard | list [query]");
    expect(widget).not.toContain("Available curated Package workflows");
  });

  it("lists the curated names when the unknown command started with run", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run");

    expect(widget).toContain("Unknown workflow command: run");
    expect(widget).toContain("Available curated Package workflows:");
    expect(widget).toContain("post-code-review");
  });
});

describe("flat workflow command compatibility", () => {
  it("keeps only the emergency stop alias", async () => {
    const h = wideHarness(makeRoot());
    expect(h.commands.get("workflow-stop")).toBeDefined();
    for (const name of [
      "workflow-dashboard",
      "workflow-list",
      "workflow-info",
      "workflow-status",
      "workflow-result",
      "workflow-run",
      "workflow-continue",
    ])
      expect(h.commands.has(name), name).toBe(false);
  });

  it("matches canonical stop output and side effects", async () => {
    const root = makeRoot();
    const canonical = wideHarness(root);
    await canonical.commands.get("workflows")!.handler("stop missing", canonical.ctx);

    const alias = wideHarness(root);
    await alias.commands.get("workflow-stop")!.handler("missing", alias.ctx);

    expect(widgetOf(alias)).toBe(widgetOf(canonical));
    expect(alias.notifications).toEqual(canonical.notifications);
  });
});

describe("/workflows status run list", () => {
  it("says there is nothing yet and offers the first run", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "status");

    expect(widget).toContain("No workflow runs yet.");
    expect(widget).toContain("status: ok; total=0 shown=0 older=0");
    expect(widget).toContain('Draft one: /workflows run task/draft "<your request>"');
  });

  it("renders one wide row per run with the agent and status columns", async () => {
    const root = makeRoot();
    writeRun(root, "20260726-212752-98cc");
    const widget = await runCommand(wideHarness(root), "status");

    expect(widget).toContain("Showing 1 newest of 1 workflow run(s).");
    expect(widget).toContain("20260726-212752-98cc");
    expect(widget).toContain("phase=review");
    expect(widget).toContain("agents=1/1");
    expect(widget).toContain("Detail: /workflows status <runId>");
  });

  it("keeps a compact host to the bounded newest rows", async () => {
    const root = makeRoot();
    for (const index of [1, 2, 3, 4, 5]) writeRun(root, `2026072${index}-101010-98c${index}`);
    const widget = await runCommand(compactHarness(root), "status");

    // WORKFLOW_RPC_STATUS_ROWS bounds the compact list at 4 of the 5 runs.
    expect(widget).toContain("Showing 4 newest of 5 workflow run(s).");
    expect(widget).toContain("+1 older run(s) hidden");
    expect(widget).toContain("20260725-101010-98c5");
  });

  it("renders one run's journal detail newest-first with its run directory", async () => {
    const root = makeRoot();
    writeRun(root, "20260726-212752-98cc");
    const widget = await runCommand(wideHarness(root), "status 20260726-212752-98cc");

    expect(widget).toContain("20260726-212752-98cc");
    expect(widget).toContain("[script] wrote findings");
    expect(widget).toContain("[agent] <- reviewer completed 1200ms");
    expect(widget).toContain("[phase] review");
    // The bounded widget wraps a long path across framed lines; the path itself
    // must survive intact once the frame and the wrapping are undone.
    const unwrapped = widget.replace(/[│╭╮╰╯─]/gu, "").replace(/\s+/gu, "");
    expect(unwrapped).toContain(`runDir:${workflowRunDir(root, "20260726-212752-98cc")}`);
    expect(unwrapped).toContain('result:{"summary":"reviewdone"}');
  });

  it("reports a run id that has no evidence on disk as not found", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "status 20260726-000000-zzzz");

    expect(widget).toContain("[WARN] Workflow run");
    expect(widget).toContain("Workflow run not found: 20260726-000000-zzzz");
    expect(widget).toContain("Recovery: /workflows status");
  });

  it("keeps passive detail total for malformed run ids without reading run evidence", () => {
    const root = makeRoot();
    const readJournal = vi.spyOn(workflowJournal, "readWorkflowRunJournalState");
    const readSummary = vi.spyOn(workflowJournal, "readWorkflowRunSummary");

    for (const selector of MALFORMED_RUN_SELECTORS) {
      const detail = buildRunDetailBlock(root, selector, true);
      expect(detail.type, selector).toBe("WARN");
    }
    expect(readJournal).not.toHaveBeenCalled();
    expect(readSummary).not.toHaveBeenCalled();
  });

  it("warns for malformed selectors on canonical passive commands before evidence reads", async () => {
    const readJournal = vi.spyOn(workflowJournal, "readWorkflowRunJournalState");
    const readSummary = vi.spyOn(workflowJournal, "readWorkflowRunSummary");

    for (const selector of MALFORMED_RUN_SELECTORS) {
      const harness = compactHarness(makeRoot());
      await harness.commands.get("workflows")!.handler(`status ${selector}`, harness.ctx);
      const widget = widgetOf(harness);
      expect(widget, selector).toContain("[WARN] Workflow run");
      expect(widget, selector).toContain("Workflow run not found:");
      expect(widget, selector).toContain("Recovery: /workflows status");
    }
    expect(readJournal).not.toHaveBeenCalled();
    expect(readSummary).not.toHaveBeenCalled();
  });

  it("warns before malformed selectors can enter a custom viewer or its static fallback", async () => {
    const readJournal = vi.spyOn(workflowJournal, "readWorkflowRunJournalState");
    const readSummary = vi.spyOn(workflowJournal, "readWorkflowRunSummary");

    for (const selector of MALFORMED_RUN_SELECTORS) {
      const harness = createHarness(makeRoot());
      harness.ctx.hasUI = true;
      const custom = vi.fn(async () => {
        throw new Error("custom renderer failed");
      }) as NonNullable<typeof harness.ctx.ui.custom>;
      harness.ctx.ui.custom = custom;
      workflows(harness.pi);
      await harness.commands.get("workflows")!.handler(`status ${selector}`, harness.ctx);
      const widget = widgetOf(harness);
      expect(widget, selector).toContain("[WARN] Workflow run");
      expect(widget, selector).toContain("Workflow run not found:");
      expect(custom, selector).not.toHaveBeenCalled();
    }
    expect(readJournal).not.toHaveBeenCalled();
    expect(readSummary).not.toHaveBeenCalled();
  });
});

describe("/workflows stop", () => {
  it("says nothing matched when no run answers the selector", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "stop 20260726-000000-zzzz");

    expect(widget).toContain("No active or recorded workflow matched 20260726-000000-zzzz.");
    expect(widget).toContain("Inspect durable runs: /workflows status");
    expect(widget).toContain("Stop the current run: /workflows stop last");
  });
});

describe("/workflows argument rejections", () => {
  it("rejects --run-name with no folder name after it", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --run-name");
    expect(widget).toContain("Missing folder name after --run-name.");
    expect(widget).toContain("No workflow execution was started.");
  });

  it("rejects --run-name together with --output-dir", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --run-name one --output-dir tmp/two");
    expect(widget).toContain("--run-name and --output-dir are mutually exclusive.");
    expect(widget).toContain("No workflow execution was started.");
  });

  it("rejects --output-dir with no project-relative path after it", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --output-dir");
    const unwrapped = widget.replace(/[│╭╮╰╯─]/gu, "").replace(/\s+/gu, " ");

    expect(widget).toContain("Missing project-relative path after --output-dir.");
    expect(unwrapped).toContain("Retry: /workflows run alpha --output-dir <path> [--resume <runId>] [--] [input]");
    expect(widget).toContain("No workflow execution was started.");
  });

  it("rejects --resume with no run id after it", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --resume");
    const unwrapped = widget.replace(/[│╭╮╰╯─]/gu, "").replace(/\s+/gu, " ");

    expect(widget).toContain("Missing run id after --resume.");
    expect(unwrapped).toContain(
      "Retry: /workflows run alpha [--run-name <name> | --output-dir <path>] --resume <runId> [--] [input]",
    );
    expect(widget).toContain("No workflow execution was started.");
  });

  it("preserves an accepted output workspace when the following resume id is missing", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --output-dir tmp/reviews/review-1 --resume");
    const unwrapped = widget.replace(/[│╭╮╰╯─]/gu, "").replace(/\s+/gu, " ");

    expect(unwrapped).toContain(
      "Retry: /workflows run alpha --output-dir tmp/reviews/review-1 --resume <runId> [--] [input]",
    );
  });

  it("preserves an accepted resume id when the following output workspace is missing", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --resume run-old --output-dir");
    const unwrapped = widget.replace(/[│╭╮╰╯─]/gu, "").replace(/\s+/gu, " ");

    expect(unwrapped).toContain("Retry: /workflows run alpha --output-dir <path> --resume run-old [--] [input]");
  });

  it("preserves an accepted duplicate outputDir on canonical recovery", async () => {
    const h = wideHarness(makeRoot());
    await h.commands.get("workflows")!.handler("run alpha --output-dir tmp/first --output-dir", h.ctx);
    const unwrapped = widgetOf(h)
      .replace(/[│╭╮╰╯─]/gu, "")
      .replace(/\s+/gu, " ");
    expect(unwrapped).toContain(
      "Retry: /workflows run alpha --output-dir tmp/first --output-dir <path> [--resume <runId>] [--] [input]",
    );
  });

  it("requires a source run id for a continuation", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "continue");

    expect(widget).toContain("Workflow continuation requires a source run id.");
    expect(widget).toContain("Retry: /workflows continue <runId> [--answer <text>]");
  });

  it("rejects --answer with no text after it", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "continue 20260726-212752-98cc --answer");

    expect(widget).toContain("Missing text after --answer.");
    expect(widget).toContain("Retry: /workflows continue <runId> --answer <text>");
  });

  it("says so when a named continuation has no actionable handoff", async () => {
    const root = makeRoot();
    writeRun(root, "20260726-212752-98cc");
    const widget = await runCommand(wideHarness(root), "continue 20260726-212752-98cc --answer yes");

    expect(widget).toContain("No actionable workflow handoff was found for 20260726-212752-98cc.");
    expect(widget).toContain("Inspect durable evidence: /workflows status <runId>");
  });
});
