export const meta = {
  name: "evaluator-optimizer",
  description: "Implement a task, review the actual change, and correct once if needed.",
  profile: "standard",
};

export default async function run({ agent }, input) {
  const context = `Use injected pwd/project root for execution context; verify the requested checkout and branch.
The input supplies the original Task, sources, product root and exact orchestration file paths.
Read those sources; missing or conflicting context/paths means blocked. Do not guess destinations.`;
  // Teaching bound: initial implementation plus one correction, both independently reviewed.
  for (let round = 0; round < 2; round += 1) {
    const work = await agent(
      `${context}\nOriginal Task and working context:\n${input}
Implement the Task in its assigned product root; choose internal files within its bounds.
Preserve unrelated work; do not commit. On correction, read the assigned findings.md and implementation.md.
Write the complete result, changed paths, actual checks and remaining work to assigned implementation.md;
read it back. Return only a short status and its exact path. This is pass ${round + 1}.`,
      { label: "implement", title: "Implement or correct the task" },
    );
    const decision = await agent(
      `${context}\nOriginal Task and working context:\n${input}
Read assigned implementation.md, then inspect the complete actual diff and required evidence.
Verify each Task requirement; equal outputs do not prove reuse or state transitions.
Do not edit product source. Write only assigned findings.md: verified/unmet/unverified requirements, defects,
checks, prior finding dispositions and next action, keep optional checks separate. Read it back.
Accept only verified requirements; revise correctable defects;
block on missing required prerequisites or handoff files. Worker status:\n${work}`,
      { label: "review", title: "Review the change", choice: ["accept", "revise", "blocked"] },
    );
    if (decision === "accept") return { ok: true, status: "accepted", handoff: work };
    if (decision === "blocked") return { ok: false, status: "blocked", handoff: work };
    if (round === 1) {
      return { ok: false, status: "incomplete", reason: "correction_allowance", handoff: work };
    }
  }
}
