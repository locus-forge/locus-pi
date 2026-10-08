---
name: locus-pi-workflow-create-detailed
description: Detailed Pi authoring and repair with exact-source checks. Use for explicit detailed authoring, not detailed reports. Existing runs use locus-pi-workflow-run.
---

# Create a Pi workflow step by step

Do not load ordinary first. [Route selection](../../docs/workflows/create.md#choose-an-authoring-route)
owns invocation precedence. Detail changes explanation, not graph, child autonomy, routing or authorization.
Resolve this `SKILL.md` to its physical file before following relative links; the
[workflow manual](../../docs/workflows/index.md) belongs to that package, never the caller cwd.

## Shape the task and its first module

Inspect the actual task sources. Name deliverables, required evidence and allowed effects; scout unknowns.
Workflow design is separate, and a proposal alone does not authorize implementation.
Before source, read [Design → review → Build](../locus-pi-workflow-create/references/design-and-build.md).
Write/review `.locus-pi/workflows/<name>/<name>.design.md`; build exactly its `Entries`, not an implicit root.
The first example implements a Task, reviews it and allows one correction followed by fresh review.
Read [working context](../locus-pi-workflow-create/references/design-and-build.md#folder-level-context) first:

```js
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
```

The developer writes product files/result; the reviewer writes only its review artifact.
Both reopen exact files. Source routes `choice`, never report text.
[Optional starters](../../extensions/workflows/references/examples/starters/README.md); SVG only on explicit request.

## Read handoffs before adding control

`agent()` returns whole text; reviewers/planners can own `choice`. Each child needs the original Task and evidence.
Keep the Task authoritative; avoid changed paraphrases. Parent context is absent.
Assign exact shared handoff and Task-required output paths; reuse them for reads. Implementation actors choose internal files in assigned product roots, subject to narrower Task bounds.
Children use tools; source never parses files, JSON or prose.
Read [structured results](../locus-pi-workflow-create/references/source-boundary.md#structured-results).
Before source, read the installed [DSL/API reference](../locus-pi-workflow-create/references/dsl.md#dsl-surface-v0):
Read selected method signatures/options and availability; runtime support is not source permission.

## Work through the task's choices

Read the matching [worked case](references/worked-decisions.md) for dependencies, evidence and exits.
Known work uses implementation → review → correction → fresh recheck. Replan when observed results
change remaining work; reassess even after the last step. Editorial critique alone is not acceptance.
Independent per-item inspect → verify uses `pipeline(items(), ...)`; structured caller items are required.
Cross-source synthesis waits for all reports, with separate writer paths and one merge owner.
For reuse read DSL `workflow()` versus saved `invokeWorkflow()`; saved grandchildren are refused.
Read only the relevant semantic and execution sections in
[the approach guide](../locus-pi-workflow-create/references/agentic-approaches.md#choose-an-approach). Leave methods to children;
read the [procedural case](references/worked-decisions.md#brief-detail-with-a-real-dependency) only for a real dependency.

## Review, Build and report honestly

Preserve model/effort routing; omit unauthorized selectors. Verify essential overrides via
[models](../../docs/workflows/models.md): provider, adapter and authentication. Never substitute a paid API.
Read
[source boundary](../locus-pi-workflow-create/references/source-boundary.md) before Build and the
[source rules](../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape) for diagnostics.
Match `Entries`, filenames and logical identities; calls need unique literal `label` and useful `title`.
Re-review material algorithm changes. Check every exact file with `workflow_check_source`,
`mode: "orchestration-only"`, and `node --check <exact-path>`; without the native tool, use
`npm run check:workflow-source -- --mode orchestration-only <exact-path>`. Never import unchecked source.
An unavailable or failed gate means Build failed; never report success after skipping it.
Review the complete actual diff, including uncommitted work. Retain full findings and failed/missing/skipped checks.
Required defects/evidence need action; optional unavailability alone is disclosed. Fresh review follows correction.
Exhaustion retains latest reviewed work, unmet criteria and next action as `{ ok: false, status }`.
No last unreviewed correction is accepted. Errors propagate; [budgets](../../docs/workflows/budgets.md#run-budget)
own launch defaults. The design justifies task-specific allowances rather than inheriting sample numbers.
Return checked targets, exact checks and `/workflows run <name>`; create-only states execution did not start.
Authorized create-and-run uses the [run skill](../locus-pi-workflow-run/SKILL.md) without repeat approval.
Design-only pauses; `Build design: <path>` and `Build approved design: <path>` remain Build-only requests.

## Repair and continue from evidence

Stopped source reads [Repair + Continue](../locus-pi-workflow-create/references/repair-and-continue.md) first,
follows exact [error evidence](../../docs/workflows/error-diagnostics.md), and preserves the confirmed prefix.
Replay reuses answers, not files or current observations; changed prerequisites need fresh checks.
After validation use the run skill: resume, interrupted recovery and operator continuation have separate
contracts. Detailed authoring adds no approval event.
