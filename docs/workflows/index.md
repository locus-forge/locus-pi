---
title: Workflow documentation
type: index
status: active
updated: "2026-09-13T00:12:22Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow documentation

This is the installed manual for writing, running and understanding Locus Pi workflows.
Choose the page that answers the current question; a workflow author does not need to
load the whole runtime manual before writing a small graph.

## Start with the task

| Reader question                                                   | Read                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I am new to workflows                                             | [Operator guide](../workflows.md), then [authoring guide](../locus-pi-workflows.md)                                                                                                   |
| I want an agent to write a workflow                               | [Create skill](../../skills/locus-pi-workflow-create/SKILL.md), its [graph cards](../../skills/locus-pi-workflow-create/references/INDEX.md), then [source contract](source-shape.md) |
| Where does my module belong and how is its name resolved?         | [Catalog and source resolution](catalog.md)                                                                                                                                           |
| How do I declare input, phases and a module entry?                | [Authoring a module](authoring.md)                                                                                                                                                    |
| Which DSL calls compose agents and saved children?                | [DSL and execution controls](dsl.md)                                                                                                                                                  |
| What can stop spending or reject an unsupported declaration?      | [Budgets and constraints](budgets.md)                                                                                                                                                 |
| How do I return text, choices, handoffs or validated values?      | [Output acceptance](agent-results.md)                                                                                                                                                 |
| How do failures, retries and review reports reach the next agent? | [Outcomes and retries](outcomes.md)                                                                                                                                                   |
| How do I launch or answer an operator question?                   | [Running](running.md), or the [run skill](../../skills/locus-pi-workflow-run/SKILL.md) for an agent executor                                                                          |
| Which model actually runs?                                        | [Agent catalog and model selection](models.md)                                                                                                                                        |
| How do I compose a panel and judge?                               | [Fusion](fusion.md)                                                                                                                                                                   |
| Where is the result and how do I inspect evidence?                | [Artifacts and journal](evidence.md), [progress and inspection](inspection.md)                                                                                                        |
| A run stopped; how do I recover it?                               | [Error diagnostics](error-diagnostics.md), then [recovery and continuation](recovery-and-continuation.md), or [recorded-call replay](replay.md)                                       |
| What does approval protect and what does source identity prove?   | [Trust and source identity](trust.md)                                                                                                                                                 |

## What it is

A Pi-native dynamic-workflow runtime that provides a DSL (`agent / fusion / items / outputDir /
invokeWorkflow / publishPrimaryFile / publishArtifact / consumeTextArtifact / awaitOperator /
parallel / pipeline / workflow / phase / log / promptFile / workspace`)
for orchestrating catalog-agent sessions through the existing
`task / createAgentSession` path and retaining their evidence under one run root.
The same extension owns an opt-in direct `fusion` tool for the main Pi session;
it is registered but inactive until the operator configures and enables it.

One way a workflow reaches a model:

- **`agent()`** — spawns a full catalog or workflow-local child session and returns
  its exact non-empty final text, routed through the same code path as the `task`
  tool. With `opts.choice` it returns one declared exact string; with
  `opts.handoffs` it returns a list of complete text work units. Every shaped
  call — `choice`, `handoffs`, `output` and the compatibility `schema` — is
  carried by the same same-session acceptance tool, which validates the value
  inside the one child session that produced it; see
  [output acceptance](agent-results.md). There is no text-parsed
  transport and no fresh-child format repair. Trusted compatibility scripts may
  still use `opts.schema` for an arbitrary validated value.
- **`fusion()`** — validates a panel of at least two explicit model selectors and one
  homogeneous capability mode, runs isolated members, and asks a separate judge
  call for one final answer. `mode: "tool-free"` gives every leg an empty active
  tool registry; `mode: "agent"` keeps the ordinary catalog-agent capability
  path. It receives no ambient conversation history.

There is no direct one-shot completion node: `llm()` existed until 0.2.x and was
removed so every physical model call keeps the same agent-session evidence path.
Fusion is a composition of that path, not a second transport.

Every `agent()` call in a workflow script routes through the same SDK child-session substrate as `spawn_agent`:

```
agent(prompt, opts)
  -> createWorkflowAgentRunner (workflow-agent-bridge.ts)
  -> createAgentRunRequest (agent-runner.ts)
  -> executeAgentRunBoundary (agent-runner.ts)
  -> createAgentSdkSessionExecutor (agent-sdk-host.ts)
  -> createAgentSession (Pi SDK host)
```

Workflow `.mjs` scripts execute as reviewed trusted JavaScript in the Pi host's
main Node process. Static `node:` imports are available by default. Local,
package, dynamic and source-anchored module behavior requires an explicit
`meta.identityCoverage: "entry-only"` evidence downgrade; it still has full Node
module access and can therefore use host filesystem, subprocess, network, or
other capabilities. Neither identity policy is a sandbox. `dsl` is the intended
authoring handle; it is not enforced.

---

## Default package

`workflows` is registered in `package.json#pi.extensions` and loads by default; the
`/workflows` command and `workflow` tool are available without manual loading.
See [Architecture and repository boundaries](../architecture.md) for the package status and publication boundary.

## What belongs here

`docs/workflows/` owns the public workflow contract: supported source and DSL,
inputs and outputs, launch modes, model routing, execution budgets and structural
constraints, evidence, failures, retries, replay and recovery. Document a rule when
it changes how a user operates a workflow or how an agent writes one. State the
default, scope, override and failure effect where each rule applies. Distinguish
execution budgets from output contracts, provider limits and display summaries.

The [budget policy](budgets.md#run-budget) is the one numeric policy owner. The
[output acceptance principle](agent-results.md#the-principle) owns result-size
policy. Examples and other pages link to those owners; example-specific numbers
are not package defaults.

`skills/` owns instructions for the executing agent: Design → review → Build,
pattern selection, launch ownership and recovery procedures. Its `references/`
contains graph cards and process guidance. Skills link to this manual for API
meaning instead of maintaining another runtime reference. The extension's
[colocated README](../../extensions/workflows/README.md) owns its short surface summary.

[Curated examples](../../extensions/workflows/examples/README.md) remain beside
executable workflow modules. The [advanced pattern catalog](../../extensions/workflows/references/patterns.md)
records trusted compatibility scripts; it is not the standard source-generation
target. Private task evidence, historical audits and local run output are not
part of this installed manual.

## Installed documentation

The npm package includes this manual. The [skill installation guide](../../skills/README.md)
explains how Pi, Codex and Claude locate it from the installed skill, including
managed symlinks. No separate documentation download is required.

## Maintain this manual

Each contract has one topical owner above. Update that owner alongside behavior,
link related pages, and keep standard snippets accepted by `workflow_check_source`.
A new public page needs an index link and must ship in the npm tarball. Repository
and package-boundary checks validate local targets and heading anchors. The
installation test verifies skill navigation from a real unpacked package,
including external skill symlinks.

The old extension reference paths are bookmark compatibility maps. Add no new
contract text there; active links point directly to this manual.
