---
title: Find an agent or workflow failure
type: guide
status: active
updated: "2026-09-13T00:12:22Z"
description: "Organize the installed workflow contract by reader task."
---

# Find an agent or workflow failure

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

Open `.locus-pi/logs/errors.jsonl` in the project that ran the call. Failed agent
cards and workflow completion messages name this exact path and the detailed
evidence file. The index is a short pointer, not a copy of the conversation.
A workflow can finish successfully while a captured agent failure remains here.

## Read the cause, then follow the evidence

```sh
jq -c '{ts, source, event, workflow, runId, agent, displayName, label, phase, callId, attempt, cause, message, sessionId, parentSessionId, evidenceWarning, journalPath, resultPath, transcriptPath}' .locus-pi/logs/errors.jsonl
jq -c 'select(.runId == "YOUR_RUN_ID")' .locus-pi/logs/errors.jsonl
```

If the index rotated, also inspect `.locus-pi/logs/errors.1.jsonl`. Follow the
record's exact `journalPath`, `resultPath` or `transcriptPath`; child executions
and resumed attempts can live below another run. Do not reconstruct their path
from `runId`. In an NDJSON workflow journal, inspect **both** `error` events and
unsuccessful `agent_end` events:

```sh
jq -c 'select(.kind == "error" or (.kind == "agent_end" and (.status == "failed" or .status == "blocked" or .status == "cancelled")))' /exact/path/from/journalPath
```

Use the recorded cause to choose the repair owner. Provider/authentication
failures belong to the host/provider setup; invalid output contracts belong to
workflow authoring; defects reported by a successful reviewer belong to the
artifact's author. A successful review saying “needs revision” is not a technical
failure. A workflow's decision to continue is separate from the failed call's
execution status. Inspect possible side effects before retrying a worker.

For source repair, use `locus-pi-workflow-create`; for an authorized launch or
Repair + Continue, use `locus-pi-workflow-run`. Logging grants no new retry,
cancellation, timeout, or persistence-error recovery permission.

## Record contract and coverage

Every row has `schema: "locus.error.v1"`, a unique `id`, `ts`, `source`, `event`
and a bounded `message`. Optional facts include `status`, `workflow`, `runId`,
`agent`, `displayName`, `label`, `title`, `phase`, `callId`, `logicalCallId`,
`attempt`, `cause`, `sessionId` (child), `parentSessionId` (calling Pi session), `replayed`, and the three evidence paths above.
Unknown facts are omitted; absence does not mean attempt 1 or a guessed agent.
Messages and display text (`title`, `label`, `displayName`) use the existing
secret redactor, flatten whitespace and retain at most 1,000 characters. That is a
bound on this INDEX row, whose consumer is a one-line pointer, and it never truncates
an agent's answer or an artifact: full details remain in their original evidence, at
whatever length they were produced.

- Workflow rows project actual `error` and failed/blocked/cancelled `agent_end`
  records. The source journal is attempted first and names the index path; the
  in-memory event and final result also carry its appended row id. If source
  persistence fails, the index omits `journalPath` and reports `evidenceWarning`;
  the screen discloses that warning without replacing the original failure.
- A technical terminal workflow exception also produces `workflow_result`.
  Several events may describe one failure; row count is not incident count.
  Deliberate domain outcomes such as `{ ok: false, status: "needs_owner" }`
  do not by themselves produce technical-error rows.
- Standalone `/agent run` and `spawn_agent` results produce `agent_result`;
  unknown catalog names produce `catalog_error`. Calls that throw retain their
  original exception. Invalid arguments rejected before a call starts have no
  agent attempt to index.
- A retry's unsuccessful attempt stays in history after a later success.
  `result: "report"` does not erase or relabel a captured failure. Cancellation
  stays `cancelled`; logging never turns it into an ordinary report.
- Existing runs are not backfilled. Source journals and results remain
  authoritative, including when this optional index is unavailable.

## Storage and logging failures

Current and previous files each retain at most 1 MiB of normally written rows.
Before the next row exceeds that limit, current becomes `errors.1.jsonl`,
replacing the older generation. Individual pointers larger than 32 KiB are
refused with a visible warning. Files are created with mode `0600`; no full
prompts or transcripts are copied here.

A cross-process exclusive lock serializes append and rotation. Contention waits
for about half a second, then reports `Error index unavailable` alongside the
original failure and evidence path. Disk, path and permission failures follow
the same non-throwing route. A logging error never replaces the execution error.
The index is best effort, not a crash-durable audit log.

An interrupted writer may leave `errors.jsonl.lock`. Inspect its recorded PID;
remove only that lock after confirming its owner is gone and no writer is active.
A partial final line is refused on the next append. Preserve the file for
inspection and repair its incomplete tail before retrying logging. Ordinary
write failures attempt to roll back their partial append. Original journals
remain available regardless of index repair.

<a id="error-diagnostics"></a>

For artifact paths and terminal status, see [run evidence](evidence.md).
