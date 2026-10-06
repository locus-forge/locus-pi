---
title: Agent results and output acceptance
type: guide
status: active
updated: "2026-10-06T05:00:00Z"
source_commit: "54dea11dbe11"
update_event: "user_request"
context: "task=T-144"
description: "Exact text and choice defaults, plus opt-in immutable structured results for trusted runtime source."
---

# Agent results and output acceptance

[Workflow documentation](index.md) · [Authoring guide](create.md) · [Operator guide](running.md)

Audience: workflow authors and bridge/host maintainers. This file owns the agent result API.

An `agent()` call supports these result contracts:

- **Plain text.** `agent(prompt)` resolves to the child's exact, full, non-empty final text.
  `result: "report"` is the same call observed as a whole execution report.
- **One exact choice.** `agent(prompt, { choice: [...] })` resolves to one declared string,
  submitted through the same-session `workflow_return` tool.

- **Structured JSON v4.** Reviewed trusted runtime source can opt into `schema`,
  optional synchronous `validate`, and a bounded `repair` allowance. It resolves to an
  immutable JSON value after raw-protocol validation, whole child completion and storage.
  The existing standard and orchestration-only source-check profiles still refuse these
  options; the create skills keep their current text/choice grammar.

Readable text remains the default. For shared reports or agent-owned product files, assign
exact destinations in prompts and pass those same files to their consumers. Native runtime
workspaces own coordination and navigation. The runtime persists every answer before
terminal `agent_end`; execution metadata and diagnostics stay in journal and result evidence.

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
const review = await agent(
  "Review the change and write findings to the exact review.md destination assigned in the whole input.",
  {
    label: "review",
  },
);
// One exact routing token, selected from the declared members.
const route = await agent(`Choose the next step from this review:\n${review}`, {
  label: "route",
  choice: ["accept", "revise", "blocked"],
  choiceFallback: "blocked",
});
```

`choice` selects the v3 routing contract. Its child alone receives
`workflow_return({ value })`; a plain child is never given that tool. The closure, not
tool arguments, owns the call's contract and identity; the tool accepts no file path,
call ID or routing target. The first valid proposal is fixed, identical duplicates are
idempotent, and a contradictory second proposal fails the call with
`output-contract-conflict`.

The choice v3 contract carries one package-owned same-session clarification: two submissions in
total, the first proposal plus one correction turn. Every choice call journals
`[workflow:return] <label>: contract v3, 1 same-session clarification turn(s) (package default 1)`.
The count is not configurable.

## Removed shaped-result options

These options were removed. Each one is refused **by name, before any child starts and
before the replay lookup**, with the replacement below. A fresh run and a resumed run whose
source still declares one fail with the same sentence, so an old shaped receipt is never
reinterpreted under the reduced contract.

| Removed                             | Use instead                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handoffs`                          | Have an agent write the exact caller-assigned destination in its prompt and return readable text; pass caller-owned work units through `items()`; or loop with a bounded `for` and route each pass with `choice`. |
| `output`                            | Drop it: plain `agent(prompt)` already returns the exact full text.                                                                                                                                               |
| `returnVia`                         | Drop it: a choice call always returns through `workflow_return`, and a plain call returns exact text.                                                                                                             |
| `maxAnswerChars`, `schemaMaxLength` | Both are refused by name; state a length requirement in the prompt.                                                                                                                                               |
| Fusion `schema`, `validate`         | The judge returns exact text; state the required format in the prompt, or have a later agent write the exact caller-assigned destination in its prompt from the judge's text.                                     |

Both source-check profiles also refuse `schema`, `validate`, `repair` and `outputTransport`: structured output is a
trusted-runtime capability in this release, outside their existing authoring grammar.

## Choice v3 same-session lifecycle

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

## Choice v3 canonical value and evidence

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

## Structured results v4 — trusted runtime source

```js
// Reviewed trusted Node workflow; neither source-check profile admits this yet.
const allowedIds = new Set(["record-17", "record-23"]);
const record = await agent("Return one authoritative record id from the supplied evidence.", {
  label: "record",
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  validate: (value) => (allowedIds.has(value.id) ? [] : ["Use an authoritative input id"]),
  repair: { maxAttempts: 2 },
});
```

`schema` selects v4. `validate` or `repair` without it fails before a child exists.
It cannot combine with choice, fallback or report mode. `output`, `returnVia` and
`handoffs` remain removed aliases. Text, report and choice v3 defaults, return types
and canonical replay keys remain unchanged.

**Host boundary.** V4 uses the existing Pi coding-agent SDK `openai-codex` Responses
route, with Pi **>=1.0.0 and actual raw/admission/tool/cancellation capabilities**.
Other routes and older hosts fail `output-contract-unavailable` before prompt.
Version alone is insufficient: callbacks must be installable and chainable, active-tool
restriction must round-trip, and raw call identity/final arguments/terminal status must
remain observable. Legacy text and choice continue to load on Pi 0.84.3. This route is
a return tool with local validation; it does not inject a native provider schema or
force tool selection, and does not change the caller's model, authentication or permissions.

**Dialect `locus-json-subset-v1`.** Every schema node is an object with one string
`type`: `null`, `boolean`, `string`, `number`, `integer`, `array` or `object`.
Allowed keywords are primitive `enum`; object `properties`, `required`, boolean
`additionalProperties`; array single-schema `items`, `minItems`, `maxItems`; string
`minLength`, `maxLength`; number/integer `minimum`, `maximum`; and string `title` and
`description`. Optional `$schema` must be exactly
`https://json-schema.org/draft/2020-12/schema`. This named subset is not a full draft
implementation. Other keywords, unions, refs, patterns, formats, wrong placement,
invalid bounds or required keys outside properties fail `unsupported-schema` before work.

Object, array, scalar and null roots are supported. Omitted or true
`additionalProperties` preserves unknown keys; false rejects them. Declared properties
remain optional unless required. Array items may be omitted. String length counts
**grapheme clusters**, including a combining sequence or family emoji as one, matching
the tested TypeBox engine. Integer means a finite JS number with no fractional part;
it does not imply safe-integer precision. Encode exact large numbers or decimals as strings.
No coercion, null deletion, defaults, trimming, truncation or fence removal occurs.
The preflight gate verifies the supported route and writable/readable host hooks; actual
provider events and terminal observation remain necessary to accept a value. A future
host with a writable hook that never delivers events fails closed as unknown.
Schema validation uses lazy TypeBox Compile/Check/Errors after the host capability gate.

**Proposal and terminal evidence.** The only envelope is exactly `{value: JSONValue}`
in finalized raw tool arguments with observed call identity. Partial deltas and Pi's
repaired/normalized arguments cannot supply a proposal. Canonical JSON sorts object
keys, preserves array order and finite numbers, and treats -0 as 0. Null is a value,
not a missing proposal. Identical accepted duplicates are idempotent; different ones
fail `output-contract-conflict`. Schema, candidates and receipts are detached and frozen.

A completed tool proposal remains provisional until the whole child and required
storage finish. The nonempty response identity and complete terminal tool set must agree
with observed item IDs, call IDs, names and finalized raw arguments. Missing, additional,
renamed or changed terminal evidence cannot commit a value. A mixed return/work-tool batch
is one rejected submission: no sibling tool executes, in either order, and only the
remaining correction allowance is available. Research in earlier turns is unaffected. Repeated executable item-added/done frames
fail before tool dispatch; exact argument-finalization duplicates remain safe. Protocol refusal before or after a proposal is `output-refused`;
incomplete is `output-incomplete`; provider errors remain failures; lost terminal/raw
observation is `output-protocol-unknown`. None is inferred from English narrative or
converted into a success. A failed store has no authoritative structured receipt.

**Custom validation.** `validate(value)` is pure and synchronous, after schema validation,
on a detached deeply frozen input with monitored mutation attempts. It returns `[]`
to accept or nonblank error strings for same-session feedback. Throw, Promise/thenable,
malformed return, or mutation (even caught by the callback) is `author-validation-error`
without model repair. It is a predicate, not a transformer or security sandbox for
trusted Node code. ID membership and cross-field checks need authoritative caller data;
an accepted model assertion is not evidence that tests or required reviews happened.

**Allowances.** Default `repair.maxAttempts` is **2 submissions**, including the initial
one. An explicit positive safe integer changes it. Each distinct finalized return,
including one rejected by the host before execution, and each completed output turn
without a return consumes one slot. Partial events or repeated observations of the
same call id do not consume another. Ordinary research before the first return uses
the caller's ordinary budgets without spending output slots. After submitting, only
the return tool is admitted; missing returns in correction turns still consume slots.
The host's automatic loop and the outer clarification loop share that ledger and deny
further generation/dispatch at exhaustion. Already dispatched effects are not rolled back.

Corrections reuse the same child and remaining output/turn/tool/time allowances. The
existing transport `attempts` default remains 1. Explicit fresh retries still require
the existing eligible failure and workspace rules, consume a physical root invocation,
and retain one logical ledger and remaining declared timeout. V4 permits such a retry
only before any model turn has been dispatched: uncertain effects, refusal, schema,
author/configuration, cancellation and lost observation never earn a fresh child.
No new global turn/tool/time defaults or durable restart clock is introduced; omitted
axes remain unbounded. A new explicit run receives a new ledger and preserves earlier evidence.

**Replay.** Only a committed v4 receipt replays: exact contract/dialect/schema digest,
observer revision (`codex-responses-v3`), full source and caller-input identities, applied allowances, spent
counters, completed raw turn/call provenance, and schema/custom validation outcome must
agree. Changed validator/closure source or caller inputs refuses reuse. Uncovered
external callbacks/imports or non-replayable source cannot resume v4. The runner uses
conservative lexical coverage: source-declared functions and local aliases can be covered;
ambient/free callbacks, `globalThis`/`process`, reflection and nonliteral property indexes
are unproven. Callable coverage follows direct source functions and their local aliases, explicit DSL/intrinsic
operations and a named standard instance-method subset. Arbitrary member callbacks,
function parameters used as callees, call-returned callees and unproven callback arguments
are unavailable for replay. Mutations, spreads and opaque agent option objects are also
unproven in this subset. Source-owned object callbacks need a declaration on their actual
receiver. This can
refuse replay for otherwise valid trusted JavaScript; it does not restrict fresh execution
or establish a sandbox or a full JavaScript dependency proof. Current validation
runs again on immutable replayed data; mismatch or author errors are
`replay-contract-failure`, without correction or a new child for that failed call.
A rejected offered receipt is settled as failure, excluded from successful reuse
counts, and closes reuse of the remaining prefix even if trusted code catches the
error. A later ordinary call must run fresh; a confirmed interrupted-recovery
prefix refusal remains terminal for that controller. Missing/uncommitted receipts,
unknown effects or incomplete ledgers fail closed. Earlier `codex-responses-v1` and `codex-responses-v2` receipts
remain readable but cannot be reused: v1 does not prove exact terminal membership, and
v2 does not prove executable-frame multiplicity or unique work-call identities.
Repeated executable added/done frames and ambiguous call identities are rejected before
dispatch; matching argument-evidence and terminal repeats remain harmless. Mixed batches
are classified before proposal validation and consume one bounded correction allowance.
V2/v3 records are never upgraded.
A custom runtime embedder must supply verified source/input identities and a current host
version reader for v4 replay. Warm sessions and durable elapsed time across restarts are
outside this contract.

The existing child/result and replay stores retain the immutable receipt. The operational
`agent_end.outputAcceptance` is only `{source:"tool", toolName:"workflow_return", attempts,
contractVersion:4}`; raw arguments and full receipts are not copied into each journal event.

## Native structured results v5 — trusted runtime source

Trusted source can explicitly add `outputTransport: "native"` to the same
`schema`/`validate`/`repair` call. Omitting the selector retains v4, including its
canonical request and receipt bytes. Any other selector, or a selector without a
schema, refuses before child work. Choice, fallback and report cannot combine with it.
Both authoring checkers continue to refuse this runtime-only syntax.

```js
const result = await agent("Return an authoritative id from the supplied evidence", {
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  validate: (value) => (allowedIds.includes(value.id) ? [] : ["Use an authoritative id"]),
  outputTransport: "native",
});
```

**Route and wire.** This slice admits Pi >=1.0.0 with actual writable payload/raw,
pre-dispatch admission, active-tool readback/restriction and cancellation hooks.
The compatibility policy is the existing public `openai` / `openai-responses` route
at `https://api.openai.com/v1`, with IDs `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`.
Unknown IDs, snapshots, fine-tuned models, other APIs and proxies refuse. These are
synthetic compatibility tests, not live qualification or an entitlement claim.
The caller's model, host-managed authentication and permissions are unchanged;
authentication remains unverified. Provider denial is terminal with no fallback.

The inherited payload hook runs first. The runtime detaches JSON data before checking
the effective payload; accessors and executable serialization hooks cannot change
the dispatched model or format after validation. Undefined object fields use ordinary
JSON transport omission. The runtime then observes the effective
non-secret route and applies strict `text.format` named `locus_workflow_result`.
Conflicting format, model, stream or route changes refuse. Input, work tools,
verbosity and unrelated fields remain intact. Every supported canonical root uses
one closed required wrapper, exactly `{value: canonicalValue}`; no return tool is
registered. `$schema` metadata is removed only from the wire projection.

**Exact supported subset.** Native requires every object to be closed and require
all declared properties, and every array to have items. Non-null scalar/object/array
roots, matching primitive enums, numeric and array bounds retain their canonical
semantics. Root or nested null, incompatible/null enums, optional/open objects,
untyped arrays and string grapheme length bounds refuse before model work; they
are not rewritten into nullable fields or a different length rule. The provider's
schema limits include the wrapper: 5000 total properties, ten nesting levels,
120000 property/enum characters, 1000 enum entries, and 15000 characters in a
single string enum exceeding 250 entries. Exceeding a limit refuses rather than
truncates. See the [official supported-schema limits](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas).
There is no new global answer-size limit.

**Finalization and correction.** Matching raw created/completed response identity
and one completed assistant message with one complete output-text part are required.
Explicit `final_answer`, absent phase and null phase qualify. Commentary or unknown
phase terminates as `output-protocol-unknown` without correction; partials, readable
last text or a subset of several messages cannot authorize data. Raw phase is
preserved before session JSONL persistence and in the next correction input.
After inherited finish hooks, the live message, context history and returned messages
must still match that raw text and phase; a conflict terminates without relabeling.
Research work calls must appear exactly once in the completed terminal set, matching
observed unique item/call IDs, names and finalized arguments, before any tool executes.
Repeated work-item added/done frames fail because the SDK can dispatch them again;
matching argument-finalization and exact terminal duplicates remain idempotent.
Research work turns consume the existing turn/tool/time axes without spending an
output slot. The first native output restricts active tools to empty; correction
uses `tool_choice: "none"`. Unexpected correction calls have no effects and spend a
slot, as does a missing output. The shared schema-first synchronous custom validator,
immutable value, default two output attempts, same child feedback and cumulative
budgets remain unchanged. A valid last slot succeeds without another generation;
author errors, refusal, incomplete/error/disconnect, cancellation or lost evidence
are terminal. Whole child completion and successful storage still establish authority.

**Receipts and replay.** Native uses distinct v5 provenance: raw response/message,
text and original phase, payload-observed wire revision/schema digest and non-secret
route, plus existing source/input/schema/validation and allowance/spent evidence.
Native raw evidence uses observer revision `openai-responses-native-v2`; its wire
revision remains `openai-responses-native-v1`. Earlier native observer-v1 receipts
remain readable but cannot replay because exact research-tool membership was not proven.
Zero real tool calls are valid; no tool name or fictional return call is present.
The journal carries only `{source:"native", contractVersion:5, attempts}`.
Replay revalidates committed data and freshly resolves the existing current
selected/registry model and role mapping before any child, credential or network
work. It compares established provider/id/API/base facts to the recorded
payload-observed route, catching inherited model changes and same-role remapping.
Unknown, opaque custom routing or mismatches refuse without a paid fresh suffix.
This read-only comparison is not fresh post-auth endpoint or credential attestation:
Pi exposes no public secret-free accessor for that stronger claim. Host-managed auth
remains unverified. V4 receipts stay strict and neither version upgrades to the other.
Custom embedders need the current route port in addition to the v4 identity/version
ports. Source coverage, storage, retry and restart limitations remain the v4 contract.

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

**Replay across this release.** Choice uses v3; structured calls use a distinct v4 receipt. See the single
[release-boundary account](recovery-and-continuation.md#replay-across-this-release-boundary)
before resuming an older run.

---

## Agent execution reports

`await dsl.agent(prompt, { result: "report", label: "review" })` returns opaque host-rendered text. The child still writes ordinary narrative. A successful report includes its exact accepted answer and execution status. A captured failure includes the declared cause, summary, diagnostics and available artifact/trace pointers, without inventing an agent answer. This is an observation of a call, not acceptance of its findings or proof of task completion.

Use it when a substantive arbiter should receive a failed reviewer alongside successful checks. Forward whole reports in prompts. The arbiter evaluates findings, evidence and missing coverage, then recommends correction, another review, a disclosed limitation or a concrete stop. Preserve every failed/missing/skipped check in the downstream handoff. Ordinary `agent()` still returns exact text or throws; ordinary `parallel()` remains fail-closed. A parallel group of report-mode calls can return all eligible observations without dropping a failed sibling.

The initial capture set is deliberately narrow: terminal `failed`/`blocked` outcomes classified as `provider-error`, `empty-answer` or `answer-too-long`. Provider errors are observed on the first attempt; the transport retry option does not retry them. Inspect possible side effects before requesting another worker. A failed review was not completed, even if a downstream arbiter delivers a useful artifact.

Cancellation, unclassified/raw thrown errors, uncertain timeout/shutdown, global invocation/deadline limits, workspace/permission/operator failures, unavailable SDK, output protocol failures and persistence errors propagate. Failures classified on replayed answers also propagate: tightening the current answer bound cannot silently turn a previously successful review into a failure report and rerun the suffix.

`result` accepts only `"report"` or omission. It cannot combine with `choice`, `choiceFallback`, `schema`, `validate` or `repair`; the remaining removed aliases are refused by name. Invalid declarations fail before child execution. Report mode does not impose an output schema or any answer limit. Author the option as the literal `result: "report"`. The source checker validates directly declared option pairs and keeps returned text opaque; it does not resolve option objects reached through variables or spreads. Runtime validation applies to every call.

The real child status and raw answer remain in journal/artifact/replay records. Captured failures remain replay `ok:false`, so resume reruns that call and the following suffix. Successful reports omit volatile run/call ids and live-only metadata, keeping their rendered bytes stable when the raw answer is replayed. A runtime log records when a failed child was captured as an observation. Reports do not change result/partial semantics or `consumeTextArtifact` admission: the latter still requires a successful source run and verified artifact provenance, not completed independent review.
