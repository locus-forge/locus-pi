---
updated: "2026-10-07T15:24:00Z"
source_commit: "f6f04156193e"
update_event: "user_request"
context: "compact design, conditional references and optional SVG"
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
re-review the design before building; never hide the change in source. Ask the user only when resolving the
mismatch would change the requested result, not for routine authoring choices.

## Design contract

Keep one short record of the decisions needed to build and review the graph.
Reference the unchanged Task; do not copy its requirements into a second specification
or prewrite the product solution. Describe each dependency once, using an edge list
or a node table, not both plus a numbered algorithm and a separate mechanisms list.

```markdown
# Design: <name>

Task: <unchanged request or exact source; additional evidence separately>
Deliverable: <requested artifact and exact location>
Context: <verified checkout/branch, delegated product root and exact shared paths>

## Entries

| Ref            | Entry kind    | Responsibility         | Invoked by |
| -------------- | ------------- | ---------------------- | ---------- |
| <name>         | runnable root | <entry responsibility> | operator   |
| <name>/<child> | direct child  | <bounded subtask>      | <node>     |

Graph: <each role's input, output, consumer and choice destination, once>
Handoffs: <exact Task/shared file paths, writers and readers; disjoint parallel scopes>
Bounds: <literal loop/group bounds with reasons; worst-case calls including saved children>
Evidence: <Task-derived criteria, required checks, optional checks and completion owner>
Exits: <accept, correct/recheck, blocked and exhausted routes; preserve work on non-success>
Review: <design checked against Task and source contract; material issues resolved>
```

For `group-only`, omit the `<name>` row entirely. Declare every direct child
that Build must create; do not declare grandchildren or an implicit root.
Omit unused child rows and mechanisms. Add model-route or procedural-brief decisions
only when they differ from authorized defaults. No default-value checklist is needed.
For budgets, launch defaults apply; every other undeclared workflow budget axis is unbounded.
An author-selected budget axis needs a consumer and a one-line reason, not a copied sample number.

Use the already selected pattern, without a mandatory planner or arbiter.
Known work can use one implement → review → bounded correction → fresh review loop,
including substantive implementation. Split stages only for real dependencies,
separate ownership or evidence that changes remaining work; keep integration QA when required.
Count orchestration machinery, not agents. A coherent additional subtask is not a defect.
Pattern-specific decisions below apply only when that mechanism is used.

### Briefs and context

The [working-context contract](authoring-styles.md#folder-level-context) owns clean-child
context. Give each child the complete relevant original Task or its unchanged accessible
source, current evidence and role-specific duties. Keep the original Task authoritative,
not repeated task copies or cumulative handoff history. Corrections need complete actionable
findings. Remove mechanical headings, repeated criteria and tool choreography that add no
information; do not turn workflow bookkeeping into product requirements.

Assign exact paths and writers/readers to shared handoffs and Task-required outputs.
Delegate product internals within the product root, respecting narrower Task bounds such as
an `index.html`-only product and preserving unrelated work. A product-read-only
reviewer may write its assigned report, not product files. The reviewer inspects the full
current diff with its own tools, including uncommitted work and every in-scope path;
the producer need not rebuild the change as an evidence bundle. Commit only when authorized.

A choice belongs only at a real routing edge; narrative travels whole without an invented
length cap. No brief requests a character, word, line or item count without a consumer
requirement. The [120-column readability rule](authoring-styles.md#text-readability)
wraps new author-owned prose; it never caps an answer or changes protected payload bytes.
Create SVG only on explicit request. The [optional diagram appendix](../../../docs/workflows/authoring.md#workflow-diagram-contract)
owns its artifact and visual checks; ordinary Build does not require a diagram.

### Review decisions and completion

The author checks the design before source: requested output, dependencies, ownership,
bounds and failure exits. A separate design-review agent is not required by default.
After Build, review the actual source against this record; a correct design does not prove
that its implementation has the same edges. Keep any independent review required by the Task
or selected authoring workflow. Do not add another reviewer merely to restate the design.

For each acceptance edge, trace blocking criteria to the request or an
authoritative contract and identify evidence an available child can obtain.
Account for every original requirement as verified, unmet or unverified in the
existing review artifact. For required reuse or state transitions, inspect the
transition the Task names, including already-created state when relevant.
Choose evidence that distinguishes the required behavior from a violation that
could produce the same output: deterministic recreation does not prove reuse.
A successful command or file presence alone cannot close unrelated requirements.
A product requirement does not by itself require one particular verification method.
Keep verification task-derived: use controlled fixtures for required behavior,
not an unrequested solver or optimization goal. Bound costly checker commands
with a task-justified limit; exhaustion leaves required evidence incomplete.
Nonblocking suggestions do not become acceptance criteria.
Do not assume the author's tools are available to children; assign any needed
capability discovery to an existing worker or reviewer.

Review both directions: preserve every required outcome, and reject any
added restriction that would prevent one. Workflow design changes
orchestration; it does not rewrite the task's requirements.

Separate observed defects, unmet required evidence and optional checks not
performed. An unavailable optional check is a coverage limitation, not
implementation work or a new blocking criterion.

When acceptance concerns file delivery, the evaluator inspects the actual
required files at their exact caller-assigned paths after the last correction or
cleanup. A report that files were created earlier is not evidence that they
remain available.

Repository ignore rules govern version control, not delivery. Cleanup may
remove disposable files belonging to this task; required deliverables remain.

Correction receives the complete actionable findings and is followed by
fresh review. A later delivery writer reports the reviewed state. If that
writer performs a new required check, its failure must reach an explicit
non-success route before successful completion.
Read a correction record only on a path where a correction produced it. An initial
acceptance path does not require correction evidence. Determine current acceptance
from the latest independent review; preserve earlier failures as history.

Walk terminal paths for a produced artifact with an optional check unavailable, a
confirmed defect and an explicitly required verifier unavailable. Delivery reports the
artifact's location, actual checks, known issues and unverified behavior. Non-success
preserves any produced artifact with the unmet requirement; it does not claim acceptance.
Operator changes to a generated workflow are not evidence that the authoring skill produced a correct design.

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
- no source carries removed `handoffs`, `output`, `returnVia`, `maxItemChars`,
  `maxAnswerChars` or `schemaMaxLength`, or ordinary-source forbidden `validate`,
  `repair` or `outputTransport`; a `schema` call follows the literal declaration and
  bounded consumption rules in [source boundary](source-boundary.md), and no size or
  budget number appears without a consumer requirement or design justification.

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

The packaged `task/plan` and `task/plan-light` own their authoring review loops and
caller-assigned source/evidence paths in the [task authoring manual](../../../examples/workflows/task/README.md).
They do not inherit an extra design-review stage from this lesson. Use the same exact source
for Node, the project-confined checker, reviewer and launcher. Retain its path, checked-byte
SHA-256 and actual outcomes. Before launch, reopen the regular nonempty source and compare
reviewed evidence; correction or replay requires current checks. Missing, drifted or failed
source forbids execution. Native completion prose does not attest file delivery.

A successful Build returns `/workflows run <name>` (or the qualified child ref).
Create-only stops there. Create-and-run continues through
[locus-pi-workflow-run](../../locus-pi-workflow-run/SKILL.md) with existing scoped
authorization and evaluates the actual terminal artifact. Keep specification
approval and external-effect boundaries intact.

## Pattern-specific design decisions

Read only the card needed by the selected graph:

- Adaptive slices: queue owner, cumulative allowance, correction/recheck, scope-change exit and final QA.
  Re-cut after every accepted slice, including the apparent last one; an empty queue does not prove completion.
- Fixed graph: known dependencies and bounds, with no unrequested judge or semantic retry.
- Refinement: completion authority, immutable criteria, measured evidence, round cap and no-progress rule.
- Decomposition: local concurrency, shared budget and key ownership; disjoint write scopes.
- Human continuation: two runs and a verified artifact handoff, not a suspended JavaScript stack.

Budget values and failure dispositions belong to the [runtime reference](../../../docs/workflows/index.md); source provenance, mutation and permitted DSL methods belong to [source contract](../../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape). Read the relevant sections before Build. Do not duplicate those invariants in another skill.

A standard source check is not live proof. Report the exact checks executed and any unavailable native checker, dependency, host or model route. Do not report successful Build after a skipped gate.
