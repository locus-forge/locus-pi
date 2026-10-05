---
updated: "2026-10-02T23:16:00Z"
source_commit: "0d098c9e06d1"
update_event: "review_refresh"
context: "changes=XL files=30"
description: "Preserve complete caller-owned scope across answerless audit failures"
---

# Small workflow starters

Begin with the sequential implementation/review module in either [authoring lesson](../../../../../docs/workflows/create.md#choose-an-authoring-route).
These modules deepen reusable interactions. After the dependency lesson, choose from task need using the [semantic approach guide](../../../../../skills/locus-pi-workflow-create/references/agentic-approaches.md),
then adapt the prompts, criteria and finite allowances. They are starting points,
not compulsory templates or runnable names in the Package catalog.

| Source                                                                  | Task need and mechanism                                                                               | Terminal result                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Evaluator-Optimizer](evaluator-optimizer.workflow.mjs)                 | Known implementation scope; reviewer-owned findings and choice, one correction followed by recheck    | Accepted short status/path after artifact review, or non-success with the preserved implementation and findings files |
| [Project tour](project-tour.workflow.mjs)                               | Optional independent file writers, then one merge owner                                               | Exact explanatory guide in `guide.md`, without independent product acceptance                                         |
| [Caller audit](caller-audit.workflow.mjs)                               | Caller-owned per-source pipeline, then complete synthesis and coverage review                         | Exact reviewed `audit.md`, or incomplete candidate/findings; empty required items are non-success                     |
| [Plan/replan](plan-replan.workflow.mjs)                                 | Observed results change remaining work; planner replaces named files and executor reads the next step | Evidenced delivery account in `delivery.md`, or non-success with plan and latest execution                            |
| [Reflection](reflection.workflow.mjs)                                   | Improve a low-risk explanation through draft, critique and revision                                   | Editorial revision in `document.md`; no independent acceptance claim                                                  |
| [Parallel investigation + Reflection](parallel-reflection.workflow.mjs) | Independent evidence and reader investigation before synthesis, critique and revision                 | Editorial revision in `document.md`, preserving both investigations in its handoffs                                   |

The primary loop uses the [shared working context](../../../../../skills/locus-pi-workflow-create/references/authoring-styles.md#folder-level-context):
original Task, verified checkout/branch, delegated product root, and an explicit orchestration/evidence folder.
Only the developer changes product files. It writes `implementation.md`; the reviewer reads it and writes
only `findings.md`, then returns the actual DSL choice. Corrections reopen the files; source passes short
statuses, never full review transcripts. Each correction requires fresh review, including the final allowed one.

Project tour is secondary. It uses author-known README/package sources, separate assigned `purpose.md`
and `commands.md` artifacts, and a single composer assigned `guide.md`. The composer waits for both writers
and reopens their files. Parallel workers never share an output path. Other semantic input is one string: supply the request, required evidence and
source locations for agents to inspect. Caller audit additionally requires structured tool `items`; slash syntax cannot supply them.
Its callbacks receive previous value and composite index, not an original-item argument.
Caller audit also passes all complete original units to verification, synthesis and coverage review.
A provider failure may have no answer or source identity; retain that unassigned failure and compare
required coverage with the original units rather than guessing a source from a slot.
File handoffs such as `findings.md`,
`plan.md` and `next-step.md` use exact caller-assigned paths in the whole input. The final guide/audit/delivery files are also written directly by agents; optional text snapshots do not attest their existence.
Workflow source never reads or parses them. Choose a fresh workspace for an
independent run; a mentioned path does not change the child project directory.
All calls inherit configured model routing. Independent sessions may use the
same model; the examples make no claim of measured model quality.

Use [Design → review → Build](../../../../../skills/locus-pi-workflow-create/references/design-and-build.md)
to adapt a starter into `.locus-pi/workflows/<name>/<name>.workflow.mjs` with a
matching `meta.name` and reviewed design. Check its exact bytes before running:

```text
node --check <exact-path>
npm run check:workflow-source -- --mode orchestration-only <exact-path>
```

The second command is available from a checkout. Installed Pi provides
`workflow_check_source` with `mode: "orchestration-only"`. These checks establish
syntax and supported source shape; they do not run children or certify judgment,
file contents or task completion. Follow the [create guide](../../../../../docs/workflows/create.md)
and [run guide](../../../../../docs/workflows/running.md) for the full authoring/launch route.

Keep the deeper references when their mechanisms are needed:
[fixed](../fixed.workflow.mjs), [refinement](../refinement.workflow.mjs),
[adaptive design](../adaptive-design.workflow.mjs), [adaptive slices](../adaptive-slices.workflow.mjs),
[caller-supplied decomposition](../decomposition.workflow.mjs), and
[human continuation](../human-continuation.workflow.mjs). The last is a reviewed
compatibility example; the six starters use orchestration-only source.
