---
name: locus-pi-workflow-create
description: Create or repair a Pi workflow through a compact lesson and exact-source checks. Use for ordinary authoring or this named invocation; without a selecting invocation explicit detailed authoring uses locus-pi-workflow-create-detailed. Existing runs use locus-pi-workflow-run.
---

# Create a reusable Pi workflow

A workflow makes dependencies visible: what investigates, verifies and combines results. Scout first if work is unclear.
This skill owns authoring and the checked-source handoff. Do not use merely to run an existing workflow.
Resolve this `SKILL.md` to its physical file before following relative links; the
[workflow manual](../../docs/workflows/index.md) belongs to that package, never the caller cwd.
This ordinary entry follows [route selection](../../docs/workflows/create.md#choose-an-authoring-route):
an explicit invocation wins; a detailed deliverable does not select detailed authoring.

## Start with a complete module

Identify the requested artifact and actual sources; workflow design is not the task specification.
Before source, read [Design → review → Build](references/design-and-build.md), then write/review
`.locus-pi/workflows/<name>/<name>.design.md`. Its `Entries` declare exactly which modules to build.
This read-only project tour teaches the graph; it does not bypass that design:

```js
export const meta = {
  name: "project-tour",
  description: "Read a project and explain where to start.",
  profile: "standard",
};

export default async function run({ agent, parallel, publishPrimaryArtifact }) {
  const notes = await parallel([
    () =>
      agent("Read README.md for the project purpose. Do not modify files.", {
        label: "purpose",
        title: "Read project purpose",
      }),
    () =>
      agent("Read package.json for development commands. Do not modify files.", {
        label: "commands",
        title: "Read development commands",
      }),
  ]);
  const guide = await agent(
    `Combine these complete notes into a getting-started guide. Preserve uncertainty; do not modify files.\n${notes.join("\n\n")}`,
    { label: "compose", title: "Write getting-started guide" },
  );
  return publishPrimaryArtifact("guide.md", guide);
}
```

Readers can start independently; composition needs both complete notes. Publication keeps exact guide text.
Read [the exact example and guide](../../extensions/workflows/references/examples/starters/README.md)
when adapting; do not inherit example effects, bounds or executor choices without a task reason.

## Calls and handoffs

`agent()` starts a clean child and returns complete text; pass it whole. Use exact `choice` only at a branch.
Findings/plans live in named workspace files that agents write/read using the host-provided workspace.
Source exposes control edges; children inspect and act with tools. Never parse prose, JSON or those files in source.
`phase()`/`log()` show progress; `publishArtifact()` retains evidence and `publishPrimaryArtifact()` final text.
For decisions, reports or a translator, read [structured results](references/structured-results.md).

## Schedule from dependencies

Use `pipeline(items(), ...)` for independent per-item inspect → verify; one item need not wait for another.
Caller-owned `items` require the structured workflow tool; slash input is one semantic string.
Use `parallel()` when a consumer needs all reports, as this composer does. Different stage names are not a
barrier reason; cross-source synthesis/deduplication is. An agent owns interpretation; group failures stay failures.
Before writing source, read the [DSL availability table](../../docs/workflows/dsl.md#dsl-surface-v0) and
only the sections for methods and agent options this graph uses. Runtime support is not source permission.

## Choose and combine useful stages

Keep known work fixed; replan when observed results change remaining work, not for task size.
Critique improves a draft; an evaluator gates required evidence and correction/recheck; a planner revises remaining work.
For those tasks read the [semantic guide](references/agentic-approaches.md) and selected
[card](references/INDEX.md). Omit planners, reviewers or arbiters without a useful responsibility.
The [installed examples](../../examples/workflows/README.md) are adaptable sources, not compulsory recipes.

## Build, check and hand off

Brief children with goal, sources and completion condition; leave methods to them. Use
[procedural detail](references/procedural-briefs.md) only for a real dependency or observed failure.
Preserve user-configured model/effort routing; omit selectors unless authorized. For an essential override,
verify provider, adapter and authentication via [models](../../docs/workflows/models.md); never substitute a paid API.
Read [source boundary](references/source-boundary.md) before Build and the
[source rules](../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape) for diagnostics.
Match reviewed `Entries`, logical identities and source; re-review material mismatches. Every call needs a
unique literal `label` and useful `title`. Check every exact file with `workflow_check_source`,
`mode: "orchestration-only"`, and `node --check <exact-path>`; without the native tool, use
the same non-executing gate: `npm run check:workflow-source -- --mode orchestration-only <exact-path>`.
Never import unchecked source.
An unavailable or failed gate means Build failed; never report success after skipping it. Static checks are not live proof.
Review the complete actual diff, including uncommitted work. Retain full findings and failed/missing/skipped checks.
Required evidence stays binding; optional unavailability alone is disclosed. Correction needs fresh review;
exhaustion preserves work, unmet criteria and next action as `{ ok: false, status }`, never an accepted unreviewed fix.
Execution errors propagate; [budgets](../../docs/workflows/budgets.md#run-budget) own launch defaults and override policy.
Create-only ends with checked source: return the checked target, exact checks and `/workflows run <name>`.
Authorized create-and-run continues through the [run skill](../locus-pi-workflow-run/SKILL.md) without repeat approval.
Design-only pauses; `Build design: <path>` and `Build approved design: <path>` remain Build-only requests.

## Repair and reuse

For stopped source read [Repair + Continue](references/repair-and-continue.md) first, follow exact
[error evidence](../../docs/workflows/error-diagnostics.md), preserve confirmed calls/labels/prompts/order,
and check repaired source before authorized continuation. Replay reuses answers, not files or current observations.
For reuse, read inline `workflow()` versus saved `invokeWorkflow()` in the DSL: saved children use fixed keys,
shared locations and no saved grandchildren. Adapt the reviewed design/source; changed prerequisites need fresh evidence.
