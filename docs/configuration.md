# Configuration

## Standalone agent concurrency

Create or edit `.locus-pi/config.toml` in the project root.

```toml
[agents]
concurrency = 4 # Maximum simultaneous spawn_agent assignments in a Pi session.
```

Use a positive TOML integer up to `9007199254740991`. The default is `4`
when the file or key is absent. Extra assignments wait in the same queue in
background and awaited mode. Each parent session reads the limit when it
first launches an agent. Start a new Pi session to apply an edit.

If the file cannot be read or contains invalid TOML or an invalid value for
`agents.concurrency`, `spawn_agent` reports the configuration error before
launching a child. [Workflow budgets](workflows/budgets.md#run-budget) cover
the separate limits for workflow runs.

## Settings reference

Paths that start with `.` are relative to the project root.

| Setting                                      | Where to set it                                                                               | Default or behavior                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone agent concurrency                 | `.locus-pi/config.toml`, `agents.concurrency`                                                 | `4` active `spawn_agent` assignments per parent session.                                                                                                  |
| Workflow budgets                             | `budget` in workflow launch options                                                           | `concurrency` defaults to `4` per run. See [all budget fields and defaults](workflows/budgets.md#run-budget).                                             |
| Activity strip size                          | `.pi/agents-ui.json`, `activityStrip.maxItems`, or `/agent settings activityStrip.maxItems 4` | `4` items. Accepts integers from `1` to `20`. [Agents guide](../extensions/agents/README.md#contract-and-limits)                                          |
| Model role assignments                       | `.pi/model-roles/config.json` or `~/.pi/agent/model-roles/config.json` via `/model-roles`     | The project file takes precedence over the user file. [Model roles](workflows/models.md#use-model-roles)                                                  |
| Fusion                                       | `.locus-pi/fusion/config.json` via `/fusion`                                                  | Disabled until configured and enabled. [Fusion setup](workflows/fusion.md)                                                                                |
| HTML transcripts                             | `LOCUS_PI_HTML_TRANSCRIPTS` in the environment                                                | Enable with `1`. [Transcript settings](environment-variables.md#locus_pi_html_transcripts)                                                                |
| Pi package loading and main-session defaults | `.pi/settings.json` or `~/.pi/agent/settings.json`                                            | Managed by Pi. [Package selection](getting-started.md#load-only-selected-extensions) · [Model selection](workflows/models.md#inspect-model-configuration) |
