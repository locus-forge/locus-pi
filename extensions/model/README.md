# model

`model` provides persisted routing roles without replacing Pi's built-in `/model`, `/models`, or `/thinking` commands.

It does not enforce Pi's `enabledModels` setting. That list keeps its Pi meaning: the scope for choosing and cycling the main model. An explicit `--model` and a workflow child route are resolved against Pi's model registry instead, including custom models from `models.json` and provider extensions.

## Commands

```text
/model-roles
```

`/model-roles` opens an interactive selector for the current model and saved roles such as `default`, `agent`, and `tier-s`. Non-default assignments affect matching child-agent and workflow role resolution; they do not silently change the current Pi session model.

The selector uses the shared [TUI visual language](../../docs/tui-design.md). Its purple frame and provider pill identify the active selection surface. Strong row focus moves from model to role to effort, while saved assignments remain green and unset routes remain warnings.

Use Pi's built-in `/thinking` selector to change the current thinking level. `Enter` applies the highlighted level to the current session; `Ctrl+S` also saves it as Pi's global default. Locus does not register a separate `/effort` alias. The package requires Pi `>=1.3.0`; `/thinking` has been available since Pi 0.84.3.

## Persistence

The selected configuration is `<project>/.pi/model-roles/config.json` when that file
exists; otherwise it is `~/.pi/agent/model-roles/config.json`. A project file replaces
the entire user file, including when its `roles` object is empty. Invalid or unreadable
project configuration is an error, never a reason to use user assignments instead.
The Pi project root determines the project file, including when a child uses another
working directory.

`/model-roles` shows the complete absolute filename at the bottom, wrapping long
paths. Assignments are saved to that same file. When neither file exists, the selector
shows the user destination as not created; the first assignment creates it. Reopen the
selector if the configuration source changes while it is open.

Tests and isolated installations may replace the user root with `$PI_MODEL_ROLES_HOME`;
this affects only the user file, not project precedence. Pi `settings.json#modelRoles`
and session evidence are not configuration inputs.

### Custom roles and tiers

Add a key to `roles` to define a custom role. The selector displays the key literally,
including case, and supports assigning its model and thinking level. There is no separate
display-name field. Names must be nonblank, have no surrounding whitespace, slashes or
control characters, and must not end in a reserved thinking suffix such as `:high`.

```json
{
  "version": 1,
  "roles": {
    "tier-s": "provider/model-s:high",
    "tier-a": "provider/model-a:high",
    "tier-b": "provider/model-b:medium",
    "tier-c": "provider/model-c:low",
    "my-reviewer": { "model": "provider/model-review", "thinking": "high" }
  }
}
```

These provider/model values are placeholders: use models available in your Pi registry.
The standard tier names have no shipped assignments or automatic ranking/downgrade policy.
Existing role names remain supported; `null` leaves a role unassigned. Only assigning
`default` also changes the current session. Other roles route matching children.

## Implementation

- Entrypoint: `extensions/model/index.ts`
- Selector: `extensions/model/model-role-selector.ts`
- Persistence and resolution: `extensions/_shared/model/model-settings.ts`
- Manifest: `extensions/model/manifest.json`
