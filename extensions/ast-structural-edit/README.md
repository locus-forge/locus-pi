# ast-structural-edit

`ast-structural-edit` provides a preview-first structural search and edit lifecycle.

## Surface

- `ast_grep` searches supported source trees structurally.
- `ast_edit` prepares replacements and records the hashes of every source file it read; it does not write source files.
- `resolve({ action: "discard" })` removes a pending preview.
- `resolve({ action: "apply" })` rereads all affected files and refuses the entire apply when any saved hash is stale.

After the stale-file preflight succeeds, writes occur file by file. This prevents applying a preview to changed input, but it is not an operating-system transaction with rollback after a mid-write failure.

The parser comes from `@ast-grep/napi` and `@ast-grep/lang-python`. Locus owns project-root confinement, schemas, preview state, stale checks, and Pi approval metadata.

## Implementation

- Entrypoint: `extensions/ast-structural-edit/index.ts`
- Search: `extensions/ast-structural-edit/ast-grep.ts`
- Preview and apply: `extensions/ast-structural-edit/ast-edit.ts`, `extensions/ast-structural-edit/resolve.ts`
- Manifest: `extensions/ast-structural-edit/manifest.json`
