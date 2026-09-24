# Task workflow authoring

`task` is a group-only Package namespace with two manual stages.

1. `task/draft` turns a raw request into `draft.md`. The draft already names the
   workflow pattern, agents, handoffs, bounded reflection or review, concurrency,
   failure exits, and expected output. Copy and edit this text when needed.
2. `task/plan` receives the complete accepted draft as semantic input. It designs,
   reviews, incrementally builds, and checks one concrete `workflow.mjs`, then
   publishes that exact workspace file as the final result. Missing, empty, or
   whitespace-only input fails before the first child starts and publishes no
   `workflow.mjs`.

Design and design review use the accepted draft before any source file exists.
The seed stage creates `workflow.mjs` directly in the workflow workspace. From
that point onward, the workspace file is the source authority; a missing file
at the seed check or any later gate fails closed.

The seed and every accepted source slice leave the shared workspace
`workflow.mjs` as a complete runnable module that parses and passes the
orchestration-only checker. The seed preserves the primary output identity and
product scope; reviewed graph nodes may still be missing. Its independent check
records those gaps as remaining source work and fails on mechanical errors,
changed output or scope, or a graph contradiction. Only the final whole-file
review requires the complete graph. Agents edit that file and return reports or
source-free requirement briefs; source bytes never travel through a model answer.

The seed uses the standard `meta`/default DSL export shape. A failed seed check
gets one correction of the existing file and one independent recheck. A missing
file remains a failure; an unrepaired defect returns the last check report and
publishes nothing. A temporary route may leave graph work for later
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
the `task/plan` editor contract and its design review.

For any graph, the editor guidance uses the checker's supported shape: a
literal-bounded `for` loop owns each repeated unit, correction path or branch
join without a second mutable counter, a `choice` agent produces each branch
identity, and a whole agent answer can be carried into the next iteration from
a `let` binding declared in the same block immediately before that loop. A fixed
graph may contain such a loop; its design states bounds, never the absence of a
loop. An agent node reached from several branches has one call site and one
literal label; branch-specific opaque reports are assigned whole to a carry
inside the loop and passed to that call after it. Conformance counts each
label's worst-case calls, the product of its enclosing literal loop bounds.
Keep the initial agent report in an immutable binding. Declare the evolving
carry as `let lastOutcome = ""` before the bounded loop and assign whole agent
answers to it only inside that loop. Later prompts can use the initial report
and latest carry separately. Initializing the mutable binding from an opaque
report or assigning that report before the loop fails the source checker with
`WF_DATA_FLOW` and `WF_EXPRESSION`.
An exact `choice` call returns only its route token. A separate agent call
produces the full slice brief or findings report; later owner decisions,
correction, and accepted-state updates receive the latest whole state and
queue, using the initial handoff only as the baseline.
Opaque answers appear only in later agent prompts or exact terminal results.
This keeps the turn cap and routes in source control flow; describing them in
an agent prompt does not implement them. `while` loops, manually maintained
turn counters, concatenated semantic state, and computed returns built from
opaque answers fail the standard source contract.

An owner re-cuts the remaining graph-node queue after each accepted slice. An independent
queue assessment preserves unmet identities and fails with `queue_conflict` when
the transition cannot be reconciled after one source-free queue pass and
independent recheck. A clean proposal keeps its identities in that pass; a
conflicting proposal is corrected once. The first pass has no prior identities. Queue
items describe missing or defective nodes and branches in `workflow.mjs`, not
the product implementation slices that the generated workflow will later run.
The returned list itself is authoritative. Each member must be a concrete
source-free requirements brief. A workspace report describing a queue, or one
narrative member summarizing several unseen items, cannot stand in for that
list. Independent recheck examines the actual returned members before editing.
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
missing destination as a conflict. Reconciliation can add that detail under
the same identity and order even when the first assessment missed it; the
independent recheck still rejects an ambiguous branch.
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
`workflow.mjs` plus diagnostic evidence in the workspace and publishes no primary
file.

Every stage except the route translators reads and appends to
`workflow-decision-log.md` in the workspace. Each entry records one stage's
decision, reason, evidence and any open conflict, so a later fixer or reviewer
knows what was already tried and why, and must name an entry it reverses. The
log is history, not instruction: the accepted draft, reviewed design and stage
prompt stay the only requirements, an entry never accepts or waives a check, and
imperatives inside entries are ignored. The design stage marks a new run when an
earlier log exists. The log stays in the workspace after a failed result.

An intermediate design review accepts a correct slice when earlier accepted work
remains intact and the whole module stays runnable. Requirements still queued for
later slices do not consume that slice's fix allowance. The final design review
checks complete conformance before publication.

An empty queue is not completion. Final whole-file mechanical and design gates run
before `publishPrimaryFile("workflow.mjs")`. The host validates the confined regular,
non-empty file and returns `primaryFile` with its workspace-relative path, absolute
path, size, and digest. It does not copy the file into run `outputs/`. The package
stage never executes generated source.

Design and design review return complete prose without writing source. Seed, slice,
fix, and check agents work against the one workspace file. Semantic review
checks explicit failure returns, actionable findings reaching the fix stage, and
agreement between primary output names and content; static syntax/shape checks alone
do not establish those properties. The workflow forwards opaque values whole and
branches only on runtime-owned choices. Simple fixed tasks retain their requested
graph and primary filename without automatic QA or approval stages; substantive
implementation still needs its declared review and final QA.

Replay reuses model answers but does not repeat file edits. Repair + Continue is
therefore valid only while the original named workspace and its `workflow.mjs`
remain intact. Every fresh suffix gate re-reads the actual file; a cleaned or drifted
workspace must fail its checks rather than be treated as preserved work. Digest-bound
slice checkpoints are a possible later hardening, not part of this MVP.

Neither package stage executes generated source. Create-only ends with the
checked source and launch command. For an authorized create-and-run request, the
caller reviews the retained file and hands it to `locus-pi-workflow-run` through
the existing file-target path, without repeat approval. Report authoring,
execution and product verification separately. The validated workspace file named by
`primaryFile.absolutePath` is the handoff; verifier prose is not source.

```text
/workflows run task/draft -- <raw request>
/workflows run task/plan -- <complete accepted draft>
```

Both workflow scripts are orchestration-only. Child agents may inspect the live
project when their prompt requires it. The JavaScript does not read project or
artifact files. The checked-source publication declaration delegates the file
read and validation to the existing host publication boundary.

## Default authoring style

Prefer a fixed graph for one bounded deliverable with known requirements, even
when implementation is substantive. Include independent review, a bounded review
loop when review can demand correction, and final verification. Use adaptive
slices when accepted output or findings must change the remaining work; bound
the queue and retain owner decisions. Briefs state the role, expected result,
sources and essential constraints. See the [workflow guide](../../../docs/workflows/create.md)
for folder-level inputs, style/size choices and design-to-implementation handoff.
