---
title: Agent results and output acceptance
type: guide
status: active
updated: "2026-09-13T00:12:23Z"
description: "Organize the installed workflow contract by reader task."
---

# Agent results and output acceptance

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

Audience: authors using a strict scalar or shaped result and bridge/host maintainers. This file owns the output API. It is no longer opt-in: same-session acceptance is the ONLY way a shaped value reaches workflow code. The text-parsed transport — a shape block appended to the prompt, the final message parsed as JSON, a fresh child spawned to repair the format — has been deleted. Plain `agent(prompt)` still returns the child's exact full text and is untouched.

`agent()` resolves to exact non-empty text. The runtime persists that text before
emitting terminal `agent_end`; fresh sessions also contribute their transcript
and result envelope. Child metadata and diagnostics stay in journal/result
evidence; plain model text is never parsed as status or JSON. A shaped call returns the
value accepted through the same-session `workflow_return` tool.

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
const route = await agent("Classify the candidate", {
  label: "classify",
  title: "Orders · classification",
  choice: ["dag", "not-a-dag", "unresolved"],
  repair: { maxAttempts: 3, clarification: "Reuse the existing evidence; correct the value only." },
});
const value = await agent("Return the exact identifier", {
  label: "identifier",
  // Both bounds name a real consumer: the identifier is one line in a status row, and
  // the record it is written into refuses more than 200 characters.
  output: { type: "string", singleLine: true, maxLength: 200 },
});
const verdict = await agent("Check the actual result against the original goal", {
  label: "verifier",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "summary"],
    properties: {
      decision: { type: "string", enum: ["complete", "needs-work", "unknown"] },
      // Present and non-blank, with no ceiling: nothing downstream breaks on a longer
      // summary, and the prompt is where its length is asked for.
      summary: { type: "string", minLength: 1, nonBlank: true },
    },
  },
  repair: { maxAttempts: 2 },
});
const units = await agent("Return complete independent work instructions", {
  label: "discover",
  // Counts, not sizes: zero units leaves the next stage nothing to do, and this caller
  // has exactly 20 workers to give them to. Drop `maxItems` when no such consumer
  // exists — a queue is not too long merely because it is long.
  handoffs: { minItems: 1, maxItems: 20 },
});
```

A shaped call declares exactly one of `choice`, `output`, `schema` or `handoffs`; declaring two is refused by name before any child starts. String output is nonblank; `singleLine` rejects line breaks, not every possible Markdown token. `maxLength` is an optional positive safe integer with **no package default**: omit it and the value is accepted at whatever length the work needs. Declare it only when a real consumer cannot take more — a status line, a filename, a field in someone else's record — because the number enters the child's contract as a promise, not as a guess. The outer tool/time bounds still apply.

`returnVia` is gone as a decision. `returnVia: "tool"` is accepted for one release and journaled as a redundant, ignored option; `returnVia: "text"` is refused by name, because it selects a transport that no longer exists.

`schema` uses the supported keyword subset and its validator. `handoffs` states an array of complete non-blank text units: `minItems` defaults to 0, `maxItems` may be omitted entirely, and there is no per-item character bound — `maxItemChars` is refused by name, because truncating one work unit to a guessed width destroys the work rather than protecting a consumer. A `maxLength` on a schema-shaped contract bounds the canonical JSON only when the author declared one; the runtime derives no allowance of its own and performs no size arithmetic before the call. The value is the JSON value itself: a string that contains JSON is a shape mismatch and is corrected in the same session, not parsed. No fence stripping or prose parsing exists anywhere on this path.

`repair.maxAttempts` counts submissions, including the first proposal or a turn with no proposal. It defaults to **2 — one proposal plus exactly one same-session correction turn** — and has no upper bound beyond being a positive safe integer. That default is visible, not hidden: every shaped call journals `[workflow:return] <label>: contract v2, N same-session clarification turn(s)` and says whether N is the package default or the author's declaration. Optional `clarification` is nonblank text of any length. Both option objects are closed. `validate` and transport `attempts` combine with shaped output normally; choice fallback exists only for `choice`.

The workflow child alone receives `workflow_return({ value })`. The closure, not tool arguments, owns this call's contract and identity. The tool accepts no file path, call ID or routing target. The first valid proposal is fixed; identical duplicates are idempotent, contradictory second proposals fail the call.

## Same-session lifecycle

The host creates one child session, performs the task and validates the tool proposal. Invalid tool calls receive feedback in that session. If the turn ends without a usable proposal, the host sends bounded clarification to the same session, reusing its history. No fresh worker or second logical workflow call is created for format repair.

After submission, and before a clarification prompt, the host narrows active tools to the return tool and verifies readback. Changes apply to the next model turn: this is not a sandbox, does not roll back a dispatched tool batch, and does not provide exactly-once external effects. Unsupported tool-set readback/restriction fails before the first prompt with `output-contract-unavailable`; there is no silent fresh-session fallback.

Tools, assistant turns and the wall-clock deadline accumulate across clarification. The original outer workflow timeout remains armed. A candidate is committed only when the child finishes successfully; a provider error, cancellation, timeout or budget failure after a proposal still fails. The session is disposed once.

Assistant turns are SDK model cycles (`turn_start`), including normal tool use
before the first proposal. The same cumulative `maxTurns` limit applies to plain
text and tool-return children; `repair.maxAttempts` separately limits output
submissions. A long review can exhaust turns without ever calling
`workflow_return`. Inspect its transcript before diagnosing a format-repair loop.

Format repair is not semantic retry: a record with the right shape is not evidence that its facts are right. A required verifier stays required, and content review is a separate agent call with the original goal and exact feedback, never a hidden continuation of shape clarification.

When an array or object container has the wrong type, correction feedback shows
the raw `value` container syntax.
The agent must fill that container with its existing schema-matching content;
the host never parses a JSON string into an accepted array or object. Correction
examples do not change the initial prompt or the completed-call replay key.

There is no fresh-session shape repair left to fall back to: `choice`, `handoffs`, `output`, `schema` and `schema + validate` all correct the format inside the child that produced the value. Ordinary text calls are unchanged. A semantic `continue` still requires a new worker call and a new conversation.

## Canonical value and evidence

The SDK emits canonical JSON for the accepted value (scalar, object or array); runtime checks that boundary and returns the exact value to workflow code. Identical duplicates are identical canonical JSON; a second proposal with different bytes is a conflict. The ordinary run-owned artifact store records those canonical answer bytes, independently of the model's final narrative. Source does not need filesystem access to persist an accepted value.

`agent_end.outputAcceptance` contains `{ source: "tool", toolName: "workflow_return", attempts }` only on success. `callId`, child session evidence and group `itemPath` bind it to the execution. Missing fresh-execution acceptance receipts fail closed. Replayed calls use recorded validated canonical answers and existing replay provenance; they do not invent a new session receipt.

Choice decisions emit a runtime journal log with `message: "[workflow:choice]"` and `choiceDecision`: `value`, `source: "validated" | "fallback"`, `returnVia` (always `"tool"` on a fresh run; `"text"` appears only in journals written before the text transport was deleted), optional attempts and fallback reason. The transcript shows the source, transport and attempts. Fallback is not ordinary model judgment.

An explicitly declared `choiceFallback` in tool mode applies only to `output-contract-exhausted`. It never turns provider, authorization, cancellation or infrastructure errors into `not-a-dag` or another domain decision. With asymmetric false-negative costs, select an explicit uncertainty value or fail closed. A valid negative classification may still require semantic re-review; output acceptance proves shape, not truth.

## Deliberate limits

This is a shape acceptance boundary, not a new domain-record database. The source archive does not contain the review's private Airflow catalog workflow/composer, so this change does not claim to migrate that workflow. A catalog needs owner-defined `candidateKey → dagRef → fieldKey`, a complete expected-key set and separate states for unknown, absent, failed and skipped. Do not correlate multiple DAGs by comma-separated position. Use accepted values/evidence as the input to that separately owned integration; an agent-written file is not authoritative merely because its returned value was valid.

A conflicting second accepted proposal has `output-contract-conflict`, not exhaustion; it never selects choiceFallback. An explicit `repair` object must supply `maxAttempts`.

## Command completed, answer rejected

Observed failure: a catalog composer wrote its output, then returned
`{"type":"string","enum":["success","failed"]}`. This lists choices but selects
none. The runtime must reject it; accepting the first enum member would invent
success. A file left on disk does not resolve the missing decision.

For agents that execute commands or write files, use the existing tool return:

```js
const result = await agent(
  'Run the command once. Call workflow_return({value:"success"}) only after exit 0; otherwise submit {value:"failed"}. Correct the answer format using the same command evidence, without repeating the command.',
  {
    label: "compose",
    title: "Compose output files",
    choice: ["success", "failed"],
    repair: { maxAttempts: 2 },
  },
);
if (result === "failed") throw new Error("Composition failed or was not confirmed; output files may exist.");
```

The success condition and `label` are authored for the actual stage. The portable
rule is same-session format correction with no fabricated fallback. Validate the
example's actual emitted options, a schema-only echo followed by a corrected value,
and repeated invalid values. Mock graph and syntax checks alone cannot prove model
compliance. A simple narrative lookup still uses plain `agent(prompt, { label, title })`;
do not add tools or extra verification agents to it.

**Replay across this deletion.** The shaped-return version and removed per-child
budget defaults are independent changes to request identity. See the single
[release-boundary account](recovery-and-continuation.md#replay-across-this-release-boundary)
before resuming an older run; plain-text calls can also require fresh execution.

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
branch would be inventing a policy the consumer never asked for. It cannot be
combined with `schema`, `handoffs`, `output` or `validate`. The members travel in
the return contract, and the child selects one through the acceptance tool. An
optional `choiceFallback` must exactly equal one declared choice. The runtime
returns it only after the in-session contract is exhausted, records a runtime-owned
journal line with the validation errors, and never masks child execution or
transport failures. Standard generated workflows use this form for machine routing
and exact text for every narrative result.

An exact-choice answer is now read strictly, because there is nothing left to read
loosely: the child submits the value as the tool argument, so the member IS the
argument. The old text dialects — a bare word, a backticked word, a fenced block,
a `{"type":"string","value":"accept"}` schema echo — were readings a final MESSAGE
forced on the runtime, and they disappeared with that transport. A submission that
is not a declared member is a mismatch and is corrected in the same session.

## Standard dynamic decomposition — `agent({ handoffs })`

Use `handoffs` when a discovery agent must define bounded runtime work units for
visible downstream workers:

```js
const MAX_DAGS_IN_SCOPE = 12;
const dags = await agent("Return one complete text handoff per DAG.", {
  handoffs: { minItems: 1, maxItems: MAX_DAGS_IN_SCOPE },
});

const descriptions = await parallel(
  dags.map((dag, index) => () => agent(`Describe this exact DAG:\n${dag}`, { label: `describe-${index + 1}` })),
);
```

Both bounds are optional. `minItems` defaults to 0 and cannot exceed `maxItems`;
`maxItems` may be omitted entirely, and then the call accepts as many units as the
work has. There is no per-item character bound: `maxItemChars` is refused by name,
because a handoff is one complete work unit and truncating it to a guessed width
destroys the work rather than protecting anything. Runtime requires every returned
member to be non-blank, then states the declaration as the equivalent array shape in
the return contract. Its prompt, same-session corrections, replay key, journal
evidence, budget accounting, and fail-closed error are therefore the ordinary shaped
path. Workflow JavaScript receives `string[]`; it does not parse model prose or own a
domain schema. Declare `maxItems` only when the CONSUMER genuinely cannot take more —
a fixed number of downstream slots, for instance — not as a general tidiness target.

`handoffs` enables dynamic fan-out but not recursive manager delegation. SDK
children still cannot call `spawn_agent` or `task`; the approved source must
show the downstream `parallel()`/`pipeline()` calls and their agent identities,
inputs, outputs, and edges.

## Advanced compatibility: shaped answers — `agent({ schema })`

This is the **value** half of [the two retries](outcomes.md#the-two-retries-and-which-failure-each-one-owns)
above: the repair loop for a child that answered off-shape. The transport half
(`attempts`) never reaches this code, and this loop never re-asks a child that failed
to answer.

The exact-text default is the contract for narrative results, `choice` is the
standard branch form, and `handoffs` is the standard bounded dynamic-list form.
Raw `schema` remains for reviewed compatibility scripts that genuinely need a
larger machine value:

```js
const gate = await agent(await promptFile("resources/gate.prompt.md", { diff }), {
  label: "gate",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      reason: { type: "string" },
    },
  },
});
if (gate.verdict === "fail") return { ok: false, summary: gate.reason };
```

What the runtime does, in order:

1. Recursively validates the declaration before any child starts. The only
   supported keywords are `type`, `enum`, `required`, `properties`,
   `additionalProperties:false`, `items`, the string bounds `minLength`,
   `maxLength`, `pattern`, and `nonBlank`, and the array bounds `minItems`,
   `maxItems`, `uniqueItems`, `uniqueTrimmedItems`, and `uniqueBy`;
   the only supported types are `object`, `array`, `string`, `number`,
   `integer`, and `boolean`. Unsupported types/keywords and malformed or
   misplaced declarations fail with zero child calls, as do a bound on the wrong
   type, a negative or non-integer bound, an unsatisfiable `min > max` pair, and
   a `pattern` that does not compile — an impossible contract must not burn every
   retry and then surface as an unexplained exhaustion. `pattern` follows the
   JSON Schema spec: an unanchored ECMA-262 search with no flags, so a schema
   that means the whole value writes `^`/`$` itself.

   The uniqueness and blankness keywords carry their own placement rules, all
   refused before the first child call:

   | Keyword                    | Where             | Requires                                                                                                                            |
   | -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
   | `nonBlank: true`           | a `string` schema | literally `true`                                                                                                                    |
   | `uniqueItems: true`        | an `array` schema | `items.type` is `string`, `number`, `integer`, or `boolean` — use `uniqueBy` for objects                                            |
   | `uniqueTrimmedItems: true` | an `array` schema | `items.type` is `string`; cannot be declared beside `uniqueItems`, which it already implies                                         |
   | `uniqueBy: "<property>"`   | an `array` schema | `items.type` is `object`, and the property is in `items.properties`, listed in `items.required`, and declared with a primitive type |

   `uniqueItems` is restricted to primitive items on purpose: deep equality over
   objects would be key-order sensitive, so duplicate detection would depend on
   the child's key order — and these messages enter the replay key. Requiring the
   `uniqueBy` property in `items.required` is what keeps "missing" from becoming
   a third, invented uniqueness verdict; a child that omits it is already told
   `missing required property`.

   **Trimming is `String.prototype.trim`.** That is the canonicalization both
   `nonBlank` and `uniqueTrimmedItems` use. Declare `uniqueTrimmedItems` whenever
   the script trims labels afterwards, or a value the validator accepted can
   still collapse into a duplicate in the normalizer.

2. Registers the `workflow_return` acceptance tool for this one child and appends
   a deterministic contract block naming it, the declared shape, and how many
   same-session correction turns the child gets. If the transport cannot register
   that tool and read the active tool set back, the call is **refused before the
   child starts** with a named capability error — there is no text fallback to
   quietly degrade into.
3. Runs the child exactly as an ordinary `agent()` call — same catalog agent,
   same capability options, same live row, same `agent_start`/`agent_end` lines.
4. Takes the value the child submitted to the tool — the argument IS the value, so
   nothing is parsed out of prose — and validates it with the DSL's JSON-Schema
   subset validator:
   `type` (object/array/string/number/integer/boolean), `required`, `properties`,
   `additionalProperties:false`, `items`, `enum`, the size/pattern bounds, and
   the uniqueness/blankness keywords. Bound violations are reported by value
   (`tags: expected at most 2 item(s), got 3`) because the child has to decide
   what to cut. Uniqueness runs after the per-element pass and compares only
   elements whose runtime type matches the declared one, so a wrong-typed element
   reports its type error and nothing else. Every later duplicate is reported at
   its own index and names the first occurrence, so the child knows which of the
   two to edit:

   - `uniqueItems` — `dependsOn[2]: value "F1" duplicates item 0`
   - `uniqueTrimmedItems` — `options[1]: trimmed value "Keep" duplicates item 0`
   - `uniqueBy` — `findings[3].id: value "F1" duplicates item 0`
   - `nonBlank` — `prompt: expected a non-blank string, got 3 whitespace character(s)`
     (the count, not the value: a blank string can be hundreds of characters, and
     echoing them would splice junk into the retry prompt)

5. When the call declared `validate`, calls it with the schema-valid value. It
   never runs on a child that failed, returned empty text, or submitted a value
   that did not validate — a cross-field rule presupposes the shape holds, so
   author code never receives an off-shape value. A non-empty return is a
   mismatch owned by the script.
6. On mismatch, asks the **same child** to correct it: the errors come back as the
   tool result, the session keeps its context, and the child submits again. The
   package default is exactly one such correction turn; `repair.maxAttempts` raises
   it, and the applied number is journaled on every shaped call, so it is a stated
   default rather than a hidden one.
7. Resolves to the validated value, or throws `SchemaValidationError` carrying
   `errors` and `attempts`.

**The host cannot force the child to answer in shape; acceptance enforces it
inside the session.** The Pi agent-session surface exposes no forced tool choice,
so the contract block is advice and the tool's accept/reject boundary is the actual
contract — but a rejection now costs a turn in the session that already holds the
work, not a fresh child that has to redo it. Practical consequence for authors:
keep shaped stages closed (`enum`, `additionalProperties: false`, few required
fields), because a wide schema is where a weak model spends its correction turns.

**Fail closed.** There is no partial and no untyped fallback: either the value
validated, or the call throws. Inside `parallel()` / `pipeline()` the throw
becomes ordinary typed branch evidence and the group rejects after the barrier.
A child run that itself fails or returns empty text still throws
`WorkflowAgentExecutionError` and does **not** consume a schema retry.
The text options type has `schema?: never`; supplying a schema selects the
schema-required overload, so a shaped object cannot be returned under a string
type.

**Evidence.** Every attempt stamps `schemaValidation`
(`{status: "valid"|"mismatch", attempts, errors}`, plus `source: "schema" |
"script"` on a mismatch when the call declared `validate`) on its own `agent_end`
journal line, so a run's evidence shows whether a stage was shape-checked, which
authority rejected it, and how many submissions it took. The `coercion` stamp is
gone with the text transport — a tool argument needs no dialect reading — and
survives only as a readable field on journals written before the deletion. `attempts` is the 1-based loop
position of the attempt, not a count of live child runs: a replayed attempt
occupies an ordinal and increments it while contributing no `usage`. Each attempt
counts against `maxTotalAgentInvocations`; a call without `schema` counts exactly
once, as before.

## Advanced compatibility: `agent({ schema, validate })`

`schema` constrains one node. Referential integrity, agreement between two
fields, a budget summed across items and the shape of a graph are joins over the
whole answer, and teaching the validator to express them would grow the runtime a
general-purpose constraint language. `validate` is the alternative: the script
keeps the rule, and the runtime lends it the retry loop.

```js
const plan = await agent(prompt, {
  schema: PLAN_SCHEMA,
  // A per-call-site closure: the rule is checked against data the host owns.
  validate: (value) => findingPlanErrors(findings, value),
});
```

The contract:

- **It runs after schema validation succeeds, on the parsed value**, inside the
  same attempt and before `agent_end`.
- **It returns `string[]`; empty means pass.** It must not throw to signal a
  violation and must not return a transformed value — the call still resolves to
  the validated, untransformed value. Accumulate: with one retry, reporting only
  the first violation turns a repairable answer into a fatal one.
- **Its errors reach the child in their own labelled block**, never merged into
  the schema bullet list. Write them in the runtime's convention — 0-indexed JSON
  path, observed value, what would satisfy it:

  ```
  The previous answer (attempt 1 of 3) matched the required shape but was REJECTED by the workflow script for:
  - findings[0].dependsOn[0]: value "F9" is not a finding id in the review
  Return the corrected JSON value only.
  ```

- **It requires `schema`.** `validate` without one is a type error and a runtime
  error before any child runs, because the text overload has no parsed value to
  hand it; a non-function `validate` is refused the same way.
- **It must be pure, synchronous and deterministic.** A synchronous `string[]`
  return makes `await` impossible, and clock or randomness reads in the entry file
  already downgrade the script to `unproven`. Filesystem and network reads are
  **not** detectable and are forbidden by this contract. Calling back into the DSL
  throws: `agent() must not be called from inside a validate callback`.
- **The runtime checks the TYPE of what it returns**, not its size: a `string[]`
  with no empty string and no Promise. There is no cap on how many errors a
  validator may report or how long one may be — accumulating every violation is
  exactly what makes a repairable answer repairable, and a runtime that truncated
  the list would silently rewrite the replay key. A non-list, a non-string member
  or a blank message fails the run closed and spends no retry.
- **A throw is an author bug, not a model failure.** It propagates unchanged, ends
  the run, consumes no retry, and is journaled as `{kind: "error", source: "script"}`.

**What must NOT go in a validator.** A re-ask is safe only where the model's one
satisfying move is to comply — a membership, uniqueness, sum or graph re-check
over data the model does not control. Two classes can be talked past and must
stay fatal throws:

1. **Self-reported status** — the check accepts the model's word about something
   the host did not verify (`a verification pass cannot override failed
repository checks`). The repair bullet tells the model _why_ its success claim
   was refused, which is coaching toward a claim the host accepts.
2. **Verdict coherence** — a model's verdict graded against its own findings
   list ("a `revise` verdict requires at least one finding"). Re-asking offers two
   satisfying moves, fabricate a finding or flip the verdict, and both destroy the
   signal.

Host-owned continuation and provenance evidence, and text a _prior_ run's agent
wrote, are likewise not this child's to repair and stay fatal.

**Replay policy.** `validate` never joins the canonical request — `JSON.stringify`
drops functions silently, so including it would produce an identical key for two
different validators with no divergence signal. Its _body_ is covered instead: the
entry bytes are hashed and any change refuses the whole resume. It **is** re-applied
to replayed answers, held to the caller's current rule; and when the current validator rejects a replayed answer the run **fails closed**
rather than re-asking. Re-asking would form an attempt-2 prompt whose key misses at
that ordinal, trip the one-way divergence latch and silently convert the operator's
resume into a full live run. Because the error strings are spliced into the retry
prompt, they enter the replay key: a `Set` iteration order, a timestamp or an
absolute path in a message is a replay defect, not a cosmetic one.

---

## Cheap one-shot decisions without a second primitive

There is no direct model-call node. `llm(prompt, opts?)` — one pi-ai
`completeSimple` / `streamSimple` completion with no child session and no tools —
existed until 0.2.x and was removed: two model-calling surfaces forced an author to
choose one before writing a stage, and a reused catalog agent constrained to a fixed
answer shape is not meaningfully more expensive than a direct call.

The replacement for a gate, a classification, or a short draft is a shaped child run:

```js
const gate = await agent(`Does this change need tool work? ${input}`, {
  label: "gate",
  schema: { type: "object", required: ["needsWork"], properties: { needsWork: { type: "boolean" } } },
});
if (gate.needsWork) {
  /* … */
}
```

That keeps one execution path, one journal shape, one option set, and one retry
budget. See [shaped answers](#advanced-compatibility-shaped-answers--agent-schema) for the full contract.

**Model and host permissions.** The manifest still declares `models: true`: child
agent sessions reach models through the host. Separately, trusted workflow JavaScript
can use network-capable Node builtins or explicitly downgraded installed modules, so
manifest filesystem, subprocess, network and browser fields are conservative
`*`/enabled declarations. Those fields describe possible host capability; they do not
add a DSL primitive.

**Budget.** Each child run normally records token/cost `usage` on its `agent_end`
journal line. If script validation or artifact adoption throws after the child
answered, the sole terminal `error` line carries the same usage; transport errors
that never produced an answer carry none. `/workflows status` sums both executed
terminal shapes per run (`tokens=… cost=$…`). Observational only — there is no
hard cap.

---

## Agent execution reports

`await dsl.agent(prompt, { result: "report", label: "review" })` returns opaque host-rendered text. The child still writes ordinary narrative. A successful report includes its exact accepted answer and execution status. A captured failure includes the declared cause, summary, diagnostics and available artifact/trace pointers, without inventing an agent answer. This is an observation of a call, not acceptance of its findings or proof of task completion.

Use it when a substantive arbiter should receive a failed reviewer alongside successful checks. Forward whole reports in prompts. The arbiter evaluates findings, evidence and missing coverage, then recommends correction, another review, a disclosed limitation or a concrete stop. Preserve every failed/missing/skipped check in the downstream handoff. Ordinary `agent()` still returns exact text or throws; ordinary `parallel()` remains fail-closed. A parallel group of report-mode calls can return all eligible observations without dropping a failed sibling.

The initial capture set is deliberately narrow: terminal `failed`/`blocked` outcomes classified as `provider-error`, `empty-answer` or `answer-too-long`. Provider errors are observed on the first attempt; the transport retry option does not retry them. Inspect possible side effects before requesting another worker. A failed review was not completed, even if a downstream arbiter delivers a useful artifact.

Cancellation, unclassified/raw thrown errors, uncertain timeout/shutdown, global invocation/deadline limits, workspace/permission/operator failures, unavailable SDK, output protocol failures and persistence errors propagate. Failures classified on replayed answers also propagate: tightening the current answer bound cannot silently turn a previously successful review into a failure report and rerun the suffix.

`result` accepts only `"report"` or omission. It cannot combine with `choice`, `choiceFallback`, `handoffs`, `schema`, `validate`, `returnVia`, `output` or `repair`. Invalid declarations fail before child execution. Report mode does not impose an output schema or any answer limit. Author the option as the literal `result: "report"`. The source checker validates directly declared option pairs and keeps returned text opaque; it does not resolve option objects reached through variables or spreads. Runtime validation applies to every call.

The real child status and raw answer remain in journal/artifact/replay records. Captured failures remain replay `ok:false`, so resume reruns that call and the following suffix. Successful reports omit volatile run/call ids and live-only metadata, keeping their rendered bytes stable when the raw answer is replayed. A runtime log records when a failed child was captured as an observation. Reports do not change result/partial semantics or `consumeTextArtifact` admission: the latter still requires a successful source run and verified artifact provenance, not completed independent review.
