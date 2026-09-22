# Live smoke: repair a stopped workflow, then continue it

`npm run check` proves the runtime against fakes. This harness proves the same thing the
other way round: a real Pi session, a real model, a real stopped run, and a real
continuation whose recorded answer is served back instead of being asked again.

It also exercises the shaped `workflow_return` path end to end, because the repaired
source asks its middle agent for `handoffs` through `returnVia: "tool"`.

## What it does

1. Writes `repair-smoke.before.workflow.mjs` into a scratch project as
   `.locus-pi/workflows/repair-smoke/repair-smoke.workflow.mjs`. That source runs one
   labelled agent, `inventory`, and then throws on purpose.
2. Starts Pi inside tmux and runs the workflow. The run stops with `inventory` recorded.
3. Copies `repair-smoke.after.workflow.mjs` over the same path — the repair. The
   `inventory` call keeps its label and its exact prompt; a `review` call and a `report`
   call are added after it.
4. Continues with `/workflows run repair-smoke --resume <runId>`.
5. Asserts the continuation's own `runtime/result.json` replay envelope with
   [assert-reuse.mjs](assert-reuse.mjs): `replayed`, `replayedCalls === 1`,
   `freshCalls >= 2`, and `divergedAtNode` naming the repaired node.

## Why tmux drives it and computer use only watches

Computer use is granted terminal applications at a click-only tier, so it can see a
terminal and click in it but cannot type into it. The keystrokes therefore come from
`tmux send-keys`. Computer use takes the screenshot of the tmux window, which is the part
a person actually needs to look at: what the operator sees while the run stops, and what
they see after the continuation reports its reuse.

## Run it

```bash
PROJECT=/tmp/repair-smoke tests/manual/repair-continue-tui/run.sh
```

`PROJECT` is a scratch directory, never this repository. `PI_CMD` overrides how Pi starts
and defaults to this checkout's extensions. `KEEP=0` closes the tmux session at the end;
the default leaves it open so a screenshot can still be taken.

The script writes every captured pane and the assertion output under `$PROJECT/.smoke/`.
It costs real model calls — three short ones on the continuation.

## Not part of `npm run check`

This needs a live provider, a terminal multiplexer and a screen, so it is a manual gate,
not a suite. `vitest` only collects `tests/**/*.test.ts`, so nothing here runs by accident.
Both sources are valid strict-profile workflows and can be verified without a model:

```bash
npm run check:workflow-source -- tests/manual/repair-continue-tui/repair-smoke.after.workflow.mjs
```

Background on the mechanism: [Repair + Continue](../../../skills/locus-pi-workflow-create/references/repair-and-continue.md)
and the runtime reference section [Continuing a repaired workflow](../../../docs/workflows/replay.md#continuing-a-repaired-workflow).
