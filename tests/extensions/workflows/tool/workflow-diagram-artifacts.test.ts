import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  packagedExamplesDir,
  packagedWorkflowPath,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";

/**
 * Diagrams used to be a generated triple — an `@kroffske/excalidraw-diagrams`
 * generator, its `.excalidraw` document, and an exported `.png`. Three files had
 * to agree, only the render was read, and the render said little the workflow
 * source did not already say. The replacement is one hand-authored SVG per
 * example, so what a reader sees is what a reviewer diffs.
 */
const RETIRED_DIAGRAM_SUFFIXES = [".diagram.mjs", ".excalidraw", ".png"];

/** Every example that still has a hand-authored diagram. */
const DRAWN = ["post-code-review"] as const;

function diagramPath(name: string): string {
  const workflowPath = packagedWorkflowPath(name);
  return path.join(path.dirname(workflowPath), `${name}-pipeline.svg`);
}

function listFilesRecursively(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  visit(root);
  return found;
}

/** Every `phase("…")` and `artifact: "…"` literal the workflow source declares. */
function declaredNames(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]!))];
}

describe("curated workflow diagrams", () => {
  it("keeps no generated Excalidraw triple anywhere under the examples directory", () => {
    const stale = listFilesRecursively(packagedExamplesDir()).filter((file) =>
      RETIRED_DIAGRAM_SUFFIXES.some((suffix) => file.endsWith(suffix)),
    );
    expect(stale).toEqual([]);
  });

  it.each(DRAWN)("ships one self-contained SVG beside %s, with nothing to fetch and nothing to run", (name) => {
    const svgPath = diagramPath(name);
    const svg = readFileSync(svgPath, "utf8");

    expect(svg.trimStart().startsWith("<svg"), svgPath).toBe(true);
    expect(svg, svgPath).toContain("viewBox=");
    // A diagram a screen reader cannot describe is a picture, not documentation.
    expect(svg, svgPath).toMatch(/<title(?:\s[^>]*)?>/u);
    expect(svg, svgPath).toMatch(/<desc(?:\s[^>]*)?>/u);

    // Self-contained: an SVG that pulls a font, an image, or a script is not a
    // file a reviewer can read, and in a published package it is a request the
    // reader never asked to make.
    expect(svg, svgPath).not.toMatch(/<script/iu);
    expect(svg, svgPath).not.toMatch(/<image/iu);
    expect(svg, svgPath).not.toMatch(/\shref=|xlink:href=/u);
    // `url(#marker)` points inside this file; anything else points outside it.
    expect(svg, svgPath).not.toMatch(/@import|url\(\s*['"]?(?!#)/u);
    // Namespace declarations are the one allowed absolute URL: they name the
    // dialect, they are never fetched.
    expect(svg.replace(/xmlns(:[a-z]+)?="[^"]*"/gu, ""), svgPath).not.toMatch(/https?:\/\//u);

    // T-108 removed `llm()` from the DSL; a diagram may not advertise a
    // primitive the reader cannot find.
    expect(svg, svgPath).not.toMatch(/llm\(/iu);
  });

  it("does not retain the removed critic-loop diagram for the minimal plan graph", () => {
    expect(() => readFileSync(diagramPath("plan"), "utf8")).toThrow();
  });

  it("shows every post-code-review workflow boundary, phase, model role, and Markdown handoff", () => {
    const parentPath = packagedWorkflowPath("post-code-review");
    const parent = readFileSync(parentPath, "utf8");
    const svg = readFileSync(diagramPath("post-code-review"), "utf8");
    const packageChildren = declaredNames(parent, /\bchild:\s*"([^"]+)"/gu);

    expect(packageChildren).toEqual([
      "scope",
      "boundaries",
      "simplicity",
      "contracts",
      "style",
      "necessity",
      "synthesis",
    ]);
    for (const phase of declaredNames(parent, /\bphase\("([^"]+)"\)/gu)) {
      expect(svg, `post-code-review diagram omits phase ${phase}`).toContain(phase);
    }
    for (const child of packageChildren) {
      expect(svg, `post-code-review diagram omits child ${child}`).toContain(child);
      const childSource = readFileSync(packagedWorkflowPath(`post-code-review/${child}`), "utf8");
      expect(childSource, `post-code-review/${child} permits model-role fallback`).toContain("requireModelRole: true");
      for (const artifact of declaredNames(childSource, /\bpublishPrimaryFile\("([^"]+)"\)/gu)) {
        expect(svg, `post-code-review diagram omits artifact ${artifact}`).toContain(artifact);
      }
    }
    expect(svg).toContain('modelRole "smol:high"');
    expect(svg).toContain('modelRole "smol:xhigh"');
    expect(svg).toContain("final QA remains separate");
    expect(svg).toContain("Operator:");
    expect(svg).toContain("Workflow:");
    expect(svg).toContain("Agent:");
    expect(svg).toContain("Artifact:");
  });

  it("challenges proposed fixes before synthesis and respects trusted external ownership", () => {
    const scope = readFileSync(packagedWorkflowPath("post-code-review/scope"), "utf8");
    const boundaries = readFileSync(packagedWorkflowPath("post-code-review/boundaries"), "utf8");
    const simplicity = readFileSync(packagedWorkflowPath("post-code-review/simplicity"), "utf8");
    const contracts = readFileSync(packagedWorkflowPath("post-code-review/contracts"), "utf8");
    const style = readFileSync(packagedWorkflowPath("post-code-review/style"), "utf8");
    const necessity = readFileSync(packagedWorkflowPath("post-code-review/necessity"), "utf8");
    const synthesis = readFileSync(packagedWorkflowPath("post-code-review/synthesis"), "utf8");
    const readme = readFileSync(path.join(path.dirname(packagedWorkflowPath("post-code-review")), "README.md"), "utf8");

    expect(scope).toContain("must be proven to exist in the reviewed tree");
    expect(scope).toContain("false provenance anchor");
    expect(scope).toContain("reviewed-tree path plus head object id");
    expect(scope).toContain("base tree, reviewed target tree, or live descendant");
    expect(scope).toContain("Never attribute live-only descendant content to the reviewed target");

    expect(boundaries).toContain("B-Q-001");
    expect(boundaries).toContain("exact reviewed target tree");

    expect(simplicity).toContain("Invert the burden of proof");
    expect(simplicity).toContain("Search production and");
    expect(simplicity).toContain("Define a contraction metric");
    expect(simplicity).toContain("S-Q-001");
    expect(simplicity).toContain("current code-shape defect even when runtime behavior succeeds");
    expect(simplicity).toContain("FINDINGS, never PASS or RESOLVED");

    expect(contracts).toContain("Do not require duplicate local leaf validation merely because data is external");
    expect(contracts).toContain("accepted responsibility boundary rather than a defect");
    expect(contracts).toContain("duplicate owner of one invariant");
    expect(contracts).toContain("C-Q-001");
    expect(contracts).toContain("concrete silent-drift failure");
    expect(contracts).toContain("stale derived documentation changed by the PR");
    expect(contracts).toContain("exact reviewed target tree");

    expect(style).toContain("Read review-scope.md there first, then read style.md");
    expect(style).toContain("an empty file means that the operator supplied no additional style criteria");
    expect(style).toContain("misleading, stale, redundant, or missing comments");
    expect(style).toContain("turn personal taste into a defect");
    expect(style).toContain("classify it as NO_ACTION polish rather than a finding");
    expect(style).toContain("ST-Q-001");

    expect(necessity).toContain("What real failure or violated contract is proven?");
    expect(necessity).toContain("Which component owns that guarantee?");
    expect(necessity).toContain("duplicate validation or responsibility");
    expect(necessity).toContain("the simplest way to close the proven risk");
    expect(necessity).toContain("documentation and tests prove that a dependency exists and is exercised");
    expect(necessity).toContain("is not duplicate validation when the old check is removed");
    expect(necessity).toContain("not limited to a runtime crash or a failing");
    expect(necessity).toContain("Tests and documentation alone do not earn an internal surface");
    expect(necessity).toContain("Split a bundled proposal");
    expect(necessity).toContain("preserve its lane question id without renumbering");
    expect(necessity).toContain("Every material lane question id must appear exactly once");
    expect(necessity).toContain("RETAIN");
    expect(necessity).toContain("REFRAME");
    expect(necessity).toContain("REJECT");
    expect(necessity).toContain("BLOCKED");
    expect(necessity).toContain("exact reviewed target tree");
    expect(necessity).toContain("descendant repaired, moved, or admitted it");

    expect(synthesis).toContain("The necessity challenge is an admission gate, not another vote");
    expect(synthesis).toContain("must not restore a proposal that the necessity challenge rejected");
    expect(synthesis).toContain("absence of repeat local validation is an accepted responsibility boundary");
    expect(synthesis).toContain("Do not treat current documentation or tests as proof");
    expect(synthesis).toContain(
      "Apply two evidence paths instead of reducing every review question to a failing consumer",
    );
    expect(synthesis).toContain("current code-shape defect");
    expect(synthesis).toContain("does not require a runtime crash");
    expect(synthesis).toContain("Low impact changes verification priority");
    expect(synthesis).toContain("This is not a final merge or QA verdict");
    expect(synthesis).toContain("Every material lane question id must appear exactly once");
    expect(synthesis).toContain("READY_WITH_RECOMMENDATIONS");
    expect(synthesis).toContain("CHANGES_REQUIRED");
    expect(synthesis).toContain("Action: REQUIRED, RECOMMENDED, or NO_ACTION");
    expect(synthesis).toContain("Impact: high, medium, or low");
    expect(synthesis).toContain("illustrative fix snippet");
    expect(synthesis).toContain("Do not include a snippet");
    expect(synthesis).toContain("positive evidence, accepted boundary, and NO_ACTION architecture claim");
    expect(synthesis).toContain("live-only descendant policy is current context, not target evidence");
    expect(synthesis).toContain("/workflows run implement");

    expect(readme).toContain("assign the portable `smol` role through `/model-roles`");
    expect(readme).toContain("replay starts no child and remains marked as not-fresh evidence");
    expect(readme).toContain("dead surface, fake parameter, duplicated");
    expect(readme).toContain("not the final QA or merge verdict");
  });
});
