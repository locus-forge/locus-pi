---
title: Workflow source contract
type: guide
status: active
updated: "2026-09-13T00:12:21Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow source contract

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

This is the runtime-owned contract checked by `workflow_check_source`. Start with
[the user guide](../locus-pi-workflows.md) to create a workflow, or
[the source boundary](../../skills/locus-pi-workflow-create/references/source-boundary.md)
for the short author-facing rules. Read this file when resolving a source diagnostic.

## Standard primitive profile

The packaged `locus-pi-workflow-create` skill emits an orchestration-only subset
of this profile. New generated source contains author-known prompts, direct
`agent()` edges, visible DSL control flow, and in-memory text publication. It
does not call `consumeTextArtifact`, `continuationArtifacts`, `outputDir`,
`projectRoot`, `promptFile`, `publishPrimaryFile`, `workspace`, `now`, or
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

The runtime desugars `choice` to its existing string-enum shape path. It owns
format instructions, parsing, validation, corrective re-ask, journal evidence,
replay, and budgets. A child that answers with the bare member text or echoes the
schema as `{"type":"string","value":"…"}` is read as that member and the journal
records the reading; anything else is re-asked once. By default exhaustion fails
closed. A design may declare
`choiceFallback` as one of the listed choices when a deterministic degraded route
is safer; the runtime uses it only after both invalid answers and records the
fallback in the journal. Workflow code does none of that recovery itself.

When discovery determines the work units at runtime, use text handoffs:

```js
const MAX_DAGS_IN_SCOPE = 12;
const units = await agent("Return one complete handoff per discovered unit.", {
  handoffs: { minItems: 1, maxItems: MAX_DAGS_IN_SCOPE },
});
```

Runtime states `handoffs` as a non-blank string array in the return contract and
owns the format instructions, same-session correction, replay, journal, budget, and
fail-closed behavior. Workflow code passes each returned string unchanged into
visible `parallel()` or `pipeline()` workers. `maxItems` is optional and belongs to
the CONSUMER: declare it when the approved Design names a fixed number of downstream
slots, and omit it when the work decides how many units there are. There is no
per-item character bound. Runtime allows one same-session correction by default, then
fails closed.

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
| `outputDir()`                        | Project-relative workflow workspace selected by the host.                   |
| `invokeWorkflow(declaration)`        | One real saved or exact-Package child run with durable item checkpointing.  |
| `publishPrimaryFile(path)`           | Validate/reference one non-empty workflow workspace file.                   |
| `promptFile(path, variables)`        | Long/shared role charter; never routing.                                    |
| `workspace(label, ref)`              | Runtime-owned retained worktree for approved write flows.                   |

`runWorkspaceDir()` is removed. Existing source that calls it fails with
`WorkflowRunWorkspaceRemovedError`; migrate to `outputDir()` and the single
project-local workflow workspace. The runtime does not create a run-local
`workspace/` directory.

Trusted raw `schema` and `validate` remain an advanced compatibility surface for
existing workflows. Standard generated source uses only exact text, `choice`,
and `handoffs` answers.

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
(`agent({ ask: true })`, REFERENCE "Live operator questions") are an
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
  `log`, `now`, `outputDir`, `parallel`, `phase`, `pipeline`, `projectRoot`,
  `promptFile`, `publishArtifact`, `publishPrimaryArtifact`,
  `publishPrimaryFile`, `random`, `workflow`, and
  `workspace`. Computed calls, aliases, `.bind()` wrappers, unknown globals,
  and other method calls are rejected.
- Every allowed DSL call has one exhaustive return classification:

  | Classification     | DSL calls                                                                                                      |
  | ------------------ | -------------------------------------------------------------------------------------------------------------- |
  | Runtime control    | `agent({ choice })` exact identity only                                                                        |
  | Opaque list        | `agent({ handoffs })`, `continuationArtifacts`, `items`, `parallel`, `pipeline`                                |
  | Saved-child status | `invokeWorkflow`; only its exact `status` identity is control                                                  |
  | Opaque value       | ordinary/model `agent`, `consumeTextArtifact`, `promptFile`, `workflow`, `workspace`                           |
  | Runtime/host value | `now`, `random`, `outputDir`, `projectRoot`, `publishArtifact`, `publishPrimaryArtifact`, `publishPrimaryFile` |
  | Void               | `awaitOperator`, `log`, `phase`                                                                                |

  Adding an allowed method without a return category fails closed. Only runtime
  choice, list identity/length, and saved-child status are control primitives.
  Opaque and runtime/host values may be forwarded whole through documented
  prompt, log, publication, scheduling, and return sinks, but may not be
  inspected, branched on, indexed, transformed, or embedded in `Error`.
  `outputDir()` may flow unchanged into `invokeWorkflow.outputDir`. Publication
  references and host paths may flow whole into an agent/log/return. A reference
  returned by `publishArtifact`, `publishPrimaryArtifact`, or
  `publishPrimaryFile` may also appear unchanged as a direct array element only
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
  environment input are unavailable. The implicit function `arguments` object
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
  key, `schema`/`validate` object key, regex, or `try/catch` is allowed. Inline
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

Adaptive slices are the default for substantive implementation; see the
[adaptive card](../../skills/locus-pi-workflow-create/references/adaptive-slices.md).
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

Author-known literal records may use named properties, including in visible
`.map()` callbacks, and flat object destructuring of those records. Model output,
caller semantic items and any composite containing them remain opaque. A map
that captures opaque values does not produce trusted author records. No helper
function, arbitrary object mutation, raw `schema` or `validate` becomes standard
through this allowance.

Every `agent()` call declares a literal `label`, and no two callsites in one file
share one. Replay addresses a completed call by its `phase`, `label`, and
occurrence, plus runtime-owned keyed group identity when supplied. A missing or
duplicate label fails the strict source check. An optional `title` is only a
human-readable description and never replaces stable identity.

### Output acceptance is not semantic continuation

Standard authoring uses `agent({ choice })`, the closed string `output` contract, or
`agent({ handoffs })`, described in [output acceptance](agent-results.md). Every
one of them is carried by the workflow-only `workflow_return` tool, which validates a
proposed value within the same child session; `returnVia` is no longer a choice the
author makes. The tool does not certify the truth of a decision, nor the facts inside
a shaped record. An author-declared `minItems`/`maxItems` on `handoffs` bounds how MANY
work units the stage returns, never how long one of them may be — the runtime adds no
size policy of its own, and the reason is stated once in
[the principle](agent-results.md#the-principle). Ordinary text and adaptive
fresh-worker rounds retain separate contracts. The standard source grammar still does not parse model prose or permit raw
`schema`/`validate`; `schema` is available to reviewed compatibility scripts only,
because the strict checker refuses raw `schema`. Review the [pattern index](../../skills/locus-pi-workflow-create/references/INDEX.md)
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

Plain-text `agent(prompt, { result: "report", label: "review" })` produces opaque text for the next agent. Author the static literal `result: "report"`; it cannot combine with shaped outputs. The checker validates direct option pairs, not the contents of variable or spread option objects; runtime validation covers every call. Source must not branch on, parse or inspect report content. An arbiter interprets full reports; a separate `choice` call can translate its recommendation into an edge. Runtime eligibility and fatal boundaries are defined in [agent execution reports](agent-results.md#agent-execution-reports). No `try/catch` exception is added to the standard grammar.
