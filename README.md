# locus-pi — Dynamic Workflows for Pi

**Describe a task. Let an agent build a reusable workflow. Run it in Pi.**

locus-pi adds a workflow DSL to [Pi](https://github.com/earendil-works/pi).
Workflows can run agents in parallel, discover more work, and choose the next step
from their results. Save the workflow as a readable JavaScript file and run it again
when you need it. Model roles let you change models without rewriting the workflow.

[Documentation](docs/index.md) · [DSL reference](docs/workflows/dsl.md) · [Examples](examples/workflows/README.md)

## Install

Requires Node.js `>=22.19.0`, Pi `>=0.83.0`, and a configured model provider.

**From Git** — available now:

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

**Windows:** use WSL 2 and install Node.js, Pi, and locus-pi inside its Linux environment.
Follow [Windows setup](docs/getting-started.md#windows-use-wsl-2).

Start a fresh Pi session in your project. If locus-pi is already installed, replace
its existing source; keep your other packages. See [installation and updates](docs/getting-started.md).

<details>
<summary>Install only Workflow</summary>

Edit only the locus-pi entry in `~/.pi/agent/settings.json` or `.pi/settings.json`.
For Git, keep its checkout path as `source`; the npm source below applies after publication.

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

Keep other settings and package entries. `skills: []` disables package skills,
including the workflow creator; omit that field to retain them. The filter controls
what Pi loads. See [package filters](docs/getting-started.md#load-only-selected-extensions).

</details>

## What it adds

| Capability      | What you can do                                                                                                  | Learn more                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Workflows**   | Save reusable agent processes with parallel steps, branches, and results you can inspect.                        | [DSL reference](docs/workflows/dsl.md)                 |
| **Agents**      | Launch child agents, follow their progress, and open their output through `/ps`.                                 | [Agent guide](extensions/agents/README.md)             |
| **Model roles** | Assign models to role names such as `smol` and `slow` through `/model-roles`, then use those names in workflows. | [Role setup](docs/workflows/models.md#use-model-roles) |

The package also includes question prompts, structural code editing, and a status
line. See [all six extensions](docs/extensions.md). Model assignments are yours to
configure; no provider or model assignments ship with the package.

## Create a workflow with an agent

Use the [workflow-create skill](skills/locus-pi-workflow-create/SKILL.md) in Pi:

```text
/skill:locus-pi-workflow-create Create a project-tour workflow: two agents read README.md and package.json in parallel, then a third combines their notes into a getting-started guide. Do not modify project files during the run. Build and check the workflow, but do not run it yet.
```

Review the source saved under `.locus-pi/workflows/project-tour/project-tour.workflow.mjs`, then run:

```text
/workflows run project-tour
/ps
/workflows result last
```

[Create your first workflow](docs/workflows/create.md) explains the skill and includes
complete copyable source. [Run and inspect](docs/workflows/running.md) covers progress,
results, stopping, fresh runs, and replay. For Codex or Claude Code, see [skill installation](skills/README.md).

## Explore the DSL and examples

A workflow connects calls such as `agent()`, `parallel()`, and `pipeline()`. Use
`agent(..., { choice: [...] })` for a decision or `agent(..., { handoffs: {...} })`
when an agent discovers the work units. A stage may request `modelRole: "smol"`;
assign the role through `/model-roles` independently of the source.

For example, this workflow gathers two perspectives before combining them:

```js
export const meta = { name: "project-summary", profile: "standard" };

export default async function run({ agent, parallel }) {
  const notes = await parallel([
    () => agent("Read README.md. Explain the project. Do not modify files.", { label: "purpose" }),
    () => agent("Read package.json. Explain the commands. Do not modify files.", { label: "commands" }),
  ]);
  return agent(`Combine these notes into a getting-started guide. Do not modify files.\n${notes.join("\n\n")}`, {
    label: "summary",
  });
}
```

Save it as `.locus-pi/workflows/project-summary/project-summary.workflow.mjs` and
[check the source](docs/workflows/create.md#your-first-workflow) before running it.

- [DSL reference](docs/workflows/dsl.md) — every method, arguments, return values, examples, and availability.
- [Workflow file format](docs/workflows/authoring.md) — metadata, input, and the exported function.
- [Source rules](docs/workflows/source-shape.md) — what the creator may generate and what the checker rejects.
- [Examples](examples/workflows/README.md) — installed workflows under `examples/workflows/` and patterns to adapt.
- [Documentation](docs/index.md) — the entry point for installation, authoring, operation, and deeper topics.

## License and security

Licensed under the [MIT License](LICENSE). Run workflows from sources you trust;
see the [workflow trust guide](docs/workflows/trust.md). Report vulnerabilities
through GitHub private vulnerability reporting; use Issues for ordinary defects.
