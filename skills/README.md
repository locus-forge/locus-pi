# locus-pi workflow skills

The npm package is the canonical source for three workflow skills.
Pi loads them directly from `package.json#pi.skills`. External agents use managed
symlinks; they do not receive copied skill text that can drift from the package.

| Skill                      | Owns                                                           | Native Pi/API route                                                     | External agent route                                                 |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `locus-pi-workflow-create` | Design, review, Build, source validation; never run            | Follow the packaged skill directly                                      | Follow the managed packaged skill directly                           |
| `locus-pi-workflow-run`    | One existing reviewed workflow run, receipts, evidence, resume | Call the structured `workflow` tool; the skill is only routing guidance | Delegate session ownership to `external-locus-pi`                    |
| `external-locus-pi`        | External interactive Pi session and manual attachment          | Not needed when already inside Pi                                       | Start Pi in a retained terminal; keep the UI available after the run |

## Install for Codex and Claude Code

Run these commands inside Pi after installing the locus-pi package:

```text
/workflows skills status --host all --scope user
/workflows skills sync --host codex --scope user
/workflows skills sync --host claude --scope user
```

`--host all` manages both hosts. `--scope project` writes under the current
project instead of the user home. Codex entries live in `.agents/skills`;
Claude Code entries live in `.claude/skills`.

`sync` creates or refreshes only locus-pi-managed symlinks. It removes managed
links under the retired names, including `locus-pi-workflow-implement-task`. A real directory or foreign symlink is a
conflict and is never overwritten. Ownership comes only from the adjacent
`.locus-pi-workflow-skills.v1.json` provenance file, never from a suggestive
symlink target. `remove` has the same ownership check. The command snapshots
managed links and provenance before mutation and rolls the whole selected host
set back after an unexpected filesystem error.

## Find the installed workflow documentation

The [workflow manual](../docs/workflows/index.md) ships in the same npm package.
Pi loads these skills through `package.json#pi.skills`. Codex and Claude Code may
expose a managed directory symlink as the skill's location. Resolve the physical
`SKILL.md` **before** following any package-relative link; then resolve
`../../docs/workflows/index.md` from its parent directory. Do not use the caller's
working directory or assume a global npm prefix. A copied skill folder without
its package is not the supported installation; use the managed sync above.

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
