import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../contracts/helpers/package-contract.js";

const chapters = [
  "agent-results.md",
  "authoring.md",
  "budgets.md",
  "catalog.md",
  "create.md",
  "dsl.md",
  "error-diagnostics.md",
  "evidence.md",
  "fusion.md",
  "index.md",
  "inspection.md",
  "models.md",
  "outcomes.md",
  "recovery-and-continuation.md",
  "replay.md",
  "running.md",
  "source-shape.md",
  "trust.md",
];
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const workflowLaunchDefaults =
  "Workflow launch defaults are mode-scoped: every run defaults to `concurrency = 4`; headless Pi `print`/`json` root launches additionally default to `totalAgents = 10_000`, shared across fresh physical child attempts made by the root, saved children and Fusion; `totalAgents` is unbounded in TUI/RPC. Every other undeclared workflow budget axis is unbounded.";

describe("installed workflow documentation ownership", () => {
  it("publishes a reviewed topical inventory reachable from the workflow entry", () => {
    expect(readdirSync(path.join(root, "docs/workflows")).sort()).toEqual(chapters);
    const index = read("docs/workflows/index.md");
    for (const chapter of chapters.filter((file) => file !== "index.md")) expect(index).toContain(`](${chapter}`);
    expect(read("extensions/workflows/README.md")).toContain("docs/workflows/index.md");
    expect(index).toContain("## What belongs here");
    expect(index).not.toMatch(/10[_,]000|3_600_000/u);
  });

  it("retires former documentation addresses instead of publishing parallel entrypoints", () => {
    for (const file of [
      "docs/workflows.md",
      "docs/locus-pi-workflows.md",
      "extensions/workflows/REFERENCE.md",
      ...[
        "output-acceptance",
        "execution-controls",
        "source-shape",
        "recovery-and-continuation",
        "error-diagnostics",
        "patterns",
      ].map((name) => `extensions/workflows/references/${name}.md`),
      "examples/README.md",
    ])
      expect(existsSync(path.join(root, file)), file).toBe(false);
  });

  it("routes machine-visible contract prose to the same public owners", () => {
    expect(read("extensions/workflows/tool/workflow-tool.ts")).toContain("docs/workflows/index.md");
    for (const file of ["docs/workflows/budgets.md", "extensions/workflows/manifest.json"])
      expect(read(file), file).toContain(workflowLaunchDefaults);
    expect(read("extensions/workflows/manifest.json")).not.toContain(
      "execution budgets are explicit-only and there are no package defaults",
    );
    expect(read("docs/workflows/authoring.md")).not.toContain("package defaults are the emergency policy");
    expect(read("skills/locus-pi-workflow-create/references/design-and-build.md")).toContain(
      "launch defaults apply; every other undeclared workflow budget axis is unbounded",
    );
    expect(read("skills/locus-pi-workflow-run/SKILL.md")).toContain("docs/workflows/budgets.md#run-budget");
    const replay = read("docs/workflows/replay.md");
    for (const field of ["timeoutMs", "maxTurns", "maxToolCalls", "returnContract"])
      expect(replay.split("## What is compared\n")[1]?.split("## Continuing a repaired workflow")[0]).toContain(field);
    expect(replay.split("| Miss")[1]?.split("A `fusion()`")[0]).toContain("return-contract-changed");
    for (const skill of ["create", "run"]) {
      const router = read(`skills/locus-pi-workflow-${skill}/SKILL.md`);
      expect(router).not.toMatch(/None has a package default|Unspecified axes stay unbounded/u);
      expect(router).toContain("docs/workflows/budgets.md#run-budget");
    }
    for (const file of ["extensions/workflows/runtime/workflow-budget.ts", "extensions/agents/run/run-launcher.ts"])
      expect(read(file)).toContain("docs/workflows/budgets.md#run-budget");
    for (const chapter of chapters)
      expect(read(`docs/workflows/${chapter}`)).not.toMatch(
        /\]\([^)]*extensions\/workflows\/(?:REFERENCE\.md|references\/(?:output-acceptance|execution-controls|source-shape|recovery-and-continuation|error-diagnostics)\.md)/u,
      );
  });
});
