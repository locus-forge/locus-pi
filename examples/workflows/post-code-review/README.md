# Post-code review workflow tree

`post-code-review` is one installable code-review workflow composed from seven
saved child workflows. The parent makes no model call itself: it owns order,
parallelism, child identity and the complete whole-input file assignments. Agents own report writes.

> **External entry point:**
> [`post-code-review.workflow.mjs`](post-code-review.workflow.mjs). The other
> seven workflow files are source-bound child components coordinated by this
> parent.

The review uses several complementary perspectives rather than one repeated
style:

1. `post-code-review/scope` resolves the requested function, file, commit,
   commit range, diff, or locally available PR range into an exact evidence
   boundary. Historical targets keep base, target, and current-descendant
   evidence distinct, so later policy cannot be attributed to an older commit.
2. `post-code-review/boundaries`, `post-code-review/simplicity`,
   `post-code-review/contracts`, and `post-code-review/style` run behind one
   parallel barrier. Each reopens `review-scope.md`, inspects live evidence
   independently, and writes only its own report. The style lane also reads the
   optional caller-owned criteria file. The simplicity lane uses delete-first
   caller evidence and records a before/after contraction target.
3. `post-code-review/necessity` runs sequentially after the barrier, reopens the
   scope and all four lane reports, and challenges every proposed fix for a
   proven behavioral or code-shape defect, a clear guarantee owner, duplicated
   responsibility, and net simplicity. It splits immediate cleanup from future
   product work, preserves each lane's stable question id, and writes
   `review-necessity.md`. Historical targets are judged against their frozen
   tree rather than descendant policy.
4. `post-code-review/synthesis` reopens all six reports, independently verifies
   admitted findings and decision-critical positive/`NO_ACTION` claims against
   the frozen target and current live source, removes unsupported or duplicate
   claims, assigns the final code-shape action levels, and writes
   `post-code-review.md`. A proven defect introduced or materially worsened by
   the reviewed change remains REQUIRED even when its impact is low.
5. The parent returns synthesis completion. Consumers reopen the final report at its exact assigned path; native completion does not attest a file.

The diagram below shows these workflow boundaries, exact source filenames,
model roles, Markdown handoffs, and the failure boundary on one canvas.

![Post-code review workflow graph](post-code-review-pipeline.svg)

## Install

The tree ships with the locus-pi package. Follow [Getting started](../../../docs/getting-started.md)
to install the published package or register a source checkout. Register it once;
do not copy workflow files into every project.

After installation, start Pi in the project to review and confirm the Package
entries:

```text
/workflows list post-code-review
```

Run the parent with the target and exact report destinations in one whole input:

```text
/workflows run post-code-review -- Review the current diff. Reports: review-scope.md: /project/reports/review-scope.md; review-boundaries.md: /project/reports/review-boundaries.md; review-simplicity.md: /project/reports/review-simplicity.md; review-contracts.md: /project/reports/review-contracts.md; review-style.md: /project/reports/review-style.md; review-necessity.md: /project/reports/review-necessity.md; post-code-review.md: /project/reports/post-code-review.md
```

Replace `/project/reports/` with your intended absolute report directory before launch; keep all seven distinct file assignments in the input.

Before launch, assign the portable `smol` role through `/model-roles`. Every
review child declares `requireModelRole: true`; `smol:high` and `smol:xhigh`
use that assignment with different reasoning effort. An unassigned role stops
each fresh review child before it runs instead of silently inheriting the parent
session model. A resumed call may reuse that original child's recorded answer;
replay starts no child and remains marked as not-fresh evidence.

Assign each report its own unambiguous exact path, preferably absolute, and pass those same instructions to all children. Parallel lanes write distinct reports and later stages reopen them after the barrier. Missing assignments or missing/unreadable/stale prerequisites are BLOCKED; no runtime folder discovery or reconstruction from returned text is permitted. Operators serialize roots sharing fixed paths because runtime leases protect only native state.

Optionally name an exact read-only criteria-file path in that same input, separately from the scope and style report. Runtime never creates or discovers style.md. Omitted criteria or an empty regular file means no additional criteria; live project conventions still apply. Nonempty bytes stay unchanged and cannot expand scope. A named missing, unreadable, nonregular or leaf-symlink file produces explicit non-success naming that path, with no fallback, substitute or link-target write.

The same entry is available through the programmatic `workflow` tool and headless command. Resume reuses eligible native calls/checkpoints but does not restore file writes; consumers must recheck their actual assigned files.

## Decision and remediation contract

The final report answers whether the reviewed code passes this code-shape gate.
It is not the final QA or merge verdict:

- `READY` — this gate passes and no source change is warranted;
- `READY_WITH_RECOMMENDATIONS` — this gate passes and only evidence-backed
  optional work outside the current change's acceptance contract remains;
- `CHANGES_REQUIRED` — at least one proven current behavioral, contract,
  documentation, ownership, style-contract, or code-shape defect must be fixed
  and re-reviewed;
- `BLOCKED` — live evidence is insufficient for a trustworthy decision.

Each item independently carries `Action: REQUIRED`, `RECOMMENDED`, or
`NO_ACTION`, plus `Impact: high`, `medium`, or `low`. This keeps mandatory work
separate from impact. A current-PR dead surface, fake parameter, duplicated
invariant owner, stale derived document, misleading behavior description,
unearned seam, or open delete/rewrite/owner move is REQUIRED when proven.
Personal taste, rejected proposals, future product choices, and accepted
responsibility boundaries remain visible as `NO_ACTION` or optional work rather
than disappearing.

For a REQUIRED or RECOMMENDED item, synthesis may include one small illustrative
fix snippet when it can do so truthfully. The snippet explains intended shape;
it is not a literal patch and never replaces ownership evidence, a complete
action, or verification. `NO_ACTION` items receive no fix snippet.

To apply fixes, give an implementation agent the exact review report and ask it
to address the REQUIRED findings. Include RECOMMENDED findings only when you
explicitly want that optional work. The report remains the handoff; this review
workflow does not start implementation.

After remediation changes the reviewed head, run a fresh post-code review. The
old decision does not prove the new head.

## Source binding

All eight files are Package workflow entries because the Package registry scans
one directory level below `examples/workflows/`. The parent is the
intended external entry. Its seven `invokeWorkflow({ child })` edges bind
children to these installed Package files. A project or personal workflow with
the same name therefore cannot silently replace one child; a shadow causes the
run to fail before the child executes.

The children remain individually inspectable through `/workflows info`. Running
a lane directly is normally not useful because the boundaries, simplicity,
contracts, and synthesis lanes expect the parent's shared `review-scope.md`
handoff.

## Files in this directory

- `post-code-review.workflow.mjs` — external parent and dependency coordinator.
- `scope.workflow.mjs` — exact scope and Git-semantics mapper.
- `boundaries.workflow.mjs` — ownership and architecture lane.
- `simplicity.workflow.mjs` — delete-first complexity lane.
- `contracts.workflow.mjs` — API, consumer, documentation, and
  validation-contract lane.
- `style.workflow.mjs` — comment quality and evidence-backed
  project-style lane with optional request-local criteria.
- `necessity.workflow.mjs` — sequential challenge to proposed
  fixes, their ownership, duplicated responsibility, and net complexity.
- `synthesis.workflow.mjs` — independent verifier and final
  report author.
- `post-code-review-pipeline.svg` — self-contained reader-facing interaction
  diagram.

The task-local `verify-post-code-review-bundle.mjs` and
`verify-post-code-review-scope-matrix.mjs` files are development checks, not
workflow entries and not installation artifacts. They validate the shipped
source graph and Git targeting rules during repository verification; operators
never run them to perform a code review.
