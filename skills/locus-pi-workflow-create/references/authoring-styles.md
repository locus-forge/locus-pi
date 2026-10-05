---
updated: "2026-10-02T22:53:28Z"
source_commit: "0d098c9e06d1"
update_event: "user_request"
context: "changes=L files=29"
description: "Teach ordinary and detailed workflow authoring with shared Pi contracts"
---

# Choose style, detail, size and executors separately

These are design-time choices written in the reviewed design. They are not new fields in `workflow`, `meta`, or `agent()`.

| Choice                | Default                        | Explicit alternative                                                                                                             |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Authoring lesson      | Ordinary                       | Explicitly selected detailed walkthrough; see the [selection owner](../../../docs/workflows/create.md#choose-an-authoring-route) |
| Graph                 | `fixed` for known scope/stages | Replan when observed results must change remaining work; combine forms as needed                                                 |
| Agent brief detail    | `outcome-led`                  | `procedural` for a concrete tool constraint or observed failure                                                                  |
| Advisory graph size   | Fit the requested outcome      | State an agent-count preference in the authoring request; preserve required checks                                               |
| Executor/model effort | Existing session/user routing  | Explicit verified `modelRole` or `model` under existing APIs                                                                     |

Example authoring requests:

> Create a workflow for task directory `.tasks/example`. Use adaptive slices and outcome-led briefs. Implement the user-selected specification; define initial slices and completion outcomes while authoring. Build the source; do not run it.

> Create a fixed workflow for this exact three-stage export. Use procedural briefs because the importer requires the documented command order. Do not run it.

The graph must support the user-selected model, including arbitration of review findings; it must not require a particular brand or tier. Preserve existing session/user routing; this is not permission to change models or billing routes. Outcome-led briefs state role, expected result, SOURCES and essential constraints. They give the agent enough context and leave method selection to it. Use headings when helpful, not as a repeated template. Never remove acceptance criteria or unresolved risks to shorten a prompt. [Procedural briefs](procedural-briefs.md) is the separate detail reference; graph style remains an independent choice.

A fixed control skeleton does not require precomputed implementation work. The existing worker → evaluator → correction loop can leave internal design to its worker; plan/replan lets observed evidence change remaining work. Use a planner only when that responsibility is needed. Known, separable tasks may keep granular per-item or per-file work fixed.

## Folder-level context

Pi's public `input` remains one semantic string; it does not accept an `args` object. Do not embed and parse a second JSON protocol.

Use one short shared working context in the existing semantic input or an author-owned prompt string,
then append each role's responsibility. It is not a new DSL `preamble` option, a detailed solution,
or another task specification. Preserve the complete original Task or direct each child to its unchanged
source; list additional evidence separately. Children do not inherit the parent conversation.

The native Pi child bridge already injects **actual execution pwd** (including a selected worktree)
and **source project root** before the author's unchanged prompt. Use those facts; do not restate guessed
cwd/root values or call unavailable path helpers in orchestration-only source. It does **not** inject the
requested Git branch, Task source, delegated product root or author-owned evidence destinations.
Record those after inspection during authoring; each child verifies the requested checkout/branch
against its actual context before writing. A branch mismatch is a blocker, not permission to switch it.
Run Pi in the intended repository; a prompt destination never changes cwd or selected worktree.

Example input context after inspection (replace these illustrative paths/branch with actual verified values):

```text
Original Task: <complete unchanged request; task source below contains its supporting specification>
Expected checkout: /work/widget; branch: task/widget-fix
Task source: /work/widget/.tasks/widget-fix/task.md
Product root: /work/widget (preserve unrelated files and narrower Task restrictions)
Orchestration/evidence folder: /work/widget/.tasks/widget-fix/orchestration
implementation.md: /work/widget/.tasks/widget-fix/orchestration/implementation.md (developer writes; reviewer reads)
findings.md: /work/widget/.tasks/widget-fix/orchestration/findings.md (reviewer writes; developer reads on correction)
```

The developer may choose internal product files. It writes its full result and actual check evidence to
`implementation.md`, then returns a short status and exact path. The reviewer reopens that file and
actual changes, writes only `findings.md`, then returns its declared `choice`. No source-side file parsing,
second JSON protocol, cumulative review transcript or duplicate solution is needed. Missing/ambiguous
assignments fail closed. Readers never reconstruct a missing artifact from the returned status.

Keep this author-owned orchestration folder separate from runtime-owned journals and checkpoints.
`--workspace-dir` selects confined native coordination only; it is not the product/evidence destination.
Native run evidence stays under `outputs/` and `runtime/`; children must not modify it. The primary
[sequential starter](../../../extensions/workflows/references/examples/starters/evaluator-optimizer.workflow.mjs)
uses this contract. The optional [parallel tour](../../../extensions/workflows/references/examples/starters/project-tour.workflow.mjs)
adds distinct `purpose.md`/`commands.md` writer paths and one `guide.md` merge owner.
For richer adaptive work assign each shared queue, slice, review and final handoff explicitly;
consumers reopen the same files after dependencies finish. See [runtime inputs](../../../docs/workflows/authoring.md#workflow-input-and-host-continuation).

## Executor selection

Pi already has responsibility roles and concrete selectors. Omit `model`, `modelRole`, `requireModelRole`, and effort selectors by default. Use `{ modelRole: "reviewer" }` only when the user or project explicitly requests that routing and the role exists in the global user model table. A configured role alone does not authorize choosing it. Model-less calls follow user routing, including an assigned `agent` role, and otherwise inherit the session model. If a particular route is essential, use `requireModelRole: true` so an unassigned role fails instead of inheriting silently. Configure roles through `/model-roles` or `~/.pi/agent/model-roles/config.json`, the only persistent model-role authority; project-local role files are not read. A role name is a configuration key, not proof of Claude, Codex, subscription billing or reviewer independence.

An explicit verified condition can select an author-owned options record at a visible callsite; do not add `chooseEngine`/`agentOpts` wrappers or parse model prose to choose a provider. Pi has no built-in live-load scheduler for choosing an engine. Resolve availability in the design or global user configuration or through a real `choice` edge when the task requires it. Do not invent automatic failover or silently change a required executor.

Keep literal responsibility labels (`review`, `correct`) and human work titles. Name a provider/model in a title only when its route was verified. Confirm `executedModel` and recorded fallback evidence when evaluating a run. Different role names alone are not different engines. The generic references deliberately inherit the session model and promise independent sessions/roles, not cross-provider review.

## What Claude's medium actually means

Claude Code calls the setting **Dynamic workflow size**, key `workflowSizeGuideline`. Values are `small` (aim below 5 agents), `medium` (below 15, default), `large` (below 50), and `unrestricted` (no guideline). It advises the author about agent count; it is not prompt length, reasoning effort, tokens, or an enforced run limit. See the [official size documentation](https://code.claude.com/docs/en/workflows#set-a-size-guideline).

Locus Pi does not implement that setting. State a size preference in the authoring request if wanted. Record the chosen graph and worst-case calls in the design; never cut required review/QA to satisfy a cosmetic target. Explicit run budgets (unbounded when undeclared) and task-derived slice/correction bounds remain separate. Procedural prompts being better for weaker models is an evaluation hypothesis, not a supported guarantee.
