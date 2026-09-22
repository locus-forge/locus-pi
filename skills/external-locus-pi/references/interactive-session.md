# Interactive Pi in a retained terminal

Use an installed tmux or a verified equivalent terminal supervisor. The example
below uses a unique socket and local configuration, so it changes no other tmux
session. Do not enable automatic restart. The user can attach to this same Pi,
including after its workflow completes.

## Native command

Inside Pi:

```text
/workflows run <name> -- <semantic input>
```

For a workflow that may continue normally, preserve the original input/workspace
and add the run skill's exact `--resume <runId>` option. Never resume an orphaned
call just because a previous session disappeared.

The interactive CLI accepts that entire slash command as one argv value:

```text
["pi", "--approve", "--session-dir", "<session directory>", "/workflows run <name> -- <semantic input>"]
```

Place any explicitly requested `--model` and `--thinking` before that final
argument. Keep stdin/stdout on the terminal PTY: redirection or a pipe can switch
Pi into print mode. Do not add `-p`, `--mode json`, `--no-session`, shell string
interpolation, or an outer agent prompt.

## Launch example

The caller supplies launch JSON with the authorized `cwd` and complete `argv`
array above, plus a NEW task-owned directory. For an empty Pi session omit the
final workflow command. Store sessions under the chosen launch directory or an
explicit operator-selected location; do not change global Pi configuration.

```python
import json
import pathlib
import shutil
import subprocess
import sys
import uuid

launch = json.loads(pathlib.Path(sys.argv[1]).read_text())
attempt = pathlib.Path(sys.argv[2]).resolve()
attempt.mkdir()  # Do not overwrite an earlier launch.
tmux = shutil.which("tmux")
if tmux is None:
    raise RuntimeError("An interactive terminal supervisor is required")
config = attempt / "tmux.conf"
config.write_text(
    "set-option -g remain-on-exit on\n"
    "set-option -s extended-keys on\n"
    "set-option -s extended-keys-format csi-u\n"
)
socket = "locus-pi-" + uuid.uuid4().hex
record = {"socket": socket, "session": "pi", "launch": launch,
          "attachArgv": [tmux, "-L", socket, "attach-session", "-t", "pi"]}
record_path = attempt / "supervisor.json"
record_path.write_text(json.dumps(record, indent=2) + "\n")
created = subprocess.run(
    [tmux, "-L", socket, "-f", str(config), "new-session", "-d", "-P",
     "-F", "#{session_id}|#{pane_id}|#{pane_pid}", "-s", "pi",
     "-c", launch["cwd"], "-x", "120", "-y", "40", *launch["argv"]],
    check=True, text=True, capture_output=True,
)
record["created"] = created.stdout.strip()
record_path.write_text(json.dumps(record, indent=2) + "\n")
```

Read back `pane_dead`, PID/start, cwd and the native workflow start/rejection.
Save a pane snapshot with `capture-pane -p` for human diagnostics. The workflow's
own journal/result and artifact files are the durable machine evidence; a pane
snapshot is not a JSON receipt. Match run bindings rather than choosing another
session's `latest` run. A failed launcher client may still have created a session:
inspect the recorded socket before retrying.

## Manual inspection and saved sessions

Give a shell-quoted rendering of `attachArgv`, or pass it directly to a terminal
process API with a capable TTY; `TERM=dumb` cannot attach. The same attachment accepts `-r` for read-only inspection. Detach
with `Ctrl-b`, then `d`; do not send exit or interrupt as a detach shortcut.
Ordinary commands can be typed inside Pi. For external input into an existing
idle pane, use literal text or a tmux paste buffer, then Enter separately; check
the current prompt first and avoid key-by-key interpolation of task text.

To stop a running workflow, enter `/workflows stop <runId>` in this same Pi.
Read back the editor before submitting. If autocomplete shows the run id, press
Escape to dismiss that completion, read back the unchanged command, then Enter.
An Enter that accepts a completion has not sent the command: if the exact stop
text remains in the editor, submit it without clearing and retyping it. Check
for the stop acknowledgement and then the matching terminal result with
`disposition.status: "cancelled"`; typed text alone proves neither. Stop is
idempotent. Never reuse this retry rule to launch a workflow again.

Interactive slash launches return control while their child agents work; the
initial CLI argument uses the same command launcher. Keep the Pi session alive
after stopping. Normal Pi shutdown aborts and drains owned workflow runs before
exit, but forced termination or lost terminals can still leave an interrupted
run without a result. Use the workflow's saved result, not Pi's exit code, to
distinguish those outcomes.

Pi keeps the UI alive after the initial extension command. Session saving stays
enabled, but command-only sessions in Pi 0.84.1 may not create their JSONL file
until a real parent assistant message exists. Verify the actual file before
claiming it can be reopened with `pi --session <file>`. Never create fake model
messages to force persistence. The retained tmux session remains inspectable;
after its loss, a new Pi in the same repository can inspect `/workflows status
<runId>` and `/workflows result <runId>` without rerunning the workflow.

Keep the terminal after completion unless closure was requested. Preserve a dead
pane's raw `pane_dead_status`, `pane_dead_signal` and `pane_dead_time` before
cleanup. If Pi disappears without terminal workflow evidence, use the run skill's
reconciliation route. A terminal supervisor does not survive every logout,
machine restart or power failure, and does not establish exactly-once effects.
