# Fixed graph

Use this card for one worker, a known sequence or independent author-known questions followed by synthesis. Avoid adding a supervisor/reviewer unless the acceptance contract requires one.

Graph: declared workers → optional declared aggregator → primary output.

Cost: the declared stages within their declared bounds; sequential depth is the graph depth. Parallel results retain input order; side effects finish independently. No semantic retry is injected.

Handoff: exact input and previous complete output. Put stable business keys and questions in author-owned records; do not encode them as newline/CSV/JSON and parse them back. Every callsite has a literal label; title may describe the item.

Loops: "fixed" means the stages and bounds are known before launch, not that source has no loop. A review that can demand correction is a literal bounded review loop from the [refinement card](bounded-refinement.md). A node after alternative branches receives their whole reports through a carry declared immediately before that loop. Conformance checks stages, routes, handoffs and that every loop is finite, not loop syntax or exact call counts.

Failure: ordinary child/group failures fail closed. Root failure semantics are owned by the [runtime reference](../../../docs/workflows/trust.md#fail-closed-behavior).

Primitives: agent, parallel, pipeline, publishPrimaryArtifact; choice and a literal bounded for when a review loop is declared. Use existing `parallel(thunks, { concurrency, keys, title })`, not an invented `parallel.map`. Nested keys form a path and must be unique within each group.

[Runnable fixed example](../../../extensions/workflows/references/examples/fixed.workflow.mjs). The more detailed mapping contract lives in [execution controls](../../../docs/workflows/dsl.md).
