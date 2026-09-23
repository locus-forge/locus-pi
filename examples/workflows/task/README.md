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
publishes nothing. A temporary route may leave adaptive graph work for later
source slices, but cannot claim final success before that graph exists.

An owner re-cuts the remaining graph-node queue after each accepted slice. An independent
queue assessment preserves unmet identities and fails with `queue_conflict` when
the transition cannot be reconciled after one source-free queue pass and
independent recheck. A clean proposal keeps its identities in that pass; a
conflicting proposal is corrected once. The first pass has no prior identities. Queue
items describe missing or defective nodes and branches in `workflow.mjs`, not
the product implementation slices that the generated workflow will later run.

Mechanical checks and design review are separate. Any failed mechanical check
always enters its one-fix path. A later distinct design defect has one design
fix, even if the mechanical fix was used; both corrections receive independent
checks. A repeated failure stops without publication. Six slices
may be accepted; a seventh pass can prove completion or return the unconsumed
queue, but cannot implement more work. Named terminal reasons are `seed_failed`,
`slice_allowance`, `slice_repair_failed`, `queue_conflict`, `empty_queue`,
`final_check_failed`, and `design_mismatch`. Every failed result keeps
`workflow.mjs` plus diagnostic evidence in the workspace and publishes no primary
file.

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

Substantive implementation briefs default to adaptive slices: the owner revises
remaining work after each reviewed slice. Briefs state the role, expected result,
sources and essential constraints. Fixed graphs and procedural detail remain
explicit alternatives. See the [workflow guide](../../../docs/workflows/create.md)
for folder-level inputs, style/size choices and design-to-implementation handoff.
