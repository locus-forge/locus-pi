---
title: Workflow file format
type: guide
status: active
updated: "2026-09-22T17:02:15Z"
source_commit: "5365d3f8cd9c"
update_event: "cleanup"
context: "changes=XL files=46"
description: "Consolidate workflow contracts at their owning pages and repair outdated guidance."
---

# Workflow file format

[Workflow documentation](index.md) · [Authoring guide](create.md) · [Operator guide](running.md)

## Authoring a new workflow

Start with [Create a workflow](create.md) for the authoring request and first
working example. The [create skill](../../skills/locus-pi-workflow-create/SKILL.md)
owns Design → review → Build, including design-only and build-only requests.
A folder may contain a runnable same-named root or only directly addressable
children; the [catalog contract](catalog.md) defines both namespace forms.

The Package [task authoring workflow](../../examples/workflows/task/README.md)
provides an editable `task/draft` → `task/plan` handoff. Its manual owns incremental
source building and final gates. Neither entry executes the generated workflow;
a create-and-run request passes the checked file to the run skill.

A workflow is a single ESM module `<name>.workflow.mjs` with two exports:

- `export const meta = { name, description, phases? }` — catalog metadata only.
  `name` should match the saved file's `<name>` so it resolves by bare name;
  `description` appears in `/workflows list` and `/workflows info <name>`;
  optional `phases` declares the pipeline's shape before the run (see "Declared
  phases" below). Metadata does not declare the execution graph, agents,
  permissions, or runtime model, and nothing in it is enforced at runtime.
- `export default async function runWorkflow(dsl, input) { ... }` — executable
  behavior. `dsl` is the intended authoring handle; `input` is the run's task,
  always absent or semantic text (see "Workflow input" below). Whatever
  the function returns is written to `result.json` as `result`.
  Trusted JavaScript can still use host capabilities allowed by its identity mode,
  so `dsl`-only is a convention, not enforcement.

Destructure the primitives you need from the first arg:

```js
const {
  agent,
  publishArtifact,
  consumeTextArtifact,
  continuationArtifacts,
  items,
  awaitOperator,
  phase,
  log,
  parallel,
  pipeline,
  workflow,
  promptFile,
  workspace,
  outputDir,
  invokeWorkflow,
  publishPrimaryFile,
} = dsl;
```

The DSL is injected by Pi, so a workflow does not import runtime functions at
execution time. Repository-owned `.mjs` files can still give JavaScript IDEs a
declaration target with an import type in JSDoc:

```js
/**
 * @param {import("../runtime/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {string | undefined} input
 */
export default async function runWorkflow(dsl, input) {
  // PyCharm/WebStorm can now navigate agent(), phase(), log(), and other DSL methods.
}
```

Adjust the relative type path for a nested workflow. This comment performs no
runtime import and does not change source-identity coverage.

### Workflow diagram contract

A workflow with several stages, agents, branches, parallel groups, or persisted
handoffs keeps a visual map beside its source: exactly one hand-authored
`<name>-pipeline.svg`. It is edited directly. There is no generator, no
rendering dependency, and no exported preview to keep in sync;
[`examples/workflows/post-code-review/post-code-review-pipeline.svg`](../../examples/workflows/post-code-review/post-code-review-pipeline.svg)
is the remaining Package reference shape.

This replaced a generated trio — an `@kroffske/excalidraw-diagrams` generator,
its `.excalidraw` document, and a rendered PNG — on 2026-07-28. Three files had
to agree, changing anything required a library this package does not depend on,
and the only file a reader opened was the one nobody could review in a diff.

The diagram is an ownership map, not a decorative code trace:

- Separate the deterministic script from the child agents visually, and give the
  script one box per `phase()`. A reader must be able to see which decisions the
  code makes and which a model makes without opening the source.
- Every agent box says what it **receives** and what it **returns**. The handoffs
  between stages are the pipeline; a box that names only a role explains nothing.
- Say what constrains each child: its prompt, declared answer shape, and answer
  cap. Every child already receives all tools. A branch on a shaped answer is not the
  same claim as a branch on prose, and the picture must not blur them.
- Every branch and loop carries its real exit condition, including the ones that
  end the run: an operator pause with `disposition: awaiting_operator`, a
  fail-closed stop, and the terminal result a later run may consume.
- Draw each persisted artifact under the exact name the code publishes it with,
  so the picture and `.locus-pi/runs/<runId>/runtime/artifacts/` agree.
- Include a legend explaining every visual type used.

Keep the file self-contained and diffable: no `<script>`, no embedded or remote
images, no remote fonts or stylesheets, and a `<title>`/`<desc>` pair so the
diagram is readable without seeing it. `tests/extensions/workflows/tool/workflow-diagram-artifacts.test.ts`
pins those properties, refuses any resurrected generator or Excalidraw artifact
under the examples directory, and checks the diagram against the workflow source
so a renamed phase or a new artifact fails the suite instead of quietly leaving
the picture wrong. Visual inspection is still required: no structural check
proves that a diagram is readable.

### Minimal working example

One real agent that does a tool action and returns text:

```js
// hello.workflow.mjs
export const meta = {
  name: "hello",
  description: "One agent lists the cwd and returns readable text.",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const task = typeof input === "string" && input.trim() ? input.trim() : "list the cwd";

  phase("work");
  const workerText = await agent(
    `You are the workflow worker. Task: ${task}. Use a tool once, then return a concise Markdown answer.`,
    {
      label: "work",
    },
  );
  log("worker returned non-empty text");
  return workerText;
}
```

This example passes the machine-enforced `standard` grammar. The complete rule
list is in
[Workflow source contract](source-shape.md#machine-enforced-standard-source-shape).
Inside Pi, Build checks an authored file by calling `workflow_check_source`
with:

```json
{
  "path": ".locus-pi/workflows/<name>/<name>.workflow.mjs",
  "mode": "orchestration-only"
}
```

Run the same check for every declared direct child. Build requires checker and
Node syntax success, source-identity assessment, and conformance to the reviewed
design. Do not import or execute unchecked source as a preliminary smoke test.
The [source contract](source-shape.md#machine-enforced-standard-source-shape)
owns diagnostics, compatibility checking, opaque-value forwarding, allowed control
flow and binding rules. Warning-only checks remain successful.

Notes:

- Keep `meta.description` as one concise, purpose-first sentence: name the useful
  outcome, not test evidence, implementation detail, or a long execution trace.
  Use a literal static string near the top of the module. The browser scans only
  the first 64 KiB, accepts no interpolation/computed value, and shortens catalog
  display after 96 characters. Project and user workflows are never rewritten by
  the browser.
- `agent()` returns the child's exact non-empty final text by default. It never
  exposes child status fields as a model-controlled result, and it parses
  JSON-looking text only when the call declared a `schema` — the opt-in shaped
  path below. Technical metadata is written to the workflow journal.
- Write a stage's prompt inline in the script by default: a shared `COMMON`
  contract constant plus a per-stage template literal that interpolates the
  previous stage's exact text between `--- BEGIN <NAME> ---` / `--- END <NAME> ---`
  markers. The whole workflow then reads in one pass, and the retained script
  snapshot covers the prompt bytes, so a prompt edit changes the script identity
  instead of altering behavior beneath an unchanged hash.
- Use `promptFile("./resources/name.prompt.md", variables)` for the two cases
  where a separate file earns its indirection: a role charter long enough that
  inlining it buries the routing (roughly 80 lines and up, like the curated
  `review` verifier), or a prompt genuinely shared by more than one workflow.
  Keep the stable role and the per-run task in that one prompt. The path is
  source-relative and hash-backed, and it must resolve to a packaged
  `*.prompt.md`. Workspace isolation remains visible in the `agent()` options;
  tool policy does not, because every workflow child receives `tools: ["*"]`.
- `agent()` is the only model-calling step. For a **cheap one-shot decision**
  (a gate or classification), use
  `agent(prompt, { choice: ["accept", "revise"] })`.
  Standard source does not wrap that call in a parser or validator.

### Declared phases — `meta.phases`

A run's shape is otherwise only knowable by executing it, because phases are
declared imperatively by `phase()` calls inside the body. Optional `meta.phases`
is presentation metadata that states the pipeline up front; `phase()` is the
call that journals actual execution. The declaration is read by the same bounded catalog scan
that already extracts `description` — first 64 KiB, AST only, module never
imported or evaluated:

```js
export const meta = {
  name: "review",
  description: "Prepares clarification or runs a question-led review with runtime-owned artifacts.",
  phases: [
    { title: "prepare-clarification", detail: "Persist exact intent and prepare questions." },
    { title: "consume-clarification", detail: "Verify prior-run refs and persist answers." },
    { title: "resolve-scope", detail: "Turn exact intent and clarification into one review scope." },
    { title: "inventory-changes", detail: "Prove complete coverage of the changed surface." },
    { title: "plan-units", detail: "Group the inventory into atomic units of meaning." },
    { title: "ask-questions", detail: "Loop: write falsifiable questions, then assess whether a round is missing." },
    { title: "verify-review", detail: "Reopen evidence, answer questions, and author review.md." },
  ],
};
```

Rules:

- **Optional.** A workflow without `phases` is valid and every surface renders
  exactly as before. `task/draft` and `task/plan` declare theirs; single-stage
  `live-smoke` does not.
- **Literal only, all or nothing.** Each entry is an object literal with a
  non-empty static string `title` and an optional static string `detail`. One
  computed value, template interpolation, spread, or non-object element discards
  the entire declaration rather than reporting a partial pipeline — the same
  fail-closed rule an interpolated `description` already follows.
- **Static declaration contract.** An absent or empty declaration remains
  valid. A non-empty declaration is the complete unique vocabulary of literal
  `phase("...")` calls, in planned first-source order. The standard source
  checker reports `WF_PHASE_DUPLICATE_DECLARATION`,
  `WF_PHASE_CASE_MISMATCH`, and `WF_PHASE_UNDECLARED` as errors;
  `WF_PHASE_UNUSED_DECLARATION` and `WF_PHASE_ORDER_DRIFT` are warnings.
  Repeated calls to one phase are not duplicates, and the checker does not try
  to prove which branch will execute.
- **Runtime projection remains observational.** Runtime does not fail a run
  because a declared branch was not reached. `/workflows status <runId>`
  matches declared titles against the `phase()` lines the run actually emitted:
  an unreached declaration stays planned, while an observed undeclared phase is
  appended and marked `(undeclared)`. The static checker prevents that drift in
  authored `standard` source before execution; the status reader stays honest
  for legacy, integration, or historical runs.
- **Where it shows.** `/workflows info <name>` lists the declared stages with
  their details; `/workflows list` adds `phases=<count>` to the row; `detail` is
  shortened past 96 characters like `description`.

Titles exactly equal the literal `phase()` arguments they describe. Every
packaged workflow with a non-empty declaration is regression-tested against its
own unique literal calls in first-source order; workflows without a declaration
remain valid.

Do not reconstruct evidence paths from a single run id. Use the returned `runDir`
and the status/result commands; grouped children and resume attempts have their
own locations.

### Workflow input and host continuation

`input` is absent or one semantic string of any length, handed to
`runWorkflow(dsl, input)` unchanged by the tool and outer-trimmed only by the
slash-command parser. The runtime declares no character ceiling on it: an input
too large for a model is a provider-side failure with real evidence, not a
runtime guess made before the run starts. It contains the operator request or answers. It is not a
JSON command, marker grammar, or generic parameter bag. An object is rejected by
the tool schema and guarded again by the runner; nested `dsl.workflow()` calls
have the same string-only bound before their callback starts.

```json
{ "name": "audit-module", "input": "Audit src/auth strictly; report at most five confirmed findings." }
```

Agents interpret meaning. Trusted JavaScript owns orchestration, branches,
bounded loops, and deterministic invariants; workflow authors must not smuggle a
second object-input protocol into the string with JSON or marker parsing.

A programmatic caller may separately provide exact `items: string[]`. The runner
and runtime validate the array/string shape, and `dsl.items()` returns a detached
frozen snapshot. Order and bytes, including whitespace, empty strings, and
duplicates, are unchanged; there is no Locus items count or character policy.
Physical constraints still include caller/tool JSON, context, memory, total
attempts, and time. A source array, caller items, or bounded model-discovered
`agent({ handoffs })` result may feed the same visible `pipeline()` plus inline
`dsl.workflow()` mini-flow. Recorded discovery can replay in an exactly matching
prefix. Fresh rediscovery must not be attached to old positional saved-child keys.
Durable execution instead begins in a separate invocation with a caller-frozen,
approved list and stable caller-owned keys. Positional keys are safe only when
that exact list and ordering are intentionally unchanged for the reused output
namespace. Only model handoffs use corrective re-ask and blank/duplicate bounds.
No file or discovery-document parser participates.

Cross-run state travels separately through the tool's closed `continuation`:

```json
{
  "name": "review",
  "input": "The migration is reversible; old clients remain supported.",
  "continuation": {
    "originRunId": "20260722-120000-abcd",
    "artifactRefs": [
      { "runId": "20260722-120000-abcd", "artifactId": "published-0001", "name": "intent.md", "sha256": "..." },
      {
        "runId": "20260722-120000-abcd",
        "artifactId": "published-0002",
        "name": "clarification-questions.md",
        "sha256": "..."
      }
    ]
  }
}
```

The control accepts exactly `originRunId` and at least one complete ref, with no
package upper count limit. Every ref must
belong to the origin; duplicate identities and unknown fields fail closed. The
runtime verifies digests and copies text before workflow code or a child starts,
then exposes readonly `{sourceRef, consumedArtifact}` pairs through
`dsl.continuationArtifacts()`. The first journal event is the canonical runtime
continuation binding with exact source and current-run consumed refs. Direct
slash continuation is not supported. `continuation` cannot be combined with
replay-only `resumeFromRunId`.

### What is NOT supported

- **No arbitrary inline JS through the `workflow` tool.** The tool is trusted-file
  only: a saved `name` or a project-relative `scriptPath` (`script` is a legacy alias
  that normalizes to one of those). To run ad-hoc logic, save a `.workflow.mjs` first.
- **No custom primitives / event kinds / lifecycle states.** The [DSL surface](dsl.md#dsl-surface-v0) is
  the whole contract; do not invent a primitive the runtime does not expose.
- **Use `dsl` only as an authoring policy.** The machine-enforced `standard`
  profile reaches the filesystem/model through direct DSL calls and permits no
  imports. This is not a sandbox: the broader `legacy`, `integration`, and
  explicitly reviewed `entry-only` surfaces retain Node.js/module capabilities
  in the Pi host process. Do not run an unreviewed file or treat identity
  coverage, a worktree, or an approval receipt as a security boundary.
- **No silent dependency downgrade.** General identity policy allows a default
  script to remain one source module apart from static `node:` imports, but the
  `standard` authoring profile is stricter and imports nothing. If reviewed
  non-standard code genuinely needs local, package, dynamic, or `import.meta`
  behavior, declare literal `meta.identityCoverage: "entry-only"` and treat its
  hash as entry-only evidence.

### Delegate authoring through the packaged skill

Use the [create skill](../../skills/locus-pi-workflow-create/SKILL.md) directly or
ask a clean child to follow it. The [creation guide](create.md#ask-pi-to-create-it)
shows the request and separates creating source from executing its agents.
