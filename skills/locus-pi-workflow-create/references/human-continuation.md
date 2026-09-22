# Human-gated continuation

Use this card when the next action requires a real operator decision, authorization or scope change. Avoid it as a substitute for an ordinary machine check.

Graph: prepare → publish state → awaitOperator + return; operator answer → a new run bound to verified continuation artifacts → next stage. There is no suspended JavaScript stack and no transcript inheritance.

Cost: preparation calls plus the new run's calls, separated by the human decision. Waiting is not another agent review round.

Handoff: original goal/constraints, proposal, evidence, precise question and continuationArtifactRefs nested under operatorHandoff. Cross-run artifacts are digest-checked by the host. Never put artifactRefs at the top of awaitOperator.

Failure: noOperator fails closed; cancellation, declined authorization and corrupt artifacts are not approval. Returned ok alone does not establish completion: inspect the terminal disposition awaiting_operator. Always return immediately after declaring the gate.

Primitives: awaitOperator, publishArtifact and the host's operator continuation launcher. Exact reading of continuationArtifacts().consumedArtifact text is an integration/compatibility surface, not permission for standard-generated source to parse artifacts. Do not label that example standard or skip the source gate.

[Runnable compatibility example](../../../extensions/workflows/references/examples/human-continuation.workflow.mjs). The [recovery and continuation contract](../../../docs/workflows/recovery-and-continuation.md) distinguishes operator continuation from resumeFromRunId.
