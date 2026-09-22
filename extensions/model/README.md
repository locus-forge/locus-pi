# model

`model` provides persisted routing roles and thinking-effort controls without replacing Pi's built-in `/model` or `/models` commands.

It does not enforce Pi's `enabledModels` setting. That list keeps its Pi meaning: the scope for choosing and cycling the main model. An explicit `--model` and a workflow child route are resolved against Pi's model registry instead, including custom models from `models.json` and provider extensions.

## Commands

```text
/model-roles
/effort [off|minimal|low|medium|high|xhigh]
```

`/model-roles` opens an interactive selector for the current model and saved roles such as `DEFAULT`, `AGENT`, and `TASK`. Non-default assignments affect matching child-agent and workflow role resolution; they do not silently change the current Pi session model.

The selector uses the shared [TUI visual language](../../docs/tui-design.md). Its purple frame and provider pill identify the active selection surface. Strong row focus moves from model to role to effort, while saved assignments remain green and unset routes remain warnings.

`/effort` changes only the current session model's supported thinking level. The extension checks model capability before applying and verifies the host result instead of reporting a clamped value as success.

## Persistence

Global user configuration: `~/.pi/agent/model-roles/config.json`.

Tests and isolated installations may replace the user root with
`$PI_MODEL_ROLES_HOME`; the file remains `$PI_MODEL_ROLES_HOME/model-roles/config.json`.

This file is the only persistent model-role authority. Project
`.pi/model-roles/config.json`, Pi `settings.json#modelRoles`, and session evidence
are not configuration inputs. Missing or unavailable role routes degrade or fail
according to the manifest contract and are recorded in run evidence.

## Implementation

- Entrypoint: `extensions/model/index.ts`
- Selector: `extensions/model/model-role-selector.ts`
- Persistence and resolution: `extensions/_shared/model/model-settings.ts`
- Effort command: `extensions/model/effort-command.ts`
- Manifest: `extensions/model/manifest.json`
