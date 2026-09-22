export const meta = {
  name: "post-code-review/simplicity",
  description: "Audit a frozen review scope for delete-first contraction and publish simplicity findings.",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  await dsl.agent(
    `Perform the simplicity lane of a post-code review.

Semantic review target and intent:
${input}

The runtime-injected absolute workflow workspace is authoritative. Read review-scope.md there first, and do not read sibling lane reports. Then read the live project source and the evidence named by review-scope.md.

Audit only duplication, wrappers or helpers that add no value, redundant guards or fallbacks, dead or unreachable paths, unnecessary depth, fake configurability, unearned seams, misleading behavior names, and delete-first alternatives. Do not modify project/source files.

Invert the burden of proof for every wrapper, helper, field, argument, export, alias,
constant, seam, fallback, and duplicated description site changed by the reviewed work:
what breaks if it is deleted and callers use the owner directly? Search production and
runtime callers first. Tests, documentation, exports, historical compatibility, and
hypothetical future use are repair surfaces, not keep evidence, unless the accepted scope
explicitly names an external compatibility contract.

Define a contraction metric before the verdict. Record the current number and location of
the files, fields, helpers, wrappers, constants, seams, and other description sites that
encode the reviewed behavior, plus the smallest proposed after-state. Inventory current-PR
dead surface, fake parameters, duplicate ownership of one invariant, pass-through wrappers,
single-adapter seams, and names or comments that materially misdescribe behavior. Separate
immediate cleanup from unresolved future product or roadmap choices.

Assign each material simplification question one stable id in source order as S-Q-001,
S-Q-002, and so on. Preserve that id beside its evidence, answer, disposition, and required
change so later stages can close the exact question instead of renumbering prose findings.

A confirmed delete, rewrite, inline, or owner move introduced or materially worsened by the
reviewed change is a current code-shape defect even when runtime behavior succeeds. Low
impact changes verification priority, not whether that defect is required. If any such
disposition remains open, the lane verdict is FINDINGS, never PASS or RESOLVED. If the
target surface does not shrink and the caller did not choose another metric, say that the
simplification gate fails.

Perform this lane within this assigned Pi session. Do not invoke or delegate to another agent, saved workflow, Fusion, Claude, Codex, or any other outside model/session through a tool or shell command.

Filesystem contract (apply to every tool action and command, including implicit writes): every filesystem write caused by you must stay under the runtime-injected workflow workspace. This includes tool-generated caches, bytecode, indexes, reports, fixtures, logs, build/state/evidence directories, and lock/dependency metadata. Do not run a command that writes elsewhere. If a useful check has implicit output, redirect all output and cache under the workflow workspace or use a no-cache/read-only mode; otherwise record that evidence limit in the report.

Replace only review-simplicity.md in the workflow workspace. Write a complete Markdown report with scope, evidence boundary, contraction metric, production/runtime usage evidence, aggressive deletion inventory, fallback/raise map, useful positive evidence, limits, and actionable findings. Each finding must include question id, severity, precise path:line evidence, concrete risk, required change, and one disposition: keep, delete, rewrite, inline, move-owner, refuted, or out-of-scope. If evidence is insufficient or live evidence drift prevents a trustworthy conclusion, write a truthful BLOCKED report instead of guessing. Write no other artifact. Finish only after review-simplicity.md is complete.`,
    { modelRole: "smol:high", requireModelRole: true, label: "simplicity audit" },
  );
  return dsl.publishPrimaryFile("review-simplicity.md");
}
