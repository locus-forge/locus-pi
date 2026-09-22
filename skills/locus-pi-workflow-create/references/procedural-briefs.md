# Procedural briefs — explicit alternative

Use when a concrete interface requires an exact sequence, or a measured failure shows that an outcome-led brief omits information the worker needs. This detail choice can be used with a fixed graph or an adaptive queue. It does not imply a model tier.

Outcome-led default:

> Review this slice against the accepted design. SOURCES: task directory, actual diff and baseline. Return confirmed defects with evidence and bounded fix instructions. Preserve all acceptance criteria. Do not edit source.

Procedural alternative for a repository whose verification contract fixes the sequence:

> Verify this slice using the repository's documented release check. SOURCES: task directory, actual diff and baseline. Run the schema migration dry check before the integration suite because the suite consumes its generated fixture. Record each command and exit. A failed migration check blocks the suite and is not a passing verification. Return requirement coverage and unresolved failures. Do not modify production data.

The additional sequence is justified by a consumer dependency, not a desire to control every tool call. Do not invent commands, budgets, repeated headings, acknowledgements or compatibility layers. Keep only the procedure that changes correctness. Never silently fall back to this style because an executor is called “weak”; compare both brief styles on the same accepted task and verified executor before making that claim.

For fixed work use [fixed graph](fixed-graph.md); for implementation with remaining-plan changes use [adaptive slices](adaptive-slices.md).
