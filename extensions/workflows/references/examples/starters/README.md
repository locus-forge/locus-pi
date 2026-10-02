---
updated: "2026-10-02T17:36:25Z"
source_commit: "8af5c47f379a"
update_event: "user_request"
context: "changes=L files=13"
description: "Explain inputs and limitations of reusable agentic workflow starters"
---

# Small workflow starters

These complete modules teach reusable interactions. Choose from the task need
using the [semantic approach guide](../../../../../skills/locus-pi-workflow-create/references/agentic-approaches.md),
then adapt the prompts, criteria and finite allowances. They are starting points,
not compulsory templates or runnable names in the Package catalog.

| Source                                                                  | Task need and mechanism                                                                               | Terminal result                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Evaluator-Optimizer](evaluator-optimizer.workflow.mjs)                 | Known implementation scope; reviewer-owned findings and choice, one correction followed by recheck    | Exact accepted handoff in `implementation.md`, or non-success with the preserved change and workspace findings |
| [Plan/replan](plan-replan.workflow.mjs)                                 | Observed results change remaining work; planner replaces named files and executor reads the next step | Evidenced delivery account in `delivery.md`, or non-success with plan and latest execution                     |
| [Reflection](reflection.workflow.mjs)                                   | Improve a low-risk explanation through draft, critique and revision                                   | Editorial revision in `document.md`; no independent acceptance claim                                           |
| [Parallel investigation + Reflection](parallel-reflection.workflow.mjs) | Independent evidence and reader investigation before synthesis, critique and revision                 | Editorial revision in `document.md`, preserving both investigations in its handoffs                            |

Every input is one semantic string: supply the request, required evidence and
source locations for agents to inspect. File handoffs such as `findings.md`,
`plan.md` and `next-step.md` live in the host-provided workflow workspace.
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
compatibility example; the four starters use orchestration-only source.
