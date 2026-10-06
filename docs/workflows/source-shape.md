---
title: Workflow source contract
type: guide
status: active
updated: "2026-10-06T14:26:19Z"
source_commit: "35b4a1294375"
update_event: "review_refresh"
context: "changes=XL files=34 task=T-147"
description: "Teach checked helper graphs and full-source replay identity over current schema authoring"
---

# Workflow source contract

[Workflow documentation](index.md) · [Create a workflow](create.md) · [DSL reference](dsl.md) · [Run a workflow](running.md)

Read this contract before authoring workflow source. The [DSL reference](dsl.md#dsl-surface-v0) describes callable methods, signatures, and examples; this page defines which source forms `workflow_check_source` accepts. New workflows use the [create guide](create.md) and the packaged skill's [short author-facing rules](../../skills/locus-pi-workflow-create/references/source-boundary.md).

Four boundaries apply: trusted runtime JavaScript, the `standard` compatibility grammar, and the stricter `mode: "orchestration-only"` grammar used by the create skill, and the explicit `dataflow-v1` profile/mode described below. A runtime method is not automatically permitted by either checker: `fusion()` is runtime-only and `runWorkspaceDir()` is removed. Both checkers admit the bounded literal `schema` form described below; `validate`, `repair` and `outputTransport` are removed and refused. The [availability table](dsl.md#dsl-surface-v0) distinguishes every method. Omitting the tool's mode selects standard compatibility checking; it does not restore removed options or grant arbitrary runtime JavaScript access.

The rules below own source restrictions and diagnostics. Passing them does not prove the workflow's prompts, decisions, side effects, or final result satisfy its goal; design review and execution evidence remain necessary.

## Standard primitive profile

Both packaged workflow-create lessons emit an orchestration-only subset
of this profile. New generated source contains author-known prompts, direct
`agent()` edges, visible DSL control flow, and in-memory text publication. It
does not call `consumeTextArtifact`, `continuationArtifacts`, `workspaceDir`,
`projectRoot`, `promptFile`, `workspace`, `now`, or
`random`. Those methods remain documented below only because the standard
checker must validate existing reviewed workflows. The skill calls
`workflow_check_source` with `mode: "orchestration-only"`, which machine-checks
the narrower Build contract.

`agent()` is the only model-calling primitive. Narrative output is exact text.
When JavaScript must route, use the runtime-owned exact choice:

```js
const route = await agent("Choose the next step.", {
  choice: ["accept", "revise", "blocked"],
  choiceFallback: "blocked",
});
```

The child submits one exact declared string through `workflow_return`; workflow
source receives the accepted value. The [agent result contract](agent-results.md#standard-exact-choice--agent-choice)
owns same-session correction, optional `choiceFallback`, journal evidence and
failure behavior. Workflow code neither parses an answer nor implements format repair.

Both checker modes validate a literal `choiceFallback` against a statically
visible literal `choice` array before execution. The fallback must satisfy the
runtime choice contract and be one of the declared choices. Dynamic values,
option spreads and shorthand declarations for choice remain runtime-validated; this
choice check does not evaluate expressions or resolve constants. Structured calls
have the stricter literal declaration rules below.

Within both checked authoring profiles, an agent returns opaque text, an exact choice,
or a schema-proven immutable JSON result. Discovered work may use a proven structured
array, or the agent can write units to an exact caller-assigned file and return readable
text for a later agent that reads that file. When the caller already knows the units,
pass them through `items()` and hand each string unchanged to visible `parallel()` or
`pipeline()` workers. A queue that changes as work lands stays in its file and is
processed by a bounded `for` loop whose passes are routed by exact `choice`.
`handoffs`, `output` and `returnVia` remain removed. A declared literal schema can instead
expose bounded fields or arrays to source; see [checked structured results](#checked-structured-results).
Both profiles still refuse `validate`, `repair` and `outputTransport`.

The remaining standard orchestration primitives are:

| Primitive                            | Responsibility                                                              |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `parallel(thunks)`                   | One fail-closed barrier over independent author-known calls.                |
| `pipeline(items, ...stages)`         | Fixed ordered stages for each author-known item.                            |
| `phase(name)` / `log(text)`          | Reader-visible run progress.                                                |
| `publishArtifact(name, text)`        | Supporting exact text artifact.                                             |
| `publishPrimaryArtifact(name, text)` | One terminal semantic document.                                             |
| `awaitOperator(declaration)`         | Declare a split-run human gate, then return; no suspended JavaScript stack. |
| `items()`                            | Immutable exact caller-supplied text units.                                 |
| `workspaceDir()`                     | Absolute native runtime workspace; no agent-file placement authority.       |
| `invokeWorkflow(declaration)`        | One real saved or exact-Package child run with durable item checkpointing.  |
| `promptFile(path, variables)`        | Long/shared role charter; never routing.                                    |
| `workspace(label, ref)`              | Runtime-owned retained worktree for approved write flows.                   |

`runWorkspaceDir()` is removed. Existing source that calls it fails with
`WorkflowRunWorkspaceRemovedError`; assign exact intermediate and final paths
in prompts. `outputDir()`, `publishPrimaryFile()` and the source-file overload
of `publishPrimaryArtifact` are also removed and rejected by both check modes when statically visible. Literal root/child `meta.outputDir` fails before import. Trusted entry-only code can materialize metadata during import; the loaded module is then checked before its entry or any agent runs. The runtime does not create a run-local
`workspace/` directory.

Choose exact text for narrative, `choice` for a single routing token, and literal `schema`
only when source needs its proven JSON shape. Schema acceptance is not semantic verification;
required reviewers and external-action authorization remain unchanged.

Standard generated source omits `maxToolCalls` and `timeoutMs` unless the operator
requests a per-attempt control and the approved Design records why. The
[budget policy](budgets.md#run-budget) owns launch defaults and explicit overrides;
there is no implicit per-attempt emergency fuse. Do not mechanically sweep legacy workflows.

Portable `modelRole` normally degrades to the parent session model with recorded
evidence when no layer assigns it. A stage whose accepted evidence depends on
that exact tier may declare `requireModelRole: true` beside its explicit
`modelRole`. Record the fail-closed requirement in Design. Do not use the flag
with concrete `model`, as a prestige selector, or without naming why fallback
would invalidate a fresh run. Replay starts no child and follows the recorded
evidence contract.

Standard generated source also omits `ask: true`. Live operator questions
([`agent({ ask: true })`](running.md#live-operator-questions--agent-ask-true)) are an
interactive capability for operator-attended workflows: the child asks through
`workflow_ask` and continues with the answer in the same session. Declare it
only when the approved Design names the stage that may ask and why an
assumption is not enough — decomposing unknowns into explicit assumptions
remains the default. An `ask: true` stage makes the workflow unusable in
`print`/`json` and unattended runs (the call fails closed with
`ask-unavailable`), so a pipeline meant for automation must not declare it.

The same applies to `dsl.awaitOperator(...)`: an unattended caller may launch
any workflow with the run-level no-operator mode (`/workflows run <name>
--no-operator`, or the `workflow` tool's `noOperator: true`), and under that
mode every request for operator input — `awaitOperator` or an `ask: true`
stage — fails closed with a named reason instead of pausing the run. A
headless launch (`print`/`json`) turns that mode on by default, so any workflow
run from a pipeline is in it unless the caller passes `--operator`. Author for
that reality: a workflow meant for automation asks nothing and turns unknowns
into explicit assumptions inside its result.

## Machine-enforced standard source shape

The build gate is deliberately a small source grammar, not a second workflow
engine. Inside Pi, call the read-only `workflow_check_source` tool with the
project-relative path of the exact file Build produced:

```json
{
  "path": ".locus-pi/workflows/<name>/<name>.workflow.mjs",
  "mode": "orchestration-only"
}
```

Run the same check for every declared direct child file. Build succeeds only
when the design `Entries` set, files, `meta.name` values, Node syntax, source identity, and
source checks all agree.

The tool is owned by the installed `workflows` extension and resolves the path
inside the current project. It behaves the same for a source checkout and an
installed package. Omitting `mode` keeps compatibility validation for existing
reviewed workflows; the workflow-create skill never omits it. Repository
maintainers use `npm run check:workflow-source`
with no path to check every `standard` entry
already present in the Package registry. Neither command discovers
or adds registry entries. The repository-wide `npm run check` gate runs that
Package check. Source-shape validation does not replace source-identity
assessment or semantic design/source comparison.

Diagnostics are compiler-shaped. Human-readable output uses
`path:line:column [CODE] message`; the tool result also returns the full
`diagnostics` array with stable `code`, `severity`, one-based source spans, and
optional related spans. An `error` fails the tool. A `warning` keeps the check
successful while making declaration drift visible. Existing automation that
calls `standardWorkflowSourceShapeErrors()` keeps the legacy sorted `string[]`
error projection; warnings are intentionally absent from that compatibility
view.

Build remains failed until the exact source passes this checker, Node syntax validation,
identity checks, and design/source comparison. An unavailable tool or failed
checker result cannot be reported as a successful Build.

These are all rules enforced for `meta.profile: "standard"`:

- Source must parse as JavaScript. The module has exactly one literal
  `export const meta` whose profile is
  `"standard"`, plus exactly one visible default function or arrow export. A
  named entry is `run` or `runWorkflow`. Other top-level declarations are
  `const` values made only from literal arrays, objects, scalars, and static
  strings; comments and a hashbang are harmless, but there are no other
  statements or exports.
- `meta.phases` remains optional. When it is a non-empty literal array, it is
  the complete unique vocabulary of literal `phase("...")` calls in planned
  first-source order. An exact or case-equivalent duplicate declaration, a
  case-only call mismatch, or an undeclared literal phase is an error. An unused
  declaration or order drift is a warning. Repeated calls to the same phase and
  branches not reached in one run are valid; the checker compares source
  vocabulary, not runtime reachability.
- Standard source has no static import, re-export, dynamic `import()`, or
  `require()` call, including `node:` modules. This is stricter than the general
  source-identity policy described below.
- Run bodies use only lexical declarations, expressions, `if`, `switch`,
  `for`, `for…of`/`for…in`, `while`, `break`, `continue`, `return`, `throw`, and
  empty statements. Labels, `do…while`, and other statement forms are outside
  this profile.
- Calls are direct uses of the bound DSL primitives: `agent`, `awaitOperator`,
  `consumeTextArtifact`, `continuationArtifacts`, `invokeWorkflow`, `items`,
  `log`, `now`, `parallel`, `phase`, `pipeline`, `projectRoot`,
  `promptFile`, `publishArtifact`, `publishPrimaryArtifact`,
  `random`, `workflow`, and
  `workspace`. Computed calls, aliases, `.bind()` wrappers, unknown globals,
  and other method calls are rejected.
- Every allowed DSL call has one exhaustive return classification:

  | Classification     | DSL calls                                                                                   |
  | ------------------ | ------------------------------------------------------------------------------------------- |
  | Runtime control    | `agent({ choice })` exact identity only                                                     |
  | Structured JSON    | awaited `agent({ schema })`; only schema-proven operations below                            |
  | Opaque list        | `continuationArtifacts`, `items`, `parallel`, `pipeline`                                    |
  | Saved-child status | `invokeWorkflow`; only its exact `status` identity is control                               |
  | Opaque value       | ordinary/model `agent`, `consumeTextArtifact`, `promptFile`, `workflow`, `workspace`        |
  | Runtime/host value | `now`, `random`, `workspaceDir`, `projectRoot`, `publishArtifact`, `publishPrimaryArtifact` |
  | Void               | `awaitOperator`, `log`, `phase`                                                             |

  Adding an allowed method without a return category fails closed. Only runtime
  choice, list identity/length, saved-child status, and proven structured enum/boolean
  comparisons are control primitives.
  Opaque and runtime/host values may be forwarded whole through documented
  prompt, log, publication, scheduling, and return sinks, but may not be
  inspected, branched on, indexed, transformed, or embedded in `Error`.
  `invokeWorkflow` accepts no directory field; saved children inherit both root locations. Publication
  references and host paths may flow whole into an agent/log/return. A reference
  returned by `publishArtifact` or `publishPrimaryArtifact` may also appear unchanged as a direct array element only
  at `awaitOperator({ operatorHandoff: { continuationArtifactRefs: [...] } })`.
  A published reference may also flow unchanged to one question's
  `detailArtifactRef` when that exact ref appears in the continuation array; the
  runtime reads and bounds its text for UI instead of letting workflow source
  inspect or interpolate it.
  Another runtime value, property, nesting layer, or derived form remains
  rejected. This source-shape rule checks only the static producer and sink; the
  host runtime verifies that every reference belongs to the terminal source run
  and appears in its terminal artifact projection. Void calls are standalone
  effects and cannot be bound, nested, or returned as values.

- Only the first run parameter supplies DSL bindings. The second parameter is
  semantic input, never another DSL object.
- Every value read by standard source resolves to a declared lexical/literal
  binding or the approved `Error` language root. Ambient host values and hidden
  environment input are unavailable. Lexical identifier spellings cannot contain Unicode
  escapes; escaped string/property literals remain supported. The implicit function `arguments` object
  is rejected; run and callback values use explicit named parameters.
- The only extra collection calls are a visible `.map(callback)` over an array
  or a source-ordered binding derived from an array or collection-producing DSL
  call, and `.join()` used inside an `agent()` prompt template. The only extra
  string call is the exact boundary default
  `typeof input === "string" && input.trim() ? input.trim() : "literal"`.
- Inline callbacks use arrow functions. Function expressions, including named
  function expressions, are outside the standard grammar; this keeps callback
  bindings and their lexical scope explicit.
- Semantic input, plain `agent()` text, and items/item aliases are opaque.
  Standard source may forward each whole value into an agent prompt, progress
  log, exact text publication, return value, or unchanged saved/inline item
  scheduling. It may not inspect properties, measure or compare the value,
  branch on it, transform/render it elsewhere, or rename a mapped item.
  Runtime-owned `agent({ choice })` identities, list identity/length, saved-call
  status, callback indexes, and declared loop counters may drive control flow.
  Opaque values may not appear anywhere inside a computed subscript index.
- Arrays, object values, spreads, and nested composites preserve contained
  semantic/runtime provenance. Wrapping a value never makes it author-known;
  unchanged whole values may still reach the documented scheduling,
  publication, prompt, log, and return sinks.
- Every value-bearing callback parameter is classified. A `pipeline()` stage
  receives one opaque value and an optional runtime-owned index; every `.map()`
  parameter, including its whole-array parameter, retains the collection's
  provenance. An unrecognized callback parameter is rejected rather than
  treated as author-known data. Mapping an opaque list remains opaque and cannot
  make its items author-known. Durable key arrays derived from caller items may
  flow only unchanged into the matching `invokeWorkflow()` `key`/`keys` fields.
- No helper function declaration, function-valued variable, object method,
  class, object/variable function wrapper, hidden edge callback, computed object
  key, unrecognized `schema`/`validate` object key, regex, or `try/catch` is allowed.
  `schema` is admitted only in a recognized structured agent declaration or its literal schema data. Inline
  callbacks containing agent edges remain visible only under `parallel`,
  `pipeline`, or `workflow` calls.
- Assignments, augmented assignments, and updates are rejected except for the
  existing numeric `for` increment and the narrow whole-value carry below.
  A counter may never be a protected DSL, collection, or `Error` binding;
  only `++`/`--` or a numeric `+=`/`-=` step is accepted in an ordinary loop.
  Whole-value carry requires a stricter ascending, provably finite literal loop.
  `new` constructs only the unshadowed global `Error` constructor, and every
  `Error` argument must remain author-known or literal. Opaque/runtime values
  are rejected anywhere inside its message, options, cause, arrays, objects,
  spreads, nesting, or member extraction. Sequence expressions are rejected
  even when every operand is a literal; use one explicit expression or
  statement at a time.
- Run parameters, nested callbacks, lexical declarations, loop bindings, and
  switch blocks may not shadow trusted DSL bindings, recognized collection
  bindings, or `Error`. Bare and parenthesized arrow parameters follow the same
  rule. Assignment targets cannot rebind those trusted names either.
- Every semantic or runtime-owned value-bearing binding name is globally unique
  in one standard source file. This intentionally conservative rule keeps
  provenance independent of JavaScript scope. A nested scalar literal may reuse
  such a spelling; its real lexical block, including a `switch` body, does not
  change the outer value's provenance.

### Bounded carry and author-owned records

A literal bounded loop is ordinary control flow in any graph, including a fixed
graph; see the [adaptive card](../../skills/locus-pi-workflow-create/references/adaptive-slices.md)
for re-cut queues.
A `let` seeded with `[]` may carry a whole opaque list in the same finite literal
`for` shape described below. List length/indexing schedules work; contents remain
opaque, including aliases, mapped items and `for…of` bindings. No push, shift,
truncation, property parsing, callback mutation or reset to a fabricated list is
allowed. This is source-checker policy; existing runtime handoffs do the work.

A reviewer-gated refinement is opt-in control flow, not a global retry policy.
The [runnable refinement example](../../extensions/workflows/references/examples/refinement.workflow.mjs)
uses a literal `for`, a fresh worker and exact reviewer feedback. There is no
new `untilComplete` primitive. The checker permits scalar `let` bindings seeded
with literal strings before that loop to receive a whole opaque answer or a
whole runtime-owned `choice` identity. The loop must use a numeric literal start,
ascending literal `<`/`<=` bound and positive literal step. The counter cannot be
reset elsewhere. Carry cannot escape into a callback or mutate shared branch
state, mix control and opaque values, replace a result with a fabricated literal,
inspect properties or transform the answer. Carried values and aliases retain
provenance; initializing a variable with `""` does not launder later model text.
The `let` must sit in the same block immediately before the nearest `for` that
assigns it. A carry assigned in a nested loop but declared outside that loop,
or declared in a block around the loop's own block, is rejected, and so is a
branch assignment outside any loop, even one that runs once. A node after
alternative branches therefore receives their whole reports through a carry
assigned inside a bounded loop.

Author-known literal records may use named properties, including in visible
`.map()` callbacks, and flat object destructuring of those records. Plain model output,
caller semantic items and any composite containing them remain opaque. A map
that captures opaque values does not produce trusted author records. Schema-proven
results use the separate bounded rules below. No helper function, arbitrary object
mutation, dynamic schema or custom `validate` becomes standard through this allowance.

Every `agent()` call declares a literal `label`, and no two callsites in one file
share one. Replay addresses a completed call by its `phase`, `label`, and
occurrence, plus runtime-owned keyed group identity when supplied. A missing or
duplicate label fails the strict source check. An optional `title` is only a
human-readable description and never replaces stable identity.

### Checked structured results

Both source-check modes admit `agent(prompt, { label: "literal", schema: ... })`.
The options must be a direct object with distinct explicit static properties: no
spreads, shorthand, computed keys, duplicate keys or aliased option objects. `schema`
is either literal data or one unshadowed top-level literal `const` bound to one identifier,
never a destructuring pattern, alias chain, imported value, callback, helper call or computed expression. Schema objects
and arrays also contain only explicit literal data. The checker never executes source
to discover a schema. `choice`, `choiceFallback` and `result: "report"` cannot combine
with `schema`; `validate`, `repair` and `outputTransport` remain forbidden in both modes.
Decoded schema property names such as `outputDir` are data; same-named workflow options
remain refused.

The same runtime `locus-json-subset-v1` normalization applies. Optional properties,
open objects and arrays without `items` are valid declarations. Those runtime
allowances do not prove that a particular field or item shape can be read by source.

- Await a structured result before consuming its shape. A pending Promise may be
  bound or returned whole, but no property read or implicit Promise consumption is allowed
- Keep unchanged aliases or return the complete JSON result. A wrapper or mapped/group
  composite whose shape is not proven remains opaque rather than gaining inferred fields
- Read only named properties declared in `properties` and present in `required` at
  each level. Unknown/open-object keys and optional properties stay unreadable, even
  after an optional-property guard; no general flow-sensitive narrowing is provided
- Compare a declared primitive enum member or boolean with an exact allowed literal
  using `===` or `!==`. Schema shape is not evidence that the model's assertion is true
- Use a proven array's `length`, visible `.map()` or `for…of`. A declared `items`
  schema supplies item shape; otherwise each item stays opaque. All unchecked indexing,
  including a literal index and an index below `minItems`, is refused
- Map JSON values synchronously. Async callbacks or callbacks returning pending Promises,
  including through arrays, objects or aliases, are refused; `await rows.map(async ...)`
  does not settle array elements. Function projections may feed the existing owned
  `parallel(rows.map(row => () => agent(...)))` composition but cannot be returned as
  JSON or wrapped in projected records/arrays. Only directly visible branch functions
  qualify; conditional/short-circuit selections do not prove a branch list. Possible
  pending/function contents survive aliases, containers and projections. Existing
  inline-edge rules still apply
- Forward a proven string unchanged into an `agent()` prompt, `log()`, or text
  publication. Interpolate scalar JSON fields directly into those sinks' templates.
  Objects/arrays cannot become text through implicit rendering or `JSON.stringify`
- Do not destructure structured results, mutate their fields, transform them with
  arbitrary methods or helpers, or launder their provenance through aliases

Both a visible default function and default arrow entry may receive DSL bindings;
`const { agent } = dsl` follows the same direct-binding rules. This is not permission
for arbitrary helper aliases. The [DSL examples](dsl.md#agent) are checked in both modes.

Source acceptance and replay coverage remain separate. Structured array `.map()`
closures can be covered when their source, schema and awaited receiver are proven.
Generalized numeric-loop replay remains conservatively unproven; an accepted bounded
source loop does not by itself promise structured replay. The existing full source/schema/input
identity and v3 observer receipt checks still apply; see [structured replay](agent-results.md#structured-results-v4).

### Output acceptance is not semantic continuation

Standard authoring routes with `agent({ choice })` or a proven structured enum/boolean,
described in [output acceptance](agent-results.md). Both use the workflow-only
`workflow_return` tool, which checks the declared choice or schema within the same child
session. The tool does not certify the truth of a decision. The runtime adds no size
policy of its own; the reason is stated once in
[the principle](agent-results.md#the-principle). Ordinary text and adaptive
fresh-worker rounds retain separate contracts. The standard source grammar does not
parse model prose. It admits only the literal-schema declaration and bounded consumption
above, still refusing `validate`, `repair`, `outputTransport` and the removed `handoffs`,
`output` and `returnVia` options by name. Review the [pattern index](../../skills/locus-pi-workflow-create/references/INDEX.md)
before selecting adaptive slices, fixed, refinement, decomposition or human-gated execution.

The owner contract separately forbids mandatory acknowledgement protocols whose
answer has no consumer. That is an explicit design/source review rule, not a
prompt-English parser: the structural checker does not guess intent from words
such as `DONE`, `OK`, or `WRITTEN`.

## Saved module and identity

A built workflow is one ESM module:

```js
export const meta = { name: "<name>", description: "<one line>", profile: "standard" };
export default async function runWorkflow(dsl, input) {
  // use only the dsl members the approved graph needs
}
```

The filename is exactly `<name>.workflow.mjs`. `.locus-pi/workflows/` is the canonical
project target. Source identity and authoring profile are separate gates. The
general `self-contained-static` identity accepts static `node:` imports, and
`legacy`, `integration`, or explicitly reviewed non-standard source may use
that allowance. The `standard` source-shape profile imports nothing. Local,
package, or dynamic imports require literal
`meta.identityCoverage: "entry-only"`, which binds only entry bytes and is also
outside `standard`. The analyzer cannot infer arbitrary eval or `createRequire`
aliases; declare the downgrade honestly.

Before handoff, run `assessWorkflowSourceIdentity()` against exact source bytes,
then import the module and require `meta.name` plus a default function. Static
validation is not evidence that the workflow ran.

### Explicit execution observations

Plain-text `agent(prompt, { result: "report", label: "review" })` produces opaque text for the next agent. Author the static literal `result: "report"`; it cannot combine with `choice`. The checker validates direct option pairs, not the contents of variable or spread option objects; runtime validation covers every call. Source must not branch on, parse or inspect report content. An arbiter interprets full reports; a separate `choice` call can translate its recommendation into an edge. Runtime eligibility and fatal boundaries are defined in [agent execution reports](agent-results.md#agent-execution-reports). No `try/catch` exception is added to the standard grammar.

## Checked dataflow-v1

Declare literal `meta.profile: "dataflow-v1"` and check it with
`workflow_check_source({ path, mode: "dataflow-v1" })` or
`npm run check:workflow-source -- --mode dataflow-v1 path.workflow.mjs`.
This opt-in admits synchronous data-only helpers and finite schema-checked v4
values while keeping DSL effects visible and owned.

Helpers are named module functions or const-bound synchronous arrows. They accept
only data, capture module literal constants and other checked helpers, and form
an acyclic direct-call graph. Local consts, destructuring, ordinary expressions,
conditionals, returns, throws and pure try/catch are supported. Pure inline
callbacks may also capture enclosing data parameters and immutable data locals.
The checker resolves actual lexical bindings, including catch parameters and
shadowing; it never executes a helper.

Supported data operations are array `map`, `filter`, `reduce`, `flatMap`, `slice`,
`concat`, `join`, `at`, `includes`, `indexOf`, `find`, `findIndex`, `some`, `every`;
string `trim`, `split`, `startsWith`, `endsWith`, `toLowerCase`, `toUpperCase`;
`JSON.parse`/`stringify`, `Array.isArray`, `Object.keys`/`values`/`entries`/`hasOwn`,
`Number.isFinite`/`isInteger`/`isSafeInteger`, and explicit `String`/`Number`/`Boolean`
conversion. Explicit parsing produces ordinary unchecked data and may throw.
It creates neither a schema receipt nor authority to execute code.

Agent options use a direct object with unique static keys. Schema declarations
are literal data or immutable literal const references. Current schema, choice,
report and fixed initial-plus-one same-session correction contracts still apply.
`validate`, `repair` and `outputTransport` remain removed, including when their
value is `undefined`. Domain assertions in helpers run after the schema result;
they throw ordinary workflow errors without feeding a correction back to that child.
The existing string `input` remains unchanged.

Statically known functions cannot be stored, returned or passed as ordinary data:
this includes helpers, DSL capabilities, global intrinsics and native methods of
literal arrays/strings, const aliases and actual root/workflow text ports. Direct
and parenthesized calls retain their callee role. Receiver-specific own data
fields such as `const row={map:"data"}; return row.map` remain usable. An unknown
receiver extraction such as `function pick(value){return value.map;}` is admitted
for fresh trusted source but makes replay coverage unproven. This is a bounded
source policy, not proof that every runtime property or result is non-callable.

DSL work stays at the root or an owned inline group/stage. Calls
to `workflow()` give their direct inline callback a real first DSL argument.
The callback can capture the outer DSL and omit parameters. A declared first
parameter is written `dsl` or destructured with the method names; the second is data.
The same lexical binding checks apply to nested workflows and local DSL
destructuring. Ordinary data callbacks and pipeline stage parameters receive data.
Promise-producing DSL calls are directly awaited or returned. Synchronous phase/log/publication and
`awaitOperator` keep their normal usage. An owned parallel factory directly maps
data to inline thunks and supplies complete stable keys, as below; literal thunk
arrays and inline pipeline/workflow stages are also supported. Stored promises or
thunks, eager promise maps, effectful ordinary callbacks, callable parameters,
DSL aliases, async data helpers and DSL try/catch/finally are refused. Group budget
and cancellation failures propagate and started branches drain before termination.

Admission checks complete retained source for statically visible opted-in or
unresolved exported profile declarations before import. Computed profile values
are refused without evaluating their expressions. Opaque metadata construction
retains trusted legacy import semantics: its import effects can run, but a loaded
`dataflow-v1` profile without checked static admission is refused before the entry
or any child work. This boundary applies to both roots and saved children.
Resume refuses any
source-byte change, including helper, comment, profile edits or profile removal;
it checks both recorded and current snapshots against their persisted identities.
A valid fresh source can still have unproven callable coverage (for example,
dynamic indexed access); its resume refuses before workflow effects or child work.
The exact examples below pass both checks. Existing input, route and committed
receipt checks remain required; unsafe tool observer v1/v2 records are not upgraded.

This source contract assumes ordinary trusted host intrinsics. Workflows still
execute trusted full-Node author code; the checker does not isolate workers or
change agent permissions. It does not prove safety against modified globals or
adversarial getters outside the data contract.

### Records to owned review work

The planner returns schema-checked records. Source rejects duplicate/blank IDs
before fan-out and checks each review's caller-assigned ID inside its branch.
These are workflow domain failures: a committed schema-valid but domain-invalid
answer fails the same assertion on replay, without starting another child.

<!-- prettier-ignore -->
```js
export const meta = { name: "dataflow-review", profile: "dataflow-v1" };

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "prompt"],
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["review", "context"] },
          prompt: { type: "string" },
        },
      },
    },
  },
};
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "summary"],
  properties: { id: { type: "string" }, summary: { type: "string" } },
};

function checkedPlan(value) {
  const ids = value.items.map((item) => item.id);
  if (ids.some((id, index) => id.trim() === "" || ids.indexOf(id) !== index)) {
    throw new Error("Plan item ids must be unique and nonblank");
  }
  return value;
}
function selectItems(rows, allowedKinds) {
  return rows.filter((row) => allowedKinds.includes(row.kind));
}
function checkedReview(value, assignedId) {
  if (value.id !== assignedId) throw new Error("Review must return its assigned item id");
  return value;
}
function renderReviews(rows, total) {
  const body = rows.map((row) => `${row.id}: ${row.summary}`).join("\n");
  return `Reviewed ${rows.length} of ${total} records; others were context.\n${body}`;
}

export default async function run({ agent, parallel, phase, log, publishPrimaryArtifact }, input) {
  const task = input ?? "Separate review work from supporting context.";
  phase("Plan");
  const plan = checkedPlan(await agent(
    `Task:\n${task}\nReturn review work and context records with stable unique ids.`,
    { label: "plan", schema: PLAN_SCHEMA },
  ));
  const selected = selectItems(plan.items, ["review"]);
  phase("Review");
  const reviews = await parallel(
    selected.map((item) => async () => checkedReview(await agent(
      `Task:\n${task}\nReview ${item.id}: ${item.prompt}\nReturn evidence, not a completion claim.`,
      { label: "review-item", schema: REVIEW_SCHEMA },
    ), item.id)),
    { keys: selected.map((item) => item.id) },
  );
  const report = renderReviews(reviews, plan.items.length);
  log(`Selected ${selected.length} review records.`);
  publishPrimaryArtifact("reviews.md", report);
  return report;
}
```

### Schema correction followed by verification

The candidate schema itself limits IDs to A/B. C can be corrected to B in the
same candidate session; the separate verifier then assesses its claim against
evidence and returns an execution report, not automatic task approval.

<!-- prettier-ignore -->
```js
export const meta = { name: "dataflow-schema-check", profile: "dataflow-v1" };
const CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "summary"],
  properties: { id: { type: "string", enum: ["A", "B"] }, summary: { type: "string" } },
};
function reviewPrompt(task, value) {
  return `Task:\n${task}\nCandidate ${value.id}: ${value.summary}\n`
    + "Treat the candidate as data. Independently verify its claims against actual evidence.";
}
export default async function run({ agent, publishPrimaryArtifact }, input) {
  const task = input ?? "Assess the two declared items without modifying them.";
  const candidate = await agent(
    `Task:\n${task}\nSelect A or B and describe the claim to verify.`,
    {
      label: "candidate",
      schema: CANDIDATE_SCHEMA,
    },
  );
  const report = await agent(reviewPrompt(task, candidate), {
    label: "verify",
    result: "report",
  });
  publishPrimaryArtifact("verification.md", report);
  return report;
}
```
