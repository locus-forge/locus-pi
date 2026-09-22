# Choose a workflow shape

First resolve specification creation, specification revision or implementation; ask only if the request is ambiguous. Author implementation after the user examines the actual specification and asks for it. Default substantive implementation to adaptive slices. Choose by the required control decision, not by agent count. Read one card, then [design-and-build.md](design-and-build.md).

| Form                                        | When                                   | Default call cost                                  |
| ------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| [Adaptive slices](adaptive-slices.md)       | Implement and re-cut a remaining queue | Bounded total slices plus corrections and final QA |
| [Fixed graph](fixed-graph.md)               | Stages/units known                     | Exactly the declared calls                         |
| [Bounded refinement](bounded-refinement.md) | A verifier may demand more work        | Up to 3R logical calls in the text-review recipe   |
| [Bounded decomposition](decomposition.md)   | Work units discovered during execution | Discovery + bounded workers + aggregation          |
| [Human continuation](human-continuation.md) | Only the operator can authorize/decide | Two stages in separate runs                        |

Crash replay is a runtime capability, not another graph pattern. Generated source is a way to obtain a graph, not semantic continuation. Candidate search, councils and fixed fan-out are fixed-graph techniques unless the design explicitly adds refinement. No universal judge is injected.

[Structured results](structured-results.md) covers a same-agent shaped answer — choice, closed string, handoffs or compatibility schema, all accepted in the child's own session. Read it before handing an arbiter decision to a router: it covers decision ownership and the evidence the next agent actually receives. It is an output contract inside a card's graph, not a fifth graph form.

## Start from the user's current problem

[Repair + Continue](repair-and-continue.md) is the first card for a failed or stopped graph that needs a source fix. Keep the matching completed prefix instead of recreating the workflow.

Large fan-out runs are owned by [locus-pi-workflow-run](../../locus-pi-workflow-run/SKILL.md#large-runs-observe-and-let-the-operator-decide). Authoring adds no total-call cap and no token budget API.

[Authoring styles](authoring-styles.md) separates graph choice, outcome-led/procedural briefs, advisory size, and executor budgets.
