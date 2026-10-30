# agents

`agents` owns the discovered agent catalog, child-session execution, `/agent`, `/ps`, and the model-callable `spawn_agent` / `agent_status` tools.

## Surface

```text
/agent list
/agent inspect <name>
/agent run [--yes|--approve] [--title <title>] <name> <task>
/agent observe
/agent summary
/agent settings activityStrip.maxItems <1–20>
/agent drill <row-id|agent|last>
/ps [row-id|agent|last]
```

`spawn_agent` accepts one required `task` plus optional `background`, `agent`, `modelRole`, `requireModelRole`, `title`, and explicit parent context. Omitting `agent` starts a clean child without a role profile. An explicit name resolves only from the project or user catalog.

Without an explicit `modelRole`, bare standalone children inherit the current session model without consulting the
`agent` model role. Bare children and named profiles whose model tier inherits also
receive known parent thinking; unknown parent thinking leaves Pi SDK defaults.
A resolved profile selector or assigned role uses its `:off|minimal|low|medium|high|xhigh`
suffix. Without a suffix it leaves the SDK's per-model/global thinking fallback,
even under a high parent. Separate profile `thinking-level`/`thinkingLevel` fields
do not affect this routing. Pi still clamps effort to model capabilities; terminal
evidence records the child's effective readback, leaving it absent when unavailable.

An explicit `modelRole` (for example `tier-s:high`) overrides the selected profile's
model preference, or selects a model for a bare child. Roles come from the project
`.pi/model-roles/config.json` when present, otherwise the user
`~/.pi/agent/model-roles/config.json`; the project replaces all user assignments.
The `modelRole` parameter advertises assigned roles and their source path before
each parent turn. `requireModelRole: true` requires an explicit assigned role and
refuses before creating a child when it is missing. Other missing roles inherit the
parent model with recorded fallback; malformed assignments fail.

Rows and tool cards display the literal role with model and effort, such as
`tier-s (provider/model, high)`. Until execution is confirmed the label says
`requested`; confirmed fields come from the child, and parent fallback is explicit.
A role selects a model; the `agent` catalog supplies instructions. Adding a role
never creates an agent profile.

## Contract and limits

Standalone task defaults and workflow constraints are listed together in the
[budget policy](../../docs/workflows/budgets.md#run-budget).

- Unknown agents, unavailable SDK support, cancellation, failure, blocked execution, and empty answers return explicit errors.
- Direct child-to-child delegation is blocked by removing `spawn_agent` from child sessions.
- Read-only intent and effective tool access differ across standalone profiles, workflow children, external CLI adapters, and Fusion tool-free; see [trust and permission limits](../../docs/workflows/trust.md#approval--trust-discipline).
- Parallel or multi-stage orchestration belongs to the workflow runtime, not one `spawn_agent` call.
- Interactive `spawn_agent` defaults to `background: true`: it returns a **queued** handle immediately, without entering the agent. `agent_status({handle})` checks without waiting; `wait: true` explicitly joins the assignment and collects its bounded result. Handles belong to the launching session and never resume work. `background: false` and the headless default preserve awaited final-text behavior; workflow DSL calls keep their existing awaited contract. `/agent run` is also nonblocking. A one-line started event appears only after observed SDK dispatch, not on a queued/refused launch.
- **Left** with a wholly empty focused editor opens **Agents Command Center** fullscreen; `/ps` and Shift+Down are compatibility entry points. Nonempty/multiline input, autocomplete and bracketed paste retain their normal behavior. Unknown third-party editor capabilities fail closed to `/ps`. The main renderer is stopped, never painted under a child overlay.
- The center groups full project identities, always-expanded `.mjs` workflow runs (including nested workflow provenance), and leaf agents with descriptions. Counts represent unique **child sessions**, not workflow/group mirrors; cwd/worktrees do not change the launch project identity. Project counts and path suffixes remain visible in compact terminals. Right Agent Details shows execution-backed model/reasoning/cwd, activity, last message and the author’s original launch prompt, never the generated execution capsule. At narrow widths Tab switches tree/details. Arrow keys select, Enter opens an existing agent, Escape/Backspace returns to the prior view. PgUp/PgDn scroll details. Stable selection never silently jumps to another execution after pruning.
- Recent history is bounded to 200 child-session snapshots and 100 terminal workflow runs in this Pi process, not a cross-restart disk session browser. Replaced/removed executions open read-only snapshots without implicit resume. Nested workflows are display provenance, not agent ownership or new lifecycle nesting support.
- In the modern TUI, legacy passive fleet/phase/earlier-run progress panels are suppressed: conversation and composer remain primary. A failure or operator handoff keeps a short actionable notice; full evidence stays in the center and workflow commands.
- The unified logical activity strip is **below** the violet status line in main and child views. It shows four items by default, workflows representing their active descendants once; retained/orphan active children remain visible when their workflow no longer represents them. Overflow is explicit. `/agent settings activityStrip.maxItems 2` persists the project preference in `.pi/agents-ui.json`, preserving unrelated fields and refusing concurrent/invalid writes. The terminal owns font size; rows use one-cell line height, one blank project separator and quiet violet selection rather than a saturated bar.
- The child uses the same native message components, thinking-level editor border, responsive violet Locus status-line renderer and compact bottom agent strip as main (with the status-line extension loaded). Child model, thinking, cwd and context come from that SDK session; unavailable context/compaction facts show `?`, not fabricated zeroes or parent metrics.
- `/ps main` or Escape outside the center switches to main without stopping the selected agent. Each agent keeps its native multiline editor draft/history and independent ScrollView. PageUp/PageDown, Ctrl+Home/Ctrl+End, mouse scrolling and the native Jump to latest message indicator affect only that view. New output does not force a scrolled viewport to the bottom.
- `/cancel` or Ctrl+C cancels the selected generation, not the agent. `/exit` in an agent stops only that agent and returns to main. `/exit` in main, or Pi's native `/quit`, shuts down all registered agents. A cancellation whose abort cannot establish an idle SDK session does not make that session available for another prompt.
- Successful assignments and verified operator cancellations retain their SDK session in interactive mode. A subsequent explicit prompt uses the same session and original permissions. Cumulative tool, turn and time budgets are never reset. An exhausted budget refuses a follow-up. Caller/workflow cancellation, failed setup, and noninteractive runs still dispose their sessions.
- Workflow agents use the same SDK execution and lifecycle implementation. Workflow launches stay in the background instead of stealing focus for every stage; `/ps` opens them. After assignment completion, explicit interactive follow-ups cannot change the accepted workflow result or resume its graph. Assignment-only return tools are removed; the original permitted work tools remain unchanged. A completed idle workflow slot session is disposed when a new round replaces that slot; persisted round history remains in the journal. An active predecessor is never cancelled by row reuse.
- Agent screens read the full in-memory SDK conversation, including streaming messages, instead of the bounded roster preview. The SDK remains the only session writer. Native assistant, tool and user-text components render the conversation. The agent editor currently handles `/ps`, `/cancel`, and `/exit`; main-only application/configuration commands remain on main. User-image rendering and arbitrary extension-command forwarding are not added by this change.
- Pi 1.3.0 is the supported host floor for the independent renderer and native ScrollView APIs. Both regular and fullscreen main modes return to the original renderer after leaving an agent.
- Workflow completion rows retain the durable catalog identity and add the same session petname shown by `/ps`. Fresh transcript filenames include their stage and petname, and an enabled HTML render uses that human identity as its browser title when the host export exposes a title element.
- Package-owned SDK children use a file-backed Pi session manager inside the owning run/report evidence directory and therefore do not appear beside operator sessions in `pi --resume`. Their durable named JSONL evidence is always exported explicitly at assignment completion; a readable HTML render is added only with [`LOCUS_PI_HTML_TRANSCRIPTS=1`](../../docs/environment-variables.md#locus_pi_html_transcripts).

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

## Screen and lifetime design

One Pi host owns the main session. One flat registry owns execution handles; creator and workflow IDs are metadata, not cascading ownership. Each SDK assignment and later interactive continuation shares the same permission and budget boundary.

The active child uses an independent `TuiAltScreen`. A terminal lease stops the main renderer before starting it, and stops it before restoring main. It never patches private renderer layout fields, opens another writer on a live JSONL file, or mounts the child as an overlay. Per-agent native ScrollViews and editors survive switching; only the selected view receives terminal input.

`working -> idle` means a turn finished, not that the agent exited. Cancellation aborts the current turn and returns to idle only after verified SDK settlement. Explicit exit disposes one execution. Main exit waits for all registered execution cleanups, including an older execution whose workflow row ID was replaced. Cleanup errors are not success receipts.

The alternative editor-container viewer was rejected because the host still rendered and scrolled its own transcript around it. A new process per visit was rejected because it would restart the agent or create two writers for the same session. Direct access to private host layout roots was rejected in favor of the public terminal handoff.

### Command Center visual hierarchy

The center uses the accepted compact layout: violet project and section headings,
lavender metadata, tree connectors, a dedicated status column, and a muted violet
selection marker without a saturated background. Running, waiting, inactive and
failed states keep textual labels as well as semantic colors. Narrow terminals
retain the Tab details view. Terminal font sizing remains a terminal setting.
Long last-message content has a short preview above the launch prompt; the full
message remains available by scrolling details. Press `P` in the center to expand
full source/project/working paths; the default details keep paths on one line.

An answered operator handoff retains its historical `awaiting_operator` run
outcome but projects its current claim as continuing, answered or retryable.
Only unresolved/retryable questions appear as needs-input in the activity strip;
a successful continuation does not rewrite the source run as completed.
