---
updated: "2026-10-02T23:16:00Z"
source_commit: "0d098c9e06d1"
update_event: "review_refresh"
context: "changes=XL files=30"
description: "Preserve complete caller-owned scope across answerless audit failures"
---

# Trace a selected authoring case

Read only the case matching the current task. These cases deepen real decisions;
they do not add roles, permissions or a second design contract. Use the common
[Design → review → Build owner](../../locus-pi-workflow-create/references/design-and-build.md)
for the actual design and exact source checks. All referenced modules inherit
configured routing. Independent sessions need not use different models.

## Known scope with evaluator feedback

Request: implement an accepted change, review the actual diff, and retain the
required checks. The steps are known, so the graph stays fixed. Implementation
size alone does not justify a queue manager.

Read the complete [Evaluator-Optimizer module](../../../extensions/workflows/references/examples/starters/evaluator-optimizer.workflow.mjs)
and [starter guide](../../../extensions/workflows/references/examples/starters/README.md).
Trace its edges before adapting the design:

1. The worker gets the original request and complete previous handoff. It inspects
   the existing state, changes only assigned scope, and reports actual evidence
   and artifact locations. It does not commit merely because it implemented work.
2. The reviewer reads the full actual diff, including uncommitted work. It owns
   acceptance and replaces workspace `findings.md`, preserving prior check
   outcomes/dispositions. Its same call returns `accept`, `revise` or `blocked`.
3. On `revise`, the fresh worker reads that file and receives the previous handoff
   whole. The next reviewer checks the new state. No translator is necessary
   because the reviewer already owns the choice.
4. `accept` publishes exactly the reviewed handoff. A concrete unavailable required
   prerequisite returns blocked with the work/findings. After the illustrative
   one-correction allowance, residuals return incomplete, with no last unreviewed
   correction. Adapt the allowance to the task, not a preferred graph size.

Keep criteria stable across correction. An unavailable optional browser check
alone is coverage to disclose; an explicitly required browser outcome still
needs evidence. If an observed defect is correctable, send its actionable finding
to correction. Missing required evidence cannot become success by dropping it.
Introduce an arbiter only when the task has a separate authority to adjudicate
disputed findings; its reasons and the original findings must reach later review.

## Caller-owned audit

Request: inspect each supplied source, verify each source's findings, then produce
one complete audit. Use the [caller-audit module](../../../extensions/workflows/references/examples/starters/caller-audit.workflow.mjs).
The structured `workflow` tool supplies immutable text `items` and one semantic
`input`. Slash syntax supplies only the latter. If the necessary tool is absent,
report the missing interface rather than inventing units; an empty required list
returns `missing_caller_items` before children start.

The graph has two different dependency kinds:

- Per source, inspection → verification is a pipeline. Source A may enter
  verification while source B still runs inspection. Each inspection report must
  carry its source identity, evidence and findings whole; the next stage receives
  that report and a composite slot index, not the original caller item. A failed
  provider may return no answer or source identity. Verification also receives all
  original caller units as complete opaque text, so required sources stay available.
  It retains unidentified failures as unassigned and inspects the actual sources
  as needed; neither source nor child should guess an original unit from a slot.
- The final audit needs all verified reports. The pipeline's completion barrier
  supplies them in caller order to synthesis. A reviewer then compares the
  complete candidate with all original caller units, all reports and the actual
  required evidence before `audit.md` publication. Synthesis also receives every
  original unit; coverage cannot depend on a child repeating its inputs. The
  reviewer owns a real coverage decision, not a universal judge.

`result: "report"` on inspection/verification lets eligible host-observed failures
reach later interpretation as complete observations. It is not acceptance.
The synthesis/reviewer retain failed, missing and skipped checks and every
finding's disposition. Required residuals return incomplete with the candidate
artifact and workspace `findings.md`; optional coverage alone is disclosed.
Fatal execution errors still propagate. No null filtering hides failed units.

Variant: all findings must be deduplicated **before** verification. A barrier is
then justified: readers → deduplication agent → verification. The deduplicator
reads complete reports and owns a named file containing all admitted/rejected
findings. A later verifier reads that file. If discovered findings must become
parallel workers, split discovery/freeze from a deliberate caller-items launch;
generated source cannot parse the findings file into a worker list.
“The stages have different names” would not justify that barrier.

## Observations changing remaining work

Request: migrate an accepted scope whose next steps may change after inspection
or execution. Read the complete [plan/replan module](../../../extensions/workflows/references/examples/starters/plan-replan.workflow.mjs).
The planner owns `plan.md` and `next-step.md` in the workflow workspace. Source
routes only its `work` / `complete` / `blocked` choice; it never reads those files.

The executor reads the next brief, completes only its authorized scope, and
returns the whole execution handoff. The planner inspects actual results and
updates remaining work without dropping unmet requirements. An obsolete step
can disappear because evidence makes it unnecessary, not to fit the allowance.
Completion is assessed after every step, including the last allowed one. Empty
remaining work alone proves nothing: all required outcomes/checks need evidence.
Required independent review becomes a planned step with a fresh responsible
session; ordinary missing implementation details remain work, not new approval.

At exhaustion keep the plan, next step, latest work and uncovered requirements
as incomplete. A concrete unavailable prerequisite is blocked with its actual
continuation condition. For reviewed slices and richer final verification, use
the existing [adaptive card](../../locus-pi-workflow-create/references/adaptive-slices.md).
If inspection merely reveals independent units without changing the remaining
plan, discovery followed by a frozen caller-items launch can be simpler.

## Brief detail with a real dependency

Both briefs below request the same catalog change and required evidence. They
do not choose another model or graph. This repository's `package.json` and
`scripts/build-public-catalogs.ts` establish the producer/consumer dependency:
`check:generated` compares committed catalog views with source; it does not
generate those views. Use these commands only in a repository declaring them.

Ordinary outcome-led brief:

> Update the public catalogs for the accepted manifest/registry change. Inspect
> package.json and the catalog generator. Return changed paths, actual verification
> and remaining discrepancies. Preserve unrelated work; do not commit.

Detailed brief for this known dependency:

> Update the same accepted catalog change. SOURCES: package.json,
> scripts/build-public-catalogs.ts, changed manifests and examples/workflows.
> Run npm run build:catalogs before npm run check:generated: the first regenerates
> the owned views; the second checks source/view agreement. Inspect all generated
> changes. Return changed paths, actual exits, discrepancies and unperformed checks.
> Preserve unrelated work; do not commit.

The added sources identify the responsibility owner; the command order prevents
checking stale output. The evidence request lets a reviewer distinguish actual
checks from intended ones. Other implementation choices remain with the child.
An agent using the ordinary brief can discover that same dependency; the example
does not establish which presentation works better for any model.

After correction, fresh review checks the actual state. Static syntax/source
checks prove grammar only. Replay preserves confirmed answers, not side effects
or refreshed source observations; changed prerequisites require fresh evidence
under the [run recovery owner](../../locus-pi-workflow-run/references/recovery.md).
