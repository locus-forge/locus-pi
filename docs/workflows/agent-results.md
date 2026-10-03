---
title: Agent results and output acceptance
type: guide
status: active
updated: "2026-09-30T12:00:00Z"
source_commit: "54dea11dbe11"
update_event: "user_request"
context: "task=T-129"
description: "Agent calls return exact text or one exact declared choice; shaped JSON and list results are removed."
---

# Agent results and output acceptance

[Workflow documentation](index.md) · [Authoring guide](create.md) · [Operator guide](running.md)

Audience: workflow authors and bridge/host maintainers. This file owns the agent result API.

An `agent()` call has exactly two result modes:

- **Plain text.** `agent(prompt)` resolves to the child's exact, full, non-empty final text.
  `result: "report"` is the same call observed as a whole execution report.
- **One exact choice.** `agent(prompt, { choice: [...] })` resolves to one declared string,
  submitted through the same-session `workflow_return` tool.

There is no third mode. An agent does not return JSON, an object, a list, or a value the
workflow script has to parse. When a stage produces something richer than one routing
token, the agent writes it to a **named workspace file** and returns readable text; the
next agent reads that file. The runtime persists every answer before emitting terminal
`agent_end`; child metadata and diagnostics stay in journal and result evidence.

## The principle

Stated here once. Every other workflow document links to this section instead of
repeating it, so there is one place to correct if it ever changes.

1. **The runtime never rejects or truncates an answer because of its own size policy.**
   A bound on answer length, item count or artifact size is either a consumer's declared
   contract, a provider's real API parameter, or it does not exist. A removed bound is
   not replaced by a smaller number, and not by a prompt asking the child to "keep it
   under N characters" — that is the same policy rewritten in English, and it fails the
   same way: the work is already paid for when the bound bites.
2. **Budgets stop spending, not answers.** Time, turns, tool calls and agents are
   resolved from the approved launch defaults and explicit author/operator settings,
   checked before the next spend, and printed as `unbounded` where neither sets a value. A run that ends on one is _stopped by
   budget_ — a statement about what it may still spend, never a verdict on the answers
   it already produced, all of which stay stored and readable. See
   [run budget](budgets.md#run-budget) for the axes.
3. **A capability that cannot be honoured is refused before the child starts.** If a
   transport or model cannot carry a declared contract, the call fails by name up front
   (`output-contract-unavailable`) rather than imitating the capability by grading the
   finished answer.

Three things stay separate throughout, and the journal keeps them separate: whether
execution FINISHED, whether the result is ACCEPTABLE to its consumer, and whether the
stored data is AVAILABLE. An invalid result is still stored and still readable.

## API

```js
// Plain text: the exact full answer, nothing parsed.
const review = await agent("Review the change and write findings to review.md in the workspace.", {
  label: "review",
});
// One exact routing token, selected from the declared members.
const route = await agent(`Choose the next step from this review:\n${review}`, {
  label: "route",
  choice: ["accept", "revise", "blocked"],
  choiceFallback: "blocked",
});
```

`choice` is the only option that changes what a call returns. The child alone receives
`workflow_return({ value })`; a plain child is never given that tool. The closure, not
tool arguments, owns the call's contract and identity; the tool accepts no file path,
call ID or routing target. The first valid proposal is fixed, identical duplicates are
idempotent, and a contradictory second proposal fails the call with
`output-contract-conflict`.

The contract carries one package-owned same-session clarification: two submissions in
total, the first proposal plus one correction turn. Every choice call journals
`[workflow:return] <label>: contract v3, 1 same-session clarification turn(s) (package default 1)`.
The count is not configurable.

## Removed shaped-result options

These options were removed. Each one is refused **by name, before any child starts and
before the replay lookup**, with the replacement below. A fresh run and a resumed run whose
source still declares one fail with the same sentence, so an old shaped receipt is never
reinterpreted under the reduced contract.

| Removed                             | Use instead                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handoffs`                          | Have an agent write a named workspace file and return readable text; pass caller-owned work units through `items()`; or loop with a bounded `for` and route each pass with `choice`. |
| `schema`                            | Have the agent write the record to a named workspace file and return readable text; use `choice` when source needs one exact token.                                                  |
| `validate`                          | Put the rule in the prompt, or run a separate verifier agent that checks the named workspace file and writes its own record.                                                         |
| `output`                            | Drop it: plain `agent(prompt)` already returns the exact full text.                                                                                                                  |
| `repair`                            | Drop it: a choice call uses the package-owned single same-session correction.                                                                                                        |
| `returnVia`                         | Drop it: a choice call always returns through `workflow_return`, and a plain call returns exact text.                                                                                |
| `maxAnswerChars`, `schemaMaxLength` | Both are refused by name; state a length requirement in the prompt.                                                                                                                  |
| Fusion `schema`, `validate`         | The judge returns exact text; state the required format in the prompt, or have a later agent write a named workspace file from the judge's text.                                     |

The standard source checker names `handoffs`, `output`, `repair` and `returnVia` on an
`agent()` call, and still refuses raw `schema` and `validate`.

## Same-session lifecycle

The host creates one child session, performs the task and validates the tool proposal.
An invalid proposal receives feedback in that session. If the turn ends without a usable
proposal, the host sends one bounded clarification to the same session, reusing its
history. No fresh worker or second logical workflow call is created for format repair.

After submission, and before a clarification prompt, the host narrows active tools to the
return tool and verifies readback. Changes apply to the next model turn: this is not a
sandbox, does not roll back a dispatched tool batch, and does not provide exactly-once
external effects. A host that cannot restrict and read back its tool set fails before
the first prompt with `output-contract-unavailable`; there is no silent fresh-session
fallback.

Tools, assistant turns and the wall-clock deadline accumulate across clarification. The
original outer workflow timeout remains armed. A candidate is committed only when the
child finishes successfully; a provider error, cancellation, timeout or budget failure
after a proposal still fails. The session is disposed once.

Assistant turns are SDK model cycles (`turn_start`), including normal tool use before the
first proposal. The same cumulative `maxTurns` limit applies to plain and choice
children. A long review can exhaust turns without ever calling `workflow_return`; inspect
its transcript before diagnosing a format-repair loop.

Format repair is not semantic retry: a declared member is not evidence that the decision
is right. A required verifier stays required, and content review is a separate agent call
with the original goal and exact feedback, never a hidden continuation of choice
clarification.

The value must be one exact declared string. An array, an object such as
`{ choice, reason }`, or a string that contains JSON is refused with a named correction
and never parsed into a member.

## Canonical value and evidence

The accepted member is recorded as its canonical JSON string; runtime checks that
boundary and returns the exact string to workflow code. The run-owned artifact store
records those bytes independently of the model's final narrative.

`agent_end.outputAcceptance` contains `{ source: "tool", toolName: "workflow_return", attempts }`
only on success. `callId`, child session evidence and group `itemPath` bind it to the
execution. Missing fresh-execution acceptance receipts fail closed. Replayed calls use
recorded answers and existing replay provenance; they do not invent a new session receipt.

Choice decisions emit a runtime journal log with `message: "[workflow:choice]"` and
`choiceDecision`: `value`, `source: "validated" | "fallback"`, `returnVia` (always
`"tool"` on a fresh run; `"text"` appears only in journals written before the text
transport was deleted), optional attempts and fallback reason. Fallback is not ordinary
model judgment.

An explicitly declared `choiceFallback` applies only to `output-contract-exhausted`. It
never turns provider, authorization, cancellation or infrastructure errors into a domain
decision. With asymmetric false-negative costs, select an explicit uncertainty value or
fail closed. `agent_end.schemaValidation` keeps its name for journal compatibility and
reports the choice check.

Older journals stay readable: `schemaValidation.source: "script"` and the `script-rejected`
cause may appear on records written while `validate` existed.

## Command completed, answer rejected

Observed failure: a composer wrote its output, then returned
`{"type":"string","enum":["success","failed"]}`. This lists choices but selects none. The
runtime rejects it; accepting the first member would invent success. A file left on disk
does not resolve the missing decision.

For agents that execute commands or write files, report the outcome as a choice:

```js
const result = await agent(
  'Run the command once. Call workflow_return({value:"success"}) only after exit 0; otherwise submit {value:"failed"}. Correct the answer format using the same command evidence, without repeating the command.',
  {
    label: "compose",
    title: "Compose output files",
    choice: ["success", "failed"],
  },
);
if (result === "failed") throw new Error("Composition failed or was not confirmed; output files may exist.");
```

A simple narrative lookup still uses plain `agent(prompt, { label, title })`; do not add
tools or extra verification agents to it.

## Standard exact choice — `agent({ choice })`

Use `choice` when workflow JavaScript must select one small branch:

```js
const route = await agent("Choose the next step.", {
  choice: ["accept", "revise", "blocked"],
  choiceFallback: "blocked",
});
```

The declaration contains at least 2 unique, non-empty strings. There is no ceiling
on how many, and no length limit on one of them: a routing list is a statement
about the branches the script actually has, and a runtime that refused the 33rd
branch would be inventing a policy the consumer never asked for. The members travel in
the return contract, and the child selects one through the acceptance tool. An
optional `choiceFallback` must exactly equal one declared choice. The runtime
returns it only after the in-session contract is exhausted, records a runtime-owned
journal line with the validation errors, and never masks child execution or
transport failures. Standard generated workflows use this form for machine routing
and exact text for every narrative result.

For directly declared literal `choice` and `choiceFallback` values, the source
checker enforces the same membership rule before execution. A fallback outside
that list is a `WF_POLICY` error. Values reached through variables, spreads or
other unresolved source forms remain subject to runtime validation.

Name each member after the action its branch takes, and never use a word that
also reads as a verdict for a different branch. Rework is `fix` or `revise`,
never `correct`, `ok`, `right` or `fine`. Observed failure: a reviewer asked for
"an explicit verdict: pass, correct, or failed" wrote "Verdict: correct — no
actionable corrections required", meaning _the work is right_; its router then
chose the `correct` rework branch, and the workflow exhausted its correction
rounds without reaching final verification. Let a reviewer report findings, and let the router prompt define every
member by the condition that selects it (for example, `fix` when at least one
actionable finding remains).

An exact-choice answer is now read strictly, because there is nothing left to read
loosely: the child submits the value as the tool argument, so the member IS the
argument. The old text dialects — a bare word, a backticked word, a fenced block,
a `{"type":"string","value":"accept"}` schema echo — were readings a final MESSAGE
forced on the runtime, and they disappeared with that transport. A submission that
is not a declared member is a mismatch and is corrected in the same session.
The child sees each valid `{ value: ... }` tool argument for its declared choices.
It submits one exact string without a `{ choice, reason }` object, explanation, or
Markdown. The kickoff prompt for a choice call directs the child to the return
tool; its final message is not the accepted result. Plain-text calls still use
their final message. A choice recorded under an earlier return contract is a replay
`return-contract-changed` boundary and runs fresh rather than being silently reused.

## Cheap one-shot decisions without a second primitive

There is no direct model-call node. `llm(prompt, opts?)` existed until 0.2.x and was
removed: two model-calling surfaces forced an author to choose one before writing a
stage. The replacement for a gate or a classification is a choice child run:

```js
const gate = await agent(`Does this change need tool work? ${input}`, {
  label: "gate",
  choice: ["needs-work", "no-work"],
});
if (gate === "needs-work") {
  /* … */
}
```

That keeps one execution path, one journal shape, one option set, and one retry budget.

**Model and host permissions.** The manifest still declares `models: true`: child agent
sessions reach models through the host. Trusted workflow JavaScript can use
network-capable Node builtins or explicitly downgraded installed modules, so manifest
filesystem, subprocess, network and browser fields are conservative `*`/enabled
declarations. Those fields describe possible host capability; they do not add a DSL
primitive.

**Budget.** Each child run normally records token/cost `usage` on its `agent_end` journal
line. If artifact adoption throws after the child answered, the sole terminal `error`
line carries the same usage; transport errors that never produced an answer carry none.
`/workflows status` sums both executed terminal shapes per run (`tokens=… cost=$…`).
Observational only — there is no hard cap.

**Replay across this release.** The return contract is now v3. See the single
[release-boundary account](recovery-and-continuation.md#replay-across-this-release-boundary)
before resuming an older run.

---

## Agent execution reports

`await dsl.agent(prompt, { result: "report", label: "review" })` returns opaque host-rendered text. The child still writes ordinary narrative. A successful report includes its exact accepted answer and execution status. A captured failure includes the declared cause, summary, diagnostics and available artifact/trace pointers, without inventing an agent answer. This is an observation of a call, not acceptance of its findings or proof of task completion.

Use it when a substantive arbiter should receive a failed reviewer alongside successful checks. Forward whole reports in prompts. The arbiter evaluates findings, evidence and missing coverage, then recommends correction, another review, a disclosed limitation or a concrete stop. Preserve every failed/missing/skipped check in the downstream handoff. Ordinary `agent()` still returns exact text or throws; ordinary `parallel()` remains fail-closed. A parallel group of report-mode calls can return all eligible observations without dropping a failed sibling.

The initial capture set is deliberately narrow: terminal `failed`/`blocked` outcomes classified as `provider-error`, `empty-answer` or `answer-too-long`. Provider errors are observed on the first attempt; the transport retry option does not retry them. Inspect possible side effects before requesting another worker. A failed review was not completed, even if a downstream arbiter delivers a useful artifact.

Cancellation, unclassified/raw thrown errors, uncertain timeout/shutdown, global invocation/deadline limits, workspace/permission/operator failures, unavailable SDK, output protocol failures and persistence errors propagate. Failures classified on replayed answers also propagate: tightening the current answer bound cannot silently turn a previously successful review into a failure report and rerun the suffix.

`result` accepts only `"report"` or omission. It cannot combine with `choice` or `choiceFallback`; the removed shaped-result options are refused by name as they are for every call. Invalid declarations fail before child execution. Report mode does not impose an output schema or any answer limit. Author the option as the literal `result: "report"`. The source checker validates directly declared option pairs and keeps returned text opaque; it does not resolve option objects reached through variables or spreads. Runtime validation applies to every call.

The real child status and raw answer remain in journal/artifact/replay records. Captured failures remain replay `ok:false`, so resume reruns that call and the following suffix. Successful reports omit volatile run/call ids and live-only metadata, keeping their rendered bytes stable when the raw answer is replayed. A runtime log records when a failed child was captured as an observation. Reports do not change result/partial semantics or `consumeTextArtifact` admission: the latter still requires a successful source run and verified artifact provenance, not completed independent review.
