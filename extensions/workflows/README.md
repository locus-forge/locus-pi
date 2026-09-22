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
/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]
/workflows continue <runId>
/workflows stop [runId|last]
/workflows skills <sync|status|remove> [--host codex|claude|all] [--scope user|project]
```

Tools: `workflow`, read-only `workflow_check_source`, and opt-in `fusion`. Compatibility command: `/workflow-stop`.

At normal interactive heights, `/workflows list` keeps the Project, User, Package, and History tabs directly below the catalog heading. The existing compact projection may omit the heading or put the selected row first when only a few lines fit. Wherever tabs are shown, the active tab uses the shared high-contrast purple selection background. The source view uses the same treatment for its left-to-right Back, Start, Edit, Review, and copy actions. A parent description starts one column to the right of its child's `└` branch, so the description remains attached to the parent instead of reading like a heading for the child. See the cross-extension [TUI visual language](../../docs/tui-design.md).

`/workflows skills` exposes the package's action-named workflow skills to
external agents. Pi already loads the packaged skills. The command manages
fail-closed symlinks in Codex `.agents/skills` and Claude Code `.claude/skills`;
the adjacent `.locus-pi-workflow-skills.v1.json` file records ownership, so it
never infers ownership from a path or replaces a real directory or foreign
symlink. See
[`skills/README.md`](../../skills/README.md).

The `workflow` tool is the structured execution surface for agents. It supports fields that cannot always be represented safely by slash-command text, including caller `items` and approved continuations.

`workflow_check_source` validates one project-relative `.workflow.mjs` file up to 512 KiB against the standard authoring grammar. It reads the source as text and never imports or executes the workflow. Results include stable error/warning codes, one-based source spans and the checked source digest; Node syntax is checked without import too. Warning-only checks remain successful. The Pi `tool_result` boundary preserves rejected checks and failed native runs as machine errors with their structured diagnostics.

Create-only returns checked source and a command without execution. An authorized create-and-run request continues through the run skill and reports actual terminal evidence, not just static validation. `task/plan` grows one authoritative workspace `workflow.mjs` through at most six complete graph-node slices. Each accepted slice leaves a runnable checker-clean module; mechanical failures enter the single per-slice correction before independent recheck, while a separate design review guards graph conformance. Source bytes never travel in model answers. Final whole-file gates precede `publishPrimaryFile("workflow.mjs")`, so the host returns the validated workspace path, byte count, and digest as `primaryFile`; it does not copy the file into run `outputs/`. See [authoring](../../docs/workflows/authoring.md).

## Evidence and workspaces

- Open `.locus-pi/runs/<storageRootRunId>/README.md`: it is the shared folder for the first launch, child executions, and resume attempts. The first launch stores `outputs/` and `runtime/` directly there; children live in `children/<runId>/`, and resume attempts in `attempts/<runId>/`.
- Each execution has a separate `runId`. The status/result/resume commands find it regardless of nesting; old flat runs remain in place and readable without migration.
- The workspace file `.workflow-runs.md` contains backlinks to groups. The README and backlink are replaced atomically only under the active root lease. An incomplete runtime-owned README is restored, while an incomplete backlink requires explicit recovery without losing earlier links. This is navigation, not a current-status summary: each execution's state is in its `runtime/result.json` and `runtime/journal.ndjson`.
- Default workflow workspace: a unique `.locus-pi/workspaces/<generated-run-name>/` directory.
- Any workflow supports `--run-name <name>` to select `.locus-pi/workspaces/<name>/`; an existing legacy-only `.locus-pi/plans/<name>/` stays in place so resume and checkpoint identity remain stable.
- Explicit output directories must remain safe, project-relative paths.
- Run evidence and the workflow workspace are separate ownership zones.
- `.locus-pi/workflow-state/v1/<hash>/` is active lease and saved-child checkpoint state. A normal run can leave an empty state directory after releasing its temporary workspace lock.
- Loose `.locus-pi/plans/*.md` files are plan documents left by the removed `plan` extension; they are user data, not workflow workspace storage.

## Trust

Workflow modules execute in the Pi Node.js host and are not sandboxed. Review project and user workflows before running them. Pi approvals remain the enforcement owner.

## More documentation

- [Operator workflow guide](../../docs/workflows.md)
- [Readable authoring contract](../../docs/locus-pi-workflows.md)
- [Advanced runtime and DSL reference](../../docs/workflows/index.md)
- [Output acceptance](../../docs/workflows/agent-results.md) — the shaped-result API, and the
  single statement of what the runtime does and does not bound
- [Packaged examples](examples/README.md)
- [Manifest](manifest.json)
