---
title: Workflow documentation
type: index
status: active
updated: "2026-09-22T17:02:16Z"
source_commit: "5365d3f8cd9c"
update_event: "cleanup"
context: "changes=XL files=46"
description: "Consolidate workflow contracts at their owning pages and repair outdated guidance."
---

# Workflow documentation

[Documentation home](../index.md) · [DSL reference](dsl.md) · [Examples](../../examples/workflows/README.md)

<a id="what-it-is"></a>

A workflow is a reusable JavaScript module that connects agent calls. It can
run tasks in parallel, choose a branch from an agent's decision, and discover work
while it runs. The workflow-create skill can write the module for you.

<a id="start-with-the-task"></a>

## Create and understand

| Question                                           | Read                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| How do I ask an agent to build a workflow?         | [Create a workflow](create.md) and the [create skill](../../skills/locus-pi-workflow-create/SKILL.md)                                   |
| Which methods can I call, and what do they return? | [DSL reference](dsl.md)                                                                                                                 |
| What belongs in the file?                          | [File format, metadata, and input](authoring.md)                                                                                        |
| What may generated source do?                      | [Source rules](source-shape.md)                                                                                                         |
| Where can I find working examples?                 | [Installed workflows](../../examples/workflows/README.md) and [patterns to adapt](../../examples/workflows/README.md#patterns-to-adapt) |
| How do names resolve and namespaces get copied?    | [Catalog and source resolution](catalog.md)                                                                                             |
| Which model will an agent use?                     | [Model roles and agent profiles](models.md)                                                                                             |
| How do text, decisions, and work units return?     | [Agent results](agent-results.md)                                                                                                       |

## Run and operate

| Question                                        | Read                                                      |
| ----------------------------------------------- | --------------------------------------------------------- |
| How do I launch, stop, or read a result?        | [Run and inspect](running.md)                             |
| Where can I see active agents and progress?     | [Progress and inspection](inspection.md)                  |
| Where are files, journals, and results stored?  | [Artifacts and journal](evidence.md)                      |
| What limits spending or execution?              | [Budgets and constraints](budgets.md)                     |
| How do failures and retries affect a graph?     | [Outcomes and retries](outcomes.md)                       |
| How do I diagnose a failed run?                 | [Error diagnostics](error-diagnostics.md)                 |
| How do I reuse recorded work?                   | [Replay](replay.md)                                       |
| How do I answer an operator handoff or recover? | [Recovery and continuation](recovery-and-continuation.md) |
| How do I compare models with a separate judge?  | [Fusion](fusion.md)                                       |
| What does source approval protect?              | [Trust and source identity](trust.md)                     |

For an agent executing a saved workflow, use the [run skill](../../skills/locus-pi-workflow-run/SKILL.md).

## What belongs here

This manual owns the public workflow contract. The DSL reference owns method
signatures and availability; source rules own the accepted grammar; the topical
pages own detailed behavior. The [budget policy](budgets.md#run-budget) owns numeric
launch defaults, and [output acceptance](agent-results.md#the-principle) owns result-size policy.

`skills/` contains instructions for the agent doing the authoring or execution.
Skills link here for API meaning. The [extension README](../../extensions/workflows/README.md)
summarizes registered tools and commands. [Examples](../../examples/workflows/README.md)
keep executable sources next to their guides.

<a id="default-package"></a>
<a id="installed-documentation"></a>

The npm package includes this manual and its linked skills and examples.
The [skill installation guide](../../skills/README.md#find-the-installed-workflow-documentation)
explains finding it from Pi or external agent skill links. No separate download is needed.

<a id="maintain-this-manual"></a>

Update the canonical topic alongside behavior, keep examples accepted by their
declared source mode, and verify links in both the repository and the installed tarball.
