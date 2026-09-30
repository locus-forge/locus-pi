# Caller-owned units and workers

Use this card when independent work units are known before launch — by the operator, an earlier run, or a deterministic record. Avoid overlapping write effects, recursive manager delegation or a hidden generated execution graph.

Graph: caller `dsl.items()` → visible parallel/pipeline workers → aggregator. Each item is one complete text unit, forwarded unchanged.

Cost: K×W + 1 calls for K items and W stages per unit; logical depth W + 1. Local group width and the shared physical-agent budget both apply.

Handoff: exact items go to workers; complete worker text goes to aggregation. `dsl.items()` is an exact-list contract with no Locus items count or character policy. An agent never returns the list: when discovery is needed, run it first as its own stage or run that writes a named workspace file, and let the operator or a later invocation turn that file into items. A queue that changes as work lands is an [adaptive slice](adaptive-slices.md) loop over a workspace file, not a returned list.

Failure: an empty item list is a named blocked exit, never success. Worker failure rejects its barrier. Do not silently filter failures out of the final catalog.

Primitives: items, parallel or pipeline, exact-text aggregation. Labels are literal callsite identities, not interpolated item numbers. Author-known literal records may use named properties/flat destructuring; caller items remain opaque strings.

Replay reuses only the exact recorded prefix of confirmed calls. This is not a blanket non-resumable pattern. Fresh discovery must not be rebound to old durable checkpoint keys. Never derive resumable positional keys from a fresh model output. For saved-child checkpoints a separate caller must supply a frozen approved list with the exact same ordering and deliberate semantic keys.

Keep decomposition in the visible harness, not child `spawn_agent`/`task`, which remains unavailable. No agent here acquires an independent orchestration control plane.

[Runnable decomposition example](../../../extensions/workflows/references/examples/decomposition.workflow.mjs). For author-owned keyed inventories use [execution controls](../../../docs/workflows/dsl.md).
