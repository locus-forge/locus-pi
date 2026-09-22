---
title: Launch and operate a workflow
type: guide
status: active
updated: "2026-09-22T17:02:17Z"
source_commit: "5365d3f8cd9c"
update_event: "cleanup"
context: "changes=XL files=46"
description: "Consolidate workflow contracts at their owning pages and repair outdated guidance."
---

# Launch and operate a workflow

[Documentation](../index.md) · [Create a workflow](create.md) · [DSL reference](dsl.md) · [Workflow topics](index.md)

Start with a [checked workflow](create.md) or choose an [installed example](../../examples/workflows/README.md).
Use this page to launch it, inspect agents and results, and choose a fresh run,
recorded-call replay, or operator continuation.

## Run a saved workflow

After [creating and checking project-tour](create.md#your-first-workflow),
start Pi in that project and run:

```text
/workflows run project-tour
```

Wait for Pi to finish its current response before launching. The command returns
to the editor while the agents work. The live panel shows their progress and the
run ID; two exploration agents run together, followed by the summary agent.

- Open `/ps`, select an agent with Up/Down, and press Enter to read its output.
  Esc returns without stopping the run. This viewer is available with the full
  package; a Workflow-only installation still has workflow status and results.
- Use `/workflows status` to find a run, then `/workflows status <runId>` for details.
- Read the completed answer with `/workflows result last` or `/workflows result <runId>`.
- Stop active work with `/workflows stop <runId>`.

## Read the full result

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

## Run again or resume

| What you want                       | Command                                        | What happens                                                                        |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Read the current project again      | `/workflows run project-tour`                  | A fresh run with a new workspace; agents execute again.                             |
| Reuse eligible recorded steps       | `/workflows run project-tour --resume <runId>` | A new attempt in the original workspace; matching recorded answers can be reused.   |
| Answer a workflow's pending handoff | `/workflows continue <runId>`                  | Opens an actionable operator handoff; after your answer, starts a continuation run. |

Use the full run ID from the run directory name (for example,
`20260922-120027-07ef`), not the short `#07ef` badge shown in the panel.

Resume reuses answers, not file changes or a fresh reading of the project. Use a
fresh run when you want new observations. After repairing a workflow, check the
replay markers to see what was actually reused. Parallel calls can change order
and cause an attempt to execute fresh even when the source is unchanged. If the original run selected a
workspace with `--run-name` or `--output-dir`, repeat that same selector and value.
See [replay details](replay.md) and [operator handoffs](recovery-and-continuation.md#human-continuation).

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

An agent outside Pi defaults to the [external-locus-pi skill](../../skills/external-locus-pi/SKILL.md),
which starts a retained interactive Pi session the operator can attach to and inspect.
It dispatches the registered workflow command directly and leaves the terminal open.
Use the following JSON print route only when non-interactive execution is explicitly requested:

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
separate closed `continuation` control with one origin and one or more complete
artifact refs, with no package upper count limit. `continuation` and replay-only `resumeFromRunId` are mutually exclusive.

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

## Run evidence

Open the group README: it links the original launch, workspace, saved children, and resume attempts.

```text
.locus-pi/runs/<storageRootRunId>/
  README.md   links to the workspace and all execution types
  outputs/    human-readable host projection
  runtime/    machine evidence and continuation authority
    journal.ndjson         append-only lifecycle evidence
    result.json            terminal result, run metadata, and bounded finalization errors
    replay.ndjson          replay records when the source is eligible
    script-<sha256>.workflow.mjs
    artifacts/             answers, transcripts, result envelopes, inputs, and publications
  children/<runId>/         separate outputs/ and runtime/ for each saved child
  attempts/<runId>/         separate outputs/ and runtime/ for each resume attempt
```

Workflow-owned working files live separately under a unique `.locus-pi/workspaces/<generated-run-name>/` directory by default or in an explicit confined output directory. Independent root launches receive different groups even in one session; resume uses the original workspace but writes its own receipt. The workflow workspace and run-evidence directory must never resolve to the same directory. Loose `.locus-pi/plans/*.md` files are plan documents left by the removed `plan` extension: user data, not workflow workspaces.

The workflow workspace is the durable location for handoffs, final results,
review evidence, and explicit resume inputs. Keep disposable environments,
dependency caches, test basetemp, transient renderer output, and staging in
ordinary OS or tool temporary and cache locations. If renderer output is the
final deliverable, write or promote it into the workflow workspace. Promote any
scratch output needed for review or resume before its temporary or cache location
expires. This guidance reduces accidental mixing; an authored prompt that
explicitly requests another placement remains authoritative.

Workspace `.workflow-runs.md` contains backlinks. It is a reserved runtime file: a user file with this name is never overwritten, and the launch explicitly rejects. The group README and backlink are replaced with complete durable content through temp+rename and parent-directory sync. An incomplete runtime-owned README is restored from root metadata; an incomplete backlink returns an explicit recovery error so earlier links are not lost. The shared pages contain permanent links, not the “latest status”; see each execution's current state in its `runtime/result.json` and journal. They are written only by the root under the workspace lease, never after it is released.

Old flat runs remain readable and resumable in place. Each runId is resolved through the shared confined lookup; symlink paths and ambiguous IDs are never selected arbitrarily. A safely located resume adds `attempts/<newRunId>/`; an early unsafe or missing source stores a separate rejected receipt. Runs and workspaces are never migrated or deleted automatically.

`runtime/journal.ndjson` is the chronological event authority. New `runtime/result.json` envelopes do not repeat the full journal. They retain only typed bounded finalization errors that must survive an independent best-effort journal write failure. Older envelopes with an embedded journal remain readable.

`.locus-pi/workflow-state/v1/<hash>/` is active runtime state. It holds the workspace lease namespace and saved-child checkpoints. A workflow with no saved children can leave this directory empty after its temporary lock is released; that empty directory is not legacy run evidence.

Use `/workflows result` for complete prose output and `/workflows status` for stages, evidence, replay markers, and actionable handoffs.

Root results and direct `parallel()`/`pipeline()` returns share one terminal-outcome rule. A JSON object is semantic failure when `ok === false`, `partial === true`, or `status` is `"failed"`, `"blocked"`, or `"cancelled"`. The original result remains in evidence, but the durable workflow disposition is `failed`. Other JSON-safe shapes retain legacy success semantics.

## Recovery and further controls

For a stopped run, follow [recovery and continuation](recovery-and-continuation.md)
and the [replay contract](replay.md#continuing-a-repaired-workflow). Replayed answers
do not re-create files: preserve the source workspace and inspect what was actually reused.

[Model roles](models.md#use-model-roles) select models independently of source.
[Fusion](fusion.md) describes multi-model panels and their separate opt-in tool.
[Trust and approvals](trust.md) explains execution permissions and source identity.
