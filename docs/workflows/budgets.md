---
title: Workflow budgets and constraints
type: guide
status: active
updated: "2026-09-13T00:12:21Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow budgets and constraints

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Run budget

This is the canonical policy for workflow budgets and standalone `task`/`spawn_agent`
execution. The list below gathers the standard defaults, explicit controls and existing
structural guards. It covers Locus execution and output acceptance; provider quotas,
context windows, OS resources and UI display projections are separate limits.

**Launch modes.** Headless means Pi `print` or `json`, determined from the root host
context. TUI and RPC can reach an operator; a missing UI or `noOperator: true` does
not make them headless. The `workflow` tool, slash commands and direct runner use the
same resolver. Direct `/fusion` and the `fusion` tool use these mode defaults too
(with no launch-budget override). Saved children inherit the root's budget, counter, deadline and gate.
A fresh root resolves defaults once; an explicit number replaces its default.

Workflow launch defaults are mode-scoped: every run defaults to `concurrency = 4`; headless Pi `print`/`json` root launches additionally default to `totalAgents = 10_000`, shared across fresh physical child attempts made by the root, saved children and Fusion; `totalAgents` is unbounded in TUI/RPC. Every other undeclared workflow budget axis is unbounded.

| Control                     | Standard value                               | Scope, explicit setting and effect                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone task runtime     | `runtimeMs = 3_600_000` (1 hour)             | `spawn_agent` and `/agent run`, including the historical `task` surface: one child wall-clock deadline, passed internally as SDK `childTimeoutMs`. No multiplication by turns; expiry aborts the child. These surfaces expose no budget override. This is also their policy when called from print/json.                    |
| Standalone task turns/tools | Unbounded                                    | No `maxTurns` or tool-call default. A task may use more than five turns within its hour. One call starts one child; orchestration belongs to workflows.                                                                                                                                                                     |
| Workflow `concurrency`      | 4                                            | Run-wide simultaneous physical leaf attempts. Excess work queues; it is not refused. Explicit `budget.concurrency` changes the width. A local `parallel()`/`pipeline()` concurrency can narrow a group; without one it uses the run width.                                                                                  |
| Workflow `totalAgents`      | **10,000 in headless; unbounded in TUI/RPC** | `budget.totalAgents` bounds fresh physical child attempts across root, saved children, review, transport retries and Fusion. The next attempt beyond the cap never starts. Replay and same-session clarification start no child and are not charged.                                                                        |
| Workflow `runtimeMs`        | Unbounded                                    | `budget.runtimeMs` checks elapsed run time after admission to the concurrency gate, before starting a child. It does not abort an in-flight child or bound trusted JavaScript between calls.                                                                                                                                |
| Workflow `timeoutMs`        | Unbounded                                    | `budget.timeoutMs` or `agent({ timeoutMs })`: one wall-clock deadline per physical child attempt, including operator waits and output clarification. Expiry aborts the child.                                                                                                                                               |
| Workflow `toolCalls`        | Unbounded                                    | `budget.toolCalls` or `agent({ maxToolCalls })`: tool dispatches per physical child, cumulative across clarification. The first dispatch beyond the cap is refused.                                                                                                                                                         |
| Workflow `turns`            | Unbounded                                    | `budget.turns` or `agent({ maxTurns })`: cumulative SDK model cycles per physical child, including ordinary work and clarification. The next generation beyond the cap is refused.                                                                                                                                          |
| Transport attempts          | 1 attempt                                    | `agent({ attempts })` is a positive safe integer including the first child. Eligible transport retries start fresh children and consume `totalAgents`; provider errors are not automatically retried.                                                                                                                       |
| Shaped-return attempts      | 2 submissions: initial + 1 clarification     | `repair.maxAttempts` includes the initial submission; 1 disables clarification. No package upper ceiling. Correction stays in the same child and shares its turns/tools/deadline. The applied allowance and its source are journaled.                                                                                       |
| Output size and item count  | No runtime size ceiling                      | Only explicit consumer contracts: `output.maxLength`, schema constraints such as `maxLength`/`maxItems`, or `handoffs.maxItems`. `maxAnswerChars`, `maxItemChars`, `schemaMaxLength` and `budget.answerChars` are removed and refused by name. Input, parent context and text artifact content have no package size budget. |
| Output shape and minima     | Always validated                             | Types, nonblank values, uniqueness and semantic validation remain. `choice` needs at least 2 options; Fusion at least 2 members. These are contract requirements, not spend budgets.                                                                                                                                        |
| Saved-workflow nesting      | Root plus one saved-child level              | The existing `invokeWorkflow()` depth guard refuses deeper saved composition. `subflow()` is in-run grouping and does not add a saved level. This guard remains a separate structural constraint.                                                                                                                           |
| Direct child delegation     | Leaf children (`depth=0`, `maxDepth=1`)      | `spawn_agent` is removed from child tools; descendants cannot start an independent delegation tree outside shared workflow accounting.                                                                                                                                                                                      |
| Numeric representation      | Positive safe integers                       | Budget numbers must be integers in `1..Number.MAX_SAFE_INTEGER`; zero, fractions, `null`, infinity and unknown/removed axes are refused. Omission or `undefined` selects the launch default, then `unbounded` if there is none; it does not disable the headless cap.                                                       |
| Timer implementation        | Safe chained waits                           | Delays above Node's 2,147,483,647 ms are chained, not clamped to 1 ms or rejected as policy. SDK cancellation has a separate 5-second abort-settlement wait; that is cleanup, not extra work time.                                                                                                                          |
| Tokens and cost             | Not enforced                                 | Reported tokens are recorded. Cost is unavailable because the host supplies no price; missing measurement never means zero.                                                                                                                                                                                                 |

**The headless safeguard bounds agent spending, not all execution time.** It permits
at most 10,000 fresh physical children by default. A hung child without `timeoutMs`,
a script loop without further agent calls, and work after the last child remain
outside it. No additional axis acquires a default without a separate policy decision.

**Overrides and visibility.** The structured `workflow` tool and command launcher
accept `budget` through `RunWorkflowScriptOptions.budget`; there are no slash budget
flags. `concurrency`, `totalAgents` and `runtimeMs` remain host-owned. The three
per-child settings remain ordinary `agent()` options. Explicit values may narrow or
raise their applied defaults; every raise is journaled with axis, old value and requested
value. Approval details show supplied values; the run header, journal, `result.json`
and report show all six resolved axes, with absent stop axes written as `unbounded`.

**Enforcement and evidence.** SDK pre-dispatch hooks enforce turns and tools before
spending. Older hosts without that seam use event counting and abort, so an excess
action may already have started. Workflow budget stops retain the named
`stopped by budget <axis>` journal entry and data received so far; standalone expiry
retains its `host-turn-timeout` failure and evidence. Neither is a verdict that earlier
answers were wrong. Root and saved children use one physical-attempt counter, and
Fusion reservations use that same allowance. A fully replayed panel consumes none.

**Compatibility.** Readers preserve historical budget values, including `unbounded`,
and still read results that predate the budget field. Reading an old result never
inserts today's defaults or rewrites its records. A new headless resume applies the
current root cap to fresh work; changing only `totalAgents` does not change per-agent
replay keys. Hard-crash recovery additionally checks the exact launch fingerprint,
including resolved budgets: a mismatch refuses recovery rather than rewriting history.
Earlier per-child default removal and shaped-return version changes retain their
[documented replay boundaries](recovery-and-continuation.md).

**Report measurements.** The selected execution's `outputs/README.md` includes every
applied axis, fresh and replayed calls separately, wall clock, longest fresh child,
reported tokens and gate-owned peak concurrency. `agent_queued` is demand;
`agent_start` follows admission. Replayed durations/tokens are excluded. Per-child turns
and tools have no durable measured totals and print as `not recorded`, never `0`.

**Source owners.** [Budget resolution](../../extensions/workflows/runtime/workflow-budget.ts),
[root launch](../../extensions/workflows/runtime/workflow-runner.ts), [shared enforcement](../../extensions/workflows/runtime/workflow-execution-state.ts),
[standalone tasks](../../extensions/agents/run/run-launcher.ts), [SDK child execution](../../extensions/_shared/agent-runtime/agent-sdk-host.ts),
[return clarification](../../extensions/workflows/runtime/workflow-return.ts) and [saved composition](../../extensions/workflows/runtime/workflow-saved-child.ts).

---

## Shared run budget at the tool boundary

The existing `workflow` tool accepts optional `budget` with the six axes: concurrency, totalAgents, runtimeMs, timeoutMs, toolCalls and turns. There is no answer-size axis: a run does not bound how LONG an answer may be, and a real size limit is declared on the call as a consumer contract (`output.maxLength`, or `maxLength`/`maxItems` inside a `schema`). A budget object that still carries `answerChars` is refused by name rather than ignored. Values are validated by the same runtime budget owner and displayed in the approval details. There is no second adaptive budget and no USD-cost claim. The command launcher carries this object for structured callers; the slash CLI syntax has not gained budget flags.

For the three-round refinement example, `totalAgents: 9` permits at most nine physical workflow children when transport retries are not enabled. Every shaped decision is corrected inside its own child session, so a format correction never costs another physical child — it consumes that child's cumulative turns/tools/time.

See the [policy above](#run-budget) for launch defaults and the [output acceptance principle](agent-results.md#the-principle) for the distinction between spending and accepting an answer.

A complete structured invocation can narrow the budget, for example:

```json
{
  "scriptPath": "extensions/workflows/references/examples/refinement.workflow.mjs",
  "input": "Explicit goal and acceptance criteria",
  "budget": {
    "concurrency": 2,
    "totalAgents": 9,
    "runtimeMs": 600000,
    "timeoutMs": 180000,
    "toolCalls": 100,
    "turns": 10
  }
}
```

These values are illustrative operator choices, not new defaults. Budgets govern the DSL execution tree and supported saved children, not arbitrary hostile subprocesses or hidden tool-launched orchestration in this trusted host.

## Provider timeout propagation

**CLI provider request timeout.** For a resolved model whose `baseUrl` uses `cli://`, the SDK child uses the declared `timeoutMs`, limited by an explicit smaller provider setting or HTTP idle setting (when no provider setting overrides it). With no declared or configured limit, the CLI request is unbounded: Pi's implicit 300,000 ms HTTP idle default does not become a process deadline. An explicit per-call timeout retains Pi's precedence over settings. Zero HTTP idle timeout means disabled, as in Pi. The adapter may enforce its own smaller process limit. Native HTTP providers, retries, abort propagation, provider hooks, saved settings, and replay inputs keep their existing behavior.
