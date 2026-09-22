# Excalidraw diagram pipeline

A project-local workflow that turns a free-form diagram intent into a readable
Excalidraw diagram and a rendered PNG. It is **not** a Package workflow: it lives
under `references/` rather than in the scanned `examples/` directory, and it is
not in `package.json#files`, so
it runs by path only.

```
extensions/workflows/references/excalidraw-pipeline/
├── excalidraw-pipeline.workflow.mjs       entry — routing, preflight, both runs
├── excalidraw-pipeline.section-host.mjs   executes agent-written section files
├── resources/
│   ├── intent-to-draft.prompt.md          run 1: intent -> request file
│   ├── section-author.prompt.md           run 2: brief -> restricted graph source
│   └── section-repair.prompt.md           run 2: execution errors -> fixed source
└── README.md
```

## Two runs, one file between them

A workflow run cannot stop and ask a human: `ask` refuses when there is no UI, and
child agent sessions are headless. So the pipeline is cut into two runs, and the
human gate is a file the operator edits in between — the same shape as
`post-code-review` → `implement`.

```
run 1  draft            run 2  build
─────────────────       ────────────────────────────────────────────────
intent                  approved request file
  │                       │
  ▼                       ▼
one agent               preflight (no model involved)
  │                       │
  ▼                       ▼
diagram-request.md ──▶  one agent per section ──▶ workflow executes each
       ▲                                          section file, feeds hard
       │                                          errors back (≤ 2 repairs)
  human edits it                                       │
  and sets                                             ▼
  approved: yes                                 workflow composes, runs
                                                assertDiagramHealthy,
                                                renders diagram.png
```

### Run 1 — draft

```
/workflows run extensions/workflows/references/excalidraw-pipeline/excalidraw-pipeline.workflow.mjs draft the review workflow stages and where each artifact lands
```

Creates one run folder under the ignored `.tasks/` tree
(`.tasks/excalidraw-pipeline/<timestamp>-<slug>/`), and one agent writes
`diagram-request.md` there. The workflow parses that file itself; if it does not
parse, the drafter gets one repair attempt and then the run fails with the list of
problems. The file stays on disk either way.

The run stops there. Nothing is drawn.

### The human gate

Open `diagram-request.md` and edit it directly. Split or merge sections, rewrite a
brief, add or remove links. Then change the first field:

```text
approved: no     →     approved: yes
```

That single word is the gate. `build` refuses to start without it, with the reason
`request-not-approved`.

### Run 2 — build

```
/workflows run extensions/workflows/references/excalidraw-pipeline/excalidraw-pipeline.workflow.mjs build .tasks/excalidraw-pipeline/<run>/diagram-request.md
```

## The request file contract

```text
# Diagram request

approved: no
title: Curated review workflow
subtitle: Six sequential agent stages and one write-capable publisher

## Section stages — Agent stages
exports: scope, inventory, publish
brief: Six read-only agent sessions in one chain. Scope resolver decides what is
under review, change inventory proves coverage, unit planner groups it, the
interrogator asks the falsifiable questions, the verifier answers them, and the
publisher writes the package. Each one hands its exact text to the next.

## Section artifacts — Persisted artifacts
exports: reviewFile, journal
brief: Where the run leaves evidence. review.md under the task artifacts folder,
the run journal, and result.json holding the executive summary.

## Links
stages.publish -> artifacts.reviewFile : writes
stages.scope -> artifacts.journal : phase events
```

| Field                       | Required | Meaning                                                               |
| --------------------------- | -------- | --------------------------------------------------------------------- |
| `approved`                  | yes      | `yes` / `true` / `approved` starts a build. Anything else refuses.    |
| `title`                     | yes      | Diagram title, drawn on the canvas.                                   |
| `subtitle`                  | no       | Second title line.                                                    |
| `## Section <id> — <title>` | ≥ 1      | One independent part of the diagram. At most 6.                       |
| `exports:`                  | yes      | lowerCamelCase names of the cards other sections may point at.        |
| `brief:`                    | yes      | The whole instruction the section author receives. Prose, not code.   |
| `## Links`                  | no       | `sectionId.exportName -> sectionId.exportName : label`, one per line. |

Ids are lowercase letters, digits, and dashes. Every link endpoint must name a
declared export. A `-` or `*` list marker in front of any line is accepted, so the
file stays comfortable to edit as Markdown.

## What each side owns

**The workflow owns** every path, every coordinate, section placement, the section
titles drawn on the canvas, the cross-section arrows, the health gate, and the
render. **The agents own** only the content of one section: which cards exist,
what they say, which icon each one uses, and which card points at which inside
their own section.

An agent never chooses an output path. The workflow passes the exact absolute path
into the prompt and validates that the file appeared there.

## The section contract

Each section agent writes one JavaScript file that the workflow then executes:

```js
export default function buildSection({ layout, scene, title }) {
  const cards = layout.column(
    {
      gateway: layout.node(scene, { title: "API gateway", iconId: "api_connector", bullets: ["terminates TLS"] }),
      authz: layout.node(scene, { title: "Authorizer", iconId: "guardrails", bullets: ["checks the token"] }),
    },
    { gap: 32 },
  );
  layout.section(scene, { title, children: [cards] });
  layout.connect(scene, cards.gateway, cards.authz, { label: "asks" });
  return { gateway: cards.gateway, authz: cards.authz };
}
```

Allowed: `layout.node`, `layout.row`, `layout.column`, `layout.section`,
`layout.connect`. Rejected before the file runs: any other `layout.*` helper,
`import`, `require`, `process`, `eval`, a call on `scene`, and numeric child
indexes such as `cards[0]`. Rejected while it runs: an invented icon id, a missing
declared export, more than one `layout.section` call, `layout.connect` before
`layout.section`, and a section that draws no cards.

Model text is never parsed as a protocol. The machine-checkable object is always
the file, executed by the workflow.

Each failing section gets at most two repairs, each fed the real execution errors.
A section that still fails ends the run with `reason: "section-unrepairable"`.

## Acceptance gate

A build succeeds only when all of this holds:

- every section file executes with no hard error;
- `assertDiagramHealthy` passes over every card and every arrow **with zero
  warnings** — not "the file was written";
- `excalidraw-render` exits cleanly and `diagram.png` exists and is not empty.

Anything else returns `ok:false` with a named `reason`.

## Requirements

`@kroffske/excalidraw-diagrams` and its `excalidraw-render` binary are **global**
tools here. The package deliberately is not a dependency of this repository:

```sh
npm i -g @kroffske/excalidraw-diagrams
```

The preflight proves both are usable **before the first child agent session
exists**. A missing package fails with `generation-package-unavailable`; a missing
renderer fails with `renderer-unavailable`. It first tries the inherited module
path, then the global npm root.

The section host runs as a separate Node process. That keeps model-written code
out of the Pi host process and lets the global module path be supplied for that
process alone. It is not a sandbox: it runs as the same user with the same
filesystem access.

## Model

No stage names a provider. The section authoring and repair stages run on the
`agent` tier (`AUTHOR_MODEL_ROLE` in the entry file) and the draft stage on
`smol` (`DRAFT_MODEL_ROLE`), so `/model-roles` decides what each one means; a
role nothing assigns runs on the current session model and the run evidence
records the degradation.

The claim this pipeline exists to demonstrate — a correctly decomposed workflow
finishes on a weak model — is a claim about a run, not about a constant in a
file. The run that established it used `openai-codex/gpt-5.6-luna` for the
authoring stages. To reproduce it rather than simply execute the pipeline,
assign `AGENT` to that model; to test the claim against your own weak model,
assign it there instead. The former spelling froze one vendor into the script
and refused the call by name for every reader who did not have it.

## Known sharp edges

- **Cross-section arrows are the fragile part of the health gate.** They are drawn
  by the workflow between sections laid out left to right in one row. A link
  between distant sections can cross a card and fail the gate. The fix is an
  operator edit: drop the link or reorder the sections in the request file, then
  rerun `build`.
- **`output-clipped` is not load bearing.** The render frame is derived from the
  composed scene, so that particular check cannot fail. Overlap, text overflow,
  and arrows crossing cards are the checks that carry the gate.
- **Run artifacts live under `.tasks/`**, which is git-ignored. Nothing this
  pipeline writes is meant to be committed.
