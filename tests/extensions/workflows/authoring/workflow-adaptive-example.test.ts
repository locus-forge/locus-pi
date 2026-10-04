import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { completed, tempRun, temporary, temporaryValue } from "../../../fixtures/scripted-agent-runtime.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { isWorkflowResultExplicitFailure } from "../../../../extensions/workflows/runtime/workflow-outcome.js";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function example(name: string, overrides: Record<string, unknown[]> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "adaptive-example-"));
  roots.push(root);
  const assigned = path.join(root, "assigned-files");
  mkdirSync(assigned);
  const names = [
    "design.md",
    "design-handoff.md",
    "baseline.md",
    "remaining-queue.md",
    "verify-tests.md",
    "verify-integration.md",
    "implementation-handoff.md",
    ...[1, 2, 3].flatMap((n) => [`slice-${n}-work.md`, `progress-${n}.md`, `review-${n}.md`, `decision-${n}.md`]),
  ];
  const wholeInput = `.tasks/example; task restrictions apply to every child.\nExact caller-assigned files:\n${names.map((file) => `${file}: ${path.join(assigned, file)}`).join("\n")}`;
  const seen: WorkflowAgentRequest[] = [];
  const counts: Record<string, number> = {};
  const answers: Record<string, unknown[]> = {
    "design-route": ["revise", "revise", "ready"],
    cut: [
      "remaining-queue.md: 1. slice A: replace parser 2. slice B: obsolete follow-up",
      "remaining-queue.md: 1. slice C: verify new caller",
      "remaining-queue.md: no items",
    ],
    scope: ["work", "work", "complete"],
    route: ["fix", "fix", "accept", "accept"],
    verdict: ["complete"],
    ...overrides,
  };
  const runtime = createWorkflowRuntime({
    runId: "adaptive-example",
    artifactPorts: createWorkflowArtifactStore({
      projectRoot: root,
      runId: "adaptive-example",
      runDir: ensureWorkflowRunDir(root, "adaptive-example"),
    }),
    agentRunner: async (request) => {
      seen.push(request);
      expect(request.prompt).toContain(wholeInput);
      const label = request.label!;
      const index = counts[label] ?? 0;
      counts[label] = index + 1;
      const options = answers[label] ?? [`${label} evidence`];
      const value = options[index] ?? options.at(-1);
      if (value instanceof Error) throw value;
      if (value && typeof value === "object" && "failureCause" in value) return value as never;
      if (name === "adaptive-slices") {
        if (["scope-assessment", "implement"].includes(label))
          expect(readFileSync(path.join(assigned, "remaining-queue.md"), "utf8")).toBeTruthy();
        if (["implement", "review", "arbiter"].includes(label))
          expect(readFileSync(path.join(assigned, "baseline.md"), "utf8")).toBe("baseline evidence");
        const file =
          label === "baseline"
            ? "baseline.md"
            : label === "cut"
              ? "remaining-queue.md"
              : label === "implement" || label === "correct"
                ? `slice-${counts.implement}-work.md`
                : label === "record"
                  ? `progress-${counts.implement}.md`
                  : label === "tests"
                    ? "verify-tests.md"
                    : label === "integration"
                      ? "verify-integration.md"
                      : label === "final-arbiter"
                        ? "implementation-handoff.md"
                        : undefined;
        if (file) writeFileSync(path.join(assigned, file), String(value));
      } else {
        const file =
          label === "design" || label === "design-correct"
            ? "design.md"
            : label === "design-arbiter"
              ? "design-handoff.md"
              : undefined;
        if (file) writeFileSync(path.join(assigned, file), String(value));
        if (label === "design-review") expect(readFileSync(path.join(assigned, "design.md"), "utf8")).toBeTruthy();
      }
      return {
        ok: true,
        status: "completed",
        summary: "scripted child",
        diagnostics: [],
        text: request.returnContract ? JSON.stringify(value) : String(value),
        ...(request.returnContract
          ? { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }
          : {}),
      };
    },
  });
  const module = await import(
    pathToFileURL(path.resolve(`extensions/workflows/references/examples/${name}.workflow.mjs`)).href
  );
  return {
    run: () => module.default(runtime.dsl, wholeInput),
    seen,
    counts,
    runtime,
    files: () =>
      Object.fromEntries(readdirSync(assigned).map((file) => [file, readFileSync(path.join(assigned, file), "utf8")])),
  };
}

describe("actual adaptive references with real runtime and scripted children", () => {
  it("rechecks two corrections, then replaces the remaining queue", async () => {
    const h = await example("adaptive-slices");
    const result = await h.run();
    expect(result).toMatchObject({ ok: true, status: "complete" });
    expect(h.files()["remaining-queue.md"]).toBe("remaining-queue.md: no items");
    expect(h.files()["implementation-handoff.md"]).toBe("final-arbiter evidence");
    const workers = h.seen.filter((r) => r.label === "implement");
    expect(workers).toHaveLength(2);
    // Source never reads the queue: every worker is pointed at the file the cut agent owns.
    for (const worker of workers)
      expect(worker.prompt).toContain("Slice:\nthe first numbered item of the assigned remaining-queue.md");
    const assessments = h.seen.filter((r) => r.label === "scope-assessment");
    expect(assessments[0]!.prompt).toContain("slice A: replace parser");
    expect(assessments[1]!.prompt).toContain("slice C: verify new caller");
    expect(assessments[1]!.prompt).not.toContain("slice B: obsolete follow-up");
    expect(assessments[0]!.prompt).toContain("An empty queue is not proof of completion");
    expect(h.counts.correct).toBe(2);
    expect(h.counts.review).toBe(4);
    const labels = h.seen.map((r) => r.label);
    expect(labels.slice(labels.indexOf("implement"), labels.indexOf("record"))).toEqual([
      "implement",
      "review",
      "arbiter",
      "route",
      "correct",
      "review",
      "arbiter",
      "route",
      "correct",
      "review",
      "arbiter",
      "route",
    ]);
    expect(h.seen.find((r) => r.label === "record")!.prompt).toContain("correct evidence");
    expect(h.seen.find((r) => r.label === "intake")!.prompt).toContain("No special acceptance file is required");
    expect(h.runtime.getJournal().filter((line) => line.kind === "agent_end")).toHaveLength(h.seen.length);
  });
  it("reaches final verification after three twice-corrected slices within the teaching allowance", async () => {
    const h = await example("adaptive-slices", {
      cut: ["1. A", "1. B", "1. C", "no items"],
      scope: ["work", "work", "work", "complete"],
      route: ["fix", "fix", "accept", "fix", "fix", "accept", "fix", "fix", "accept"],
    });
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.counts.implement).toBe(3);
    expect(h.counts.correct).toBe(6);
    expect(h.counts.review).toBe(9);
    expect(h.seen).toHaveLength(57);
  });
  it("bounds recuts cumulatively and returns the untruncated remainder", async () => {
    const h = await example("adaptive-slices", {
      cut: ["1. still required A 2. still required B 3. still required C 4. still required D"],
      scope: ["work"],
      route: ["accept"],
    });
    // The remainder is the whole queue file the cut agent owns, never a truncated copy.
    expect(await h.run()).toMatchObject({
      ok: false,
      status: "incomplete",
      reason: "slice_allowance",
      remaining: "remaining-queue.md",
    });
    expect(h.counts.implement).toBe(3);
    expect(h.counts.cut).toBe(4);
  });
  it.each([{ scope: ["needs_owner"] }, { scope: ["blocked"] }])(
    "does not implement a stopped scope: %j",
    async (overrides) => {
      const h = await example("adaptive-slices", overrides);
      expect(await h.run()).toMatchObject({ ok: false, remaining: "remaining-queue.md" });
      expect(h.counts.implement).toBeUndefined();
    },
  );
  it("returns the latest reviewed work when repeated correction uses the allowance", async () => {
    const h = await example("adaptive-slices", { route: ["fix"] });
    expect(await h.run()).toMatchObject({
      ok: false,
      status: "incomplete",
      reason: "review_allowance",
      currentWork: "correct evidence",
    });
    expect(h.counts.implement).toBe(1);
    expect(h.counts.correct).toBe(2);
    expect(h.counts.review).toBe(3);
    expect(h.counts.record).toBeUndefined();
  });
  it("gives a failed final reviewer and successful sibling to substantive arbitration", async () => {
    const failed = {
      ok: false,
      status: "failed",
      failureCause: "provider-error",
      summary: "review unavailable",
      diagnostics: ["provider failure"],
    };
    const h = await example("adaptive-slices", { tests: [failed], verdict: ["incomplete"] });
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, status: "incomplete" });
    expect(result.verification[0]).toContain("Cause: provider-error");
    expect(result.verification[1]).toContain("integration evidence");
    const prompt = h.seen.find((r) => r.label === "final-arbiter")!.prompt;
    expect(prompt).toContain("No accepted agent answer");
    expect(prompt).toContain("integration evidence");
  });
  it("propagates raw reviewer errors without reaching an arbiter", async () => {
    const h = await example("adaptive-slices", { review: [new Error("host failed")] });
    await expect(h.run()).rejects.toThrow("host failed");
    expect(h.counts.arbiter).toBeUndefined();
  });
  it("repairs design residuals after the second review without creating implementation", async () => {
    const h = await example("adaptive-design", {
      "design-review": ["nine defects", "bad test link; state owner missing; claim unverified", "all criteria checked"],
      "design-correct": ["first revised candidate", "corrected link and ownership; claim explicitly unverified"],
    });
    const result = await h.run();
    expect(isWorkflowResultExplicitFailure(result)).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      candidate: "corrected link and ownership; claim explicitly unverified",
    });
    expect(result.next_action).toContain("author a separate workflow");
    expect(h.counts["design-correct"]).toBe(2);
    expect(h.counts["design-review"]).toBe(3);
    expect(h.seen.filter((r) => r.label === "design-arbiter")[1]!.prompt).toContain("bad test link");
    expect(h.counts.implement).toBeUndefined();
  });
  it.each(["retry_review", "ready", "needs_owner", "stop"])(
    "preserves an empty review outcome for arbiter route %s",
    async (route) => {
      const h = await example("adaptive-design", {
        "design-review": ["", "later review"],
        "design-route": [route, "ready"],
      });
      const result = await h.run();
      expect(h.seen.find((r) => r.label === "design-arbiter")!.prompt).toContain("Cause: empty-answer");
      expect(h.counts["design-correct"]).toBeUndefined();
      expect(result.ok).toBe(route === "retry_review" || route === "ready");
      expect(h.counts["design-review"]).toBe(route === "retry_review" ? 2 : 1);
    },
  );
  it("publishes an incomplete specification at the limit without an unreviewed correction", async () => {
    const h = await example("adaptive-design", { "design-route": ["revise"] });
    expect(await h.run()).toMatchObject({
      ok: false,
      reason: "review_allowance",
      candidate: "design-correct evidence",
    });
    expect(h.counts["design-correct"]).toBe(2);
    expect(h.counts["design-review"]).toBe(3);
  });
});

/** Load one reference example's exported graph, to run against a runtime built here. */
async function exampleWorkflow(
  name: string,
): Promise<(dsl: ReturnType<typeof createWorkflowRuntime>["dsl"], input: string) => Promise<unknown>> {
  const url = pathToFileURL(path.resolve(`extensions/workflows/references/examples/${name}.workflow.mjs`));
  return (await import(url.href)).default;
}

async function refinement(routes: string[]) {
  return temporaryValue(async (root) => {
    const id = "refinement";
    const requests: WorkflowAgentRequest[] = [];
    let decisions = 0;
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
    const runtime = createWorkflowRuntime({
      runId: id,
      artifactPorts: store,
      agentRunner: async (req) => {
        requests.push(req);
        if (req.label === "decision") {
          assert.ok(req.returnContract);
          return {
            ...completed(req, JSON.stringify(routes[decisions++])),
            outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
          };
        }
        return completed(
          req,
          req.label === "worker"
            ? `work-${decisions + 1}: evidence and remainder`
            : `review-${decisions + 1}: exact feedback\nremaining criterion R2`,
        );
      },
    });
    const result = await (await exampleWorkflow("refinement"))(runtime.dsl, "Goal G1; do not change scope");
    return {
      result,
      requests,
      journal: runtime.getJournal(),
      artifacts: store.list().map((record) => ({
        ...record,
        text: store
          .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
          .toString(),
      })),
    };
  });
}

/**
 * The refinement and fixed references, run the same way: the actual example source against
 * the real runtime and the persisted artifact store, with scripted decisions.
 */
describe("the refinement and fixed references", () => {
  it("refinement complete on first round has no second worker and one primary", async () => {
    const got = await refinement(["complete"]);
    assert.equal(got.requests.length, 3);
    assert.equal(got.artifacts.filter((record) => record.kind === "primary").length, 1);
  });
  it("continue launches a new worker with exact goal, work and reviewer handoff, then completes", async () => {
    const got = await refinement(["continue_progress", "complete"]);
    assert.equal(got.requests.length, 6);
    const second = got.requests.filter((req) => req.label === "worker")[1]!;
    assert.match(second.prompt, /Goal G1; do not change scope/u);
    assert.match(second.prompt, /work-1: evidence and remainder/u);
    assert.match(second.prompt, /review-1: exact feedback\nremaining criterion R2/u);
    assert.ok(got.artifacts.some((record) => /Decision: continue_progress/u.test(record.text)));
    assert.equal(got.journal.filter((line) => line.choiceDecision).length, 2);
  });
  it("round cap and repeated no-progress are blocked, never a primary success", async () => {
    const cap = await refinement(["continue_progress", "continue_progress", "continue_progress"]);
    assert.equal(cap.requests.length, 9);
    assert.equal((cap.result as { summary: string }).summary, "round_cap");
    assert.equal((cap.result as { ok: boolean }).ok, false);
    assert.equal(cap.artifacts.filter((record) => record.kind === "primary").length, 0);
    const stalled = await refinement(["continue_stalled", "continue_stalled"]);
    assert.equal(stalled.requests.length, 6);
    assert.equal((stalled.result as { summary: string }).summary, "no_progress");
  });
  it("fixed graph still performs exactly one worker and no reviewer", async () =>
    temporary(async (root) => {
      const id = "fixed";
      const requests: WorkflowAgentRequest[] = [];
      const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
      const runtime = createWorkflowRuntime({
        runId: id,
        artifactPorts: store,
        agentRunner: async (req) => {
          requests.push(req);
          return completed(req, "fixed output");
        },
      });
      await (
        await exampleWorkflow("fixed")
      )(runtime.dsl, "fixed goal");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.returnContract, undefined);
    }));
});
