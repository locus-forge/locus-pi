export const meta = {
  name: "post-code-review/boundaries",
  description: "Audit ownership and architecture boundaries, then publish review-boundaries.md.",
  profile: "standard",
};

export default async function run(dsl, input) {
  await dsl.agent(
    `Perform only the boundaries lane of a post-code review.

Semantic review input:
${input}

Use only the runtime-injected absolute project and workspace paths. Do not invent or derive relative paths. Reopen the complete named review-scope.md from the runtime-injected workspace before making claims. Do not read review-simplicity.md, review-contracts.md, or any sibling report.

Read live project evidence independently. Audit only ownership and architecture boundaries: owner and folder placement, directory or layer boundaries, dependency direction, coupling, facades, seams, and material boundary drift. Do not perform simplicity, duplication, dead-path, API-contract, consumer, documentation, or test-alignment review except where directly required as boundary evidence. Assign each material question one stable id in source order as B-Q-001, B-Q-002, and so on. Cite every actionable finding with its question id, repository-resolvable path:line evidence, concrete consumer or maintenance risk, and required change. Distinguish confirmed findings, positive evidence, unknowns, and limits; never guess. If live source has materially drifted from the scope, report semantic BLOCKED with evidence and limits.

For a commit, range, diff, or PR target, verify every placement or dependency-direction
finding and every positive or NO_ACTION boundary claim against the exact reviewed target tree
and its diff. Compare current live policy separately. A config key or allowlist added only
in a descendant cannot prove that the reviewed target admitted an edge. A hard-coded test
whitelist proves executable acceptance only; it does not override a contradictory owning
AGENTS.md, package README, ADR, or declared dependency contract in the target tree.

Filesystem-write contract: every filesystem write caused by you or by a tool/command you run—including caches, bytecode, indexes, reports, fixtures, logs, build/state/evidence directories, and lock/dependency metadata—must stay under the runtime-injected workspace. Do not run any command that writes elsewhere. If a useful check has implicit output, redirect all output and cache under the workspace or use a no-cache/read-only mode; otherwise record the check as an evidence limit.

Perform this lane within this assigned Pi session. Do not invoke or delegate to another agent, saved workflow, Fusion, Claude, Codex, or any other outside model/session through a tool or shell command.

Write or replace exactly one complete Markdown file named review-boundaries.md in the runtime-injected workspace. It must state the reviewed scope, this lane's PASS, FINDINGS, or semantic BLOCKED verdict, findings, positive evidence, and limits. Do not modify project source, commits, Git state, or any file outside the runtime-injected workspace. Write no other artifact. Finish only after the complete replacement file is written.`,
    { modelRole: "smol:high", requireModelRole: true },
  );

  return dsl.publishPrimaryFile("review-boundaries.md");
}
