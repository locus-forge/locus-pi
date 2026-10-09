# workflows

`workflows` is the trusted JavaScript workflow runtime. It discovers Package, project, user, and retained-history entries; runs child-agent graphs; and persists inspectable evidence.

## Surface

```text
/workflows
/workflows dashboard
/workflows list [query]
/workflows info [name]
/workflows status [runId]
/workflows result [runId|last]
/workflows run <name|path> [--run-name <name> | --workspace-dir <path>] [--resume <runId>] [--force] [--no-operator|--operator] [--] [input] | --input-json <JSON tail>
/workflows continue <runId>
/workflows stop [runId|last]
/workflows skills <sync|status|remove> [--host codex|claude|all] [--scope user|project]
```

Tools: `workflow`, read-only `workflow_check_source`, and opt-in `fusion`. Compatibility command: `/workflow-stop`.

At normal interactive heights, `/workflows list` keeps the Project, User, Package, and History tabs directly below the catalog heading. The existing compact projection may omit the heading or put the selected row first when only a few lines fit. Wherever tabs are shown, the active tab uses the shared high-contrast purple selection background. The source view uses the same treatment for its left-to-right Back, Start, Edit, Review, and copy actions. Start restores a direct command for untyped workflows and an editable `locus-pi-workflow-run` handoff for a source with static `meta.inputSchema`; neither form submits editor text. A parent description starts one column to the right of its child's `└` branch, so the description remains attached to the parent instead of reading like a heading for the child. See the cross-extension [TUI visual language](../../docs/tui-design.md).

`/workflows skills` exposes the package's action-named workflow skills to
external agents. Pi already discovers the packaged skills. The command manages
all four entries, including the ordinary and detailed authoring lessons; the
[create guide](../../docs/workflows/create.md#choose-an-authoring-route) owns selection and explicit invocations. It manages
fail-closed symlinks in Codex `.agents/skills` and Claude Code `.claude/skills`;
the adjacent `.locus-pi-workflow-skills.v1.json` file records ownership, so it
never infers ownership from a path or replaces a real directory or foreign
symlink. See
[`skills/README.md`](../../skills/README.md).

Explicit [typed input](../../docs/workflows/dsl.md#typed-workflow-input) uses `meta.inputSchema` and tool `inputValue` or terminal command `--input-json`. The run skill shows canonical `inputValue` before launch, and the tool card shows a bounded canonical preview of current-call JSON for pre-start diagnostics without adding another persisted value. The runtime validates and freezes JSON before entry; inline/saved children validate their own explicit schemas. Typed continuation keeps the JSON and receives its separate operator answer through optional root context. Legacy text remains exact.

Both checked authoring profiles admit bounded literal-schema [immutable structured results v4](../../docs/workflows/agent-results.md#structured-results-v4) on the actual verified Pi >=1.0.0 `openai-codex` route. `validate`, `repair` and `outputTransport` remain removed; the return tool carries the actual schema and requests Pi strict preference only where semantics are preserved. The checked [dataflow-v1 profile](../../docs/workflows/source-shape.md#checked-dataflow-v1) adds bounded synchronous data helpers and visible owned keyed graphs with full-source resume identity. Historical v5 evidence remains readable but cannot replay as current output. Host permissions are unchanged.

The `workflow` tool is the structured execution surface for agents. It supports fields that cannot always be represented safely by slash-command text, including caller `items` and approved continuations.

`workflow_check_source` validates one project-relative `.workflow.mjs` file up to 512 KiB against the standard authoring grammar. It reads the source as text and never imports or executes the workflow. Results include stable error/warning codes, one-based source spans and the checked source digest; Node syntax is checked without import too. Warning-only checks remain successful. The Pi `tool_result` boundary preserves rejected checks and failed native runs as machine errors with their structured diagnostics.

Create-only returns checked source and a command without execution. Authorized create-and-run continues through the run skill. `task/plan` writes the caller-assigned workflow.mjs in one author call, then performs at most three reviews and two revisions. `task/plan-light` grows the same exact file through at most six complete graph-node slices with mechanical and design gates. Every relevant stage receives the whole input with identical source, draft, design, report and log destinations. Source bytes never travel in model answers. Agents save files through ordinary tools; no DSL publication is required. Before launch the consumer reopens the assigned regular nonempty source, checks persisted reviewed-byte identity and repeats current Node/source checks. Completion never attests file delivery. See [authoring](../../docs/workflows/authoring.md).

## Evidence and workspaces

- Open `.locus-pi/runs/<storageRootRunId>/README.md`: it is the shared folder for the first launch, child executions, and resume attempts. The first launch stores `outputs/` and `runtime/` directly there; children live in `children/<runId>/`, and resume attempts in `attempts/<runId>/`.
- Each execution has a separate `runId`. The status/result/resume commands find it regardless of nesting; old flat runs remain in place and readable without migration.
- The workspace file `.workflow-runs.md` contains backlinks to groups. The README and backlink are replaced atomically only under the active root lease. An incomplete runtime-owned README is restored, while an incomplete backlink requires explicit recovery without losing earlier links. This is navigation, not a current-status summary: each execution's state is in its `runtime/result.json` and `runtime/journal.ndjson`.
- Default native runtime workspace: a unique `.locus-pi/workspaces/<generated-run-name>/` directory.
- Any workflow supports `--run-name <name>` to select `.locus-pi/workspaces/<name>/`; an existing legacy-only `.locus-pi/plans/<name>/` stays in place so resume and checkpoint identity remain stable.
- Run evidence, native workspace coordination and exact caller-assigned user files have distinct owners. Runtime leases do not fence arbitrary prompt destinations.
- `.locus-pi/workflow-state/v1/<hash>/` owns the runtime-workspace `lease.json`, short-lived `reclaim.json`, and saved-child checkpoints. A normal run can leave an empty state directory after releasing its temporary workspace lock.
- `.locus-pi/logs/errors.jsonl` is the shared host error journal. Removing it loses diagnostics but neither releases nor acquires workflow ownership.
- Loose `.locus-pi/plans/*.md` files are plan documents left by the removed `plan` extension; they are user data, not workflow workspace storage.

`--force` reclaims only a leaked lease whose exact run has a complete matching terminal envelope written after lease release. It never kills a process, overwrites an active/unverifiable owner, or removes an existing reclaim guard. See [operator recovery](../../docs/workflows/running.md#workspace-and-output-ownership-recovery).

## Trust

Workflow modules execute in the Pi Node.js host and are not sandboxed. Review project and user workflows before running them. Pi approvals remain the enforcement owner.

## More documentation

- [Operator workflow guide](../../docs/workflows/running.md)
- [Readable authoring contract](../../docs/workflows/create.md)
- [Advanced runtime and DSL reference](../../docs/workflows/index.md)
- [Output acceptance](../../docs/workflows/agent-results.md) — exact text, exact choice and opt-in structured JSON results, and the
  single statement of what the runtime does and does not bound
- [Packaged examples](../../examples/workflows/README.md)
- [Manifest](manifest.json)
