# workflows

`workflows` is the trusted JavaScript workflow runtime. It discovers Package, project, user, and retained-history entries; runs child-agent graphs; and persists inspectable evidence.

## Child startup timing

Every fresh workflow child records startup marks in the native `journal.ndjson` as
`kind: "log"`, `source: "runtime"`, with `callId`, a readable `message`, and a structured
`startup` mark. The per-call result envelope and bridge result contain the ordered
`startup` array, including marks retained on failure. Replayed calls create no child
and produce no fresh startup measurements.

The marks, in order, are `agent_start`, `model_roles_load_start`, `model_roles_loaded`,
`model_resolve_start`, `model_resolved`, `capability_checked`, `runner_enter`,
`sdk_host_enter`, `sdk_import_start`, `sdk_imported`, `session_options_start`,
`session_manager_start`, `session_manager_created`, `resources_load_start`,
`resources_loaded`, `create_session_start`, `session_ready`, `first_provider_request`,
and `first_provider_response`. Resource loading includes extension discovery/loading
through `DefaultResourceLoader.reload`; session construction includes Pi's subsequent
extension initialization. Provider marks observe the stream dispatch and first response
or raw stream-event callback (including WebSocket responses), rather than inferring a provider call from Pi's `agent_start` or `model_change`.
Marks for work that never happens are absent.

Each mark carries ISO wall-clock `ts`, cumulative monotonic `elapsedMs`, and intervals
since the previous mark: `wallMs`, `cpuUserMs`, `cpuSystemMs`, and maximum
`eventLoopDelayMs`. The first mark has zero intervals. CPU measures the whole process,
including concurrent children; it is not a per-agent CPU allocation. Event-loop delay
uses a 10 ms sampler and samples again at each mark to retain synchronous blocking
before the timer can run.

Startup has a separate **120,000 ms** limit, from admission `agent_start` to
`session_ready`; queue wait is excluded. The host captures a shared monotonic/wall-clock
and process-CPU snapshot immediately before writing `agent_start`, so synchronous journal
and event-handler time counts in both the measurements and the startup deadline. Set `LOCUS_PI_WORKFLOW_STARTUP_TIMEOUT_MS`
in Pi's environment to a positive integer number of milliseconds to override it.
Invalid values fail explicitly. The overall call timeout, model selection and retry
allowlist retain their existing behavior. First provider request/response are measured
after readiness and remain governed by the existing call/turn deadlines.

If startup expires, the call fails with `failureCause: "startup-timeout"` and a reason
such as `Agent startup exceeded its 120000 ms limit; last completed stage: resources_load_start.`
This cause is not automatically retried. Pending SDK work cannot always be interrupted,
but late-created sessions are disposed exactly once without prompting, including a
synchronous factory overrun returning an already-resolved Promise. Run cancellation also
interrupts role loading and model resolution immediately, preserves `cancelled`, and
releases the startup deadline and sampler. A synchronous JavaScript block
cannot be preempted: expiry is enforced at its next mark or bounded await. These marks
expose the location of a slow launch; they do not diagnose or repair its cause.

## Surface

```text
/workflows
/workflows list [query]
/workflows dashboard
/workflows info [name]
/workflows status [runId]
/workflows result [runId|last]
/workflows run <name|path> [--run-name <name> | --workspace-dir <path>] [--resume <runId>] [--force] [--no-operator|--operator] [--] [input] | --input-json <JSON tail>
/workflows continue <runId>
/workflows stop [runId|last]
/workflows doctor [check|install|remove] [--host codex|claude|all] [--scope user|project]
/workflows doctor recovery
```

Tools: `workflow`, read-only `workflow_check_source`, and opt-in `fusion`. Compatibility command: `/workflow-stop`.

An accepted workflow command clears the preceding temporary panel and keeps pinned progress visible.
Use `/workflows status` to inspect run evidence. A built-in command such as `/settings` or a
third-party command outside the workflow lifecycle leaves a stale workflow warning visible.
Press Escape to dismiss an unpinned warning while Pi handles the key normally. The warning's
record, run details, journals, results, and error logs remain available. Escape also closes
passive command views on both legacy and Kitty terminals.

Pi may wait to run a workflow command you enter while another command is still running.
An unpinned workflow error panel that appears during the wait can disappear when your
command starts. Your command still runs. Open `/workflows status <runId>` to see the failed
run and its stages. The full error stays in that run's `runtime/result.json`:
`.locus-pi/runs/<runId>/` for a root run, or `attempts/<runId>/` (a `--resume` attempt) and
`children/<runId>/` (a saved child) inside the original run's folder.
`.locus-pi/logs/errors.jsonl` keeps a shortened message.

At normal interactive heights, `/workflows list` keeps the Project, User, Package, and History tabs directly below the catalog heading and opens on Project whenever it contains a selectable workflow. The existing compact projection may omit the heading or put the selected row first when only a few lines fit. Wherever tabs are shown, the active tab uses the shared high-contrast purple selection background. The source view uses the same treatment for its left-to-right Start, Back, Edit, Review, and copy actions, with Start focused first for a ready current workflow. Start restores a direct command for untyped workflows and a complete native-run request for static `meta.inputSchema`; neither form submits editor text itself. After the user submits the typed request, the agent prepares canonical `inputValue` and calls the native `workflow` tool, whose extension-owned interactive confirmation is the review boundary; the route does not require package skills and unavailable capability never falls back to a shell or slash command. A parent description starts one column to the right of its child's `└` branch, so the description remains attached to the parent instead of reading like a heading for the child. See the cross-extension [TUI visual language](../../docs/tui-design.md).

`/workflows doctor` checks the package's four external-agent skill links and
shows each absolute destination and next command. A scoped `install` creates
or repairs owned links, and `remove` uninstalls them. Pi already discovers
the packaged skills. See the [skills installation guide](../../skills/README.md#install-for-codex-and-claude-code)
for paths, legacy recovery and the single-writer boundary. Use
`/workflows doctor recovery` for incomplete rollback details.

Explicit [typed input](../../docs/workflows/dsl.md#typed-workflow-input) uses `meta.inputSchema` and tool `inputValue` or terminal command `--input-json`. The run skill can prepare canonical JSON and an editable command without launching; interactive programmatic tool launches detach the complete request, resolve and hash the source, and show its safe locator, SHA-256, effective workspace, and bounded typed value in the extension-owned confirmation and current-call tool card, while slash launches keep JSON visible in the editor and bypass both. Catalog Start retains the selected target and entry-byte digest behind a one-use `catalogSelectionId`, so unrelated calls cannot consume it; a newer Start supersedes the prior unsubmitted editor handoff, steering or follow-up input carrying the ID marks it submitted, later streaming input preserves it until its tool call, and the next idle user input retires an ID it does not carry. Missing or mismatched IDs fail while the submitted catalog request remains outstanding, and explicit reuse, shadowing, or byte drift still fails closed. Admission enforces the confirmed digest and displayed workspace selection, including its project root, before import or workspace creation. Confirmation follows the parent abort signal, settles locally after five minutes even for an inert adapter, and reports cancellation as a tool error. The runtime validates and freezes JSON before entry; inline/saved children validate their own explicit schemas. Typed continuation keeps the JSON and receives its separate operator answer through optional root context. Legacy text remains exact.

Both checked authoring profiles admit bounded literal-schema [immutable structured results v4](../../docs/workflows/agent-results.md#structured-results-v4) on the actual verified Pi >=1.0.0 `openai-codex` route. `validate`, `repair` and `outputTransport` remain removed; the return tool carries the actual schema and requests Pi strict preference only where semantics are preserved. The checked [dataflow-v1 profile](../../docs/workflows/source-shape.md#checked-dataflow-v1) adds bounded synchronous data helpers and visible owned keyed graphs with full-source resume identity. Historical v5 evidence remains readable but cannot replay as current output. Host permissions are unchanged.

The `workflow` tool is the structured execution surface for agents. It supports fields that cannot always be represented safely by slash-command text, including caller `items` and approved continuations.

`workflow_check_source` validates one project-relative `.workflow.mjs` file up to 512 KiB against the standard authoring grammar. It reads the source as text and never imports or executes the workflow. Results include stable error/warning codes, one-based source spans and the checked source digest; Node syntax is checked without import too. Warning-only checks remain successful. The Pi `tool_result` boundary preserves rejected checks and failed native runs as machine errors with their structured diagnostics.

Create-only returns checked source and a command without execution. Authorized create-and-run continues through the run skill. `task/plan` writes the caller-assigned workflow.mjs in one author call, then performs at most three reviews and two revisions. `task/plan-light` grows the same exact file through at most six complete graph-node slices with mechanical and design gates. Every relevant stage receives the whole input with identical source, draft, design, report and log destinations. Source bytes never travel in model answers. Agents save files through ordinary tools; no DSL publication is required. Before launch the consumer reopens the assigned regular nonempty source, confirms successful review covers the current source and repeats current Node/source checks. Source or evidence changes require review of the affected scope against the design and Task; no stored source digest is required for this handoff. Completion never attests file delivery. See [authoring](../../docs/workflows/authoring.md).

## Typed input launch errors

Supply `inputValue` as the native JSON value required by `meta.inputSchema`.
For an object schema with a `reviewMode` property, the tool arguments can be:

```json
{ "name": "typed-review", "inputValue": { "reviewMode": "adaptive" } }
```

Applying `JSON.stringify` to that inner object makes `inputValue` a string. When
the schema requires an object or array, admission rejects the string and explains
how to pass the native value. JSON-looking strings remain exact when the schema
accepts strings. Legacy `input` cannot launch a workflow that declares
`meta.inputSchema`; the error directs the caller to `inputValue`.

In Pi's command editor, put all options before `--input-json` and use raw JSON:

```text
/workflows run typed-review --input-json {"reviewMode":"adaptive"}
```

Outer single quotes are literal command text, so `'{"reviewMode":"adaptive"}'`
is invalid JSON. The parse error asks the caller to remove those quotes; it does
not strip them or reinterpret valid JSON strings. A saved root uses just its
name (`typed-review`); `typed-review/child` selects a separate child entry.

## Evidence and workspaces

- Open `.locus-pi/runs/<storageRootRunId>/README.md`: it is the shared folder for the first launch, child executions, and resume attempts. The first launch stores `outputs/` and `runtime/` directly there; children live in `children/<runId>/`, and resume attempts in `attempts/<runId>/`.
- Each execution has a separate `runId`. The status/result/resume commands find it regardless of nesting; old flat runs remain in place and readable without migration.
- Completion cards link a saved structured result to its exact JSON record and name `/workflows status <runId>` for inspecting the run's evidence. `completed` describes execution, not acceptance of an arbitrary returned object. Prose results keep their text file; `/workflows result <runId>` is offered when the canonical record was also persisted. Otherwise the card points to the run inspector and the available text file, without linking an unsaved JSON record.
- The workspace file `.workflow-runs.md` contains backlinks to groups. The README and backlink are replaced atomically only under the active root lease. An incomplete runtime-owned README is restored, while an incomplete backlink requires explicit recovery without losing earlier links. This is navigation, not a current-status summary: each execution's state is in its `runtime/result.json` and `runtime/journal.ndjson`.
- Default native runtime workspace: a unique `.locus-pi/workspaces/<generated-run-name>/` directory.
- Any workflow supports `--run-name <name>` to select `.locus-pi/workspaces/<name>/`; an existing legacy-only `.locus-pi/plans/<name>/` stays in place so resume and checkpoint identity remain stable.
- Run evidence, native workspace coordination and exact caller-assigned user files have distinct owners. Runtime leases do not fence arbitrary prompt destinations.
- `.locus-pi/workflow-state/v1/<hash>/` owns the runtime-workspace `lease.json`, short-lived `reclaim.json`, and saved-child checkpoints. A normal run can leave an empty state directory after releasing its temporary workspace lock.
- `.locus-pi/logs/errors.jsonl` is the shared host error journal. Removing it loses diagnostics but neither releases nor acquires workflow ownership.
- Loose `.locus-pi/plans/*.md` files are plan documents left by the removed `plan` extension; they are user data, not workflow workspace storage.

`--force` reclaims only a leaked lease whose exact run has a complete matching terminal envelope written after lease release. It never kills a process, overwrites an active/unverifiable owner, or removes an existing reclaim guard. See [operator recovery](../../docs/workflows/running.md#workspace-and-output-ownership-recovery).

## Trust

Workflow modules execute in the Pi Node.js host and are not sandboxed. Review project and user workflows before running them. The workflow tool owns interactive confirmation; explicit slash and one-shot launches own their authorization at the caller surface.

## More documentation

- [Operator workflow guide](../../docs/workflows/running.md)
- [Readable authoring contract](../../docs/workflows/create.md)
- [Advanced runtime and DSL reference](../../docs/workflows/index.md)
- [Output acceptance](../../docs/workflows/agent-results.md) — exact text, exact choice and opt-in structured JSON results, and the
  single statement of what the runtime does and does not bound
- [Packaged examples](../../examples/workflows/README.md)
- [Manifest](manifest.json)
