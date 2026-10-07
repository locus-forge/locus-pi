---
updated: "2026-10-06T12:27:00Z"
source_commit: "fee5f591caaf"
update_event: "user_request"
context: "bounded schema authoring on the standard-tool contract"
description: "Keep opaque text and schema-proven results within checked workflow source boundaries."
---

# Author-facing source boundary

Read [result contracts](#structured-results) when choosing a handoff and [source shape](#target-source-shape)
before Build. Exact grammar diagnostics belong to the runtime-owned
[source contract](../../../docs/workflows/source-shape.md).

## Structured results

Choose the smallest result contract its consumer needs:

- Plain `agent()` returns exact whole text for narrative and full documents
- `choice` returns one exact declared string for a single branch
- A literal `schema` returns immutable JSON when source needs proven fields or arrays
- Exact caller-assigned files carry shared artifacts and revisable queues that later agents read

Caller-owned work units still come from `dsl.items()`. Running commands or writing files
does not change a result contract or prove that the requested effects happened.
`handoffs`, `output` and `returnVia` remain removed. Both source-check profiles admit the
bounded [structured v4 contract](../../../docs/workflows/agent-results.md#structured-results-v4)
and refuse the removed `validate`, `repair` and `outputTransport` options. Correction remains package-owned.

### Schema-proven source consumption

Use a direct options object with distinct explicit properties, a literal `label`, and
`schema` set to literal data or one unshadowed top-level literal `const`. Do not spread
stage options into a structured call, use shorthand/computed declarations, or build
schemas with helpers. The runtime dialect stays `locus-json-subset-v1`, including
optional properties, open objects and arrays without `items`; those shapes do not grant
source permission to read optional/unknown fields or inspect untyped items.

```js
export const meta = { name: "review-summary", profile: "standard" };
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["accept", "revise"] },
    summary: { type: "string" },
  },
  required: ["decision", "summary"],
  additionalProperties: false,
};
export default async function run({ agent, publishPrimaryArtifact }, input) {
  const review = await agent(`Review the task against its acceptance criteria.\n${input}`, {
    label: "review",
    schema: REVIEW_SCHEMA,
  });
  if (review.decision === "revise") return agent(review.summary, { label: "explain-corrections" });
  return publishPrimaryArtifact("review.md", review.summary);
}
```

Await before reading. Keep unchanged aliases or return the whole result; read required
declared named fields; compare enum/boolean identities with `===`/`!==`; use proven
array `length`, `.map()` or `for…of`. Strings can forward unchanged to prompts, logs and
publication; scalar fields can interpolate directly in those sinks' templates. Plain
model text stays opaque. Mapped/group composites stay opaque where shape is unproven.
Map JSON values synchronously; async callbacks, pending Promises and emitted functions
are refused. Use the existing direct `parallel(rows.map(row => () => agent(...)))`
form for deferred branches. Awaiting the mapped array does not await its elements.

Do not destructure results, read optional/unknown fields, use unchecked indexes (even
literal indexes), mutate fields, parse prose, transform JSON, or introduce helper
aliases. Optional guards do not establish field presence. The
[source contract](../../../docs/workflows/source-shape.md#checked-structured-results)
owns the exact boundary; the [DSL reference](dsl.md#agent) has checked array examples.

V4 uses the existing return tool on verified Pi >=1.0.0 `openai-codex` hosts; version
alone is insufficient. The tool carries the actual schema; Pi strict preference is used
only where it preserves that schema. There is no second transport or new permission. Shape validation
is not proof of truth or permission to skip required review. Source acceptance also does
not promise replay: exact source/schema/input identity and v3 observer receipts remain
required, and generalized numeric-loop replay is still conservatively unproven.

### Choices and semantic review

A choice is corrected in that same child session by construction: there is no other
transport. A value that lists choices without selecting one must not become success.
Do not parse Markdown fences or ask a fresh worker to rediscover facts solely because
the first answer was not a declared member.

A long review stays plain text; a separate routing decision carries the branch:

```js
const review = await agent(`Review the proposed change against its acceptance criteria.\n${input}`, {
  label: "review",
  title: "Review the proposed change",
});
const decision = await agent(`Decide whether the acceptance criteria are met.\n${input}\n${review}`, {
  label: "acceptance",
  title: "Check acceptance",
  choice: ["ready", "blocked"],
});
```

The load-bearing distinction is prose versus code-consumed control, not these
labels or this number of agents. Add a separate decision only if the graph needs
to branch. Ordinary narrative needs no author-selected cap; a real format requirement
belongs in the prompt and, when it must be checked, in a separate verifier that
writes its own record. Budgets stop spending, not answers, and never silently
truncate complete work.

Use the existing workflow_return path, not a second return tool. Choice clarification stays in the same child session and uses one package-owned correction and cumulative resources. Semantic improvement is a fresh worker with the original goal and exact feedback. A successful proposal followed by cancellation/provider failure is not an accepted result.

A declared member does not prove factual correctness. A required verifier remains required. An unknown field is not a verified absence; a missing verifier is not a clean decision. Reused answers are marked as reused, not given invented new child receipts. See the canonical [output acceptance contract](../../../docs/workflows/agent-results.md) for the principle, the removed options and the visible clarification default.

When code branches on an arbiter's judgement, prefer that arbiter returning the
`choice` directly. The call returns the branch, not
its explanatory prose. If a later round needs that explanation, save it in a
exact caller-assigned file before returning and tell the next consumer to
read it. This keeps the decision with its evidence; it does not let the producer
approve its own work or remove required review.

Name each choice member after the action its branch takes, never with a word
that also reads as a verdict for another branch: rework is `fix` or `revise`,
never `correct`, `ok`, `right` or `fine`. A reviewer who writes "Verdict:
correct" about clean work selects the rework branch by accident. Define every
member by the condition that selects it.

If a separate translator is useful, give it the stated branch and its meaning.
It extracts that decision rather than applying acceptance criteria again. Child
sessions do not automatically inherit JavaScript variables or earlier agents'
conversations: pass needed context explicitly. A translator must not add owner
approval when `complete` only means a document is ready for owner discussion.

Bad: "Return complete only if criteria, owner decision and review are explicitly
confirmed" asks a second judge to decide from a summary. A translator's brief is:

```text
Copy the one branch explicitly selected in the arbitration below; do not rejudge
its evidence. Here complete means ready for owner discussion, not owner approval
or permission to implement. A stated failed remains failed. If no single branch
is stated, use the designated non-success branch for an unresolved decision,
without claiming a
review failed. Arbitration: <actual decision text>
```

A filename or short final reply is not the full artifact. Pass the text the
consumer needs, or explicitly ask a consumer with read access to read the named file. If it only copies
an explicit decision, do not make it repeat the underlying research. Attribute a
terminal branch to its decision maker; a negative routing value alone does not
prove that review failed or that the specification is incomplete.

For a revisable slice queue use [adaptive slices](agentic-approaches.md#adaptive-slices): the queue owner rewrites an exact caller-assigned queue file whole, and each stage reads its first item. Source never reads the file; every pass is routed by an exact choice.

## Target source shape

Keep stable stage option groups together near the top. Keep prompts, calls,
branches, and handoffs visible at their execution edges. Stage prompts own their
roles; package agent names are never required.

Use the create skill's consumer rule: narrative stays whole; a single branch can use
`choice`; proven fields/arrays can use a literal `schema`; a revisable work queue lives
in an exact caller-assigned file. The [structured-results guide](#structured-results)
explains the distinction. Structured calls use direct explicit options without the
spreads used by the plain-text example below.
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

The workflow orchestrates within the result's declared boundary:

- an extraction agent may return one complete textual finding, a literal-schema
  result for bounded source consumption, or findings in an exact caller-assigned file
  that later agents read; source never parses a list out of plain model text;
- a composer returns the complete Markdown document;
- a reviewer returns the complete corrected replacement;
- the script passes text unchanged and publishes accepted text exactly; a structured
  string may also reach a text sink, and scalar fields may interpolate directly into
  prompt/log/publication templates.

A structured call declares a literal schema or one unshadowed top-level literal `const`
in direct options with distinct explicit properties. Await before reading required
named fields, comparing exact enum/boolean identities, or using proven array
`length`/`.map()`/`for…of`. Optional or unknown fields, unchecked indexes, result
destructuring, transformations and field mutation remain rejected. Open/optional
objects and untyped arrays remain valid runtime schemas; source cannot infer their
missing shape. Mapped composites and group outputs remain opaque when shape is unproven.
`validate`, `repair` and `outputTransport` stay outside ordinary authoring. See
[checked structured results](../../../docs/workflows/source-shape.md#checked-structured-results).

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

## Readable string literals

Follow the [text readability rule](design-and-build.md#text-readability) when writing prompts.
A physical newline in a template literal is part of its value. Replacing an existing escaped
`\n` with that physical newline preserves the prompt; adding a new newline does not.
For a static value that must remain on one logical line, use a literal continuation:

```js
const CONTEXT = `Read exact files. \
Preserve the Task.`;
```

The space before the backslash remains; the backslash-newline contributes no character.
Indenting the continuation would add spaces to the value. Do not split escapes, backticks
or interpolation syntax arbitrarily. The checker accepts multiline and continued literals;
top-level string concatenation is not a literal declaration. Do not add wrap/dedent helpers,
array joins or runtime input transformations merely to format source. Forward Task bytes whole.
Preserving a literal value still changes the source hash; do not reformat an existing replay
or frozen evaluation source. Review source and prompt identity separately.

## Standard-profile bad smells

Do not generate:

- dynamic/helper-built schemas, `validate`, `repair`, `outputTransport`, input splitting,
  JSON/prose parsers, regex gates, coverage checks;
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
