# Adaptive code review workflow

`adaptive-code-review` is one packaged workflow for evidence-backed code review and codebase design review. It starts from the actual task and change, selects only the justified review assignments, runs those assignments in parallel, and publishes one standalone Markdown report.

It is additive. The fixed `post-code-review` bundle keeps its existing seven-child workflow and file contract.

## Requirements

The workflow uses typed input and structured-results v4 for context intake and assignment selection. A fresh run therefore requires:

- Pi `>=1.0.0`;
- the `task` role assigned through `/model-roles` to a Pi coding-agent SDK `openai-codex` Responses route with the verified raw/admission/tool/cancellation capabilities required by structured-results v4;
- the `agent` role assigned through `/model-roles` for bounded assignment workers.

Lead calls use `task:xhigh`; assignment calls use `agent:high`. Both declare `requireModelRole: true`, so an unassigned or malformed role fails before a fresh child starts. A role is a portable configuration key, not a provider identity or proof that two roles use different models. Replay may reuse recorded evidence without starting a child.

The package still supports Pi `>=0.84.3`; this workflow has the narrower capability boundary above. An incompatible lead route fails with `output-contract-unavailable` before the structured intake prompt is sent. No provider/model id is hardcoded in workflow source, and the workflow never changes model-role configuration.

## Input

Launch with typed JSON. `reviewMode` is required. The other fields are optional strings: the intake lead resolves omitted details from repository evidence when safe and requests operator input only when one material fact is still missing.

```text
/workflows run adaptive-code-review --input-json '{"reviewMode":"adaptive","task":"Review the current formatter change","change":"current diff","repositoryInstructions":"AGENTS.md","reviewScope":"changed formatter and its callers"}'
```

Supported fields:

| Field                    | Contract                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `reviewMode`             | `adaptive` selects the smallest justified assignment set. `full` requires both review lenses. |
| `task`                   | Task goal or accepted change intent.                                                          |
| `change`                 | Diff, commit/range, paths, symbols, or another resolvable change target.                      |
| `repositoryInstructions` | Relevant instruction, specification, or decision sources.                                     |
| `reviewScope`            | Explicit inclusions, exclusions, or review boundary.                                          |

Ordinary `-- <text>` input is not accepted. Typed admission preserves the exact `reviewMode` decision and allows a validated continuation to retain the original JSON.

## Stages

1. **Context** inspects the task/change, repository instructions, changed owners and contracts, real callers/consumers, likely impact, and available evidence. It returns an explicit context pack.
2. **Selection** returns both lenses' selected/skipped disposition and reason plus one to six bounded assignments. Each assignment contains a stable id, lens/skill, falsifiable question or claim, scope/paths, evidence targets, expected result contract, and selection reason. Checked source rejects duplicate ids, lane/assignment mismatches, and a full-mode plan that omits either lens.
3. **Review** runs only the selected assignments behind one keyed parallel barrier. A worker reads the complete selected `code-standard` or `codebase-design` skill and every mandatory example/reference before reviewing real callers, contracts, owners, and downstream impact. Its report states `FINDINGS`, `NO_FINDING`, or `BLOCKED` with evidence and limits.
4. **Synthesis** receives the context pack, the complete selection including skipped reasons, and every report-mode observation. It verifies decision-critical claims, deduplicates shared causes, and writes one standalone report.
5. **Publish** stores that report as the run's primary `adaptive-code-review.md` artifact.

Adaptive mode does not run a fixed checklist and does not ask the operator to choose lanes. Full mode is the explicit override: it requires at least one `code-standard` and one `codebase-design` assignment, while the selector still chooses the concrete questions.

Every model stage treats the repository and Git state as read-only. Intake, selection, assignment workers, and synthesis may inspect source and run read-only checks, but they must not edit files, change Git state, install dependencies, run write-producing commands, or delegate further work.

## Missing context and continuation

When source inspection and typed input still cannot establish a material fact needed for trustworthy scope, intake returns `needs_input`. The workflow publishes the context pack as verified handoff detail and declares one actionable `awaitOperator` text question. No selector, worker, or synthesis runs in that source run.

`/workflows continue <runId>` preserves the original typed JSON and supplies the real operator answer through the host-authenticated `operatorAnswer` context to a fresh intake. Workflow source does not extract or trust arbitrary continuation artifact properties. A complete input can run with `--no-operator`; only the branch that actually needs input calls `awaitOperator`, where no-operator mode fails closed instead of waiting.

## Result and failure behavior

The primary `adaptive-code-review.md` includes:

- reviewed scope;
- selected assignments and skipped lenses with reasons;
- findings by severity with assignment id, lens, evidence/location, impact, and remedy;
- separate code-standard and codebase-design conclusions;
- residual risks, evidence limits, and one verdict: `READY`, `READY_WITH_RECOMMENDATIONS`, `CHANGES_REQUIRED`, or `BLOCKED`.

Assignment calls use `result: "report"`. Successful answers and terminal `provider-error` or `empty-answer` observations therefore reach synthesis together, and missing coverage must remain visible. Other failure classes propagate and may prevent the final artifact. Synthesis failure also prevents publication; the workflow never labels a partial transcript as the durable review.

Inspect the static contract before running:

```text
/workflows info adaptive-code-review
```
