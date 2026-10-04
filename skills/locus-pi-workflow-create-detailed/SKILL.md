---
name: locus-pi-workflow-create-detailed
description: Detailed Pi authoring and repair with exact-source checks. Use for explicit detailed authoring, not detailed reports. Existing runs use locus-pi-workflow-run.
---

# Author a Pi workflow with traced decisions

Do not load ordinary first. [Route selection](../../docs/workflows/create.md#choose-an-authoring-route)
owns invocation precedence. Detail changes explanation, not graph, child autonomy, routing or authorization.
Resolve this `SKILL.md` to its physical file before following relative links; the
[workflow manual](../../docs/workflows/index.md) belongs to that package, never the caller cwd.

## Shape the task and its first module

Inspect the actual task sources. Name deliverables, required evidence and allowed effects; scout unknowns.
Workflow design is separate, and a proposal alone does not authorize implementation.
Before source, read [Design → review → Build](../locus-pi-workflow-create/references/design-and-build.md).
Write/review `.locus-pi/workflows/<name>/<name>.design.md`; build exactly its `Entries`, not an implicit root.
This project tour has two readers and one consumer, without a product gate:

```js
export const meta = {
  name: "project-tour",
  description: "Read a project and explain where to start.",
  profile: "standard",
};

export default async function run({ agent, parallel }, input) {
  const notes = await parallel([
    () =>
      agent(`Read README.md for the project purpose. Do not modify files.\nWhole caller input:\n${input}`, {
        label: "purpose",
        title: "Read project purpose",
      }),
    () =>
      agent(`Read package.json for development commands. Do not modify files.\nWhole caller input:\n${input}`, {
        label: "commands",
        title: "Read development commands",
      }),
  ]);
  const guide = await agent(
    `Combine notes into a guide; preserve uncertainty. Write only the exact guide.md path assigned in input using tools; missing/ambiguous path means failure, never guess.
Return the complete guide too. Whole input:\n${input}\nComplete notes:\n${notes.join("\n\n")}`,
    { label: "compose", title: "Write getting-started guide" },
  );
  return guide;
}
```

Purpose and commands are independent inputs; the composer needs both whole answers. This barrier has a real
dependency. The composer writes the assigned file; returned text is not file acceptance proof.
Metadata names entry/profile; labels identify replay calls, titles describe work.
Read [the exact source and guide](../../extensions/workflows/references/examples/starters/README.md).

## Read handoffs before adding control

`agent()` returns whole text; reviewers/planners can own `choice`. Pass task context; children inherit no earlier conversation.
Give file writers/readers the same exact caller-assigned paths, preferably absolute. Children inspect with tools; source never parses
files, JSON or prose.
For decisions, reports or a translator, read [structured results](../locus-pi-workflow-create/references/structured-results.md).
`phase()`/`log()` show progress; text publication retains optional native evidence, not an agent-owned file.
Read the [DSL table](../../docs/workflows/dsl.md#dsl-surface-v0) for selected methods before source:
`agent`, `parallel`, `pipeline`, `items` and text publication pass runtime and both checker modes.
Path/clock helpers remain outside orchestration-only; shaped results stay refused. Runtime JavaScript is
trusted, not sandboxed; child tools have host constraints.

## Trace dependencies, then compose

Use `pipeline()` when source A can reach verification while B is still inspecting.
Callbacks get previous value/composite index, not original item. Keep full caller units beside reports.
`items()` needs the structured tool; slash launch cannot carry it. Empty required caller input is non-success.
Cross-source synthesis waits for all reports. An agent can deduplicate into a named file; source cannot turn
discoveries into parallel workers. Failed groups throw with evidence.
For that task read [the caller-audit case](references/worked-decisions.md#caller-owned-audit), including its complete tested module.
For reuse, read DSL `workflow()` versus `invokeWorkflow()`: inline callbacks have no saved checkpoint;
saved children receive explicit destinations and use fixed keys. Saved grandchildren are refused.

## Work through the task's choices

Known implementation/review stays fixed: worker handoff → evaluator-owned choice/findings → correction → fresh recheck.
Observed results changing remaining work justify plan/replan; the planner assesses even after the last allowed step.
Read the task's [worked case](references/worked-decisions.md): consumers, evidence and exits traced
against tested starters. Read only the relevant case.
Editorial critique/revision improves text without final independent acceptance. Add a verifier only when required.
Use evidence lenses, adversarial checks or completeness critique when findings change next work.
For repeated discovery an agent retains seen/rejected findings and “nothing new” evidence in a file. Source
routes its choice under finite task-derived bounds; exhaustion retains uncovered work.
Choose the relevant [semantic explanation](../locus-pi-workflow-create/references/agentic-approaches.md) and
[card](../locus-pi-workflow-create/references/INDEX.md) after these dependencies; no universal judge is added.
For command/data order read [the brief case](references/worked-decisions.md#brief-detail-with-a-real-dependency).
Outcome-led briefs leave methods to children; detail does not force choreography.

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
An unavailable or failed gate means Build failed; never report success after skipping it. Static checks are not live proof.
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
