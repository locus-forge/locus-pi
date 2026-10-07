---
updated: "2026-10-06T12:27:00Z"
source_commit: "fee5f591caaf"
update_event: "user_request"
context: "bounded schema authoring on the standard-tool contract"
description: "Teach ordinary and detailed workflow authoring with shared Pi contracts"
---

# Choose an approach for the task

After the first module and dependency lesson in the [ordinary](../SKILL.md) or
[detailed](../../locus-pi-workflow-create-detailed/SKILL.md) entry, choose what must
improve or change and the smallest supported graph. Both entries share
[Design → review → Build](design-and-build.md); the
[public create guide](../../../docs/workflows/create.md#choose-an-authoring-route) owns route selection.
For a failed or stopped graph needing a source fix, start with
[Repair + Continue](repair-and-continue.md) and preserve its completed prefix.

| Task need                                                                    | Semantic approach                            | Start here                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| Improve an explanatory draft with actionable critique                        | Reflection                                   | [Purpose and adaptation](agentic-approaches.md#reflection)                     |
| Correct work until declared criteria and required evidence are met           | Evaluator-Optimizer                          | [Feedback and acceptance](agentic-approaches.md#evaluator-optimizer)           |
| Revise remaining work after observing execution results                      | Plan-and-Execute/Replan                      | [Plan ownership and replanning](agentic-approaches.md#plan-and-executereplan)  |
| Pass known stages forward, choose a route, or investigate independent angles | Chaining, routing, parallel cooperation      | [Combine mechanisms](agentic-approaches.md#combine-and-simplify)               |
| Inspect or act on external information inside one task                       | Child Tool Use; ReAct when actually designed | [Child tools and observations](agentic-approaches.md#child-tool-use-and-react) |

Read only the selected semantic explanation and the execution card needed for its control flow.
The entry skill already includes the complete sequential starter; do not reread another copy.
Read a different starter only when its mechanism is needed. These approaches combine; they are
not compulsory role lists. Keep known scope/stages fixed, including substantive
implementation. Replan when observed results must change remaining work, not
because a task is large. Review alone does not require a queue manager or arbiter.

## Map the approach to Pi execution

| Form                                        | When                                                    | Call cost                                                    |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| [Fixed graph](fixed-graph.md)               | Stages/units known; may include a bounded feedback loop | Declared stages within their bounds                          |
| [Bounded refinement](bounded-refinement.md) | A verifier may demand correction                        | Up to 3R logical calls in the full text-review recipe        |
| [Adaptive slices](adaptive-slices.md)       | Observed results re-cut remaining work                  | Bounded total slices plus corrections and final verification |
| [Bounded decomposition](decomposition.md)   | Caller supplies independent work units                  | Bounded workers plus aggregation                             |
| [Human continuation](human-continuation.md) | A real operator answer is required                      | Two stages in separate runs                                  |

The [starter guide](../../../extensions/workflows/references/examples/starters/README.md)
links four small complete modules. Keep the full refinement/adaptive references
for richer evidence and control needs. Example allowances illustrate finite
control flow; they are not task or spending defaults.

Crash replay is a runtime capability, not a semantic approach. Generated source
is a way to obtain a graph, not semantic continuation. Candidate search, councils
and fixed fan-out can use known stages; no universal judge is injected.

[Structured results](structured-results.md) explains whole text, reviewer-owned
choices, bounded literal-schema JSON consumption and exact caller-assigned files. Read it before introducing a separate arbiter
or decision translator. It refines a graph's handoffs rather than adding a form.
[Authoring styles](authoring-styles.md) separates graph choice, brief detail,
advisory size and executor routing. Large fan-out monitoring belongs to
[locus-pi-workflow-run](../../locus-pi-workflow-run/SKILL.md#observe-and-report).
