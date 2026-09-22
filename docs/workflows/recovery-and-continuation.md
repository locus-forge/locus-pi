---
title: Recovery and operator continuation
type: guide
status: active
updated: "2026-09-13T00:12:21Z"
description: "Organize the installed workflow contract by reader task."
---

# Recovery and operator continuation

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

Audience: operators recovering a run and authors selecting a handoff. Ordinary Repair + Continue remains owned by [Resume and replay](replay.md#resume-and-replay); this file owns the conservative explicit interrupted-run extension.

| Mechanism             | Boundary                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| Semantic continuation | Same run, a verifier selects another fresh worker with exact goal/result/feedback  |
| Format clarification  | Same logical call and same child session, only the output contract is corrected    |
| Replay                | Rerun source, reuse a matching recorded call prefix, then execute a fresh suffix   |
| Human continuation    | Terminal awaiting_operator, verified artifacts and operator answer start a new run |
| Generated workflow    | New source is authored before execution; not a completion mechanism by itself      |

## Explicit interrupted-run recovery

`workflow({ ..., resumeFromRunId, recoverInterrupted: true })` is an opt-in admission path for a missing terminal `result.json`. It is not a general retry switch, not the default Repair + Continue route, and not a promise to resume arbitrary in-flight effects. It requires the structured tool; no new slash-command flag is introduced.

New root runs persist a host-owned launch binding before child work, with target/source snapshot, physical workspace identity and an exact fingerprint of input, caller items, resolved budgets and no-operator mode. Old diagnostic/runtime runs without that fingerprint remain readable but do not gain hard-crash recovery authority.

Admission requires the identical target, source and caller inputs; a healthy self-contained orchestration-only source with no imports; no saved children or grouped execution; a complete labelled serial journal/replay prefix; and no started-but-unconfirmed call, error, damaged/truncated record or clock/random recording. A present-but-corrupt result is not treated as a missing result. The existing workspace lease must be acquired; the evidence is checked again under that lease. Live or unverifiable lease owners are not silently taken over.

No terminal success envelope is manufactured. An admission-only metadata projection has `ok:false`, is never persisted as a result, and is used solely to validate the existing workspace/replay path. The new run produces its own real terminal result. Under this mode a mismatch inside the confirmed prefix throws instead of executing that prefix afresh, and ending before consuming the confirmed prefix is an error. Ordinary repaired-source replay remains unchanged when this flag is absent.

This conservative first version refuses parallel/nested runs and unconfirmed effects. That is narrower than a general durable execution engine, deliberately. A child may have changed a file before its completion record was durable; runtime cannot infer exactly-once semantics for that window. Use idempotency/receipts or operator reconciliation, not blind continuation. Do not delete or edit runtime evidence to force admission.

A confirmed cached answer does not recreate files or recheck an externally changed repository. Do not change the workspace, provider routes or agent profiles while relying on old evidence. Require fresh verification before irreversible external effects. Filesystem/power-loss durability and real Pi execution require their own acceptance evidence; process-kill prefix tests do not establish those stronger guarantees.

### Reconcile an unconfirmed call

Missing `agent_end`, `workflow_end` and `result.json` after process loss do not
prove that the child did nothing. Preserve the evidence and identify the actual
process and descendants by PID/start, working directory and stream paths. Check
for a newer matching run and respect the existing workspace lease before any
continuation. If descendants or external operations are still active or unknown,
resolve that concrete effect first. An unexplained exit is not proof of a signal,
OOM or timeout.

The project owner inspects the current diff, accepted scope, partial artifacts,
command records and any external readback. Record what is retained, incomplete
or uncertain and whether the completed prefix's prerequisites are still usable.
This is reconciliation of current state, not acceptance of the interrupted child.
Existing authorization for scoped repair and continuation remains sufficient;
preserve real safety and external-action boundaries.

If an authorized checkpoint commit occurred between attempts, reconcile content
separately from `HEAD`, index and inventory changes. Keep the original step-entry
baseline tar and manifest through the checkpoint and recovery. Compare the full
current step against that baseline, including additions and deletions; a clean
working-tree diff after commit does not mean the step made no changes. Explain
checkpoint/report-only differences separately and validate actual content changes
against the accepted scope. Do not replace the baseline with the new commit or
require historical `HEAD` equality as a substitute for that comparison. A checkpoint
already authorized by the owner needs no repeat approval and proves no acceptance.

If a verified terminal ancestor has the same target, physical workspace and
original semantic input, ordinary `--resume <ancestorRunId>` is a supported new
branch after that reconciliation. Preserve the suitable prefix's exact requests;
repair the first fresh stage to inspect retained changes and finish or repair the
accepted work. Keep downstream review and QA fresh. Verify the source and actual
prefix reuse. Report the terminal ancestor as `resumeFromRunId` and the orphan as
separate reconciliation context; do not claim direct recovery of the orphan.

If the prefix is no longer suitable, make an earlier stage fresh or author an
explicitly declared fresh recovery workflow from current state. If no terminal
ancestor is usable, no prefix replay is available through this route. Neither
path deletes partial work, fabricates a terminal record, edits historical replay,
skips required checks or retries an unconfirmed external effect blindly. Runtime
does not perform the domain reconciliation or guarantee exactly-once effects.

## Replay across this release boundary

Two independent things changed what a recorded call's key contains, and an operator
resuming an older run meets whichever comes first.

**Explicit budgets, and this is the one that reaches plain text too.** `timeoutMs`,
`toolCalls` and `turns` are part of every call's canonical request, and the package
defaults that used to fill them — `86400000`, `1000`, `1000` — are gone. A call that
inherited them now sends `null` on those axes, so its key differs from the recorded one
whatever kind of call it is. **A run recorded before this release therefore re-runs from
its first agent call, plain text included**, reported as `key-mismatch` at that call. The
exception is a run that declared each of those budgets explicitly: nothing was inherited,
the keys are unchanged, and it replays exactly as before.

**The shaped return contract carries a version, and this release is v2.** The ceilings
the runtime used to add to every shaped call are gone, so the contract text a shaped call
sends is not the text an older record was written under. Resuming such a run does not
silently reuse the record and does not blame the script for a key mismatch it did not
cause: the call reports `return-contract-changed`, the journal names the release
boundary, and that call runs fresh. In a mixed run this is the miss an operator sees only
when the budgets were explicit — otherwise the budget boundary above has already ended
reuse earlier.

What is not done to old runs. No historical journal, result or replay record is
rewritten, no historical key is recomputed, and a call recorded as failed never becomes
an accepted one by being read under the new contract. An old record stays inspectable as evidence of
what that run actually did; it simply stops being a substitute for executing the call
again. Treat the boundary the way any other fresh suffix is treated: the replayed prefix
must still have left the workspace and project tree in the state the fresh calls expect.
See [output acceptance](agent-results.md#the-principle) for what changed in the
contract itself.

## Human continuation

`awaitOperator({ reason, operatorHandoff? })` declares a terminal disposition and does not pause the JavaScript stack. Return immediately. A resumable handoff places references under `operatorHandoff.continuationArtifactRefs`, not a top-level `artifactRefs` property. The handoff service validates claims, target/workspace identity and artifact digests, then starts a new run with the real operator answer. It does not synthesize approval.

`continuation` and `resumeFromRunId` remain mutually exclusive. In `noOperator` mode the gate fails closed. A reason-only awaiting_operator stop explains the blocker but is not automatically a fully bound handoff. See the [compatibility example](../../extensions/workflows/references/examples/human-continuation.workflow.mjs); standard source must not claim permission to inspect arbitrary artifact objects.
