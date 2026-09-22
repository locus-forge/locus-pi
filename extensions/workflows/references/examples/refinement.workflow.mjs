export const meta = {
  name: "refinement",
  description: "Explicit reviewer-gated refinement; at most three fresh workers",
  profile: "standard",
};
export default async function runWorkflow(dsl, input) {
  let previousWork = "";
  let previousReview = "";
  let previousRoute = "start";
  for (let round = 1; round <= 3; round += 1) {
    const work = await dsl.agent(
      `Original goal, constraints and acceptance criteria (do not weaken):\n${input}\nPrevious result/evidence:\n${previousWork}\nExact reviewer feedback:\n${previousReview}\n` +
        "Complete only the remaining scope. Inspect the actual current state. Return a compact complete handoff: work done, exact evidence, result " +
        "locations and remaining scope. Do not repeat external effects.",
      { label: "worker", title: "Work on the remaining scope" },
    );
    const review = await dsl.agent(
      `Independently verify the original criteria against the CURRENT result and evidence. Do not edit the result or relax the goal.\nGoal:\n${input}\nPrevious result:\n${previousWork}\n` +
        `Previous review:\n${previousReview}\nCurrent result:\n${work}\n` +
        "Return evidence per criterion, stable unresolved criterion IDs, exact remaining scope, and whether verified progress occurred. Tool calls or changed wording alone are not progress. " +
        "Recommend complete only if every required criterion is demonstrated; otherwise continue_progress, continue_stalled, needs_operator or " +
        "failed. State the reason and exact next-worker feedback.",
      { label: "reviewer", title: "Verify criteria and progress" },
    );
    const route = await dsl.agent(
      `Choose the control identity supported by this review. Do not overrule failed or missing evidence.\nOriginal criteria:\n${input}\nReview:\n${review}`,
      {
        label: "decision",
        title: "Completion decision",
        choice: ["complete", "continue_progress", "continue_stalled", "needs_operator", "failed"],
      },
    );
    const evidence = dsl.publishArtifact(
      `round-${round}.md`,
      `Round: ${round}\nDecision: ${route}\nOriginal goal:\n${input}\nWorker result:\n${work}\nReview and next-worker feedback:\n${review}`,
    );
    dsl.log(`Semantic round ${round}: ${route}; see round-${round}.md for evidence and exact handoff.`);
    if (route === "complete") return dsl.publishPrimaryArtifact("result.md", work);
    if (route === "needs_operator") {
      dsl.awaitOperator({ reason: "A decision or authorization is required; inspect the last round artifact." });
      return evidence;
    }
    if (route === "failed") return { ok: false, status: "failed", summary: "review_failed", evidence };
    if (route === "continue_stalled" && previousRoute === "continue_stalled")
      return { ok: false, status: "blocked", summary: "no_progress", evidence };
    if (round === 3) return { ok: false, status: "blocked", summary: "round_cap", evidence };
    previousWork = work;
    previousReview = review;
    previousRoute = route;
  }
}
