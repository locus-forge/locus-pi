---
title: Fusion panels
type: guide
status: active
updated: "2026-09-13T00:12:21Z"
description: "Organize the installed workflow contract by reader task."
---

# Fusion panels

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Direct Fusion from the main session

Fusion also has a model-callable `fusion` tool. It is disabled by default, so it
does not enter the active tool list or the parent model's tool prompt until an
operator explicitly enables it.

```text
/fusion                                      # interactive menu or passive status
/fusion configure                            # choose one mode, at least 2 members, and one judge
/fusion set --mode tool-free --members provider/a,provider/b --judge provider/judge
/fusion enable
/fusion disable
/fusion status
/fusion run <complete standalone question>  # manual call through the same runner
```

The interactive selector reads `modelRegistry.getAvailable()`, so it shows only
models the current Pi host can actually use rather than every model known to a
provider. Configuration is project-local at
`.locus-pi/fusion/config.json`. Version 2 requires an explicit homogeneous
`tool-free` or `agent` mode. Operational commands reject legacy version 1
configuration. `/fusion configure` and `/fusion set` may replace it atomically,
but the replacement remains disabled until the operator reviews the selected
mode and runs `/fusion enable`. Members must be unique, and the judge must be
different from every member. Enabling fails closed when the roster is incomplete
or a selected model is no longer available.

The tool accepts `question`, optional explicit `context`, and an optional final
`output` instruction. It never forwards ambient session history. A direct run
uses the same mode-specific Fusion calls and writes the same packet,
answers, journal, result envelope, and readable output under
`.locus-pi/runs/<runId>/` as the Workflow DSL primitive. Disabling removes
`fusion` from Pi's active tools immediately while leaving `/fusion` available for
configuration.

Every finished-run surface is bounded on purpose: the chat digest caps a line at
160 characters because it enters model context, and the live panel clips to the
terminal width. So a run whose result **is** prose — a review, a plan, an answer —
writes that text verbatim to `outputs/workflow-result.md`, and both the digest
and the panel name that file plus the command that opens it. `/workflows result`
opens the full text in a scrollable read-only screen:
`↑/↓` and PageUp/PageDown scroll, Home/End jump, Esc closes. A host without custom
UI gets a bounded preview plus the exact path, which is the copy that is never
truncated. The native workflow tool's operator card also renders this exact text
without clipping, while its model-facing content remains bounded. Structured
(non-text) results stay in `runtime/result.json`, which already pretty-prints them.

A run that ends badly and produced **no** prose result — a script returning a
structured `{ ok: false }` is the common case — gets the same treatment against a
different command. Its verdict line carries the failure summary and is clipped
like any other, so the digest and the panel add
`read the full reason: /workflows status <runId>`, which prints the structured
result the reason actually lives in. `/workflows result` is deliberately not
offered there: it refuses a non-prose result, so pointing at it would send the
operator to a dead end.

`/workflows result` and `/workflows status` accept the short run suffix every
surface prints (`run #98cc` → `/workflows result 98cc`), `last` for the newest run,
or a full run id. A short suffix matching more than one run is refused with the real
match count and the listed candidates — never opened as the wrong run, and never
reported as missing when runs were found.

Only the emergency stop owner remains available as a flat command:

```
/workflow-stop [runId|last]
```

Direct typed `/workflows <subcommand>` forms retain argument completion for
workflow names, persisted run ids, `last`, and replay ids. Completion does not
scan persisted handoffs while the operator types the root command or any
subcommand other than `continue`; this keeps ordinary input responsive on slow
mounted filesystems. Catalog queries, paths, and semantic input remain free text.

`/workflows run` adapts to the host's run mode. In `tui` and `rpc` the session
outlives the turn, so the run is detached: the command returns immediately, the
live panel streams it, and `/workflows stop` can cancel it. `/workflow-stop`
remains the emergency compatibility alias. In the one-shot output
modes (`pi -p`, `--mode json`) the host disposes the session when the turn ends —
a detached run would lose the ctx its child sessions need — so the command holds
the turn open until the run settles and its result is persisted. A headless
invocation therefore blocks for the whole run and there is no concurrent
`/workflows stop`; cancel it with the host's own interrupt.

An actionable `awaiting_operator` handoff opens directly in the primary editor
after Pi becomes idle — automatically only for runs this session launched,
their continuations included. A question left by an earlier session stays in
its run's evidence until asked for: open the `/workflows` menu and choose
`continue` for the oldest pending one project-wide, or type
`/workflows continue <runId>` for a named one. The menu provides contextual
workflow/run selection for `info`, `result`, `run`, `continue`, and `stop`, not
one combined picker. Multiple handoffs are oldest-first and show
`Question 1 of N`; answering launches one integrity-checked continuation before
the next item opens. Escape is an answer, not a postponement: the continuation
receives the question list with an operator-declined note, keeping any answers
given before the refusal. A retryable handoff — one whose continuation consumed
an answer and then failed — never reopens unprompted; the idle pump prints a
one-line notice (once per session) naming the run; `/workflows` then opens the
menu so `continue` can reopen it.

A question may bind one published continuation artifact as
`detailArtifactRef`. Before the question becomes actionable, the runtime proves
that the reference belongs to the source run and is one of its continuation
artifacts. The question service then re-reads and digest-verifies the indexed
text, redacts secrets, bounds it to 4096 bytes and 12 lines, and renders it above
the choices. Select questions retain the workflow/run context line and may show
declared options plus the built-in custom-answer row; workflow JavaScript never
parses or interpolates the artifact text into UI strings.

Only `/workflows stop` cancels a workflow; flat `/workflow-stop` remains a
compatibility alias for the same cancellation owner.

`/workflows continue <runId>` collects answers interactively in TUI and RPC.
`--answer` is the
explicit non-interactive path and accepts exactly one
question: closed selections require an exact label, while custom-enabled
questions accept other non-empty text. Multi-question handoffs fail closed
instead of guessing how one string should be distributed.

Mode behavior stays explicit:

| Pi mode            | Question projection                            | Answer collection                          |
| ------------------ | ---------------------------------------------- | ------------------------------------------ |
| TUI                | Automatic primary-editor select/text component | Arrows, Enter, or inline custom text       |
| RPC                | Command/static projection                      | Native bidirectional extension UI requests |
| JSON/print         | Readable one-way lifecycle output              | `/workflows continue … --answer …` only    |
| Embedded child SDK | Existing `session.subscribe(...)` observation  | Not applicable                             |

The minimum supported host floor for automatic questions is Pi 0.83.0. The exact tested Pi version is pinned in the development dependencies and may be newer. Locus
serializes its own inline components and rechecks the current idle session before
mounting. Pi exposes no global custom-UI lock for unrelated third-party
extensions, so `/workflows` opens the recovery menu if another extension
displaces the question.

The run group is stored in `.locus-pi/runs/<storageRootRunId>/`. The first root keeps
`outputs/` and `runtime/` at the group root; saved children live in `children/<runId>/`,
and root resume in `attempts/<runId>/`. `lineage.rootRunId` still means the root
of the current attempt, while `storageRootRunId` identifies the physical group of
the first launch. Two independent launches in one Pi session receive different groups.

The runner creates the non-symlink `outputs/` and `runtime/` evidence directories and writes
the first `runtime/journal.ndjson` line before it
announces the RunID; initialization failure announces no start and launches no
child. Agent-authored files use a separate project-local workspace. Fresh
workflows default to `.locus-pi/workspaces/<generated-run-name>/`.
`--run-name <name>` selects `.locus-pi/workspaces/<name>/` for any workflow. The
start surface reports the resolved run directory, which matters when
the terminal is viewing another checkout or worktree. `runtime/result.json` appears when
the run finishes, so `status` works across sessions and after the fact.

At the group root, `README.md` links the workspace, child executions, and attempts.
The workspace contains the runtime-owned `.workflow-runs.md` with backlinks.
Only the root with an active workspace lease writes them; after release, and on an
early rejection without a lease, the shared pages are not updated. They do not show
the “latest status”: see the relevant execution's `runtime/result.json`. A conflict
between the reserved `.workflow-runs.md` and a user file rejects the run and
preserves the original file. Both navigation projections are written as complete
durable content through temp+rename and parent-directory sync. The marker, version,
and full body are checked before reuse: an incomplete README is restored under the
lease, while an incomplete backlink fails with a recovery-required error so
previously written links are not lost.

The history of previous flat `.locus-pi/runs/<legacyRunId>/` remains readable and
resumable in place. Lookup is limited to group roots and two nested directories;
ambiguous IDs and selected symlinks are rejected. An early unsafe or unresolvable
resume saves a separate rejected receipt; after the group is identified safely,
even a semantic rejection is stored in its `attempts/`. The old `.pi/locus-pi` path
is not returned by lookup. Global claim IDs are serialized by the short-lived
`.locus-pi/runs/.run-claim.lock` lock. If a claim is interrupted, the next launch
explicitly rejects; before manually removing the lock, verify that its owning
process has actually stopped. History is not deleted.
