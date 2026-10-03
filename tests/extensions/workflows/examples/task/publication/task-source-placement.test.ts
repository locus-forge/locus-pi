import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentExecutor,
  AgentRunRequest,
} from "../../../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR } from "../../../../../../extensions/workflows/runtime/location-state/workflow-child-task.js";
import { runWorkflowScript } from "../../../../../../extensions/workflows/runtime/workflow-runner.js";
import { checkWorkflowSourceText } from "../../../../../../extensions/workflows/tool/workflow-source-check-tool.js";
import { createHarness } from "../../../../../test-harness.js";

const roots: string[] = [];
const source =
  'export const meta = { name: "generated", profile: "standard" };\nexport default function run(dsl) { return dsl.publishPrimaryArtifact("answer.md", "deliverable"); }\n';
const correctedSource = source.replace("deliverable", "corrected deliverable");
type Variant = "plan" | "plan-light";
type Scenario = "valid" | "repair" | "missing" | "misplaced";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Scripted children obey the authored placement rule, including its old contradictory workspace form. */
function declaredSource(task: string) {
  const boundary = task.indexOf(WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR);
  expect(boundary).toBeGreaterThan(0);
  const note = task.slice(0, boundary);
  const prompt = task.slice(boundary + WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR.length);
  const bound = /^workflow directory \(handoffs under artifacts\/, final files\): (.+)$/mu.exec(note)?.[1];
  const workspace = /^workflow workspace \(handoffs and intermediate files\): (.+)$/mu.exec(note)?.[1] ?? bound;
  const output = /^workflow output \(final deliverables\): (.+)$/mu.exec(note)?.[1] ?? bound;
  expect(workspace).toBeDefined();
  expect(output).toBeDefined();
  let base: string;
  if (prompt.includes("workflow.mjs in the workflow output directory")) base = output!;
  else if (prompt.includes("workspace workflow.mjs")) base = workspace!;
  else throw new Error("No explicit source placement instruction");
  return { workspace: workspace!, output: output!, source: path.join(base, "workflow.mjs") };
}

function fixture(variant: Variant, scenario: Scenario = "valid", bound = false) {
  const root = mkdtempSync(path.join(tmpdir(), "task-source-placement-"));
  roots.push(root);
  let file = path.resolve(`examples/workflows/task/${variant}.workflow.mjs`);
  let module = readFileSync(file, "utf8");
  if (bound) {
    // Default cases use the actual Package entry; only this metadata variant needs a local copy.
    module = module.replace('profile: "standard",', 'profile: "standard", outputDir: ".local/proof",');
    file = path.join(root, ".locus-pi/workflows/task", `${variant}.workflow.mjs`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, module);
  }
  expect(checkWorkflowSourceText(module, "compatibility")).toEqual([]);
  execFileSync(process.execPath, ["--check", file]);
  const harness = createHarness(root);
  const edits: Array<{ label: string; path: string }> = [];
  const checks: Array<{ label: string; path: string; text: string }> = [];
  const locations: ReturnType<typeof declaredSource>[] = [];
  const routes: Record<string, string[]> =
    variant === "plan"
      ? { "workflow-review-route": scenario === "repair" ? ["revise", "accept"] : ["accept"] }
      : {
          "workflow-source-seed-route": scenario === "repair" ? ["failed"] : ["passed"],
          "workflow-source-seed-fix-route": ["passed"],
          "workflow-source-queue-route": ["work", "complete"],
          "workflow-source-check-route": ["passed"],
          "workflow-source-review-route": ["accept"],
          "workflow-source-final-check-route": ["passed"],
          "workflow-source-final-route": ["publish"],
        };
  const writers = new Set([
    "workflow-author",
    "workflow-revise",
    "workflow-source-seed",
    "workflow-source-seed-fix",
    "workflow-source-slice",
  ]);
  const inspectors = new Set([
    "workflow-review",
    "workflow-source-seed-check",
    "workflow-source-seed-fix-check",
    "workflow-source-cut",
    "workflow-source-queue-assessment",
    "workflow-source-check",
    "workflow-source-review",
    "workflow-source-final-check",
    "workflow-source-final-review",
  ]);
  const createExecutor: NonNullable<Parameters<typeof runWorkflowScript>[0]["createExecutor"]> = (
    options,
  ): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      const label = options.live?.label;
      if (!label) throw new Error("Expected a labeled task authoring child");
      let answer: string;
      if (request.responseAcceptance) {
        const queue = routes[label];
        if (!queue?.length) throw new Error(`Unscripted route: ${label}`);
        answer = JSON.stringify(queue.shift());
      } else {
        const location = declaredSource(request.task);
        locations.push(location);
        if (writers.has(label)) {
          const first = label === "workflow-author" || label === "workflow-source-seed";
          const omit = scenario === "missing" || (scenario === "repair" && first && variant === "plan-light");
          if (!omit) {
            // Misplacement is a deliberate producer fault, not a publication fallback.
            const target = scenario === "misplaced" ? path.join(location.workspace, "workflow.mjs") : location.source;
            writeFileSync(target, scenario === "repair" && !first ? correctedSource : source);
            edits.push({ label, path: target });
          }
        }
        if (inspectors.has(label) && existsSync(location.source)) {
          const text = readFileSync(location.source, "utf8");
          execFileSync(process.execPath, ["--check", location.source]);
          expect(checkWorkflowSourceText(text, "orchestration-only")).toEqual([]);
          checks.push({ label, path: location.source, text });
        }
        // Negative cases intentionally claim acceptance despite missing files, to exercise the host boundary.
        answer = existsSync(location.source) ? "Exact source inspected; checks passed." : "Source absent.";
        appendFileSync(path.join(location.workspace, "workflow-decision-log.md"), `${label}: ${answer}\n`);
      }
      return {
        status: "completed",
        agentName: request.agent?.name ?? "sub-agent",
        text: answer,
        reason: "scripted placement proof",
        diagnostics: [],
        lifecycleEntryIds: [],
        ...(request.responseAcceptance
          ? { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }
          : {}),
      };
    },
  });
  return {
    root,
    edits,
    checks,
    locations,
    run: () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: `task/${variant}`,
        input: "Accepted brief.",
        ...(bound ? {} : { workspaceDir: "proof" }),
        createExecutor,
      }),
  };
}

describe.each<Variant>(["plan", "plan-light"])("task/%s source placement through the real runner", (variant) => {
  it.each([false, true])("publishes the exact authored and checked file (bound output: %s)", async (bound) => {
    const f = fixture(variant, "valid", bound);
    const result = await f.run();
    expect(result.ok, result.error).toBe(true);
    const location = f.locations[0]!;
    expect(location.output).toBe(bound ? location.workspace : path.join(location.workspace, "outputs"));
    expect(f.edits.every((edit) => edit.path === location.source)).toBe(true);
    expect(f.checks.length).toBeGreaterThan(0);
    expect(f.checks.every((check) => check.path === location.source && check.text === source)).toBe(true);
    expect(result.primaryFile).toMatchObject({
      absolutePath: location.source,
      relativePath: "workflow.mjs",
      bytes: Buffer.byteLength(source),
    });
    expect(readFileSync(result.primaryFile!.absolutePath, "utf8")).toBe(source);
    expect(readFileSync(path.join(location.workspace, "workflow-decision-log.md"), "utf8")).toContain("checks passed");
    expect(existsSync(path.join(result.runDir, "outputs/workflow.mjs"))).toBe(false);
  });

  it("rechecks the corrected output source before publication", async () => {
    const f = fixture(variant, "repair");
    const result = await f.run();
    expect(result.ok, result.error).toBe(true);
    const editor = variant === "plan" ? "workflow-revise" : "workflow-source-seed-fix";
    const reviewer = variant === "plan" ? "workflow-review" : "workflow-source-seed-fix-check";
    expect(f.edits.some((edit) => edit.label === editor)).toBe(true);
    expect(f.checks.some((check) => check.label === reviewer && check.text === correctedSource)).toBe(true);
    expect(f.edits.every((edit) => edit.path === result.primaryFile!.absolutePath)).toBe(true);
    expect(readFileSync(result.primaryFile!.absolutePath, "utf8")).toBe(correctedSource);
  });

  it.each<Scenario>(["missing", "misplaced"])("fails without fallback for %s output source", async (scenario) => {
    const f = fixture(variant, scenario);
    const result = await f.run();
    const location = f.locations[0]!;
    expect(result.ok).toBe(false);
    expect(result.primaryFile).toBeUndefined();
    expect(result.error).toContain("ENOENT");
    expect(result.error).toContain(path.join(location.output, "workflow.mjs"));
    expect(existsSync(path.join(location.output, "workflow.mjs"))).toBe(false);
    if (scenario === "misplaced")
      expect(readFileSync(path.join(location.workspace, "workflow.mjs"), "utf8")).toBe(source);
  });
});
