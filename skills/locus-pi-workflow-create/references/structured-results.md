# Results: exact text, choices, structured JSON, named files

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

## Schema-proven source consumption

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

## Choices and semantic review

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

For a revisable slice queue use [adaptive slices](adaptive-slices.md): the queue owner rewrites an exact caller-assigned queue file whole, and each stage reads its first item. Source never reads the file; every pass is routed by an exact choice.
