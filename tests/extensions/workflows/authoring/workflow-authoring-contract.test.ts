/**
 * The authoring references themselves: what the skill cards, manuals and
 * packaged examples must still say, and that every declared-standard snippet
 * they publish passes the checker they teach. These cases own documentation
 * truth, not the checker's rules.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { staticWorkflowMeta } from "../../../../extensions/workflows/catalog/workflow-meta.js";
import { standardWorkflowSourceShapeErrors } from "../../../../extensions/workflows/tool/workflow-source-shape.js";
import {
  packagedWorkflowNames,
  packagedWorkflowPath,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function standardSource(run: string, declarations = ""): string {
  return [
    'export const meta = { name: "contract-test", profile: "standard", description: "Contract test." };',
    declarations,
    run,
  ]
    .filter(Boolean)
    .join("\n");
}

function javascriptDocSnippets(relativePath: string): string[] {
  return [...source(relativePath).matchAll(/```(?:js|javascript|mjs)\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
}

function declaredStandardDocSnippets(relativePath: string): string[] {
  return javascriptDocSnippets(relativePath).filter((snippet) => /profile:\s*["']standard["']/u.test(snippet));
}

describe("readable workflow authoring references", () => {
  const authoringSurfaces = [
    "skills/locus-pi-workflow-create/SKILL.md",
    "skills/locus-pi-workflow-create/references/design-and-build.md",
    "docs/workflows/authoring.md",
    "extensions/workflows/tool/workflow-tool.ts",
    "extensions/workflows/manifest.json",
    "extensions/workflows/examples/README.md",
  ];

  it.each(authoringSurfaces)("keeps Design -> review -> Build continuous by default on %s", (relativePath) => {
    const text = source(relativePath);
    expect(text).toContain(".design.md");
    expect(text).toContain("Build design:");
    expect(text).toContain("Build approved design:");
    expect(text).toMatch(/design[- ]only|pause after design/iu);
  });

  it("documents the draft to concrete workflow source contract", () => {
    const text = source("extensions/workflows/examples/task/README.md");
    expect(text).toContain("`task` is a group-only Package namespace");
    expect(text).toContain("`task/draft` turns a raw request into `draft.md`");
    expect(text).toContain("Copy and edit this text when needed");
    expect(text).toContain("`task/plan` receives the complete accepted draft as semantic input");
    expect(text).toContain("one concrete `workflow.mjs`");
    expect(text).toContain("Neither package stage executes generated source.");
    expect(text).toContain("For an authorized create-and-run request");
  });

  it("keeps CLI syntax target-first on every active manual speaker", () => {
    const canonical =
      "/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]";
    for (const relativePath of [
      "skills/locus-pi-workflow-run/SKILL.md",
      "docs/workflows/running.md",
      "extensions/workflows/references/patterns.md",
    ]) {
      expect(source(relativePath)).toContain(canonical);
    }
    expect(source("docs/workflows/running.md")).not.toContain("/workflow-run <name|path>");
    for (const relativePath of ["docs/workflows/running.md", "docs/workflows.md"]) {
      const text = source(relativePath);
      expect(text).toContain("--run-name <name>");
      expect(text).toContain("--output-dir <path>");
      expect(text).not.toContain("/workflows run --output-dir <path>");
    }
  });

  it.each([
    "skills/locus-pi-workflow-create/SKILL.md",
    "docs/workflows/source-shape.md",
    "docs/workflows/authoring.md",
  ])("publishes the runnable standard source gate on %s", (relativePath) => {
    expect(source(relativePath)).toContain("workflow_check_source");
  });

  it("makes workflow authoring source-checking fail closed through either supported route", () => {
    const text = source("skills/locus-pi-workflow-create/SKILL.md");
    expect(text).toContain("workflow_check_source");
    expect(text).toContain("npm run check:workflow-source -- --mode orchestration-only <exact-path>");
    expect(text).toMatch(/neither route is available/iu);
    expect(text).toMatch(/selected validator fails/iu);
    expect(text).toMatch(/never (?:report|return).*successful Build/isu);
  });

  it("keeps the manual hello-world inside the enforced input-normalization grammar", () => {
    expect(source("docs/workflows/authoring.md")).toContain(
      'const task = typeof input === "string" && input.trim() ? input.trim() : "list the cwd";',
    );
  });

  it("runs every public declared-standard documentation snippet through the source checker", () => {
    const documents = [
      "docs/workflows/source-shape.md",
      "skills/locus-pi-workflow-create/references/source-boundary.md",
      "skills/locus-pi-workflow-create/SKILL.md",
      ...readdirSync(path.join(root, "docs/workflows")).map((name) => `docs/workflows/${name}`),
      "extensions/workflows/examples/README.md",
      "README.md",
    ];
    const snippets = documents.flatMap((relativePath) =>
      declaredStandardDocSnippets(relativePath).map((snippet, index) => ({ index, relativePath, snippet })),
    );
    expect(snippets.length).toBeGreaterThan(0);
    for (const { index, relativePath, snippet } of snippets) {
      expect(standardWorkflowSourceShapeErrors(snippet), `${relativePath} standard snippet ${index + 1}`).toEqual([]);
    }
  });

  it("keeps standard teaching free of author-side capability and answer engineering", () => {
    const documents = [
      "docs/workflows/source-shape.md",
      "skills/locus-pi-workflow-create/references/source-boundary.md",
      "skills/locus-pi-workflow-create/SKILL.md",
      ...readdirSync(path.join(root, "docs/workflows")).map((name) => `docs/workflows/${name}`),
      "extensions/workflows/examples/README.md",
      "README.md",
    ];
    const snippets = documents.flatMap((relativePath) => declaredStandardDocSnippets(relativePath));
    for (const snippet of snippets) {
      expect(snippet).not.toMatch(/\b(?:tools|readOnly|permissionMode|sandbox|schema|validate)\s*:/u);
      expect(snippet).not.toMatch(/function\s+(?:parse|validate|render|repair|acknowledge)\w*/iu);
    }
  });

  it("teaches one project-local workflow workspace separate from two-zone run evidence", () => {
    for (const relativePath of ["skills/locus-pi-workflow-create/references/source-boundary.md", "docs/workflows.md"]) {
      const text = source(relativePath);
      expect(text).toContain(".locus-pi/workspaces/<generated-run-name>");
      expect(text).not.toContain("outputs/<workflow-name>");
    }
    expect(source("skills/locus-pi-workflow-create/SKILL.md")).not.toContain(
      ".locus-pi/workspaces/<generated-run-name>",
    );
    const storage = source("docs/workflows.md");
    expect(storage).toContain("runs/<storageRootRunId>/");
    expect(storage).toContain("outputs/    human-readable host projection");
    expect(storage).toContain("runtime/    machine evidence and continuation authority");
    expect(storage).toContain("children/<runId>/");
    expect(storage).toContain("attempts/<runId>/");
    expect(storage).toContain("must never resolve to the same directory");
  });

  it("teaches durable workflow files separately from disposable scratch", () => {
    for (const relativePath of [
      "skills/locus-pi-workflow-create/SKILL.md",
      "skills/locus-pi-workflow-create/references/source-boundary.md",
      "docs/workflows/dsl.md",
      "docs/workflows.md",
    ]) {
      const text = source(relativePath);
      expect(text).toMatch(/durable (?:handoffs|location)/iu);
      expect(text).toMatch(/final results/iu);
      expect(text).toMatch(/review evidence/iu);
      expect(text).toMatch(/explicit resume inputs/iu);
      expect(text).toMatch(/dependency caches/iu);
      expect(text).toMatch(/test basetemp/iu);
      expect(text).toMatch(/temporary and cache locations/iu);
      expect(text).toMatch(/explicit.*remains authoritative/isu);
    }
  });

  it("checks canonical AUTHORING fragments while keeping the installed router code-free", () => {
    const authoring = javascriptDocSnippets("docs/workflows/source-shape.md");
    const skill = javascriptDocSnippets("skills/locus-pi-workflow-create/SKILL.md");
    expect(authoring).toHaveLength(3);
    expect(skill).toHaveLength(0); // Entrypoint routes to tested complete examples; it duplicates no harness.

    const fragments = [
      {
        label: "AUTHORING choice fragment",
        source: standardSource(`export default async function run({ agent }) {
${authoring[0] ?? ""}
  return route;
}`),
      },
      {
        label: "AUTHORING handoffs fragment",
        source: standardSource(`export default async function run({ agent }) {
${authoring[1] ?? ""}
  return units;
}`),
      },
      ...authoring.slice(2).map((snippet, index) => ({
        label: `AUTHORING complete snippet ${index + 1}`,
        source: snippet,
      })),
    ];
    for (const fragment of fragments) {
      expect(standardWorkflowSourceShapeErrors(fragment.source), fragment.label).toEqual([]);
    }
  });

  it("keeps unused acknowledgement protocols review-owned instead of parsing prompt English", () => {
    for (const relativePath of ["docs/workflows/source-shape.md", "docs/workflows/authoring.md"]) {
      const text = source(relativePath);
      expect(text).toMatch(/acknowledgement/iu);
      expect(text).toMatch(/review/iu);
      expect(text).toMatch(/prompt[- ]English/iu);
    }
  });

  it("routes one continuous Design-review-Build process without copying the runtime manual", () => {
    const router = source("skills/locus-pi-workflow-create/SKILL.md");
    const design = source("skills/locus-pi-workflow-create/references/design-and-build.md");
    expect(router).toContain("This skill owns authoring and the checked-source handoff.");
    expect(router).toContain("references/design-and-build.md");
    expect(router).toContain("source-shape.md#machine-enforced-standard-source-shape");
    expect(router).toContain("docs/workflows/index.md");
    expect(router).toContain("Create-only ends with checked source");
    expect(router).toContain("Create-and-run continues through that run skill");
    expect(router).not.toContain("Never run the workflow");
    expect(design).toContain("no unchecked module is imported");
    expect(router).toContain("exact copyable launch command");
    expect(router).toContain("/workflows run <name>");
    expect(router.split("\n").length).toBeLessThan(100);
    expect(design).toContain("before any source");
    expect(design).toContain("## Entries");
    expect(design).toContain("group-only");
    expect(design).toContain("<name>/<child>");
    expect(design).toContain("workflow_check_source");
    expect(design).toContain("material algorithm mismatch");
  });

  it("keeps source grammar, labels, output and failure authority in canonical references", () => {
    const authoring =
      source("docs/workflows/source-shape.md") +
      source("skills/locus-pi-workflow-create/references/source-boundary.md");
    const dsl = source("docs/workflows/dsl.md");
    const policy = source("docs/workflows/budgets.md");
    const index = source("docs/workflows/index.md");
    const output = source("docs/workflows/agent-results.md");
    expect(authoring).toContain("exact text");
    expect(authoring).toContain("choice:");
    expect(authoring).toContain("handoffs:");
    expect(authoring).toContain("literal `label`");
    expect(authoring).toContain("provenance");
    expect(authoring).toContain("Markdown/table/report renderers");
    expect(authoring).toContain("raw `schema`");
    expect(dsl).toContain("items()");
    expect(policy).toContain("## Run budget");
    expect(policy).toContain("No additional axis acquires a default without a separate policy decision.");
    for (const owner of ["agent-results.md", "dsl.md", "budgets.md", "recovery-and-continuation.md"])
      expect(index).toContain(owner);
    expect(output).toContain("returnVia");
    expect(output).toContain("workflow_return");
    expect(output).toContain("same");
    expect(output).toContain("fallback");
    expect(output).toContain("handoffs");
    expect(output).toContain("schema");
    expect(output).toContain("Format repair is not semantic retry");
  });

  it("keeps workflow-create snippets free of file parsing and default fuse boilerplate", () => {
    const authoredDocs = [
      "skills/locus-pi-workflow-create/SKILL.md",
      ...readdirSync(path.join(root, "skills/locus-pi-workflow-create/references"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `skills/locus-pi-workflow-create/references/${name}`),
    ];
    for (const relativePath of authoredDocs) {
      for (const snippet of javascriptDocSnippets(relativePath)) {
        expect(snippet, relativePath).not.toMatch(
          /\b(?:consumeTextArtifact|projectRoot|promptFile|publishPrimaryFile|workspace|now|random)\s*\(/u,
        );
        expect(snippet, relativePath).not.toMatch(/\b(?:maxToolCalls|timeoutMs)\s*:/u);
      }
    }
    const card = source("skills/locus-pi-workflow-create/references/fixed-graph.md");
    expect(card).toContain("author-known");
    expect(card).toContain("do not encode them as newline/CSV/JSON");
    const human = source("skills/locus-pi-workflow-create/references/human-continuation.md");
    expect(human).toContain("integration/compatibility");
    expect(human).toContain("Do not label that example standard");
  });

  it("keeps the surviving runtime defaults in the runtime owner, not the router", () => {
    const manual = source("docs/workflows/budgets.md");
    expect(source("docs/workflows/agent-results.md")).toContain("MAX_DAGS_IN_SCOPE");
    const policy = manual.split("## Run budget\n")[1]?.split("\n---\n")[0] ?? "";
    expect(policy).toMatch(/Workflow `concurrency`\s*\| 4\s*\|/u);
    expect(policy).toMatch(/Workflow `totalAgents`\s*\| \*\*10,000 in headless; unbounded in TUI\/RPC\*\*/u);
    expect(policy).toMatch(/Standalone task runtime\s*\| `runtimeMs = 3_600_000`/u);
    expect(policy).toMatch(/Standalone task turns\/tools\s*\| Unbounded/u);
    for (const axis of ["runtimeMs", "timeoutMs", "toolCalls", "turns"]) {
      const row = policy.split("\n").find((line) => line.includes(`Workflow \`${axis}\``));
      expect(row, axis).toMatch(/\| Unbounded\s*\|/u);
    }
    expect(policy).toContain("No multiplication by turns");
    expect(policy).toContain("one wall-clock deadline per physical child attempt");
    expect(manual).not.toMatch(/24-hour (?:emergency|new-child)|1,000 turns per child attempt/u);
    expect(source("skills/locus-pi-workflow-create/SKILL.md")).not.toContain("10,000");
  });

  it("states the deleted size limits as deleted, so no reader re-derives them from the manual", () => {
    // The runtime stopped guessing how long an answer, a handoff item or a routing list
    // may be. A manual that still printed those numbers would be the last place an author
    // could learn a rule the code no longer has.
    for (const file of readdirSync(path.join(root, "docs/workflows"))) {
      const manual = source(`docs/workflows/${file}`);
      expect(manual, file).not.toContain("SCHEMA_MAX_ATTEMPTS");
      expect(manual, file).not.toMatch(/500,000\s+(?:answer\s+)?characters/u);
      for (const mention of manual.split("\n").filter((line) => /maxItemChars|maxAnswerChars/u.test(line)))
        expect(mention, file).toContain("refused by name");
    }
    expect(source("docs/workflows/budgets.md")).toMatch(/all six resolved axes/u);
    expect(source("docs/workflows/agent-results.md")).toContain("`maxItems` may be omitted entirely");
  });

  it("keeps ordered stages separate from the caller-item inline mini-workflow pattern", () => {
    const patterns = source("extensions/workflows/references/patterns.md");
    const ordered =
      patterns.split("## Ordered pipeline\n")[1]?.split("## Caller-supplied item mini-workflows\n")[0] ?? "";
    const callerItems =
      patterns.split("## Caller-supplied item mini-workflows\n")[1]?.split("## Fan-out/fan-in\n")[0] ?? "";

    expect(ordered).toContain("extracted: await agent");
    expect(ordered).toContain("classified: await agent");
    expect(callerItems).toContain("const items = dsl.items()");
    expect(callerItems).toContain("dsl.pipeline(items");
    expect(callerItems).toContain("dsl.workflow((nested) => processItem(nested, item))");
    expect(callerItems).toContain("requires caller-supplied items");
  });

  it("ships the graph cards and focused authoring references without empty redirects", () => {
    const base = "skills/locus-pi-workflow-create/references";
    const cards = ["fixed-graph.md", "bounded-refinement.md", "decomposition.md", "human-continuation.md"];
    const index = source(`${base}/INDEX.md`);
    for (const name of cards) {
      expect(index).toContain(name);
      const text = source(`${base}/${name}`);
      for (const word of ["Use", "Avoid", "Graph", "Cost", "Handoff", "Failure", "Primitives"])
        expect(text, name).toContain(word);
      expect(text).toContain(".workflow.mjs");
    }
    // The six legacy redirect cards and large-agent-runs.md are gone, not renamed:
    // a card that only points elsewhere is catalog noise, and fan-out is run-skill territory.
    const retired = [
      "sequential-text",
      "fixed-fan-out",
      "bounded-review-loop",
      "bounded-candidate-search",
      "dynamic-orchestrator-workers",
      "human-gate",
      "large-agent-runs",
    ];
    expect(readdirSync(path.join(root, base)).sort()).toEqual([
      "INDEX.md",
      "adaptive-slices.md",
      "authoring-decisions.md",
      "authoring-styles.md",
      "bounded-refinement.md",
      "decomposition.md",
      "design-and-build.md",
      "fixed-graph.md",
      "human-continuation.md",
      "procedural-briefs.md",
      "repair-and-continue.md",
      "source-boundary.md",
      "structured-results.md",
    ]);
    for (const name of retired) expect(index, name).not.toContain(name);
    // Return contracts refine a graph; the worked example must use the real standard DSL.
    expect(index).toContain("structured-results.md");
    const snippets = javascriptDocSnippets(`${base}/structured-results.md`);
    expect(snippets.length).toBeGreaterThan(0);
    for (const snippet of snippets) {
      const workflow = standardSource(`export default async function run({ agent, input }) {\n${snippet}\n}`);
      expect(standardWorkflowSourceShapeErrors(workflow)).toEqual([]);
    }
  });

  it("distinguishes recorded discovery replay from unsafe rediscovered checkpoint identity", () => {
    const card = source("skills/locus-pi-workflow-create/references/decomposition.md");
    expect(card).toContain("agent({ handoffs })");
    expect(card).toContain("complete non-blank unique text unit");
    expect(card).toContain("prefix");
    expect(card).toContain("keys");
    expect(card).not.toContain("intentionally non-resumable");
    expect(card).toContain("Never derive resumable positional");
  });

  it("classifies every existing Package registry entry", () => {
    const profiles = Object.fromEntries(
      packagedWorkflowNames().map((name) => {
        const text = readFileSync(packagedWorkflowPath(name), "utf8");
        return [name, staticWorkflowMeta(text).profile];
      }),
    );

    expect(profiles).toEqual({
      "live-smoke": "standard",
      "task/draft": "standard",
      "task/plan": "standard",
      "post-code-review": "standard",
      "post-code-review/boundaries": "standard",
      "post-code-review/contracts": "standard",
      "post-code-review/necessity": "standard",
      "post-code-review/scope": "standard",
      "post-code-review/simplicity": "standard",
      "post-code-review/style": "standard",
      "post-code-review/synthesis": "standard",
      "stage-loop": "standard",
    });
    expect(packagedWorkflowNames()).toHaveLength(12);
    for (const name of [
      "live-smoke",
      "task/draft",
      "task/plan",
      "post-code-review",
      "post-code-review/boundaries",
      "post-code-review/contracts",
      "post-code-review/necessity",
      "post-code-review/scope",
      "post-code-review/simplicity",
      "post-code-review/style",
      "post-code-review/synthesis",
    ]) {
      expect(standardWorkflowSourceShapeErrors(readFileSync(packagedWorkflowPath(name), "utf8")), name).toEqual([]);
    }
  });

  it("reviews every paid revision and reports cap/no-progress without a final unreviewed worker", () => {
    const card = source("skills/locus-pi-workflow-create/references/bounded-refinement.md");
    const example = source("extensions/workflows/references/examples/refinement.workflow.mjs");
    expect(card).toContain("3R");
    expect(card).toContain("cap/no-progress");
    // The card used to teach `returnVia: "tool"` as the cheaper transport. There is no
    // other transport now, so what it must still teach is the COST: a format correction
    // stays inside the child that already did the work.
    expect(card).not.toContain("returnVia");
    expect(card).toContain("never adds a physical child");
    expect(example).toContain('summary: "round_cap"');
    expect(example).toContain('summary: "no_progress"');
    expect(example.indexOf('label: "worker"')).toBeLessThan(example.indexOf('label: "reviewer"'));
    expect(example.indexOf('label: "reviewer"')).toBeLessThan(example.indexOf('route === "complete"'));
    expect((example.match(/label: "worker"/gu) ?? []).length).toBe(1);
  });
});
