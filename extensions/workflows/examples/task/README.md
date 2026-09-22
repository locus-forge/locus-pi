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

The seed and every accepted source slice leave the shared workspace
`workflow.mjs` complete, runnable, Node-parseable, and valid under the
orchestration-only checker. Agents edit that file and return reports or source-free
requirement briefs; source bytes never travel through a model answer. An owner
re-cuts the remaining graph-node queue after each accepted slice. An independent
queue assessment preserves unmet identities and fails with `queue_conflict` when
the transition cannot be reconciled.

Mechanical checks and design review are separate. Any failed mechanical check
always enters the fix path. Each slice has one cumulative fix,
followed by an independent mechanical and, when needed, design recheck. Six slices
may be accepted; a seventh pass can prove completion or return the unconsumed
queue, but cannot implement more work. Named terminal reasons are `seed_failed`,
`slice_allowance`, `slice_repair_failed`, `queue_conflict`, `empty_queue`,
`final_check_failed`, and `design_mismatch`. Every failed result keeps
`workflow.mjs` plus diagnostic evidence in the workspace and publishes no primary
file.

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
explicit alternatives. See the [workflow guide](../../../../docs/locus-pi-workflows.md#create-a-workflow)
for folder-level inputs, style/size choices and design-to-implementation handoff.
