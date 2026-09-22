# Specification and adaptive implementation

Author these workflows separately. First create a workflow that develops a specification. After its run, the user examines the result and asks to implement. Only then author the implementation workflow against the actual specification and documentation directory. Its initial slice briefs identify a goal, source context, concrete completion outcome, evidence and constraints. The task specification and the workflow graph's `.design.md` are different documents.

If the requested deliverable or authoritative specification is unclear, clarify it before authoring. A clear implementation request is authorization; a special acceptance file is not required. A generated document alone is not authorization. Ordinary omissions and correctable technical defects enter the implementation queue.

## Graphs and judgment

Specification: author → independent reported review → substantive arbiter → correction or review retry → fresh review. The arbiter can accept or reject findings with evidence, return an indispensable product question, or stop with a concrete reason. A completed proposal remains distinct from independently reviewed work and implemented behavior.

Implementation: scope intake → baseline → remaining queue → scope decision → implement one slice → reported review → arbiter → correction/review retry → fresh review → record progress → re-cut. After completion evidence, final checks and a final arbiter assess delivery. Fixed graphs and stricter reviewer-gated refinement remain explicit alternatives when the task calls for them.

Use capable agents with outcome-led briefs under existing user routing. Leave inspection and implementation methods to them. Procedural detail is a separate choice for an actual constraint or observed failure, not the definition of an adaptive graph.

## Queue and continuation

Use `handoffs` for complete text briefs and `choice` for graph edges. Source consumes order/length and forwards opaque values; agents own meaning. The queue owner sees the previous whole queue, verified progress and live source. It may reorder, merge, shrink or replace remaining work within scope. Never silently drop unmet requirements or repeat verified slices.

Carry the queue in a `let` initialized with `[]` before a finite literal `for` loop. Forward each whole item; do not parse or truncate it. Carry narrative history through agent-owned reports/artifacts, preserving all execution outcomes and finding dispositions. No source-side semantic accumulator or parser is needed.

## Bounds and evidence

Derive limits from the task. The teaching references allow three specification reviews (two corrections), and three implementation slices with three reviews per slice (two corrections). Review retries consume the same review allowance. A last allowed review may accept work; no unreviewed last-minute correction follows it. The implementation graph's longest path is 57 logical calls; transport/output clarification resources remain separate. These are teaching allowances, not defaults for new tasks. The queue call declares `handoffs: {}`: the runtime puts no ceiling on the number of slices or on the length of one brief. A slice allowance is the literal loop bound in source, never a `maxItems`.

New residual findings after verified repairs are not proof of stagnation. Stop for no progress only with repeated evidence that the same criteria remain unresolved. At an allowance limit return the latest reviewed artifact, full remaining queue, unresolved criteria and next action. Exhaustion alone does not require a product decision. An incomplete required outcome remains non-successful.

`result: "report"` lets eligible terminal reviewer failures reach the arbiter. Keep failed/missing/skipped checks in its input and final handoff. A failed review is never a completed review. The arbiter can retry or accept a disclosed limitation when the required outcome is otherwise evidenced; it cannot invent evidence or waive the user's scope. Cancellation, global limits, uncertain child shutdown and persistence failures remain fatal. Ordinary `parallel()` still fails closed. See the runtime reference for the narrow capture list.

## Executable references

- [Specification refinement](../../../extensions/workflows/references/examples/adaptive-design.workflow.mjs) publishes the specification and review/disposition history. Its next action is to author implementation after the user's request, not launch a prebuilt command.
- [Adaptive implementation](../../../extensions/workflows/references/examples/adaptive-slices.workflow.mjs) consumes the selected specification, repairs ordinary omissions, re-cuts remaining work and reports verified/unverified/remaining outcomes.

These are packaged references, not registered commands. Copy/adapt a selected source into a reviewed project workflow folder, name its entry, set task-specific initial slices, criteria, resource bounds and artifact locations, then validate. The source never launches its counterpart. Baseline preparation is not implementation. Commit only when authorized. Headless product questions return readable questions/options and artifact paths, not an unavailable interactive pause.
