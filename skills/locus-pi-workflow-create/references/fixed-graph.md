# Fixed graph

Use this card for one worker, a known sequence or independent author-known questions followed by synthesis. Avoid adding a supervisor/reviewer unless the acceptance contract requires one.

Graph: declared workers → optional declared aggregator → primary output.

Cost: exactly N declared calls; sequential depth is the graph depth. Parallel results retain input order; side effects finish independently. No semantic retry is injected.

Handoff: exact input and previous complete output. Put stable business keys and questions in author-owned records; do not encode them as newline/CSV/JSON and parse them back. Every callsite has a literal label; title may describe the item.

Failure: ordinary child/group failures fail closed. Root failure semantics are owned by the [runtime reference](../../../docs/workflows/trust.md#fail-closed-behavior).

Primitives: agent, parallel, pipeline, publishPrimaryArtifact. Use existing `parallel(thunks, { concurrency, keys, title })`, not an invented `parallel.map`. Nested keys form a path and must be unique within each group.

[Runnable fixed example](../../../extensions/workflows/references/examples/fixed.workflow.mjs). The more detailed mapping contract lives in [execution controls](../../../docs/workflows/dsl.md).
