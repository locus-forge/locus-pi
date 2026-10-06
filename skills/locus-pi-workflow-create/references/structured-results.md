# Results: exact text, one choice, named files

Within this skill's checked authoring grammar, an agent returns: plain `agent()` text, or one exact
`choice` member when source must branch. Running commands or writing files does not
change that. Anything richer — a record, a list of units, a queue, per-field findings —
goes into a **exact caller-assigned file** that the agent writes and a later agent reads.
`handoffs`, `output` and `returnVia` remain removed. The checker also refuses
`schema`, `validate` and `repair`. Reviewed trusted runtime source has an opt-in
[structured v4 contract](../../../docs/workflows/agent-results.md#structured-results-v4--trusted-runtime-source);
this lesson does not teach that syntax before its authoring grammar is supported.
Caller-owned work units come from `dsl.items()`.

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
