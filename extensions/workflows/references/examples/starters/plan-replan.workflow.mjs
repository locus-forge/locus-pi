export const meta = {
  name: "plan-replan",
  description: "Revise a named sequential plan from observed execution results",
  profile: "standard",
};

export default async function run({ agent, publishArtifact, publishPrimaryArtifact }, input) {
  // Teaching allowance: three work opportunities, then one final plan assessment.
  // Adapt it to the task; preserve every unmet requirement when it is exhausted.
  let lastResult = "";
  for (let pass = 0; pass <= 3; pass += 1) {
    const next = await agent(
      `Own the task plan. Inspect the original requirements, current source and actual evidence. Read plan.md in the workflow workspace if it exists, ` +
        `then replace it with completed evidence, remaining requirements and the revised sequence. On work, replace next-step.md with one complete in-scope brief. ` +
        `Replan from observed results; never drop unmet requirements. Include any independent verification explicitly required by the task as work before completion. ` +
        `Choose complete only when every required outcome and check is evidenced, work when an executable step remains, or blocked for a concrete unavailable required prerequisite. ` +
        `Stay within authorized scope and effects. Original task:\n${input}\nPrevious complete execution handoff:\n${lastResult}`,
      { label: "plan", title: "Plan or replan from actual results", choice: ["work", "complete", "blocked"] },
    );
    if (next === "blocked") return { ok: false, status: "blocked", plan: "plan.md", lastResult };
    if (next === "complete") {
      const result = await agent(
        `Write the complete delivery account from plan.md in the workflow workspace and the actual evidence. Preserve verified, unverified and remaining outcomes. ` +
          `Original task:\n${input}\nLatest complete execution handoff:\n${lastResult}`,
        { label: "deliver", title: "Explain the evidenced result" },
      );
      return publishPrimaryArtifact("delivery.md", result);
    }
    if (pass === 3) {
      return {
        ok: false,
        status: "incomplete",
        reason: "work_allowance",
        plan: "plan.md",
        nextStep: "next-step.md",
        lastResult,
        next_action: "Inspect the preserved plan, evidence and next step before choosing further work.",
      };
    }
    const step = await agent(
      `Read next-step.md in the workflow workspace and complete only that step. Use available tools to inspect, implement and verify within the authorized task. ` +
        `Preserve unrelated work; do not commit. Return the complete execution handoff with actual checks, artifact locations and remaining requirements for replanning. ` +
        `Original task:\n${input}`,
      { label: "execute", title: `Execute the selected step ${pass + 1}` },
    );
    publishArtifact(`step-${pass + 1}.md`, step);
    lastResult = step;
  }
}
