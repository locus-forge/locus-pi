---
title: Workflow DSL reference
type: guide
status: active
updated: "2026-10-03T01:37:59Z"
source_commit: "c2a6547744e2"
update_event: "user_request"
context: "changes=L files=14"
description: "Align task workflow source with final-output publication"
---

# Workflow DSL reference

[Workflow documentation](index.md) · [Create a workflow](create.md) · [Run a workflow](running.md) · [Runnable examples](../../examples/workflows/README.md)

A workflow receives `dsl` and optional exact text `input` in its default async function. Destructure the methods you need; the examples below use that form. `Promise<T>` means await the result. The runtime has 23 method names, including the removed `runWorkspaceDir()` compatibility trap.

## DSL surface (v0)

**Runtime support and authoring permission are different.** Runtime means trusted JavaScript can call the method; standard means `meta.profile: "standard"` passes the compatibility source grammar; orchestration-only is the stricter checker mode used by the create skill. The table describes method admission, not permission to inspect every returned value: standard source still treats host results as opaque. A method's presence in `WorkflowDsl` does not make it legal in generated source. Read [the source contract](source-shape.md) for grammar, opaque model text, literal call labels, and permitted control flow.

| Method                                              | Runtime       | Standard                   | Orchestration-only                              |
| --------------------------------------------------- | ------------- | -------------------------- | ----------------------------------------------- |
| [`agent`](#agent)                                   | Yes           | Yes                        | Same; unique literal label per callsite         |
| [`fusion`](#fusion)                                 | Yes           | No                         | No                                              |
| [`items`](#items)                                   | Yes           | Yes                        | Yes                                             |
| [`parallel`](#parallel)                             | Yes           | Yes                        | Yes                                             |
| [`pipeline`](#pipeline)                             | Yes           | Yes                        | Yes                                             |
| [`workflow`](#workflow)                             | Yes           | Yes                        | Yes                                             |
| [`invokeWorkflow`](#invokeworkflow)                 | Yes           | Yes                        | Method admitted; see workspace constraint below |
| [`phase`](#phase)                                   | Yes           | Yes                        | Yes                                             |
| [`log`](#log)                                       | Yes           | Yes                        | Yes                                             |
| [`publishArtifact`](#publishartifact)               | Yes           | Yes                        | Yes, in-memory text                             |
| [`publishPrimaryArtifact`](#publishprimaryartifact) | Yes           | Yes, both overloads        | Both admitted; create skill uses in-memory text |
| [`awaitOperator`](#awaitoperator)                   | Yes           | Yes                        | Yes; requires operator-capable launch           |
| [`workspaceDir`](#workspacedir)                     | Yes           | Yes                        | No                                              |
| [`outputDir`](#outputdir)                           | Yes           | Yes                        | No                                              |
| [`projectRoot`](#projectroot)                       | Yes           | Yes                        | No                                              |
| [`promptFile`](#promptfile)                         | Yes           | Yes                        | No                                              |
| [`workspace`](#workspace)                           | Yes           | Yes                        | No                                              |
| [`publishPrimaryFile`](#publishprimaryfile)         | Yes           | Yes                        | No                                              |
| [`consumeTextArtifact`](#consumetextartifact)       | Yes           | Yes; result remains opaque | No                                              |
| [`continuationArtifacts`](#continuationartifacts)   | Yes           | Yes; entries remain opaque | No                                              |
| [`now`](#now)                                       | Yes           | Yes                        | No                                              |
| [`random`](#random)                                 | Yes           | Yes                        | No                                              |
| [`runWorkspaceDir`](#runworkspacedir)               | Always throws | No                         | No                                              |

Entries describe ordinary runtime behavior; a custom host that omits a required artifact store, resource loader, workspace manager, child runner, or operator callback fails with a named “not configured” error. Static checking proves source shape, not semantic correctness or successful execution.

## Agent calls

### agent

**Signature:** `agent(prompt: string, options?) -> Promise<string>`; the `choice` overload narrows the result to one exact declared member. Run a clean child by default, or select a catalog persona with `agent`. Prompt must be nonblank task text; no implicit answer length limit exists. Ordinary success returns the exact non-empty final answer. Execution failures throw `WorkflowAgentExecutionError`; invalid declarations fail before a child starts.

| Result mode / options                    | Result and defaults                                                                                  | Availability and important constraints                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Omit result options                      | Exact final text, `Promise<string>`                                                                  | All three modes; no parsing or truncation                                               |
| `choice: ["accept", "revise"]`           | One exact member; a TypeScript readonly tuple infers its member union, dynamic lists return `string` | All three; at least two unique nonblank strings; no option-count or text-length ceiling |
| `choiceFallback: "revise"` with `choice` | Declared member after the one same-session correction is exhausted                                   | Must belong to `choice`; never substitutes for transport or host failure                |
| `result: "report"`                       | Opaque host-rendered observation, `Promise<string>`                                                  | All three; accepted answer or eligible terminal failure, not semantic approval          |

A choice call uses `workflow_return` inside the same child session with one package-owned correction turn; exhaustion throws `SchemaValidationError` unless `choiceFallback` applies. A transport without the return-tool capability fails closed. `handoffs`, `schema`, `validate`, `output`, `repair` and `returnVia` were removed and are refused by name before any child starts; richer results live in named workspace files, and caller-owned work units come from [`items()`](#items). See [agent results](agent-results.md#removed-shaped-result-options).

**Example — orchestration-only:** a complete module; every agent edge has a distinct literal label. Caller-supplied items go unchanged to each worker, reports stay opaque, and only the exact choice controls the branch.

<!-- dsl-example: orchestration-only -->

```js
export const meta = { name: "review-units", profile: "standard" };
export default async function run({ agent, items, parallel, publishPrimaryArtifact }, input) {
  const units = items();
  const reports = await parallel(units.map((unit) => () => agent(unit, { label: "review-unit", result: "report" })));
  const decision = await agent(`Choose the next action from these reports:\n${reports.join("\n\n")}`, {
    label: "decide",
    choice: ["accept", "revise"],
    choiceFallback: "revise",
  });
  if (decision === "revise") {
    return agent(`Explain the required corrections:\n${reports.join("\n\n")}`, { label: "corrections" });
  }
  const summary = await agent(`Write the final review:\n${reports.join("\n\n")}`, { label: "summarize" });
  publishPrimaryArtifact("review.md", summary);
  return summary;
}
```

**Example — removed schema, rejected by both source-check modes and by the runtime:** the profile is deliberately present to demonstrate the refusal; do not copy this declaration.

<!-- dsl-example: rejected-schema -->

```js expect-error
export const meta = { name: "schema-compatibility", profile: "standard" };
export default async function run({ agent }, input) {
  return agent(input, { label: "classify", schema: { type: "boolean" } });
}
```

## Agent options

Output fields and their combinations are covered above. Additional call options:

| Field                                   | Default                                            | Meaning / refusal                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent: string`                         | Clean child                                        | Catalog persona; [catalog lookup](catalog.md)                                                                                                                                                    |
| `model: string`                         | Effective configured model, otherwise parent model | Concrete `provider/id` selector with optional `:off\|minimal\|low\|medium\|high\|xhigh`; unresolved selector fails before dispatch                                                               |
| `modelRole: string`                     | Effective configured model, otherwise parent model | Portable tier name; unassigned role falls back with recorded evidence; assigned malformed selector fails; [model precedence](models.md)                                                          |
| `requireModelRole: true`                | Off                                                | Requires explicit `modelRole`, refuses missing assignment, cannot combine with `model`; replay may reuse recorded evidence                                                                       |
| `label: string`, `title: string`        | Unset                                              | Literal label identifies callsite; title is display only and may use author-owned records. Orchestration-only requires unique nonblank literal labels                                            |
| `artifact: string`                      | Safe derived label/agent name                      | Logical automatic-answer artifact name; nonempty display label, no path separators/control characters                                                                                            |
| `phase: string`                         | Current phase                                      | Override the call's journal/UI phase                                                                                                                                                             |
| `ask: true`                             | Off                                                | Inject live `workflow_ask` only for this child; interactive parents only; unavailable/no-operator hosts fail closed; [live questions](running.md#live-operator-questions--agent-ask-true)        |
| `timeoutMs`, `maxTurns`, `maxToolCalls` | Unbounded unless run supplied a default            | Positive safe integer per-child-attempt limits: wall clock (including operator waits), SDK model cycles, tool starts. Expiry aborts rather than returning partial success; [budgets](budgets.md) |
| `attempts: number`                      | 1                                                  | Positive safe integer physical transport attempts; only named retryable transport failures retry, never a weak answer. Values above 1 are refused for worktree modes or workspace handles        |
| `workspaceMode`                         | `"project"`                                        | `"project"`, `"worktree"`, or `"temporary-worktree"`; isolation for file review, not security                                                                                                    |
| `workspaceHandle: string`               | Unset                                              | Opaque retained worktree handle from `workspace()`; reuse across stages                                                                                                                          |
| `readOnly`, `tools`, `permissionMode`   | Ignored compatibility fields                       | Children inherit parent permissions and receive all tools; these cannot restrict them                                                                                                            |
| `sandbox`                               | Unset                                              | Deprecated workspace alias: `"read-only"` → project, `"workspace-write"` → worktree; explicit `workspaceMode` wins; no security boundary                                                         |

### fusion

**Signature:** `fusion(question: string, options) -> Promise<string>`; `schema` and `validate` were removed and are refused by name before any leg starts. **Runtime only:** neither checker permits `fusion`. Ask at least two isolated members, then a separately selected judge; return the judge's exact text. Required `mode` is `"tool-free"` or `"agent"`; required `members` and `judge` each select exactly one `model` or `modelRole`, optionally a catalog `agent`. Member labels and selectors must be unique, and the judge cannot repeat a member selector. Invalid declarations, unresolvable selectors, failed member legs, unavailable capability readback, or insufficient run budget fail before a judge result.

`strategy` defaults to `"replicate"`; `"roles"` requires a nonblank `lens` per member. `context` defaults to `{ mode: "prompt-only" }`; `{ mode: "provided", text }` passes explicit nonblank context. Optional `output` is an instruction for the judge only, defaulting to a direct answer in the question's format. `memberLimits` and `judgeLimits` accept `timeoutMs`, `maxTurns`, and `attempts` (1 by default), not answer length caps. Judge label defaults to `"judge"`. See [Fusion](fusion.md) for complete isolation and evidence behavior.

**Example — runtime API, rejected by both source-check modes:** configure these three role names in the host before executing; this profile intentionally demonstrates the checker boundary.

<!-- dsl-example: rejected-fusion -->

```js expect-error
export const meta = { name: "panel-compatibility", profile: "standard" };
export default async function run({ fusion }, input) {
  return fusion(input, {
    mode: "tool-free",
    members: [
      { label: "first", modelRole: "first" },
      { label: "second", modelRole: "second" },
    ],
    judge: { modelRole: "judge" },
  });
}
```

## Control flow and input

### items

**Signature:** `items() -> readonly string[]`. Return an immutable snapshot of exact caller-provided text work units; absent items become `[]`. No parsing, splitting, or default work discovery. Invalid items are rejected by the launch boundary. **Example:** `const units = items();` then `await parallel(units.map((unit) => () => agent(unit, { label: "worker" })))`. See [input and host continuation](authoring.md#workflow-input-and-host-continuation).

### parallel

**Signature:** `parallel<T>(thunks: Array<() => Promise<T>>, options?: { concurrency?, keys?, title? }) -> Promise<T[]>`. Run independent branches behind a full barrier; successful results retain input order. Local concurrency defaults to the run's concurrency and still shares its global child limit. `keys` optionally assigns a complete ordered set of unique nonblank business identities; `title` is display text. Invalid options fail before branches start. Ordinary failed branches let successful siblings finish, then throw `WorkflowGroupFailureError` with ordered slots, failures, and partial results; run-level abort/deadline failures can stop the group. **Example:** `await parallel([() => agent("Review code", { label: "code" }), () => agent("Review tests", { label: "tests" })], { concurrency: 2 })`. See [group details](#existing-parallel-with-explicit-options) and [outcomes](outcomes.md).

### pipeline

**Signature:** `pipeline<T>(items: readonly T[], ...stages: Array<(item, index) => Promise<unknown>>) -> Promise<unknown[]>`. Each item's result feeds its next fixed stage; different items can progress concurrently. The callback index is `itemIndex * stages.length + stageIndex`, not just the item index. Returns final values in input order. With no stages, values pass through; empty input returns `[]`. A failed item skips its later stages while other items finish, then throws `WorkflowGroupFailureError`; run-level failures still propagate. **Example:** `await pipeline(items(), (unit) => agent(unit, { label: "draft" }), (draft) => agent(draft, { label: "review" }))`.

### workflow

**Signature:** `workflow<T>(subFn: (dsl, input?: string) => Promise<T>, input?: string) -> Promise<T>`. Invoke an inline nested function with the same DSL and return its result; omitted nested input is `undefined`, not automatically the root input. Journals enter/exit but creates no saved child run, independent checkpoint, or new budget. Invalid non-text input and callback errors propagate. **Example:** `await workflow(async ({ agent }, request) => agent(request, { label: "nested-review" }), input)`. Keep the callback inline for standard source.

### invokeWorkflow

**Signature:** `invokeWorkflow({ child | name | scriptPath | packageName, input?, items?, key, keys }) -> Promise<{ status: "completed" | "skipped", key, workspaceDir, outputDir, runId?, sourceRunId?, primaryFile? }>`. Exactly one target selector is required. `child` binds a sibling to the current root source; `name` uses saved-name precedence; `scriptPath` is project-relative; `packageName` requires the exact Package source. `input` is optional semantic text; `items` carries exact work units. `key` identifies this unit and `keys` is the complete frozen unique set. Children inherit both root locations; `workspaceDir` and `outputDir` fields are rejected. Completion returns a child run ID; a matching checkpoint returns `skipped` with `sourceRunId`.

**Example:** `await invokeWorkflow({ child: "review", input, key: "review", keys: ["review"] })`. Do not invent a location or derive resumable keys from fresh model output. Missing selectors, invalid keys, directory overrides, grandchildren, and source cycles fail closed. [Saved-child details](#workspace-and-saved-child-contract) explain checkpointing and shared execution.

### phase

**Signature:** `phase(name: string) -> void`. Set the current branch's progress phase and append a journal line. A grouped sibling cannot overwrite another branch or root phase. If nonempty `meta.phases` is declared, literal calls must use those exact unique titles; mismatch is a source-check error. **Example:** `phase("Review");`. See [phase declarations](authoring.md#declared-phases--metaphases).

### log

**Signature:** `log(message: string) -> void`. Append a script-owned journal message tagged with the current phase. No return value or text transformation. Host event callbacks cannot throw into this method. **Example:** `log("Review started");`. [Inspection](inspection.md) shows the journal and live progress surfaces.

## Artifacts and operator handoff

### publishArtifact

**Signature:** `publishArtifact(name: string, text: string) -> WorkflowArtifactRef`. Persist exact workflow-authored text as supporting evidence and project readable output into `outputs/`. Reference has `{ runId, artifactId, name, sha256 }`; name is a display label, not a path, and repeated names are allowed. No implicit text-size limit. Unsafe names, changed artifact indexes, path escapes, or storage errors fail closed. **Example:** `const ref = publishArtifact("review.md", review);`. See [artifact identity and publication](evidence.md#publish-and-consume-artifacts).

### publishPrimaryArtifact

**Signatures:** `publishPrimaryArtifact(name: string, text: string, stage?: string) -> WorkflowArtifactRef`; compatibility form `publishPrimaryArtifact(name, { workflowSource: relativePath }, stage?) -> WorkflowArtifactRef`. Publish the run's one primary semantic document. Optional stage defaults to current phase. A second primary-artifact declaration fails. Names and returned reference match `publishArtifact`. **Example:** `publishPrimaryArtifact("decision.md", decision);`.

The compatibility file form reads a confined UTF-8 workspace file up to 512 KiB, checks Node syntax and orchestration-only shape, then retains those exact bytes. Both source-check modes admit this overload; the create skill's authoring policy uses in-memory text instead of workflow-side file reads. Checker acceptance does not enforce that policy or supply the required configured host. Static validation does not prove semantic correctness. `task/plan` currently uses `publishPrimaryFile("workflow.mjs")` after its mechanical/design gates; see [task authoring](../../examples/workflows/task/README.md).

**Example — checked-source publication admitted by both grammars, outside the create skill's in-memory publication policy:**

<!-- dsl-example: checked-source-publication -->

```js
export const meta = { name: "publish-source", profile: "standard" };
export default async function run({ publishPrimaryArtifact }) {
  return publishPrimaryArtifact("workflow.mjs", { workflowSource: "workflow.mjs" });
}
```

### publishPrimaryFile

**Signature:** `publishPrimaryFile(relativePath: string) -> { relativePath, absolutePath, bytes, sha256 }`. Standard compatibility only. Validate one nonempty regular non-symlink file beneath `outputDir()` and return its reference without copying or parsing the content. A second primary-file declaration, missing/empty file, or confinement failure throws. **Example:** `const primary = publishPrimaryFile("report.md");`. Files survive failed runs; the digest is a point-in-time non-atomic observation, not protection against hostile concurrent filesystem replacement.

### consumeTextArtifact

**Signature:** `consumeTextArtifact(ref: WorkflowArtifactRef) -> { ref, text, source }`. The method is admitted by standard compatibility, but its returned object remains opaque there: extracting `prior.text` requires trusted runtime source outside that profile. Verify a full prior-run reference and copy exact text into this run; return the new current-run reference, text, and source target/artifact/terminal provenance. Source run must have `ok: true`. Self-reference, missing index membership, wrong media type/size/digest, or unsafe paths fail closed. References come from verified host/caller evidence, not a guessed filename. See [consumption rules](evidence.md#publish-and-consume-artifacts).

**Example — trusted runtime property access, rejected by both grammars:** the profile deliberately demonstrates refusal; replace the four reference placeholders with one verified prior-run reference before runtime use.

<!-- dsl-example: rejected-consumed-text -->

```js expect-error
export const meta = { name: "consume-text", profile: "standard" };
export default async function run({ consumeTextArtifact, agent }) {
  const sourceRef = { runId: "<run-id>", artifactId: "<artifact-id>", name: "review.md", sha256: "<sha256>" };
  const prior = consumeTextArtifact(sourceRef);
  return agent(prior.text, { label: "continue-review" });
}
```

### continuationArtifacts

**Signature:** `continuationArtifacts() -> readonly { sourceRef, consumedArtifact: { ref, text, source } }[]`. The method is admitted by standard compatibility, but property extraction from its entries requires trusted runtime source outside that profile. Read the immutable artifacts the host already verified and copied before trusted workflow code started; absent continuation returns `[]`. Invalid provenance fails at launch rather than becoming unverified content here. See [host continuation input](authoring.md#workflow-input-and-host-continuation) and [human continuation](recovery-and-continuation.md#human-continuation).

**Example — trusted runtime property access, rejected by both grammars:** the profile deliberately demonstrates refusal.

<!-- dsl-example: rejected-continuation-text -->

```js expect-error
export const meta = { name: "continue-text", profile: "standard" };
export default async function run({ continuationArtifacts, parallel, agent }) {
  return parallel(
    continuationArtifacts().map((entry) => () => agent(entry.consumedArtifact.text, { label: "continue-review" })),
  );
}
```

### awaitOperator

**Signature:** `awaitOperator({ reason: string, operatorHandoff?: { title, questions, continuationArtifactRefs } }) -> void`. Declare an `awaiting_operator` disposition after durable artifacts exist, then return the unchanged handoff payload. The reason must be nonblank and has no length bound. A reason alone explains the stop; it does not create an actionable question. The optional `operatorHandoff` binds a title, at least one uniquely identified text/select question, and published continuation artifact references. It does not suspend JavaScript or change the returned value; cancellation/failure still wins finalization. Unknown fields, invalid reason or handoff, unavailable callback, and no-operator mode fail at the call site. **Example — reason-only stop:** `publishPrimaryArtifact("handoff.md", handoff); awaitOperator({ reason: "Choose the deployment window." }); return handoff;`. For a complete bound question and its next run, see [operator handoff and continuation](recovery-and-continuation.md#human-continuation) and the [compatibility example](../../extensions/workflows/references/examples/human-continuation.workflow.mjs).

## Workspace, resources, and replay values

### workspaceDir

**Signature:** `workspaceDir() -> string`. Standard compatibility only. Return the absolute workflow directory shared by the execution tree. Use it for handoffs and intermediate files. When the root declares `meta.outputDir`, that directory is the single [bound workflow directory](#bound-workflow-directory) and `workspaceDir()` equals `outputDir()`. Otherwise the host selects it through `runName`, `workspaceDir`, or the generated `.locus-pi/workspaces/<run-id>-<workflow>` default. Runtime navigation and checkpoint identity belong to this directory. **Example:** `const handoffDir = workspaceDir();`.

### outputDir

**Signature:** `outputDir() -> string`. Standard compatibility only. Return the absolute final-output directory shared by the execution tree. The root may declare a project-relative literal `meta.outputDir`; `.local/...` is supported, and the declared directory is then also `workspaceDir()`. Without a declaration, output is exactly `<workspaceDir>/outputs`. Children inherit it and may not override it. **Example:** `const finalDir = outputDir();`. [Workspace details](#workspace-and-saved-child-contract) define confinement and ownership.

### projectRoot

**Signature:** `projectRoot() -> string`. Standard compatibility only. Return the absolute launch project root captured by the host, not the current agent worktree. Missing/blank host configuration throws. **Example:** `const root = projectRoot();` then include it as context in an agent prompt; generated orchestration-only source delegates filesystem work through prompts.

### promptFile

**Signature:** `promptFile(path: string, variables?: Record<string, string>) -> Promise<string>`. Standard compatibility only. Render a neighboring `.prompt.md` resource relative to the original workflow source; variables default to `{}` and replace uppercase `{{NAME}}` slots (`[A-Z][A-Z0-9_]*`). Missing/unused variables, empty resources/results, wrong suffix, missing files, escapes, and replay snapshot hash mismatch throw. **Example:** `const prompt = await promptFile("./resources/review.prompt.md", { TASK: input });`. Resource text `Review {{TASK}}.` renders with the exact value; use resources for role charters, never hidden routing. [Authoring](create.md) owns resource guidance.

### workspace

**Signature:** `workspace(label: string, ref: string) -> Promise<string>`. Standard compatibility only. Allocate one retained runtime-owned linked Git worktree at an exact ref; return an opaque handle, not a path. Requires the host workspace manager and valid Git allocation. **Example:** `const handle = await workspace("review", "HEAD");` then `await agent(input, { label: "inspect-tree", workspaceHandle: handle })`. Reusing the handle shares that worktree across calls; worktree isolation is not a security boundary. See [trust](trust.md).

### now

**Signature:** `now() -> number`. Standard compatibility only. Return wall-clock milliseconds like `Date.now()`; record on first execution and replay the recorded value on resume until divergence. Without a replay store, reads the clock directly. **Example:** `const startedAt = now();`. Direct `Date.now()` is runtime JavaScript but unrecorded and prevents replay; neither that global nor this DSL call belongs in orchestration-only source. See [replay](replay.md#resume-and-replay).

### random

**Signature:** `random() -> number`. Standard compatibility only. Return a value in `[0, 1)` like `Math.random()` under the same record/replay contract as `now()`. **Example:** `const sample = random();`. Direct `Math.random()` is unrecorded and prevents replay. Neither method promises deterministic values across fresh runs; replay guarantees apply to the recorded call sequence.

### runWorkspaceDir

**Signature:** `runWorkspaceDir() -> never` (the deprecated interface retains `string`). **Removed:** always throws `WorkflowRunWorkspaceRemovedError` with code `WORKFLOW_RUN_WORKSPACE_REMOVED`; both source-check modes reject it. **Migration:** use `workspaceDir()` for handoffs/intermediate files and `outputDir()` for final files.

**Example — standard compatibility, rejected by orchestration-only:**

<!-- dsl-example: standard -->

```js
export const meta = { name: "workspace-review", profile: "standard", outputDir: ".local/review" };
export default async function run({ agent, workspaceDir }, input) {
  const dir = workspaceDir(); // the bound .local/review directory; outputDir() returns the same path
  return agent(
    `Workflow directory: ${dir}\nReview ${input}. Write the final report to review.md in the workflow directory with one complete write and write no other file.`,
    { label: "review" },
  );
}
```

## Workspace and saved-child contract

### Bound workflow directory

A root that declares `meta.outputDir` runs in exactly one directory. For
`meta.outputDir: ".local/airflow-review"`, `workspaceDir()` and `outputDir()`
both return `<project>/.local/airflow-review`, and the runtime creates no
`.locus-pi/workspaces/...` directory for the run. The path is checked only by
the `meta.outputDir` grammar: project-relative, safe components, not beneath
`.locus-pi` or `.git`. Every child task names this one directory:

```text
workflow directory (handoffs under artifacts/, final files): /abs/project/.local/airflow-review

Relative handoff paths named in this task (for example artifacts/scope/scope.md) resolve against the workflow directory above, never against pwd or project root.
```

Write handoffs for other agents beneath `artifacts/` and final deliverables in
the directory itself. Name the directory in the authored prompt as well, and
give each agent one exact handoff instruction, for example: _You write a
handoff for another agent: replace exactly `artifacts/scope/scope.md` with one
complete write and write no other file._ `artifacts/` is an authoring
convention; the runtime does not create, validate, or clean it.

```text
.local/airflow-review/
  feature-x.md                  final report
  .workflow-runs.md             runtime backlinks to .locus-pi/runs/<run-id>
  artifacts/scope/scope.md      handoffs written by agents
  artifacts/review/secrets.md
```

The directory is stable across runs, so earlier runs' files stay until an
agent replaces them. The runtime never deletes them. When a later agent must
not read a previous run's handoff, the workflow owns that check: for example,
the first agent records the commit it reviewed, every handoff repeats it, and
every consumer refuses a mismatch.

Run evidence, leases, and checkpoints stay under `.locus-pi/`; only the
`.workflow-runs.md` backlink appears in the workflow directory. One workspace
lease fences the directory, so a second run targeting the same directory is
refused while the first is live. Saved-child checkpoints of a bound root belong
to one launch lineage: a fresh launch re-executes every item, while `--resume`
(including a resume of a resume) and a workspace-reusing operator continuation
reuse completed items.

A bound root refuses `workspaceDir` and `runName` before any child starts:

```text
workflow declares meta.outputDir ".local/airflow-review", which is its workflow directory; workspaceDir and runName are not accepted for this workflow
```

A run recorded before this contract, with a separate workspace and declared
output, cannot be resumed after the upgrade; the error names both recorded
paths and asks for a fresh run. Workflows without `meta.outputDir` are
unchanged.

### Unbound workspace

`workspaceDir()` returns the absolute runtime workspace. Fresh runs default to
`.locus-pi/workspaces/<generated-run-name>` under the project root. The
`--run-name <name>` form selects
`.locus-pi/workspaces/<name>`. A legacy-only `.locus-pi/plans/<name>` remains
bound to its original physical identity. The same workspace can be selected through the
programmatic tool's `workspaceDir` or `/workflows run <name|path> --workspace-dir
<path>`. The runtime
preserves a qualified child's complete saved name in the generated workspace
leaf; an invoked child still shares its parent's selected workspace. The
runtime creates its absolute path before the first child and
names it exactly once in every child task. Agent files keep their exact names;
the runtime does not rename, move, or clean them. Each child task also says that
pre-existing workspace files are owned state: the child may replace only its
assigned filename and must preserve runtime-owned state beneath `.locus-pi`,
`style.md`, and sibling handoffs. A lane instruction to write no other artifact
forbids extra writes; it never authorizes cleanup. Confined absolute paths are
accepted. `./path` resolves from the agent working directory. Traversal outside
the project, whitespace tricks, backslashes, out-of-project working directories,
and symlink escapes fail before a child starts.
A task artifacts directory such as `.tasks/<task>/artifacts` is a legal
`--workspace-dir`; running again into the same directory when it already holds
durable workflow state fails closed through
`assertFreshWorkflowOutputNamespace`.

For `post-code-review`, the workspace is also a freshness boundary. Its
generated default is unique. If a caller explicitly selects a workspace, fresh
semantic input cannot reuse prior durable state there. Resume with the original
`runId` to reuse the source workspace. This owner policy lives at
launch/runtime boundaries, not in the workflow JavaScript.

The same owner policy materializes `style.md` inside that workspace: preserve a
regular existing file or create an empty one before the first child. This keeps
request-specific style guidance beside the request id instead of embedding it
in Package prompts or overloading semantic input.

`runWorkspaceDir()` is removed and throws
`WorkflowRunWorkspaceRemovedError`. New run evidence has no `workspace/`
directory. Auto-captured readable material goes to `outputs/`; machine evidence
and transcripts go to `runtime/artifacts/`. See [run evidence](evidence.md).

`publishPrimaryFile(relativePath)` validates a regular, non-symlink, non-empty
file beneath the workflow output directory and exposes absolute/output-relative path, byte count, and
SHA-256 digest. It neither copies nor parses content. The reference is a
point-in-time, non-atomic observation: portable Node cannot make ancestor
replacement and path-based open/rename/unlink one indivisible operation against
a hostile local process. Workflow output files survive failed runs; run-local evidence
remains immutable under the run id.

The workflow workspace is the durable location for handoffs, review evidence,
and explicit resume inputs. Final results and deliverables belong beneath `outputDir()`. Keep disposable environments,
dependency caches, test basetemp, transient renderer output, and staging in
ordinary OS or tool temporary and cache locations. If renderer output is the
final deliverable, write or promote it into the output directory. Promote any
scratch output needed for review or resume before its temporary or cache location
expires. This guidance reduces accidental mixing; an authored prompt that
explicitly requests another placement remains authoritative.

`invokeWorkflow()` accepts exactly one source-bound sibling `child`, saved
`name`, project-relative `scriptPath`, or exact legacy `packageName`, optional
semantic `input` and exact `items`, one safe item `key`, the complete unique
`keys` list. Directory fields are forbidden: the child inherits the root's workspace and output. It starts a real depth-one child with an
independent run directory, source snapshot, journal, result, and parent lineage.
`child` resolves `<running-root>/<child>` inside the exact source and folder of
the running root; it cannot fall through to another namespace owner. `name`
accepts a root or qualified child ref and keeps normal Project → User → Package
precedence. `packageName` resolves
the Package entry first and then requires the child launch to match that exact
canonical path and source hash, so a higher-precedence shadow fails closed rather
than replacing the installed child.
The root and children share cancellation, global concurrency, one physical-call
counter, whatever run deadline the launch declared (none by default), and one
fenced workspace lease plus a separate output lease under `.locus-pi`.
The leases exclude concurrent writers to either physical location and prevent a stale
owner from committing a checkpoint after takeover. Keys are compact stable
identities, not payloads.
Saved children cannot invoke saved grandchildren; direct or source-identity
cycles fail before model work.

Before durable execution, the caller supplies the complete frozen work list and
the runtime validates all keys before the first child. Fresh model discovery
must remain an inline same-run graph without rediscovered saved-child keys, or finish in a separate run before a
human/caller approves and transports the frozen list. Never derive resumable
positional keys from fresh model output. Terminal-success checkpoints are committed atomically
and keyed by parent source hash, child source hash, workflow workspace, and
item key. A retry skips a matching child and reruns missing or source-invalidated
items. Execution is at least once, so assigned files must be replaced
idempotently rather than appended. Checkpoint reads and quarantine first prove
the lexical and physical `workflow-state/<namespace>/checkpoints` ancestor chain;
symlinked or dangling ancestors and leaves fail closed rather than becoming
ordinary absence or mutating an external path. `workflow-state/v1/<namespace>/`
is active runtime state, not a retired run layout. The runtime creates the
namespace while acquiring a workspace lease. A workflow with no saved children
may leave that namespace empty after the temporary lock is released; it remains
the reserved home for later checkpoints on the same physical workspace identity.
The runtime provides no workflow-side ledger,
domain parser, renderer, or recovery engine. As with other portable Node path
operations, a hostile concurrent replacement can still race the proof; this is
a local evidence-integrity limitation, not process isolation.

Project source is read live throughout execution. Each run journals
`policy=live`, the project root, and its run-boundary timestamp. This makes the
consistency policy observable without pretending the repository was snapshotted;
an approved workflow that needs stronger drift behavior must state it explicitly.

## Operator handoff behavior

A declaration does not pause JavaScript. Finalization records `awaiting_operator` only after a successful return; an abort or semantic/infrastructure failure wins. In [no-operator mode](running.md#no-operator-mode----no-operator----operator), the call fails closed at its callsite. A bound question and its published references are distinct from a reason-only stop.

See [operator handoff and continuation](recovery-and-continuation.md#human-continuation) for the declaration and [answering a pending handoff](recovery-and-continuation.md#answer-a-pending-handoff) for interactive questions, declined answers, and reopening earlier runs.

## Fusion execution details

See [Fusion execution details](fusion.md#fusion-execution-details) for isolation, context, preflight, accounting and replay.

## Existing parallel with explicit options

`parallel(thunks, { concurrency?, keys?, title? })` keeps its existing one-argument behavior. Options are closed. Concurrency is a positive safe integer. A group without one is scheduled at the run's own effective concurrency — there is no second, private scheduling width beside it — and an explicit `concurrency` changes this group's local scheduling only. Every physical child must still acquire the shared global leaf gate. A group wrapper reserves no agent slot, so nested groups do not deadlock by holding parent slots while waiting for children.

`keys` must be a full ordered list matching the number of branches, locally unique, nonblank and free of control characters. There is no length ceiling on a key: control characters are refused because a key enters branch identity and the replay key, while length was never an identity property, and an awkwardly long title is a display problem the renderer already solves by clipping what it draws. Validation happens before any member starts. Nested business identity is the complete path; unkeyed nested levels contribute an explicit positional component. Keyed paths participate in replay request identity. Reordered keys do not silently reuse another item's answer. Unkeyed old calls retain their existing canonical shape.

`title` is display text under the same rule: non-blank, no control characters, no length ceiling. A child `agent(..., { label, title })` keeps a literal callsite label and may derive title from author-known records. Titles do not affect replay identity. `parallel` results are in input order, not completion order; files and other effects are not implicitly ordered.

```js
const FIELDS = [
  { key: "id", question: "Exact ID?" },
  { key: "schedule", question: "Exact schedule?" },
];
const answers = await dsl.parallel(
  FIELDS.map((field) => () => dsl.agent(field.question, { label: "field", title: field.key })),
  {
    concurrency: 2,
    keys: FIELDS.map((entry) => entry.key),
    title: "Fields",
  },
);
```

This is the existing `parallel` primitive, not a new `parallel.map`. `pipeline` retains its existing per-item stage semantics. Discovered model values are opaque and cannot be destructured like author-owned records; the standard source checker owns that distinction.

## Queue, phases and inspection

A fresh physical request emits `agent_queued` before gate admission. `agent_start` occurs only after admission/deadline checks, immediately before dispatch to the bridge. Neither event claims the first provider token has arrived. Replayed calls emit replay evidence without pretending they waited for a new child slot. Live rows distinguish queued from working.

`phase()` changes the current async branch's phase inside a group. A sibling cannot overwrite it; root phase remains unchanged. Group journal lines retain parent grouping and supplied titles. The top-level transcript ignores branch-local phase updates rather than displaying whichever sibling last ran.

Physical format attempts, logical calls, semantic refinement rounds and replayed calls are different counters. The refinement recipe publishes `round-N.md` with goal/work/review/decision and emits an explicit round log; structured choice logs expose validated versus fallback. Existing drill-down opens round evidence. No new global supervisor or automatic round is injected into a fixed graph.

See [agent results](agent-results.md) for shaped returns, [outcomes and retries](outcomes.md) for failure propagation, and [budgets](budgets.md) for shared and per-child controls.
