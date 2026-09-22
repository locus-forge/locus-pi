---
title: locus-pi documentation
type: index
status: active
updated: "2026-09-22T17:02:15Z"
source_commit: "5365d3f8cd9c"
update_event: "cleanup"
context: "changes=XL files=46"
description: "Consolidate workflow contracts at their owning pages and repair outdated guidance."
---

# locus-pi documentation

locus-pi adds **Dynamic Workflows for Pi**: reusable programs that coordinate agents,
branch on their results, and use model roles configured separately from the source.
Start with the action you want to take.

## Start here

| I want to…                                     | Read                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Install, update, or remove locus-pi            | [Getting started](getting-started.md), including [Windows with WSL 2](getting-started.md#windows-use-wsl-2)           |
| Ask an agent to create a workflow              | [Create a workflow](workflows/create.md) and the [workflow-create skill](../skills/locus-pi-workflow-create/SKILL.md) |
| Find a DSL method and understand its arguments | [DSL reference](workflows/dsl.md)                                                                                     |
| Understand what a workflow file can contain    | [File format](workflows/authoring.md) and [source rules](workflows/source-shape.md)                                   |
| Start from a working example                   | [Examples](../examples/workflows/README.md)                                                                           |
| Run a workflow and inspect the result          | [Run and inspect](workflows/running.md)                                                                               |

## Core capabilities

- **[Workflows](workflows/index.md)** connect agent calls, branching, parallel work, artifacts, and operator handoffs.
- **[Agents](../extensions/agents/README.md)** launch child sessions and expose their progress and transcripts.
- **[Model roles](workflows/models.md#use-model-roles)** let you assign a model once and request that role from a workflow.

The [extension catalog](extensions.md) covers all six included extensions.
The [skill guide](../skills/README.md) explains using the creator and runner from Pi,
Codex, and Claude Code.

## Operate and troubleshoot

- [Find and copy workflows](workflows/catalog.md).
- [Inspect progress](workflows/inspection.md), [read evidence and artifacts](workflows/evidence.md), and [understand failures](workflows/error-diagnostics.md).
- [Resume recorded work](workflows/replay.md) or [continue after an operator answer](workflows/recovery-and-continuation.md).
- [Configure budgets](workflows/budgets.md), [understand accepted results](workflows/agent-results.md), and [review trust boundaries](workflows/trust.md).

The [workflow topic index](workflows/index.md) lists the remaining detailed contracts.

## Repository reference

[Architecture and repository boundaries](architecture.md) explains source ownership.
[Environment variables](environment-variables.md) and the [TUI design guide](tui-design.md)
cover configuration and interface conventions.
