# locus-pi workflow skills

The npm package is the canonical source for four workflow skills.
Pi discovers them directly from `package.json#pi.skills`. External agents use managed
symlinks; they do not receive copied skill text that can drift from the package.

| Skill                               | Owns                                                                                  | Native Pi/API route                                                     | External agent route                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `locus-pi-workflow-create`          | Ordinary authoring lesson; reviewed design, checked source and authorized run handoff | Follow the packaged skill directly                                      | Follow the managed packaged skill directly                           |
| `locus-pi-workflow-create-detailed` | Explicitly selected detailed lesson under the same authoring contracts                | Invoke the detailed entry                                               | Follow the managed packaged skill directly                           |
| `locus-pi-workflow-run`             | One existing reviewed workflow run, receipts, evidence, resume                        | Call the structured `workflow` tool; the skill is only routing guidance | Delegate session ownership to `external-locus-pi`                    |
| `external-locus-pi`                 | External interactive Pi session and manual attachment                                 | Not needed when already inside Pi                                       | Start Pi in a retained terminal; keep the UI available after the run |

## Install for Codex and Claude Code

Choose the ordinary or detailed lesson using the [public selection guide](../docs/workflows/create.md#choose-an-authoring-route).
Both are actual packaged entries; the run and external-session skills keep their existing responsibilities.

Run `/workflows doctor` inside Pi to check both apps. Doctor shows the absolute
destination, the state of the four skill links on disk, and a command for the
selected app. For example:

```text
/workflows doctor check --host codex --scope user
/workflows doctor install --host codex --scope user
/workflows doctor check --host codex --scope user
```

Use `--host claude` for Claude Code. The default user destinations are
`~/.agents/skills` for Codex and `~/.claude/skills` for Claude Code. With
`--scope project`, the same subdirectories are under the active Pi project
root. With `--host all`, writes preflight both destinations before changing
either. Use `remove` with the same explicit host and scope to uninstall owned
links. If `CLAUDE_CONFIG_DIR` names a different configuration, Claude user
commands still show the default folder and qualify skill discovery as
unverified. Doctor refuses writes to shared or redirected destinations.
Doctor checks on-disk state. Host startup and skill discovery are separate.

Install creates missing symlinks and refreshes proven links after a package
move. The adjacent `.locus-pi-workflow-skills.v1.json` retains its filename.
New v2 records track a symlink's filesystem identity and raw target. Doctor
uses both to verify ownership before a write. Real files, directories and
foreign or disputed links block a write. Install and remove retire only
proven links on the allowlist `locus-pi-workflows`,
`locus-pi-run-workflow`, `locus-task-workflow` and
`locus-pi-workflow-implement-task`.

Old commands display the new equivalent with the same host and scope. Old
v1 records contain names only. If Doctor reports a v1 or identity conflict,
run the displayed scoped `doctor check` to see the exact paths. Inspect the
disputed links. If you choose to clear them, move them intact to a backup
outside the skills folder, then repeat the check. Keep a link in place if it
must remain available. Doctor leaves that destination blocked. Once the
destination is clear, the scoped `doctor install` touches the four managed
slots and the adjacent marker. The scoped `doctor remove` touches proven
entries and the marker. The backup remains available.

Run one writing command at a time and keep other writers away from the
selected trees until it returns. Doctor can undo verified writes on a later
failure and reports skipped or failed restoration. Node's path-based rename
and unlink cannot guarantee preservation against an undetected concurrent
pathname change after the final check. Process crashes are outside the
rollback guarantee. Run `/workflows doctor recovery` in the same Pi session
and project for the full incomplete-rollback report and its scoped recheck.

## Find the installed workflow documentation

Both authoring entries require the [co-located DSL/API reference](locus-pi-workflow-create/references/dsl.md)
before source is written. It contains every runtime method, signature, example and source-mode constraint.
`docs/workflows/dsl.md` is canonical; `npm run build:catalogs` generates this version-matched projection
and `check:generated` rejects drift. Both this copy and the canonical document ship in the npm package.
Codex and Claude Code reach the same files through their managed skill links, in either user or project scope.

Pi initially advertises each skill's name, description and `SKILL.md` location. For a matching ordinary
request, the agent reads that entry; an explicit `/skill:locus-pi-workflow-create` or
`/skill:locus-pi-workflow-create-detailed` invocation inserts the selected `SKILL.md` body into the request.
Neither discovery nor explicit invocation recursively loads linked files. The authoring instructions
then require the agent to read the linked co-located DSL and selected references before writing source.
Child agents receive the context their workflow prompts supply; references are not silently injected.

The [workflow manual](../docs/workflows/index.md) ships in the same npm package.
Pi discovers these skills through `package.json#pi.skills`. Codex and Claude Code may
expose a managed directory symlink as the skill's location. Resolve the physical
`SKILL.md` **before** following any package-relative link; then resolve
`../../docs/workflows/index.md` from its parent directory. Do not use the caller's
working directory or assume a global npm prefix. A copied skill folder without
its package is not the supported installation; use the managed install above.

Given the actual skill location reported by the host:

```bash
realpath '<skill-location>/SKILL.md'
```

The portable Python equivalent also prints the manual's absolute entry path:

```bash
python3 - '<skill-location>/SKILL.md' <<'PYDOC'
from pathlib import Path
import sys
skill = Path(sys.argv[1]).resolve(strict=True)
manual = (skill.parent / "../../docs/workflows/index.md").resolve(strict=True)
print(manual)
PYDOC
```

This follows Pi's own packaging pattern: it [ships a docs directory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)
and its [system prompt supplies the absolute docs path](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts).
That path identifies Pi's documentation; the physical skill identifies the Locus
package and its version-matched manual.

## Model selection

For an external Pi invocation, select the main Pi model and reasoning level on
the command line:

```bash
pi --approve \
  --model '<provider/model>' --thinking high \
  '/workflows run <name> -- <semantic input>'
```

Child model routing is separate. Configure roles through `/model-roles` or
`~/.pi/agent/model-roles/config.json`. An unassigned role inherits the main Pi
model.
`--approve` is broad project trust, not workflow-only approval.

For an inspectable session launched from Codex or Claude Code, use
[`external-locus-pi`](external-locus-pi/SKILL.md). It returns a command to attach
to the same interactive Pi terminal. JSON print mode is an explicit alternative
for non-interactive output, not the default external session.
