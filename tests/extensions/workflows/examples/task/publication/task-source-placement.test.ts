import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentExecutor,
  AgentRunRequest,
} from "../../../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { runWorkflowScript } from "../../../../../../extensions/workflows/runtime/workflow-runner.js";
import { registerWorkflowSourceCheckTool } from "../../../../../../extensions/workflows/tool/workflow-source-check-tool.js";
import { createHarness, runTool } from "../../../../../test-harness.js";

const roots: string[] = [];
const source =
  'export const meta = { name: "generated", profile: "standard" };\nexport default function run({ publishPrimaryArtifact }) { return publishPrimaryArtifact("answer.md", "deliverable"); }\n';
const correctedSource = source.replace("deliverable", "corrected deliverable");
type Variant = "plan" | "plan-light";
type Scenario = "valid" | "repair" | "missing" | "misplaced" | "drift";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(variant: Variant, scenario: Scenario = "valid") {
  const root = mkdtempSync(path.join(tmpdir(), "task-explicit-source-"));
  roots.push(root);
  const authoring = path.join(root, "caller-assigned");
  const nativeWorkspace = path.join(root, "native-state");
  mkdirSync(authoring);
  mkdirSync(path.join(nativeWorkspace, "outputs"), { recursive: true });
  const assignedSource = path.join(authoring, "workflow.mjs");
  const log = path.join(authoring, "workflow-decision-log.md");
  const review = path.join(authoring, "workflow-review.md");
  const names = new Set(
    readFileSync(path.resolve(`examples/workflows/task/${variant}.workflow.mjs`), "utf8").match(
      /workflow[\w.-]*\.(?:md|mjs)/gu,
    ) ?? [],
  );
  const input = `Complete accepted product requirements. SENTINEL_RESTRICTION.\nExact file destinations:\n${[...names].map((name) => `${name}: ${path.join(authoring, name)}`).join("\n")}`;
  const harness = createHarness(root);
  registerWorkflowSourceCheckTool(harness.pi);
  const edits: Array<{ label: string; path: string }> = [];
  const checks: Array<{ label: string; path: string; sha256: unknown; failed: boolean }> = [];
  let failedCheck = false;
  let lastReviewedDigest: unknown;
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
    "workflow-source-check",
    "workflow-source-final-check",
    "workflow-source-final-review",
  ]);
  const routes: Record<string, string[]> = {
    "workflow-review-route": scenario === "repair" ? ["revise", "accept"] : ["accept"],
    "workflow-source-seed-route": scenario === "repair" ? ["failed"] : ["passed"],
    "workflow-source-seed-fix-route": ["passed"],
    "workflow-source-queue-route": ["work", "complete"],
    "workflow-source-check-route": ["passed"],
    "workflow-source-review-route": ["accept"],
    "workflow-source-final-check-route": ["passed"],
    "workflow-source-final-route": ["publish"],
  };
  const createExecutor: NonNullable<Parameters<typeof runWorkflowScript>[0]["createExecutor"]> = (
    options,
  ): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      const label = options.live?.label;
      if (!label) throw new Error("Expected labeled task authoring child");
      expect(request.workingDirectory ?? harness.ctx.cwd).toBe(root);
      expect(request.task).toContain(`pwd (actual execution directory): ${root}`);
      expect(request.task, label).toContain(input);
      expect(request.task).not.toContain("workflow output (final deliverables)");
      let answer: string;
      if (request.responseAcceptance) {
        const scripted = routes[label]?.shift();
        if (!scripted) throw new Error(`Unscripted route: ${label}`);
        const failedRoute = label === "workflow-review-route" ? "revise" : "failed";
        answer = JSON.stringify(failedCheck ? failedRoute : scripted);
        // Review exhaustion uses the same truthful failure route on every round.
        if (failedCheck && label === "workflow-review-route") routes[label]!.push("accept");
      } else {
        if (writers.has(label)) {
          expect(request.task).toMatch(/exact.*(?:assigned|destination)|assigned.*exact/isu);
          const first = label === "workflow-author" || label === "workflow-source-seed";
          const omit = scenario === "missing" || (scenario === "repair" && first && variant === "plan-light");
          if (!omit) {
            const target =
              scenario === "misplaced" ? path.join(nativeWorkspace, "outputs/workflow.mjs") : assignedSource;
            writeFileSync(target, scenario === "repair" && !first ? correctedSource : source);
            edits.push({ label, path: target });
          }
        }
        if (inspectors.has(label)) {
          const checked = await runTool(harness, "workflow_check_source", {
            path: path.relative(root, assignedSource),
            mode: "orchestration-only",
          });
          failedCheck = checked.isError === true;
          if (!failedCheck) execFileSync(process.execPath, ["--check", assignedSource]);
          lastReviewedDigest = checked.details?.sha256;
          checks.push({ label, path: assignedSource, sha256: lastReviewedDigest, failed: failedCheck });
          writeFileSync(
            review,
            JSON.stringify({ source: assignedSource, sha256: lastReviewedDigest, passed: !failedCheck }),
          );
        }
        answer = failedCheck
          ? `Failed exact source check: ${assignedSource}`
          : "Exact assigned file checked; source-free report.";
        appendFileSync(log, `${label}: ${answer}\n`);
      }
      if (
        scenario === "drift" &&
        ((variant === "plan" && label === "workflow-review-route") || label === "workflow-source-final-route")
      )
        writeFileSync(assignedSource, correctedSource);
      return {
        status: "completed",
        agentName: request.agent?.name ?? "sub-agent",
        text: answer,
        reason: "scripted ordinary file tools",
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
    assignedSource,
    nativeWorkspace,
    edits,
    checks,
    review,
    run: () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: `task/${variant}`,
        input,
        workspaceDir: "native-state",
        createExecutor,
      }),
    currentCheck: () =>
      runTool(harness, "workflow_check_source", {
        path: path.relative(root, assignedSource),
        mode: "orchestration-only",
      }),
    reviewedDigest: () => lastReviewedDigest,
  };
}

describe.each<Variant>(["plan", "plan-light"])("task/%s exact file chain through the real runner", (variant) => {
  it("writes and checks the caller file outside native workspace without publication", async () => {
    const f = fixture(variant);
    const result = await f.run();
    expect(result.ok, result.error).toBe(true);
    expect(f.edits.every((edit) => edit.path === f.assignedSource)).toBe(true);
    expect(f.checks.length).toBeGreaterThan(0);
    expect(f.checks.every((check) => check.path === f.assignedSource && !check.failed)).toBe(true);
    expect(readFileSync(f.assignedSource, "utf8")).toBe(source);
    expect(JSON.parse(readFileSync(f.review, "utf8"))).toMatchObject({ source: f.assignedSource, passed: true });
    expect(result).not.toHaveProperty("primaryFile");
    expect(existsSync(path.join(f.nativeWorkspace, "outputs/workflow.mjs"))).toBe(false);
    expect(existsSync(path.join(result.runDir, "outputs/workflow.mjs"))).toBe(false);
  });

  it("reopens corrected source at the same destination before acceptance", async () => {
    const f = fixture(variant, "repair");
    const result = await f.run();
    expect(result.ok, result.error).toBe(true);
    expect(f.edits.every((edit) => edit.path === f.assignedSource)).toBe(true);
    expect(readFileSync(f.assignedSource, "utf8")).toBe(correctedSource);
    const current = await f.currentCheck();
    expect(current.details?.sha256).toBe(f.reviewedDigest());
  });

  it.each<Scenario>(["missing", "misplaced"])(
    "fails its actual checker/route for %s source without fallback",
    async (scenario) => {
      const f = fixture(variant, scenario);
      const result = await f.run();
      expect(result.ok).toBe(false);
      expect(f.checks.some((check) => check.failed && check.path === f.assignedSource)).toBe(true);
      const checked = await f.currentCheck();
      expect(checked.isError).toBe(true);
      expect(JSON.stringify(checked.content)).toContain("caller-assigned");
      expect(existsSync(f.assignedSource)).toBe(false);
      if (scenario === "misplaced")
        expect(readFileSync(path.join(f.nativeWorkspace, "outputs/workflow.mjs"), "utf8")).toBe(source);
    },
  );

  it("exposes current byte drift to the actual consumer despite native completion", async () => {
    const f = fixture(variant, "drift");
    const result = await f.run();
    expect(result.ok, result.error).toBe(true);
    const checked = await f.currentCheck();
    expect(checked.isError).not.toBe(true);
    expect(checked.details?.sha256).not.toEqual(f.reviewedDigest());
    // The operator gate compares these actual bytes; native completion cannot authorize launch.
    const persistedReview = JSON.parse(readFileSync(f.review, "utf8"));
    expect(checked.details?.sha256).not.toBe(persistedReview.sha256);
    rmSync(f.assignedSource);
    expect((await f.currentCheck()).isError).toBe(true);
  });
});
