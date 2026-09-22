# Repair one diagram section

You are S2, repairing a section file that failed to execute.

The workflow ran the file and collected the hard errors below. They are the real
output of running your section, not an opinion about it. Fix exactly those errors
and leave everything else alone.

## Errors from the last execution

--- BEGIN EXECUTION ERRORS ---
{{EXECUTION_ERRORS}}
--- END EXECUTION ERRORS ---

## How to repair

1. Read the current file at the path below. If no file is there, write it from
   scratch.
2. Change only what the errors name. Do not redesign the section, do not rename
   cards that were accepted, and do not add cards the brief did not ask for.
3. Rewrite the whole file; never leave a partial edit behind.

Common causes, in the order they usually apply:

- **Unknown icon id** — you invented one. Replace it with an id from the list
  below, exactly as spelled there.
- **`layout.<something>` is not part of the contract** — only `layout.node`,
  `layout.row`, `layout.column`, `layout.section`, and `layout.connect` exist.
- **`layout.connect` before `layout.section`** — build the cards, call
  `layout.section` once, then draw the arrows.
- **A missing declared export** — the returned object must map every declared
  name to a card and must export nothing else.
- **Numeric index** — use the name you gave the card, never `cards[0]`.
- **`import` / `require` / a `scene` method call** — remove it. `layout` and
  `scene` arrive as arguments and `scene` is only ever passed through.

## The shape the file must keep

```js
export default function buildSection({ layout, scene, title }) {
  const cards = layout.column(
    {
      someName: layout.node(scene, { title: "A card", iconId: "api_connector", bullets: ["what it does"] }),
      otherName: layout.node(scene, {
        title: "Another card",
        iconId: "historical_database",
        bullets: ["what it holds"],
      }),
    },
    { gap: 32 },
  );
  layout.section(scene, { title, children: [cards] });
  layout.connect(scene, cards.someName, cards.otherName, { label: "writes" });
  return { someName: cards.someName, otherName: cards.otherName };
}
```

## The only icon ids that exist

{{ICON_IDS}}

## Current task

Your section: `{{SECTION_ID}}` — {{SECTION_TITLE}}

What this section must show:

--- BEGIN SECTION BRIEF ---
{{SECTION_BRIEF}}
--- END SECTION BRIEF ---

Declared exports that must be returned: {{SECTION_EXPORTS}}

Rewrite this exact file, and no other file:

{{SECTION_PATH}}

Then return one or two sentences naming what you changed. The workflow re-executes
the file; the execution decides whether the repair worked.
