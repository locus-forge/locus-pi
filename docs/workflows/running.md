---
title: Launch and operate a workflow
type: guide
status: active
updated: "2026-09-13T00:12:22Z"
description: "Organize the installed workflow contract by reader task."
---

# Launch and operate a workflow

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## How to run

### `/workflows` command

`/workflows` is the canonical visible workflow command. Bare `/workflows`
opens its command menu with all nine exact verbs — `dashboard`, `list`, `info`,
`status`, `result`, `run`, `continue`, `stop`, and `skills` — and a description beside
each verb when interactive select is available in TUI; RPC, headless hosts, and
TUI without select receive the same help as a typed command fallback. Direct typed forms such as
`/workflows run <name>` remain available. `/workflow-stop` remains the one
emergency compatibility alias; every other operation uses `/workflows`.

```
/workflows                        open the canonical command menu (or typed help fallback)
/workflows dashboard              persisted run → stage → evidence viewer
/workflows list [query]           current first-wins workflows + run-specific immutable history
/workflows info [name]            explain discovery, metadata, trust, DSL, agents, and model routing
/workflows status [runId]         interactive persisted viewer and stage evidence
/workflows result [runId|last]    whole text the run finished with, scrollable and untruncated
/workflows run live-smoke         start one background workflow (returns editor)
/workflows run live-smoke --output-dir tmp/reviews/review-1 <input>  select a fresh project-relative workspace
/workflows run live-smoke -- --resume literal request  pass option-looking input unchanged
/workflows continue <runId>       answer and continue an actionable handoff
/workflows stop [runId|last]      request cancellation; terminal state follows settlement
/workflows skills status         inspect external-agent skill links
/workflows run live-smoke --resume <runId>  replay that run's recorded agent calls (see "Resume and replay")
/workflows run plan --no-operator <input>   unattended launch: any operator-input request fails closed
```

Every fresh workflow launch receives a unique
`.locus-pi/workspaces/<generated-run-name>` workspace. This includes
`post-code-review`, so its normal start command needs no manual `outputDir`.
Callers may still select another confined project-relative workspace with
`--output-dir`. A fresh `post-code-review` launch cannot reuse a workspace that
already has durable review state. Resume binds to the original run's exact
workspace. Any workflow may select a stable `.locus-pi/workspaces/<name>` workspace
with `--run-name <name>`. An existing legacy-only `.locus-pi/plans/<name>` is
reused at its original physical identity; if both roots exist, launch fails
before child execution.

Each accepted `post-code-review` workspace also owns one optional operator file,
`style.md`. Before launch, the operator may place comment and project-style
criteria at `<selected-workspace>/style.md`. After the workspace is
confined, the runtime opens the existing regular non-symlink file without
changing it, or creates it empty before any child starts. Empty means no extra
operator criteria. A symlink or non-regular leaf fails before review work; the
style agent treats the file as scoped guidance and cannot use it to expand the
review boundary or weaken the read-only filesystem contract.

`--output-dir` and `--resume` may appear in either order before semantic input.
If either option is repeated, the last supplied value wins. Use the conventional
`--` end-of-options delimiter when semantic input begins with `--resume`,
`--output-dir`, `--`, or another option-looking token; the entire remainder
after the delimiter is forwarded byte-for-byte as semantic input. The delimiter
works the same way for `/workflows run`.

### No-operator mode — `--no-operator` / `--operator`

`--no-operator` (value-less, composable with the other run options) turns one
launch into a run-level guarantee for unattended callers: **any request for
operator input fails closed with a named reason instead of parking the run**.
The mode is method-agnostic — it forbids operator input as such, not one API:

- `dsl.awaitOperator(...)` under the mode does not declare a pause. It fails
  the run at the call site: the terminal error and the journal carry
  `Operator input requested but forbidden for this run (no-operator mode):
<the author's reason>`, no `operatorHandoff` envelope is produced, and
  artifacts published before the refusal stay on disk (the workspace outlives
  the failed run, exactly as for any other failure).
- `agent({ ask: true })` under the mode is refused before any child is
  spawned: the call returns a result-shaped failure with the closed cause
  `ask-unavailable` — operator input genuinely is unavailable in this run, by
  launch policy rather than by missing UI.

There is no auto-answer and no recommended-option fallback under the mode: a
fabricated operator input would be a silent wrong success, which is worse than
the named refusal. The run journal opens with
`[workflow:no-operator] operator input is forbidden for this run`, so
`/workflows status` and the persisted run evidence show the mode was active.
Saved children inherit the mode through run coordination and cannot unset it:
one run, one guarantee. The programmatic `workflow` tool exposes the same switch
as the boolean `noOperator` field; embedders use
`RunWorkflowScriptOptions.noOperator`.

**Headless launches turn the mode on by default.** In the one-shot host modes
`print` and `json` there is no operator to reach, so a request for human input
can only park the run until the turn is disposed. Both launch surfaces
therefore default `noOperator` to on there, and the journal of such a run opens
with `[workflow:no-operator] operator input is forbidden for this run (headless
launch: no operator can be reached)` — so a refusal is explicable to a reader
who typed no flag. Interactive hosts (`tui`, `rpc`) are unchanged: the mode
stays opt-in, because their operator input is deliverable.

The default is a default, not a removal: `--operator` (value-less, and the
`workflow` tool's `noOperator: false`) opts back in to the designed
`awaitOperator` split-run pause inside a headless launch, whose durable
artifacts and continuation still work exactly as documented. Explicit always
beats the default in both directions — `--no-operator` turns the mode on in an
interactive session — and a repeated mode flag follows the same last-one-wins
rule as the value options. Continuing a paused headless run with `--resume` is
itself a headless launch, so a second operator gate is refused unless that
continuation also passes `--operator`. The runner never infers the mode from
the host: an embedder calling `runWorkflowScript` directly opts in itself.

### Run from an agent without a wrapper

The installed `locus-pi-workflow-run` skill chooses the execution surface by
capability. When the structured `workflow` tool is available, the agent calls it
directly with `name` or `scriptPath` plus optional `input`, `items`,
`outputDir`, `resumeFromRunId`, or an approved `continuation`. It does not spawn
Pi or translate the request into shell text.

`items` and `continuation` are native-tool-only fields. When either is required
and the structured tool is unavailable, the caller stops as unsupported; it
does not route through the slash command and silently drop the field.

An agent outside Pi invokes the registered command directly in JSON print mode:

```bash
pi --mode json -p --no-session --approve \
  '/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]'
```

The complete slash command is one process argument. A caller should use an argv
array and must not interpolate the target, an option value, or semantic input as
shell syntax. Apply one token rule to the target and every `--output-dir` or
`--resume` value: a simple token remains unchanged; a value containing
whitespace, quotes, backslashes, or controls uses the command parser's JSON
string-token form. Reject a command-token value beginning with `-`; quoting does
not make a reserved Pi option token valid. The output directory remains a safe
project-relative path and the resume value remains a real saved run id. Semantic
input remains unchanged after `--`.

`--approve` grants broad Pi project trust: Pi may load project settings,
packages, extensions, prompts, context files, and other local resources. The
approval is not limited to the selected workflow, and neither Pi nor the
workflow runtime provides an OS, filesystem, subprocess, or network sandbox.
Run only in a trusted project with reviewed workflow sources.

Pi's JSON stream repeats a custom message at `message_start` and `message_end`.
The caller interprets only terminal records whose `message.role` is `custom` and
whose `message.customType` is `locus-workflow-run`, then branches on
`message.details.eventKind`:

| Event               | Meaning                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workflow_start`    | Accepted run identity plus absolute `runDir`, `journalPath`, and canonical expected `resultPath`.                      |
| `workflow_rejected` | Typed pre-start refusal with a closed `code`; no run identity was created.                                             |
| `workflow_end`      | Authoritative `workflowStatus`, run paths, and `resultPersisted` truth after the background run and callbacks settled. |

The skill requires either `workflow_start` or `workflow_rejected` within 30
seconds. That is a caller policy, not a second runtime protocol. After start,
the Pi process remains attached until `workflow_end`; the caller may read or
tail `journalPath` for durable liveness and then read `resultPath` when
`resultPersisted:true`. No second log directory or wrapper event schema exists.

Pi process status is transport evidence only. A registered slash command can
emit `workflow_rejected` or a failed `workflow_end` and still leave Pi with exit
code `0`; callers must use the typed receipt for semantic success. When the
workflow settles as `awaiting_operator`, report the unanswered handoff and stop.
Do not synthesize an answer or launch continuation without explicit operator
input.

### `workflow` tool (programmatic)

The tool stays headless. It validates the launch target and executes the workflow without
opening a human launch prompt.

```json
{ "name": "item-pipeline", "input": "Write concise results.", "items": ["a.ts", "b.ts"] }
```

The tool's `input` is the same optional semantic string as `/workflows run`,
preserved unchanged and not bounded by a character count. `items` is a separate
optional array of strings exposed as a frozen snapshot by `dsl.items()`. It
preserves order and exact values, including whitespace, empty strings, and
duplicates, and adds no count or character limit. The tool's strict
`prepareArguments` hook rejects non-array `items`, non-string members, nested
arrays, `null`, and unknown top-level fields before Pi's schema conversion can
coerce them; direct `execute` and runner/runtime callers are revalidated as well.
An absent list becomes an empty frozen list; a workflow that requires units owns
a named pre-pipeline guard. The human `/workflows run` grammar exposes the same
workspace choice through `--output-dir <safe-project-relative-path>` before the
optional semantic input.
Cross-run state is a
separate closed `continuation` control with one origin and 1–8 complete artifact
refs. `continuation` and replay-only `resumeFromRunId` are mutually exclusive.

Legacy compatibility still accepts `script`, but it only maps to saved names or
project-relative paths.

---

## Run a real workflow (live)

The unit tests use a mocked host. To exercise the runtime for real, run `pi` with a
working model in a scratch project so child agents actually spawn:

1. Point a scratch dir at this package — `.test_pi/.pi/settings.json`:
   ```json
   { "packages": ["<absolute path to your locus-pi checkout>"] }
   ```
2. Drive the registered slash command directly in JSON print mode:
   ```
   cd .test_pi
   pi --mode json -p --approve --no-session --model "<provider/model>" \
     '/workflows run live-smoke -- hello'
   ```
3. Read the terminal `locus-workflow-run` receipt, then verify the child-agent
   evidence in its `journalPath` and the final envelope in its `resultPath`:
   ```
   cat .test_pi/.locus-pi/runs/<runId>/runtime/journal.ndjson
   cat .test_pi/.locus-pi/runs/<runId>/runtime/result.json
   ```
   A real run shows `agent_end` events with `status: "completed"` and a non-empty
   `childSessions.*` session id. If the host cannot spawn a child, the run fails closed
   with the `Pi SDK host` reason (see [fail-closed behavior](trust.md#fail-closed-behavior)) — an honest failure, not a proof.

Interactive `pi` (no `-p`) renders the live progress panel, and for
`workspaceMode: "worktree"` / `"temporary-worktree"` agents Pi native approval can
prompt for writes according to `tools.approvalMode` and `tools.approval.*`.
`locus-pi` no longer adds its own workflow launch gate before runtime starts.

### Live operator questions — `agent({ ask: true })`

A stage that declares `ask: true` gives its child ONE extra tool, `workflow_ask`:
the child submits a list of questions (each with options; free text is always
allowed), the question renders in the parent session through the shared
operator-question surface, and the human's answer returns as the tool result —
the same child continues with the answer in its own context. This is the
interactive complement to `awaitOperator`, which stays the durable split-run
gate: `ask` never parks a run and never creates a continuation.

Owner decision, `.locus/soul.md` direction log 2026-08-19. The load-bearing
rules:

- **Off by default, per call.** The tool exists only for the one child whose
  stage declared `ask: true`. Curated Package workflows remain no-ask by
  construction: unknowns become explicit assumptions, not questions.
- **The stock `ask` is excluded from every workflow child** — declared or not.
  A headless child receives the stock tool's refusal as model-visible text (the
  recorded fabrication probe), and its option timeout auto-answers for the
  operator. `workflow_ask` has no timeout at all; a `recommended` option is a
  display hint, never an automatic choice.
- **No UI fails the call, not the sentence.** In `print`/`json` or any parent
  without an operator surface, a `workflow_ask` call ends the child with
  `failureCause: "ask-unavailable"` — the same fail-closed shape as the
  wall-clock fuse, and equally non-retryable. Unattended pipelines never wait
  on a human.
- **Esc is an answer.** A declined question returns as ordinary text — the
  answers already given plus an "operator declined" note — and the child
  decides how to proceed; nothing hangs and nothing is invented.
- **Concurrent questions queue FIFO.** One workflow question is mounted at a
  time; children asking in parallel are serialized oldest-first, and a question
  evicted by the operator's own editor interaction is re-mounted, not dropped.
  One call may carry any number of questions: they are served one at a time, and
  a count is not a reason to refuse a call the workflow already decided to make.
- **The operator's wait counts against the deadline.** `timeoutMs` is wall clock
  and includes the time a human spends answering. One clock, so the bridge and the
  SDK host cannot disagree about how much time has passed, and there is no hidden
  24-hour allowance to cover a pause the host could not honour. The wait itself is
  recorded in the call's diagnostics (`workflow_ask: operator wait of N ms counted
against the call deadline`), so a call that dies on its deadline while someone was
  thinking says so instead of looking like a slow model. An `ask: true` stage that
  needs thinking time declares a timeout that allows for it, or declares none.
- **Evidence is durable.** Each answered call records one indexed `operator-ask`
  artifact (questions, answers, declined flag) through the run artifact store;
  viewer readback verifies its digest. If persistence fails after the question
  was shown, the current child call aborts with `ask-evidence-persistence`,
  returns no successful answer/ref, and does not remount the same invocation.
- **Replay forks on `ask`.** The call key records the declaration, so a record
  made without `ask` is never served to an asking call, and vice versa. A
  completed call replays its recorded final text as usual; an interrupted call
  re-executes and honestly asks again.
- **The run-level no-operator mode wins.** Under `--no-operator` (or the
  `workflow` tool's `noOperator`), an `ask: true` stage is refused before any
  child is spawned, with the same closed `ask-unavailable` cause. See
  "No-operator mode" above.
