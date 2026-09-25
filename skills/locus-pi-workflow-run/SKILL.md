---
name: locus-pi-workflow-run
description: Launch, observe or recover an existing locus-pi workflow, including a stopped run known only by its run id. Use the native workflow tool in Pi or external-locus-pi for an inspectable session; verify persisted run evidence.
---

# Run a locus-pi workflow

Resolve this `SKILL.md` to its physical file before following relative links.
The installed [workflow manual](../../docs/workflows/index.md) is relative to that file,
never the caller cwd; see [discovery](../README.md#find-the-installed-workflow-documentation).

Run an existing reviewed workflow through its owning host. Do not add a wrapper, import the runner or
ask a parent model to launch it. Workflow JavaScript is trusted code with full Node.js access;
it is not sandboxed. `--approve` trusts the whole project, not only one workflow.
Preserve the user's scoped authorization; create-and-run needs no repeat approval.

## Choose by capability

1. If the request supplies `items` or `continuation`, require the structured `workflow` tool;
   stop as unsupported when that tool is unavailable. Slash syntax cannot carry those fields.
2. If a structured tool named `workflow` is available, call it directly using the native path below.
3. Otherwise use [external-locus-pi](../external-locus-pi/SKILL.md) for an inspectable interactive session
   when Pi and locus-pi are installed. Use JSON only when non-interactive execution is explicitly requested.
4. If neither route exists, report the missing prerequisite; [Getting started](../../docs/getting-started.md)
   owns installation. Do not assume the npm package is already published.

Require one exact saved name or project-relative `.workflow.mjs` path. Source creation or repair belongs
to `locus-pi-workflow-create`. Accept its checked-source handoff under existing execution authorization.
For `task/plan` or `task/plan-light`, use `primaryFile.absolutePath` from completed run evidence, with its validated path,
byte count and digest. Launch that existing file; do not guess `outputs/workflow.mjs` or use verifier prose.
Check an existing session/run before replacing it; silence or a lost tool handle does not prove it stopped.

## Native Pi path

Read the [workflow tool contract](../../docs/workflows/running.md#workflow-tool-programmatic).
Supply exactly one of `name` or `scriptPath`, plus the original semantic `input` and required options.
Do not spawn Pi or translate the request into a slash command when the structured tool exists.
Use `resumeFromRunId` only through [run recovery](references/recovery.md), not as a general retry switch.
`continuation` carries a real operator answer to a recorded handoff; never synthesize that answer.

Choose either `outputDir` or `runName`, never both. A name selects `.locus-pi/workspaces/<name>`;
a legacy-only `.locus-pi/plans/<name>` stays bound in place, and both paths existing fails closed.
Resume repeats the source workspace. Read the returned run id, paths, disposition, result and artifacts.
Success requires a completed disposition and retained result. Failed/cancelled dispositions, unavailable
terminal evidence, a static source check or a process exit code alone are not semantic success.

## Preserve model configuration

Model choice belongs to the operator. Preserve the current Pi session and its configured defaults
unless the user or project requests a provider, model, thinking level or role override.
The native tool has no per-run model field: use `/model` and `/effort` for an authorized session change.
Before an explicit selector or role override, read
[model configuration](../../docs/workflows/models.md#inspect-model-configuration).
Verify resolution and actual child routing; do not change them silently.
An external `--model` / `--thinking` changes the main process, not explicit child roles.
For subscription-backed execution, verify each required role's provider, adapter and authentication mode.
A role name or parent model proves no child transport; never silently substitute an API key or other route.

## External JSON path

Only for an explicit non-interactive request, read the
[launch grammar and receipt protocol](../../docs/workflows/running.md#run-from-an-agent-without-a-wrapper).
Pass the literal `/workflows run ...` command as one argv value:

```text
["pi", "--mode", "json", "-p", "--no-session", "--approve", prompt]
```

Apply that grammar to `target`, `runName`, `outputDir`, and `resumeFromRunId`. Reject a command-token value
whose first character is `-`; quoting cannot make it a valid option value. Preserve semantic input after
`--` and never interpolate launch values as shell syntax. Read
[external process lifecycle](references/external-lifecycle.md) before a launch that must outlive this call.

Interpret only `message_end` records with `message.role == "custom"` and
`message.customType == "locus-workflow-run"`. Require `workflow_start` or `workflow_rejected` within
30 seconds. Capture the real run id and `journalPath`; keep Pi alive until `workflow_end`.
A parent assistant turn, missing fields or missing receipts is a protocol failure, not model-prose fallback.
Require `resultPersisted` and reconcile the receipt with the actual persisted result before claiming success.
A zero process exit, partial artifact or old result is insufficient. An `awaiting_operator` result reports
its question and artifacts; no headless caller may invent an answer.

## Recover a stopped run

For a run that stopped, failed or was interrupted, read [run recovery](references/recovery.md) before
launching, even when only its run id is known. It owns evidence order, admission, refusal and reuse proof.
For diagnostics, follow `.locus-pi/logs/errors.jsonl` and the exact pointers described in
[error diagnostics](../../docs/workflows/error-diagnostics.md); historical failures do not disappear on success.
A source repair preserves the unaffected completed prefix and returns here after exact-source validation.
Ordinary resume, explicit interrupted recovery and operator continuation are different mechanisms.

## Observe and report

Read the [budget policy](../../docs/workflows/budgets.md#run-budget) before diagnosing a budget stop or
selecting an override. Its launch-mode defaults apply; other undeclared axes are unbounded.
Never invent an agent-count cap, token floor, answer-size policy or automatic budget increase.
Large intended fan-out is not itself a graph defect. Same-session format correction is not a fresh child.
Use the journal for activity and `/ps`, `/workflows status <runId>` or `/workflows stop <runId>` where available.
Separate fresh attempts, queued/active/terminal calls and reused answers; partial usage is not a verified bill.

Report the resolved target, run id, terminal status, evidence paths and required next action.
For continuation, prove reuse from the new result; `freshCalls` alone proves nothing.
For an external interactive run, include the actual attachment command and leave its session inspectable.
Distinguish source validation, workflow completion and acceptance of the user's requested outcome.
