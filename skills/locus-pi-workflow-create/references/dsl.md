---
title: Workflow DSL reference
type: guide
status: active
updated: "2026-10-07T19:05:59Z"
source_commit: "87298468676c"
update_event: "user_request"
context: "changes=S files=3"
description: "Workflow DSL with optional schema-checked parameters for source-owned control flow"
---

<!-- Generated from docs/workflows/dsl.md by npm run build:catalogs; do not edit. -->

# Workflow DSL reference

[Workflow documentation](../../../docs/workflows/index.md) · [Create a workflow](../../../docs/workflows/create.md) · [Run a workflow](../../../docs/workflows/running.md) · [Runnable examples](../../../examples/workflows/README.md)

A workflow receives `dsl` and optional exact text `input`, or an explicitly schema-validated readonly JSON value, in its default async function. Destructure the methods you need; the examples below use that form. `Promise<T>` means await the result. Removed methods retain narrow throwing migration traps; they never resolve user files.

## Typed workflow input

Keep ordinary agent tasks as semantic text passed whole to children. Choose typed
input when workflow JavaScript consumes fixed parameters for routing or iteration,
such as a supported mode, an exact revision or structured records from a programmatic
caller. The schema checks those parameters before work starts. A simple list of
exact text work units already has the separate [`items`](#items) input.

Declare `meta.inputSchema` as a complete literal or one unshadowed top-level literal
`const` using the [existing JSON schema dialect](../../../docs/workflows/agent-results.md#structured-results-v4).
Supply explicit `inputValue` through the tool/direct runner, or terminal `--input-json`
through the command. Input is detached and frozen before callbacks or awaits;
normalization, compilation and validation finish before import, lease or agent work.
Unsupported visible schema declarations refuse early. Opaque legacy metadata is
checked after import and cannot opt into typed entry without static proof.

```js
export const meta = {
  name: "typed-review",
  profile: "dataflow-v1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "ids"],
    properties: { task: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
  },
};
export default async function run({ agent }, input) {
  return await agent(`Task: ${input.task}; ids: ${input.ids.join(",")}`, { label: "review" });
}
```

Tool: `{name:"typed-review",inputValue:{task:"Review",ids:["A","B"]}}`.
Command: `/workflows run typed-review --input-json {"task":"Review","ids":["A","B"]}`.
Missing input, `inputValue:null`, a JSON string and legacy text remain distinct.
Any own `input` field conflicts with `inputValue`, including `input:undefined`.
There is no coercion, default insertion or unknown-property stripping. Typed
input works without a child SDK call on the supported Pi peer floor.

A validated operator continuation preserves the original JSON. Its typed root
may receive `run(dsl,input,context)`, with absent context on ordinary launches
and readonly `{operatorAnswer:string}` after an accepted handoff. Guard optional
context before reading the answer. The answer is ordinary exact plaintext in
private typed authority, separate from the JSON and bounded presentation;
existing question/tool policies still apply. Inline and saved children receive
only explicitly supplied input and do not inherit this context.

## DSL surface (v0)

**Runtime support and authoring permission are different.** Runtime means trusted JavaScript can call the method; standard means `meta.profile: "standard"` passes the compatibility source grammar; orchestration-only is the stricter checker mode used by the create skill. The table describes method admission, not permission to inspect every returned value: standard source still treats host results as opaque. A method's presence in `WorkflowDsl` does not make it legal in generated source. Read [the source contract](../../../docs/workflows/source-shape.md) for grammar, opaque model text, literal call labels, and permitted control flow.

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
| [`publishPrimaryArtifact`](#publishprimaryartifact) | Yes           | Yes, text only             | Yes, in-memory text                             |
| [`awaitOperator`](#awaitoperator)                   | Yes           | Yes                        | Yes; requires operator-capable launch           |
| [`workspaceDir`](#workspacedir)                     | Yes           | Yes                        | No                                              |
| [`outputDir`](#outputdir)                           | Always throws | No                         | No                                              |
| [`projectRoot`](#projectroot)                       | Yes           | Yes                        | No                                              |
| [`promptFile`](#promptfile)                         | Yes           | Yes                        | No                                              |
| [`workspace`](#workspace)                           | Yes           | Yes                        | No                                              |
| [`publishPrimaryFile`](#publishprimaryfile)         | Always throws | No                         | No                                              |
| [`consumeTextArtifact`](#consumetextartifact)       | Yes           | Yes; result remains opaque | No                                              |
| [`continuationArtifacts`](#continuationartifacts)   | Yes           | Yes; entries remain opaque | No                                              |
| [`now`](#now)                                       | Yes           | Yes                        | No                                              |
| [`random`](#random)                                 | Yes           | Yes                        | No                                              |
| [`runWorkspaceDir`](#runworkspacedir)               | Always throws | No                         | No                                              |

The explicit `dataflow-v1` profile/mode uses the orchestration-only method column
and admits checked data transformations and static v4 declarations. It also
requires owned awaiting, checked helper captures and complete source-byte identity
on resume. Read the [dataflow contract and exact examples](../../../docs/workflows/source-shape.md#checked-dataflow-v1).
Omitting the checker mode keeps standard compatibility behavior.

Entries describe ordinary runtime behavior; a custom host that omits a required artifact store, resource loader, workspace manager, child runner, or operator callback fails with a named “not configured” error. Static checking proves source shape, not semantic correctness or successful execution.

## Agent calls

### agent

**Signature:** `agent(prompt: string, options?) -> Promise<string>`; the `choice` overload narrows the result to one exact declared member; `schema` calls return `Promise<WorkflowSchemaResult<Schema>>`, inferred as deeply readonly JSON from literal schemas. Run a clean child by default, or select a catalog persona with `agent`. Prompt must be nonblank task text; no implicit answer length limit exists. Ordinary success returns the exact non-empty final answer. Execution failures throw `WorkflowAgentExecutionError`; invalid declarations fail before a child starts.

| Result mode / options                    | Result and defaults                                                                                                | Availability and important constraints                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Omit result options                      | Exact final text, `Promise<string>`                                                                                | All three modes; no parsing or truncation                                                          |
| `choice: ["accept", "revise"]`           | One exact member; a TypeScript readonly tuple infers its member union, dynamic lists return `string`               | All three; at least two unique nonblank strings; no option-count or text-length ceiling            |
| `choiceFallback: "revise"` with `choice` | Declared member after the one same-session correction is exhausted                                                 | Must belong to `choice`; never substitutes for transport or host failure                           |
| `result: "report"`                       | Opaque host-rendered observation, `Promise<string>`                                                                | All three; accepted answer or eligible terminal failure, not semantic approval                     |
| `schema: literalOrTopLevelConst`         | Immutable finite JSON, v4; initial plus one package-owned correction; literal schemas infer deeply readonly values | Both checkers admit bounded schema-proven uses; Pi >=1.0.0 openai-codex with verified capabilities |

A choice call uses `workflow_return` inside the same child session with one package-owned correction turn; exhaustion throws `SchemaValidationError` unless `choiceFallback` applies. A transport without the return-tool capability fails closed. `handoffs`, `output` and `returnVia` remain removed. Standard compatibility and orchestration-only admit a literal `schema` or one unshadowed top-level literal schema `const` in direct options with distinct explicit properties. They reject options spreads, shorthand and computed keys on structured calls, and still refuse `validate`, `repair` and `outputTransport`. The [structured v4 contract](../../../docs/workflows/agent-results.md#structured-results-v4) preserves the standard return tool carrying the actual schema and Pi strict sampling where conversion preserves its semantics. `validate`, `repair` and `outputTransport` are removed runtime options, refused before work or replay. Use a schema only when source consumes proven fields or arrays; exact caller-assigned files remain useful for richer handoffs, and [`items()`](#items) carries caller-owned units.

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

**Example — literal schema, admitted by both source-check modes:** await a structured boolean before comparing its exact identity. This uses the same v4 tool route as the following record/array examples.

<!-- dsl-example: structured-literal -->

```js
export const meta = { name: "classify-task", profile: "standard" };
export default async ({ agent }, input) => {
  const needsReview = await agent(`Does this task require review?\n${input}`, {
    label: "classify",
    schema: { type: "boolean" },
  });
  if (needsReview === true) return agent(input, { label: "review" });
  return "No review requested";
};
```

**Example — required fields from a top-level schema:** strings forward unchanged, and scalar fields interpolate directly into text sinks. Schema acceptance establishes shape, not the truth of the reviewer's finding.

<!-- dsl-example: structured-record -->

```js
export const meta = { name: "review-record", profile: "standard" };
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["accept", "revise"] },
    summary: { type: "string" },
    count: { type: "integer", minimum: 0 },
  },
  required: ["decision", "summary", "count"],
  additionalProperties: false,
};
export default async function run(dsl, input) {
  const { agent, log, publishPrimaryArtifact } = dsl;
  const review = await agent(`Review this task and return the requested record.\n${input}`, {
    label: "review-record",
    schema: REVIEW_SCHEMA,
  });
  log(`Reported findings: ${review.count}`);
  if (review.decision === "revise") return agent(review.summary, { label: "explain-corrections" });
  return publishPrimaryArtifact("review.md", review.summary);
}
```

**Example — structured array scheduling:** the item schema proves each required `summary`. The resulting worker reports remain opaque. Do not index the array or assume a group result has the same schema.

<!-- dsl-example: structured-array -->

```js
export const meta = { name: "review-findings", profile: "standard" };
const FINDINGS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
};
export default async function run({ agent, parallel, log }, input) {
  const findings = await agent(`Identify findings for independent review.\n${input}`, {
    label: "findings",
    schema: FINDINGS_SCHEMA,
  });
  log(`Findings to review: ${findings.length}`);
  return parallel(findings.map((finding) => () => agent(finding.summary, { label: "review-finding" })));
}
```

An awaited structured result may also be returned whole or kept through an unchanged alias.
Only required named fields are readable; optional guards do not prove presence.
All unchecked indexes, result destructuring, field mutation and arbitrary transformations
remain rejected. Array `items` is optional in the runtime dialect, but an untyped item
stays opaque. Map JSON values synchronously: Promise/function projections are refused,
and `await` on the mapped array does not settle its elements. The example above passes
branch functions directly to `parallel()`, which owns their execution and settlement.
See the [source boundary](../../../docs/workflows/source-shape.md#checked-structured-results).

**Example — removed validation callback, rejected by both source-check modes:** express constraints in the schema or domain decisions in workflow source; the runtime also refuses `validate`.

<!-- dsl-example: rejected-structured-validator -->

```js expect-error
export const meta = { name: "validated-result", profile: "standard" };
export default async function run({ agent }, input) {
  return agent(input, { label: "classify", schema: { type: "boolean" }, validate: () => [] });
}
```

## Agent options

Output fields and their combinations are covered above. Additional call options:

| Field                                   | Default                                            | Meaning / refusal                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent: string`                         | Clean child                                        | Catalog persona; [catalog lookup](../../../docs/workflows/catalog.md)                                                                                                                                                    |
| `model: string`                         | Effective configured model, otherwise parent model | Concrete `provider/id` selector with optional `:off\|minimal\|low\|medium\|high\|xhigh`; unresolved selector fails before dispatch                                                                                       |
| `modelRole: string`                     | Effective configured model, otherwise parent model | Portable tier name; unassigned role falls back with recorded evidence; assigned malformed selector fails; [model precedence](../../../docs/workflows/models.md)                                                          |
| `requireModelRole: true`                | Off                                                | Requires explicit `modelRole`, refuses missing assignment, cannot combine with `model`; replay may reuse recorded evidence                                                                                               |
| `label: string`, `title: string`        | Unset                                              | Literal label identifies callsite; title is display only and may use author-owned records. Orchestration-only requires unique nonblank literal labels                                                                    |
| `artifact: string`                      | Safe derived label/agent name                      | Logical automatic-answer artifact name; nonempty display label, no path separators/control characters                                                                                                                    |
| `phase: string`                         | Current phase                                      | Override the call's journal/UI phase                                                                                                                                                                                     |
| `ask: true`                             | Off                                                | Inject live `workflow_ask` only for this child; interactive parents only; unavailable/no-operator hosts fail closed; [live questions](../../../docs/workflows/running.md#live-operator-questions--agent-ask-true)        |
| `timeoutMs`, `maxTurns`, `maxToolCalls` | Unbounded unless run supplied a default            | Positive safe integer per-child-attempt limits: wall clock (including operator waits), SDK model cycles, tool starts. Expiry aborts rather than returning partial success; [budgets](../../../docs/workflows/budgets.md) |
| `attempts: number`                      | 1                                                  | Positive safe integer physical transport attempts; only named retryable transport failures retry, never a weak answer. Values above 1 are refused for worktree modes or workspace handles                                |
| `workspaceMode`                         | `"project"`                                        | `"project"`, `"worktree"`, or `"temporary-worktree"`; isolation for file review, not security                                                                                                                            |
| `workspaceHandle: string`               | Unset                                              | Opaque retained worktree handle from `workspace()`; reuse across stages                                                                                                                                                  |
| `readOnly`, `tools`, `permissionMode`   | Ignored compatibility fields                       | Children inherit parent permissions and receive all tools; these cannot restrict them                                                                                                                                    |
| `sandbox`                               | Unset                                              | Deprecated workspace alias: `"read-only"` → project, `"workspace-write"` → worktree; explicit `workspaceMode` wins; no security boundary                                                                                 |

### fusion

**Signature:** `fusion(question: string, options) -> Promise<string>`; `schema` and `validate` were removed and are refused by name before any leg starts. **Runtime only:** neither checker permits `fusion`. Ask at least two isolated members, then a separately selected judge; return the judge's exact text. Required `mode` is `"tool-free"` or `"agent"`; required `members` and `judge` each select exactly one `model` or `modelRole`, optionally a catalog `agent`. Member labels and selectors must be unique, and the judge cannot repeat a member selector. Invalid declarations, unresolvable selectors, failed member legs, unavailable capability readback, or insufficient run budget fail before a judge result.

`strategy` defaults to `"replicate"`; `"roles"` requires a nonblank `lens` per member. `context` defaults to `{ mode: "prompt-only" }`; `{ mode: "provided", text }` passes explicit nonblank context. Optional `output` is an instruction for the judge only, defaulting to a direct answer in the question's format. `memberLimits` and `judgeLimits` accept `timeoutMs`, `maxTurns`, and `attempts` (1 by default), not answer length caps. Judge label defaults to `"judge"`. See [Fusion](../../../docs/workflows/fusion.md) for complete isolation and evidence behavior.

**Example — runtime API, rejected by standard and orchestration-only modes:** configure these three role names in the host before executing; this profile intentionally demonstrates the checker boundary.

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

**Signature:** `items() -> readonly string[]`. Return an immutable snapshot of exact caller-provided text work units; absent items become `[]`. No parsing, splitting, or default work discovery. Invalid items are rejected by the launch boundary. **Example:** `const units = items();` then `await parallel(units.map((unit) => () => agent(unit, { label: "worker" })))`. See [input and host continuation](../../../docs/workflows/authoring.md#workflow-input-and-host-continuation).

### parallel

**Signature:** `parallel<T>(thunks: Array<() => Promise<T>>, options?: { concurrency?, keys?, title? }) -> Promise<T[]>`. Run independent branches behind a full barrier; successful results retain input order. Local concurrency defaults to the run's concurrency and still shares its global child limit. `keys` optionally assigns a complete ordered set of unique nonblank business identities; `title` is display text. Invalid options fail before branches start. Ordinary failed branches let successful siblings finish, then throw `WorkflowGroupFailureError` with ordered slots, failures, and partial results; run-level abort/deadline failures can stop the group. **Example:** `await parallel([() => agent("Review code", { label: "code" }), () => agent("Review tests", { label: "tests" })], { concurrency: 2 })`. See [group details](#existing-parallel-with-explicit-options) and [outcomes](../../../docs/workflows/outcomes.md).

### pipeline

**Signature:** `pipeline<T>(items: readonly T[], ...stages: Array<(item, index) => Promise<unknown>>) -> Promise<unknown[]>`. Each item's result feeds its next fixed stage; different items can progress concurrently. The callback index is `itemIndex * stages.length + stageIndex`, not just the item index. Returns final values in input order. With no stages, values pass through; empty input returns `[]`. A failed item skips its later stages while other items finish, then throws `WorkflowGroupFailureError`; run-level failures still propagate. **Example:** `await pipeline(items(), (unit) => agent(unit, { label: "draft" }), (draft) => agent(draft, { label: "review" }))`.

### workflow

**Signature:** `workflow<T>(subFn: (dsl, input?: string) => Promise<T>, input?: string) -> Promise<T>`. Invoke an inline nested function with the same DSL and return its result; omitted nested input is `undefined`, not automatically the root input. Journals enter/exit but creates no saved child run, independent checkpoint, or new budget. The typed overload `workflow(fn,{inputValue,inputSchema})` validates a closed two-field descriptor before calling `fn` with frozen JSON. Other invalid input and callback errors propagate. **Example:** `await workflow(async ({ agent }, request) => agent(request, { label: "nested-review" }), input)`. Keep the callback inline for standard source.

### invokeWorkflow

**Signature:** `invokeWorkflow({ child | name | scriptPath | packageName, input?, inputValue?, items?, key, keys }) -> Promise<{ status: "completed" | "skipped", key, workspaceDir, runId?, sourceRunId? }>`. Exactly one target selector is required. `child` binds a sibling to the current root source; `name` uses saved-name precedence; `scriptPath` is project-relative; `packageName` requires the exact Package source. `input` is optional semantic text; explicit `inputValue` requires the child’s own static schema and is validated before checkpoint reuse. `items` carries exact work units. `key` identifies this unit and `keys` is the complete frozen unique set. Children inherit the root native workspace; location overrides are rejected. Pass exact agent-file destinations in the same whole input. Completion returns a child run ID; a matching checkpoint returns `skipped` with `sourceRunId`.

**Example:** `await invokeWorkflow({ child: "review", input, key: "review", keys: ["review"] })`. Do not invent a location or derive resumable keys from fresh model output. Missing selectors, invalid keys, directory overrides, grandchildren, and source cycles fail closed. [Saved-child details](#workspace-and-saved-child-contract) explain checkpointing and shared execution.

### phase

**Signature:** `phase(name: string) -> void`. Set the current branch's progress phase and append a journal line. A grouped sibling cannot overwrite another branch or root phase. If nonempty `meta.phases` is declared, literal calls must use those exact unique titles; mismatch is a source-check error. **Example:** `phase("Review");`. See [phase declarations](../../../docs/workflows/authoring.md#declared-phases--metaphases).

### log

**Signature:** `log(message: string) -> void`. Append a script-owned journal message tagged with the current phase. No return value or text transformation. Host event callbacks cannot throw into this method. **Example:** `log("Review started");`. [Inspection](../../../docs/workflows/inspection.md) shows the journal and live progress surfaces.

## Artifacts and operator handoff

### publishArtifact

**Signature:** `publishArtifact(name: string, text: string) -> WorkflowArtifactRef`. Persist exact workflow-authored text as supporting evidence and project readable output into `outputs/`. Reference has `{ runId, artifactId, name, sha256 }`; name is a display label, not a path, and repeated names are allowed. No implicit text-size limit. Unsafe names, changed artifact indexes, path escapes, or storage errors fail closed. **Example:** `const ref = publishArtifact("review.md", review);`. See [artifact identity and publication](../../../docs/workflows/evidence.md#publish-and-consume-artifacts).

### publishPrimaryArtifact

**Signature:** `publishPrimaryArtifact(name: string, text: string, stage?: string) -> WorkflowArtifactRef`. Declare the run's one native text document. Optional stage defaults to the current phase; a second declaration fails. Names and references match `publishArtifact`. **Example:** `publishPrimaryArtifact("decision.md", decision)`.

Both text methods retain optional native evidence and support verified text continuation. They neither save an agent-owned file nor attest its existence. A requested report, intermediate handoff or generated source is written by its assigned agent through ordinary file tools at the exact destination in the prompt. The next consumer opens that same file.

The former `{ workflowSource: relativePath }` overload is removed. All source-check modes reject it; runtime use fails with migration guidance. Do not reconstruct source from an answer or copy an old runtime projection as a substitute.

**Example — removed source-file publication, rejected by both grammars:**

<!-- dsl-example: rejected-source-publication -->

```js expect-error
export const meta = { name: "removed-source-publication", profile: "standard" };
export default function run({ publishPrimaryArtifact }) {
  return publishPrimaryArtifact("workflow.mjs", { workflowSource: "workflow.mjs" });
}
```

### publishPrimaryFile

**Signature:** `publishPrimaryFile(path: string) -> never`. **Removed:** a narrow trap always throws. All source-check modes reject direct and destructured use. **Migration example:** prompt the writer with `Write /project/reports/review.md`, then have the reader open that exact file. Assign the exact destination in the writer's prompt; the reader verifies the file before using it. Native completion is not a generic file-existence, size or digest guarantee.

### consumeTextArtifact

**Signature:** `consumeTextArtifact(ref: WorkflowArtifactRef) -> { ref, text, source }`. The method is admitted by standard compatibility, but its returned object remains opaque there: extracting `prior.text` requires trusted runtime source outside that profile. Verify a full prior-run reference and copy exact text into this run; return the new current-run reference, text, and source target/artifact/terminal provenance. Source run must have `ok: true`. Self-reference, missing index membership, wrong media type/size/digest, or unsafe paths fail closed. References come from verified host/caller evidence, not a guessed filename. See [consumption rules](../../../docs/workflows/evidence.md#publish-and-consume-artifacts).

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

**Signature:** `continuationArtifacts() -> readonly { sourceRef, consumedArtifact: { ref, text, source } }[]`. The method is admitted by standard compatibility, but property extraction from its entries requires trusted runtime source outside that profile. Read the immutable artifacts the host already verified and copied before trusted workflow code started; absent continuation returns `[]`. Invalid provenance fails at launch rather than becoming unverified content here. See [host continuation input](../../../docs/workflows/authoring.md#workflow-input-and-host-continuation) and [human continuation](../../../docs/workflows/recovery-and-continuation.md#human-continuation).

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

**Signature:** `awaitOperator({ reason: string, operatorHandoff?: { title, questions, continuationArtifactRefs } }) -> void`. Declare an `awaiting_operator` disposition after durable artifacts exist, then return the unchanged handoff payload. The reason must be nonblank and has no length bound. A reason alone explains the stop; it does not create an actionable question. The optional `operatorHandoff` binds a title, at least one uniquely identified text/select question, and published continuation artifact references. It does not suspend JavaScript or change the returned value; cancellation/failure still wins finalization. Unknown fields, invalid reason or handoff, unavailable callback, and no-operator mode fail at the call site. **Example — reason-only stop:** `publishPrimaryArtifact("handoff.md", handoff); awaitOperator({ reason: "Choose the deployment window." }); return handoff;`. For a complete bound question and its next run, see [operator handoff and continuation](../../../docs/workflows/recovery-and-continuation.md#human-continuation) and the [compatibility example](../../../extensions/workflows/references/examples/human-continuation.workflow.mjs).

## Workspace, resources, and replay values

### workspaceDir

**Signature:** `workspaceDir() -> string`. Standard compatibility only. Return the execution tree's absolute native runtime workspace, selected by `runName`, `workspaceDir` or the generated `.locus-pi/workspaces/<generated-run-name>` default. Navigation, runtime leases and saved-child checkpoint identity belong here. This method supplies no placement authority for agent-written files; standard-generated source passes exact destinations through prompts instead. **Example:** `const nativeState = workspaceDir();`.

### outputDir

**Signature:** `outputDir() -> never`. **Removed:** a narrow trap always throws. All source-check modes reject direct and destructured use, and root/child `meta.outputDir` is refused before agent work. Literal metadata is checked before import; dynamically materialized trusted metadata is rejected on module load before its entry runs. **Migration example:** `Write /project/reports/result.md` in the agent prompt. Placement never changes cwd, tool resolution, loaded context or worktree selection.

### projectRoot

**Signature:** `projectRoot() -> string`. Standard compatibility only. Return the absolute launch project root captured by the host, not the current agent worktree. Missing/blank host configuration throws. **Example:** `const root = projectRoot();` then include it as context in an agent prompt; generated orchestration-only source delegates filesystem work through prompts.

### promptFile

**Signature:** `promptFile(path: string, variables?: Record<string, string>) -> Promise<string>`. Standard compatibility only. Render a neighboring `.prompt.md` resource relative to the original workflow source; variables default to `{}` and replace uppercase `{{NAME}}` slots (`[A-Z][A-Z0-9_]*`). Missing/unused variables, empty resources/results, wrong suffix, missing files, escapes, and replay snapshot hash mismatch throw. **Example:** `const prompt = await promptFile("./resources/review.prompt.md", { TASK: input });`. Resource text `Review {{TASK}}.` renders with the exact value; use resources for role charters, never hidden routing. [Authoring](../../../docs/workflows/create.md) owns resource guidance.

### workspace

**Signature:** `workspace(label: string, ref: string) -> Promise<string>`. Standard compatibility only. Allocate one retained runtime-owned linked Git worktree at an exact ref; return an opaque handle, not a path. Requires the host workspace manager and valid Git allocation. **Example:** `const handle = await workspace("review", "HEAD");` then `await agent(input, { label: "inspect-tree", workspaceHandle: handle })`. Reusing the handle shares that worktree across calls; worktree isolation is not a security boundary. See [trust](../../../docs/workflows/trust.md).

### now

**Signature:** `now() -> number`. Standard compatibility only. Return wall-clock milliseconds like `Date.now()`; record on first execution and replay the recorded value on resume until divergence. Without a replay store, reads the clock directly. **Example:** `const startedAt = now();`. Direct `Date.now()` is runtime JavaScript but unrecorded and prevents replay; neither that global nor this DSL call belongs in orchestration-only source. See [replay](../../../docs/workflows/replay.md#resume-and-replay).

### random

**Signature:** `random() -> number`. Standard compatibility only. Return a value in `[0, 1)` like `Math.random()` under the same record/replay contract as `now()`. **Example:** `const sample = random();`. Direct `Math.random()` is unrecorded and prevents replay. Neither method promises deterministic values across fresh runs; replay guarantees apply to the recorded call sequence.

### runWorkspaceDir

**Signature:** `runWorkspaceDir() -> never` (the deprecated interface retains `string`). **Removed:** always throws `WorkflowRunWorkspaceRemovedError` with code `WORKFLOW_RUN_WORKSPACE_REMOVED`; both source-check modes reject it. **Migration:** put exact intermediate and final file destinations in agent prompts. Native workspace coordination remains separate.

**Example — standard compatibility, rejected by orchestration-only:**

## Workspace and saved-child contract

<!-- dsl-example: standard -->

```js
export const meta = { name: "native-workspace-context", profile: "standard" };
export default async function run({ agent, workspaceDir }, input) {
  const nativeState = workspaceDir();
  return agent(
    `Inspect native runtime coordination read-only; this path is not a user-file destination. Native workspace: ${nativeState}\nWhole caller input:\n${input}`,
    { label: "inspect-native-state" },
  );
}
```

### Explicit agent files and native workspace

Agents execute in their launch-selected inherited cwd or chosen worktree. The host labels the actual cwd separately from project root. File destinations do not rebase relative paths or change execution. Prefer absolute paths in prompts; every writer, reviewer, checker and downstream reader receives the same whole semantic input and exact destination. Source does not parse paths from opaque input.

The caller assigns exact shared handoff and Task-required output paths; agents create them with ordinary write/bash tools. Implementation actors may choose internal files within delegated product roots, subject to narrower Task boundaries and read-only reviewer roles. Do not use a native workspace as an implicit base, search fallback folders, reconstruct files from final prose or declare an output setting. Parallel writers receive distinct files and finish before the reader barrier. Roots sharing fixed domain files must be serialized by their operator; runtime leases do not lock arbitrary prompt destinations.

The runtime workspace stays project-confined and owns native coordination, navigation and checkpoints. Fresh launches default to `.locus-pi/workspaces/<generated-run-name>`; `--run-name` selects a stable name and `--workspace-dir` an explicit confined native workspace. A legacy-only `.locus-pi/plans/<name>` stays at its physical identity, while ambiguous dual roots fail before work. The runtime never moves or deletes user files. Preserve native state and sibling-owned files; a single-report assignment never authorizes cleanup.

`post-code-review` receives exact report destinations and an optional exact caller-owned criteria-file path in its whole input. No runtime criteria file is created or discovered. Omission or an empty regular criteria file means no additional criteria. A nonempty supplied file is read-only guidance and cannot widen scope or override the workflow. A named missing, unreadable, nonregular or leaf-symlink file causes explicit non-success with that path, without fallback, substitution or link-target mutation.

Native completed/resultPersisted evidence describes orchestration, not user-file effects. A file consumer independently opens the assigned regular nonempty file, verifies current required checks and, where reviewed identity is claimed, compares persisted checked/reviewed-byte SHA-256 evidence. Recheck after correction, replay/skip and immediately before generated-source execution. Missing, drifted or invalid files, failed review and exhaustion prohibit execution even when some source remains on disk.

Replay reuses answers but never restores filesystem effects. New-format roots get distinct launch lineages; same-lineage resume preserves matching recorded calls. Old output-bound/default-output execution bindings remain inspectable but cannot resume, recover or reuse checkpoints under the new contract; start a fresh migrated run. Historical output and primary-file fields are read-only evidence. Verified historical text may be consumed into a fresh continuation through the existing provenance checks without importing old placement identity.

`invokeWorkflow()` accepts exactly one source-bound sibling `child`, saved
`name`, project-relative `scriptPath`, or exact legacy `packageName`, optional
semantic `input` or explicit schema-validated `inputValue`, and exact `items`, one safe item `key`, the complete unique
`keys` list. Directory fields are forbidden: the child inherits the root's native workspace, while agent files use explicit prompt destinations. It starts a real depth-one child with an
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
fenced native workspace lease under `.locus-pi`.
The lease excludes concurrent owners of native state and prevent a stale
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

A declaration does not pause JavaScript. Finalization records `awaiting_operator` only after a successful return; an abort or semantic/infrastructure failure wins. In [no-operator mode](../../../docs/workflows/running.md#no-operator-mode----no-operator----operator), the call fails closed at its callsite. A bound question and its published references are distinct from a reason-only stop.

See [operator handoff and continuation](../../../docs/workflows/recovery-and-continuation.md#human-continuation) for the declaration and [answering a pending handoff](../../../docs/workflows/recovery-and-continuation.md#answer-a-pending-handoff) for interactive questions, declined answers, and reopening earlier runs.

## Fusion execution details

See [Fusion execution details](../../../docs/workflows/fusion.md#fusion-execution-details) for isolation, context, preflight, accounting and replay.

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

This is the existing `parallel` primitive, not a new `parallel.map`. `pipeline` retains its existing per-item stage semantics. Plain model text and unproven composites are opaque and cannot be destructured like author-owned records. Structured results permit only their schema-proven operations and also cannot be destructured; the standard source checker owns that distinction.

## Queue, phases and inspection

A fresh physical request emits `agent_queued` before gate admission. `agent_start` occurs only after admission/deadline checks, immediately before dispatch to the bridge. Neither event claims the first provider token has arrived. Replayed calls emit replay evidence without pretending they waited for a new child slot. Live rows distinguish queued from working.

`phase()` changes the current async branch's phase inside a group. A sibling cannot overwrite it; root phase remains unchanged. Group journal lines retain parent grouping and supplied titles. The top-level transcript ignores branch-local phase updates rather than displaying whichever sibling last ran.

Physical format attempts, logical calls, semantic refinement rounds and replayed calls are different counters. The refinement recipe publishes `round-N.md` with goal/work/review/decision and emits an explicit round log; structured choice logs expose validated versus fallback. Existing drill-down opens round evidence. No new global supervisor or automatic round is injected into a fixed graph.

See [agent results](../../../docs/workflows/agent-results.md) for shaped returns, [outcomes and retries](../../../docs/workflows/outcomes.md) for failure propagation, and [budgets](../../../docs/workflows/budgets.md) for shared and per-child controls.
