---
title: Architecture and repository boundaries
type: overview
status: active
updated: 2026-08-19T22:43:06Z
description: Document architecture and repository boundaries.
owner: locus-pi maintainers
tags: [architecture, repository]
---

# Architecture and repository boundaries

## Sources of truth

Public behavior is defined by the intersection of:

1. `package.json#pi.extensions` — the extension entrypoints Pi loads;
2. `extensions/<name>/manifest.json` — declared tools, commands, hooks, permissions, risk, tests, and manual;
3. extension source and focused tests;
4. the shipped workflow registry under `extensions/workflows/examples/`;
5. the npm allowlist in `package.json#files`.

A file merely existing in the repository does not make it a default extension, supported workflow, or npm package surface.

## Repository layout

```text
extensions/              extension implementations
extensions/_shared/      shared host, operator, runtime, model, and agent-runtime layers
extensions/workflows/    workflow runtime, authoring guide, and packaged examples
skills/                  bundled Pi skills
scripts/                 validation and public-repository materialization
tests/                   focused and integration tests
docs/                    small cross-cutting public guides
```

Extension-specific documentation is co-located in `extensions/<name>/README.md`. This keeps behavior, manifest metadata, tests, and documentation reviewable in one change.

## Extension dependency rule

Shared infrastructure under `extensions/_shared/` does not create a feature dependency. A direct feature dependency exists only when one `extensions/<feature>/` directory imports another feature directory.

The current direct feature graph has one edge:

- `agents → workflows`, partly through the read-only persisted-run facade

`scripts/check-extension-layers.ts` enforces the shared-layer ownership and import direction rules. It also enforces that the workflow DSL core (`extensions/workflows/runtime/workflow-runtime.ts`) reaches operator handoff and result semantics only through the fs-free contract modules `workflow-handoff-contract.ts` and `workflow-outcome.ts`, never through their durable counterparts, so no `node:fs` dependency enters the core's value-import closure.

## Workflow runtime owners

`extensions/workflows/runtime/` is organised by what a module owns, with imports pointing one way: the composition roots import the owners, never the reverse.

- `workflow-runtime.ts` assembles the DSL; `workflow-runner.ts` is the host entry that claims a run, admits it, executes it and finalizes it. Both re-export the names callers always imported from them, so a reader can start at either root.
- Execution owners behind the DSL: `workflow-execution-state.ts` (the one root leaf gate, counters and deadline shared by a root run and its saved children), `workflow-groups.ts` (group barriers and branch context), `workflow-agent-contract.ts` / `workflow-agent-call.ts` / `workflow-agent-attempt.ts` (the agent request contract, the logical call with its replay identity and transport retries, and one physical attempt), `workflow-agent-output.ts` (shaped results accepted only from a confirmed tool receipt) and `workflow-fusion.ts` (Fusion composition). All stay in the fs-free closure the layer checker proves for the core.
- Host owners behind the runner: `workflow-run-admission.ts` (target → source snapshot → workspace identity → launch binding, in that order, after the run claim and first journal line), `workflow-run-resume.ts` (the resume authority the tool and operator handoff share), `workflow-saved-child.ts` (one saved-child level, driven through an injected launcher so it never imports the runner) and `workflow-run-finalization.ts` (terminal precedence: abort, evidence, handoff, terminal text, lease, report, `result.json`).
- Persistence owners: `workflow-journal-format.ts` (the event contract and strict codec), `workflow-journal.ts` (claim, append, listing, queries), `workflow-result.ts` (result write and tolerant readback), `workflow-run-snapshot.ts` (whether the executed bytes are still provable), `workflow-artifact-format.ts` / `workflow-artifacts.ts` (format vs the mutable store), `workflow-workspace.ts` / `workflow-workspace-state.ts` (workspace identity vs the fenced lease and checkpoints; `workflow-output.ts` is the compatibility surface over both) and `workflow-run-layout.ts` (storage roots and confinement).
- Everything outside `extensions/workflows/` reads persisted runs through `extensions/workflows/run/run-read.ts`; the layer checker lists the persisted-run owners as feature-internal so that door stays the only one.

File size is a growth ratchet rather than a ceiling: `npm run check:topology` (part of `check:push`) fails on growth since the base ref, and `.locus-topology.toml` records the few accepted exceptions with an owner and a revisit trigger.

## Runtime state

Local runtime state is intentionally outside the public source surface and ignored by Git:

- `.locus-pi/runs/<runId>/` — workflow outputs and machine evidence;
- `.locus-pi/workspaces/<generated-run-name>/` — workflow-authored working files, including task drafts, generated workflows, review files, and implementation history;
- `.locus-pi/plans/<run-name>/` — legacy workflow workspaces; an existing one stays bound in place, and new named workspaces go to `.locus-pi/workspaces/`;
- `.locus-pi/workflow-state/v1/<hash>/` — active workspace leases and saved-child checkpoints; the directory may be empty after a lease is released;
- `.locus-pi/fusion/config.json` — project-local Fusion configuration;
- `.locus/runtime/` — session, artifact, and diagnostic state used by Locus extensions;
- `.tasks/` — optional local task state and explicit bridges;
- an explicit project-relative output directory — an optional operator override for workflow-owned working files.

Runtime state may contain project paths, prompts, model output, transcripts, or other private material. Do not commit it.

## Workflow precedence

Workflow discovery is first-wins by name. Project and user workflows can override package names according to the runtime discovery order. `/workflows list` shows the effective live catalog and source.

Package workflows are reviewed release assets. Project and user workflows remain local trusted code and receive no package support promise merely because the runtime can discover them.

## Publication boundary

The public repository keeps source, tests, package metadata, stable guides, extension manuals, examples, and legal/support files. The following belong outside the public Git history:

- task drafts and planning state;
- private roadmaps and product notes;
- ADR and decision history not required to use or contribute to the current code;
- source-audit working notes and local upstream checkouts;
- generated reports, transcripts, benchmarks, evaluations, and runtime artifacts;
- diagnostic export manifests and workstation-specific paths.

`.gitignore` prevents new local files in these categories from being added accidentally. It does not hide files already tracked; publication cleanup must remove them from the index and, when necessary, rewrite Git history before making the repository public.
