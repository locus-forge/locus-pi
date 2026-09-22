# locus-pi

`locus-pi` adds agent tools, workflow execution, model controls, and status views to [Pi](https://github.com/earendil-works/pi). The package includes six extensions, curated workflows, and three workflow skills. Named agent profiles stay in your project or home catalog.

Requires Node.js `>=22.19.0`, Pi `>=0.83.0`, and trusted project and workflow sources.

## Install

```bash
pi install npm:@locus-forge/locus-pi
```

Start a new Pi session and try `/workflows list`, then `/workflows run live-smoke`.

To load only Workflow and no package skills, replace the existing locus-pi entry in `~/.pi/agent/settings.json` or `.pi/settings.json`. Keep your other package entries:

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

The example shows the `packages` array; edit only its locus-pi entry in existing settings. The filter limits what Pi loads; it does not reduce the installed npm package. See [Getting started](docs/getting-started.md) for updates, removal, and first-run help.

## Guides

- [Extensions catalog](docs/extensions.md)
- [Create workflows](docs/locus-pi-workflows.md) · [Run and inspect workflows](docs/workflows.md)
- [Workflow reference by topic](docs/workflows/index.md) · [External-agent skill links](skills/README.md)

Extensions and workflow scripts run with the trusted Pi and Node.js host, without a sandbox. Review local workflow sources before running them. Report vulnerabilities through GitHub private vulnerability reporting; use Issues for ordinary defects.

Licensed under the [MIT License](LICENSE).
