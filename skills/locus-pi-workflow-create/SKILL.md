---
name: locus-pi-workflow-create
description: Create or revise an adaptive slice-first locus-pi `.workflow.mjs` agent graph through Design, review, Build, and source validation. Generated source contains prompts and agent/DSL edges, not file-reading logic. For create-and-run, hand checked source to locus-pi-workflow-run under the existing execution authorization.
---

# Create a locus-pi workflow

Resolve this `SKILL.md` to its physical file before following relative links; the installed [workflow manual](../../docs/workflows/index.md) is relative to that file, never the caller cwd (see [discovery](../README.md#find-the-installed-workflow-documentation)).

This skill owns authoring and the checked-source handoff. Do not use merely to run an existing workflow; use the `locus-pi-workflow-run` skill for launch, stopped-run recovery and monitoring. Create-only ends with checked source and a launch command. Create-and-run continues through that run skill under the request's existing scoped authorization, without asking for the same approval again. Report authoring and execution outcomes separately. No package-provided catalog agent is required.

## Product goal and repair requests

Build useful graphs of LLM agents. Do not optimize for deterministic re-execution of the whole JavaScript program. A deliberate graph may contain hundreds or thousands of small calls; count alone is not a defect and is not a reason to redesign it or invent a smaller cap. Do not assign model, effort or budget choices the user did not request. Use the user-configured default model and effort; omit model and role selectors unless the user or project explicitly requests an override. Never prescribe a model brand or tier for a stage. A role name does not establish its provider or billing route. If subscription transport is required, verify each role's provider, adapter and authentication mode before accepting the design; do not substitute a paid API route.

When a workflow fails, open `.locus-pi/logs/errors.jsonl`, follow its exact evidence paths, and fix the owning layer; see [error diagnostics and jq examples](../../docs/workflows/error-diagnostics.md). When the request is to fix a stopped workflow, read [Repair + Continue](references/repair-and-continue.md) first. Repair the same source and preserve the unaffected completed prefix, including literal labels, prompts, order and workspace assumptions. Do not rebuild the graph from scratch merely because execution stopped. Validate the exact repaired source, then hand the result to the run skill. Continue when repair-and-continue was requested; a repair-only request stops at checked source.

## Establish the requested deliverable

Before authoring, inspect the request and supplied documents. If the purpose is unclear, ask one focused question: create a specification, revise an existing specification, or implement a selected design? Clarify which specification/documentation directory is authoritative and whether an unresolved product choice changes the intended outcome. Do not ask again when the user already specified this. A specification need not be flawless to support authorized implementation; ordinary technical defects become assigned work.

These are two independently authored workflows. The first produces the task specification and its review history. After the user examines it and asks to implement, author the second workflow against that actual artifact. At that point define initial slices, references to the specification and documentation directory, and the concrete completion outcome of each phase. The implementation queue may later be re-cut while preserving verified work and unmet requirements. Do not prebuild or automatically launch implementation merely because specification authoring finished. The workflow's own `.design.md` describes its graph; it is not the task specification.

When using the packaged `task/plan` authoring stage, pass the complete accepted `task/draft` text as semantic input. Missing or blank input fails before any child starts and produces no `workflow.mjs`; never substitute a placeholder brief.

## Select the graph before loading details

Read [the pattern index](references/INDEX.md), then only the selected card. Default to adaptive slices for substantive implementation: owner cut → implement one slice → review → addressed correction → recheck → owner re-cut. Choose a fixed graph for genuinely fixed work or an explicit request. Claude Code is not a control plane or a required dependency.

Read [authoring styles](references/authoring-styles.md) for explicit graph/detail choices, folder-level task input, executor selection and the Claude size setting. Default brief detail is outcome-led; procedural detail is an explicit alternative. These are authoring instructions, not new runtime options.

## Design → review → Build

A plain authoring request writes `.locus-pi/workflows/<name>/<name>.design.md`, reviews it, then builds exactly its `Entries` table. Read [design-and-build.md](references/design-and-build.md) before writing the design or source. A `runnable root` includes the root; `group-only` has only direct child entries. Stop after the design only for an explicit design-only request, pause after design or do not build.

Build-only requests remain `Build design: <exact path>` and `Build approved design: <exact path>`. A material algorithm mismatch returns to design review; never hide it in source.

## Agent briefs and returns

Give each agent a coherent task, relevant context and clear completion condition. State each fact once; leave inspection, implementation and verification methods to the agent.
Add procedural instructions only for a concrete repository constraint or known failure; do not script tool sequences or repeat a general policy in every node. For a code slice, the reviewer reads the actual complete diff, including uncommitted work. End with a commit only when commit authority exists; never invent it to make review easier. Require coverage of that diff before a favorable verdict.

Implementation briefs and templates must distinguish completion from preparation:
after an authorized environment repair, continue the accepted implementation and
verify its requested behavior. Passing baseline tests is not implementation.
Unfinished work alone is not a blocker; a blocked result needs a concrete obstacle
that cannot be resolved within scope, or an observed resource limit. For this
failure, read [Repair + Continue](references/repair-and-continue.md#unfinished-implementation).

Choose the return shape from its consumer. Ordinary reports and intermediate
narrative use plain `agent()` text, without `output`, `schema`, `handoffs` or an
author-guessed length target. Use `choice` when code branches on a decision and
`handoffs` when it schedules discovered work units, including a sequential slice queue. A singleton
array must not become a report envelope or a success signal.
A stage refusal uses an explicit `choice` identity and `{ ok: false, status }`. Runtime failure statuses are `failed`, `blocked` and `cancelled`; a domain label such as `needs_owner` needs `ok: false` to mark refusal.
Do not use an empty queue or a success fallback to conceal missing work.
For substantive review, use an arbiter that evaluates findings and may accept or reject them with evidence, request correction, retry review or disclose a limitation. Reviewer output is input to judgment, not an automatic veto. Preserve the complete inventory of completed, failed, missing and skipped checks. Do not claim a check ran when it did not.

Use `agent(prompt, { result: "report" })` for plain-text calls whose eligible terminal failure must reach that arbiter. Forward the entire host-rendered report. It includes actual answer or failure facts; it is not task acceptance. It cannot combine with shaped output. Ordinary calls and fatal execution failures still throw; see [report mode](../../docs/workflows/agent-results.md#agent-execution-reports). Use bounded correction and fresh review after every change; allow residual findings to return to the author while progress/resources permit. On exhaustion preserve the latest reviewed artifact, unmet criteria, reason and next action. An incomplete required outcome stays non-successful; a real user question includes options and consequences. `throw` is for execution errors, not a routine review decision.

The runtime has no answer-size policy: it never rejects or truncates an answer for its length, and no size option has a package default. Declare `minItems`/`maxItems` only for a consumer that counts (a fixed number of downstream slots, a queue that must not be empty); `maxLength`/`singleLine` only for a named downstream limit (a status line, a filename, a field in someone else's record), and say which in the design. Never write a prompt line such as "keep it under N characters" or "at most N items": that is the same policy in English. Never emit `maxItemChars`, `maxAnswerChars`, `schemaMaxLength` or `returnVia`; the runtime refuses the first three by name and `returnVia: "tool"` is redundant.

Budgets (`timeoutMs`, `maxTurns`, `maxToolCalls` on a call; `totalAgents`, `runtimeMs` at launch) stop spending, not answers. The [budget policy](../../docs/workflows/budgets.md#run-budget) owns launch-mode defaults; other undeclared axes are `unbounded`, as printed in the run header. Declare one only with a one-line reason recorded in the design; do not copy a number from an example or raise one after a valid answer was refused. `maxTurns` counts SDK model cycles inside one child, including tool use; it is not a retry or repair count. A capability option (`workspaceMode`, `ask`, `maxToolCalls` as a runaway fuse) is justified by what the stage must or must not be able to do, never as a size stand-in; legacy `tools`/`readOnly` fields are ignored. For a confirmed turn-budget stop, follow [Repair + Continue](references/repair-and-continue.md#turn-budget-failures).

When repairing an output-contract failure, inspect the whole unfinished suffix
for the same narrative-wrapper mistake. Preserve completed calls and genuine
decision/fan-out contracts; see [Repair + Continue](references/repair-and-continue.md#repeated-output-contract-failures).

When an agent executes a command or writes files before returning a `choice`, the
format correction already stays in that child's own session — every shaped call is
carried by `workflow_return`, so a mismatch never reruns the command. Put the actual
success condition in the prompt, such as a confirmed command exit code.
Never use a success fallback to conceal an unconfirmed result. An existing file
does not prove the current command succeeded.

Before any decision handoff, read [structured results](references/structured-results.md): the arbiter owns the decision; a translator copies it without new criteria or owner approval. A path or summary is not the full arbitration.
That reference also covers same-session correction and schema-echo repair. Plain narrative agents
need no output contract. For a stopped run, inspect the command transcript as
well as the final answer: work may have finished before shape acceptance failed; answer size is never the cause.

## Source and evidence boundary

Workflow source is orchestration only: explicit prompts, visible DSL edges and whole-value handoffs. Agents own interpretation, any source inspection requested by their prompt, and complete reader-facing results. Read the canonical [Workflow source contract](../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape) for the permitted grammar; do not infer permission from a legacy recipe. Where files belong is owned by [source boundary](references/source-boundary.md#target-source-shape): durable handoffs, final results, review evidence and explicit resume inputs in the workflow workspace — or in `.tasks/<task>/artifacts/<stage>/` when the workflow carries one task; disposable environments, dependency caches, test basetemp, transient renderer output and staging in ordinary OS or tool temporary and cache locations. Explicit authored placement remains authoritative.

Give every agent a concise human `title` describing its current work. In a
`.map()`/`parallel()` list, derive it from the item and question so siblings are
distinguishable, for example ``title: `${item.key} · ${field.key}```. A title has no length ceiling; the renderer clips what it cannot draw. Verify a two-item example reaches
the displayed rows; distinct labels alone do not prove readable titles.

Every callsite needs its own literal `label`. A dynamic `title` is display text, not identity. Same-session output clarification is not a semantic round; semantic continuation creates a fresh worker. Recovery is a separate runtime capability.

Run `workflow_check_source` with `mode: "orchestration-only"` on every exact built source, plus `node --check <exact-path>` and the design/source checks. Never import unchecked source as a preliminary smoke test. When that Pi-native tool is unavailable and a `locus-pi` source checkout is present, use its supported equivalent from that checkout: `npm run check:workflow-source -- --mode orchestration-only <exact-path>`. Both routes call the same workflows-owned validator and neither imports or executes the target. If neither route is available, or the selected validator fails, Build fails: never report a successful Build after skipping the gate. Return the exact copyable launch command `/workflows run <name>`. For create-only, explicitly state execution did not start. For an authorized create-and-run request, continue now through the run skill and report its terminal status, source/run references, diagnostics and verified deliverable. A static-valid source that fails at runtime is not a successful create-and-run result.

## Trust and further references

Reviewed JavaScript runs in the Pi host process; approval and worktrees are not a sandbox. Runtime/API authority is [workflow manual](../../docs/workflows/index.md). Follow only the section needed by the selected graph. Do not load the entire runtime manual just to author a fixed chain. Substantial fan-out is owned by [locus-pi-workflow-run](../locus-pi-workflow-run/SKILL.md#large-runs-observe-and-let-the-operator-decide): do not inject a call-count cap, token floor or automatic budget change here.
