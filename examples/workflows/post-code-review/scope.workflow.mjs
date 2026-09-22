export const meta = {
  name: "post-code-review/scope",
  description: "Resolve a review target into an exact evidence boundary and write review-scope.md.",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  await dsl.agent(
    `Resolve the complete post-code review scope from the caller's semantic input below.

The runtime has injected the absolute project path and absolute workflow workspace/output
path into your context. Use those paths directly; do not ask the caller to translate them.
Read the live project source, Git state, and project contracts using read-only repository
and file tools. Resolve a function, file, commit, commit range, diff, or locally available
PR range without guessing. Resolve Git refs to immutable full object IDs and record exact
parent, empty-tree, endpoint-tree, or merge-base semantics as applicable. An ordinary
commit compares with its sole parent, a root commit with Git's empty tree, a merge commit
defaults to its first parent while listing all parents, a commit range uses base..head
endpoint tree semantics, and a local PR range uses merge-base(base, head)..head.

Every contract, instruction, task, specification, or documentation path admitted into
review-scope.md must be proven to exist in the reviewed tree or named local-only scope.
Do not copy a nearby document's path claim without checking it. A missing named source is
an evidence gap or false provenance anchor, not a contract the later lanes may cite.
For each admitted source, record one exact locator: reviewed-tree path plus head object id,
or local-only path plus the reason it belongs to this review.

For every historical Git target, provenance each source, policy, documentation, and
contract fact as coming from the base tree, reviewed target tree, or live descendant.
Read exact frozen bytes and diffs from the resolved objects rather than treating the
current checkout as the target. Never attribute live-only descendant content to the reviewed target.
When current project authority differs from the target tree, record both versions and
state whether the difference affects introducedness or the target's accepted boundaries.

Scope resolution is read-only mapping only. Do not execute tests, linters, typechecks,
builds, dependency resolution, index rebuilds, runtime commands, or any command that
materializes auxiliary output. Do not create caches, bytecode, indexes, reports, fixtures,
logs, build/state/evidence directories, or lock/dependency metadata. Write or replace
exactly one complete reader-facing Markdown file named review-scope.md in the injected
workflow output directory, and no other workspace file. Inability to prove execution
results is an evidence limit for later lanes, not work for scope. The report must state
the target kind, intent, exact files and symbols or lines when applicable, immutable OIDs
and Git semantics, relevant project contracts, starting source/Git state, read-only
inspection choices, and evidence limits. If the target cannot be resolved or evidence is
insufficient, write a truthful BLOCKED report rather than inventing scope. Do not modify
source files, Git refs, commits, or anything outside the output directory. Finish only
after the complete replacement review-scope.md has been written. Perform this lane within
this assigned Pi session. Do not invoke or delegate to another agent, saved workflow,
Fusion, Claude, Codex, or any other outside model/session through a tool or shell command.

Caller input:
---
${input}
---`,
    { modelRole: "smol:high", requireModelRole: true, label: "resolve post-code review scope" },
  );
  return dsl.publishPrimaryFile("review-scope.md");
}
