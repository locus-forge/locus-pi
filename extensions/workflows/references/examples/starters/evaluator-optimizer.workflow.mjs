export const meta = {
  name: "evaluator-optimizer",
  description: "Implement a task, review the actual change, and correct once if needed.",
  profile: "standard",
};

export default async function run({ agent }, input) {
  // Keep the caller's Task, constraints and assigned paths whole for each clean child.
  // One correction is available. Every change gets a fresh review.
  for (let round = 0; round < 2; round += 1) {
    // The worker owns the plan, product edits and implementation handoff.
    const work = await agent(
      `Task and assigned paths:\n${input}
Verify checkout, branch, product root and assigned paths. Read assigned Task sources.
Stop on missing or conflicting prerequisites.
Round ${round + 1}. On correction, first read assigned findings.md and implementation.md.
State the approach, work order and checks before edits. Implement in the assigned product root.
Preserve unrelated work. Commit required files only with authorization for that repository.
Replace assigned implementation.md with the plan, changes, checks and remaining work. Reread it.
Return a short status and its exact path.`,
      { label: "implement", title: "Implement or correct the task" },
    );
    // The reviewer opens the real files. The workflow routes on its choice.
    const decision = await agent(
      `Task and assigned paths:\n${input}
Verify checkout, branch, product root and assigned paths. Read assigned Task sources.
Read assigned implementation.md and inspect the product, including uncommitted changes.
Verify each Task requirement. Check required state changes or reuse directly.
Leave the product unchanged. Use assigned scratch for checks that write.
Write and reread assigned findings.md with checks, coverage, actionable defects and prior dispositions.
Mark requirements verified, unmet or unverified. Accept only on evidence, revise fixable defects,
or block on missing or conflicting prerequisites or handoffs. Worker status:\n${work}`,
      { label: "review", title: "Review the change", choice: ["accept", "revise", "blocked"] },
    );
    if (decision === "accept") return { ok: true, status: "accepted", handoff: work };
    if (decision === "blocked") return { ok: false, status: "blocked", handoff: work };
    if (round === 1) {
      return { ok: false, status: "incomplete", reason: "correction_allowance", handoff: work };
    }
  }
}
