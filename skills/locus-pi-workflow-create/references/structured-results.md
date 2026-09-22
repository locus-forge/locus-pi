# Structured results and same-session format repair

Start with plain `agent()` text for a report, review or narrative handoff. Running
commands or writing files does not by itself require structured output. Add a
contract only when the next consumer needs one: `choice` for code branching,
`handoffs` for discovered work units, sequential or independent, or `output` for an
actual string-format requirement. Raw `schema` remains compatibility-only.

When a structured result follows commands or file writes, the correction happens in
that same child session by construction: there is no other transport. A schema-only
echo selects no value and must not become success. Do not parse Markdown fences or ask a fresh
worker to rediscover facts solely because the first answer has the wrong shape.

For example, rejecting a complete 37,000-character review because a guessed
`handoffs` item bound allowed less was an authoring defect — and the runtime no
longer offers that bound to guess with. A review of that kind should return plain
text anyway; a separate routing decision retains its real contract:

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
to branch. A real output limit names its consumer, unit and source; ordinary
narrative needs no author-selected cap. `output.maxLength` and `singleLine` have
no package default: declare them only for a named downstream limit. `maxItems`
counts what the consumer can take; `minItems` is what it needs. Budgets stop
spending, not answers, and never silently truncate complete work to pass validation.

Extend the existing workflow_return path, not a second return tool. Format clarification stays in the same child session and uses bounded attempts and cumulative resources. Semantic improvement is a fresh worker with the original goal and exact feedback. A successful proposal followed by cancellation/provider failure is not an accepted result.

Shape validity does not prove factual correctness. A required verifier remains required. An unknown field is not a verified absence; a missing verifier is not a clean decision. Reused answers are marked as reused, not given invented new child receipts. See the canonical [output acceptance contract](../../../docs/workflows/agent-results.md) for the principle, the supported combinations and the visible clarification default.

When code branches on an arbiter's judgement, prefer that arbiter returning the
`choice` directly. The call returns the branch, not
its explanatory prose. If a later round needs that explanation, save it in a
named workflow-workspace file before returning and tell the next consumer to
read it. This keeps the decision with its evidence; it does not let the producer
approve its own work or remove required review.

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

For a revisable slice queue use [adaptive slices](adaptive-slices.md): the structured result is an array of complete text briefs. The queue owner interprets each brief; source forwards items unchanged. A domain object schema is unnecessary when no source edge consumes its individual fields.
