---
name: locus-pi-workflow-create
description: Create or repair a Pi workflow through a compact lesson and exact-source checks. Use for ordinary authoring or this named invocation; without a selecting invocation explicit detailed authoring uses locus-pi-workflow-create-detailed. Existing runs use locus-pi-workflow-run.
---

# Create a reusable Pi workflow

A workflow makes dependencies visible. Scout first if work is unclear.
This skill owns authoring and the checked-source handoff. Do not use merely to run an existing workflow.
Resolve this `SKILL.md` to its physical file before following relative links; the
[workflow manual](../../docs/workflows/index.md) belongs to that package, never the caller cwd.
This ordinary entry follows [route selection](../../docs/workflows/create.md#choose-an-authoring-route):
an explicit invocation wins; a detailed deliverable does not select detailed authoring.

## Start with a complete module

Identify the requested artifact and actual sources; workflow design is not the task specification.
Before source, read [Design → review → Build](references/design-and-build.md), then write/review
`.locus-pi/workflows/<name>/<name>.design.md`. Its `Entries` declare exactly which modules to build.
Start with sequential implementation → review → bounded correction, adapting the allowance to the Task.
Read [working context](references/authoring-styles.md#folder-level-context) and supply its verified paths:

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
      `${context}\nOriginal Task and working context:\n${input}\nImplement the Task in its assigned product root; choose internal files within its bounds.
Preserve unrelated work; do not commit. On correction, read the assigned findings.md and implementation.md.
Write the complete result, changed paths, actual checks and remaining work to assigned implementation.md;
read it back. Return only a short status and its exact path. This is pass ${round + 1}.`,
      { label: "implement", title: "Implement or correct the task" },
    );
    const decision = await agent(
      `${context}\nOriginal Task and working context:\n${input}\nRead assigned implementation.md, then inspect the complete actual diff and required evidence.
Do not edit product source. Write only assigned findings.md: criteria, defects, check outcomes, prior
finding dispositions and next action. Read it back before choosing. Keep nonblocking suggestions separate.
Accept only verified Task requirements; disclose optional checks not performed. Revise correctable defects;
block on missing required prerequisites or handoff files. Do not weaken criteria. Short worker status:\n${work}`,
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
The [starter guide](../../extensions/workflows/references/examples/starters/README.md) includes optional parallel work.

## Calls and handoffs

`agent()` starts a clean child and returns whole text. Give each child the original Task and evidence; parent conversation is absent.
Keep that Task authoritative; add role-specific duties without duplicating or changing its requirements.
Use exact `choice` only at a branch.
Assign exact paths for shared handoffs and Task-required outputs; writers/readers use those same files.
Delegate internal file layout within an implementation actor's product root, subject to narrower Task boundaries.
Source exposes control edges; children inspect and act with tools. Never parse prose, JSON or those files in source.
`phase()`/`log()` show progress; text publication retains optional native evidence. It never saves or attests an agent-owned file.
For decisions, reports or a translator, read [structured results](references/structured-results.md).

## Choose stages from dependencies

The sequential loop fits known work; plan/replan fits observations changing remaining work.
Read the relevant [semantic guide](references/agentic-approaches.md) and [card](references/INDEX.md).
For independent per-item inspect → verify use `pipeline(items(), ...)`; caller items need the structured tool.
Use `parallel()` only for independent writers with distinct files and a later merge owner.
Before writing source, read the installed [DSL/API reference](references/dsl.md#dsl-surface-v0)
and selected method/options sections. Runtime support is not source permission.

## Build, check and hand off

Brief children with outcomes; leave methods to them. Use [procedural detail](references/procedural-briefs.md) only when needed.
Preserve user-configured model/effort routing; omit selectors unless authorized. For an essential override,
verify provider, adapter and authentication via [models](../../docs/workflows/models.md); never substitute a paid API.
Read [source boundary](references/source-boundary.md) before Build and the
[source rules](../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape) for diagnostics.
Match reviewed `Entries`, logical identities and source; re-review material mismatches. Every call needs a
unique literal `label` and useful `title`. Check every exact file with `workflow_check_source`,
`mode: "orchestration-only"`, and `node --check <exact-path>`; without the native tool, use
the same non-executing gate: `npm run check:workflow-source -- --mode orchestration-only <exact-path>`.
Never import unchecked source.
An unavailable or failed gate means Build failed; never report success after skipping it.
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
the same explicit prompt destinations and no saved grandchildren. Adapt the reviewed design/source; changed prerequisites need fresh evidence.
