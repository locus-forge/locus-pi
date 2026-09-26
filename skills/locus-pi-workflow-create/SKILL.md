---
name: locus-pi-workflow-create
description: Create or repair a locus-pi workflow through design, review and exact-source validation. Use for authoring; hand authorized execution to locus-pi-workflow-run.
---

# Create a locus-pi workflow

Resolve this `SKILL.md` to its physical file before following relative links.
The installed [workflow manual](../../docs/workflows/index.md) is relative to that file,
never the caller cwd; see [discovery](../README.md#find-the-installed-workflow-documentation).

This skill owns authoring and the checked-source handoff. Do not use merely to run an existing workflow;
use the `locus-pi-workflow-run` skill for launch, recovery and monitoring.
Create-only ends with checked source and a launch command. Authorized create-and-run continues through
that skill without repeat approval. Report authoring and execution separately.

## Establish the deliverable

Inspect the request and supplied sources. Ask only when the intended deliverable or authoritative
specification is unclear: create a specification, revise one, or implement the selected design.
The workflow's `.design.md` describes its graph; it is not the task specification.
Author implementation from the actual specification under the user's implementation request.
Do not prebuild or launch implementation merely because specification authoring finished.
Ordinary technical omissions become assigned implementation work, not another approval requirement.

Preserve user-configured model and effort routing. Omit selectors unless the user or project requests
an override; a role name proves neither provider nor billing route. For a required subscription route,
verify provider, adapter and authentication before accepting the design; never substitute a paid API.
A deliberate graph may contain hundreds of calls. Do not invent an agent-count cap or budget.

For a stopped workflow needing a source fix, read [Repair + Continue](references/repair-and-continue.md)
first. Inspect `.locus-pi/logs/errors.jsonl` and its exact evidence paths using
[error diagnostics](../../docs/workflows/error-diagnostics.md). Repair the owning layer and preserve
unaffected completed calls, labels, prompts, order and workspace assumptions. Repair-only ends at checked
source; an authorized repair-and-continue returns to the run skill and continues to terminal evidence.

## Select and design the graph

Read [the pattern index](references/INDEX.md), then only the selected card. Prefer a fixed graph for one
bounded deliverable with known requirements; use adaptive slices when accepted output must re-cut the work.
Read [authoring styles](references/authoring-styles.md) for brief detail, folder input or executor choices.
Outcome-led briefs are the default; procedural detail needs a concrete constraint or observed failure.

Before writing source, read the [DSL availability table](../../docs/workflows/dsl.md#dsl-surface-v0)
and only the sections for methods and agent options this graph uses. The
[source rules](../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape)
separately determine what passes `mode: "orchestration-only"`; runtime availability is not permission.
When adapting an example, read its exact source and adjacent guide from
[installed workflows](../../examples/workflows/README.md) or the selected pattern card.
Do not inherit example budgets, model roles or external effects without a task-specific reason.

Read [Design → review → Build](references/design-and-build.md) before writing the design or source.
Write `.locus-pi/workflows/<name>/<name>.design.md`, review it, then build exactly its `Entries` table.
A `runnable root` includes the root; `group-only` includes only direct children. A material algorithm
mismatch returns to design review. Pause after design only when explicitly requested.
Build-only forms remain `Build design: <exact path>` and `Build approved design: <exact path>`.
For packaged `task/plan` or `task/plan-light`, supply the complete accepted `task/draft` text; blank input or a placeholder
brief cannot produce an accepted workflow. No package-provided catalog agent is required.

## Briefs, decisions and evidence

Give each agent its task, relevant sources and completion condition once; let it choose methods.
Reviewers inspect the complete actual diff, including uncommitted work, before a favorable verdict.
Commit only when authorized. Preparation and baseline tests do not complete an implementation.
A blocker needs a concrete obstacle or observed resource limit; unfinished work alone is not a blocker.

Choose results by their consumer: plain `agent()` text for narrative, `choice` for a branch, and
`handoffs` for discovered work units, including a sequential slice queue. Do not wrap reports in singleton
lists, parse their prose or turn an empty queue into success. Read
[structured results](references/structured-results.md) before any decision handoff; the arbiter owns
the decision, and a translator copies it without adding criteria or owner approval.

For substantive review, an arbiter judges findings and may accept or reject them with evidence,
request correction, retry review or disclose a limitation. Preserve completed, failed, missing and
skipped checks. Use `agent(prompt, { result: "report" })` when eligible reviewer failures must reach it;
read [report eligibility](../../docs/workflows/agent-results.md#agent-execution-reports).
Forward the entire report; it is not acceptance and cannot combine with shaped output.
Keep bounded correction and fresh review after changes. Exhaustion preserves the latest reviewed
artifact, unmet criteria and next action; an incomplete required outcome stays non-successful.
An agent returns the exact `choice` string; the workflow maps a refusal branch to `{ ok: false, status }`.
Use `throw` for execution errors, not ordinary review decisions.

The runtime has no answer-size policy. Declare size fields only for a named consuming limit, not a
narrative preference; never disguise a cap as a prompt instruction. Do not emit `maxItemChars`,
`maxAnswerChars`, `schemaMaxLength` or `returnVia`. Budgets stop spending, not answers.
The [budget policy](../../docs/workflows/budgets.md#run-budget) owns launch-mode defaults.
Any chosen override needs a reason in the design; do not copy example numbers or raise limits automatically.
For output-contract or turn-budget failures, read the matching section of Repair + Continue.

## Validate and hand off

Read [source boundary](references/source-boundary.md) before Build for source layout and artifact placement.
Source contains visible DSL edges and whole-value handoffs; agents own interpretation and file inspection.
Every `agent()` call needs a unique literal `label` and a useful human `title`; dynamic titles do not
replace identity. Check two sibling titles where mapping could make displayed work indistinguishable.

Validate every exact built file with `workflow_check_source` using `mode: "orchestration-only"`, plus
`node --check <exact-path>` and the design/source checks. Without the native tool, a `locus-pi` checkout
provides the same non-executing gate: `npm run check:workflow-source -- --mode orchestration-only <exact-path>`.
Never import unchecked source as a smoke test. An unavailable or failed gate means Build failed;
never report success after skipping it. Reviewed JavaScript runs in Pi and is not sandboxed.

Return the checked target, exact checks and `/workflows run <name>`. Create-only states execution did
not start. Authorized create-and-run now continues through the
[run skill](../locus-pi-workflow-run/SKILL.md) and reports its actual terminal status and evidence.
