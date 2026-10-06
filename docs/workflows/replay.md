---
title: Replay recorded workflow calls
type: guide
status: active
updated: "2026-09-22T17:02:17Z"
source_commit: "5365d3f8cd9c"
update_event: "cleanup"
context: "changes=XL files=46"
description: "Consolidate workflow contracts at their owning pages and repair outdated guidance."
---

# Replay recorded workflow calls

[Workflow documentation](index.md) · [Authoring guide](create.md) · [Operator guide](running.md)

## Resume and replay

`/workflows run <name> --resume <runId>` reruns the workflow against a recorded
run. Resume validates the persisted version-3 target, source identity coverage,
exact semantic input and caller items, and the native workspace's recorded path
and canonical physical identity. It preserves the recorded root lineage. Repeat
an explicit workspace selector exactly; a missing or changed selector fails before
child execution. Old output-format runs remain readable but require a fresh
migrated run before replay or recovery.

Ordinary repaired-source replay may use changed self-contained source at the
original target while reusing its unchanged labelled request prefix. The first
changed call makes the suffix fresh. Interrupted recovery instead requires its
original source and complete confirmed prefix; it refuses a mismatch rather than
re-executing that prefix. Neither route restores agent-written files. Every
`agent()` call whose **position** and **exact request** match the
record returns the recorded child text without spawning a child, so iterating on
the last stage of a long pipeline no longer pays for the earlier stages.

### What is compared

The key is the call's admission ordinal plus its canonical resolved request.
The runtime allocates one receipt before the first await and carries it through
transport retries and settlement. New version-4 replay records keep that ordinal
in `seq`, even when parallel children finish in reverse order. Reading uses the
stored ordinal, never the line's position in the file.
It includes the prompt, catalog `agent`, `maxToolCalls`, `timeoutMs`, `maxTurns`,
declared model and role selectors, `label`, `phase`, workspace and execution
identity, mapped item identity, and the `ask` declaration. A call that may block
on a live human answer never shares a record with one that may not. Display titles
are not execution identity; see [model routing](models.md#model-selection-execution-versus-metadata)
for the distinction between declared selectors and the model that actually ran.

A choice call includes its versioned `returnContract` in the canonical request.
It does not encode that contract by appending it to the prompt or parsing model
text. Same-session clarification stays within the same logical call and does not
create another replay ordinal. Transport retries also share that logical ordinal;
see [the two retry loops](outcomes.md#the-two-retries-and-which-failure-each-one-owns).

Structured calls also revalidate their committed receipt, full source and caller
input; native v5 evidence cannot be reused. Replay-log v4 is separate from tool
return-contract v4 and historical native return-contract v5. Native v5 evidence remains readable but cannot supply current tool acceptance or start a fresh retry. Structured intake detaches the
recorded evidence; its declared return-contract version must match the call.
Missing or unproven structured evidence refuses before child work, including
historical log-v3 identity misses. Retired-native evidence in log v3 refuses execution before any call, because its settlement order does not prove admission order; passive historical readback stays available.
If revalidation fails and the workflow catches it, subsequent prefix reuse still
stops: ordinary suffix calls run fresh and structured suffix calls refuse. Calls
already admitted concurrently retain their own settlement; this does not roll
back their effects. Groups drain their started branches before ending the run.

Each recorded agent line also carries a `node` name, `[phase, label, occurrence]`,
absent when the call had no `label`. It is the readable identity of the completed
prefix: `runtime/replay.ndjson` answers "which nodes finished" without the
workflow source, and the `replay` envelope reports `divergedAtNode`. It is not
the safety boundary — the key already carries `phase` and `label` — so a name
never contradicts a matching key on an unbroken prefix.

Replay is a **strict prefix**. The first call that does not resolve from the
record invalidates that call _and every later call_, including calls whose own
prompt did not change: a later recorded answer was produced after an earlier
answer that no longer exists, so reusing it would misreport what the run
observed. Every miss reason latches, not only a key mismatch — running a call for
real changes the world the later recorded answers came from.

### Continuing a repaired workflow

Changed source bytes do not end a resume. Repairing the stopped workflow in the
same file and continuing under the original run id is the supported path: the
completed nodes return their recorded answers, and the repaired node and its tail
run fresh. Once the bytes differ, the node name becomes mandatory — a call the
author never labeled cannot be located in a program that changed under it.

| Miss                           | Meaning                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `invocation-identity-unproven` | a legacy v3 record has completion order but no proven admission identity |
| `recorded-sequence-invalid`    | a recorded ordinal is duplicated or missing before later calls           |
| `no-record`                    | the record has no entry at this position                                 |
| `unnamed-node`                 | source changed and either the entry or the current call has no name      |
| `node-mismatch`                | source changed and the names differ                                      |
| `return-contract-changed`      | the recorded choice-return contract predates the current version         |
| `key-mismatch`                 | the resolved request differs from the recorded one                       |
| `recorded-failure`             | the recorded call failed; a failure is never served back as an answer    |
| `side-effecting-call`          | the call writes to a worktree, so its record cannot stand in for it      |
| `diverged`                     | the latch is already set by one of the above                             |

A `fusion()` group standing after the divergence point runs as an ordinary fresh
panel: the latch guarantees no later call can be served from the record, so every
leg is fresh and the panel takes its model preflight like any other fresh call.
What the panel still refuses is a MIXED set of legs — some recorded, some fresh —
before the divergence point, which ends the run with `fusion resume cannot mix
recorded and fresh agent calls`. The rule against mixing recorded and live answers
inside one panel is kept at the cost of that terminal error.

A panel served entirely from the record is not charged against `totalAgents` and
does not reserve against it: a replayed leg starts no child (see
`spendInvocation("replayed")`). Only a fresh panel reserves its worst case up
front, so a resume can replay a three-member panel under `totalAgents: 1`, and a
leg that diverges into fresh work still meets the cap at its own admission,
through the same `stopped by budget totalAgents` journal line.

The strict `orchestration-only` source mode requires every `agent()` call to
declare a unique literal `label`. That rule, not the recorded name, is what
prevents a deleted call site from handing its recorded answer to a twin sharing
its label.

### When replay is refused

Refusal is never silent — the reason is written to the journal and to
`result.json`, and the run executes normally.

| Reason                       | Meaning                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `source-run-unusable`        | the named run has no readable persisted script identity                                              |
| `target-changed`             | the persisted source target does not match the target selected for this resume                       |
| `identity-coverage-unproven` | the script declares `entry-only`, so imported bytes could move calls without changing the entry hash |
| `replay-unsafe-script`       | the AST found direct clock/randomness syntax (below)                                                 |
| `no-recorded-calls`          | the recorded run wrote no replay record                                                              |

### Replay-safety is scanned, not asserted

Ordinary resume still requires a trustworthy terminal result. Explicit
`recoverInterrupted: true` is a separate conservative structured-tool route for
a fully confirmed serial prefix and absent `result.json`. See [recovery admission](recovery-and-continuation.md);
corrupt results and uncertain effects are not automatically recovered.

There is no `meta.replaySafe` field, deliberately. An author assertion fails
open: a script that claims to be replay-safe and calls `Date.now()` would replay
answers produced in a different world and look green. Instead the same AST scan
that classifies import edges also looks for direct clock and randomness syntax.
Any hit makes the script `unproven`: it still runs normally, it is simply never
recorded and never replayed.

The nondeterministic roots are `Date.now`, `new Date(…)`, `Math.random`,
`performance.now`/`timeOrigin`, `crypto.randomUUID`/`getRandomValues`, and
`process.hrtime`/`uptime`. The scan folds these forms of reaching them:

| Form                                  | Example                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| direct member access                  | `Date.now()`, `Math.random()`                                                                  |
| computed member access                | `Date["now"]()`                                                                                |
| through the global object             | `globalThis.Date.now()`, `global.Date.now()`, `self.Math.random()`, `globalThis["Date"].now()` |
| a computed global member              | `globalThis[key].now()` — unfoldable, so always unproven                                       |
| construction, parenthesised or not    | `new Date()`, `new (Date)()`, `new globalThis.Date()`                                          |
| a fresh binding for the root          | `const d = Date`, `const { random } = Math`, `m = Math`                                        |
| a named `node:` import                | `import { randomUUID } from "node:crypto"`, `import { performance } from "node:perf_hooks"`    |
| a default or namespace `node:` import | `import c from "node:crypto"` — the module is renamed, so it is flagged wholesale              |

That last pair matters more than it looks: `node:` specifiers are exactly what
keeps a script `self-contained-static`, so an ESM import of `randomUUID` would
otherwise be the one bypass the identity gate actively invites.

**What the scan still cannot see.** It reads syntax, not behavior, so it is a
filter and not a proof:

- access assembled at runtime — `globalThis[k]` where `k` is computed elsewhere,
  `Reflect.get`, or a root threaded through a function parameter or property bag;
- a nondeterministic value smuggled in through `process.env`, `argv`, or a file;
- anything inside an imported module — which is exactly why `entry-only`
  coverage counts as unproven and is never recorded at all.

So the honest claim is narrower than "replay is proven safe". The gate that
actually prevents a wrong replay is the per-call request key plus the prefix
latch above: nondeterminism that reaches a prompt, or that changes call order or
count, produces a key mismatch and fails closed. This scan reduces how often that
gate is the only thing standing, and it errs toward `unproven` — a false positive
costs a cache miss, a false negative would replay an answer from a different
world. Reach for `dsl.now()` / `dsl.random()` and the question does not arise.

The folded forms above are each covered by a case in
`tests/extensions/workflows/runtime/workflow-replay.test.ts` (`static replay-safety
assessment` and `replay-safety bypasses are refused end to end`).

### A replayed run is always marked

A replayed call is recorded evidence, not fresh evidence, and every surface says
so:

- `journal.ndjson` — `agent_start` / `agent_end` carry `replayed: true`.
- `result.json` — a `replay` envelope with `replayed`, `recorded`, `sourceRunId`,
  `refusedReason`, `notRecordedReason`, `replayedCalls`, `freshCalls`,
  `divergedAtCall`, and `divergedAtNode`.
- `/workflows status` — `replayed=<n>` on the run row, and a detail line reading
  `N/M agent call(s) reused a recorded run — not fresh evidence`.
- the live progress panel — `replayed=<n>` in the header.
- `/workflows status <runId>` timeline — `[replayed]` on the agent rows.
- the bounded command/tool lifecycle digest — `[replayed]` on the agent lines and
  `N replayed from a recorded run` on the final line. This is the one workflow
  surface that enters LLM context, so a model reading it cannot mistake recorded
  evidence for work that just happened.

A replayed call reports **no** token usage, so the run budget shown by
`/workflows status` counts only work that actually happened.

### Limits, stated plainly

- **Replay reuses answers, not side effects.** A child that wrote a file on the
  first run does not write it again. Calls that ran under a worktree
  (`workspaceMode` other than `project`, or any `workspaceHandle`) are therefore
  never replayed even on a clean key match; they re-run. For a
  `project`-mode child that wrote a file, the marking above is the mitigation,
  not a guarantee that the filesystem still matches.
- **A replayed call does not re-read either — its answer describes the tree as
  it was.** Replay is keyed on `(ordinal, resolved request)` and never on the
  state the child read. This is the sharper edge of the bullet above, because it
  bites in exactly the scenario `--resume` exists for: you changed something and
  want to rerun the last stage. An earlier `project`-mode stage that had read
  those files replays its recorded answer about the _old_ tree, with a
  byte-identical prompt and no divergence. That is by design — nothing is
  fabricated and every surface marks it `replayed` — but if an early stage's
  answer must reflect your edit, change that stage's prompt or resume from
  further back.
- **Parallel completion order does not change identity.** Version-4 records use
  admission order. Identical parallel requests retain their own answers even when
  the second child finishes first. Different admission order or changed business
  keys still ends reuse at the first differing request.
- **Legacy v3 records stay readable, but normal resume runs fresh.** Their `seq`
  described completion order, which cannot prove which identical parallel call
  produced an answer. They are never silently sorted into an invented launch
  order; the journal names `invocation-identity-unproven`. Only explicit
  interrupted recovery can reuse a legacy prefix after its existing journal
  checks prove fully confirmed, labelled, non-overlapping serial execution.
- **Damaged logs never compact ordinals.** Missing or duplicate agent, clock and
  random positions end reuse at the first unproven position. A malformed row with
  a readable position invalidates that position and its suffix; an unreadable row
  stops the reader before later physical rows. The proven prefix can still replay.
  A missing clock/random value is produced fresh and ends subsequent reuse too.
  An append failure likewise leaves a gap; it cannot shift a later answer into
  the failed call's place. Historical files are never rewritten.
- **Resume is not Pi session continuation.** The child session is not resumed;
  only the workflow-level answer is reused.
- **A recorded failure is not replayed.** It keeps its ordinal so the prefix
  before it still replays, and the call itself runs again — which is what
  "resume to fix the stage that failed" means.
- **Every replay miss ends prefix reuse.** A recorded failure or a side-effecting
  worktree call executes fresh even when its request key still matches. That miss
  also makes every later call fresh, so later answers cannot be reused across a
  predecessor that executed again.
- Recording is skipped entirely for `unproven` and `entry-only` scripts, so those
  runs write no `replay.ndjson` and cannot be resumed.

## Refused replay stays refused

A rejected offered replay closes prefix reuse before returning control, including
when its caller catches the error. Rejected offers are not counted as successfully
replayed calls. If a confirmed interrupted-recovery prefix is refused, later agent
and recorded-value requests remain blocked; catching that failure cannot repeat
previously confirmed effects. This does not block normal continuation after an
entire confirmed prefix succeeds: its new, unrecorded suffix may execute normally.
