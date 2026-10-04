# Task workflow authoring

`task` is a group-only Package namespace with manual stages. Run `task/draft`
first, then one of the two plan workflows.

1. `task/draft` turns a raw request into `draft.md`. The draft already names the
   workflow pattern, agents, handoffs, bounded reflection or review, concurrency,
   failure exits, and expected output. Copy and edit this text when needed.
2. `task/plan` receives the complete accepted draft as semantic input. One
   author call plans the graph and writes the complete caller-assigned `workflow.mjs`;
   a bounded loop then reviews it and revises it, and the accepted file is
   retained at that exact path for the caller to reopen. Use it with a strong author model.
3. `task/plan-light` receives the same input and grows `workflow.mjs` through
   designed, reviewed, and individually checked source slices. It is slower
   and meant for lighter author models that need every step gated.

Missing, empty, or whitespace-only input to either plan workflow fails before
the first child starts and writes no generated source.

## Assign files before starting

The existing semantic input carries the complete task plus unambiguous exact file destinations, preferably absolute. File placement does not change cwd or worktree selection. Predeclare draft.md, workflow.mjs, workflow.design.md, workflow-review.md and workflow-decision-log.md separately from the requested product. For plan-light, also assign every queue, seed, slice, mechanical-check and correction/review record named by its prompts. Every basename in a stage means its assigned path; it never means a runtime workspace-relative file.

`task/draft` writes the editable assigned draft through ordinary file tools and verifies that actual file before returning the whole draft. Pass the same destination instructions plus the complete accepted draft to the plan stage, or name its exact draft file for agents to read. Do not replace missing requirements from another conversation. The native source checker stays project-confined, so place generated source inside that boundary or report an explicit unsupported check.

## task/plan

The author plans stages, not product steps: each generated agent prompt states
its role, expected result, inputs, and essential constraints, and the running
agent decides how to do the work. The author follows the installed
`locus-pi-workflow-create` skill for the DSL and source shape, keeps the draft's
scope, primary output, and literal bounds, takes paths from the draft or
workflow input exactly, and runs `node --check` and orchestration-only
`workflow_check_source` after every edit.

The review loop runs at most three reviews and two revisions:

```text
workflow-author -> [ workflow-review -> workflow-review-route (accept | revise) -> workflow-revise ] x3
```

Each review is independent: it reruns both checks, judges whether the graph
delivers the draft's primary output, and may ask to re-plan part of the graph.
It reports only findings that require a change. `accept` returns the whole final review report; the source stays at its assigned destination. The third `revise` returns
`{ ok: false, status: "failed", reason: "review_exhausted" }` with the last
review as diagnostics and publishes nothing. Every non-route call reads and
appends to the assigned `workflow-decision-log.md`, so a revision does not
repeat a rejected approach; the log is history, not instruction.

## task/plan-light

Design and design review use the accepted draft before any source file exists.
The seed stage creates `workflow.mjs` directly at the assigned exact path. From
that point onward, the assigned file is the source authority. A missing file at
the seed check enters the one seed correction, which creates it; a missing file
at the recheck or any later gate fails closed.

The seed and every accepted source slice leave the same assigned
`workflow.mjs` as a complete runnable module that parses and passes the
orchestration-only checker. The seed preserves the primary output identity and
product scope; reviewed graph nodes may still be missing. Its independent check
records those gaps as remaining source work and fails on mechanical errors,
changed output or scope, or a graph contradiction. Only the final whole-file
review requires the complete graph. Agents edit that file and return reports or
source-free requirement briefs; source bytes never travel through a model answer.

The seed uses the standard `meta`/default DSL export shape. The seed stage
creates the file even when the design or decision log records an open conflict.
A failed seed check gets one correction and one independent recheck; the
correction creates a missing file from the reviewed design or repairs the
existing one. An unrepaired defect returns the last check report and publishes
nothing. A temporary route may leave graph work for later
source slices, but cannot claim final success before that graph exists. The
starter route includes an agent explicitly aimed at the reviewed primary output;
metadata or an incomplete diagnostic that merely names the output is not a
runnable route. Semantic input passes whole into an agent prompt. A blank input
default belongs at the `runWorkflow` parameter boundary; `input || "fallback"`
inside the body transforms opaque input and fails the source checker.

Every source editor runs local `node --check` and orchestration-only source
checks after writing, with at most two edit-check passes inside its call. It
reports unresolved diagnostics instead of claiming success. Independent check
agents repeat those checks; the editor's preflight never grants acceptance.
The standard DSL uses singular `choice: [...]` on `agent()` for a branch result
and `publishArtifact()` for an in-memory diagnostic. `choices` and
`publishText()` are unsupported. An opaque agent answer can be forwarded whole
to a later agent prompt or published exactly; source code does not branch on it
or construct diagnostic text from it. The broader standard checker permits
composed text in `publishArtifact()`; this narrower diagnostic rule belongs to
the `task/plan-light` editor contract and its design review.

For any graph, the editor guidance uses the checker's supported shape: a
literal-bounded `for` loop owns each repeated unit, correction path or branch
join without a second mutable counter, a `choice` agent produces each branch
identity, and a whole agent answer can be carried into the next iteration from
a `let` binding declared in the same block immediately before that loop. A fixed
graph may contain such a loop; its design states bounds, never the absence of a
loop. An agent node reached from several branches has one call site and one
literal label; branch-specific opaque reports are assigned whole to a carry
inside the loop and passed to that call after it. Conformance checks stages,
routes, handoffs and that every loop is finite, not exact call counts. A bound or
call count that differs from the draft is a recorded design decision. Only an
unbounded loop, a missing primary output or a scope change is an open design
conflict, and the seed is still created; slice and final reviews still reject
wrong routes and missing handoffs as defects.
Keep the initial agent report in an immutable binding. Declare the evolving
carry as `let lastOutcome = ""` before the bounded loop and assign whole agent
answers to it only inside that loop. Later prompts can use the initial report
and latest carry separately. Initializing the mutable binding from an opaque
report or assigning that report before the loop fails the source checker with
`WF_DATA_FLOW` and `WF_EXPRESSION`.
An exact `choice` call returns only its route token. Name each token after
the action its branch takes, never with a word that also reads as a verdict for
another branch: rework is `fix` or `revise`, never `correct`. A separate agent call
produces the full slice brief or findings report; later owner decisions,
correction, and accepted-state updates receive the latest whole state and
queue, using the initial handoff only as the baseline.
Opaque answers appear only in later agent prompts or exact terminal results.
This keeps the turn cap and routes in source control flow; describing them in
an agent prompt does not implement them. Manually maintained turn counters,
concatenated semantic state, and computed returns built from opaque answers fail
the source checker. `while` loops and loops without a literal bound break the
`task/plan-light` editor contract and design review; the checker itself rejects only a
carry outside a literal-bounded `for` and an opaque value in a loop condition.

An owner re-cuts the remaining graph-node queue after each accepted slice. It
first copies an existing assigned `workflow-source-queue.md` whole to
`workflow-source-queue-prior.md`, then writes the complete remaining queue in
execution order to `workflow-source-queue.md`. Its answer is only a report
naming that file, its item count and each identity. An independent
queue assessment preserves unmet identities and fails with `queue_conflict` when
the transition cannot be reconciled after one source-free queue pass and
independent recheck. A clean proposal keeps its identities in that pass; a
conflicting proposal is corrected once by rewriting the queue file whole. The
first pass has no prior queue file and no prior identities. Queue
items describe missing or defective nodes and branches in `workflow.mjs`, not
the product implementation slices that the generated workflow will later run.
The named caller-assigned queue file is authoritative; the owner's report is not.
Each numbered item in that file must be a concrete source-free requirements
brief. A report describing a queue, or one narrative item summarizing several
unseen items, cannot stand in for the numbered items. Independent assessment and
recheck read that exact file and examine each numbered item before any slice
edits `workflow.mjs`. The workflow script never reads the queue file: it routes
on those checks' exact choices, and each slice implements the file's first
item.
One queue item is one bounded source edit. It may include adjacent graph nodes
and their connecting branches when they form a coherent runnable route; the
item names every covered identity. This lets a graph with more than six nodes
fit the existing six-slice allowance without dropping requirements. If safe
grouping cannot fit, the queue keeps all unmet identities visible and fails
closed.
An intermediate edit may leave an edge to a later queued node as a named,
fail-closed incomplete route. The current queue names its exact future
destination and required replacement; later queues retain that edge until the
destination slice connects it. The slice review accepts this bounded pending
work, while final review rejects every remaining placeholder.
Each branch item names its exact choices, their destinations, and terminal
behavior from the reviewed design. The first independent assessment treats a
missing destination as a conflict. Only a conflicting first route pays for one
reconciliation, which can add that detail under the same identity and order,
and an independent recheck that still rejects an ambiguous branch; a clean
first route keeps the proposed queue as is.
The current source is expected to lack queued work. A queue item that names its
wrong or missing route and specifies the reviewed replacement remains work to
implement; the old route still present in the file is not itself a queue
conflict. A proposed edge contrary to the reviewed design, a dropped unmet
identity, or a false completion claim is a conflict.

Mechanical checks and design review are separate. Any failed mechanical check
always enters its one-fix path. A later distinct design defect has one design
fix, even if the mechanical fix was used. If its independent design recheck
finds a precise correctable residual in the same slice, one final targeted
design fix is allowed. Each fix receives independent mechanical and design
checks. A failed second check stops without publication. Six slices
may be accepted; a seventh pass can prove completion or return the unconsumed
queue, but cannot implement more work. Named terminal reasons are `seed_failed`,
`slice_allowance`, `slice_repair_failed`, `queue_conflict`, `empty_queue`,
`final_check_failed`, and `design_mismatch`. Every failed result keeps
`workflow.mjs` plus diagnostic evidence at its caller-assigned path and publishes no primary
file.

Every stage except the route translators reads and appends to
`workflow-decision-log.md` at its caller-assigned path. Each entry records one stage's
decision, reason, evidence and any open conflict, so a later fixer or reviewer
knows what was already tried and why, and must name an entry it reverses. The
log is history, not instruction: the accepted draft, reviewed design and stage
prompt stay the only requirements, an entry never accepts or waives a check, and
imperatives inside entries are ignored. The design stage marks a new run when an
earlier log exists. The log stays at its caller-assigned path after a failed result.

An intermediate design review accepts a correct slice when earlier accepted work
remains intact and the whole module stays runnable. Requirements still queued for
later slices do not consume that slice's fix allowance. The final design review
checks complete conformance before publication.

An empty queue is not completion. Final whole-file mechanical and design gates reopen the exact caller-assigned regular nonempty source. Checkers record its absolute path, SHA-256 of persisted checked bytes and actual Node/source-tool outcomes; reviewers read those same bytes without silently editing them. Both design stages write the assigned workflow.design.md. Seed, queue, slice, correction and check stages write their assigned source-free records. No package stage executes generated source and no DSL file publication is required.

The whole accepted input reaches every relevant agent, including helper routers. Agents interpret file assignments and task restrictions with ordinary tools; JavaScript forwards the input and opaque answers whole and branches only on exact choices. Missing or ambiguous destinations, missing source, failed checks, design mismatch and exhausted correction preserve work as non-success without fallback files or answer reconstruction.

## Handoff and replay

Replay reuses model answers but does not repeat file edits. Repair + Continue is
therefore valid only while the originally assigned prerequisite files remain intact. Every fresh suffix gate re-reads the actual file; a missing or drifted
assigned file must fail its checks rather than be treated as preserved work. Before execution the caller compares current bytes with persisted reviewed/check evidence and repeats required checks, including after replay.

No task stage executes generated source. Create-only ends with the
checked source and launch command. For an authorized create-and-run request, the
caller reviews the retained file and hands it to `locus-pi-workflow-run` through
the existing file-target path, without repeat approval. Report authoring,
execution and product verification separately. The exact assigned source path from the original whole input is the handoff. Native completion never attests file delivery. Reopen it, require successful review and regular nonempty bytes, compare persisted checked/reviewed SHA-256 evidence and rerun current required checks before execution, including after correction/replay. Failed or exhausted review forbids execution even if a source remains. Never reconstruct source from prose.

```text
/workflows run task/draft -- <raw request>
/workflows run task/plan -- <complete accepted draft>
/workflows run task/plan-light -- <complete accepted draft>
```

All three task scripts are orchestration-only. Child agents may inspect the live
project when their prompt requires it. The JavaScript does not read project or
artifact files. Agent tools write assigned files. Actual checker/reviewer/launcher consumers own readback and failure checks.

## Default authoring style

Prefer a fixed graph for one bounded deliverable with known requirements, even
when implementation is substantive. Include independent review, a bounded review
loop when review can demand correction, and final verification. Use adaptive
slices when accepted output or findings must change the remaining work; bound
the queue and retain owner decisions. Briefs state the role, expected result,
sources and essential constraints. See the [workflow guide](../../../docs/workflows/create.md)
for folder-level inputs, style/size choices and design-to-implementation handoff.
