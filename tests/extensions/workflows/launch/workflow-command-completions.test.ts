import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  workflowArgumentCompletions,
  workflowFlatCommandCompletions,
} from "../../../../extensions/workflows/launch/command-completions.js";
import workflows from "../../../../extensions/workflows/index.js";
import { WorkflowOperatorHandoffController } from "../../../../extensions/workflows/operator/operator-handoff-controller.js";
import * as workflowJournal from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness, emit } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-completions-"));
  roots.push(root);
  const workflowsDir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    path.join(workflowsDir, "alpha.workflow.mjs"),
    'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>null;\n',
    "utf8",
  );
  writeFileSync(
    path.join(workflowsDir, "alpha workflow.workflow.mjs"),
    'export const meta={name:"alpha workflow",description:"Quoted workflow"}; export default async()=>null;\n',
    "utf8",
  );
  writeFileSync(
    path.join(workflowsDir, ".alpha.workflow.mjs"),
    'export const meta={name:".alpha",description:"Dot workflow"}; export default async()=>null;\n',
    "utf8",
  );
  for (const runId of ["20260724-120000-old", "20260724-130000-new"]) {
    const runDir = ensureWorkflowRunDir(root, runId);
    writeFileSync(workflowResultFile(runDir), JSON.stringify({ runId, ok: true, result: null, journal: [] }), "utf8");
  }
  return root;
}

describe("workflow command argument completion", () => {
  it("keeps ordinary command typing off the persisted handoff scan", async () => {
    const root = project();
    const persistedRunIds = vi.spyOn(workflowJournal, "listWorkflowRootRunIds");
    const eligibleRunIds = vi
      .spyOn(WorkflowOperatorHandoffController.prototype, "eligibleRunIds")
      .mockReturnValue(["20260724-130000-new"]);
    const harness = createHarness(root);
    harness.ctx.cwd = root;
    workflows(harness.pi);
    await emit(harness, "session_start");
    const complete = harness.commands.get("workflows")?.getArgumentCompletions;
    expect(complete).toBeTypeOf("function");
    if (complete === undefined) throw new Error("expected workflow argument completion");

    complete("");
    complete("r");
    complete("run a");
    complete("info a");
    expect(eligibleRunIds).not.toHaveBeenCalled();
    expect(persistedRunIds).not.toHaveBeenCalled();

    complete("stop ");
    expect(persistedRunIds).toHaveBeenCalledOnce();

    expect(complete("continue ")).toContainEqual(expect.objectContaining({ value: "continue 20260724-130000-new" }));
    expect(eligibleRunIds).toHaveBeenCalledOnce();
  });

  it("offers the complete root command vocabulary, including result and continue", () => {
    const root = project();
    const labels = workflowArgumentCompletions("", root, root)?.map(
      (completion) => completion.label ?? completion.value,
    );

    expect(labels).toEqual(["dashboard", "list", "info", "status", "result", "run", "continue", "stop", "skills"]);
  });

  it("returns full argument strings for grammar-owned tokens and yields free text and paths", async () => {
    const root = project();
    const storageRootRunId = "20260724-130000-new";
    const childId = "20260724-140000-child";
    const attemptId = "20260724-150000-attempt";
    for (const [runId, kind] of [
      [childId, "child"],
      [attemptId, "attempt"],
    ] as const) {
      const runDir = ensureWorkflowRunDir(root, runId, { storageRootRunId, kind });
      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({
          runId,
          storageRootRunId,
          ok: true,
          journal: [{ ts: `2026-07-24T${kind === "child" ? "14" : "15"}:00:00.000Z` }],
        }),
        "utf8",
      );
    }
    const harness = createHarness(root);
    harness.ctx.cwd = root;
    workflows(harness.pi);
    await emit(harness, "session_start");
    const complete = harness.commands.get("workflows")?.getArgumentCompletions;
    expect(complete).toBeTypeOf("function");
    if (complete === undefined) throw new Error("expected workflow argument completion");

    expect(complete("st")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "status " }),
        expect.objectContaining({ value: "stop " }),
      ]),
    );
    expect(complete("run a")).toContainEqual(expect.objectContaining({ value: "run alpha", label: "alpha" }));
    expect(complete("info a")).toContainEqual(expect.objectContaining({ value: "info alpha", label: "alpha" }));
    expect(complete("status 20260724-13")).toContainEqual(
      expect.objectContaining({ value: "status 20260724-130000-new" }),
    );
    expect(complete("stop ")).toContainEqual(expect.objectContaining({ value: "stop last" }));
    expect(complete("stop ")).toContainEqual(expect.objectContaining({ value: `stop ${attemptId}` }));
    expect(complete("stop ")).not.toContainEqual(expect.objectContaining({ value: `stop ${childId}` }));
    expect(complete("run alpha ")).toEqual([
      expect.objectContaining({ value: "run alpha --run-name ", label: "--run-name" }),
      expect.objectContaining({ value: "run alpha --output-dir ", label: "--output-dir" }),
      expect.objectContaining({ value: "run alpha --resume ", label: "--resume" }),
      expect.objectContaining({ value: "run alpha -- ", label: "--" }),
    ]);
    expect(complete("run task/draft ")).toContainEqual(
      expect.objectContaining({ value: "run task/draft --run-name ", label: "--run-name" }),
    );
    expect(complete('run "alpha workflow" ')).toEqual([
      expect.objectContaining({ value: 'run "alpha workflow" --run-name ', label: "--run-name" }),
      expect.objectContaining({ value: 'run "alpha workflow" --output-dir ', label: "--output-dir" }),
      expect.objectContaining({ value: 'run "alpha workflow" --resume ', label: "--resume" }),
      expect.objectContaining({ value: 'run "alpha workflow" -- ', label: "--" }),
    ]);
    expect(complete("run alpha --out")).toEqual([
      expect.objectContaining({ value: "run alpha --output-dir ", label: "--output-dir" }),
    ]);
    expect(complete("run alpha -")).toEqual([
      expect.objectContaining({ value: "run alpha --run-name ", label: "--run-name" }),
      expect.objectContaining({ value: "run alpha --output-dir ", label: "--output-dir" }),
      expect.objectContaining({ value: "run alpha --resume ", label: "--resume" }),
      expect.objectContaining({ value: "run alpha -- ", label: "--" }),
    ]);
    expect(complete("run alpha --")).toBeNull();
    expect(complete("run alpha --res")).toEqual([
      expect.objectContaining({ value: "run alpha --resume ", label: "--resume" }),
    ]);
    expect(complete("run alpha --output-dir ")).toBeNull();
    expect(complete("run alpha --output-dir tmp/review ")).toEqual([
      expect.objectContaining({ value: "run alpha --output-dir tmp/review --output-dir ", label: "--output-dir" }),
      expect.objectContaining({ value: "run alpha --output-dir tmp/review --resume ", label: "--resume" }),
      expect.objectContaining({ value: "run alpha --output-dir tmp/review -- ", label: "--" }),
    ]);
    expect(complete("run alpha --output-dir tmp/review --res")).toEqual([
      expect.objectContaining({ value: "run alpha --output-dir tmp/review --resume ", label: "--resume" }),
    ]);
    expect(complete('run alpha --output-dir "tmp/review 1" ')).toEqual([
      expect.objectContaining({
        value: 'run alpha --output-dir "tmp/review 1" --output-dir ',
        label: "--output-dir",
      }),
      expect.objectContaining({ value: 'run alpha --output-dir "tmp/review 1" --resume ', label: "--resume" }),
      expect.objectContaining({ value: 'run alpha --output-dir "tmp/review 1" -- ', label: "--" }),
    ]);
    expect(complete('run alpha --output-dir "tmp/review 1" --res')).toEqual([
      expect.objectContaining({ value: 'run alpha --output-dir "tmp/review 1" --resume ', label: "--resume" }),
    ]);
    expect(complete("run alpha --resume 20260724-130000-new --resume ")).toContainEqual(
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --resume 20260724-130000-new",
        label: "20260724-130000-new",
      }),
    );
    expect(complete('run alpha --output-dir "tmp/review 1" --output-dir ')).toBeNull();
    expect(complete("run alpha --output-dir tmp/review --resume 20260724-13")).toContainEqual(
      expect.objectContaining({
        value: "run alpha --output-dir tmp/review --resume 20260724-130000-new",
      }),
    );
    expect(complete("run alpha --resume 20260724-13")).toContainEqual(
      expect.objectContaining({ value: "run alpha --resume 20260724-130000-new" }),
    );
    expect(complete("run alpha --resume 20260724-130000-new ")).toEqual([
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --run-name ",
        label: "--run-name",
      }),
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --output-dir ",
        label: "--output-dir",
      }),
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --resume ",
        label: "--resume",
      }),
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new -- ",
        label: "--",
      }),
    ]);
    expect(complete("run alpha --resume 20260724-130000-new --output-dir ")).toBeNull();
    expect(complete("run alpha --resume 20260724-130000-new --output-dir tmp/review ")).toEqual([
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --output-dir tmp/review --output-dir ",
        label: "--output-dir",
      }),
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --output-dir tmp/review --resume ",
        label: "--resume",
      }),
      expect.objectContaining({
        value: "run alpha --resume 20260724-130000-new --output-dir tmp/review -- ",
        label: "--",
      }),
    ]);
    expect(complete("run alpha --resume 20260724-120000-old --resume 20260724-13")).toContainEqual(
      expect.objectContaining({
        value: "run alpha --resume 20260724-120000-old --resume 20260724-130000-new",
      }),
    );
    expect(complete("run alpha review current changes")).toBeNull();
    expect(complete("run alpha -- --resume literal input")).toBeNull();
    expect(complete("run alpha -- ")).toBeNull();
    expect(complete("run ./local.workflow.mjs")).toBeNull();
    expect(complete("list auth")).toBeNull();
    expect(complete("skills ")).toEqual([
      expect.objectContaining({ value: "skills sync ", label: "sync" }),
      expect.objectContaining({ value: "skills status ", label: "status" }),
      expect.objectContaining({ value: "skills remove ", label: "remove" }),
    ]);
    expect(complete("skills sync ")).toEqual([
      expect.objectContaining({ value: "skills sync --host ", label: "--host" }),
      expect.objectContaining({ value: "skills sync --scope ", label: "--scope" }),
    ]);
    expect(complete("skills sync --host ")).toContainEqual(
      expect.objectContaining({ value: "skills sync --host all ", label: "all" }),
    );
    expect(complete("unknown tail")).toBeNull();
  });

  it("keeps the exported provider structurally usable without a live Pi context", () => {
    const root = project();
    expect(workflowArgumentCompletions("run a", root, root)).toContainEqual(
      expect.objectContaining({ value: "run alpha" }),
    );
  });

  it("offers only canonical saved names and round-trips interior whitespace as one token", () => {
    const root = project();
    const workflowsDir = path.join(root, ".locus-pi", "workflows");
    const invalidNames = [
      " alpha",
      "alpha ",
      "alpha\u0001control",
      String.raw`alpha\beta`,
      "alpha.mjs",
      "a".repeat(201),
    ];
    for (const name of invalidNames) {
      writeFileSync(path.join(workflowsDir, `${name}.workflow.mjs`), "export default () => null;\n", "utf8");
    }

    const canonicalRun = workflowArgumentCompletions("run ", root, root) ?? [];
    expect(canonicalRun).toContainEqual({ value: 'run "alpha workflow"', label: "alpha workflow" });
    expect(workflowArgumentCompletions("run a", root, root)).toContainEqual({
      value: 'run "alpha workflow"',
      label: "alpha workflow",
    });
    expect(workflowArgumentCompletions('run "alpha w', root, root)).toContainEqual({
      value: 'run "alpha workflow"',
      label: "alpha workflow",
    });
    expect(workflowArgumentCompletions("info a", root, root)).toContainEqual({
      value: 'info "alpha workflow"',
      label: "alpha workflow",
    });
    expect(workflowArgumentCompletions("run .", root, root)).toContainEqual({
      value: "run .alpha",
      label: ".alpha",
    });
    expect(workflowFlatCommandCompletions("run", "", root, root)).toContainEqual({
      value: '"alpha workflow"',
      label: "alpha workflow",
    });
    for (const name of invalidNames) {
      expect(
        canonicalRun.map((completion) => completion.label),
        name,
      ).not.toContain(name);
    }
  });

  it("registers only the stop compatibility command with native argument completions", async () => {
    const root = project();
    const harness = createHarness(root);
    workflows(harness.pi);
    await emit(harness, "session_start");

    expect(harness.commands.has("workflows")).toBe(true);
    for (const name of [
      "workflow-run",
      "workflow-list",
      "workflow-info",
      "workflow-status",
      "workflow-result",
      "workflow-continue",
    ])
      expect(harness.commands.has(name), name).toBe(false);
    expect(harness.commands.get("workflow-stop")?.getArgumentCompletions?.("")).toContainEqual(
      expect.objectContaining({ value: "last", label: "last" }),
    );
  });

  it("keeps flat completion values scoped to the command argument buffer", () => {
    const root = project();
    expect(workflowFlatCommandCompletions("run", "a", root, root)).toContainEqual(
      expect.objectContaining({ value: "alpha", label: "alpha" }),
    );
    expect(workflowFlatCommandCompletions("run", "alpha --output-dir tmp/review ", root, root)).toEqual([
      expect.objectContaining({ value: "alpha --output-dir tmp/review --output-dir ", label: "--output-dir" }),
      expect.objectContaining({ value: "alpha --output-dir tmp/review --resume ", label: "--resume" }),
      expect.objectContaining({ value: "alpha --output-dir tmp/review -- ", label: "--" }),
    ]);
    expect(workflowFlatCommandCompletions("run", 'alpha --output-dir "tmp/review 1" ', root, root)).toEqual([
      expect.objectContaining({ value: 'alpha --output-dir "tmp/review 1" --output-dir ', label: "--output-dir" }),
      expect.objectContaining({ value: 'alpha --output-dir "tmp/review 1" --resume ', label: "--resume" }),
      expect.objectContaining({ value: 'alpha --output-dir "tmp/review 1" -- ', label: "--" }),
    ]);
    expect(workflowFlatCommandCompletions("run", 'alpha --output-dir "tmp/review 1" --res', root, root)).toEqual([
      expect.objectContaining({ value: 'alpha --output-dir "tmp/review 1" --resume ', label: "--resume" }),
    ]);
    expect(workflowFlatCommandCompletions("run", "alpha -", root, root)).toEqual([
      expect.objectContaining({ value: "alpha --run-name ", label: "--run-name" }),
      expect.objectContaining({ value: "alpha --output-dir ", label: "--output-dir" }),
      expect.objectContaining({ value: "alpha --resume ", label: "--resume" }),
      expect.objectContaining({ value: "alpha -- ", label: "--" }),
    ]);
    expect(workflowFlatCommandCompletions("run", "alpha --", root, root)).toBeNull();
    expect(workflowFlatCommandCompletions("run", "alpha --resume 20260724-130000-new ", root, root)).toEqual([
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --run-name ",
        label: "--run-name",
      }),
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --output-dir ",
        label: "--output-dir",
      }),
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --resume ",
        label: "--resume",
      }),
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new -- ",
        label: "--",
      }),
    ]);
    expect(
      workflowFlatCommandCompletions("run", "alpha --resume 20260724-120000-old --resume 20260724-13", root, root),
    ).toContainEqual(
      expect.objectContaining({
        value: "alpha --resume 20260724-120000-old --resume 20260724-130000-new",
      }),
    );
    expect(
      workflowFlatCommandCompletions("run", "alpha --resume 20260724-130000-new --resume ", root, root),
    ).toContainEqual(
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --resume 20260724-130000-new",
        label: "20260724-130000-new",
      }),
    );
    expect(
      workflowFlatCommandCompletions("run", "alpha --resume 20260724-130000-new --output-dir tmp/review ", root, root),
    ).toEqual([
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --output-dir tmp/review --output-dir ",
        label: "--output-dir",
      }),
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --output-dir tmp/review --resume ",
        label: "--resume",
      }),
      expect.objectContaining({
        value: "alpha --resume 20260724-130000-new --output-dir tmp/review -- ",
        label: "--",
      }),
    ]);
    expect(workflowFlatCommandCompletions("info", "a", root, root)).toContainEqual(
      expect.objectContaining({ value: "alpha", label: "alpha" }),
    );
    expect(workflowFlatCommandCompletions("result", "20260724-130000-new", root, root)).toContainEqual(
      expect.objectContaining({ value: "20260724-130000-new" }),
    );
    expect(workflowFlatCommandCompletions("continue", "20260724-130000-new ", root, root)).toEqual([
      expect.objectContaining({ value: "20260724-130000-new --answer ", label: "--answer" }),
    ]);
  });
});
