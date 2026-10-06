import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkflowAgentResult } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import { runStarter } from "./starter-fixture.js";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";
import { checkWorkflowSourceText } from "../../../../../extensions/workflows/tool/workflow-source-check-tool.js";
import { staticWorkflowMeta } from "../../../../../extensions/workflows/catalog/workflow-meta.js";

const base = "extensions/workflows/references/examples/starters";
const starters = [
  "project-tour",
  "caller-audit",
  "evaluator-optimizer",
  "plan-replan",
  "reflection",
  "parallel-reflection",
];
const originalWork = "First complete handoff\n  required evidence: missing\nartifact: changed-source.ts\n";
const correctedWork = "Corrected complete handoff\n  verified: required check\nartifact: changed-source.ts\n";

function checkSource(source: string, label: string): void {
  const diagnostics =
    staticWorkflowMeta(source).profile === "dataflow-v1"
      ? checkWorkflowSourceText(source, "dataflow-v1")
      : orchestrationOnlyWorkflowSourceShapeDiagnostics(source);
  expect(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    label,
  ).toEqual([]);
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: source });
}

// Check the exact source before importing any example to exercise its graph.
beforeAll(() => {
  for (const name of starters) checkSource(readFileSync(`${base}/${name}.workflow.mjs`, "utf8"), name);
});

describe("small agentic starters with real runtime and scripted children", () => {
  it("checks complete current authoring snippets with Node and their explicitly matching source modes", () => {
    const references = "skills/locus-pi-workflow-create/references";
    const documents = [
      "docs/workflows/create.md",
      "docs/workflows/source-shape.md",
      "skills/locus-pi-workflow-create/SKILL.md",
      "skills/locus-pi-workflow-create-detailed/SKILL.md",
      "skills/locus-pi-workflow-create-detailed/references/worked-decisions.md",
      ...readdirSync(references)
        .filter((file) => file.endsWith(".md") && file !== "dsl.md")
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

  it("keeps optional parallel writer artifacts separate and merges only after both finish", async () => {
    const answers = { purpose: [""], commands: [""], compose: [""] };
    let releasePurpose!: () => void;
    const ready = new Promise<void>((resolve) => {
      releasePurpose = resolve;
    });
    const finished: string[] = [];
    const got = await runStarter("project-tour", answers, async (request, _, folder) => {
      const label = request.label!;
      if (label === "purpose") await ready;
      if (label === "purpose" || label === "commands") {
        const file = path.join(folder, `${label}.md`);
        expect(request.prompt).toContain(`write only assigned ${label}.md`);
        writeFileSync(file, `Full ${label} evidence, retained only in the file.`);
        answers[label][0] = `Written: ${file}`;
        finished.push(label);
        if (label === "commands") releasePurpose();
      } else {
        expect(finished).toEqual(["commands", "purpose"]);
        const reports = ["purpose", "commands"].map((name) => readFileSync(path.join(folder, `${name}.md`), "utf8"));
        for (const report of reports) expect(request.prompt).not.toContain(report);
        expect(request.prompt).toContain(`${answers.purpose[0]}\n\n${answers.commands[0]}`);
        writeFileSync(path.join(folder, "guide.md"), reports.join("\n"));
        answers.compose[0] = `Written: ${path.join(folder, "guide.md")}`;
      }
    });
    expect(got.result).toBe(answers.compose[0]);
    expect(got.files["guide.md"]).toContain(got.files["purpose.md"]);
    expect(got.files["guide.md"]).toContain(got.files["commands.md"]);
    expect(got.artifacts.every((artifact) => artifact.kind === "answer")).toBe(true);
  });

  it("advances one audit item before its sibling, then waits for both before synthesis", async () => {
    const checked = ["Verified A with complete evidence\n", "Verified B with optional coverage disclosure\n"];
    let releaseB!: () => void;
    const bReleased = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let bFinished = false;
    const got = await runStarter(
      "caller-audit",
      {
        inspect: ["A whole findings\n", "B whole findings\n"],
        verify: checked,
        synthesize: ["Complete audit\n"],
        review: ["accept"],
      },
      async (request, occurrence) => {
        if (request.label === "inspect" && occurrence === 1) {
          await bReleased;
          bFinished = true;
        }
        if (request.label === "verify" && occurrence === 0) {
          expect(bFinished).toBe(false);
          expect(request.prompt).toContain("A whole findings\n");
          releaseB();
        }
        if (request.label === "synthesize" || request.label === "review") {
          expect(bFinished).toBe(true);
          for (const report of checked) expect(request.prompt).toContain(report);
          expect(request.prompt.indexOf(checked[0]!)).toBeLessThan(request.prompt.indexOf(checked[1]!));
          expect(request.prompt).toContain("Execution: completed");
        }
      },
      ["Source A", "Source B"],
    );
    expect(got.counts).toEqual({ inspect: 2, verify: 2, synthesize: 1, review: 1 });
    expect(got.seen.filter((request) => request.label === "verify").map((request) => request.title)).toEqual([
      "Verify findings at pipeline slot 1",
      "Verify findings at pipeline slot 3",
    ]);
    expect(got.artifacts.find((artifact) => artifact.kind === "primary")!.text).toBe("Complete audit\n");
  });

  it("refuses empty required caller items without starting children", async () => {
    const got = await runStarter("caller-audit", {});
    expect(got.result).toEqual({ ok: false, status: "incomplete", reason: "missing_caller_items" });
    expect(got.seen).toEqual([]);
    expect(got.artifacts).toEqual([]);
  });

  it("retains the complete audit candidate when required evidence remains unmet", async () => {
    const got = await runStarter(
      "caller-audit",
      {
        inspect: ["source findings"],
        verify: ["required evidence missing"],
        synthesize: ["Complete account with required residuals"],
        review: ["incomplete"],
      },
      (request, _, workspace) => {
        if (request.label === "review")
          writeFileSync(
            path.join(workspace, "findings.md"),
            "R1: required evidence unavailable; verify before acceptance.",
          );
      },
      ["Source A"],
    );
    expect(got.result).toMatchObject({
      ok: false,
      status: "incomplete",
      candidate: "Complete account with required residuals",
      findings: "findings.md",
    });
    expect(got.published).toEqual(["Complete account with required residuals"]);
    expect(got.artifacts.some((artifact) => artifact.kind === "primary")).toBe(false);
  });

  it("retains original caller units downstream when provider failures have no answer", async () => {
    const units = [
      "hidden-source-A.ts\n  Required: inspect this exact caller source.\n",
      "hidden-source-B.ts\n  Required: verify the second independent source.\n",
    ];
    const failure: WorkflowAgentResult = {
      ok: false,
      status: "failed",
      failureCause: "provider-error",
      summary: "provider unavailable",
      diagnostics: ["P2 provider probe"],
    };
    const got = await runStarter(
      "caller-audit",
      {
        inspect: [failure, "Complete second inspection"],
        verify: [failure, "Complete second verification"],
        synthesize: ["Complete account preserving failed checks"],
        review: ["incomplete"],
      },
      (request, occurrence) => {
        if (request.label === "inspect") return;
        expect(request.prompt).toContain(units.join("\n\n"));
        if (request.label === "verify" && occurrence === 1) return;
        expect(request.prompt).toContain("Cause: provider-error");
        expect(request.prompt).toContain("No accepted agent answer");
        expect(request.prompt).toContain("P2 provider probe");
        expect(request.prompt).toContain(`Label: ${request.label === "verify" ? "inspect" : "verify"}`);
      },
      units,
    );
    expect(got.result).toMatchObject({ ok: false, candidate: "Complete account preserving failed checks" });
    expect(got.artifacts.some((artifact) => artifact.kind === "primary")).toBe(false);
  });

  it("does not synthesize after an ordinary pipeline execution failure", async () => {
    const seen: string[] = [];
    await expect(
      runStarter(
        "caller-audit",
        { inspect: ["findings"], verify: ["verified"] },
        (request) => {
          seen.push(request.label!);
          if (request.label === "inspect") throw new Error("audit host failed");
        },
        ["Source A"],
      ),
    ).rejects.toThrow();
    expect(seen).toEqual(["inspect"]);
  });

  it.each([
    { choices: ["accept"], status: "accepted", rounds: 1 },
    { choices: ["revise", "accept"], status: "accepted", rounds: 2 },
    { choices: ["revise", "revise"], status: "incomplete", rounds: 2 },
    { choices: ["blocked"], status: "blocked", rounds: 1 },
  ])(
    "runs the primary artifact-backed loop through $choices with no unreviewed fix",
    async ({ choices, status, rounds }) => {
      const task =
        "Original Task: implement the requested behavior.\n  Preserve this exact Task and its required checks.\n";
      const answers = { implement: ["", ""], review: choices };
      const fullReviews: string[] = [];
      const got = await runStarter(
        "evaluator-optimizer",
        answers,
        (request, occurrence, folder) => {
          const product = path.join(path.dirname(folder), "product");
          const internal = path.join(product, "actor-selected-module.ts");
          const handoffPath = path.join(folder, "implementation.md");
          const reviewPath = path.join(folder, "findings.md");
          expect(request.prompt).toContain(task);
          expect(request.prompt).toContain(`Orchestration/evidence folder: ${folder}`);
          if (request.label === "implement") {
            if (occurrence > 0) {
              expect(readFileSync(reviewPath, "utf8")).toBe(fullReviews[occurrence - 1]);
              expect(readFileSync(handoffPath, "utf8")).toContain("Revision: 1");
              expect(request.prompt).not.toContain(fullReviews[occurrence - 1]);
            }
            mkdirSync(product, { recursive: true });
            writeFileSync(internal, `export const value = ${occurrence + 1};\n`);
            writeFileSync(
              handoffPath,
              `Complete result\nChanged: ${internal}\nRevision: ${occurrence + 1}\nActual checks and remaining work.\n`,
            );
            expect(readFileSync(handoffPath, "utf8")).toContain(internal);
            answers.implement[occurrence] = `Implemented pass ${occurrence + 1}; result: ${handoffPath}`;
          } else {
            expect(request.prompt).toContain("Do not edit product source");
            expect(request.prompt).toContain("Write only assigned findings.md");
            expect(request.prompt).toContain(answers.implement[occurrence]);
            const result = readFileSync(handoffPath, "utf8");
            expect(request.prompt).not.toContain(result);
            const discovered = /^Changed: (.+)$/mu.exec(result)![1]!;
            const beforeReview = readFileSync(discovered, "utf8");
            expect(beforeReview).toBe(`export const value = ${occurrence + 1};\n`);
            const review =
              `Revision: ${occurrence + 1}; decision: ${choices[occurrence]}\n` +
              `Prior findings: ${occurrence ? "R1 verified on correction" : "none"}\n` +
              "Optional check unavailable; required evidence disposition is explicit.\n" +
              "Detailed evidence. ".repeat(500);
            writeFileSync(reviewPath, review);
            expect(readFileSync(reviewPath, "utf8")).toBe(review);
            fullReviews.push(review);
            expect(readFileSync(discovered, "utf8")).toBe(beforeReview);
          }
        },
        [],
        task,
      );
      expect(got.seen.map((request) => request.label)).toEqual(
        Array.from({ length: rounds }, () => ["implement", "review"]).flat(),
      );
      expect(got.result).toMatchObject({ ok: status === "accepted", status, handoff: answers.implement[rounds - 1] });
      expect(got.counts).toEqual({ implement: rounds, review: rounds });
      expect(got.files["findings.md"]).toBe(fullReviews[rounds - 1]);
      expect(got.files["implementation.md"]).toContain(`Revision: ${rounds}`);
      expect(got.journal.filter((line) => line.choiceDecision)).toHaveLength(rounds);
      expect(got.primary).toEqual([]);
      expect(got.published).toEqual([]);
      expect(readFileSync(`${base}/evaluator-optimizer.workflow.mjs`, "utf8")).not.toContain(
        "actor-selected-module.ts",
      );
      if (status === "incomplete") expect(got.result).toMatchObject({ reason: "correction_allowance" });
    },
  );

  it("delivers the requirement/evidence instruction contract to the actual reviewer call", async () => {
    // Protect shipped instructions, not a scripted actor's ability to judge compliance.
    await runStarter("evaluator-optimizer", { implement: [originalWork], review: ["blocked"] }, (request) => {
      if (request.label !== "review") return;
      const prompt = request.prompt.replace(/\s+/gu, " ");
      expect(prompt).toContain("Verify each Task requirement");
      expect(prompt).toContain("equal outputs do not prove reuse or state transitions");
      expect(prompt).toContain("verified/unmet/unverified requirements");
    });
  });

  it("lets a reviewer block on a missing result file despite a successful-looking worker answer", async () => {
    const got = await runStarter(
      "evaluator-optimizer",
      { implement: ["All done"], review: ["blocked"] },
      (request, _, folder) => {
        if (request.label === "review") {
          expect(existsSync(path.join(folder, "implementation.md"))).toBe(false);
          expect(request.prompt).toContain("block on missing required prerequisites or handoff files");
          writeFileSync(path.join(folder, "findings.md"), "Blocked: assigned result file is missing.");
        }
      },
    );
    expect(got.result).toMatchObject({ ok: false, status: "blocked" });
    expect(got.counts).toEqual({ implement: 1, review: 1 });
    expect(got.files["findings.md"]).toContain("missing");
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
    expect(got.published).toEqual([first, second]);
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
    expect(got.published).toEqual([originalWork]);
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
    expect(got.primary).toEqual([revised]);
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
