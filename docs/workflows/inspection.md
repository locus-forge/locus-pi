---
title: Workflow progress and agent inspection
type: guide
status: active
updated: "2026-09-13T00:12:21Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow progress and agent inspection

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Background launch and cancellation

Pi can invoke an extension command immediately while the parent agent is still streaming. Therefore `/workflows run` first checks the real command context `ctx.isIdle()` before target resolution, transcript creation, or workflow execution. A busy session fails closed with `Workflow not started: Pi is busy streaming…`; it sends no custom message and starts no workflow. The operator retries after the current response finishes. Read-only `/workflows list` and `/workflows status` do not create transcript messages and remain available. This guard is required because `sendMessage({ triggerTurn:false })` routes to `agent.steer()` when Pi is streaming, despite `triggerTurn:false`.

After the idle check, `/workflows run` claims one process-local background lease for the current session/project, launches `runWorkflowScript` without awaiting it, and returns control to the editor. A second interactive run in that stable session/project identity is rejected with the existing run id even across an extension reload, until the predecessor settles. The programmatic `workflow` tool remains awaited and headless, but registers a non-exclusive run controller with the same owner; it does not occupy the slash-command slot. `/workflows stop [runId|last]` is the sole operator cancellation command for either launch origin. Stop is idempotent and the UI says `stopping` until settlement. Once the controlling signal is observed as aborted, the runner persists `disposition.status:"cancelled"` even if trusted script code catches a child abort. `operator_stop`, `session_shutdown`, and unknown host aborts remain distinguishable reasons.

## Live widget and agent drill

The background run installs a compact `belowEditor` widget. Its header identifies the workflow and run, the stage frontier preserves declaration order, and each stage is labelled only as `declared`, `reached`, or `current`; only an explicit `kind: "phase"` journal event makes a stage reached or current. Phase metadata on agent, group or log events remains grouping context. One active child row is rendered through the shared `AgentLivePanel`; a `parallel()`/`pipeline()` group contributes a summary heading once it aggregates two or more agents, and that heading is never selectable. A group of one is a heading over a single row, so the heading is dropped and its member is lifted to the group's own parent; the leaf itself is never hidden. Round retries retain the same stage slot and add an `rN` marker. `/ps` snapshots the agents extension's shared fleet directly from the current `agentLiveStore`, then focuses the primary roster already visible below the editor; its custom editor component captures keys but renders no duplicate agent rows. Snapshot membership and order stay fixed until close while live fields keep updating. Up/Down move through every leaf row, and an eight-row viewport follows the cursor with explicit earlier/later counts. Reopening `/ps` refreshes membership. Because rows of the last few completed runs stay drillable, the snapshot ranks the newest workflow run and every standalone agent first and puts earlier runs behind one `earlier workflow runs` label. A bare agent name resolves to that agent's row in the newest run; an earlier run stays reachable through its own row id. A question that stops a run for a human names the blocked run inside the question block itself (`workflow <name> · run #<id> · awaitOperator`), as a body line rather than a badge, so a narrow terminal drops neither it nor the question counter. `Shift+Down` is an optional terminal shortcut, not the primary contract. `Enter` opens transcript output or a recorded replay answer whose digest was checked by the workflow event adapter. `Esc`/`q` close or go back without aborting and restore the normal editor surface. Workflow-owned rows carry explicit run provenance and expose no `x` action; use `/workflows stop [runId|last]`. Standalone agent rows retain their confirmed `x` behavior.

The agent screen a roster row drills into does not take the terminal's mouse. In
Pi's regular mode it writes no mouse-tracking sequences on open or on close, so the
wheel and the host terminal's own scrollback stay with the terminal, and the screen's
history moves on `PageUp`/`PageDown`/`Home`/`End`. `LOCUS_DRILL_MOUSE=1`, read per
viewer when the screen opens rather than once per module, restores the previous SGR
wheel capture together with its lease refcount, and the footer offers `wheel` only
where the screen actually captures it. In Pi fullscreen the screen writes nothing
either and does not decode wheel reports, because Pi owns the mouse there and its own
`ScrollView` consumes the wheel before the component sees it.

The switch is fail-closed on the host mode, not on the flag. When the host hands the
component a terminal wrapper that carries no mode, the mode is unknown and the
extension writes no mouse sequence at all — so `LOCUS_DRILL_MOUSE=1` silently has no
effect on such a host. That is the intended outcome rather than a gap: an enable this
code cannot match to a mode is an enable it cannot promise to undo. What text
selection then looks like in any particular terminal, multiplexer, or remote session
is not claimed here; only what the extension writes is.

The detached run adapter and transcript callbacks carry the originating Pi session generation; late completion therefore cannot write through them into a new session. The progress component's live-store listener and spinner timer are instead session-owned resources: the extension disposes them synchronously on session start/shutdown and idempotently on terminal, error, and `finally` paths, even when a runner ignores abort and settles later. `session_shutdown` (including reload) also aborts active work and awaits all owned run settlements so the runner can persist terminal results before normal Pi exit. Revoked UI callbacks remain suppressed; forced process termination still cannot guarantee persistence. This lifecycle uses Pi's documented [`session_shutdown`](https://pi.dev/docs/latest/extensions#events), [`input`/`turn_end`](https://pi.dev/docs/latest/extensions#events), and [`setWidget(key, undefined)` cleanup](https://pi.dev/docs/latest/extensions#widgets-status-and-footer) seams, plus the one shared agent-row formatter.

## Session transcript and completion messages

Transcript persistence follows the Pi surface that started the run. The slash-command path publishes a run-boundary banner at launch and a bounded digest at settlement, both with `customType: "locus-workflow-run"`. When the workflow returns prose, it publishes that exact text separately with `customType: "locus-workflow-result"`; this result message is intentionally untruncated so the operator can read and copy it directly from scrollback. Structured, non-text results do not fabricate a prose message and remain available through persisted evidence. The banner is what separates one run from the next in scrollback — it names the workflow, the run, and the wall-clock time, so two runs of the same workflow are never read as one stream. It is sent from `onRunStart` and only after a synchronous `ctx.isIdle()` recheck, because the operator can submit a prompt between the launch gate and the first journal event and `sendMessage` routes to `agent.steer()` while Pi streams, despite `triggerTurn:false`; a busy session simply gets no banner and the live widget still shows the run. No further `sendMessage` call happens while the run is active, because a long workflow can outlive the launch-time idle check. The lifecycle stays in memory while widget/status surfaces show live progress. After the workflow finishes and the completion UI is updated, the command awaits the real `ctx.waitForIdle()`, rechecks `ctx.isIdle()`, and invokes every final `sendMessage` synchronously before awaiting either promise. Interactive TUI appends the bounded terminal digest and then the optional exact result, leaving the useful result last; non-interactive modes keep the exact result before the authoritative `workflow_end`, so an attached CLI can close on terminal truth without racing prose. There is no await between the final idle check and either send call, so Pi's synchronous routing appends instead of steering. The calls omit `deliverAs` and do not start or queue a model turn. Every published record is stored and participates in later LLM context.

The programmatic `workflow` tool never calls `sendMessage` while its tool output may be streaming. It buffers the same lifecycle and appends one digest to the single ordinary final `toolResult` text; Pi therefore persists it through the native tool-call transcript without an extra turn. Streamed progress updates remain presentation-only. Digests on both paths cap bounded lifecycle lines at 160 characters, keep at most 20 agent rows, and separate `Files` from `Commands`; semantic primary files lead the file group, while full-result and status commands stay copyable and untruncated. Persisted run headers are plain semantic text. The command renderer adds `──` fill at the live card width, so session JSONL is terminal-independent and wide cards do not stop at a fixed 64 columns. The separate command result message deliberately does not use digest bounds. Interactive command transcripts order the cards as started, finished, then exact result, so the useful output remains last; non-interactive JSON preserves exact-result-before-`workflow_end` because that terminal receipt closes the external protocol. A completed run with an exact result does not repeat a clipped copy in the finished receipt. A Package `task/draft` result points to the editable `draft.md` and tells the operator to copy or edit the complete text before passing it to `task/plan` as semantic input. A Package `task/plan` result labels its primary `workflow.mjs` path and tells the operator to review it, copy it into the target project's `.locus-pi/workflows/<name>.workflow.mjs`, verify `meta.name`, and use the normal reviewed-workflow launch path; the bounded digest repeats neither action. One agent occupies one row for the whole run: the row is written on `agent_start` and rewritten in place on `agent_end`, keyed by the runtime-owned `callId` (falling back to agent/label/slot/round), so a reader never meets the same agent twice. An agent whose `agent_end` never arrives is not collapsed and not dropped — its row reads `■ agent <name> started — no end recorded (evidence missing)`, because a missing end must never be folded into a green run. Replayed work carries its own marker, `↻ agent <name> replayed from run #<source>`, rather than a success glyph plus a suffix; the source run id is taken from the runtime's own resume metadata and is never parsed out of log text. When it is unavailable the row still declares the replay and says the source run is unknown. A continuation run opens with `↳ continues run #<source>` plus the operator's answer, so it is legible without its source run on screen. A run that stops at an operator gate renders that gate as its own block: a blank line, `◐ WAITING FOR OPERATOR — <title>`, the stage that was current and the tool that opened the gate, the questions, and the pending-answer line. The handoff envelope records no asking agent, so the block names the stage and never infers an agent from adjacency. Raw result/journal detail never enters the digest. Fresh workflow agent lines keep the stable catalog `agent` as primary identity and append the live execution petname in parentheses, followed by `label` and status. Historical or replayed journals that carry no petname remain readable with the catalog identity alone; no name is reconstructed after the fact. Terminal markers are status-aware: `✓ … finished` only for `completed`, `◐ … awaiting operator` for a successful handoff, `⊘ … cancelled` for `cancelled`, and `✗ … failed` for `failed`. Agent-row markers are `✓ finished`, `⊘ cancelled`, `✗ failed`/`blocked`, `↻ replayed`, `■ ended (<status>)`, and `■ … no end recorded`. Journal `error` lines are not persisted separately: a failed run always emits exactly one final failure with `eventKind: "workflow_end"`, using the journal text only as a fallback when the final result has none. On the command path, evidence warnings and failures to persist the completion messages remain correctly levelled `warning` notifications. A `result.json` write failure already belongs to the final live/typed result and is not repeated as a toast. If `waitForIdle`, the final idle check, or `sendMessage` is unavailable or fails, completion persistence stops and a clear warning is shown; the persisted journal/result artifacts remain source truth. The fallback never calls `sendMessage` and therefore cannot steer the parent agent.

## Agent roster and status projection

The compact workflow panel fits to the terminal height, keeps its journal internally, and shows the workflow/run header, the declared/reached/current stage frontier, the run's agent roster, bounded diagnostics, and the `/ps` inspection hint. The roster is the run tree: a group heading with its `k/n done · f failed` counters, then its members ranked working, then failed, then queued, then done, while the rows of a linear run keep the order the run produced them. Settled agents keep their status marker, duration, and token counter; the agent working right now keeps its spinner, the shared `accent` color every working agent carries, and its activity sub-line. `/ps` runs the same set-level projection (`orderAgentLiveRows` in `agent-live-panel.ts`), so both surfaces show one structure. The declared stages the run has not reached yet close the roster as a single dim tail line: one pending stage keeps its full `○ <title> · planned · <detail>` reading with the detail read statically from `meta.phases`, while two or more collapse into `○ next: <title> (+k planned)`, because the next stage is the only one an operator can act on and a long declared plan would otherwise spend the roster budget one line per stage. An undeclared dynamic stage appears only once it actually runs, so the roster never advertises work no declaration promised. A loop that re-enters a slot updates that one row and shows its `r<N>` round badge instead of appending a duplicate. When the passive roster does not fit the terminal, it gives up the most expendable settled entry first and the oldest among equally expendable ones: finished agents, then queued and failed group members, then the headings of groups that have already finished, and only then anything still live. The collapse is announced as `(+N earlier agents)`, `(+N earlier groups)`, or both — never silent — and the working agents, the heading of a group that is still running, the pending line, and the final verdict are not the part that is dropped. Collapsing belongs to this passive panel alone: `/ps` clamps nothing, because every leaf there has to stay reachable by the cursor. While `/ps` is focused, the primary below-editor panel temporarily projects the global frozen fleet snapshot and its cursor; other progress panels retain only their header/result so the fleet is not duplicated. Every `agent_end` status is terminal in the projection: `completed`, `failed`, and `cancelled` all leave `active`, atomically clear `currentTools`, `currentToolArgs`, and `currentToolStartMs`, freeze `elapsedMs`, stop the spinner, and render their own marker. Drill therefore cannot retain a stale command such as `sleep 60`, and duration cannot keep growing after cancel. Live-row settlement alone does not decide the workflow outcome: the shared returned-outcome classifier evaluates the root and direct `parallel()`/`pipeline()` values, while typed group failure is emitted only after the barrier has preserved sibling evidence. Those rows participate in the shared fleet, but bare `Up`/`Down` always remain Pi editor/history input; `/ps` opens fleet management and `Shift+Down` is the registered fallback. Aggregate group rows are status headings and are never selectable or actionable; in focused mode, `Enter`, `/ps last`, and direct targets operate only on exact leaf rows. Their visibility, unlike their selectability, is bounded rather than absolute: a heading is rendered only from two members up, and in the passive panel the heading of a finished group is collapsible under the line budget as described above. Workflow leaf rows are inspectable but never keyboard-stoppable. `x` asks for confirmation only for a selected standalone working SDK child through its live `AbortController` seam. Terminal rows keep drill/back but expose no `x stop` affordance.

## Logs and completion text

`dsl.log()` records one readable script event with `source: "script"` and appears in the live panel as
`│ script · <message>`. Internal workflow enter/exit and resume metadata record
`source: "runtime"`; old journal lines without `source` remain neutral journal
messages and are never relabeled as script output. The completion line prefers a
non-empty `result.summary`, then a scalar `result.verdict`, then a string result;
otherwise it reports `completed`. Arbitrary result objects are not guessed or
dumped into the live panel, tool text, RPC, or headless command output. Full
result JSON and `runDir` remain available through `/workflows status <runId>`
and `result.json`; the tool result exposes the semantic completion, bounded
lifecycle digest, artifact path, and persistence status.

The owned `[agent] ->` / `[agent] <-` transport markers are intentionally absent
from the main status surface because the structured fleet already shows those
transitions. `/workflows status <runId>` retains the markers in its detail
timeline. Failures and evidence warnings are not suppressed: failures remain in
main status and the final command event or tool digest; command warnings remain
correctly leveled `warning` notifications.

## Shared agent row grammar

The progress panel is allocated at run start, so a workflow that emits no journal
events still uses the same semantic completion grammar in TUI, RPC, and no-UI modes.

Workflow `agent()` steps still create source-backed workflow parent rows and pass `live.parentRowId` to SDK child sessions, but the live renderer collapses a workflow parent row once its real SDK child row exists. The visible running view therefore avoids duplicate `Working` lines such as `quick_task (label)` plus child `label`; it shows the group heading, then the actual child agent row in the shared grammar below, and beneath that row the sub-lines the panel adds while they have content: what the agent last said, and a `└ <verb> · <gist>` line for the tool that is running. The final summary appears in place, so the live view is never replaced by a truncated text widget.

The row renderer is the shared local `AgentLivePanel` (`extensions/_shared/agent-runtime/agent-live-panel.ts`),
not copied `pi-subagents` UI code. One agent is one line, and the line has one grammar:

```text
<icon> <name>  <title>  ·  <model> <effort>  ·  r<N>  ·  <elapsed>  ·  ↑<in> ↓<out>
```

The status icon and its color carry the state, so the row deliberately has no
`[Working]` word and no `on task`, `activity=`, `args=`, `steps=`, `turns=`,
`tokens=`, `childSession=` field and no raw JSON: those key/value forms are not part
of the grammar and are not rendered anywhere. `<name>` is the session petname,
clipped to twelve columns; `<title>` is the explicit title or the call label and is
the only part that truncates when the line overflows, so the right-hand meta always
survives. The model badge is the short model name plus the bare effort word; the
`r<N>` round badge appears from r2 up; and each right-hand segment is omitted when
its source field is absent. A multi-row roster uses recursive `├─`, `└─`, and `│`
rails for root rows, descendants, latest messages, and tool activity. A single row
keeps the established unprefixed grammar, with `   └` for its detail line.

`parallel()` and `pipeline()` also emit local `group_start` / `group_end` journal
lines, and their summary row is a grammar of its own — the group label, elapsed,
`<k>/<n> done`, `<f> failed` when any failed, and the summed token counter — while
the individual agent rows are preserved beneath it.

The live store is process-shared through a versioned `globalThis` symbol. This is
required by Pi's real extension loader: each package entrypoint is evaluated by a
fresh `jiti` instance with `moduleCache:false`, so an ordinary module singleton
would split workflow progress from `/agent drill` and fleet control.
