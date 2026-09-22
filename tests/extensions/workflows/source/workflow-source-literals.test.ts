/**
 * Three owners read a workflow source statically and decide different things
 * about it: `catalog/workflow-meta.ts` scans a bounded prefix tolerantly,
 * `runtime/workflow-script-identity.ts` assesses identity, and
 * `tool/workflow-source-shape.ts` validates the published standard grammar.
 * They disagree about failure on purpose, but they share one lexical layer in
 * `source/workflow-source-literals.ts` and must never disagree about what a
 * literal spells.
 *
 * Each case therefore asks all three owners the same lexical question about the
 * same bytes and pins their answers together.
 */
import { describe, expect, it } from "vitest";
import { staticWorkflowMeta } from "../../../../extensions/workflows/catalog/workflow-meta.js";
import { assessWorkflowSourceIdentity } from "../../../../extensions/workflows/runtime/workflow-script-identity.js";
import { standardWorkflowSourceShapeDiagnostics } from "../../../../extensions/workflows/tool/workflow-source-shape.js";

/** A lone backslash, so the sources below carry escape sequences rather than what they denote. */
const BACKSLASH = String.fromCharCode(92);
const ESCAPED_SPACE = `${BACKSLASH}u0020`;
const ESCAPED_HYPHEN = `${BACKSLASH}u002d`;

/** A standard workflow whose declared phase title is also the title it calls. */
function phasedSource(metaLines: readonly string[], calledTitle: string): string {
  return [
    "export const meta = {",
    ...metaLines,
    "};",
    `export default function run({ phase }) { phase(${JSON.stringify(calledTitle)}); return { ok: true }; }`,
    "",
  ].join("\n");
}

describe("workflow source literals shared by every static reader", () => {
  it("spells quoted keys and escape sequences the same way in all three readers", () => {
    // Every key is quoted and every value carries a unicode escape, so each
    // reader has to both unquote the key and decode the value to agree.
    const source = phasedSource(
      [
        `  "name": "sample",`,
        `  "profile": "standard",`,
        `  "identityCoverage": "self-contained${ESCAPED_HYPHEN}static",`,
        `  "description": "Line${ESCAPED_SPACE}one",`,
        `  "phases": [{ "title": "Scope${ESCAPED_SPACE}check" }]`,
      ],
      "Scope check",
    );

    expect(staticWorkflowMeta(source)).toEqual({
      description: "Line one",
      profile: "standard",
      phases: [{ title: "Scope check" }],
    });
    expect(assessWorkflowSourceIdentity(source).identityCoverage).toBe("self-contained-static");
    // The checker matched the escaped declaration against the plain call, so it
    // decoded ` ` to the same space the other two readers decoded.
    expect(standardWorkflowSourceShapeDiagnostics(source)).toEqual([]);
  });

  it("rejects an interpolated template literal as non-static in all three readers", () => {
    const source = phasedSource(
      [`  name: "sample",`, `  profile: "standard",`, "  phases: [{ title: `Scope ${suffix}` }]"],
      "Scope check",
    );
    const withBinding = `const suffix = "check";\n${source}`;

    // The title is knowable only by running the module, so no reader claims it.
    expect(staticWorkflowMeta(withBinding).phases).toEqual([]);
    expect(standardWorkflowSourceShapeDiagnostics(withBinding).map((diagnostic) => diagnostic.code)).toEqual([
      "WF_META_PROFILE",
    ]);
    expect(() =>
      assessWorkflowSourceIdentity(
        [
          `const kind = "static";`,
          "export const meta = { identityCoverage: `self-contained-${kind}` };",
          "export default () => true;",
          "",
        ].join("\n"),
      ),
    ).toThrow(/must be the literal/u);
  });

  it("treats a computed key as no key in all three readers", () => {
    const source = [
      `const phasesKey = "phases";`,
      phasedSource(
        [`  name: "sample",`, `  profile: "standard",`, `  [phasesKey]: [{ title: "Scope check" }]`],
        "Scope check",
      ),
    ].join("\n");

    expect(staticWorkflowMeta(source).phases).toEqual([]);
    expect(standardWorkflowSourceShapeDiagnostics(source).map((diagnostic) => diagnostic.code)).toEqual([
      "WF_META_PROFILE",
      "WF_POLICY",
    ]);
    // The computed key declares no coverage, so the unbound import stays
    // unacknowledged — the error names the missing declaration rather than an
    // invalid one.
    expect(() =>
      assessWorkflowSourceIdentity(
        [
          `const coverageKey = "identityCoverage";`,
          `export const meta = { [coverageKey]: "entry-only" };`,
          `import "./helper.mjs";`,
          "",
        ].join("\n"),
      ),
    ).toThrow(/outside self-contained-static identity/u);
  });

  it("reads no string from a value that is not a string literal", () => {
    const numericTitle = phasedSource(
      [
        `  name: "sample",`,
        `  profile: "standard",`,
        `  description: 42,`,
        `  phases: [{ title: "Scope check" }, { title: 42 }]`,
      ],
      "Scope check",
    );

    expect(staticWorkflowMeta(numericTitle).description).toBeUndefined();
    // All three read no string from `42`; what each then does with that is its
    // own policy and stays different on purpose. The tolerant scanner distrusts
    // a partly non-literal declaration and reports no phases at all...
    expect(staticWorkflowMeta(numericTitle).phases).toEqual([]);
    // ...while the checker keeps the literal sibling and simply has no title
    // from `42`, so nothing is reported as uncalled...
    expect(standardWorkflowSourceShapeDiagnostics(numericTitle)).toEqual([]);
    // ...while a real uncalled string title in the same position still is.
    const stringTitle = numericTitle.replace("{ title: 42 }", `{ title: "Review" }`);
    expect(standardWorkflowSourceShapeDiagnostics(stringTitle).map((diagnostic) => diagnostic.code)).toEqual([
      "WF_PHASE_UNUSED_DECLARATION",
    ]);
    expect(() =>
      assessWorkflowSourceIdentity(
        ["export const meta = { identityCoverage: 42 };", "export default () => true;", ""].join("\n"),
      ),
    ).toThrow(/must be the literal/u);
  });
});
