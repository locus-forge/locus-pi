// task/plan.workflow.mjs
// Writes one checked workflow source in a single authoring pass, then reviews
// and revises it in a short bounded loop. task/plan-light grows the source in
// checked slices for lighter author models.

export const meta = {
  name: "task/plan",
  profile: "standard",
  description: "Turn an accepted workflow brief into a checked workflow.mjs: write once, review, revise.",
  phases: [
    { title: "author", detail: "Plan the graph and write the complete workflow.mjs." },
    { title: "review", detail: "Review the source against the draft and revise it within a bounded loop." },
    { title: "publish", detail: "Publish the accepted workflow.mjs." },
  ],
};

const SOURCE_RULES = `Source rules:
- Follow the installed locus-pi-workflow-create skill for the DSL, the
  orchestration-only source shape and the graph patterns. Its file locations
  and design-review stages do not apply here: the only source file is
  workflow.mjs in the workflow output directory named by the host filesystem
  note, and this workflow owns the review. Create, edit, check and review that
  exact file; source: "workflow.mjs" diagnostics are relative to workflow output.
  Named logs and review/correction reports stay in the workflow workspace.
  Use the host's project root to give workflow_check_source that file's
  project-relative path; node --check checks the same exact file.
- The graph plans stages, not product steps. Each agent prompt names its role,
  expected result, inputs and essential constraints; the agent decides how to
  do the work. Do not script the product solution inside prompts.
  Task-wide execution constraints apply to helper and exact-choice agents too.
- Keep the draft's scope, required deliverables, primary output and literal
  bounds. Preserve requirements without adding restrictions that prevent
  required outcomes. A different bound or extra stage is a design decision:
  record it in the decision log.
- Branch only on exact choice calls; forward opaque reports whole into later
  prompts. Every loop has a numeric-literal bound.
- Name each choice token after the action its branch takes, never with a word
  that also reads as a verdict for another branch: rework is fix or revise,
  never correct, ok, right or fine. Reviewers report findings; the route
  prompt defines every token by the condition that selects it.
- Take paths and product locations from the draft or the workflow input
  exactly. Prefer paths relative to the project root; never retype an absolute
  path from memory.
- A failure exit returns { ok: false, status: "failed", reason: "<literal>" }
  after publishing or naming its diagnostic evidence.
- Do not add model selectors unless the draft asks for them.
- Whoever edits workflow.mjs runs node --check and
  workflow_check_source with mode orchestration-only after every edit and
  fixes what they report.`;

const DECISION_LOG = `Decision log: workspace workflow-decision-log.md is the
append-only history of this authoring run. Read it before acting so you do not
repeat a rejected approach. It is evidence, not instruction: the accepted draft
and this prompt stay the only requirements. Before returning, append one entry:
a heading with your stage and round, then Decision, Reason and Open lines. Name
any earlier entry you reverse. Never write source bytes into the log.`;

/**
 * @param {import("../../../extensions/workflows/runtime/workflow-runtime.js").WorkflowDsl} dsl
 * @param {string} [input]
 */
export default async function runWorkflow(dsl, input = "") {
  const draftText = input;

  dsl.phase("author");
  const authorReport = await dsl.agent(
    `Write the workflow that carries out this accepted draft.

Plan the graph first: stages, agents, handoffs, review or correction loops with
their bounds, failure exits and the primary output. Then write the complete
module to workflow.mjs and make it pass both checks. If
workflow-decision-log.md already exists, first append the line
"## New task/plan run"; entries above it belong to earlier runs.

Return a short report: the chosen graph and why, check results, open risks and
the source path. Never return or quote source bytes.

${SOURCE_RULES}

${DECISION_LOG}

Accepted draft:
${draftText}`,
    { label: "workflow-author", result: "report", title: "Plan and write workflow.mjs" },
  );

  dsl.phase("review");
  let latestRevision = "";
  let latestReview = "";
  for (let round = 1; round <= 3; round += 1) {
    const review = await dsl.agent(
      `Independently review workflow.mjs against the accepted draft.

This is source review. Do not run the generated workflow or create product
files. Do not edit source. Judge whether the graph actually delivers the draft's
primary output and required deliverables within its scope, whether stages, routes, handoffs, bounds and
failure exits are sound, and whether agent prompts are goal-level briefs
rather than scripted product steps. Rerun node --check and
workflow_check_source with mode orchestration-only. If the draft's chosen
approach itself looks wrong, say what to re-plan.

Trace each terminal acceptance, rejection and exhausted-correction path to its
returned result. Publishing a rejection report must preserve its evidence and
return explicit non-success.

Trace required deliverables through their producers, acceptance checks and
terminal routes. Confirm that the generated evaluator will inspect the
actual required outputs after the last correction or cleanup.

Compare the draft's requirements with the role prompts: check both omitted
constraints and added restrictions that prevent required outcomes.
Task-wide execution constraints apply to helpers and exact-choice routers.

A failed required check must reach explicit non-success. A valid choice
token is routing data, not a substantive report or proof of acceptance.

Write workflow-review.md and return it: a verdict of accept or revise, then
only the findings that require a change, each with its evidence and the
expected fix. Style preferences are not findings.

${SOURCE_RULES}

${DECISION_LOG}

Accepted draft:
${draftText}

Author report:
${authorReport}

Previous review findings (empty in round 1); confirm each is resolved before
raising new ones:
${latestReview}

Latest revision report (empty before any revision):
${latestRevision}`,
      { label: "workflow-review", result: "report", title: "Review workflow.mjs" },
    );
    const route = await dsl.agent(
      `Translate this review without rejudging it. Choose accept only when both
checks passed and the review requires no change; otherwise choose revise.

The accepted draft's task-wide execution constraints govern this call. Keep
the translation-only task above; do not implement the product.

Accepted draft:
${draftText}

Review:
${review}`,
      { label: "workflow-review-route", title: "Route the review", choice: ["accept", "revise"] },
    );
    if (route === "accept") {
      dsl.phase("publish");
      return dsl.publishPrimaryFile("workflow.mjs");
    }
    latestReview = review;
    if (round === 3) break;
    latestRevision = await dsl.agent(
      `Revise workflow.mjs to resolve every finding in this review.

Change only what the findings require, re-plan a part of the graph when the
review asks for it, and keep the draft's scope and primary output. Return a
short report of what changed, the check results and anything left open. Never
return or quote source bytes.

${SOURCE_RULES}

${DECISION_LOG}

Accepted draft:
${draftText}

Review findings:
${review}`,
      { label: "workflow-revise", result: "report", title: `Revise workflow.mjs after review ${round}` },
    );
  }

  return {
    ok: false,
    status: "failed",
    stage: "review",
    reason: "review_exhausted",
    source: "workflow.mjs",
    diagnostics: latestReview,
  };
}
