import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  registerWorkflowTool,
  workflowConfirmationDetails,
} from "../../../../extensions/workflows/tool/workflow-tool.js";
import type { WorkflowCommandLauncher } from "../../../../extensions/workflows/launch/workflow-command-launcher.js";
import { createHarness, runTool, type Harness } from "../../../test-harness.js";

/**
 * What the `workflow` tool's own schema still declares, and what it no longer does.
 *
 * Two claims, both about the tool surface rather than the runtime: a removed budget
 * option is answered by NAME, and a continuation carries as many complete artifact
 * refs as its origin run produced.
 *
 * A removed budget option, answered by NAME at the tool surface.
 *
 * The runtime has one sentence per removed key saying what replaced it. The tool
 * schema is a second door into the same object and its key set is closed, so
 * `budget: { answerChars: 4000 }` used to come back as "unexpected property
 * answerChars" — true, and useless to the caller, who is left believing the option
 * exists but was mistyped. Both doors now give the same sentence.
 */

/** The refusal returns before anything is launched, so the launcher is never used. */
const IDLE_LAUNCHER = {
  currentLease: () => ({}) as never,
  attach: () => {
    throw new Error("no run should be launched by a refused call");
  },
} as unknown as WorkflowCommandLauncher;

function toolHarness(): Harness {
  const h = createHarness(mkdtempSync(path.join(tmpdir(), "workflow-tool-removed-budget-")));
  registerWorkflowTool(h.pi, {
    commandLauncher: IDLE_LAUNCHER,
    onRunStarted: () => {},
    onRunCompleted: () => {},
  });
  return h;
}

describe("workflow tool: removed budget options", () => {
  it("shows only declared budget overrides before the host policy is resolved", () => {
    const details = workflowConfirmationDetails({ name: "live-smoke", budget: { turns: 7 } }, process.cwd());
    expect(details).toContain("Budget overrides: turns=7; other axes use launch defaults");
    expect(String(details)).not.toContain("totalAgents=unbounded");
  });

  it("names answerChars and the contract to declare instead", async () => {
    const result = await runTool(toolHarness(), "workflow", {
      name: "any",
      budget: { answerChars: 4_000 },
    });

    const text = result.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("answerChars was removed");
    expect(text).toContain("no longer bounds the SIZE of an answer");
    expect(text).toContain("length requirement in the stage prompt");
    // Not the schema's generic complaint.
    expect(text).not.toMatch(/unexpected|additional propert/iu);
  });

  it("names a renamed option with its replacement axis", async () => {
    const result = await runTool(toolHarness(), "workflow", {
      name: "any",
      budget: { maxTotalAgentInvocations: 10 },
    });

    const text = result.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("maxTotalAgentInvocations was removed");
    expect(text).toContain("budget.totalAgents");
  });

  it("leaves a live axis alone, so the check is about removed keys and nothing else", async () => {
    // Two targets is the NEXT refusal on this path. Reaching it proves the budget
    // check passed a declared axis through instead of swallowing the call.
    const result = await runTool(toolHarness(), "workflow", {
      name: "any",
      scriptPath: "also/here.workflow.mjs",
      budget: { totalAgents: 10 },
    });

    const text = result.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(text).toContain("exactly one of name, scriptPath, or script");
  });
});

describe("workflow tool: continuation artifact refs", () => {
  it("accepts more than the eight refs the schema used to cap, and still demands one", async () => {
    const refs = Array.from({ length: 13 }, (_, index) => ({
      runId: "20260912-090000-origin",
      artifactId: `artifact-${String(index + 1).padStart(2, "0")}`,
      name: `note-${index + 1}.md`,
      sha256: String(index + 1)
        .repeat(64)
        .slice(0, 64),
    }));

    // Two targets is the NEXT refusal on this path. Reaching it proves all thirteen
    // refs passed the schema: a `maxItems` would have refused before it.
    const accepted = await runTool(toolHarness(), "workflow", {
      name: "any",
      scriptPath: "also/here.workflow.mjs",
      continuation: { originRunId: "20260912-090000-origin", artifactRefs: refs },
    });
    const acceptedText = accepted.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(acceptedText).toContain("exactly one of name, scriptPath, or script");

    // The lower bound is a real contract and stays: a continuation with no reference
    // continues nothing.
    const empty = await runTool(toolHarness(), "workflow", {
      name: "any",
      continuation: { originRunId: "20260912-090000-origin", artifactRefs: [] },
    });
    expect(empty.isError).toBe(true);
  });
});

const confirmationRoots: string[] = [];

function typedConfirmationHarness(mode: "tui" | "json" = "tui") {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-tool-confirmation-"));
  confirmationRoots.push(root);
  const workflowDir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    path.join(workflowDir, "typed.workflow.mjs"),
    'export const meta={inputSchema:{type:"object",properties:{count:{type:"integer"},mode:{type:"string"}},required:["mode"],additionalProperties:false}}; export default () => "ok";\n',
  );
  const harness = createHarness(root, { mode });
  workflows(harness.pi);
  return { root, harness };
}

function completedRun(root: string) {
  return {
    runId: "confirmed-run",
    runDir: path.join(root, ".locus-pi", "runs", "confirmed-run"),
    ok: true,
    result: "ok",
    disposition: { status: "completed" as const },
    journal: [],
    resultPersistence: { ok: true as const, path: path.join(root, "result.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of confirmationRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow tool interactive confirmation", () => {
  it("shows canonical typed input and stops before the runner when declined", async () => {
    const { harness } = typedConfirmationHarness();
    harness.confirmQueue.push(false);
    const run = vi.spyOn(runner, "runWorkflowScript");

    const result = await harness.tools
      .get("workflow")!
      .execute(
        "declined",
        { name: "typed", inputValue: { mode: "safe", count: 2 } },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

    expect(run).not.toHaveBeenCalled();
    expect(harness.confirmCalls).toHaveLength(1);
    expect(harness.confirmCalls[0]).toMatchObject({ title: 'Run trusted workflow "typed"?' });
    expect(harness.confirmCalls[0]?.message).toContain('Input (JSON): {"count":2,"mode":"safe"}');
    expect(result).toMatchObject({ details: { status: "cancelled" } });
  });

  it("launches the exact confirmed snapshot", async () => {
    const { root, harness } = typedConfirmationHarness();
    const run = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(completedRun(root));

    const result = await harness.tools
      .get("workflow")!
      .execute(
        "confirmed",
        { name: "typed", inputValue: { mode: "safe", count: 2 } },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

    expect(harness.confirmCalls).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      name: "typed",
      inputValue: { count: 2, mode: "safe" },
    });
    expect(result.isError).not.toBe(true);
  });

  it("fails closed when interactive confirmation cannot open", async () => {
    const { harness } = typedConfirmationHarness();
    vi.spyOn(harness.ctx.ui, "confirm").mockRejectedValue(new Error("dialog unavailable"));
    const run = vi.spyOn(runner, "runWorkflowScript");

    const result = await harness.tools
      .get("workflow")!
      .execute(
        "unavailable",
        { name: "typed", inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

    expect(run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("dialog unavailable") });
  });

  it("keeps explicitly authorized one-shot JSON execution headless", async () => {
    const { root, harness } = typedConfirmationHarness("json");
    const run = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(completedRun(root));

    await harness.tools
      .get("workflow")!
      .execute(
        "headless",
        { name: "typed", inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

    expect(harness.confirmCalls).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
