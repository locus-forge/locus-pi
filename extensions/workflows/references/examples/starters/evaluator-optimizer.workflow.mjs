export const meta = {
  name: "evaluator-optimizer",
  description: "Implement known scope with reviewer-owned feedback and one correction/recheck",
  profile: "standard",
};

export default async function run({ agent, publishArtifact, publishPrimaryArtifact }, input) {
  // Teaching allowance: initial work plus one correction, each followed by review.
  // Choose a task-derived allowance in the design; this is not a global retry default.
  let previousWork = "";
  for (let round = 0; round < 2; round += 1) {
    const work = await agent(
      `Implement the requested behavior and required checks in the existing checkout. Preserve unrelated work; do not commit. Inspect the actual state. ` +
        `On a correction pass, read findings.md at its exact caller-assigned path and address its concrete findings. Write the complete handoff to the assigned implementation.md using ordinary file tools. Return changed paths, artifact locations, actual checks and remaining work. ` +
        `Every named file means its exact path assigned in this whole input, preferably absolute; missing or ambiguous assignments are unmet required evidence. Never guess a runtime folder or fallback file. Original request:\n${input}\nPrevious complete handoff:\n${previousWork}`,
      { label: "implement", title: "Implement or correct the requested behavior" },
    );
    const decision = await agent(
      `Independently inspect the complete current diff, including uncommitted work, and actual evidence against the original request. Do not edit product source. ` +
        `Read prior findings.md if present, then replace it with criteria, observed defects, missing required evidence, optional checks not performed, and actionable feedback. Retain prior check outcomes and their dispositions. ` +
        `Choose accept only when required behavior and evidence are established; disclose unavailable optional checks without claiming they passed. ` +
        `Choose revise for correctable findings, or blocked for a concrete unavailable required prerequisite. Do not weaken the criteria. ` +
        `Every named file means its exact path assigned in this whole input, preferably absolute; missing or ambiguous assignments are unmet required evidence. Never guess a runtime folder or fallback file. Original request:\n${input}\nComplete worker handoff:\n${work}`,
      {
        label: "review",
        title: "Review the actual change and choose the next action",
        choice: ["accept", "revise", "blocked"],
      },
    );
    const evidence = publishArtifact(`reviewed-work-${round + 1}.md`, work);
    if (decision === "accept") return publishPrimaryArtifact("implementation.md", work);
    if (decision === "blocked") {
      return { ok: false, status: "blocked", evidence, findings: "findings.md", currentWork: work };
    }
    if (round === 1) {
      return {
        ok: false,
        status: "incomplete",
        reason: "correction_allowance",
        evidence,
        findings: "findings.md",
        currentWork: work,
        next_action: "Inspect findings.md and the preserved change before choosing further work.",
      };
    }
    previousWork = work;
  }
}
