export const meta = {
  name: "post-code-review/necessity",
  description: "Challenge behavioral and code-shape fixes for necessity, ownership, and complexity.",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  await dsl.agent(
    `Challenge the proposed findings and fixes from a post-code review.

Semantic review target and intent:
${input}

Read review-scope.md, review-boundaries.md, review-simplicity.md, review-contracts.md, and review-style.md from the runtime-injected shared workflow output directory. Then inspect the live source, supported consumers, project contracts, specifications, decisions, tests, style conventions, and dependency documentation needed to evaluate the recommendations. Audit the proposed findings and required changes, not the codebase in general. Do not invent an additional review lane or reward agreement among lane reports as evidence.

For a commit, range, diff, or PR target, verify each proposal's failure,
introducedness, owner, and accepted boundary against the exact reviewed target tree and
diff. Keep current descendant authority separately labelled. Do not reject a real target
defect merely because a descendant repaired, moved, or admitted it, and do not retain a
proposal by citing policy that did not exist in the target tree.

For every proposed finding and required action, preserve its lane question id without renumbering and answer all four questions with concrete path:line, symbol, contract, or supported-consumer evidence:
1. What real failure or violated contract is proven?
2. Which component owns that guarantee?
3. Would the proposed fix duplicate validation or responsibility already owned by an external dependency or another component?
4. Is the proposed fix the simplest way to close the proven risk without making the system more complex than the original code?

For this review, a real current defect is not limited to a runtime crash or a failing
consumer. It also includes code shape introduced or materially worsened by the reviewed
change: consumerless or dead surface, fake configurability, duplicate ownership of one
invariant, a wrapper or seam without policy or production variation, stale derived
documentation changed by the PR, a misleading behavior description, or responsibility
drift. Do not downgrade such a confirmed defect merely because current execution succeeds.
Tests and documentation alone do not earn an internal surface under delete-first review.

Split a bundled proposal when immediate current-PR cleanup and future roadmap or product
work need different action levels. A safe local delete, rewrite, inline, documentation
repair, or owner move must not be hidden inside a non-blocking future milestone. Conversely,
do not turn an unresolved future product decision into required cleanup.

Assign exactly one disposition to each proposal: RETAIN when all four answers support the finding and its action; REFRAME when the defect is real but ownership or the simplest fix differs; REJECT when failure, ownership, non-duplication, or net benefit is not proven; BLOCKED when required live evidence is unavailable. A finding is not confirmed until all four questions have evidence-backed answers. Treat an explicitly documented trusted external provider as the owner of its declared field type/value guarantees unless live evidence proves the local component claims a stricter contract, transforms the value into a locally owned invariant, or a supported consumer actually fails at the boundary. In that trusted-provider case, absence of repeat local validation is an accepted responsibility boundary, not a defect. Do not retain speculative hardening, defense in depth, or future-proofing as a current defect. Prefer deleting or narrowing a recommendation over adding machinery without proven user or consumer value.

A real violated contract includes a proven ownership or dependency-direction boundary that forces a supported narrower-layer consumer to depend on an unrelated broader runtime, even when no runtime crash has occurred yet. Current documentation and tests prove that a dependency exists and is exercised; they do not by themselves prove that the dependency belongs to that component. Resolve conflicts among a component's stated narrow responsibility, its imports, its supported consumers, and broader integration behavior instead of treating the broadest current implementation as automatically authoritative. Moving an existing check out of the wrong narrow-layer owner into the existing integration owner is not duplicate validation when the old check is removed; adding a second check while retaining the first is duplication. Judge the smallest ownership-correct move, including renaming a surface when its current broad responsibility is intentional.

Perform this challenge within this assigned Pi session. Do not invoke or delegate to another agent, saved workflow, Fusion, Claude, Codex, or any other outside model/session through a tool or shell command. Do not modify project source. Every agent-caused filesystem write, including tool-generated caches, bytecode, indexes, reports, fixtures, logs, build/state/evidence directories, and lock/dependency metadata, must stay under the runtime-injected workflow workspace; do not run a command that writes elsewhere. If a useful check has implicit output, redirect all output and cache under the workspace or use a no-cache/read-only mode; otherwise record it as an evidence limit.

Write or replace exactly one complete Markdown file named review-necessity.md in the workflow workspace. Include the semantic scope, one four-question decision record per preserved lane question id, its disposition, the simplest justified action for retained or reframed findings, rejected complexity, evidence gaps, and limits. Every material lane question id must appear exactly once; missing or duplicate ids make the challenge BLOCKED. Write no other artifact. Finish only after review-necessity.md is complete.`,
    { modelRole: "smol:xhigh", requireModelRole: true, label: "challenge review fix necessity" },
  );
  return dsl.publishPrimaryFile("review-necessity.md");
}
