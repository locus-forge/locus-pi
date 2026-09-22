# locus-pi — Dynamic Workflows for Pi

Build reusable workflows that coordinate agents in [Pi](https://github.com/earendil-works/pi). Describe a task, save its workflow, and run it again when you need it. A workflow can run agents in parallel, choose its next steps from their results, and reuse recorded steps when resuming a run. Model roles let you choose models in settings without rewriting the workflow.

## Install

Requires Node.js `>=22.19.0` and Pi `>=0.83.0` with a configured model provider.

**From Git** — the available installation route while the npm package is unpublished:

```bash
git clone https://github.com/locus-forge/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
pi install .
```

**From npm** — once `@locus-forge/locus-pi` is published:

```bash
pi install npm:@locus-forge/locus-pi
```

Start a new Pi session in your project. If locus-pi is already registered, replace its existing source instead of adding a second copy; preserve your other packages. [Getting started](docs/getting-started.md) covers source replacement, `git pull` updates, scopes, and removal.

<details>
<summary>Install only Workflow</summary>

Edit only the locus-pi entry in `~/.pi/agent/settings.json` or `.pi/settings.json`.
For Git, keep its existing checkout path as `source` and add the two filters below.
The npm source in this example applies after publication:

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

Keep the rest of your settings and other package entries. `skills: []` disables package skills; omitting it leaves them enabled. The filter controls what Pi loads, not the contents of the installed package. See [package filters](docs/getting-started.md#load-only-selected-extensions).

</details>

## Create, save, run

Ask Pi to create a workflow, for example:

```text
Create a project-tour workflow: two agents read README.md and package.json in parallel,
then a third combines their notes into a short getting-started guide.
Do not modify project files during the run. Build and check the workflow, but do not run it yet.
```

Review the source saved under `.locus-pi/workflows/project-tour/project-tour.workflow.mjs`. The [first-workflow guide](docs/locus-pi-workflows.md#your-first-workflow) includes a complete copyable example if you prefer to write it yourself.

```text
/workflows run project-tour
/ps
/workflows result last
```

The live panel shows agents as they work. In `/ps`, select an agent and press Enter to inspect its output; Esc returns to Pi. Run `/workflows run project-tour` again for a fresh run. Use `--resume <runId>` to reuse eligible recorded steps; [the operator guide](docs/workflows.md#run-again-or-resume) explains when to choose each.

## Choose models through roles

A stage can use `modelRole: "smol"` instead of a concrete model ID. Assign that role through `/model-roles`; the same workflow can then use different models on different machines. Roles are optional, and the package ships no assignments. See [model-role setup](docs/workflows/models.md#use-model-roles).

## Guides

- [Install, update, or remove](docs/getting-started.md)
- [Create workflows](docs/locus-pi-workflows.md) · [Run and inspect workflows](docs/workflows.md)
- [What each extension adds](docs/extensions.md)
- [Workflow reference by topic](docs/workflows/index.md) · [Use skills from Codex or Claude Code](skills/README.md)

## License and security

Licensed under the [MIT License](LICENSE). Run workflows from sources you trust; see the [workflow trust guide](docs/workflows/trust.md). Report vulnerabilities through GitHub private vulnerability reporting; use Issues for ordinary defects.
