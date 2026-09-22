# Recover a stopped workflow

Read for a stopped, failed or interrupted run, starting from its run id.
Ordinary resume reuses a matching completed prefix after a source repair; it is not arbitrary node caching.
The [replay contract](../../../docs/workflows/replay.md#resume-and-replay) owns request matching,
miss reasons, fusion boundaries and accounting. Read it before deciding whether the proposed prefix is usable.

## Read evidence before choosing a continuation

The `workflow` tool schema has no `status` operation. Resolve the actual `runDir` from the native
start receipt or saved launch binding; the equivalent human surface is `/workflows status <runId>`.
When only the id is known, follow [run evidence navigation](../../../docs/workflows/running.md#run-evidence)
and [journal layout](../../../docs/workflows/evidence.md#journal-layout): inspect the project's
`.locus-pi/runs/` group roots and their `children/<runId>/` and `attempts/<runId>/` directories.
Confirm the requested id in the located journal/result before using that directory.
A missing flat `.locus-pi/runs/<runId>/` does not establish missing evidence: child and resume executions
are nested under a storage-root group. Once resolved, read only that execution's files:

1. `<runDir>/runtime/result.json`: terminal status, target, script identity and replay envelope.
2. Its `failureDiagnostic`: origin, stage, source and exact `evidencePath`, `journalPath`, `repairRequest`.
   Read the referenced child result, transcript or answer; absent fields prove nothing.
3. `<runDir>/runtime/journal.ndjson`: lifecycle and whether replay was recorded.
4. `<runDir>/runtime/replay.ndjson`: recorded nodes as `[phase, label, occurrence]` identify
   the completed prefix without reading source or inverting request hashes.

If no result exists, use the start receipt and launch binding to find evidence; a partial file is not
completion. Process loss with an unconfirmed call requires the reconciliation route below.

## Declare one outcome before launching

Name `continue` or `refuse`, with the evidence supporting it.

Continue the same target with the exact original semantic input and source workspace, using
`resumeFromRunId` (operator surface: `--resume <runId>`). Repeat an explicit `outputDir` or `runName`
as `--output-dir <path>` or `--run-name <name>`; do not create a replacement workspace.
Source edits are allowed and expected. Hand source repair to the
[create skill](../../locus-pi-workflow-create/SKILL.md), preserving unaffected prompts, literal labels,
order, phases and effective options. Return here after its exact-source gate; authorized Repair + Continue
needs no new approval ritual. A changed earlier request moves the fresh boundary earlier.

Replay serves answer text only. It does not recreate files, re-read the project or repeat child side effects.
Check that needed artifacts and project prerequisites remain suitable: a cleaned workspace can turn a
replayed “checks passed” answer into a false green. Changes from unfinished authorized work need
reconciliation, not blanket historical tree equality. The first fresh call makes the whole suffix fresh;
stable business keys do not recover independent completed branches. The canonical replay contract covers
`unnamed-node`, changed scheduling and the refusal to mix replayed and fresh legs inside one fusion panel.

Refuse ordinary continuation when:

- The run/result is unreadable or corrupt. Missing terminal result needs the explicit interruption route.
- The journal says `replay: not recorded`; no prefix can be reused.
- A required source repair is outside the current project, such as an installed Package workflow.
  Use a project-owned copy or upstream repair; never edit the installed tree and claim the original resume.
- Original semantic input is unavailable. Never guess it; a fresh run must be declared as fresh.
- Status is `awaiting_operator`: use the real answer through `/workflows continue <runId>` instead.
- Required workspace/artifacts or project prerequisites are unsuitable or the source workspace is missing.
- A repaired source's recorded calls have no node names/labels, so all work would run fresh.
  Report that boundary instead of claiming saved work; every new `agent()` call needs a unique literal `label`.

When older evidence misses despite unchanged source, read
[release boundaries](../../../docs/workflows/recovery-and-continuation.md#replay-across-this-release-boundary).
Do not rewrite old keys/results or mistake budget/return-contract changes for an authoring defect.

## Missing terminal result or unconfirmed effects

Read [interrupted recovery](../../../docs/workflows/recovery-and-continuation.md#explicit-interrupted-run-recovery)
before an explicitly authorized `recoverInterrupted: true` structured-tool launch. It requires identical
bound source/input/budgets, a fully confirmed serial prefix and workspace ownership under the lease.
It is not ordinary repaired-source resume. Never manufacture `result.json` to obtain admission.

For a started but unconfirmed call, follow
[reconciliation](../../../docs/workflows/recovery-and-continuation.md#reconcile-an-unconfirmed-call).
Preserve attempts and evidence, establish actual process/descendant state, and reconcile current changes
and external readback before deciding how to continue. Existing authorization covers in-scope repair;
technical uncertainty does not imply missing repeat approval. Never blindly repeat an uncertain effect.
A usable verified terminal ancestor may supply the prefix for a repaired fresh reconciliation stage.
Name that ancestor and the orphan separately; this does not accept or directly recover the orphaned call.

## Prove what the new run did

Read the NEW run's `runtime/result.json`: report `replayedCalls`, `divergedAtCall` and `divergedAtNode`.
`freshCalls` alone proves nothing; a complete restart reports it too. Recheck required files on disk.
A fully replayed call starts no child and does not spend `totalAgents`; raising a fresh-work cap still needs
authorized budget selection. Require fresh verification before irreversible effects and the real terminal
result before reporting completion. Never describe zero reuse as proof that completed work was preserved.
