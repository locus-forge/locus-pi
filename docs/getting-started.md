---
title: Getting started
type: guide
status: active
owner: locus-pi maintainers
tags: [installation, getting-started]
updated: "2026-09-22T16:20:56Z"
source_commit: "54dea11dbe11"
update_event: "user_request"
context: "changes=XL files=71 task=T-101"
description: "Clarify the documentation entry points, canonical workflow guides, and installed example navigation."
---

# Getting started

Requires Node.js `>=22.19.0`, Pi `>=0.83.0`, and a configured model provider.
Choose one installation source. The new npm package is not published yet; use
Git for now. Both routes provide the same extensions, workflows, and skills.

[Documentation](index.md) · [Create a workflow](workflows/create.md) · [Examples](../examples/README.md)

## Windows: use WSL 2

Use WSL 2 for the Linux installation route described below. In an administrator
PowerShell, follow [Microsoft's WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install)
and run `wsl --install` if WSL is not installed. Restart when prompted, then open
your Linux distribution.

Install Git, Node.js `>=22.19.0`, and Pi **inside that Linux environment**. Configure
Pi's model provider there, then run the Git or npm commands below from the same
Linux shell. Keep the checkout and your project in the Linux filesystem, for example
under `~/projects/`. Avoid mixing Windows Node/npm with a WSL Pi installation.

This is the recommended route for locus-pi on Windows. Pi also documents native
Windows bash setups; the WSL recommendation is not a claim that Pi requires WSL.

## Install from a Git checkout

```bash
git clone https://github.com/locus-forge/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
pi install .
pi list
```

Keep the checkout at this path: Pi loads it directly. `pi install .` registers
it for your user. To register it only for a project, run
`pi install /absolute/path/to/locus-pi -l` from that project's directory.
Register it in one scope, not both.

If you already have locus-pi installed, replace its entry as described below
before registering another source.

## Install from npm

Once `@locus-forge/locus-pi` is published:

```bash
pi install npm:@locus-forge/locus-pi
pi list
```

Add `-l` to `pi install` for project scope. `pi list` shows registered sources
and their scopes. Pi reports missing entrypoints and load failures at startup.

## Replace an existing installation

Use `pi list` to find the existing locus-pi source and scope. In
`~/.pi/agent/settings.json` (user scope) or `.pi/settings.json` (project scope),
replace only that entry's source. Preserve its resource filters and all other
package settings. Do not add a second locus-pi entry alongside it.

For example, replace `npm:@kroffske/locus-pi` with the absolute path to your
prepared Git checkout now, or with `npm:@locus-forge/locus-pi` after publication.
For the npm source, then run `pi update npm:@locus-forge/locus-pi` to install it.
For a checkout, run `npm ci --ignore-scripts` in that checkout. Confirm the new
source with `pi list`, then start a fresh Pi session.

## First launch

Start Pi in the project you want agents to work on. To check discovery:

```text
/workflows list
/workflows info live-smoke
```

For a small live check, run `/workflows run live-smoke`. It starts two child
agents **in sequence**, each listing the project directory, and uses your
configured model provider.

Next, [create and save your first workflow](workflows/create.md#your-first-workflow),
then follow [run and inspect](workflows/running.md#run-a-saved-workflow). The first example
runs two agents in parallel and combines their results.

Pi loads the package skills by default. If you use the Workflow-only filter,
use the copyable example or enable the skills before asking Pi to author a workflow.
To expose the same skills to Codex or Claude Code, follow the
[managed skill-link guide](../skills/README.md#install-for-codex-and-claude-code).

## Load only selected extensions

Pi installs the package once and can filter which entrypoints it loads. Use `pi config` for an interactive global or project-local selection, or edit the existing locus-pi entry in `~/.pi/agent/settings.json` or `.pi/settings.json`. Replace that entry instead of adding a second copy; keep all other package entries.

For Git, keep the existing checkout path as `source` and add the resource filters
below. The example uses the npm source for after publication; it loads only the
workflow extension and disables the bundled skills:

```json
{
  "packages": [
    {
      "source": "npm:@locus-forge/locus-pi",
      "extensions": ["extensions/workflows/index.ts"],
      "skills": []
    }
  ]
}
```

The JSON block shows one `packages` array for clarity. If your settings already
contain other packages, change only the locus-pi object inside that array.
`skills: []` disables package skills; omitting `skills` leaves them enabled.

For a Git installation, retain the registered checkout path as `source` instead
of the npm source shown above. Filters limit the resources Pi loads; the complete
package and its dependencies remain installed.

## Mix with another Pi package

Pi can load several package sources in one process. Before enabling another implementation of the same capability, explicitly exclude the overlapping Locus entrypoint. Do not rely on package order to override a tool: duplicate tool names are order-sensitive, duplicate commands are disambiguated by the host, and hooks compose according to each event's rules.

Example: keep the Locus agent launcher and use workflows from another package:

```json
{
  "packages": [
    {
      "source": "npm:@locus-forge/locus-pi",
      "extensions": ["extensions/agents/index.ts"],
      "skills": []
    },
    "npm:@vendor/other-workflows"
  ]
}
```

## Update, scopes, and removal

### Update a Git checkout

From the registered checkout:

```bash
git pull --ff-only
npm ci --ignore-scripts
```

No re-registration is needed. Start a fresh Pi session so it loads the updated
source. If Git reports local changes or a diverged branch, resolve those before
updating; do not discard your work to force an update.

### Update an npm installation

Run `pi update npm:@locus-forge/locus-pi` and start a fresh Pi session. Your
resource filter stays in settings.

### Inspect scopes and remove a registration

Use `pi list` and `pi config` to inspect sources and filters. Remove only the
unwanted scope:

```bash
pi remove npm:@locus-forge/locus-pi
pi remove npm:@locus-forge/locus-pi -l
```

For a checkout, run `pi remove /absolute/path/to/locus-pi` from the same scope,
or add `-l` from the project where it was registered. Remove the registration
before moving or deleting the checkout. Removing it does not delete runtime history.

## Common failures

### Pi reports a missing or failed extension entrypoint

Reinstall dependencies for a checkout and verify that the package or checkout is complete. For npm installs, remove and reinstall the same package identity.

### Pi works outside the repository but fails inside it

The checkout is probably registered in both user and project scope. Use `pi list`, then remove one registration.

### `/workflows run` is rejected before a run starts

Check the target name, required `--output-dir`, safe project-relative path rules, and whether the workflow needs structured fields available only through the `workflow` tool. Use `/workflows info <name>` for the live contract.

### A workflow is awaiting operator input

Inspect it with `/workflows status <runId>`, then continue it explicitly with `/workflows continue <runId>`. Do not invent an answer in automation.

### A local workflow is untrusted

Do not run it. Project and user workflows are JavaScript with host access; path validation and approval prompts are not a sandbox.
