---
updated: "2026-10-02T22:53:29Z"
source_commit: "0d098c9e06d1"
update_event: "user_request"
context: "changes=L files=29"
description: "Teach ordinary and detailed workflow authoring with shared Pi contracts"
---

# Design, review, Build

Audience: the author after a graph pattern has been selected. This file owns the authoring process and design record, not the DSL grammar or runtime defaults.

## Authoring is continuous by default

A plain request to create, design, write, or author a workflow runs one visible
sequence in the same turn:

1. Create `.locus-pi/workflows/<name>/` and write
   `.locus-pi/workflows/<name>/<name>.design.md` before any source.
2. Review the design against the request, selected pattern, graph contract, and
   standard source profile. Revise the design until the review finds no material
   mismatch.
3. Build exactly the direct `.workflow.mjs` entries declared by the reviewed
   design. A `runnable root` design includes
   `.locus-pi/workflows/<name>/<name>.workflow.mjs`; a `group-only` design omits it
   and builds only its direct children. Never invent a root.
4. Validate source identity, Node syntax without import, and orchestration-only
   source shape with the packaged tools. Read the design against the built source:
   walk its node and edge list and confirm each one appears. No tool checks that
   correspondence; do not write a home-made checker for it.
5. For create-only, return checked source and the launch command without execution.
   For an authorized create-and-run request, hand the checked target to the run
   skill and continue to terminal evidence. The same request can authorize both;
   do not invent another approval, or bypass the host's trust requirements.

The design remains the readable source of truth and must exist before JavaScript;
continuous authoring removes only the mandatory human pause between them. Stop
after the design only when the user explicitly asks for `design only`, `pause
after design`, `do not build`, or equivalent wording. A user may also request the
build-only compatibility route with `Build approved design: <exact design path>`
or `Build design: <exact design path>`.

If design review or Build discovers a material algorithm mismatch, update and
re-review the design before
building; never hide the change in source. Ask the user only when resolving the
mismatch would change the requested result, not for routine authoring choices.

## Design contract

The design is short Markdown a reader can approve without opening JavaScript:

```markdown
# Design: <name>

Purpose: <one sentence>
Input: <semantic text or none>
Primary deliverable: <requested artifact and location>; accompanying report: <if needed>
Authoring route: <ordinary or explicitly selected detailed lesson; not a runtime field>
Evidence boundary: <semantic input, caller items, author-known prompt material, or child inspection>
Approach: <task need and semantic approach(s); omit any unnecessary roles>
Graph: <fixed for known scope/stages; replan when observed results must change remaining work>
Brief detail: <outcome-led by default, or procedural with reason>
Context: <repository checkout, task directory, output location; agents discover files>
Executors: <responsibility roles and verified model routes; no unverified engine names>
Verification: <required evidence, available or discoverable child capabilities, optional checks and delivery effects>

Namespace: `runnable root` (include the `<name>` entry below) or `group-only`
(omit the root entry; children remain directly runnable)

## Entries

| Ref              | Entry kind    | Responsibility         | Invoked by |
| ---------------- | ------------- | ---------------------- | ---------- |
| `<name>`         | runnable root | <standard entry point> | operator   |
| `<name>/<child>` | direct child  | <one bounded subtask>  | `<node>`   |

For `group-only`, omit the `<name>` row entirely. Declare every direct child
that Build must create; do not declare grandchildren or an implicit root.

1. <numbered algorithm>

| Node     | Responsibility         | Receives      | Returns                                | Next       |
| -------- | ---------------------- | ------------- | -------------------------------------- | ---------- |
| `<node>` | <one coherent subtask> | <exact input> | <complete text, choice, or named file> | <consumer> |

Concurrency: <groups or none>
Loop bounds: <bounds or none>
Budgets: <axis=value with a one-line reason, or none — launch defaults apply; every other undeclared workflow budget axis is unbounded>
Named files: <each workspace file, its writer and its readers, or none>
File boundary: workflow source performs no file reads; name any child-owned source inspection
Worst-case calls: <exact formula including saved children>
Failure exits: <fail-closed exits>
Mechanisms: <parallel barriers, choices, loops, human gates; no agent-count penalty>
Status: REVIEWED — ready for build.
```

Count orchestration machinery, not agents. More agents are fine when the task
really decomposes into more coherent subtasks.

Review whether each brief gives the agent enough to complete its task. Remove
mechanical headings, repeated completion criteria, tool choreography and
general policy that add no task-specific information.
For a review edge, let the reviewer inspect the full current diff with its own tools.
Commit only within existing task authorization; require it to account for every
in-scope path in that diff before a favorable verdict. Do not have the producer
rebuild the change as an evidence bundle for the reviewer to read.
For each choice, named file or author-selected limit, identify the consuming edge
and why it needs that contract. Plain narrative is passed whole without an
invented length cap; a choice belongs only at a real routing edge. Two review
checks apply to every design:

- **No invented size policy.** Every budget axis carries a one-line reason. A
  number with no owner is removed, not lowered.
- **No prompt-side size request.** No brief asks for a character, word, line or
  item count the consumer did not declare. "Keep it short" is the removed policy
  rewritten in English.

Use the already selected pattern card as an algorithm, not a full workflow to copy blindly.

For each acceptance edge, trace blocking criteria to the request or an authoritative
contract and identify how a child can establish them. A product requirement does not
by itself require one particular verification method. Do not assume the author's
tools are available to children; assign any needed capability discovery to an existing
worker or reviewer. Separate observed defects, unmet required evidence and optional
checks not performed. Check that correction can address the finding: an unavailable
optional verifier is a coverage limitation, not implementation work.

Walk terminal paths for a produced artifact with an optional check unavailable, a
confirmed defect and an explicitly required verifier unavailable. Delivery reports the
artifact's location, actual checks, known issues and unverified behavior. Non-success
preserves any produced artifact with the unmet requirement; it does not claim acceptance.
The author owns this design review. Operator changes to a generated workflow are not
evidence that the authoring skill produced a correct design.

## Build checks

Build writes one canonical folder matching the reviewed design: an optional
`.locus-pi/workflows/<name>/<name>.workflow.mjs` only when the namespace is declared
`runnable root`, plus only its declared direct child entries. A `group-only`
namespace has no root source and never receives a fake one. It then checks:

- the design `Entries` table and source set match exactly;
- when present, root `meta.name` equals `<name>`; each child `meta.name` equals
  `<name>/<child>` and its filename is `<child>.workflow.mjs`;
- `meta.profile` is `"standard"`;
- source identity policy passes;
- `node --check <exact-path>` passes; static inspection confirms `meta` and a default function;
- no unchecked module is imported or executed as a smoke test;
- source exposes the reviewed nodes, edges, handoffs, bounds, and failure exits,
  confirmed by reading the design's node and edge list against the source;
- refusal branches return an explicit failure object, not failure-looking prose;
- correction receives actionable review findings, not merely a routing choice;
- the primary output contains its declared data; a report is not renamed as a
  product file such as JSON, HTML, or source code;
- no design-absent node or standard-profile bad smell appeared.
- the exact built file passes the Pi-native `workflow_check_source` tool with
  `mode: "orchestration-only"` for every built
  `.locus-pi/workflows/<name>/*.workflow.mjs` path; from a `locus-pi` checkout the
  same validator is `npm run check:workflow-source -- --mode orchestration-only <exact-path>`.
- every built source uses only the orchestration-only DSL subset and contains no
  file, path, artifact-consumption, clock, or randomness primitive.
- no source carries `handoffs`, `schema`, `validate`, `output`, `repair`,
  `returnVia`, `maxItemChars`, `maxAnswerChars` or `schemaMaxLength` (the runtime
  refuses each by name before any child starts), and no size or budget number the
  design did not justify.

Read checker diagnostics as `path:line:column [CODE] message`. Any error fails
Build. Warning-only output remains a successful check, but Build must report the
warning and repair declaration drift when it concerns generated source.

An unavailable required source gate, failed checker result, syntax error, or
design/source mismatch means Build failed. Preserve source and diagnostics before
correction. Choose and record a semantic correction bound in the design; a prompt
alone is not a runtime-enforced retry count. Use explicit `choice` routing when the
authored graph needs correction. Exhausted correction with unresolved defects or
unmet required evidence returns `{ ok: false, status: "failed" }` with the latest
artifact and evidence; do not publish it as accepted or silently start a fresh run.
An optional check not performed does not, by itself, make a completed implementation fail.

The packaged `task/plan` writes the whole workspace `workflow.mjs` in one author
call, then runs at most three independent reviews with at most two revisions.
The packaged `task/plan-light`, for lighter author models, creates a minimal
runnable workspace `workflow.mjs`, then grows it through at most six complete
graph-node slices. An owner re-cuts the source-free remaining queue after each
accepted slice. Independent mechanical and design gates share one cumulative
correction per slice; final whole-file gates run after the queue is empty. The exact routes and terminal reasons live in the
[task authoring manual](../../../examples/workflows/task/README.md).

`publishPrimaryFile("workflow.mjs")` returns `primaryFile` with the validated
workspace-relative path, absolute path, byte count, and digest. It does not copy the
file into run `outputs/`. The validated `primaryFile.absolutePath` remains the
read-and-launch handoff; verifier prose is not source. Host publication validation
is not semantic review or live proof.

A successful Build returns `/workflows run <name>` (or the qualified child ref).
Create-only stops there. Create-and-run continues through
[locus-pi-workflow-run](../../locus-pi-workflow-run/SKILL.md) with existing scoped
authorization and evaluates the actual terminal artifact. Keep specification
approval and external-effect boundaries intact.

## Pattern-specific design decisions

For adaptive slices, name the queue owner, cumulative slice allowance, correction/recheck edge, scope-change exit and required final QA. Re-cut after each accepted slice, including the apparent last one, so an empty queue cannot hide unmet requirements. For fixed graphs, do not add a judge or semantic retry that the request did not require. For refinement, record the completion authority, immutable criteria, measured evidence, literal round cap, no-progress rule, exact handoff and terminal outcomes. For decomposition, record local concurrency, global budget and key ownership. Human continuation names two runs and a verified artifact handoff, never a suspended JavaScript stack.

Budget values and failure dispositions belong to the [runtime reference](../../../docs/workflows/index.md); source provenance, mutation and permitted DSL methods belong to [source contract](../../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape). Read the relevant sections before Build. Do not duplicate those invariants in another skill.

A standard source check is not live proof. Report the exact checks executed and any unavailable native checker, dependency, host or model route. Do not report successful Build after a skipped gate.
