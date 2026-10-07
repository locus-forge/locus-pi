---
updated: "2026-10-02T22:53:28Z"
source_commit: "0d098c9e06d1"
update_event: "user_request"
context: "changes=L files=29"
description: "Teach ordinary and detailed workflow authoring with shared Pi contracts"
---

# From task need to an agentic approach

An approach explains why agents interact: what they observe, what feedback changes, and who decides
completion. Choose the task mechanism, then its execution recipe; read only those sections.
The [starter guide](../../../extensions/workflows/references/examples/starters/README.md) supplies complete
reusable modules. Examples inherit configured routing; separate child sessions do not imply different models.

## Choose an approach

After the first module and dependency lesson in the [ordinary](../SKILL.md) or
[detailed](../../locus-pi-workflow-create-detailed/SKILL.md) entry, choose what must
improve or change and the smallest supported graph. Both entries share
[Design → review → Build](design-and-build.md); the
[public create guide](../../../docs/workflows/create.md#choose-an-authoring-route) owns route selection.
For a failed or stopped graph needing a source fix, start with
[Repair + Continue](repair-and-continue.md) and preserve its completed prefix.

| Task need                                                                    | Semantic approach                            | Start here                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Improve an explanatory draft with actionable critique                        | Reflection                                   | [Purpose and adaptation](#reflection)                     |
| Correct work until declared criteria and required evidence are met           | Evaluator-Optimizer                          | [Feedback and acceptance](#evaluator-optimizer)           |
| Revise remaining work after observing execution results                      | Plan-and-Execute/Replan                      | [Plan ownership and replanning](#plan-and-executereplan)  |
| Pass known stages forward, choose a route, or investigate independent angles | Chaining, routing, parallel cooperation      | [Combine mechanisms](#combine-and-simplify)               |
| Inspect or act on external information inside one task                       | Child Tool Use; ReAct when actually designed | [Child tools and observations](#child-tool-use-and-react) |

Read only the selected semantic explanation and the execution card needed for its control flow.
The entry skill already includes the complete sequential starter; do not reread another copy.
Read a different starter only when its mechanism is needed. These approaches combine; they are
not compulsory role lists. Keep known scope/stages fixed, including substantive
implementation. Replan when observed results must change remaining work, not
because a task is large. Review alone does not require a queue manager or arbiter.

### Map the approach to Pi execution

| Form                                      | When                                                    | Call cost                                                    |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| [Fixed graph](#fixed-graph)               | Stages/units known; may include a bounded feedback loop | Declared stages within their bounds                          |
| [Bounded refinement](#bounded-refinement) | A verifier may demand correction                        | Up to 3R logical calls in the full text-review recipe        |
| [Adaptive slices](#adaptive-slices)       | Observed results re-cut remaining work                  | Bounded total slices plus corrections and final verification |
| [Bounded decomposition](#decomposition)   | Caller supplies independent work units                  | Bounded workers plus aggregation                             |
| [Human continuation](#human-continuation) | A real operator answer is required                      | Two stages in separate runs                                  |

The [starter guide](../../../extensions/workflows/references/examples/starters/README.md)
links four small complete modules. Keep the full refinement/adaptive sections
for richer evidence and control needs. Example allowances illustrate finite
control flow; they are not task or spending defaults.

Crash replay is a runtime capability, not a semantic approach. Generated source
is a way to obtain a graph, not semantic continuation. Candidate search, councils
and fixed fan-out can use known stages; no universal judge is injected.

[Structured results](source-boundary.md#structured-results) explains whole text, reviewer-owned
choices, bounded literal-schema JSON consumption and exact caller-assigned files. Read it before introducing a separate arbiter
or decision translator. It refines a graph's handoffs rather than adding a form.
[Authoring styles](design-and-build.md#choose-style-detail-size-and-executors-separately) separates graph choice, brief detail,
advisory size and executor routing. Large fan-out monitoring belongs to
[locus-pi-workflow-run](../../locus-pi-workflow-run/SKILL.md#observe-and-report).

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
The reviewer writes complete explanations in the assigned `findings.md` and returns
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
[full refinement card](#bounded-refinement) also explains evidence and progress
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
has the planner replace the assigned `plan.md` and `next-step.md`; an executor reads
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
[full adaptive card](#adaptive-slices). Discovered units in an agent-written
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

## Quality patterns within the task

For quality work, compose only evidence mechanisms that affect the task. Distinct
source/search lenses can find different omissions; an adversarial verifier tries
to refute a specific claim; a completeness critic identifies unread sources,
unverified claims or missing coverage. Their findings feed correction or replanning,
not a universal judge. When repeated discovery is needed, an agent keeps seen and
rejected findings together in a named file so rejected claims do not reappear as
new work. Source routes exact choices within task-derived finite bounds; the
decision owner establishes “nothing new” from evidence. Disclose sampling,
unperformed searches and exhausted coverage rather than claiming completeness.

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

## Fixed graph

Use this card for one worker, a known sequence or independent author-known questions followed by synthesis. Avoid adding a supervisor/reviewer unless the acceptance contract requires one.

Graph: declared workers → optional declared aggregator → primary output.

Cost: the declared stages within their declared bounds; sequential depth is the graph depth. Parallel results retain input order; side effects finish independently. No semantic retry is injected.

Handoff: exact input and previous complete output. Put stable business keys and questions in author-owned records; do not encode them as newline/CSV/JSON and parse them back. Every callsite has a literal label; title may describe the item.

Loops: "fixed" means the stages and bounds are known before launch, not that source has no loop. A review that can demand correction is a literal bounded review loop from the [refinement card](#bounded-refinement). A node after alternative branches receives their whole reports through a carry declared immediately before that loop. Conformance checks stages, routes, handoffs and that every loop is finite, not loop syntax or exact call counts.

Failure: ordinary child/group failures fail closed. Root failure semantics are owned by the [runtime reference](../../../docs/workflows/trust.md#fail-closed-behavior).

Primitives: agent, parallel, pipeline, publishPrimaryArtifact; choice and a literal bounded for when a review loop is declared. Use existing `parallel(thunks, { concurrency, keys, title })`, not an invented `parallel.map`. Nested keys form a path and must be unique within each group.

[Runnable fixed example](../../../extensions/workflows/references/examples/fixed.workflow.mjs). The more detailed mapping contract lives in [execution controls](../../../docs/workflows/dsl.md).

## Bounded refinement

Use this card when a worker may leave concrete work unfinished. Avoid it without acceptance criteria, when effects cannot be safely repeated, or when only an operator has authority. Do not use worker self-approval for a higher-risk adaptive result.

Graph: fresh worker → independent reviewer → exact choice; continue → fresh worker with exact handoff. One review, at most one correction and one recheck is the two-round case (`round <= 2`) inside a fixed graph. Complete → primary output; failed, cap or no-progress → honest non-success; needs_operator → stop and return.

Cost: the recipe uses 3R logical calls and sequential depth 3R. Output clarification remains in that call's own session and still costs tokens/turns/tools; it never adds a physical child. No transport retries are declared in the example.

Handoff: immutable original goal, constraints and criteria; previous worker result; exact reviewer feedback; completed work with evidence; precise remaining scope. Keep only useful prior-round state, not a concatenated transcript. A fresh worker has a new conversation, not a promise of an empty resource environment.

Completion authority: prefer deterministic validation where a real machine criterion exists; use a domain reviewer for semantic criteria; require the operator for permissions and unresolved policy. A model saying “tests passed” and JSON Schema validation are not deterministic proof.

The example chooses three rounds and stops on two consecutive continue_stalled decisions. These are recipe choices, not new global defaults. Progress means changed verified criteria/evidence, not changed prose or tool usage. Stable unresolved criterion IDs help the reviewer compare rounds. No JavaScript regex grades model prose.

Failure: complete publishes the reviewed primary result. At cap/no-progress return `ok:false`, `status:"blocked"` and evidence; never publish the last unreviewed edit as success. A child error propagates; no reviewer-approved fallback can invent missing execution. `needs_operator` declares awaiting_operator and immediately returns. The example's reason-only stop is not an automatic resumable human handoff.

Primitives: agent, choice, literal bounded for, publishArtifact, publishPrimaryArtifact, log, awaitOperator. Whole-value carry is allowed only by the canonical bounded-loop provenance rules in [source contract](../../../docs/workflows/source-shape.md#bounded-carry-and-author-owned-records). This recipe's reviewer decision reaches source as that exact `choice`. Literal-schema results are a separate bounded authoring option; custom `validate` remains removed.

[Runnable refinement example](../../../extensions/workflows/references/examples/refinement.workflow.mjs). Every round artifact records the original goal, work, review, decision and next-worker feedback. Choose an explicit shared budget at launch; see [execution controls](../../../docs/workflows/dsl.md). Replay is separate: see [recovery](../../../docs/workflows/recovery-and-continuation.md).

## Adaptive slices

Author these workflows separately. First create a workflow that develops a specification. After its run, the user examines the result and asks to implement. Only then author the implementation workflow against the actual specification and documentation directory. Its initial slice briefs identify a goal, source context, concrete completion outcome, evidence and constraints. The task specification and the workflow graph's `.design.md` are different documents.

If the requested deliverable or authoritative specification is unclear, clarify it before authoring. A clear implementation request is authorization; a special acceptance file is not required. A generated document alone is not authorization. Ordinary omissions and correctable technical defects enter the implementation queue.

### Graphs and judgment

Specification: author → independent reported review → substantive arbiter → correction or review retry → fresh review. The arbiter can accept or reject findings with evidence, return an indispensable product question, or stop with a concrete reason. A completed proposal remains distinct from independently reviewed work and implemented behavior.

Implementation: scope intake → baseline → remaining queue → scope decision → implement one slice → reported review → arbiter → correction/review retry → fresh review → record progress → re-cut. After completion evidence, final checks and a final arbiter assess delivery. Fixed graphs and stricter reviewer-gated refinement remain explicit alternatives when the task calls for them.

Use capable agents with outcome-led briefs under existing user routing. Leave inspection and implementation methods to them. Procedural detail is a separate choice for an actual constraint or observed failure, not the definition of an adaptive graph.

### Queue and continuation

The queue owner rewrites an exact caller-assigned queue file whole, one complete text brief per item; each stage reads its first item, and `choice` routes every graph edge. Source never reads the file and forwards opaque values; agents own meaning. The queue owner sees the previous whole queue file, verified progress and live source. It may reorder, merge, shrink or replace remaining work within scope. Never silently drop unmet requirements or repeat verified slices.

The queue exists only as that assigned file; no JavaScript variable holds it. Source keeps a finite literal `for` loop and forwards whole agent text, such as the last accepted progress report, without parsing or truncating it. Carry narrative history through agent-owned reports/artifacts, preserving all execution outcomes and finding dispositions. No source-side semantic accumulator or parser is needed.

### Bounds and evidence

Derive limits from the task. The teaching references allow three specification reviews (two corrections), and three implementation slices with three reviews per slice (two corrections). Review retries consume the same review allowance. A last allowed review may accept work; no unreviewed last-minute correction follows it. The implementation graph's longest path is 57 logical calls; transport/output clarification resources remain separate. These are teaching allowances, not defaults for new tasks. The queue owner is a plain call that writes the file and returns readable text; the runtime puts no ceiling on the number of queued slices or on the length of one brief. A slice allowance is the literal loop bound in source, not an item count the agent returns.

New residual findings after verified repairs are not proof of stagnation. Stop for no progress only with repeated evidence that the same criteria remain unresolved. At an allowance limit return the latest reviewed artifact, full remaining queue, unresolved criteria and next action. Exhaustion alone does not require a product decision. An incomplete required outcome remains non-successful.

`result: "report"` lets eligible terminal reviewer failures reach the arbiter. Keep failed/missing/skipped checks in its input and final handoff. A failed review is never a completed review. The arbiter can retry or accept a disclosed limitation when the required outcome is otherwise evidenced; it cannot invent evidence or waive the user's scope. Cancellation, global limits, uncertain child shutdown and persistence failures remain fatal. Ordinary `parallel()` still fails closed. See the runtime reference for the narrow capture list.

### Executable references

- [Specification refinement](../../../extensions/workflows/references/examples/adaptive-design.workflow.mjs) publishes the specification and review/disposition history. Its next action is to author implementation after the user's request, not launch a prebuilt command.
- [Adaptive implementation](../../../extensions/workflows/references/examples/adaptive-slices.workflow.mjs) consumes the selected specification, repairs ordinary omissions, re-cuts remaining work and reports verified/unverified/remaining outcomes.

These are packaged references, not registered commands. Copy/adapt a selected source into a reviewed project workflow folder, name its entry, set task-specific initial slices, criteria, resource bounds and artifact locations, then validate. The source never launches its counterpart. Baseline preparation is not implementation. Commit only when authorized. Headless product questions return readable questions/options and artifact paths, not an unavailable interactive pause.

## Decomposition

Use this card when independent work units are known before launch — by the operator, an earlier run, or a deterministic record. Avoid overlapping write effects, recursive manager delegation or a hidden generated execution graph.

Graph: caller `dsl.items()` → visible parallel/pipeline workers → aggregator. Each item is one complete text unit, forwarded unchanged.

Cost: K×W + 1 calls for K items and W stages per unit; logical depth W + 1. Local group width and the shared physical-agent budget both apply.

Handoff: exact items go to workers; complete worker text goes to aggregation. `dsl.items()` is an exact-list contract with no Locus items count or character policy. An agent never returns the list: when discovery is needed, run it first as its own stage or run that writes an exact caller-assigned file, and let the operator or a later invocation turn that file into items. A queue that changes as work lands is an [adaptive slice](#adaptive-slices) loop over an assigned file, not a returned list.

Failure: an empty item list is a named blocked exit, never success. Worker failure rejects its barrier. Do not silently filter failures out of the final catalog.

Primitives: items, parallel or pipeline, exact-text aggregation. Labels are literal callsite identities, not interpolated item numbers. Author-known literal records may use named properties/flat destructuring; caller items remain opaque strings.

Replay reuses only the exact recorded prefix of confirmed calls. This is not a blanket non-resumable pattern. Fresh discovery must not be rebound to old durable checkpoint keys. Never derive resumable positional keys from a fresh model output. For saved-child checkpoints a separate caller must supply a frozen approved list with the exact same ordering and deliberate semantic keys.

Keep decomposition in the visible harness, not child `spawn_agent`/`task`, which remains unavailable. No agent here acquires an independent orchestration control plane.

[Runnable decomposition example](../../../extensions/workflows/references/examples/decomposition.workflow.mjs). For author-owned keyed inventories use [execution controls](../../../docs/workflows/dsl.md).

## Human continuation

Use this card when the next action requires a real operator decision, authorization or scope change. Avoid it as a substitute for an ordinary machine check.

Graph: prepare → publish state → awaitOperator + return; operator answer → a new run bound to verified continuation artifacts → next stage. There is no suspended JavaScript stack and no transcript inheritance.

Cost: preparation calls plus the new run's calls, separated by the human decision. Waiting is not another agent review round.

Handoff: original goal/constraints, proposal, evidence, precise question and continuationArtifactRefs nested under operatorHandoff. Cross-run artifacts are digest-checked by the host. Never put artifactRefs at the top of awaitOperator.

Failure: noOperator fails closed; cancellation, declined authorization and corrupt artifacts are not approval. Returned ok alone does not establish completion: inspect the terminal disposition awaiting_operator. Always return immediately after declaring the gate.

Primitives: awaitOperator, publishArtifact and the host's operator continuation launcher. Exact reading of continuationArtifacts().consumedArtifact text is an integration/compatibility surface, not permission for standard-generated source to parse artifacts. Do not label that example standard or skip the source gate.

[Runnable compatibility example](../../../extensions/workflows/references/examples/human-continuation.workflow.mjs). The [recovery and continuation contract](../../../docs/workflows/recovery-and-continuation.md) distinguishes operator continuation from resumeFromRunId.
