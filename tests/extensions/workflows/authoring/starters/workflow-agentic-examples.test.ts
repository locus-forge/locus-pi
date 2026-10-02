import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { completed, tempRun, temporaryValue } from "../../../../fixtures/scripted-agent-runtime.js";
import { createWorkflowArtifactStore } from "../../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";

const base = "extensions/workflows/references/examples/starters";
const starters = ["evaluator-optimizer", "plan-replan", "reflection", "parallel-reflection"];
const input = "Deliver the requested outcome; retain required checks and uncertainty.\nSources: task.md";
const originalWork = "First complete handoff\n  required evidence: missing\nartifact: changed-source.ts\n";
const correctedWork = "Corrected complete handoff\n  verified: required check\nartifact: changed-source.ts\n";

function checkSource(source: string, label: string): void {
  expect(
    orchestrationOnlyWorkflowSourceShapeDiagnostics(source).filter((diagnostic) => diagnostic.severity === "error"),
    label,
  ).toEqual([]);
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: source });
}

// Check the exact source before importing any example to exercise its graph.
beforeAll(() => {
  for (const name of starters) checkSource(readFileSync(`${base}/${name}.workflow.mjs`, "utf8"), name);
});

type ChildEffect = (request: WorkflowAgentRequest, occurrence: number, workspace: string) => void | Promise<void>;

async function runStarter(name: string, answers: Record<string, string[]>, effect?: ChildEffect) {
  return temporaryValue(async (root) => {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const seen: WorkflowAgentRequest[] = [];
    const counts: Record<string, number> = {};
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: name, runDir: tempRun(root, name) });
    const runtime = createWorkflowRuntime({
      runId: name,
      projectRoot: root,
      workspaceDir: workspace,
      artifactPorts: store,
      agentRunner: async (request) => {
        seen.push(request);
        const label = request.label!;
        const occurrence = counts[label] ?? 0;
        counts[label] = occurrence + 1;
        await effect?.(request, occurrence, workspace);
        const script = answers[label];
        expect(script, `unscripted child: ${label}`).toBeDefined();
        const answer = script![occurrence] ?? script!.at(-1)!;
        return {
          ...completed(request, request.returnContract ? JSON.stringify(answer) : answer),
          ...(request.returnContract
            ? { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }
            : {}),
        };
      },
    });
    const module = await import(pathToFileURL(path.resolve(`${base}/${name}.workflow.mjs`)).href);
    const result = await module.default(runtime.dsl, input);
    return {
      result,
      seen,
      counts,
      journal: runtime.getJournal(),
      files: Object.fromEntries(
        readdirSync(workspace).map((file) => [file, readFileSync(path.join(workspace, file), "utf8")]),
      ),
      artifacts: store.list().map((record) => ({
        ...record,
        text: store
          .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
          .toString(),
      })),
    };
  });
}

describe("small agentic starters with real runtime and scripted children", () => {
  it("checks complete current authoring snippets with Node and the actual orchestration-only checker", () => {
    const references = "skills/locus-pi-workflow-create/references";
    const documents = [
      "docs/workflows/create.md",
      "docs/workflows/source-shape.md",
      ...readdirSync(references)
        .filter((file) => file.endsWith(".md"))
        .map((file) => `${references}/${file}`),
    ];
    let checked = 0;
    for (const file of documents) {
      for (const match of readFileSync(file, "utf8").matchAll(/```(?:js|javascript|mjs)\n([\s\S]*?)```/gu)) {
        const source = match[1]!;
        if (!/export const meta\s*=/u.test(source)) continue;
        checkSource(source, file);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("accepts the exact first handoff with disclosed optional coverage and no extra router", async () => {
    const work = "Complete result\nOptional browser check unavailable; required checks passed.\n";
    const got = await runStarter(
      "evaluator-optimizer",
      { implement: [work], review: ["accept"] },
      (request, _, workspace) => {
        if (request.label === "review")
          writeFileSync(
            path.join(workspace, "findings.md"),
            "Required evidence met; optional browser check not performed.",
          );
      },
    );
    expect(got.seen.map((request) => request.label)).toEqual(["implement", "review"]);
    expect(got.seen[1]!.prompt).toContain(work);
    expect(got.seen[1]!.returnContract).toBeDefined();
    expect(got.artifacts.filter((artifact) => artifact.kind === "primary").map((artifact) => artifact.text)).toEqual([
      work,
    ]);
    expect(got.files["findings.md"]).toContain("not performed");
    expect(got.journal.filter((line) => line.choiceDecision)).toHaveLength(1);
  });

  it("passes whole feedback/work into correction, then freshly reviews before publication", async () => {
    const findings =
      "R2: missing required check\n  preserve the existing artifact\nexact correction: exercise changed caller\n";
    const got = await runStarter(
      "evaluator-optimizer",
      { implement: [originalWork, correctedWork], review: ["revise", "accept"] },
      (request, occurrence, workspace) => {
        if (request.label === "review") {
          expect(request.prompt).toContain(occurrence === 0 ? originalWork : correctedWork);
          writeFileSync(path.join(workspace, "findings.md"), occurrence === 0 ? findings : "R2 evidenced; accepted.");
        }
        if (request.label === "implement" && occurrence === 1) {
          expect(request.prompt).toContain(originalWork);
          expect(request.prompt).toContain("findings.md");
          expect(readFileSync(path.join(workspace, "findings.md"), "utf8")).toBe(findings);
        }
      },
    );
    expect(got.seen.map((request) => request.label)).toEqual(["implement", "review", "implement", "review"]);
    expect(got.artifacts.filter((artifact) => artifact.kind === "primary").map((artifact) => artifact.text)).toEqual([
      correctedWork,
    ]);
    expect(got.artifacts.filter((artifact) => artifact.kind === "published").map((artifact) => artifact.text)).toEqual([
      originalWork,
      correctedWork,
    ]);
    expect(got.journal.filter((line) => line.choiceDecision)).toHaveLength(2);
  });

  it("preserves latest reviewed work and required residuals on exhaustion without another worker", async () => {
    const got = await runStarter(
      "evaluator-optimizer",
      { implement: [originalWork, correctedWork], review: ["revise"] },
      (request, _, workspace) => {
        if (request.label === "review")
          writeFileSync(
            path.join(workspace, "findings.md"),
            "R3 remains unmet; next action: verify required integration.",
          );
      },
    );
    expect(got.result).toMatchObject({
      ok: false,
      status: "incomplete",
      reason: "correction_allowance",
      currentWork: correctedWork,
      findings: "findings.md",
    });
    expect(got.counts).toEqual({ implement: 2, review: 2 });
    expect(got.files["findings.md"]).toContain("R3 remains unmet");
    expect(got.artifacts.at(-1)!.text).toBe(correctedWork);
    expect(got.artifacts.some((artifact) => artifact.kind === "primary")).toBe(false);
  });

  it("stops for missing required prerequisites while retaining the produced work", async () => {
    const got = await runStarter(
      "evaluator-optimizer",
      { implement: [originalWork], review: ["blocked"] },
      (request, _, workspace) => {
        if (request.label === "review")
          writeFileSync(
            path.join(workspace, "findings.md"),
            "Required service unavailable; reconnect it before recheck.",
          );
      },
    );
    expect(got.result).toMatchObject({ ok: false, status: "blocked", currentWork: originalWork });
    expect(got.counts).toEqual({ implement: 1, review: 1 });
    expect(got.artifacts.some((artifact) => artifact.kind === "primary")).toBe(false);
  });

  it("propagates execution errors instead of manufacturing a favorable review", async () => {
    const seen: string[] = [];
    await expect(
      runStarter("evaluator-optimizer", { implement: [originalWork], review: ["accept"] }, (request) => {
        seen.push(request.label!);
        if (request.label === "review") throw new Error("review host unavailable");
      }),
    ).rejects.toThrow("review host unavailable");
    expect(seen).toEqual(["implement", "review"]);
  });

  it("replaces a sequential plan from observed results and reassesses after the last step", async () => {
    const first = "Observed result A\nRemaining: caller evidence changed\n";
    const second = "Observed result B\nRequired caller evidence verified\n";
    const got = await runStarter(
      "plan-replan",
      { plan: ["work", "work", "complete"], execute: [first, second], deliver: ["Complete delivery account\n"] },
      (request, occurrence, workspace) => {
        if (request.label === "plan") {
          if (occurrence > 0) {
            expect(request.prompt).toContain(occurrence === 1 ? first : second);
            expect(readFileSync(path.join(workspace, "plan.md"), "utf8")).toContain("Remaining");
          }
          writeFileSync(
            path.join(workspace, "plan.md"),
            occurrence === 2
              ? "Verified: all required evidence\nRemaining: none"
              : `Remaining: step ${occurrence + 1}; retain required checks`,
          );
          if (occurrence < 2)
            writeFileSync(
              path.join(workspace, "next-step.md"),
              occurrence === 0
                ? "Step A: inspect initial caller"
                : "Step B: verify the observed caller; obsolete step removed",
            );
        }
        if (request.label === "execute") {
          expect(request.prompt).toContain("next-step.md");
          expect(readFileSync(path.join(workspace, "next-step.md"), "utf8")).toContain(
            occurrence === 0 ? "Step A" : "Step B",
          );
        }
        if (request.label === "deliver") {
          expect(request.prompt).toContain(second);
          expect(readFileSync(path.join(workspace, "plan.md"), "utf8")).toContain("Verified: all required evidence");
        }
      },
    );
    expect(got.seen.map((request) => request.label)).toEqual(["plan", "execute", "plan", "execute", "plan", "deliver"]);
    expect(got.artifacts.filter((artifact) => artifact.kind === "published").map((artifact) => artifact.text)).toEqual([
      first,
      second,
    ]);
    expect(got.artifacts.find((artifact) => artifact.kind === "primary")!.text).toBe("Complete delivery account\n");
  });

  it("exhausts work opportunities only after replanning, preserving the complete remainder", async () => {
    const got = await runStarter(
      "plan-replan",
      { plan: ["work"], execute: ["step 1 evidence", "step 2 evidence", "step 3 evidence"] },
      (request, occurrence, workspace) => {
        if (request.label === "plan") {
          writeFileSync(path.join(workspace, "plan.md"), `Remaining after ${occurrence} steps: required A, B, C, D`);
          writeFileSync(path.join(workspace, "next-step.md"), "Next: complete required A; retain B, C, D");
        }
      },
    );
    expect(got.result).toMatchObject({
      ok: false,
      status: "incomplete",
      reason: "work_allowance",
      lastResult: "step 3 evidence",
      plan: "plan.md",
      nextStep: "next-step.md",
    });
    expect(got.counts).toEqual({ plan: 4, execute: 3 });
    expect(got.files["plan.md"]).toBe("Remaining after 3 steps: required A, B, C, D");
    expect(got.artifacts.some((artifact) => artifact.kind === "primary")).toBe(false);
  });

  it("retains the last execution when replanning discovers a required unavailable prerequisite", async () => {
    const got = await runStarter("plan-replan", { plan: ["work", "blocked"], execute: [originalWork] });
    expect(got.result).toMatchObject({ ok: false, status: "blocked", lastResult: originalWork });
    expect(got.counts).toEqual({ plan: 2, execute: 1 });
    expect(got.artifacts.filter((artifact) => artifact.kind === "published").map((artifact) => artifact.text)).toEqual([
      originalWork,
    ]);
  });

  it("passes complete editorial values and publishes only the exact revision", async () => {
    const draft = "Draft\n  source quotation and uncertainty\n";
    const critique = "Critique\n  correct unsupported conclusion\n";
    const revised = "Revised document\n  uncertainty retained\n";
    const got = await runStarter("reflection", { draft: [draft], critique: [critique], revise: [revised] });
    expect(got.seen[1]!.prompt).toContain(draft);
    expect(got.seen[2]!.prompt).toContain(draft);
    expect(got.seen[2]!.prompt).toContain(critique);
    expect(got.seen.every((request) => request.returnContract === undefined)).toBe(true);
    expect(
      got.artifacts
        .filter((artifact) => artifact.kind === "published" || artifact.kind === "primary")
        .map((artifact) => artifact.text),
    ).toEqual([draft, critique, revised]);
    expect(got.artifacts.filter((artifact) => artifact.kind === "primary").map((artifact) => artifact.text)).toEqual([
      revised,
    ]);
  });

  it("waits for both investigations and preserves declared order through critique and revision", async () => {
    const facts = "Facts\n  exact evidence\n";
    const reader = "Reader questions\n  unresolved disagreement\n";
    const draft = "Complete synthesis\n";
    const critique = "Actionable synthesis critique\n";
    const revised = "Complete editorial revision\n";
    const completions: string[] = [];
    let releaseFacts!: () => void;
    const factsReleased = new Promise<void>((resolve) => {
      releaseFacts = resolve;
    });
    const got = await runStarter(
      "parallel-reflection",
      { facts: [facts], reader: [reader], synthesize: [draft], critique: [critique], revise: [revised] },
      async (request) => {
        if (request.label === "facts") {
          await factsReleased;
          completions.push("facts");
        } else if (request.label === "reader") {
          completions.push("reader");
          releaseFacts();
        } else {
          expect(completions).toEqual(["reader", "facts"]);
          expect(request.prompt).toContain(`${facts}\n\n${reader}`);
        }
      },
    );
    expect(got.seen.map((request) => request.label)).toEqual(["facts", "reader", "synthesize", "critique", "revise"]);
    expect(got.seen[3]!.prompt).toContain(draft);
    expect(got.seen[4]!.prompt).toContain(draft);
    expect(got.seen[4]!.prompt).toContain(critique);
    expect(got.artifacts.find((artifact) => artifact.kind === "primary")!.text).toBe(revised);
  });
});
