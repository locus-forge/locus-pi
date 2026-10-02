---
updated: "2026-10-02T17:32:37Z"
source_commit: "8af5c47f379a"
update_event: "created"
context: "changes=L files=17"
description: "Explain reusable feedback, reflection, replanning and composition approaches"
---

# From task need to an agentic approach

An approach explains why agents interact: what they observe, what feedback
changes, and who decides completion. A graph expresses those interactions with
Pi calls. Choose the mechanism for the task, then remove nodes without a useful
consumer. See the [index](INDEX.md) for execution cards and the
[starter guide](../../../extensions/workflows/references/examples/starters/README.md) for
complete reusable modules. Examples inherit configured routing; separate child
sessions do not imply different models.

## Reflection

Use Reflection when a draft can improve through explicit critique: explanation,
editing or source-grounded synthesis. The producer drafts; the critic identifies
specific weaknesses against the request and sources; revision applies feedback
supported by those sources. Feedback changes the content, not the original goal.

The [editorial starter](../../../extensions/workflows/references/examples/starters/reflection.workflow.mjs)
passes the complete draft to critique, then the complete draft and critique to
revision. It retains draft/critique artifacts and publishes the complete revised
document after one editorial cycle. That terminal result is a revised draft;
it has no independent acceptance gate. An execution error still fails the run.

One cycle fits a low-risk document when revision is the requested deliverable.
Omit critique for a direct transformation whose outcome needs no feedback; combine
critique and revision in one child when a separate perspective has no useful role.
If the task requires evidenced acceptance after revision, add a fresh verifier
and explicit non-success route as in Evaluator-Optimizer. Do not label the last
unreviewed revision as independently accepted.

## Evaluator-Optimizer

Use Evaluator-Optimizer when the work must meet declared criteria and actionable
evaluation can guide correction. The worker implements or revises. The evaluator
inspects the actual result and evidence, identifies concrete residuals, and owns
acceptance. Correction receives those findings and is followed by fresh review.
Criteria stay fixed; only the candidate and feedback change.

The [feedback starter](../../../extensions/workflows/references/examples/starters/evaluator-optimizer.workflow.mjs)
uses known stages and a bounded loop: work → review → correction → recheck.
The reviewer writes complete explanations in workspace `findings.md` and returns
an exact `choice` at the same call. The correction agent reads that file; source
does not parse it. A separate router is unnecessary because this reviewer owns
the decision. Success publishes the exact reviewed worker handoff and names the
implemented artifact locations. The teaching allowance permits one correction;
exhaustion or an unavailable required prerequisite preserves work/findings and
returns non-success, without one last unreviewed worker.

Separate observed defects, missing required evidence and optional checks not
performed. Optional unavailability alone is a disclosed limitation. Required
evidence remains binding. Use a substantive arbiter only when the task needs an
authority that can adjudicate disputed findings; the
[full refinement card](bounded-refinement.md) also explains evidence and progress
tracking. Omit a review loop when no correction decision is needed; required
verification still belongs in the graph.

## Plan-and-Execute/Replan

Use Plan-and-Execute when work needs an explicit plan; add Replan when observed
results can change what remains. The planner owns a sequence and unfinished
requirements. Execution completes one in-scope step and records evidence.
Replanning uses those observations to reorder, replace, merge or remove now
unnecessary steps while preserving unmet requirements and authorized scope.
A large task with known stages can stay fixed.

The [plan/replan starter](../../../extensions/workflows/references/examples/starters/plan-replan.workflow.mjs)
has the planner replace workspace `plan.md` and `next-step.md`; an executor reads
the next brief and returns a complete handoff. Source routes only the planner's
exact `choice`, never the plan's contents. The planner assesses completion after
each step, including the last allowed step. Completion requires actual evidence
for every required outcome/check; an empty plan alone proves nothing. Three work
opportunities illustrate a finite allowance. Exhaustion preserves the plan,
next step and latest result as incomplete; a concrete unavailable required
prerequisite is blocked. Add any required independent review as a planned step.

Omit the planner when the sequence is already known. Combine planning with an
existing decision owner when it already inspects results and owns remaining
work. For reviewed implementation slices and richer final verification use the
[full adaptive card](adaptive-slices.md). Discovered units in an agent-written
file can guide later agents sequentially. They cannot become a source-parsed
parallel worker list; caller-owned units use `items()` instead.

## Combine and simplify

Chaining passes a complete result into the next stage; direct `agent()` calls or
`pipeline()` express known dependencies. Routing uses an exact `choice` only
when the next action must differ. Parallel cooperation investigates independent
angles before a barrier and synthesis; use `parallel()` with authored branches
or caller-supplied `items()`. Parallel agents should have distinct work and
inputs, not merely different persona names.

The [composition starter](../../../extensions/workflows/references/examples/starters/parallel-reflection.workflow.mjs)
investigates facts and reader needs in parallel → synthesizes both complete
reports → critiques the synthesis against both reports → revises. The barrier
retains declared report order even when children finish in another order.
Draft/critique artifacts remain available; the terminal document is an editorial
revision with the same acceptance limitation as Reflection.

Remove the investigations when sources are already ready. Use one investigation
when angles overlap. Omit critique/revision when synthesis alone meets the task;
add evaluator feedback after revision when required evidence must gate delivery.
Replan only if findings change remaining work. Each added node needs a distinct
responsibility and a consumer; none of router, arbiter, reviewer or human approval
is universal. A task's existing external-action authorization remains its boundary.

## Child Tool Use and ReAct

Tool Use belongs inside the child task: it reads sources, queries an available
tool, acts within authorization, observes results and uses those observations.
Workflow source supplies the goal and handoffs; it does not dispatch domain
tools, load files or parse model text on the child's behalf.

ReAct describes an interleaved reasoning/action/observation process. A child
having tools does not establish that particular algorithm. If a task needs such
a process, state the observation and completion responsibilities in its brief
and assess actual execution evidence. Do not invent a source-side JSON/XML
protocol or a child-owned spawning control plane. The supported methods and
source grammar remain owned by the [DSL reference](../../../docs/workflows/dsl.md)
and [source contract](../../../docs/workflows/source-shape.md).
