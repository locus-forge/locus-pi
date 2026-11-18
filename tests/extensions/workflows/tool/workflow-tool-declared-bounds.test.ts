import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  registerWorkflowTool,
  workflowConfirmationDetails,
  WORKFLOW_LAUNCH_CONFIRM_TIMEOUT_MS,
} from "../../../../extensions/workflows/tool/workflow-tool.js";
import {
  resolveWorkflowTarget,
  type ResolvedWorkflowTarget,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import { sha256WorkflowBytes } from "../../../../extensions/workflows/runtime/workflow-script-identity.js";
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
const CATALOG_SELECTION_ID = "00000000-0000-4000-8000-000000000001";

function typedConfirmationHarness(mode: "tui" | "rpc" | "json" = "tui") {
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

function catalogSelectionHarness(
  root: string,
  selection: { target: ResolvedWorkflowTarget; scriptSha256: string },
): Harness {
  const harness = createHarness(root);
  registerWorkflowTool(harness.pi, {
    commandLauncher: IDLE_LAUNCHER,
    resolveCatalogLaunchSelection: ({ catalogSelectionId, name }) =>
      catalogSelectionId === CATALOG_SELECTION_ID && name === selection.target.ref
        ? { status: "selected", ...selection }
        : { status: "invalid", message: "catalog selection mismatch" },
    onRunStarted: () => {},
    onRunCompleted: () => {},
  });
  return harness;
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
    expect(harness.confirmCalls[0]?.opts).toMatchObject({ timeout: WORKFLOW_LAUNCH_CONFIRM_TIMEOUT_MS });
    expect(harness.confirmCalls[0]?.opts?.signal).toBeInstanceOf(AbortSignal);
    expect(result.isError).toBe(true);
    expect(result).toMatchObject({ details: { status: "cancelled" } });
  });

  it("stops when the parent aborts during confirmation even if the dialog later says Yes", async () => {
    const { harness } = typedConfirmationHarness();
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    vi.spyOn(harness.ctx.ui, "confirm").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const run = vi.spyOn(runner, "runWorkflowScript");
    const controller = new AbortController();

    const pending = harness.tools
      .get("workflow")!
      .execute(
        "aborted",
        { name: "typed", inputValue: { mode: "safe" } },
        controller.signal,
        () => void 0,
        harness.ctx,
      );
    controller.abort(new Error("parent stopped"));
    resolveConfirmation?.(true);
    const result = await pending;

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, details: { cancellationReason: "aborted" } });
  });

  it("bounds an unanswered RPC confirmation and fails closed", async () => {
    vi.useFakeTimers();
    try {
      const { harness } = typedConfirmationHarness("rpc");
      vi.spyOn(harness.ctx.ui, "confirm").mockImplementation(
        (_title, _message, opts) => new Promise<boolean>(() => void opts),
      );
      const run = vi.spyOn(runner, "runWorkflowScript");
      const pending = harness.tools
        .get("workflow")!
        .execute(
          "timed-out",
          { name: "typed", inputValue: { mode: "safe" } },
          new AbortController().signal,
          () => void 0,
          harness.ctx,
        );

      await vi.advanceTimersByTimeAsync(WORKFLOW_LAUNCH_CONFIRM_TIMEOUT_MS);
      const result = await pending;
      expect(run).not.toHaveBeenCalled();
      expect(result).toMatchObject({ isError: true, details: { cancellationReason: "timed-out" } });
    } finally {
      vi.useRealTimers();
    }
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

  it("detaches every launch argument before awaiting confirmation", async () => {
    const { root, harness } = typedConfirmationHarness();
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    vi.spyOn(harness.ctx.ui, "confirm").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const run = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(completedRun(root));
    const args = {
      name: "typed",
      inputValue: { mode: "safe" },
      items: ["first"],
      budget: { turns: 1 },
    };

    const pending = harness.tools
      .get("workflow")!
      .execute("detached", args, new AbortController().signal, () => void 0, harness.ctx);
    args.name = "other";
    args.items.push("late");
    args.budget.turns = 9;
    resolveConfirmation?.(true);
    await pending;

    expect(run.mock.calls[0]?.[0]).toMatchObject({
      name: "typed",
      items: ["first"],
      budget: { turns: 1 },
    });
  });

  it("refuses ordinary interactive entry-byte drift during confirmation before import", async () => {
    const { root, harness } = typedConfirmationHarness();
    const sourcePath = path.join(root, ".locus-pi", "workflows", "typed.workflow.mjs");
    const marker = path.join(root, "imported.txt");
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    vi.spyOn(harness.ctx.ui, "confirm").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );

    const pending = harness.tools
      .get("workflow")!
      .execute(
        "ordinary-drift",
        { name: "typed", inputValue: { mode: "safe" } },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );
    expect(harness.confirmCalls).toHaveLength(0);
    writeFileSync(
      sourcePath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export const meta={inputSchema:{type:"object",properties:{mode:{type:"string"}},required:["mode"]}}; export default()=>"changed";\n`,
    );
    resolveConfirmation?.(true);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("source changed after confirmation or catalog selection"),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses new precedence that appears while an ordinary confirmation is open", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-tool-direct-shadow-"));
    confirmationRoots.push(root);
    const harness = createHarness(root);
    workflows(harness.pi);
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    vi.spyOn(harness.ctx.ui, "confirm").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );

    const pending = harness.tools
      .get("workflow")!
      .execute("direct-shadow", { name: "live-smoke" }, new AbortController().signal, () => void 0, harness.ctx);
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    const marker = path.join(root, "shadow-imported.txt");
    writeFileSync(
      path.join(workflowDir, "live-smoke.workflow.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export default()=>"shadow";\n`,
    );
    resolveConfirmation?.(true);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("target binding no longer matches") });
    expect(existsSync(marker)).toBe(false);
  });

  it("previews the effective project-relative workspace and bound source identity", async () => {
    const { root, harness } = typedConfirmationHarness();
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    harness.ctx.session!.workingDirectory = nested;
    harness.confirmQueue.push(false);

    await harness.tools
      .get("workflow")!
      .execute(
        "workspace-preview",
        { name: "typed", inputValue: { mode: "safe" }, workspaceDir: "./review" },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

    const message = harness.confirmCalls[0]?.message ?? "";
    expect(message).toContain("Workflow workspace: nested/review");
    expect(message).toContain("Source: .locus-pi/workflows/typed.workflow.mjs");
    expect(message).toMatch(/Entry SHA-256: [a-f0-9]{64}/u);
    expect(message).not.toContain("Workflow workspace: ./review");
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

  it("refuses project shadowing of the catalog-selected Package target before confirmation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-tool-catalog-shadow-"));
    confirmationRoots.push(root);
    const selectedTarget = resolveWorkflowTarget({ name: "post-code-review" }, root, root);
    expect(selectedTarget.source).toBe("package");
    const selection = {
      target: selectedTarget,
      scriptSha256: sha256WorkflowBytes(readFileSync(selectedTarget.path)),
    };
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "post-code-review.workflow.mjs"), 'export default () => "shadow";\n');
    const harness = catalogSelectionHarness(root, selection);

    const result = await runTool(harness, "workflow", {
      name: "post-code-review",
      catalogSelectionId: CATALOG_SELECTION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("binding no longer matches") });
    expect(harness.confirmCalls).toEqual([]);
  });

  it("refuses changed selected entry bytes before confirmation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-tool-catalog-bytes-"));
    confirmationRoots.push(root);
    const workflowDir = path.join(root, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    const sourcePath = path.join(workflowDir, "typed.workflow.mjs");
    writeFileSync(sourcePath, 'export default () => "selected";\n');
    const selectedTarget = resolveWorkflowTarget({ name: "typed" }, root, root);
    const selection = {
      target: selectedTarget,
      scriptSha256: sha256WorkflowBytes(readFileSync(sourcePath)),
    };
    writeFileSync(sourcePath, 'export default () => "changed";\n');
    const harness = catalogSelectionHarness(root, selection);

    const result = await runTool(harness, "workflow", { name: "typed", catalogSelectionId: CATALOG_SELECTION_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("entry bytes changed") });
    expect(harness.confirmCalls).toEqual([]);
  });
});
