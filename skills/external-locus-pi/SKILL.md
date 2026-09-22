---
name: external-locus-pi
description: Launch or inspect Locus Pi from Codex, Claude Code or another external host in a named interactive session the user can attach to manually. Use for External Locus Pi, external Pi launch, or an inspectable Pi session. Delegates workflow syntax, evidence and recovery to locus-pi-workflow-run.
---

# External Locus Pi

Resolve this `SKILL.md` to its physical file before following relative links; the installed [workflow manual](../../docs/workflows/index.md) is relative to that file, never the caller cwd (see [discovery](../README.md#find-the-installed-workflow-documentation)).

Own the external Pi session and the user's route back to it. Default to an
interactive Pi terminal retained by tmux, with session saving enabled. Keep the
terminal open after the workflow finishes. Do not substitute a hidden print-mode
process when the user wants to inspect Pi manually.

The [run skill](../locus-pi-workflow-run/SKILL.md) owns workflow target/input syntax,
model configuration, evidence and recovery. Read those sections as needed; this
explicit external route does not loop back through its host chooser. This skill
does not author workflows or replace the native workflow runtime.

## First action

Resolve the existing workflow and repository, then check whether the requested
session or workflow is already running. Reattach or inspect that session instead
of creating another writer. A request merely to open Pi creates no workflow run.
A stopped workflow requires the run skill's recovery decision before launch.

Use the operator's configured Pi installation and roles. Keep model/effort choices
unchanged unless requested. Use `--approve` only for the authorized project;
project trust is broader than one workflow. Do not copy credentials into launch
records. If Pi or the required supervisor is unavailable, report that prerequisite.

## Launch once, keep it inspectable

Read [interactive session mechanics](references/interactive-session.md). Save
the exact argv/cwd, original semantic input, supervisor identity and attachment
command in a new task-owned launch directory. Preserve the terminal PTY for Pi's
stdin and stdout. Omit print mode and `--no-session`; never pipe text into Pi's
stdin for this route.

Start the literal `/workflows run ...` command as one initial Pi argv value.
Pi dispatches the extension command directly; do not ask a parent model to launch
the workflow. With no workflow request, start Pi without an initial command.
For `items` or `continuation`, follow the run skill's structured-tool requirement;
do not silently drop fields into the slash-command grammar.

Read back the live pane/process and native start or rejection message. Bind the
observed run ID to its target, source, physical workspace and launch input. Use
the run's journal and persisted result for progress and terminal truth. An idle
Pi prompt, dead pane, partial file or old result is not workflow completion.
An interactive terminal is not a JSON event stream: do not parse its ANSI output
as JSON receipts or invent a missing session file.

## Give the user control

Return the concrete command `tmux -L <socket> attach-session -t <session>`.
Offer read-only viewing with `attach-session -r` when useful. Detaching with
`Ctrl-b`, then `d`, leaves Pi running. Inside Pi, the user can use `/workflows
status <runId>`, `/workflows result <runId>` and `/ps` where the agents extension
is loaded. Return the actual run ID and evidence paths alongside the attachment.

After workflow completion, leave the interactive session open for inspection.
Session closure is separate from workflow cancellation; do not kill a pane to
stop an uncertain child. Use native workflow stop and verify descendants before
closing a session. No automatic restart after process loss.

If the user explicitly requests non-interactive JSON execution, use the run
skill's [JSON path](../locus-pi-workflow-run/SKILL.md#external-json-path) and its
[process lifecycle](../locus-pi-workflow-run/references/external-lifecycle.md).
State that this mode provides saved output, not an attachable interactive Pi UI.

Example request: "Use external-locus-pi to run the existing review workflow in
this repository and leave Pi available for manual inspection." Success means
one verified native run, an attachable session and honest evidence status; it
does not mean the feature was accepted merely because the session opened.
