import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeWorkflowReturnContract,
  workflowReturnInstructions,
} from "../../../../../extensions/workflows/runtime/workflow-return.js";
import {
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
  standardWorkflowSourceShapeDiagnostics,
} from "../../../../../extensions/workflows/tool/workflow-source-shape.js";
import { runStarter } from "./starter-fixture.js";

const starterPath = "extensions/workflows/references/examples/starters/evaluator-optimizer.workflow.mjs";
const lessons = [
  "skills/locus-pi-workflow-create/SKILL.md",
  "skills/locus-pi-workflow-create-detailed/SKILL.md",
  "docs/workflows/create.md",
];
const source = (file: string): string => readFileSync(file, "utf8");
const backslash = String.fromCharCode(92);
const moduleSource = (body: string, declarations = ""): string =>
  [
    'export const meta = { name: "wrapping-test", profile: "standard" };',
    declarations,
    `export default async function run({ agent }, input) {\n${body}\n}`,
  ].join("\n");

function checkSource(text: string): void {
  expect(standardWorkflowSourceShapeDiagnostics(text)).toEqual([]);
  expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(text)).toEqual([]);
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: text });
}

describe("authoring readability without changing prompt or input values", () => {
  it("keeps requested SVG work in its optional owner while preserving its artifact and visual safeguards", () => {
    const manual = source("docs/workflows/authoring.md");
    const appendixStart = manual.indexOf("## Optional diagram appendix");
    expect(appendixStart).toBeGreaterThan(0);
    const core = manual.slice(0, appendixStart);
    const appendix = manual.slice(appendixStart).replace(/\s+/gu, " ");
    expect(core).not.toContain("Visual inspection is still required");
    expect(core).not.toContain("keep exactly one hand-authored");
    for (const requirement of [
      "### Workflow diagram contract", // Retain the existing public link anchor.
      "Create a workflow SVG only on explicit request.",
      "parallel groups or handoffs do not require one",
      "When requested, keep exactly one hand-authored",
      "no `<script>`",
      "no embedded or remote images",
      "no remote fonts or stylesheets",
      "`<title>`/`<desc>`",
      "Visual inspection is still required",
    ])
      expect(appendix).toContain(requirement);
    expect(source("skills/locus-pi-workflow-create/references/design-and-build.md")).toContain(
      "ordinary Build does not require a diagram",
    );
  });

  it("keeps a compact design with Task, ownership, acceptance and failure contracts rather than repeated graphs", () => {
    const design = source("skills/locus-pi-workflow-create/references/design-and-build.md");
    const template = /```markdown\n([\s\S]*?)```/u.exec(design)?.[1];
    expect(template).toBeDefined();
    for (const field of [
      "Task",
      "Deliverable",
      "Context",
      "Graph",
      "Handoffs",
      "Bounds",
      "Evidence",
      "Exits",
      "Review",
    ])
      expect(template).toMatch(new RegExp(`^${field}:`, "mu"));
    expect(template).toContain("## Entries");
    expect(template).toContain("exact Task/shared file paths, writers and readers");
    expect(template).toContain("disjoint parallel scopes");
    expect(template).toContain("worst-case calls including saved children");
    expect(template).toContain("correct/recheck, blocked and exhausted");
    expect(template).not.toMatch(/^(?:Approach|Mechanisms|Concurrency|Failure exits):/mu);
    const prose = design.replace(/\s+/gu, " ");
    for (const requirement of [
      "Describe each dependency once",
      "A separate design-review agent is not required by default",
      "After Build, review the actual source",
      "Keep any independent review required by the Task",
      "verified, unmet or unverified",
      "Correction receives the complete actionable findings and is followed by fresh review",
      'returns `{ ok: false, status: "failed" }`',
    ])
      expect(prose).toContain(requirement);
    const index = source("skills/locus-pi-workflow-create/references/INDEX.md").replace(/\s+/gu, " ");
    expect(index).toContain("Read only the selected semantic explanation and the execution card needed");
    expect(index).toContain("do not reread another copy");
  });

  it("owns width at authoring time with explicit byte-preservation exceptions and no runtime formatter", () => {
    const styles = source("skills/locus-pi-workflow-create/references/authoring-styles.md").replace(/\s+/gu, " ");
    for (const requirement of [
      "120 Unicode code points, including indentation",
      "not a cap on answer length",
      "Do not reflow the original Task, opaque inputs/results, frozen evaluation inputs or reviewed prompt bytes",
      "Never truncate content or normalize input at runtime",
      "keep the bytes and record that specific exception",
      "unchanged prompt values do not preserve changed source-byte identity",
    ])
      expect(styles).toContain(requirement);
  });

  it("keeps the canonical starter and all three teaching copies identical within 120 physical code points", () => {
    const canonical = source(starterPath);
    const modules: Array<{ file: string; text: string }> = [{ file: starterPath, text: canonical }];
    for (const file of lessons) {
      const examples = [...source(file).matchAll(/```(?:js|javascript|mjs)\n([\s\S]*?)```/gu)]
        .map((match) => match[1]!)
        .filter((text) => /name:\s*"evaluator-optimizer"/u.test(text));
      expect(examples, file).toHaveLength(1);
      expect(examples[0]!.trim(), file).toBe(canonical.trim());
      modules.push({ file, text: examples[0]! });
    }
    // Only new author-owned teaching source is width-checked, never caller input or historical source.
    for (const { file, text } of modules) {
      const overlong = text.split(/\r\n|\n|\r/u).flatMap((line, index) => {
        const width = [...line].length; // Includes indentation; astral code points count once.
        return width > 120 ? [{ line: index + 1, width }] : [];
      });
      expect(overlong, file).toEqual([]);
      checkSource(text);
    }
  });

  it.each([
    ["multiline template", "`Read exact files.\nPreserve the Task.`"],
    ["quoted LF continuation", `"Read exact files. ${backslash}\nPreserve the Task."`],
    ["template CRLF continuation", "`Read exact files. " + backslash + "\r\nPreserve the Task.`"],
  ])("accepts an author-owned top-level %s without importing the source", (_name, literal) => {
    checkSource(
      moduleSource('return agent(`${CONTEXT}\\n${input}`, { label: "review" });', `const CONTEXT = ${literal};`),
    );
  });

  it.each([
    'const context = "Read exact files. " +\n"Preserve the Task.";\n' +
      'return agent(`${context}\\n${input}`, { label: "review" });',
    'return agent("Read exact files. " +\n"Preserve the Task.\\n" + input, { label: "review" });',
    'return agent(`Original Task: ${\ninput\n}`, { label: "review" });',
  ])("allows source-only expression wrapping at an existing prompt sink: %s", (body) => {
    checkSource(moduleSource(body));
  });

  it.each([
    [
      "top-level concatenation",
      moduleSource(
        'return agent(`${CONTEXT}\\n${input}`, { label: "review" });',
        'const CONTEXT = "Read exact files. " +\n"Preserve the Task.";',
      ),
      "WF_TOP_LEVEL",
    ],
    [
      "input split/join",
      moduleSource('return agent(`${input.split(" ").join("\\n")}`, { label: "review" });'),
      "WF_DATA_FLOW",
    ],
    [
      "input whitespace replacement",
      moduleSource('return agent(input.replaceAll(" ", "\\n"), { label: "review" });'),
      "WF_CALL",
    ],
  ])("does not broaden the grammar to admit %s", (_name, text, code) => {
    // These are valid JavaScript; the authoring grammar, not syntax, refuses them.
    execFileSync(process.execPath, ["--input-type=module", "--check"], { input: text });
    for (const check of [standardWorkflowSourceShapeDiagnostics, orchestrationOnlyWorkflowSourceShapeDiagnostics]) {
      expect(check(text).filter((diagnostic) => diagnostic.severity === "error")).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    }
  });

  it("preserves complete implementation/review prompt bytes and a long unchanged Task through correction", async () => {
    checkSource(source(starterPath));
    const task =
      '  Original Task: preserve π 日本 😀, "quotes", \\paths, `backticks` and ${input}.\r\n' +
      "An unchanged requirement. ".repeat(8) +
      "\r\n\tPreserve leading and trailing whitespace.  \r\n  ";
    expect(task.split("\r\n").some((line) => [...line].length > 120)).toBe(true);
    const work = ["  Complete first report.\r\n", "  Complete corrected report.\r\n"];
    const context = [
      "Use injected pwd/project root for execution context; verify the requested checkout and branch.",
      "The input supplies the original Task, sources, product root and exact orchestration file paths.",
      "Read those sources; missing or conflicting context/paths means blocked. Do not guess destinations.",
    ].join("\n");
    const got = await runStarter(
      "evaluator-optimizer",
      { implement: work, review: ["revise", "accept"] },
      (request, occurrence, folder) => {
        const root = path.dirname(folder);
        const names = [
          "guide.md",
          "purpose.md",
          "commands.md",
          "audit.md",
          "implementation.md",
          "findings.md",
          "plan.md",
          "next-step.md",
          "delivery.md",
          "document.md",
        ];
        const wholeInput = [
          task,
          `Expected checkout: ${root}`,
          `Product root: ${path.join(root, "product")}`,
          `Orchestration/evidence folder: ${folder}`,
          "Exact file destinations:",
          ...names.map((name) => `${name}: ${path.join(folder, name)}`),
        ].join("\n");
        // These expected values pin the original prompt bytes, independently of the source literal layout.
        const duty =
          request.label === "implement"
            ? [
                "Implement the Task in its assigned product root; choose internal files within its bounds.",
                "Preserve unrelated work; do not commit. On correction, read the assigned findings.md and implementation.md.",
                "Write the complete result, changed paths, actual checks and remaining work to assigned implementation.md;",
                `read it back. Return only a short status and its exact path. This is pass ${occurrence + 1}.`,
              ]
            : [
                "Read assigned implementation.md, then inspect the complete actual diff and required evidence.",
                "Verify each Task requirement; equal outputs do not prove reuse or state transitions.",
                "Do not edit product source. Write only assigned findings.md: verified/unmet/unverified requirements, defects,",
                "checks, prior finding dispositions and next action, keep optional checks separate. Read it back.",
                "Accept only verified requirements; revise correctable defects;",
                "block on missing required prerequisites or handoff files. Worker status:",
                work[occurrence]!,
              ];
        const authored = [context, "Original Task and working context:", wholeInput, ...duty].join("\n");
        const expected =
          request.label === "review"
            ? `${authored}\n\n${workflowReturnInstructions(
                normalizeWorkflowReturnContract({ choices: ["accept", "revise", "blocked"] }),
              )}`
            : authored;
        expect(Buffer.from(request.prompt)).toEqual(Buffer.from(expected));
        const taskOffset = `${context}\nOriginal Task and working context:\n`.length;
        expect(Buffer.from(request.prompt.slice(taskOffset, taskOffset + task.length))).toEqual(Buffer.from(task));
      },
      [],
      task,
    );
    expect(got.counts).toEqual({ implement: 2, review: 2 });
    expect(got.result).toEqual({ ok: true, status: "accepted", handoff: work[1] });
  });
});
