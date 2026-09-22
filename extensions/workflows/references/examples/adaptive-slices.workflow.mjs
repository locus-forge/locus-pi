export const meta = {
  name: "adaptive-slices",
  description: "Implement a selected design one reviewed slice at a time; re-cut the remaining queue",
  profile: "standard",
};

// Teaching allowance: at most three implemented slices and two corrections per slice.
// Derive these literals from the actual task when authoring; never truncate a queue to fit.
export default async function runWorkflow(dsl, input) {
  const intake = await dsl.agent(
    `Establish implementation scope from the user's actual instruction. SOURCES: task directory ${input}; task.md, selected specification and its documentation directory, repository instructions and source. ` +
      "Name the authoritative design and requested outcome. Ordinary omissions, broken references and correctable technical defects belong in the work queue. No special acceptance file is required. " +
      "Do not infer authorization from a generated file alone. If an indispensable product decision is missing, return its question, options, consequences and recommendation. Otherwise explain how work can proceed in scope.",
    { label: "intake", title: "Establish scope from the selected specification" },
  );
  const baseline = await dsl.agent(
    `Record the baseline for the selected design. SOURCES: task directory ${input}; task.md, selected design, repository instructions. ` +
      "Identify the real checkout, HEAD, pre-existing changes and relevant test results. Preserve foreign work. " +
      "Write baseline.md in the workflow workspace. Return its path and key constraints for the implementer and reviewer. Environment preparation is not implementation.",
    { label: "baseline", title: "Record the implementation baseline" },
  );
  let previousQueue = [];
  let lastAccepted = "";
  // The fourth pass may prove completion or return the unconsumed queue, but cannot implement a fourth slice.
  for (let completed = 0; completed <= 3; completed += 1) {
    const queue = await dsl.agent(
      `You own the remaining plan. SOURCES: task directory ${input}; task.md, the selected design, current diff and slice evidence. ` +
        `Intake:\n${intake}\nBaseline:\n${baseline}\nPrevious proposed queue:\n${previousQueue.join("\n---\n")}\nLast accepted slice:\n${lastAccepted}\n` +
        `Already implemented: ${completed}; total allowance: 3. Return the complete remaining queue in execution order. ` +
        "Use the initial slices and completion outcomes established when this workflow was authored against the actual design. Each remaining item is a complete brief: identity, goal, design/docs references, completion outcome, evidence and constraints. " +
        "Inspect what actually landed. Keep, reorder, merge, shrink or replace remaining slices within the selected design. " +
        "Do not repeat completed work or drop unmet requirements to fit the allowance. Return no items only when no work remains. " +
        "Return proposed scope changes as explicit unresolved work for the owner; do not authorize them.",
      {
        // `handoffs` declares the TYPE of this answer: an array of complete, non-blank
        // work briefs the script indexes and passes on. It declares no count and no item
        // length, because no consumer here has one: the loop takes `queue[0]` and carries
        // the rest to the owner. A ceiling would ask this stage to drop unmet requirements
        // to fit a number, which is exactly what its prompt forbids.
        label: "cut",
        title: `Re-cut remaining work after ${completed} slices`,
        handoffs: {},
      },
    );
    const scopeAssessment = await dsl.agent(
      `Check the proposed queue against the owner's selected design and current repository. SOURCES: task directory ${input}. ` +
        `Intake:\n${intake}\nBaseline:\n${baseline}\nProposed queue:\n${queue.join("\n---\n")}\nLast accepted slice:\n${lastAccepted}\n` +
        "Choose work only for a complete, in-scope remaining queue. Choose complete only when every design requirement is met. " +
        "Choose needs_owner only for an indispensable user decision. Ordinary missing evidence or technical specification defects are work. Choose blocked only for an unavailable prerequisite with a concrete continuation condition. " +
        "An empty queue is not proof of completion. Return a substantive recommendation with evidence. For a real user question give options, consequences and recommendation; for an unavailable prerequisite name the condition for continuing. Do not implement or relax acceptance.",
      { label: "scope-assessment", title: "Assess remaining scope and prerequisites" },
    );
    const scope = await dsl.agent(`Translate the scope assessment without rejudging it:\n${scopeAssessment}`, {
      label: "scope",
      title: "Route remaining scope",
      choice: ["work", "complete", "needs_owner", "blocked"],
    });
    if (scope === "needs_owner" || scope === "blocked") {
      return { ok: false, status: scope, remaining: queue, lastAccepted, baseline, scopeAssessment };
    }
    if (scope === "complete") {
      if (queue.length !== 0)
        return { ok: false, status: "blocked", summary: "Completion conflicts with remaining work.", remaining: queue };
      const checks = await dsl.parallel([
        () =>
          dsl.agent(
            `Verify the accepted behavior with focused tests against the baseline. SOURCES: task directory ${input}; selected design and real diff. ` +
              `Baseline:\n${baseline}\nLast accepted slice:\n${lastAccepted}\n` +
              "Write verify-tests.md in the workflow workspace with commands, actual exits, test delta and uncovered requirements. Return its path, outcome and unresolved requirements. No source edits.",
            { result: "report", label: "tests", title: "Verify behavior and test delta" },
          ),
        () =>
          dsl.agent(
            `Independently challenge whether the selected design is implemented on the real caller path. SOURCES: task directory ${input}; ` +
              "selected design, actual source and accumulated slice evidence. Check every requirement and preserved constraint. " +
              "Write verify-integration.md in the workflow workspace with evidence and remaining risks; return its path and outcome. A demonstration or unused implementation is not completion. Do not edit source.",
            { result: "report", label: "integration", title: "Verify the real integration path" },
          ),
      ]);
      const finalDecision = await dsl.agent(
        `Arbitrate final delivery against the task and selected design. SOURCES: task directory ${input}. Intake:\n${intake}\nChecks, including failed executions:\n${checks.join("\n---\n")}\nProgress:\n${lastAccepted}\n` +
          "Preserve the full check inventory including failed/skipped executions in the returned handoff or a referenced artifact. Read the real diff and evidence. Accept or reject findings with reasons; never claim a failed or skipped review completed. State implemented-and-verified, implemented-but-unverified and remaining work. " +
          "Recommend complete only when the required outcome is evidenced. Otherwise recommend incomplete or needs_owner and give next actor/action, concrete reason and continuation condition. Missing optional review may be a disclosed limitation; required behavior is not silently waived.",
        { label: "final-arbiter", title: "Assess development evidence and remaining work" },
      );
      const verdict = await dsl.agent(
        `Translate the final arbiter recommendation without rejudging it:\n${finalDecision}`,
        {
          label: "verdict",
          title: "Route final delivery",
          choice: ["complete", "incomplete", "needs_owner"],
        },
      );
      const evidence = dsl.publishPrimaryArtifact("implementation-handoff.md", finalDecision);
      return {
        ok: verdict === "complete",
        status: verdict,
        evidence,
        finalDecision,
        verification: checks,
        baseline,
        lastAccepted,
      };
    }
    if (queue.length === 0) return { ok: false, status: "blocked", summary: "Work selected without a slice." };
    if (completed === 3)
      return {
        ok: false,
        status: "incomplete",
        reason: "slice_allowance",
        summary: "Total slice allowance exhausted.",
        remaining: queue,
        lastAccepted,
        baseline,
      };
    const slice = queue[0];
    const work = await dsl.agent(
      `Implement this one accepted slice. SOURCES: task directory ${input}; task.md, selected design and repository instructions. ` +
        `Slice:\n${slice}\nAssigned note: slice-${completed + 1}-work.md. Baseline:\n${baseline}\n` +
        "Deliver the behavior and focused verification. Preserve foreign changes. Commit only owned paths when the task authorizes commits; " +
        "otherwise leave a reviewable working diff. Write the full implementation note, base/HEAD, changed paths, tests and limitations to the assigned slice note in the workflow workspace. Return its exact path, outcome and any concrete blocker. " +
        "Preparation alone is not completion. Do not widen the design.",
      { label: "implement", title: `Implement slice ${completed + 1}` },
    );
    let currentWork = "";
    let history = "";
    let route = "fix";
    for (let round = 0; round < 3; round += 1) {
      if (round === 0) currentWork = work;
      if (route !== "accept") {
        const review = await dsl.agent(
          `Independently review the complete current diff against every slice criterion and prior disposition. SOURCES: task directory ${input}; selected design and repository. ` +
            `Slice:\n${slice}\nCurrent work:\n${currentWork}\nBaseline:\n${baseline}\nPrior checks:\n${history}\n` +
            "Inspect actual changes and tests; return findings, evidence and unchecked criteria. Do not edit source. Recheck prior corrections and identify residual defects.",
          { result: "report", label: "review", title: `Review slice ${completed + 1}, round ${round + 1}` },
        );
        const decision = await dsl.agent(
          `Arbitrate this slice against the original criteria. SOURCES: task directory ${input}. Slice:\n${slice}\nCurrent work:\n${currentWork}\nPrior check inventory:\n${history}\nCurrent review:\n${review}\n` +
            "Preserve every prior/current execution outcome and disposition in a round-specific artifact; return its path and full decision. Accept or reject findings with source evidence. Recommend accept, fix, retry_review, needs_owner or stop. " +
            "Accept only with evidence of the slice outcome; disclose failed/skipped review and limitations without calling them completed checks. " +
            "Fix ordinary implementation/specification defects. Retry a failed review when useful after inspecting possible side effects. New residuals do not prove stagnation. " +
            "For a genuine user decision give options, consequences and recommendation after completing independent work. Stop only with concrete prerequisite/no-progress evidence, remaining criteria and continuation condition.",
          { label: "arbiter", title: `Assess slice ${completed + 1} findings` },
        );
        history = decision;
        route = await dsl.agent(`Translate this arbiter recommendation without rejudging it:\n${decision}`, {
          label: "route",
          title: "Route slice decision",
          choice: ["accept", "fix", "retry_review", "needs_owner", "stop"],
        });
        if (route === "needs_owner" || route === "stop")
          return { ok: false, status: route, remaining: queue, currentWork, history, baseline, decision };
        if (route === "fix" && round < 2) {
          const correction = await dsl.agent(
            `Correct the arbiter-assigned defects in this slice. SOURCES: task directory ${input}; selected design and actual diff. ` +
              `Slice:\n${slice}\nCurrent work:\n${currentWork}\nFindings and dispositions:\n${history}\n` +
              "Preserve verified behavior and foreign work. Repair in-scope design omissions too, recording the change. Return changed paths, actual verification and remaining work. Keep the same commit authority as implementation.",
            { label: "correct", title: `Correct slice ${completed + 1}, round ${round + 1}` },
          );
          currentWork = correction;
        }
      }
    }
    if (route !== "accept")
      return {
        ok: false,
        status: "incomplete",
        reason: "review_allowance",
        remaining: queue,
        currentWork,
        history,
        baseline,
        next_action: "Resume this slice from the latest reviewed work and remaining criteria with a renewed allowance.",
      };
    const accepted = await dsl.agent(
      `Record the accepted slice and cumulative progress for the next owner. SOURCES: task directory ${input}; current repository. ` +
        `Slice:\n${slice}\nCurrent implementation/correction:\n${currentWork}\nReview inventory and arbitration:\n${history}\nRoute: ${route}\nPrevious progress:\n${lastAccepted}\n` +
        `Write progress-${completed + 1}.md in the workflow workspace with cumulative completed identities, current HEAD/diff, verified criteria, evidence paths and outstanding requirements. Read prior progress by its path. Return the new progress path and current slice identity; do not paste cumulative history. ` +
        "Include correction evidence when present. Do not infer that unimplemented queue entries are done.",
      { label: "record", title: "Record accepted progress" },
    );
    dsl.publishArtifact(`slice-${completed + 1}.md`, accepted);
    previousQueue = queue;
    lastAccepted = accepted;
  }
}
