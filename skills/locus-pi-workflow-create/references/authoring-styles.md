# Choose style, detail, size and executors separately

These are design-time choices written in the reviewed design. They are not new fields in `workflow`, `meta`, or `agent()`.

| Choice                               | Default                       | Explicit alternative                                                               |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------- |
| Graph for substantive implementation | `adaptive-slices`             | `fixed` for predetermined work; refinement/decomposition where appropriate         |
| Agent brief detail                   | `outcome-led`                 | `procedural` for a concrete tool constraint or observed failure                    |
| Advisory graph size                  | Fit the requested outcome     | State an agent-count preference in the authoring request; preserve required checks |
| Executor/model effort                | Existing session/user routing | Explicit verified `modelRole` or `model` under existing APIs                       |

Example authoring requests:

> Create a workflow for task directory `.tasks/example`. Use adaptive slices and outcome-led briefs. Implement the user-selected specification; define initial slices and completion outcomes while authoring. Build the source; do not run it.

> Create a fixed workflow for this exact three-stage export. Use procedural briefs because the importer requires the documented command order. Do not run it.

The graph must support the user-selected model, including arbitration of review findings; it must not require a particular brand or tier. Preserve existing session/user routing; this is not permission to change models or billing routes. Outcome-led briefs state role, expected result, SOURCES and essential constraints. They give the agent enough context and leave method selection to it. Use headings when helpful, not as a repeated template. Never remove acceptance criteria or unresolved risks to shorten a prompt. [Procedural briefs](procedural-briefs.md) is the separate detail reference; graph style remains an independent choice.

## Folder-level context

Pi's public `input` remains one semantic string; it does not accept an `args` object. Do not embed and parse a second JSON protocol.

Start with the task directory as input. The first agent discovers `task.md`, design and referenced evidence there. Keep concrete filenames inside the relevant brief. A reusable workflow may accept ordinary text naming a task directory and extra context; agents interpret that text. The runnable references use a directory-only input for clarity.

Run Pi in the target repository. A path mentioned in a prompt does not change the child working directory. `--output-dir` (tool `outputDir`) sets the confined workflow workspace; the host separately publishes evidence under the run's `outputs/` and `runtime/`. An authored `out` description is not a substitute for the host option. For an installed project example:

```text
/workflows run adaptive-slices --output-dir .tasks/example/artifacts/implementation -- .tasks/example
```

Choose a fresh output directory for an independent run. Agents create their working documents there; source does not read paths or files. See [runtime inputs](../../../docs/workflows/authoring.md#workflow-input-and-host-continuation).

## Executor selection

Pi already has responsibility roles and concrete selectors. Omit `model`, `modelRole`, `requireModelRole`, and effort selectors by default. Use `{ modelRole: "reviewer" }` only when the user or project explicitly requests that routing and the role exists in the global user model table. A configured role alone does not authorize choosing it. Model-less calls follow user routing, including an assigned `agent` role, and otherwise inherit the session model. If a particular route is essential, use `requireModelRole: true` so an unassigned role fails instead of inheriting silently. Configure roles through `/model-roles` or `~/.pi/agent/model-roles/config.json`, the only persistent model-role authority; project-local role files are not read. A role name is a configuration key, not proof of Claude, Codex, subscription billing or reviewer independence.

An explicit verified condition can select an author-owned options record at a visible callsite; do not add `chooseEngine`/`agentOpts` wrappers or parse model prose to choose a provider. Pi has no built-in live-load scheduler for choosing an engine. Resolve availability in the design or global user configuration or through a real `choice` edge when the task requires it. Do not invent automatic failover or silently change a required executor.

Keep literal responsibility labels (`review`, `correct`) and human work titles. Name a provider/model in a title only when its route was verified. Confirm `executedModel` and recorded fallback evidence when evaluating a run. Different role names alone are not different engines. The generic references deliberately inherit the session model and promise independent sessions/roles, not cross-provider review.

## What Claude's medium actually means

Claude Code calls the setting **Dynamic workflow size**, key `workflowSizeGuideline`. Values are `small` (aim below 5 agents), `medium` (below 15, default), `large` (below 50), and `unrestricted` (no guideline). It advises the author about agent count; it is not prompt length, reasoning effort, tokens, or an enforced run limit. See the [official size documentation](https://code.claude.com/docs/en/workflows#set-a-size-guideline).

Locus Pi does not implement that setting. State a size preference in the authoring request if wanted. Record the chosen graph and worst-case calls in the design; never cut required review/QA to satisfy a cosmetic target. Explicit run budgets (unbounded when undeclared) and task-derived slice/correction bounds remain separate. Procedural prompts being better for weaker models is an evaluation hypothesis, not a supported guarantee.
