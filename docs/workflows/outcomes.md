---
title: Agent outcomes, failures and retries
type: guide
status: active
updated: "2026-09-13T00:12:22Z"
description: "Organize the installed workflow contract by reader task."
---

# Agent outcomes, failures and retries

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Returned outcome contract

After the JSON detach boundary, root runs, direct `parallel()` branches, and
direct `pipeline()` stages use one classifier. A value that cannot cross
`prepareWorkflowResult()` JSON detachment fails separately at the group
boundary; examples include unsupported `BigInt`, circular values, and throwing
`toJSON`. This preparation diagnostic is not a fourth semantic kind. For a
successfully detached object, semantic failure holds when any of these exact
conditions is true:

```text
ok === false
partial === true
status === "failed" | "blocked" | "cancelled"
```

The checks are additive and context-independent. For example,
`{ status: "blocked", summary: "Owner decision required" }` fails at the root
and inside a group; `{ partial: true }` also fails in both places. The runtime
classifies the detached value returned by `prepareWorkflowResult()` in both
contexts. Group failure slots keep the original raw branch or stage value as
evidence; the root keeps its detached result. A failure `status` remains domain
detail, while the durable workflow disposition is `failed`. Missing fields,
non-boolean `ok`/`partial`, and other status strings retain legacy success
semantics.

This is a one-way compatibility change. A direct group value with
`partial:true` previously resolved as success and now rejects with typed group
failure. A root value with a failure `status` previously completed and now
fails. A direct non-JSON-safe branch or stage value could previously pass the
group barrier and now fails closed as a typed boundary error. Direct or root
`ok:false` was already failure and remains unchanged.

## Group failure contract

`parallel()` and `pipeline()` are fail-closed full barriers. They let already
scheduled independent siblings settle before reporting the group outcome. If
every slot succeeds, both primitives preserve input order and return the same
success arrays as before; an explicitly fulfilled `null` is a valid value.

An ordinary branch or stage fails when it throws, when its **direct return
value** cannot cross the JSON preparation boundary, or when the successfully
detached value matches the shared returned-outcome contract above (`ok:false`,
`partial:true`, or a failure status). Preparation failure remains separate from
the exact three-kind semantic classifier.
`pipeline()` stops later stages for that item while other items continue to the
barrier. After the barrier, either primitive rejects one
`WorkflowGroupFailureError` with stable `code: "WORKFLOW_GROUP_FAILURE"`,
`groupKind`, `groupId`, `total/completed/failed`, ordered `slots`, ordered
`partialResults`, and indexed `failures`. A pipeline failure also carries
`stageIndex`; a returned failure may carry its `status`.

Use `error.slots` as the unambiguous in-memory view. A fulfilled `null` is
`{ index, status: "completed", value: null }`; a thrown position is
`{ index, status: "failed", failure }` with no value. `partialResults` is only a
convenience view: thrown positions appear as `null`, while directly returned
failure records stay inspectable in their failed position.

`WorkflowInvocationCapError` is the deliberate exception to group capture. It
remains a separate hard run-level failure rather than becoming partial branch
evidence.

If the script does not catch this typed error, `runWorkflowScript` persists a
JSON-safe `WorkflowGroupFailureEnvelope` as `result`. It contains counts, slot
status, and failure metadata but omits potentially non-JSON-safe branch values;
both the inner failure envelope and the outer run have `ok:false`. The failed
`group_end` line records the actual completed/failed counts, and no tool,
command, live, status, or `result.json` surface may project the run as success.

Partial continuation is an explicit author decision, not the default. Catch only
the stable code, rethrow every other error, inspect `slots`/`partialResults` in
memory, and return a JSON-safe top-level result with `partial:true`:

```js
try {
  const results = await parallel(thunks);
  return { ok: true, results };
} catch (error) {
  if (!error || error.code !== "WORKFLOW_GROUP_FAILURE") throw error;
  return {
    ok: false,
    partial: true,
    completed: error.completed,
    failed: error.failed,
    failures: error.failures,
  };
}
```

The runner treats `partial:true` as non-success even if `ok:false` is omitted.
Workflow scripts are trusted JavaScript, so the runtime cannot forbid a broad
catch; the typed check and explicit partial marker are the supported authoring
contract, not an enforcement or security boundary.

Standard workflows inherit the full host-exposed tool surface and the parent
permission mode; agent catalog roles choose prompt/model identity, not
capabilities. `workspaceMode` expresses filesystem isolation intent for review
UX. It is not authorization, a sandbox, or a tool allowlist.

An assistant turn that ends with provider `stopReason=length` is not exact text:
the provider stopped at its output-token limit. The host therefore fails that
agent call as `provider-error` and preserves the transcript evidence instead of
publishing the partial answer or passing it to the next workflow stage.

Per-child spend controls are defined in the [budget policy](budgets.md#run-budget).
An explicit per-call value overrides its run-level value; increases are journaled.
The root launch mode selects the shared defaults, and saved children inherit them.

See [replay identity](replay.md#what-is-compared) and the
[release boundary](recovery-and-continuation.md#replay-across-this-release-boundary)
for how per-call budgets and the shaped-return version affect recorded calls.

`attempts` does not follow `timeoutMs`: it never joins the canonical
request, so a recording written before the option existed still replays, and a call
that adds a retry budget keeps the key it already had. The retry itself is invisible
to replay by construction — the replay envelope opens once per **logical** `agent()`
call, and every physical attempt inside it shares that one ordinal. Recording a
discarded attempt at its own ordinal would shift every later call on `--resume`, trip
the one-way divergence latch, and re-run the recorded suffix live.

## The two retries, and which failure each one owns

The runtime has exactly two retry loops, and they answer different questions. Neither
re-asks a child because its prose was thin: when an answer needs judging, the answer is
another agent whose job is that judgement.

| Loop                             | Question it answers                                             | Declared by                                    | Bound                                                                                                                  | On exhaustion                                   |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Value repair** (pre-existing)  | "The child answered — is the answer the declared choice/shape?" | `choice`, or advanced `schema` plus `validate` | one same-session clarification turn by package default; `repair.maxAttempts` sets more, with no package upper bound    | `SchemaValidationError`                         |
| **Transport retry** (`attempts`) | "Did the child get to answer at all?"                           | `attempts`                                     | exactly what the author declared — explicit only, with no package upper bound; an undeclared `attempts` is one attempt | the call fails closed with the last cause named |

The value repair is described under [exact choice](agent-results.md#standard-exact-choice--agent-choice)
and [advanced shaped answers](agent-results.md#advanced-compatibility-shaped-answers--agent-schema)
in the result contract. It stays inside the same child session — the previous validator errors come back
to the child as a clarification turn, so no fresh child is spawned to fix the shape of an
answer that already exists. The transport retry re-sends the **identical** prompt in a new
child, because there is nothing to repair: the child never answered.

The two do not multiply children. A shaped call declaring `attempts: 2` can run at most
two children, each charged to `totalAgents` with its own transcript and result envelope;
clarification turns happen inside whichever child answered. A transport budget exhausted
before an answer ends the run there rather than handing the acceptance path a rejected
answer — there is no answer to reject.

**Which failures the transport retry owns.** An allowlist of two named causes, not
"everything the never-retry list forgot":

| Cause                                                                      | Retried | Why                                                                                                   |
| -------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `host-turn-timeout`                                                        | yes     | the host's turn budget expired and the child was aborted                                              |
| `call-timeout`                                                             | yes     | the call's own `timeoutMs` fuse expired and the child was aborted                                     |
| `sdk-unavailable`                                                          | no      | there is no channel to re-ask on                                                                      |
| `cancelled`                                                                | no      | re-asking would override the operator                                                                 |
| `tool-call-budget`                                                         | no      | a fuse that re-arms is not a fuse                                                                     |
| `provider-error`                                                           | no      | provider-side, not a lost channel; classified, never guessed at                                       |
| `unparseable-answer`, `empty-answer`, `answer-too-long`, `script-rejected` | no      | the child **answered**; an empty or oversized answer is a decomposition signal, not a dropped channel |
| `unknown-agent`, `workspace-allocation`, `run-policy-blocked`              | no      | author or environment errors a retry would hide                                                       |
| `unclassified`                                                             | no      | nothing has shown this cause to be transient                                                          |

The cause is a machine-readable field on `agent_end`, set where each cause is known and
carried unchanged through the host, the run envelope and the bridge — and on the terminal
`error` line for `sdk-unavailable`, which never reaches an `agent_end` because it throws.
A result written
before the field existed reads as `unclassified` and never retries. Promoting a cause out
of `unclassified` is its own evidenced change, never a widening of the default.

**Which calls may declare it.** Ordinary project-workspace calls may declare
`attempts > 1`; every attempt receives the same full tool set. Calls bound to a
runtime worktree or `workspaceHandle` are refused because a later attempt would
inherit filesystem state from the earlier attempt. Nothing silently downgrades
the requested count.

**What the evidence shows.** Every physical attempt is a real agent call: its own `callId`,
its own `agent_start` and its own terminal record — an `agent_end`, or an `error` line when
the attempt **threw** instead of answering — both carrying `attempt`, `attempts` and the
`logicalCallId` of the one call they belong to, its own transcript
and result directories, and its own charge against `maxTotalAgentInvocations`. A
`[workflow:retry]` line names the boundary between attempts. The selected
execution's `outputs/README.md` grows a `## Retried agent calls` section listing
every attempt by `callId` with the discarded one's cause; an attempt that threw
is listed as `threw`. Root outputs live directly under
`.locus-pi/runs/<storageRootRunId>/`; child and resume-attempt outputs live in
their fixed nested execution directories. That
section reads both terminal kinds on purpose: a call that timed out, was re-run and then
threw leaves exactly one `agent_end` behind, and a report built from `agent_end` alone
would show a stage that ran twice and was billed twice as if it had never retried. A budget
blind to its own retries is a gate that does not count what it gates.

The per-call result envelope carries `failureCause` as well, so a reader who has only the
persisted `locus.agent.run-result.v2` body still gets the machine-readable cause rather than
the reason sentence. Where the workflow's own `timeoutMs` fuse ended the call, that is the
cause written into the envelope: the host reports the cancellation it observed, which is
true and is not the whole truth, and the caller that fired the fuse hands its classification
down before the envelope is written so the two most durable records of one call agree.

`logicalCallId` is what that section groups by, and it is not decoration: `parallel()`
can run two calls that agree on agent, label, phase and group, and their attempts then
interleave in the journal. A reader grouping by those descriptive fields would put one
call's discarded attempt under the other — a section that reads as evidence while being
wrong. The three fields travel together and the journal reader refuses a line carrying
one without the others.

**When the transport failure never becomes a result.** One cause cannot be retried and
cannot be reported as a failed call either: if the agent SDK substrate is unavailable
there is no channel to re-ask on, so the call **throws** and the run ends. There is no
`agent_end` for it. The terminal journal record is the `error` line, which carries
`failureCause: "sdk-unavailable"` for exactly that reason — so a reader never has to
tell that case apart from any other by reading the message text. The same line carries the
attempt trio whenever the call declared a budget, so an attempt already spent stays visible
even when the next one ends the run. The bridge decides to throw on that typed cause and
never on the diagnostic prose beside it.
