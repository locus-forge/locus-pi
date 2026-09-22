---
title: Run artifacts, results and journal
type: guide
status: active
updated: "2026-09-13T00:12:22Z"
description: "Organize the installed workflow contract by reader task."
---

# Run artifacts, results and journal

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Persisted run artifacts and viewer

This page follows a run from durable artifacts to its terminal result and journal.

## Artifact identity and child receipts

The canonical artifact inventory is
`<resolved-runDir>/runtime/artifacts/index.json`. Every record includes a
logical id/name, media type, byte size, relative path, stage, provenance, and
SHA-256. Its portable identity is always the complete object
`{ runId, artifactId, name, sha256 }`; a run id or path alone is not an artifact
reference.

Every `agent()` attempt receives a stable `call-<n>` identity before scheduling.
The runtime persists the exact non-empty child text under `runtime/artifacts/answers/`.
A fresh child session must also export a Pi session transcript under
`artifacts/transcripts/<callId>/` and a JSON result envelope under
`artifacts/results/<callId>/`; missing evidence makes the call fail before its
terminal `agent_end` is emitted. A replayed call writes a new answer record with
`provenance: "replay"` and its source run id, but invents no transcript or result
envelope because no child ran.

Fresh transcript filenames carry the durable agent identity, bounded stage label,
session petname, and timestamp. The required JSONL is always exported. When
[`LOCUS_PI_HTML_TRANSCRIPTS=1`](../environment-variables.md#locus_pi_html_transcripts),
the sibling HTML render uses the same filename and replaces the host's generic
title with `Agent transcript — <petname> · <stage>` when the export contains a
title element. The completion digest names the shared
`artifacts/transcripts/` directory once instead of printing every call path.
Workflow child sessions use Pi's public file-backed session manager inside their
run-scoped evidence directory, so they do not enter the operator session catalog
and the host can still render HTML. The runtime explicitly exports each named
child JSONL and any enabled HTML render into that directory before disposal. The parent operator
session and built-in `/export`
remain host-owned; current Pi hosts materialize the session file only after an
assistant turn, so a slash-only workflow session can require one ordinary turn
before the built-in exporter becomes available.

## Publish and consume artifacts

Authors can add or connect deterministic text evidence through four surfaces:

- `publishArtifact(name, text)` writes workflow-authored Markdown under
  `runtime/artifacts/published/`, projects it into `outputs/`, and returns its
  full reference.
- `publishPrimaryArtifact(name, text)` does the same while explicitly declaring
  the run's one primary semantic document. A second declaration fails closed.
- `consumeTextArtifact(ref)` accepts only a full prior-run reference, requires the
  source run to have `ok:true`, requires the exact ref in its complete verified
  artifact index, verifies identity, media type, size, digest,
  path confinement, and bytes, then copies them under `runtime/artifacts/inputs/` with
  the original reference recorded as lineage. Self-reference is refused.
- `agent(prompt, { artifact: "report.md" })` names the automatic answer artifact.
  Without `artifact`, the runtime derives a safe name from the label or agent.

Artifact names are display labels: any non-empty text that is not itself a path
(no separators, no control characters). The storage identity is `artifactId`,
which the runtime generates and which every file path is derived from, so a name
needs no alphabet or length policy. Text artifacts carry no size policy: a write
that cannot be stored fails with the real storage error. Repeated logical names are
allowed because `artifactId` is the portable identity; duplicate artifact ids or
destinations are refused. The source run target and source artifact kind/stage
returned by `consumeTextArtifact()` let a consumer enforce workflow-specific
provenance rather than trusting a conventional filename. The read result also
projects the successful source run's terminal JSON result and validated
`artifactRefs`, so a stricter consumer can bind structured prepare refs or prove
that referenced bytes were the terminal string output rather than merely a
same-name indexed artifact.

The artifact index is single-owner and append-only during a run. External index
changes, duplicate identities, symlink escapes, unsafe names,
tampered bytes, or malformed transcript headers fail closed.
The same owner resolves the project root and rejects symlinks in every ancestor
through the selected execution directory before any artifact read, write, or
consume. A root execution lives at `.locus-pi/runs/<storageRootRunId>`; saved
children and resume attempts live below that group at
`{children,attempts}/<runId>`. This prevents a redirected canonical root.

## Result references and the persisted viewer

At run completion, `runtime/result.json` and the model-callable `workflow` tool project
up to the newest 20 explicitly published/primary refs as `artifactRefs`; an
`artifactRefsOmitted` count makes the omission explicit. Each projected item is the
same complete `{runId, artifactId, name, sha256}` identity verified by the index.

That projection is a summary for display, not an admission list. Consumption
resolves any artifact of the source run through the full verified index in
`runtime/artifacts/index.json`: `consumeTextArtifact()` checks the id, the byte
digest and the source run's terminal envelope, so an artifact published earlier
than the newest twenty stays consumable for as long as its bytes exist. An
operator handoff is likewise built from the run's complete published/primary set.
The caller must still use a complete verified ref, never an id inferred from a
logical filename.

In an interactive Pi TUI, `/workflows dashboard`, `/workflows status`, and
`/workflows status <runId>` open the persisted run viewer. It navigates
run → stage → evidence → content from disk only. Evidence rows include automatic
answers, child transcripts, child result envelopes, workflow-published and
consumed text, plus stage journal logs. Content is re-read through the index and
digest-verified before rendering; missing, malformed, changed, oversized, or
tampered evidence is shown as unavailable rather than guessed. RPC, print/no-UI,
and TUI hosts without custom UI retain the bounded static status/detail blocks.

## Result envelope and semantic completion

The runtime normalizes every script result through one JSON boundary. `null`
stays a valid successful result. A top-level `undefined`, `BigInt`, circular
value, or throwing `toJSON` becomes an explicit
`WORKFLOW_RESULT_NOT_JSON_SAFE` sentinel and makes the persisted outer envelope
`ok:false`; no surface may call that run completed. The final `result.json` is
mandatory evidence: an envelope/filesystem write failure also makes the returned
run `ok:false`, preserves the typed `resultPersistence` reason, and records a
runtime `error` journal line so `/workflows status` remains failed without a valid
result artifact. At a direct `parallel()` branch or `pipeline()` stage, failed
preparation becomes a typed group-boundary failure before semantic
classification. It is not a fourth returned-outcome kind, and the original raw
branch or stage value remains in group evidence. After successful detachment,
the shared returned-outcome
classifier treats a JSON-safe top-level object with boolean `ok:false`,
`partial:true`, or `status: "failed" | "blocked" | "cancelled"` as semantic
non-success. Any condition sets the returned and persisted run envelope to
`ok:false`; status, command/tool completion, `result.json`, and read-side status
therefore cannot present the run as success. A deliberate `partial:true`
recovery may omit an `error` string. A failure status remains preserved domain
detail; the workflow disposition is `failed`. Missing fields, nested fields,
non-boolean `ok`/`partial`, and other status strings retain legacy
execution-success semantics. For a semantic failure without a technical error,
the shared result owner formats the non-empty `summary`, then stable sorted
`unresolvedRows`; the transcript, tool/command result block, and live progress
consume that one value. A technical error retains priority. The fallback
`Workflow execution failed.` is used only when neither source provides a useful
diagnostic.

## Failure diagnostics

A failed run that carries a technical error also persists a `failureDiagnostic`:
the failing stage (the last `phase()` the journal recorded), the owning script
path, persisted failure evidence, the run journal, and one copyable
`repairRequest` sentence. Paths are project-relative when they live inside the
root. `origin` separates `script` — the trusted script or its prompts rejected
the run — from `runtime`, and only the wording depends on it. Nothing is guessed:
an unproven stage, script, or evidence pointer is omitted rather than invented.
For a child execution failure, the diagnostic binds the caught child result to
its journal call and prefers that call's result, then transcript, then answer.
An unhandled group failure has no exact typed link to a single causal child.
It therefore omits the child pointer and keeps the journal and group failure
envelope as entry points. A handled child inside that group, or an earlier
handled group, cannot become the diagnostic source.
Missing or ambiguous child evidence never falls back to another child's answer.
A script that immediately rejects the last completed call can still point to
that call's indexed answer in the same phase. A subsequent phase, group barrier,
log, or error removes that direct link; a missing last-call answer does not fall
back to an older one. Runtime/finalization failures do not borrow completed answers.
Rendered pointers use the neutral `evidence:` label. A
deliberate `{ ok: false }` or `partial: true` verdict is a domain result, not a
defect, and gets no diagnostic. `result.json`, `/workflows status <runId>`, the
tool result, and the persisted run message carry the whole diagnostic including
the repair request; the width-clamped live panel shows the pointer lines only,
because a truncated repair request cannot be copied.

## Terminal disposition and continuation

The outer envelope also persists a runtime-owned `disposition`. Its terminal
states are `completed`, `awaiting_operator`, `cancelled`, and `failed`; `ok`
remains the compatibility/script-result boolean. `dsl.awaitOperator({ reason,
operatorHandoff? })` records one bounded run-local declaration and does not
modify the script's returned `result`; the last declaration wins. A reason-only
declaration remains readable but is not directly actionable.
`operatorHandoff` declares a title, one or more select/text questions, and exact
continuation artifact refs owned by the current run. Identity, types, uniqueness
and confinement are checked; the human-facing text is not counted. There is no
maximum number of questions, options or refs, and no character ceiling on a
title, prompt or option label — a surface that can only draw so much bounds its
own rendering and says how much it left out. A question may also name one
unchanged published ref as `detailArtifactRef`, but that ref must appear in the
same continuation list. The runner
supplies the version, stable handoff id, origin, and verified
self-contained-static target/script identity. At finalization, controlling
signal cancellation wins over failure, failure wins over a handoff declaration,
and a successful undeclared run is completed. Readers preserve the old
`ok -> completed|failed` behavior only when `disposition` is absent. A present
malformed or future disposition is `unknown`, never green.

Direct continuation re-reads the source envelope, verifies every declared
artifact and the unchanged target/script identity, then atomically claims the
handoff before using the ordinary background workflow launcher. The claim is
bound to the child run and contains no raw answer. Launch failure releases it;
a failed/cancelled child makes the source retryable, while a completed or newly
waiting child resolves the source item. `result.json` is never rewritten.
`--resume` remains recorded-call replay and is not a continuation alias.

## Journal layout

```
.locus-pi/runs/<storageRootRunId>/
  README.md          — stable group navigation
  outputs/           — created on terminal projection; root README, documents, exact workflow-result.md prose
  runtime/
    script-<sha256>.workflow.mjs — Read-only bytes evaluated for this run
    journal.ndjson    — NDJSON lines: {ts, runId, kind, source?, phase?, message?, agent?, usage?, replayed?, ...}
                      kinds: phase | log | agent_queued | agent_start | agent_end |
                             group_start | group_end | error
    replay.ndjson     — Recorded agent answers + dsl.now()/dsl.random() values for --resume;
                      absent for scripts that are not replay-safe (see "Resume and replay")
    result.json       — Final result + disposition + bounded finalization errors + identity/replay envelopes
    artifacts/
      index.json       — Canonical digest-bound inventory for this run
      answers/         — Exact automatic agent answers
      transcripts/     — Created on first fresh child transcript; Pi session JSONL grouped by call id
      results/         — Created on first fresh child result envelope, grouped by call id
      published/       — Text written through publishArtifact()/publishPrimaryArtifact()
      inputs/          — Verified copies consumed from prior runs, with source refs
  children/<runId>/  — created on first saved child; owns the same optional outputs/ and runtime/ shape
  attempts/<runId>/  — created on first resume; owns the same optional outputs/ and runtime/ shape
```

Legacy top-level `.locus-pi/runs/<runId>/` evidence remains readable without
migration. New child and resume evidence is always nested under its physical group.

Files deliberately written by workflow agents are outside this tree, under the
selected project-local workflow workspace. Fresh workflows default to
`.locus-pi/workspaces/<generated-run-name>/`.

`agent_end` carries `usage` (token/cost), the child session's model and reasoning-effort
readback when the host exposes them, and — for a shaped call —
`schemaValidation` (with `source: "schema" | "script"` on a mismatch when the call declared
`validate`; the `coercion` field appears only on journals written before the text transport
was deleted), plus full answer/transcript/result artifact references when
those records exist. `/workflows status` shows `agents=…` and sums the run budget from those
`usage` values. Journals written before 0.2.x may still contain `llm_start` / `llm_end` /
`llm_delta` lines; they parse but are no longer counted or specially rendered.
`parallel()` and `pipeline()` group lines are local observability metadata: they
summarize current DSL structure and record accurate completed/failed barrier counts.
They do not add upstream dynamic fanout, acceptance evaluation, async detach,
interrupt/resume, or append-step semantics.
