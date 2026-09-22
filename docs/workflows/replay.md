---
title: Replay recorded workflow calls
type: guide
status: active
updated: "2026-09-13T00:12:22Z"
description: "Organize the installed workflow contract by reader task."
---

# Replay recorded workflow calls

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Resume and replay

`/workflows run <name> --resume <runId>` reruns the workflow against a recorded
run. The source result must persist its workspace identity; resume rejects a
missing or unsafe identity and requires the current resolved workspace to match
both the recorded project-relative path and its canonical physical target. When
the source run used an explicit workspace, repeat its exact `--output-dir <path>`;
omitting it or naming another workspace fails before child execution. A fresh
semantic target must use a different path. Every
`agent()` call whose **position** and **exact request** match the
record returns the recorded child text without spawning a child, so iterating on
the last stage of a long pipeline no longer pays for the earlier stages.

### What is compared

The key is the call's ordinal position plus its canonical resolved request.
It includes the prompt, catalog `agent`, `maxToolCalls`, `timeoutMs`, `maxTurns`,
declared model and role selectors, `label`, `phase`, workspace and execution
identity, mapped item identity, and the `ask` declaration. A call that may block
on a live human answer never shares a record with one that may not. Display titles
are not execution identity; see [model routing](models.md#model-selection-execution-versus-metadata)
for the distinction between declared selectors and the model that actually ran.

A shaped call includes its versioned `returnContract` in the canonical request.
It does not encode that contract by appending it to the prompt or parsing model
text. Same-session clarification stays within the same logical call and does not
create another replay ordinal. Transport retries also share that logical ordinal;
see [the two retry loops](outcomes.md#the-two-retries-and-which-failure-each-one-owns).

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

| Miss                      | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `no-record`               | the record has no entry at this position                              |
| `unnamed-node`            | source changed and either the entry or the current call has no name   |
| `node-mismatch`           | source changed and the names differ                                   |
| `return-contract-changed` | the recorded shaped-return contract predates the current version      |
| `key-mismatch`            | the resolved request differs from the recorded one                    |
| `recorded-failure`        | the recorded call failed; a failure is never served back as an answer |
| `side-effecting-call`     | the call writes to a worktree, so its record cannot stand in for it   |
| `diverged`                | the latch is already set by one of the above                          |

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
- **`parallel()` wider than the scheduler is a cache miss, not a wrong answer.**
  Ordinals are assigned as calls start, and a group with more branches than the
  scheduler width (4) may start them in a different order on the second run. That
  breaks the prefix and the remaining calls run for real. Sequential pipelines —
  the case this feature exists for — are fully deterministic.
- **Resume is not Pi session continuation.** The child session is not resumed;
  only the workflow-level answer is reused.
- **A recorded failure is not replayed.** It keeps its ordinal so the prefix
  before it still replays, and the call itself runs again — which is what
  "resume to fix the stage that failed" means.
- **The prefix latch fires on key mismatch, not on a changed outcome.** A call
  that re-runs at a matching key — a recorded failure that now succeeds, or a
  worktree stage that is never replayed — does _not_ break the prefix. Its
  successors, if their own keys still match, keep replaying. So a stage whose
  recorded answer was produced in a run where its predecessor had failed can be
  replayed into a run where that predecessor succeeded. Nothing is fabricated:
  the text is a real child answer to a byte-identical request, and the run is
  marked `replayed`. But "the prefix before the divergence replays" is only half
  the rule — the prefix _after_ an outcome change replays too, and only a
  changed request key stops it.
- Recording is skipped entirely for `unproven` and `entry-only` scripts, so those
  runs write no `replay.ndjson` and cannot be resumed.
