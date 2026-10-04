---
updated: "2026-10-02T17:36:25Z"
source_commit: "8af5c47f379a"
update_event: "user_request"
context: "changes=L files=13"
description: "Give file writers and readers identical exact caller-assigned destinations"
---

# Author-facing source boundary

Read before Build. For exact grammar diagnostics read the runtime-owned
[source contract](../../../docs/workflows/source-shape.md).

## Target source shape

Keep stable stage option groups together near the top. Keep prompts, calls,
branches, and handoffs visible at their execution edges. Stage prompts own their
roles; package agent names are never required.

Use the create skill's consumer rule: narrative stays whole; only a real branch needs a
`choice`, and a work queue lives in an exact caller-assigned file. The [structured-results guide](structured-results.md) explains the distinction.
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
    () =>
      agent(`Review the contract:\n${input}`, {
        ...AGENTS.reviewer,
        label: "contract-review",
        title: "Review contract",
      }),
    () =>
      agent(`Review the evidence:\n${input}`, {
        ...AGENTS.reviewer,
        label: "evidence-review",
        title: "Review evidence",
      }),
  ]);

  phase("compose");
  const result = await agent(`Return the complete review:\n${reviews.join("\n\n")}`, {
    ...AGENTS.composer,
    label: "compose-review",
    title: "Compose complete review",
  });
  return publishPrimaryArtifact("review.md", result);
}
```

The workflow orchestrates but does not interpret or format agent results:

- an extraction agent returns one complete textual finding as exact text;
  several findings belong in an exact caller-assigned file that later agents read,
  and source never consumes a list carried in a model answer;
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

The host labels actual execution cwd and project source context. It does not prepend an agent-file placement base. The caller names shared handoffs and Task-required outputs with exact paths in the whole semantic input, preferably absolute; writers and readers receive that same input. Agents use ordinary tools to save intermediate and final files. Generated source does not parse paths, call workspace helpers for placement or load file contents.

For example, a prompt can assign `/project/.tasks/example/artifacts/review.md` while the agent executes in `/project` or a selected worktree. The writer replaces that complete file; after the barrier, the reviewer opens the identical path. A missing or ambiguous destination causes explicit non-success, not a default folder, fallback search or reconstruction from returned text. Assign distinct files to parallel writers. Operators serialize roots sharing fixed domain files; native runtime leases do not lock arbitrary prompt destinations.

These exact-path contracts do not enumerate every product internal. A task may delegate implementation within a product root, allowing that actor to inspect and choose internal files. Give parallel implementation actors disjoint write scopes. Preserve Task-required filenames, narrower write boundaries, unrelated files and read-only reviewer roles. A shared plan or complete worker handoff can convey discovered paths to later actors; workflow source passes that evidence whole without parsing it. The source-context root alone grants no write permission.

The caller also owns durability. Write a file needed after temporary-worktree release to its assigned durable path before release. Keep authorized scratch/caches in normal temporary locations. Native text snapshots remain optional evidence and verified-continuation inputs; they are never substitutes for requested files. A native completed result does not attest a filesystem write: the consuming stage reopens the exact assigned file and checks current required evidence. Replay restores answers, not file effects; missing or drifted prerequisites fail the consumer.

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
