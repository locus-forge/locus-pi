---
title: Workflow DSL and saved children
type: guide
status: active
updated: "2026-09-13T00:12:23Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow DSL and saved children

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## DSL surface (v0)

```ts
items()                      // Exact caller-provided text units; see workflow input
agent(prompt, opts?)          // Run a catalog/local agent; returns exact child text
agent(prompt, {choice, …})    // Standard machine route; returns one declared exact string
agent(prompt, {handoffs, …})  // Standard dynamic decomposition; returns bounded text units
agent(prompt, {schema, …})    // Advanced compatibility; returns the validated shaped value
fusion(question, options)     // Required homogeneous mode + 2+ isolated answers -> separate judge
fusion(question, {schema, …}) // Same panel; validates only the judge's final answer
publishArtifact(name, text)   // Persist workflow-authored text; return full digest-bound reference
publishPrimaryArtifact(name, text) // Publish the run's one primary semantic document
outputDir()                   // Project-relative workflow workspace selected by the host
invokeWorkflow(declaration)   // Run one saved child level with durable item checkpointing
publishPrimaryFile(path)      // Validate/reference one non-empty workflow workspace file
consumeTextArtifact(ref)      // Verify/copy prior-run text; return current ref + exact text
awaitOperator({reason})       // Declare a successful operator handoff without changing result
promptFile(path, variables?)  // Render a neighboring .prompt.md resource
workspace(label, ref)         // Allocate one retained workspace; returns opaque handle
projectRoot()                 // Absolute launch project root
parallel(thunks)              // Full barrier; success returns ordered T[], ordinary failed branches reject typed evidence
pipeline(items, ...stages)    // Per-item staged chains; a failed item stops before its later stages, then typed reject
phase(name)                   // Progress grouping + journal line
log(msg)                      // Journal line
now()                         // Recorded wall clock (ms); replayed on --resume
random()                      // Recorded randomness in [0,1); replayed on --resume
```

`task/plan` performs its mechanical and design gates, then calls
`publishPrimaryFile("workflow.mjs")`. The host validates the confined regular,
non-symlink, non-empty workspace file and returns `primaryFile` with its relative
path, absolute path, byte count, and SHA-256 digest. It neither copies the file into
run `outputs/` nor parses it at publication time; the validated workspace path is
the create-to-run handoff. See the [task authoring contract](../../extensions/workflows/examples/task/README.md).

`publishPrimaryArtifact(name, { workflowSource: "workflow.mjs" })` remains the
compatibility checked-source artifact form. It reads a confined UTF-8 workspace
file up to 512 KiB, checks Node syntax and orchestration-only shape, and retains
those exact bytes through the artifact store. That API returns an artifact
reference and output path; it is not the current `task/plan` publication path.
Static validation does not prove semantic correctness or successful execution.

`fusion()` requires `mode: "tool-free" | "agent"`; every member and the judge
use that same mode. Each selector still requires `model` or `modelRole` and may
also name an existing catalog `agent`. Tool-free legs retain the selected
catalog persona and ordinary execution metadata, but the package supplies their
complete system prompt, disables extension, skill, prompt-template, theme, and
context-file discovery, and starts them with no active tools. The host reads the
active tool registry before the first prompt and fails the leg without prompting
if that readback is missing or non-empty. Agent-mode legs keep the existing
catalog-agent tool and parent-permission behavior. Ordinary `agent()` calls are
unchanged.

Fusion defaults to prompt-only context and never reads ambient chat history.
Explicit `context: { mode: "provided", text }` is copied verbatim into the
Fusion packet artifact. When reconnaissance is needed, run it as an ordinary
visible `agent()` or child-workflow stage and pass its bounded text through this
explicit context field; Fusion does not discover it automatically. No character
cap applies to a member answer, to the judge answer, or to the assembled judge
prompt: a panel returns what its members wrote. A panel declares at least two
members. All declared members are required; a member failure stops before the
judge runs. The production runner resolves
all declared model selectors before the first child, and overlapping Fusion
calls reserve their complete worst-case invocation counts atomically. A resume
tries recorded answers without requiring the old models to remain configured;
Fusion fails before any fresh child if one of its recorded legs is missing or
divergent. The mode is part of the replay key. Replayed legs retain the declared
mode but do not claim a fresh host active-tool readback. Fresh results persist
the declared mode and exact host readback in per-call evidence, the workflow
journal, and the readable run report. Run without `--resume` to execute a new
panel.

`awaitOperator()` accepts exactly one non-empty reason, of any length. It is a
control declaration, not model output and not a thrown
pause. Call it only after durable handoff artifacts exist, immediately before
returning the unchanged handoff payload. An abort or semantic/infrastructure
failure still wins at finalization. Under the run-level no-operator mode
(`--no-operator`, the tool's `noOperator`) the call does not declare anything:
it fails the run closed at the call site with a named reason — see
"No-operator mode" in the run section.

If the operator answers the question, the workflow's continuation run receives
their answer text. If they press Escape, it receives a plain-text refusal
instead — the same questions, each with whatever was answered before the
refusal, under the line `The operator declined to answer this workflow's
questions.` — delivered through the same channel and the same continuation. It
is not a status and the runtime attaches no handling contract to it: what a
declined question means is the workflow author's decision, exactly as it would
be for any other answer text.

A question opens on its own only for a run the current Pi session started, or a
continuation that run spawned. Nothing an earlier session left unanswered
interrupts a new one — not at session start and not on its first settled turn.
Those questions stay in their run's evidence and reopen on request: the
`/workflows` menu's `continue` entry takes the oldest pending one project-wide,
and `/workflows continue <runId>` takes a named run.

`outputDir()` returns the project-relative workflow workspace. Fresh runs
default to `.locus-pi/workspaces/<generated-run-name>` under the project root. The
`--run-name <name>` form selects
`.locus-pi/workspaces/<name>`. A legacy-only `.locus-pi/plans/<name>` remains
bound to its original physical identity. The same workspace can be selected through the
programmatic tool's `outputDir` or `/workflows run <name|path> --output-dir
<path>`. The runtime
preserves a qualified child's complete saved name in the generated workspace
leaf; an invoked child still shares its parent's selected workspace. The
runtime creates its absolute path before the first child and
names it exactly once in every child task. Agent files keep their exact names;
the runtime does not rename, move, or clean them. Each child task also says that
pre-existing workspace files are owned state: the child may replace only its
assigned filename and must preserve the active `.locus-pi-workflow.lock`,
`style.md`, and sibling handoffs. A lane instruction to write no other artifact
forbids extra writes; it never authorizes cleanup. Confined absolute paths are
accepted. `./path` resolves from the agent working directory. Traversal outside
the project, whitespace tricks, backslashes, out-of-project working directories,
and symlink escapes fail before a child starts.
A task artifacts directory such as `.tasks/<task>/artifacts` is a legal
`--output-dir`; running again into the same directory when it already holds
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
and transcripts go to `runtime/artifacts/`. See [`docs/workflows.md`](../workflows.md).

`publishPrimaryFile(relativePath)` validates a regular, non-symlink, non-empty
file beneath the workflow workspace and exposes absolute/relative path, byte count, and
SHA-256 digest. It neither copies nor parses content. The reference is a
point-in-time, non-atomic observation: portable Node cannot make ancestor
replacement and path-based open/rename/unlink one indivisible operation against
a hostile local process. Workspace files survive failed runs; run-local evidence
remains immutable under the run id.

The workflow workspace is the durable location for handoffs, final results,
review evidence, and explicit resume inputs. Keep disposable environments,
dependency caches, test basetemp, transient renderer output, and staging in
ordinary OS or tool temporary and cache locations. If renderer output is the
final deliverable, write or promote it into the workflow workspace. Promote any
scratch output needed for review or resume before its temporary or cache location
expires. This guidance reduces accidental mixing; an authored prompt that
explicitly requests another placement remains authoritative.

`invokeWorkflow()` accepts exactly one source-bound sibling `child`, saved
`name`, project-relative `scriptPath`, or exact legacy `packageName`, optional
semantic `input` and exact `items`, one safe item `key`, the complete unique
`keys` list, and the same `outputDir()`. It starts a real depth-one child with an
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
fenced workflow-workspace lease.
The lease excludes concurrent runs on the same namespace and prevents a stale
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

`now()` and `random()` exist so a workflow can be nondeterministic AND replayable.
They return exactly what `Date.now()` / `Math.random()` would, and the runtime
records each value in the run's replay record; a resumed run reads the recorded
value instead of producing a new one. Calling `Date.now()` or `Math.random()`
directly is not forbidden — those values are simply unrecorded, and a script
containing them is refused for replay. See [resume and replay](replay.md#resume-and-replay).

## Agent options

| Field              | Type                        | Default                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`            | string                      | — (clean child)                       | Optional project/user catalog name. Omit it to run without a role profile.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ask`              | `true`                      | — (off)                               | Lets THIS child ask the operator live clarifying questions through the injected `workflow_ask` tool: the question renders in the parent session, the answer returns as the tool result, and the same child continues. Interactive parents only — with no UI the call **fails closed** with `failureCause: "ask-unavailable"`. See [live operator questions](running.md#live-operator-questions--agent-ask-true).                                                                                                    |
| `maxToolCalls`     | positive safe integer       | — (unbounded)                         | Per-child-attempt runaway safety fuse. Do not set it to zero. The first over-budget tool start aborts the child; this is not a normal work target or security boundary. Absent means no counter at all.                                                                                                                                                                                                                                                                                                             |
| `timeoutMs`        | positive safe integer       | — (unbounded)                         | Wall clock for one child attempt, operator `ask` waits included. On expiry the runtime **aborts the child** and the call fails closed; it never resolves to a partial answer. `maxToolCalls` cannot end a stalled child. A value above Node's maximum timer delay runs as a chain of representable waits.                                                                                                                                                                                                           |
| `maxTurns`         | positive safe integer       | — (unbounded)                         | Cumulative SDK model cycles for one child, including tool use and output clarification; not workflow restarts or returned answers. Applies to text and tool-return paths. It is a separate axis from `timeoutMs` and is never multiplied by it.                                                                                                                                                                                                                                                                     |
| `attempts`         | positive safe integer       | `1`                                   | Physical child attempts for this one call when the **transport** failed — the child never got to answer, or lost the channel while answering. Refused, never clamped, when it is not a positive safe integer. Never re-asks an answer the child did produce.                                                                                                                                                                                                                                                        |
| `label`            | string                      | —                                     | Journal / UI label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `artifact`         | string                      | safe label or agent name              | Logical name for the exact automatic answer artifact. It must be a safe single component; transcript/result names derive from it.                                                                                                                                                                                                                                                                                                                                                                                   |
| `phase`            | string                      | current phase                         | Overrides the active phase tag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workspaceMode`    | string                      | `"project"`                           | Workspace intent: `"project"`, `"worktree"`, or `"temporary-worktree"`. Worktree modes allocate an isolated git worktree for file-change review UX.                                                                                                                                                                                                                                                                                                                                                                 |
| `workspaceHandle`  | string                      | —                                     | Opaque handle returned by `workspace(label, ref)`; reuses one runtime-owned linked worktree across agent calls.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sandbox`          | string                      | —                                     | Deprecated workspace alias. `"read-only"` maps to `workspaceMode: "project"`; `"workspace-write"` maps to `workspaceMode: "worktree"`. Explicit `workspaceMode` wins. It does not restrict tools.                                                                                                                                                                                                                                                                                                                   |
| `model`            | string                      | the resolved tier, else session model | Per-call CONCRETE selector `provider/id` with an optional `:off\|minimal\|low\|medium\|high\|xhigh` child reasoning-effort suffix. The resolved model and requested effort are passed to the child session. A selector this host's registry cannot resolve **fails the call** by name, with no child spawned — it never falls back to `ctx.model`.                                                                                                                                                                  |
| `modelRole`        | string                      | the resolved tier, else session model | Per-call TIER: a name in the roles table (`smol`, `slow`, `task`, …), never a provider selector. The package ships no assignments, so an operator layer has to say what the name means; a role nothing assigns degrades to `ctx.model` and records `modelRoleFallback` on `agent_end`, in the run-result artifact and in the run report. A role that IS assigned but whose value is not a parseable selector is a config error, not an unassigned role: it fails the call by name, quoting the value and the layer. |
| `requireModelRole` | `true`                      | absent                                | Requires an explicit `modelRole` on the same call, cannot be combined with `model`, and refuses an unassigned role before a fresh child starts. Use only when the stage's evidence contract depends on the declared tier; ordinary portable workflows keep the recorded session-model fallback. The flag is part of replay identity and appears on `agent_start`; replay starts no child and may reuse original evidence.                                                                                           |
| `choice`           | string[] (2+ unique values) | none                                  | **Standard machine-routing form.** The declared members travel in the return contract, and the child submits one of them through the acceptance tool, so replay, journal evidence, budgets and fail-closed exhaustion are the ordinary shaped path. There is no ceiling on the number of options and no length limit on one option. Cannot be combined with `schema`, `handoffs`, `output` or `validate`.                                                                                                           |
| `handoffs`         | `{minItems?, maxItems?}`    | none                                  | **Standard dynamic-decomposition form.** Returns complete non-blank text units. Both bounds are optional author declarations about the CONSUMER (`minItems` defaults to 0; omitting `maxItems` accepts any number of items), and there is no per-item character bound — `maxItemChars` is refused by name. Runtime owns acceptance, replay, evidence, budgets and fail-closed exhaustion. Cannot be combined with `choice`, `schema`, `output` or `validate`.                                                       |
| `schema`           | object (JSON Schema)        | none                                  | **Advanced compatibility.** Declare an arbitrary answer shape: the call returns the validated value instead of text, corrects the format inside the same child session, and throws `SchemaValidationError` when the contract is exhausted. Standard generated source uses `choice` instead. `validate` is available alongside it.                                                                                                                                                                                   |
| `validate`         | `(value) => string[]`       | none                                  | **Advanced compatibility, requires `schema`.** Cross-field rules the subset cannot declare. Runs on a schema-valid value; a non-empty return asks the same child to correct it in its own labelled block. Standard generated source does not emit validators.                                                                                                                                                                                                                                                       |

See [agent results](agent-results.md) for the complete acceptance lifecycle.

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
