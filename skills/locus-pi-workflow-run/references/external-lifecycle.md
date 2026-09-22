# Non-interactive Pi process lifecycle

Use this for an explicitly requested JSON print-mode run that must outlive a tool call, chat turn or
monitoring task. Pi still owns workflow execution. An established process
supervisor owns the Pi process; no parent model or custom workflow runner is
inserted. A short attached run may use the ordinary process API. For a Pi UI the
user can inspect, use [external-locus-pi](../../external-locus-pi/SKILL.md).

## Before starting

Resolve the exact authorized launch argv, working directory, semantic input,
workspace and model settings. Save them in a task-owned launch record. Before a
replacement launch, inspect the existing supervisor, matching run bindings,
processes and descendants; a missing tool session ID is not proof they stopped.
Respect the workspace lease. Never start a second writer to replace silence.

Use file-backed stdin/stdout/stderr and a supervisor independent of the ephemeral
tool session. Do not rely on a background PID or `Popen(...).wait()` alone.
Disable automatic restart: an interrupted child may already have changed state.
Keep the supervisor's process identity, start, terminal exit/signal and timestamps.
Unknown causes stay unknown; supervisor status does not prove workflow success.

## One-shot tmux example

Use installed `tmux` where available, or a verified platform job manager with the
same ownership and evidence properties. Do not install or configure a new system
service silently. This example starts a separate socket and retains dead panes;
it changes no existing tmux configuration and schedules no restart. The caller
supplies a saved launch JSON with `cwd` and an `argv` string array, plus a NEW
task-owned directory. Keep this directory and the launch JSON private.

```python
import json
import pathlib
import shutil
import subprocess
import sys
import uuid

launch = json.loads(pathlib.Path(sys.argv[1]).read_text())
attempt = pathlib.Path(sys.argv[2]).resolve()
attempt.mkdir()  # Refuse reuse; never truncate previous streams.
tmux = shutil.which("tmux")
if tmux is None:
    raise RuntimeError("A durable process supervisor is required for this launch")
config = attempt / "tmux.conf"
config.write_text("set-option -g remain-on-exit on\n")
socket = "workflow-" + uuid.uuid4().hex
stdout = attempt / "stream.ndjson"
stderr = attempt / "stderr.log"
# Only descriptor setup uses a shell. Every launch value remains a separate argv.
redirect = 'out=$1; err=$2; shift 2; exec "$@" </dev/null >"$out" 2>"$err"'
record = {"socket": socket, "session": "workflow", "launch": launch,
          "stdout": str(stdout), "stderr": str(stderr)}
record_path = attempt / "supervisor.json"
record_path.write_text(json.dumps(record, indent=2) + "\n")
created = subprocess.run(
    [tmux, "-L", socket, "-f", str(config), "new-session", "-d", "-P",
     "-F", "#{session_id}|#{pane_id}|#{pane_pid}", "-s", "workflow",
     "-c", launch["cwd"], "/bin/sh", "-c", redirect, "workflow-launch",
     str(stdout), str(stderr), *launch["argv"]],
    check=True, text=True, capture_output=True,
)
record["created"] = created.stdout.strip()
record_path.write_text(json.dumps(record, indent=2) + "\n")
```

The example only establishes process ownership. Read back the pane PID/start,
actual working directory and open stream paths, then the native typed
`workflow_start` or `workflow_rejected` receipt. Save its real run ID and journal
paths beside this launch. A failed client call is not proof no process started:
inspect its recorded unique socket before retrying.

Query the recorded socket and pane using an argv array:
`tmux -L <socket> display-message -p -t <pane> '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_dead_time}'`.
Save the raw fields; signal representation may be a name, and empty means
unavailable, not zero. Preserve the dead pane until status and streams are saved.
Remove only this launch's owned session after checking for surviving descendants;
never kill an unrelated server or automatically respawn a failed pane.

## Completion and loss of ownership

Observe the existing run; do not restart it between monitoring turns. Require
typed `workflow_end`, `resultPersisted` and the actual persisted result for
terminal workflow truth. Files written by a child are working evidence until its
required acceptance succeeds. A zero process exit is insufficient.

If the process is gone without terminal evidence, preserve its streams and
supervisor status and follow the [unconfirmed-call reconciliation route](../../../docs/workflows/recovery-and-continuation.md#reconcile-an-unconfirmed-call).
Do not write a replacement result or guess a kill cause. A supervisor separates
process lifetime from the caller; it does not guarantee survival of logout,
machine restart, supervisor loss or power failure. Those interruptions still
require reconciliation.
