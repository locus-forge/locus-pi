# agents

`agents` owns the discovered agent catalog, child-session execution, `/agent`, `/ps`, and the model-callable `spawn_agent` tool.

## Surface

```text
/agent list
/agent inspect <name>
/agent run [--yes|--approve] [--title <title>] <name> <task>
/agent observe
/agent summary
/agent drill <row-id|agent|last>
/ps [row-id|agent|last]
```

`spawn_agent` accepts one required `task` plus optional `agent`, `title`, and explicit parent context. Omitting `agent` starts a clean child without a role profile. An explicit name resolves only from the project or user catalog.

## Contract and limits

Standalone task defaults and workflow constraints are listed together in the
[budget policy](../../docs/workflows/budgets.md#run-budget).

- Unknown agents, unavailable SDK support, cancellation, failure, blocked execution, and empty answers return explicit errors.
- Direct child-to-child delegation is blocked by removing `spawn_agent` from child sessions.
- Explicit native `readOnly` profiles are narrowed by the Pi host adapter. Workflow children use the full tool surface. External Claude Code repository-agent profiles own a separate CLI tool loop and must expose full tools; a reviewer role alone must not remove shell/git or report writing.
- Parallel or multi-stage orchestration belongs to the workflow runtime, not one `spawn_agent` call.
- `/ps` and `/agent drill` inspect live and retained child rows; closing the view does not stop a child.
- In TUI mode `/ps` focuses the agent roster already visible below the editor instead of drawing a second copy. Recursive `├─`, `└─`, and `│` rails keep workflow groups, agents, latest messages, and tool activity attached across the focused viewport. Its row membership and order stay fixed until close, live fields keep updating, and Up/Down can reach every leaf through the eight-row viewport. Reopen `/ps` to include agents that arrived while it was focused. Escape from a drill opened by `/ps` returns to `/ps` on the same row, with membership re-read on return; `q` leaves the agent surface for the editor instead, and so does a drill whose row retired while it was open.
- `/agent drill` uses the full viewport only when its request/transcript needs it. Short retained results stay top-aligned at their real content height; long results keep tail-follow. Its header says where a workflow child sits — run, stage, enclosing group, agent — and one status line beneath it carries the row's state and how long it has been running.
- In Pi's regular mode Home, End, PageUp and PageDown move that history. On a MacBook, PageUp and PageDown are `fn+Up` and `fn+Down`, which the visible footer names. The viewer accepts whichever PageUp/PageDown or Home/End encoding the terminal sends, including `ESC[5~`/`ESC[6~`, `ESC[1~`/`ESC[4~` under `tmux-256color`, `ESC O H`/`ESC O F` under `xterm-256color`, and the `ESC[H`/`ESC[F` pair. Home and End used to answer to the last pair alone, so both keys were dead in tmux.
- In Pi fullscreen the screen's history does not scroll at all, and the footer promises no history control there. This is a host limitation the component cannot route around: Pi's alt-screen TUI registers a viewport input listener in its own constructor, before any component exists (`@earendil-works/pi-tui/dist/tui-alt-screen.js:77`), that listener consumes PageUp, PageDown, Home and End for `tui.altScreen.pageUp`/`pageDown`/`top`/`bottom` (`@earendil-works/pi-tui/dist/keybindings.js:91-116`), and every input listener runs to completion before the focused component is reached (`@earendil-works/pi-tui/dist/tui.js:557`). The wheel is Pi's there by design, so in fullscreen a transcript taller than the viewport is readable only at its tail. An operator who rebinds those four `tui.altScreen.*` actions gets the keys back, because the screen still handles them.
- Fullscreen costs the screen one row. Pi mounts the component in a dock stacked under a transcript `ScrollView` that never shrinks below one line, so a screen claiming every row but Pi's footer had its own footer clipped off the bottom with nowhere to scroll to. The screen reserves that row and gives up one line of transcript instead.
- The agent screen no longer enables terminal mouse tracking in regular mode, so the wheel and the host terminal's own scrollback stay with the terminal and history moves by key. `LOCUS_DRILL_MOUSE=1` restores the previous wheel-scrolled history, and the footer offers `wheel` only where the screen captures it. In Pi fullscreen the screen writes no mouse sequences at all and leaves wheel reports to Pi; a host that gives the component a terminal wrapper with no mode is treated the same way, so the variable has no effect there (`docs/workflows/index.md`).
- The reply box is Pi's own editor component mounted whole, with its frame and its own key hints. It needs 18 terminal rows; below that the screen says `resize terminal for input` instead.
- Workflow completion rows retain the durable catalog identity and add the same session petname shown by `/ps`. Fresh transcript filenames include their stage and petname, and an enabled HTML render uses that human identity as its browser title when the host export exposes a title element.
- Package-owned SDK children use a file-backed Pi session manager inside the owning run/report evidence directory and therefore do not appear beside operator sessions in `pi --resume`. Their durable named JSONL evidence is always exported explicitly before disposal; a readable HTML render is added only with [`LOCUS_PI_HTML_TRANSCRIPTS=1`](../../docs/environment-variables.md#locus_pi_html_transcripts).

The catalog follows project -> user precedence: project `.agents/agents/`, then user `~/.agents/agents/`. The package ships no profiles.

## Failure diagnostics

Failed standalone calls and workflow agents point to the project-wide
`.locus-pi/logs/errors.jsonl`. Failure cards retain the cause and complete evidence
paths even when collapsed. Follow [error diagnostics](../../docs/workflows/error-diagnostics.md)
for `jq` queries, rotation, missing facts and logging warnings. Host-rejected
workflow calls remain visible even when their SDK child completed successfully.

## Implementation

- Entrypoint: `extensions/agents/index.ts`
- Tool: `extensions/agents/tool/task-tool.ts`
- Catalog: `extensions/agents/catalog/catalog.ts`
- SDK adapter: `extensions/_shared/agent-runtime/agent-sdk-host.ts`
- Manifest: `extensions/agents/manifest.json`

## Claude Code progress and model execution

Claude Code progress comes from the separately installed
[locus-pi-claude-code-adapter](https://github.com/kroffske/locus-pi-claude-code-adapter).
Select its `claude-code/...` model for the child session. The adapter starts the
Claude Code CLI and translates its output into Pi assistant-message snapshots.

### What the user sees

The adapter requests `stream-json` with partial messages. It shows session text,
available reasoning text, initialization, tool activity, and capacity waits.
`thinking_tokens` records do not become progress messages. Nested Claude tools
appear as text; Pi does not execute those reported tools again.

Locus follows the newest text while a message is streaming. The live transcript
keeps at most 4,000 characters per text block, and the roster preview keeps 300.
Both bounds retain the tail during streaming. The panel also keeps the tail when
the terminal width is smaller, while preserving tree rails. Completed messages and replay keep
the report opening. The canonical final response replaces temporary progress.
The full provider/session output is not expanded by this bounded viewer.

For example, the live CLI check produced this shortened sequence:

```text
[Claude Code progress] Session initialized
[Claude Code progress] Read: .../package.json
[Claude Code progress] Tool finished
The package name is `locus-pi-claude-code-adapter`.
```

### Why display does not invoke the main model

The execution boundary has three owners:

1. The adapter's `createClaudeCodeProvider` registers `stream` and `streamSimple`
   for the CLI provider. `streamClaudeCode` calls `runClaudeCode` once. Its output
   callback only constructs assistant text snapshots. `runClaudeCode` invokes
   the configured executable with `spawn`, sends the prompt on stdin, and parses
   stdout. There is no model call in the progress parser or callback.
2. Pi's pinned agent runtime calls the stream function for the selected model.
   In `@earendil-works/pi-agent-core` 0.84.1, `streamAssistantResponse` consumes
   `event.partial` and emits `message_update`. A status-only update may carry an
   empty delta; the replacement snapshot still contains the new status.
   A final text response has no Pi tool calls, so this response does not cause
   another model turn. This contract is tested with the real Pi loop.
3. Locus's [child-session host](../_shared/agent-runtime/agent-sdk-host.ts)
   subscribes in `driveChildTurn` and passes events to the live store. The
   [transcript projection](../_shared/agent-runtime/agent-live-transcript.ts)
   and [panel](../_shared/agent-runtime/agent-live-panel.ts) transform
   data synchronously. They have no model client or inference callback.

This proves that **rendering Claude Code progress adds no main-model inference**.
It does not mean that Claude Code itself is free: its internal model loop and
aggregate usage belong to Claude Code. A main-model turn that launches a tool,
a later turn that reads its result, explicitly parallel workflow stages, and
user steering are separate actions. Displaying progress neither launches nor
cancels those actions. Workflow command receipts use `triggerTurn: false`;
the model-callable workflow tool awaits completion and returns its native tool
result instead of triggering a turn for each update.

### Verification and limits

The companion adapter test starts a controlled CLI process through the real
runner. It checks streamed text, tool activity, deduplication, ignored counters,
final-result replacement, one runner invocation, and no parent `fetch` calls.
`tests/shared/agent-runtime/agent-progress-runtime.test.ts` uses the installed
Pi loop with controlled provider output. Several progress
updates produce one selected-provider invocation and one turn; reported nested
tools never become Pi tool execution events. The
`tests/shared/agent-runtime/agent-live-transcript.test.ts`
first failed on the previous implementation because the latest status was lost.

A live smoke check also ran Claude Code 2.1.257 through the companion provider
and Pi 0.84.1. Claude read `package.json` and returned the correct package name.
It produced six distinct visible snapshots, one adapter invocation, and zero
parent-process `fetch` calls. The child's network access was allowed; the
parent's `fetch` was replaced with a throwing counter. This is a bounded
execution check, not an account-wide billing audit or proof that unrelated
sessions are idle. The local smoke harness and raw result remain runtime data.

Updating Locus alone does not install or update the separate adapter. Both
changes must be present to get readable CLI events and tail-following previews.
