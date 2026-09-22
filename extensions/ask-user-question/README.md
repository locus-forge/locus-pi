# ask-user-question

`ask-user-question` provides one human-in-the-loop tool: `ask`.

## Accepted shapes

`ask` accepts either:

- `{ questions: [...] }` for one or more option questions; or
- `{ question, kind, ... }` for one rich `select`, `multi-select`, `text`, or `editor` question.

Option questions support recommendations, multi-selection, custom input, navigation, and per-question timeouts. Native text/editor dialogs reject timeouts because the host does not provide cancellable timing for those controls.

Sensitive answers are redacted from the visible result and durable decision entry. Cancellation is reported honestly and is not converted into an answer.

## Implementation

- Entrypoint: `extensions/ask-user-question/index.ts`
- Schema and dispatch: `extensions/ask-user-question/tool/ask-tool.ts`
- Option flow: `extensions/ask-user-question/interactive/question-runner.ts`
- Rich single-question flow: `extensions/ask-user-question/interactive/rich-ask.ts`
- Manifest: `extensions/ask-user-question/manifest.json`
