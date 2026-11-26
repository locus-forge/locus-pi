---
name: locus-pi-workflow-create
description: Create or repair a checked Pi workflow. Use for ordinary authoring or this named invocation. Explicit detailed authoring uses locus-pi-workflow-create-detailed unless an invocation selects an entry. Existing runs use locus-pi-workflow-run.
---

# Create a reusable Pi workflow

Resolve this `SKILL.md` to its physical file in Locus Pi. Follow links from there.
An explicit invocation wins over the wording of its task.

## Author in order

1. **Read the Task.** Confirm the checkout, product root, outputs and allowed effects.
2. **Design.** Write and review the `.design.md`. List modules in `Entries`. Record each role, handoff, branch and exit.
3. **Plan the product.** With a settled approach, the implementer plans before edits. Add a planning step and plan handoff for unresolved interfaces, data or checks.
4. **Build and check.** Match the design. Give each call a unique literal `label` and useful `title`. Pass the original Task and paths whole. Keep the Task authoritative.

## Files and ownership

The first two paths are defaults relative to the project root.

- `.locus-pi/workflows/<name>/<name>.design.md` — author writes; design reviewer and author read before Build.
- `.locus-pi/workflows/<name>/<name>.workflow.mjs` — author writes; checker and launcher read. A group-only design has no root module.
- `plan.md` — a separate planner writes before product edits; implementer and reviewer read.
- `implementation.md` — implementer writes each round; reviewer and corrector read.
- `findings.md` — reviewer writes each round; corrector and fresh reviewer read.
- Review scratch — reviewer uses a fresh copy when checks write.

Put exact paths for each shared handoff and Task-required output in `input`, with the Task, expected checkout, product root and write scope.
Choose internal files within narrower Task bounds. Verify the Git root before authorized Git writes.

## Reading map

1. [design-and-build.md](references/design-and-build.md#design-contract) — Design the graph.
2. [DSL/API reference](references/dsl.md#dsl-surface-v0) (`dsl.md`) — Methods used in Build.
3. [source-boundary.md](references/source-boundary.md) — Source and handoff limits before Build.

- [design-and-build.md](references/design-and-build.md#folder-level-context) — Assign execution paths.
- [design-and-build.md](references/design-and-build.md#plan-the-product-work) — Later roles need a plan.
- [design-and-build.md](references/design-and-build.md#review-decisions-and-completion) — Acceptance evidence.
- [agentic-approaches.md](references/agentic-approaches.md#choose-an-approach) — Choose a different graph.
- [source-boundary.md](references/source-boundary.md#structured-results) — Branch on a result.
- [source-shape.md](../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape) — Explain a rejected source shape.
- [models.md](../../docs/workflows/models.md) — Verify an authorized route override.
- [budgets.md](../../docs/workflows/budgets.md#run-budget) — Set a run bound.
- [repair-and-continue.md](references/repair-and-continue.md) — Repair a stopped run.
- [error-diagnostics.md](../../docs/workflows/error-diagnostics.md) — Identify a run failure.
- [locus-pi-workflow-run/SKILL.md](../locus-pi-workflow-run/SKILL.md) — Run or continue checked source.
- [create.md](../../docs/workflows/create.md#choose-an-authoring-route) — Select a lesson.
- [workflow manual](../../docs/workflows/index.md) (`docs/workflows/index.md`) — Browse package docs.

## Example for a settled approach

[More runnable examples](../../extensions/workflows/references/examples/starters/README.md). Comments explain the graph. Prompts assign work.

```js
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
```

## Choose stages from dependencies

Use `parallel()` for independent writers with separate files and a merge owner. Replan when evidence changes remaining work.
Children open files. Source forwards whole text and routes on `choice` or schema fields. Preserve model and effort routing.
Use caller-supplied items for `pipeline()`. Check the DSL before saved child reuse. SVG requires an explicit request.

## Source checks and delivery

1. Run `node --check <exact-path>` and `workflow_check_source` with a project-relative path and `mode: "orchestration-only"`.
   If unavailable, run the same non-executing gate from the package checkout.
   `npm run check:workflow-source -- --mode orchestration-only <exact-path>`
2. Check before final formatting. Keep failed versions and diagnostics. Fix the cause and rerun both checks.
   Never import unchecked source. An unavailable or failed gate means Build failed; never report success after skipping it.
3. Required evidence stays binding. Corrections require fresh review.
   Do not repeat full review of accepted unchanged work and evidence. Expand checks only for a named requirement/risk.
4. Return exact checked files, check results and `/workflows run <name> -- <execution input>`.
   Create-only stops here. Authorized create-and-run uses the run skill without repeat approval.
   Pause after design only when asked. `Build design:` and `Build approved design:` use the supplied design.
   Repair keeps the confirmed prefix and rechecks the new source. Replay reuses answers; reopen required files.
