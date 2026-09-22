# Author-facing source boundary

Read before Build. For exact grammar diagnostics read the runtime-owned
[source contract](../../../docs/workflows/source-shape.md).

## Target source shape

Keep stable stage option groups together near the top. Keep prompts, calls,
branches, and handoffs visible at their execution edges. Stage prompts own their
roles; package agent names are never required.

Use the create skill's consumer rule: narrative stays whole; only a real branch or work queue
needs a shaped result. The [structured-results guide](structured-results.md) explains the distinction.
Keep chosen bounds with their consuming edge and their reason in the design; the
[budget policy](../../../docs/workflows/budgets.md#run-budget) owns launch defaults.

```js
export const meta = {
  name: "review-task",
  description: "Review one task and publish the complete result.",
  profile: "standard",
};

const AGENTS = {
  reviewer: {},
  composer: {},
};

export default async function run({ agent, parallel, phase, publishPrimaryArtifact }, input) {
  phase("review");
  const reviews = await parallel([
    () => agent(`Review the contract:\n${input}`, { ...AGENTS.reviewer, label: "contract-review" }),
    () => agent(`Review the evidence:\n${input}`, { ...AGENTS.reviewer, label: "evidence-review" }),
  ]);

  phase("compose");
  const result = await agent(`Return the complete review:\n${reviews.join("\n\n")}`, {
    ...AGENTS.composer,
    label: "compose-review",
  });
  return publishPrimaryArtifact("review.md", result);
}
```

The workflow orchestrates but does not interpret or format agent results:

- an extraction agent returns the complete textual finding or list;
- a composer returns the complete Markdown document;
- a reviewer returns the complete corrected replacement;
- the script passes these values unchanged and publishes accepted text exactly.

Every child receives the full tool surface through `tools: ["*"]`. Standard
source contains no capability fields or tool lists. Roles choose only
prompt/model identity. `write`, `edit`, `bash`, and every other available tool
work by default. This is the Pi host contract; an external model adapter must
also expose its own full tool surface. Claude Code repository-agent profiles use
`--tools default --permission-mode bypassPermissions`; `*` is not Claude Code's
all-tools selector, and `--allowedTools "*"` does not grant all permissions.
Explicit tool-free profiles remain an intentional exception. A reviewer's
read-only responsibility concerns product source: it may use shell/git, write
reports, and repair authorized technical prerequisites. Host restrictions and
external-action authorization still apply. If repository evidence is needed, the child reads it because
its prompt asks for that work. Workflow JavaScript does not obtain paths or load
file contents on the child's behalf.

The runtime still prepends one exact absolute workflow workspace to every child
prompt. Fresh runs default to a unique
`.locus-pi/workspaces/<generated-run-name>/` workspace under the project root. A
qualified child keeps both name components in its generated leaf. Authors name the assigned relative file and the idempotent replacement rule;
the host supplies the actual workspace. Package task drafting and planning use the same workspace contract;
saved children and later manual stages share the selected named path. The host also supplies source context. Do not add permission/tool fields,
another default writable root, a path parser, or an information-gathering script.

The workflow workspace is the durable location for handoffs, final results,
review evidence, and explicit resume inputs. Keep disposable environments,
dependency caches, test basetemp, transient renderer output, and staging in the
ordinary OS or tool temporary and cache locations. When renderer output is the
final deliverable, write or promote it into the workflow workspace. Promote any
scratch output needed for review or resume before its temporary or cache location
expires. This guidance reduces accidental mixing; an authored prompt that
explicitly requests another placement remains authoritative.

When a workflow carries one task, the task's own artifact folder is a legitimate
and usually preferable durable root: `.tasks/<task>/artifacts/<stage>/` keeps
stage reports beside the task text a human already reads, and later stages read
earlier ones from there instead of receiving them again as prompt text.
`--output-dir .tasks/<task>/artifacts` is accepted by the operator surface (see
[workflow manual](../../../docs/workflows/index.md)); the runtime places its own lock and run marker inside
whatever root is selected. Nothing changes for disposable output: environments,
dependency caches, test basetemp and staging stay in ordinary OS or tool
temporary and cache locations, never beside evidence.

## Standard-profile bad smells

Do not generate:

- domain schemas, `validate`, input splitting, JSON/prose parsers, regex gates,
  coverage checks;
- Markdown/table/report renderers or handoff formatters;
- hand-written retry loops, branch-local `try/catch`, custom partial-result or
  failure envelopes;
- wrappers, registries, or graph engines around `agent()`;
- agents declared as personas with no distinct subtask inputs, outputs, and edges;
- prompt files that hide routing;
- domain-specific helpers promoted into runtime;
- a large structured plan used to fake manager-agent delegation.

This list is a baseline, not a loophole. During review, ask whether any helper
interprets, grades, reformats, recovers, or hides an agent edge. If yes, move the
semantic work into an agent, use a generic runtime guarantee, or return to design.

Routine agent and group failure is uncaught and fail-closed. Partial continuation
is outside the standard profile unless the approved design explicitly proves
that surviving results remain useful.
