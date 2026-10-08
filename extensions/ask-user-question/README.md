# ask-user-question

`ask-user-question` provides one human-in-the-loop tool: `ask`.

## Accepted shapes

`ask` accepts either:

- `{ questions: [...] }` for one or more option questions; or
- `{ question, kind, ... }` for one rich `select`, `multi-select`, `text`, or `editor` question.

Option questions support recommendations, multi-selection, custom input, navigation, and per-question timeouts. Native text/editor dialogs reject timeouts because the host does not provide cancellable timing for those controls.

Rich questions marked `sensitivity: "secret"` redact their answers before the public result, Pi decision entry, or JSONL decision journal is produced. This applies to text/editor, selected options, and custom answers from single- and multi-select. Collection does not write provisional answers: each completed question is finalized once, after navigation ends. A cancelled batch records only the cancelled question; superseded, unavailable, or failed prompts write no decision.

Outcomes distinguish `answered`, `timed-out`, and `cancelled` in the result and both decision journals. Results expose `timedOut` and `answerSource`; decision metadata carries the same provenance:

- Explicit answers use `answerSource: "human"`
- Legacy `{ questions: [...] }` timeouts retain the recommended/first option (or current multi-selection), with `status: "timed-out"` and `answerSource: "automatic"`. The result text and card identify the automatic completion; it is not human approval
- Rich select/multi-select timeouts auto-cancel: `status: "timed-out"`, `timedOut: true`, `cancelled: true`, `answerSource: "none"`, and no answer value or journal answer
- Cancellation has `status: "cancelled"`, `answerSource: "none"`, and no journal answer

Older decision records remain readable, but their missing provenance cannot establish an explicit human answer. Rich multi-select custom input is returned as a one-item `value` array.

## Implementation

- Entrypoint: `extensions/ask-user-question/index.ts`
- Schema and dispatch: `extensions/ask-user-question/tool/ask-tool.ts`
- Option flow: `extensions/ask-user-question/interactive/question-runner.ts`
- Outcome finalization and decision journals: `extensions/ask-user-question/interactive/human-control.ts`
- Rich single-question flow: `extensions/ask-user-question/interactive/rich-ask.ts`
- Manifest: `extensions/ask-user-question/manifest.json`
