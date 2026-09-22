---
title: Workflow catalog and source resolution
type: guide
status: active
updated: "2026-09-13T00:12:23Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow catalog and source resolution

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Curated Package workflows

The generated [Package inventory](../workflows.md#package-catalog) and
[examples guide](../../extensions/workflows/examples/README.md) list the shipped
names and their purpose. The `standard` profile classifies source shape, not
runtime behavior or model choice; catalog rows omit the internal label.

## Authoring patterns

New workflows use the progressive-disclosure cards under
`skills/locus-pi-workflow-create/references/`. The index maps requirements and common
names to small standard topologies; the author reads only the selected card.
Cards are algorithms and snippets, not Package workflows. Saving a local workflow
does not add it to the Package registry.

The older `extensions/workflows/references/patterns.md` remains an advanced
compatibility reference for trusted scripts that already use raw schemas and
validators. It is not the standard generation target.

This repository dogfoods that boundary with ignored project files under
`.locus-pi/workflows/`: `locus-plan.workflow.mjs` exercises clarification, planning,
digest-bound split-run execution, and per-unit implementation; `test-code.workflow.mjs`
separates testcase design, test implementation/execution, and failure
attribution among independent agents. Their independent final verifier and
attribution agents are instructed not to edit and can run frozen
`repository_check` scripts; bounded intent, plans, units, predecessor results,
execution evidence, and final inputs fail closed. They are local operational examples, not
tracked source, curated names, documentation shipped in the npm tarball, or
public package support promises.

Standard scripts pass narrative results as exact text, use
`agent({ choice: [...] })` when JavaScript must select a branch, and use
`agent({ handoffs: {...} })` when discovery must produce bounded complete text
units for visible downstream workers. A choice may explicitly name a
`choiceFallback` from the same list for a design-approved degraded route after
both invalid answers. Raw `schema`, `validate`, parsers, renderers, and custom
recovery remain outside the standard profile. Only files in the curated
`examples/` registry are Package workflows.

Saved workflow refs such as `live-smoke` or `post-code-review/necessity` use one
first-wins resolver for execution, `/workflows list`, and `/workflows info`.
Starting at the command's working directory and walking upward to the project
root, each level checks `.locus-pi/workflows/`. User
`~/.locus-pi/workflows/` and Package follow. `.pi/workflows/`,
`.claude/workflows/`, and `.agents/workflows/` are not saved-name sources.

A canonical namespace is a `<root>/` folder with an optional
`<root>.workflow.mjs` entry plus direct sibling `<child>.workflow.mjs` entries.
When the root entry exists, the root runs as `<root>` and a child runs as
`<root>/<child>`. Without the root entry, the namespace is group-only: the
folder is a non-runnable catalog header and only children run as
`<root>/<child>`. Once a source owns `<root>`, that whole namespace wins: a
missing child does not fall through to User or Package. Existing flat
`<root>.workflow.mjs` Project/User entries remain compatible standalone roots,
but new authoring always uses a folder. A foreign `<name>.js` is never accepted;
scripts for another host's DSL still require a real port.

Package requires the canonical folder layout. `post-code-review` is one root with these exact,
directly addressable children:
`post-code-review/scope`, `post-code-review/boundaries`,
`post-code-review/simplicity`, `post-code-review/contracts`, `post-code-review/style`,
`post-code-review/necessity`, and `post-code-review/synthesis`.

Fresh Package `post-code-review` children require an explicit `smol` role
assignment. Their `smol:high` and `smol:xhigh` selectors use the same portable
role with different reasoning effort. Unlike ordinary portable workflow stages,
they set `requireModelRole: true`, so an unassigned role fails before a fresh
child runs instead of degrading an acceptance review to the parent session
model. Replay may reuse a recorded answer because it starts no child and is
already marked as not-fresh evidence.

The first eligible source for a root namespace wins and its exact resolved path is retained.
Project and user directories are scanned on each resolve/list/info call, so adding or
removing a valid file changes the next result and removing a shadow reveals the next
source. The packaged examples directory is scanned the same way, so adding or
removing a `<name>.workflow.mjs` there is the whole of adding or removing a
Package workflow. The scan descends one directory level, which is how a workflow
keeps prompt resources or its diagram beside its entry, and it accepts only
regular files, so a symlink never resolves out of the package. An already-open
catalog selection is revalidated, so a precedence change fails explicitly instead of
switching paths silently. If a higher-precedence search directory is missing,
resolver and catalog skip it together. An existing non-directory, unreadable,
dangling, or externally symlinked directory blocks resolution instead of falling
through to a lower source. A directory symlink whose physical target remains
inside the owning project is accepted; resolver and catalog apply this same
physical proof.

The owner-specific `post-code-review` launch policy follows the resolved project
or curated Package target. Named and explicit-path launches under
`.locus-pi/workflows/`, plus the installed Package parent, therefore require the
same fresh `outputDir`; a personal workflow with the same saved name is not the
owner.

To run your own script, pass an explicit project-relative `scriptPath` ending in `.mjs`.
At resolution time, existing explicit targets and project saved-name candidates are checked
twice: lexically and by canonical `realpath`. An external symlink observed by that check is
rejected before module evaluation. An internal symlink remains usable after its physical
target is verified inside the project; the existing lexical path remains stable as the
recorded source path. Personal and packaged sources keep their documented roots. The check
is not atomic with the later Node import: workflow files are trusted input and must not be
replaced concurrently during launch. This is path validation, not a filesystem sandbox.
Legacy `script` strings normalize to either `name` or `scriptPath`; arbitrary inline
JavaScript is not supported.

## Catalog inspection and history

`/workflows list [query]` is a read model over the same first-wins resolver used
by `/workflows run`: scan-based discovery for Project, User, and Package alike.
It does not add a separate UI-only registry or change resolution semantics. The
focused catalog presents `Project`, `User`, `Package`, and review-only `History`
as persistent tabs. It opens on the current source with the most selectable
workflows, resolving equal counts in Project, User, Package order; History is
the fallback only when all current sources are empty. Tab or Right moves
forward, Left moves back, and Up/Down
selects only inside the active source. Every row leads with the workflow name and
a compact source badge (`[P]`, `[U]`, or `[PKG]`); descriptions wrap at word
boundaries and omit the internal authoring-profile label. Root rows precede
their indented short-name children. The active tab shows its absolute catalog
directory, while inspection shows the exact selected entry path. Very low
terminals retain a compact source-tab projection.

Every canonical folder is one catalog tree and one resolver namespace. A
group-only namespace is shown as an unselectable header with its direct children
indented below it; a namespace with a root shows the standard root row and its
child count. Runnable children remain directly addressable through their
qualified `<root>/<child>` refs. Namespace precedence is atomic, so the catalog
cannot show a Project root with User or Package children. `/workflows info
<exact-ref>` explains group-only status or shows composition and a safe source
locator for a runnable root or child.

RPC, print, and TUI hosts without the focused viewer receive the same model as a
bounded passive projection. It includes exact root, child, and history row totals
that remain true under any host line budget, and an explicit
warning that details may be omitted. The compact form does not imply that omitted
rows are unavailable, and it never derives an omitted-workflow count from dropped
presentation lines.

History rows are separate evidenced runs, not a deduplicated list of names or a
tree projection: each row leads with the workflow ref, then its `runId`, then
the compact source badge, and carries the persisted target, source label, and
retained snapshot availability. `[R]` means run history; `[P]`, `[U]`, and
`[PKG]` are compact source badges, not alternative registries. Tree grouping
never rewrites persisted run identity.

In an interactive Pi TUI with custom UI support, Up/Down moves across the active
tab and Enter opens the exact selected source in an
`Inspect` viewer. Current selections are revalidated through the same resolver.
A deleted target, unreadable file, or new higher-precedence shadow produces an
explicit state and never switches paths. A valid current source is read in full
as inert UTF-8 text: it is not imported or executed.

History inspection reads only the immutable source snapshot recorded for that
exact run. A snapshot becomes `ready` only when all persisted identity checks
agree: a simple `runId`; the expected lexical run directory; a non-symlink
directory chain; exact `script-<sha256>.workflow.mjs` basename; a regular,
non-symlink file; physical containment as a direct child of that run directory;
readable bytes; a valid persisted target; and a matching content SHA-256. The
other states are explicit: `legacy`, `missing`, `unreadable`, `invalid`, and
`tampered`. After catalog selection, the browser re-reads the snapshot and
compares its run target, path, SHA, and identity coverage. A changed identity is
reported as `stale`; nothing opens until the operator returns and refreshes the
catalog. No persisted or browser state reads the current workflow or another
path as fallback.

The focused browser uses the available terminal height after reserving Pi's three
footer/status rows; it has no fixed 24-row ceiling. Pi's native
`highlightCode(..., "javascript")` provides syntax colors. A persistent `Code`
top border and a bottom border carrying the visible line range separate source
from identity metadata while scrolling. Up/Down, PageUp/PageDown, Home, and End
reach the final source line. `Esc` or the `Back` action returns to the preserved
catalog cursor. This internal viewer is a workflow-source alternative to printing
a long file; it does not change Pi's generic `Ctrl-O`, `cat`, or terminal-scrollback
behavior.

Press `i` on the source screen to open a dedicated identity screen. Its scroll is
independent from source scroll, and Up/Down, PageUp/PageDown, Home, and End keep
the full identity reachable even at terminal widths 8 and 1. Current identity
shows the human source label and exact path. History identity also shows the run
ID, exact snapshot path, and SHA when present. Press `i` again or `Esc` to return
to the source at the preserved position.

The action bar is deliberate prompt handoff, not execution. `Tab` or the
Left/Right arrows changes the focused action, and Enter activates only that
action. Focus is marked by
both a `›` caret and the theme's warning color (normally yellow); other available
actions use the success color (normally green). `[VIEW]`, `Source:`, `Path:`, and
the equivalent history metadata labels use the same semantic success styling so
metadata stays distinct from highlighted code:

- A ready current source offers `Back`, `Start`, `Edit`, and `Review`. A
  folder-owned Package namespace also offers `Copy to Project` and `Copy to
User`; Project/User sources offer the opposite editable destination.
- A history source offers `Back` and `Review`; it never offers `Start` or `Edit`.
- A failed current read offers only `Back`. An unavailable or `stale` history
  snapshot keeps `Review` only when the prompt identifies the run and names the
  snapshot state; it never substitutes current source.

Copying claims one destination namespace and preserves the complete folder —
root when present, direct children, README files, prompts, diagrams, and other
resources. A group-only namespace remains group-only. An existing destination
folder or compatible flat root is reported and never merged or overwritten.

`Back` and cancellation return no intent. `Start`, `Edit`, and `Review` return a
typed intent from the custom component. The `/workflows` command awaits the
shared inline `ctx.ui.custom(..., { overlay:false })` surface, restores Pi's main
editor, and only then calls `setEditorText()` once. `Start` prefills the direct
`/workflows run <resolved-name>` command; submitting it reaches the runtime
without a model planning or authoring turn, and optional semantic input can be
appended on the same command line. `Edit` and `Review` still prefill the compact
`Request: ...`, `Skill: locus-pi-workflow-create`, and
`Additional instructions:` handoff because those actions require source work.
The packaged skill owns workflow-authoring instructions. No global catalog
persona is required.
Historical review keeps the exact run/snapshot identity. The browser itself does
does not submit editor text, import a module, mutate history, send a message, or
claim success if the editor setter is missing or fails. Copy actions are the one
explicit filesystem mutation and report their exact destination.

RPC, print/no-UI, and TUI hosts without custom UI keep an honest passive
projection. Empty, no-match, history-only, unavailable-source, and narrow-terminal
states have no phantom selection, and every rendered row is bounded to the
terminal width. Exact source identity remains discoverable through `i`, including
at the narrowest supported widths. The optional query is case-insensitive and
matches name or description; a miss names the query and reports the non-empty
catalog size instead of pretending the resolver is empty.

Metadata comes from a bounded inert AST scan of the first 64 KiB. Only a top-level
literal `export const meta = {...}` is considered; unquoted or quoted literal
`description` keys with static string values are accepted. Comments, unrelated
objects, computed keys, interpolation, imports, and runtime values are ignored.
The scanner never executes the module and reports unavailable/non-static metadata
explicitly.

`/workflows info [name]` builds one immutable `OperatorBlock` as its semantic
source. Bare `info` explains the commands, exact source precedence, static
metadata boundary, trusted-code limit, history, DSL primitives, catalog-agent
selection, model-role metadata, and actual model routing. Named `info` uses the
same first-wins resolver and adds the exact human source/path plus statically
parsed `meta.description` and, when the workflow declares them, its
`meta.phases`; an unknown name fails explicitly.

In an interactive Pi TUI with custom UI support, the command opens that complete
block in a workflow-owned read-only scroll view. Up/Down moves one line,
PgUp/PgDn moves one page, Home/End jumps to the first/final page, and Esc/q
closes the view. Tests reconstruct every rendered semantic line at
146, 80, and 48 columns. RPC, print/no-UI, and TUI hosts without custom UI keep
the same bounded passive projection; the TUI fallback says that interactive
scrolling is unavailable. Neither projection imports or runs a workflow,
invents an execution graph, mutates the editor, or writes a file. This focused
view is not a generic fix for `Ctrl-O`, `cat`, or terminal scrollback.

Bare `/workflows` opens the canonical command menu in TUI, including when an
actionable handoff is pending. Choosing `continue` from that menu (or typing
`/workflows continue <runId>`) opens the oldest handoff. In RPC and headless
hosts, the same command returns the typed `VIEW` help fallback. It clears stale
workflow chrome before installing the menu. Passive `/workflows list`,
`/workflows status`, settled run receipts, and non-interactive `/workflows info`
reuse the shared operator frame. Interactive list and info views are separate
workflow-owned custom components; info still renders the same semantic block as
its passive projection. Neither path replaces the domain-owned live progress
panel. Run discovery accepts only
directories with `journal.ndjson` or `result.json` and a provable start time.
Canonical ids use their UTC prefix; legacy ids use the first persisted journal
timestamp. Worktree-only/test-artifact directories are ignored instead of
appearing as `unknown` runs. TUI `/workflows status` shows the newest 10 accepted
runs and detail shows the newest 20 journal rows. RPC passive output uses a
host-budgeted four-run list and one newest detail event; both variants keep
literal total/shown/older or `+N hidden` and point to `result.json` for complete
evidence. Detail reverses chronological order and distinguishes script, runtime,
and legacy journal provenance. Missing runs and failed launches use typed
`ERROR`; busy/unprovable idle and invalid input use typed `WARN`; a headless
settled run uses `RESULT` or `ERROR`. TUI uses a width/height-aware component,
RPC uses plain `string[]`, and explicit no-UI hosts receive no fake widget
delivery.

Static passive workflow `VIEW` closes with `Esc` from the ordinary editor. This
removes only the last passive help/status/fallback view; active workflow `LIVE`
stays pinned until terminal state, and persistent/shared status is not cleared.
Escape inside an operator question is an answer, not a dismissal: the run
continues with a plain-text refusal naming its questions, keeping any answers
typed before it. It does not abort an agent or cancel a workflow —
`/workflows stop` remains the only cancellation path; flat `/workflow-stop` is
its compatibility alias.
The focused catalog owns the source-to-catalog and catalog-to-close lifecycle
described above. The shared TUI adapter requests a full host redraw for passive
open/close, so stale border or bracket glyphs do not remain after
open/close/resize.
