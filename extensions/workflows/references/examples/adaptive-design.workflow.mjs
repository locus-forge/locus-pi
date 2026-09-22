export const meta = {
  name: "adaptive-design",
  description: "Develop and refine a specification; return it for a separate implementation authoring request",
  profile: "standard",
};

// Teaching allowance: three reviews, allowing two corrections. Derive limits from the actual task.
export default async function runWorkflow(dsl, input) {
  const initial = await dsl.agent(
    `Develop the task specification. SOURCES: task directory ${input}; task.md, referenced documentation, repository instructions and actual source. ` +
      "Write artifacts/design.md under the task directory. Define intended behavior, owners of state/classes, constraints, evidence needed and open product decisions. " +
      "Return the complete candidate or its exact path with a useful summary. Mark unsupported facts as unverified. Do not implement.",
    { label: "design", title: "Develop the specification" },
  );
  let candidate = "";
  let history = "";
  let decision = "";
  for (let round = 0; round < 3; round += 1) {
    if (round === 0) candidate = initial;
    const review = await dsl.agent(
      `Independently review the complete current specification. SOURCES: task directory ${input}. Candidate:\n${candidate}\nHistory:\n${history}\n` +
        "Check the original task, real source, references, state ownership and factual claims. Assess prior dispositions and new residuals. " +
        "Return evidence-backed findings and coverage, including anything not checked. Do not edit the specification or implement.",
      { result: "report", label: "design-review", title: `Review specification round ${round + 1}` },
    );
    const arbitration = await dsl.agent(
      `Arbitrate the specification against the original task. SOURCES: task directory ${input}. Current candidate:\n${candidate}\nPrior inventory:\n${history}\nCurrent review:\n${review}\n` +
        "Preserve every prior and current review execution outcome and disposition in a round-specific artifact; return its exact path and the full decision. Read the actual documents. Accept or reject findings with evidence; do not rubber-stamp the reviewer. A failed review is an observed failed check, not a completed review. " +
        "Recommend ready, revise, retry_review, needs_owner or stop with reasons. Ready means the requested specification is delivered; disclose any missing independent review and limitations. " +
        "Revise ordinary defects; retry eligible failed review when useful. Do not call new residuals stagnation merely because an earlier review already ran. " +
        "Stop for evidenced lack of progress or an unavailable prerequisite: name unresolved criteria, next actor/action and continuation condition. " +
        "For an indispensable product decision give the question, options, consequences and recommendation; finish independent work first. Do not implement.",
      { label: "design-arbiter", title: "Decide specification corrections and limitations" },
    );
    decision = arbitration;
    history = arbitration;
    const route = await dsl.agent(
      `Translate this arbiter's recommendation into the next edge. Do not rejudge the specification.\n${decision}`,
      {
        label: "design-route",
        title: "Route the arbiter decision",
        choice: ["ready", "revise", "retry_review", "needs_owner", "stop"],
      },
    );
    if (route === "ready") {
      const evidence = dsl.publishPrimaryArtifact(
        "design-handoff.md",
        `Specification:\n${candidate}\nReview inventory and dispositions:\n${history}`,
      );
      return {
        ok: true,
        status: "ready",
        design: evidence,
        candidate,
        history,
        next_action:
          "Review this specification. After the user asks to implement it, author a separate workflow referencing this design and documentation directory, with initial slices and completion outcomes.",
      };
    }
    if (route === "needs_owner" || route === "stop") {
      const stoppedEvidence = dsl.publishPrimaryArtifact(
        "design-handoff.md",
        `Current specification:\n${candidate}\nRemaining work and decisions:\n${history}`,
      );
      return { ok: false, status: route, design: stoppedEvidence, candidate, history, decision };
    }
    if (round < 2 && route === "revise") {
      const corrected = await dsl.agent(
        `Revise the current specification within the task. SOURCES: task directory ${input}. Candidate:\n${candidate}\nFull findings and dispositions:\n${history}\n` +
          "Repair accepted defects and substantiate disputed findings. Keep original criteria and verified work. Update artifacts/design.md and return the complete candidate or exact path, changed criteria and remaining questions. " +
          "Correct references and ownership gaps; qualify unsupported claims with the check needed. Do not invent facts or implement.",
        { label: "design-correct", title: `Correct specification round ${round + 1}` },
      );
      candidate = corrected;
    }
  }
  const exhaustedEvidence = dsl.publishPrimaryArtifact(
    "design-handoff.md",
    `Latest reviewed specification:\n${candidate}\nReview history and remaining work:\n${history}`,
  );
  return {
    ok: false,
    status: "incomplete",
    reason: "review_allowance",
    design: exhaustedEvidence,
    candidate,
    history,
    decision,
    next_action:
      "Continue from the latest candidate and arbiter's remaining work with a renewed resource allowance; exhaustion alone requires no product decision.",
  };
}
