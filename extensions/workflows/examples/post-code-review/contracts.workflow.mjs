export const meta = {
  name: "post-code-review/contracts",
  description: "Audit API and internal contracts for one post-code review scope.",
  profile: "standard",
};

export default async function run(dsl, input) {
  await dsl.agent(
    `Perform only the contracts lane of a post-code review.

Semantic review input:
${input}

First use a real read tool to reopen the complete review-scope.md from the runtime-injected absolute workflow output directory. Do not read review-boundaries.md, review-simplicity.md, or any other sibling lane report. Then independently inspect live project source and the contract evidence named by review-scope.md.

For a commit, range, diff, or PR target, verify every claimed contract, config key,
composition exception, owner, and consumer against the exact reviewed target tree and diff.
Keep live descendant authority as separately labelled current context. Never use policy added
after the target as proof that the target already satisfied or admitted a contract.

Perform this lane within this assigned Pi session. Do not invoke or delegate to another agent, saved workflow, Fusion, Claude, Codex, or any other outside model/session through a tool or shell command.

	Audit only APIs and internal contracts, callers and consumers, types, errors, defaults, documentation, tests, specs, decisions, and diff-to-intent alignment. Treat the accepted included/excluded/local-only delivery scope in review-scope.md as authoritative: absence from public/package/tracked surfaces is not a defect when explicitly excluded, while named local or ignored evidence must be inspected directly. For every removed, renamed, or canonicalized contract surface, build a closed inventory across tracked code, operator commands/docs, config, scripts, and tests, including unchanged and explicitly allowlisted files. Prove each in-scope speaker has a replacement or installation/composition owner and consistent downstream value semantics; an allowlist is not an executable contract. Trace affected consumers and distinguish observed evidence, inference, unknowns, and limits. Assign each material question one stable id in source order as C-Q-001, C-Q-002, and so on. Cite that id plus exact path:line or symbol evidence. Each finding must name severity, the proven contract failure or breached boundary, the component that owns the guarantee, the affected caller or consumer, and the simplest required change. Treat speculative future-only hardening as an enhancement. Treat a confirmed duplicate owner of one invariant, stale derived documentation changed by the PR, or a contract description that contradicts live behavior as a current code-shape defect even when no supported consumer has failed yet. A duplicate-invariant finding must state the value that must stay equal, its current owner, and the concrete silent-drift failure; otherwise classify the repetition as coincidental and take no action.

Apply this general contract checklist to every parsed or migrated contract: first identify which component owns each guarantee and whether the project explicitly trusts an external provider for field types or values. Do not require duplicate local leaf validation merely because data is external. When the project accepts the provider's guarantee and no supported consumer failure or breached local integrity boundary is proven, record that as an accepted responsibility boundary rather than a defect. Require local validation only when the reviewed component owns or claims the guarantee, translates or canonicalizes the value into a stricter local contract, or a concrete supported-consumer failure or integrity breach proves the check necessary. For locally owned validation, enumerate every declared field and trace the actually invoked owner-compatible type/value validator, including language coercion traps such as bool-as-number. Also verify every referenced path is inventoried and contained before reading it; verify every canonicalized identity value is the same projection consumed downstream rather than a raw divergent value; and preserve the closed old-speaker inventory across unchanged/allowlisted consumers and operator commands. Whenever parser or validator ownership moved or was reimplemented, build a base-owner-to-head-consumer parity matrix covering every locally owned declared field, referenced path, validation call, canonical projection, and downstream use. Exact key presence or content hash is insufficient only for guarantees the local component actually owns. Classify every relaxed locally owned guarantee with introducedness. Include the reviewed scope and intent, positive evidence, actionable findings, accepted trust boundaries, and limits. If evidence is insufficient or live source is materially unavailable, write a truthful semantic BLOCKED result rather than guessing.

Write or replace exactly one complete Markdown file named review-contracts.md in the runtime-injected absolute workflow output directory. Every filesystem write caused by you or by a tool you run—including caches, bytecode, indexes, reports, fixtures, logs, build/state/evidence directories, and lock/dependency metadata—must stay under that workflow directory; do not run a command that writes elsewhere. The workflow directory is not scratch space: do not materialize diffs, excerpts, context bundles, command output, temporary files, or intermediate notes there. Read evidence directly and keep transient reasoning in the session. If a useful check has implicit output, use a genuinely no-write mode; otherwise record it as an evidence limit. Do not modify project source or Git state, read sibling reports, or write outside the workflow output directory. Write no other artifact. Finish only after the complete replacement file is written.`,
    { modelRole: "smol:xhigh", requireModelRole: true, label: "audit post-code review contracts" },
  );

  return dsl.publishPrimaryFile("review-contracts.md");
}
