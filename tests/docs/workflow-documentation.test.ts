import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../contracts/helpers/package-contract.js";

const chapters = [
  "agent-results.md",
  "authoring.md",
  "budgets.md",
  "catalog.md",
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
    for (const entry of ["docs/workflows.md", "docs/locus-pi-workflows.md", "extensions/workflows/README.md"])
      expect(read(entry)).toContain(
        "docs/workflows/index.md".replace(/^docs\//u, entry.startsWith("docs/") ? "" : "docs/"),
      );
    expect(index).toContain("## What belongs here");
    expect(index).not.toMatch(/10[_,]000|3_600_000/u);
  });

  it("keeps old budget, return, source and recovery bookmarks as navigation only", () => {
    for (const [file, anchor, target] of [
      ["extensions/workflows/REFERENCE.md", "run-budget", "budgets.md#run-budget"],
      [
        "extensions/workflows/REFERENCE.md",
        "continuing-a-repaired-workflow",
        "replay.md#continuing-a-repaired-workflow",
      ],
      ["extensions/workflows/references/output-acceptance.md", "the-principle", "agent-results.md#the-principle"],
      [
        "extensions/workflows/references/execution-controls.md",
        "shared-run-budget-at-the-tool-boundary",
        "budgets.md#shared-run-budget-at-the-tool-boundary",
      ],
      [
        "extensions/workflows/references/source-shape.md",
        "machine-enforced-standard-source-shape",
        "source-shape.md#machine-enforced-standard-source-shape",
      ],
      [
        "extensions/workflows/references/recovery-and-continuation.md",
        "reconcile-an-unconfirmed-call",
        "recovery-and-continuation.md#reconcile-an-unconfirmed-call",
      ],
    ]) {
      const content = read(file!);
      expect(content).toContain(`id="${anchor}"`);
      expect(content).toContain(target);
      expect(content).not.toMatch(/10[_,]000|3_600_000|```/u);
    }
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
    expect(read("skills/locus-pi-workflow-run/SKILL.md")).toContain("For a TUI/RPC");
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
