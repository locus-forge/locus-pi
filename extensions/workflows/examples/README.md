# Shipped workflow portfolio

This directory is the Package registry. Each `<name>/` folder owns one namespace:
it may provide a runnable `<name>.workflow.mjs` root, direct
`<child>.workflow.mjs` entries, or only children when the namespace is
group-only. Runnable roots resolve as `<name>`; children resolve as
`<name>/<child>`.

Adding or removing an entry here changes the public package surface. The same
change must update the npm package boundary, manuals, tests, and changelog.

All shipped entries use the `standard` authoring profile. That value describes
the compact source-shape contract checked during authoring; it is metadata, not
a runtime mode or model choice.

## Current portfolio

| Namespace          | Shape                         | Why it remains                                                                                                                                 |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`       | runnable root                 | Provides the smallest real child-session diagnostic for an installed Pi host.                                                                  |
| `task`             | group-only: `draft`, `plan`   | Separates an editable orchestration brief from direct construction of one reviewed `workflow.mjs`; no generic implementation workflow remains. |
| `post-code-review` | runnable root plus 7 children | Owns the modular review graph: `scope`, `boundaries`, `simplicity`, `contracts`, `style`, `necessity`, and `synthesis`.                        |
| `stage-loop`       | runnable root                 | Shows the bounded fix loop: implement, review and checks in parallel, a `choice` gate, then a commit; refusal is returned, never thrown.       |

The registry therefore exposes twelve runnable names across four namespaces.
The retired generic implementation, template-rendering, substep, and
workflow-creator entries duplicated the direct draft-to-source route. They are
intentionally absent rather than retained as catalog noise.

## Resolution and copying

Project sources resolve before User sources, which resolve before Package
sources. The focused `/workflows list` browser exposes those sources plus
History as separate tabs; changing tabs does not change first-wins resolution.
Each tab shows its active catalog directory, and source inspection shows the
exact catalog directory and selected entry path.

Folder-owned namespaces can be copied from source inspection. Package offers
`Copy to Project` and `Copy to User`; Project and User offer only the opposite
destination. Copying preserves the complete namespace, including direct
children and adjacent README, prompt, diagram, and resource files. Group-only
namespaces remain group-only after copying.

Copying never merges or overwrites. An existing destination folder or
compatible flat root produces a conflict notice and leaves both locations
unchanged. Reopen `/workflows list` after a successful copy to see first-wins
resolution select the new editable source.

## Command surface

The canonical command is `/workflows` with a subcommand:

```text
/workflows dashboard
/workflows list [query]
/workflows info [name]
/workflows status [runId]
/workflows result [runId|last]
/workflows run <name|path> [options] [input]
/workflows continue <runId> [--answer <text>]
/workflows stop [runId|last]
```

Only `/workflow-stop` remains as an emergency flat alias.

## Distribution boundary

- Git tracks public-repository contents. `package.json#files` controls the installed npm package.
- `tests/integration/package-boundary.test.ts` proves that packed workflow
  names equal the entries discovered from this directory.

## Authoring boundary

Standard authoring is one continuous Design → review → Build sequence. A raw
request first writes and reviews
`.locus-pi/workflows/<name>/<name>.design.md`, then creates exactly the root and direct
children declared by that design. Explicit design-only wording may pause after
design. `Build design: <path>` and `Build approved design: <path>` remain
Build-only compatibility forms.

The detailed source-shape contract lives in [source contract](../../../docs/workflows/source-shape.md#machine-enforced-standard-source-shape).
Worked references that must not become Package entries live under
`../references/` and run only by explicit path.
