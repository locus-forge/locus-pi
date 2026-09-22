# Workflow examples

Use these examples to run a workflow in Pi or give an agent a concrete starting
point for a reusable workflow of your own. First [install locus-pi](../docs/getting-started.md).

## Ready-to-run workflows

[Shipped workflows](workflows/README.md) are installed with the package and appear
in the Package tab of `/workflows list`. You can run them by name and copy an
entire namespace into your project before editing it.

| Start here                                                       | What it demonstrates                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Live smoke check](workflows/live-smoke/live-smoke.workflow.mjs) | Two real child agents checking that an installed Pi host works.             |
| [Task authoring](workflows/task/README.md)                       | Turn a request into an editable brief, then a checked workflow source file. |
| [Post-code review](workflows/post-code-review/README.md)         | Parallel review perspectives, independent verification, and a final report. |
| [Stage loop](workflows/stage-loop/stage-loop.workflow.mjs)       | A bounded implement, review, fix, and commit cycle.                         |

## Patterns to adapt

[Workflow patterns](../extensions/workflows/references/patterns.md) explain reusable
orchestration shapes. The teaching sources in
`extensions/workflows/references/examples/` are separate from the shipped
workflow registry: they do not appear as saved Package names. They can be read,
adapted, or run by explicit path after review.

- [Adaptive slices](../extensions/workflows/references/examples/adaptive-slices.workflow.mjs)
  shows how an owner revises the remaining work after each reviewed slice.
- [Refinement](../extensions/workflows/references/examples/refinement.workflow.mjs)
  shows a bounded improve-and-check loop.

To ask an agent for your own workflow, follow [Create a workflow](../docs/workflows/create.md).
Use the [complete DSL reference](../docs/workflows/dsl.md) for available operations
and [authoring restrictions](../docs/workflows/source-shape.md) for the source
that an agent is allowed to produce.
