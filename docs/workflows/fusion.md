---
title: Fusion panels
type: guide
status: active
updated: "2026-09-22T17:02:16Z"
source_commit: "5365d3f8cd9c"
update_event: "cleanup"
context: "changes=XL files=46"
description: "Consolidate workflow contracts at their owning pages and repair outdated guidance."
---

# Fusion panels

[Workflow documentation](index.md) · [Authoring guide](create.md) · [Operator guide](running.md)

## Direct Fusion from the main session

Fusion also has a model-callable `fusion` tool. It is disabled by default, so it
does not enter the active tool list or the parent model's tool prompt until an
operator explicitly enables it.

```text
/fusion                                      # interactive menu or passive status
/fusion configure                            # choose one mode, at least 2 members, and one judge
/fusion set --mode tool-free --members provider/a,provider/b --judge provider/judge
/fusion enable
/fusion disable
/fusion status
/fusion run <complete standalone question>  # manual call through the same runner
```

The interactive selector reads `modelRegistry.getAvailable()`, so it shows only
models the current Pi host can actually use rather than every model known to a
provider. Configuration is project-local at
`.locus-pi/fusion/config.json`. Version 2 requires an explicit homogeneous
`tool-free` or `agent` mode. Operational commands reject legacy version 1
configuration. `/fusion configure` and `/fusion set` may replace it atomically,
but the replacement remains disabled until the operator reviews the selected
mode and runs `/fusion enable`. Members must be unique, and the judge must be
different from every member. Enabling fails closed when the roster is incomplete
or a selected model is no longer available.

The tool accepts `question`, optional explicit `context`, and an optional final
`output` instruction. It never forwards ambient session history. A direct run
uses the same mode-specific Fusion calls and writes the same packet,
answers, journal, result envelope, and readable output under
`.locus-pi/runs/<runId>/` as the Workflow DSL primitive. Disabling removes
`fusion` from Pi's active tools immediately while leaving `/fusion` available for
configuration.

Read the [full result](running.md#read-the-full-result) through the ordinary
workflow commands. [Run evidence](evidence.md) owns storage and artifact identity;
[operator continuation](recovery-and-continuation.md#human-continuation) owns handoffs.
For the callable signature and availability, see [`fusion()`](dsl.md#fusion).

## Fusion execution details

`fusion()` requires `mode: "tool-free" | "agent"`; every member and the judge
use that same mode. Each selector still requires `model` or `modelRole` and may
also name an existing catalog `agent`. Tool-free legs retain the selected
catalog persona and ordinary execution metadata, but the package supplies their
complete system prompt, disables extension, skill, prompt-template, theme, and
context-file discovery, and starts them with no active tools. The host reads the
active tool registry before the first prompt and fails the leg without prompting
if that readback is missing or non-empty. Agent-mode legs keep the existing
catalog-agent tool and parent-permission behavior. Ordinary `agent()` calls are
unchanged.

Fusion defaults to prompt-only context and never reads ambient chat history.
Explicit `context: { mode: "provided", text }` is copied verbatim into the
Fusion packet artifact. When reconnaissance is needed, run it as an ordinary
visible `agent()` or child-workflow stage and pass its bounded text through this
explicit context field; Fusion does not discover it automatically. No character
cap applies to a member answer, to the judge answer, or to the assembled judge
prompt: a panel returns what its members wrote. A panel declares at least two
members. All declared members are required; a member failure stops before the
judge runs. The production runner resolves
all declared model selectors before the first child, and overlapping Fusion
calls reserve their complete worst-case invocation counts atomically. While a resume
is still reusing its recorded prefix, every panel leg must replay; a missing or
divergent leg fails before a fresh child can create a mixed recorded/live panel.
Once a preceding call has ended prefix reuse, the whole panel runs fresh with
ordinary model preflight and budget reservation. A fully replayed panel needs
neither the old models configured nor a fresh invocation reservation; see
[Fusion replay boundaries](replay.md#continuing-a-repaired-workflow).

The mode is part of the replay key. Replayed legs retain the declared mode but do
not claim a fresh host active-tool readback. Fresh results persist the declared
mode and exact host readback in per-call evidence, the workflow journal, and the
readable run report. Run without `--resume` to execute the whole workflow afresh.
