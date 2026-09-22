---
title: TUI visual language
type: guide
status: active
updated: "2026-09-01T19:37:49Z"
description: Define the shared TUI selection palette, geometry, fallback, and ownership.
owner: locus-pi maintainers
tags: [tui, design, selection]
---

# TUI visual language

Locus uses color to explain interaction state, not to decorate every focused row. This guide is the cross-extension contract for selection, status, frames, and color-independent fallback.

## Semantic palette

| Meaning                                     | Treatment                           | Fixed color                          |
| ------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Active choice or current stage focus        | Purple fill with high-contrast text | background `#583d79`, text `#f8f1ff` |
| Active `SELECT` boundary                    | Light-purple frame                  | `#c4a7e7`                            |
| Saved or settled success                    | Host `success` foreground           | theme-owned                          |
| Warning, unset value, or required attention | Host `warning` foreground           | theme-owned                          |
| Supporting text                             | Host `muted` or `dim` foreground    | theme-owned                          |

Purple is not a general-purpose selected-state color. A stored model assignment remains green even when it is relevant to the current screen. An unset route remains yellow. The purple treatment identifies the control the operator can change now.

## Selection geometry

### Horizontal choices

Mutually exclusive choices arranged left to right use compact purple pills. Current examples are the Project, User, Package, and History sources; the workflow source action bar; and the provider filter in `/model-roles`.

Inactive choices stay plain or dim. Labels keep brackets or the `›` marker so the choice remains visible when ANSI is unavailable.

### Staged vertical choices

A filled vertical row is exceptional. It is used when the row is the main choice inside a staged selector, currently `/model-roles`.

That selector moves one strong row focus through three stages:

1. the selected model row;
2. the selected role action;
3. the selected effort level.

When focus advances, the earlier choice remains readable context without a second cursor or filled row. Other vertical lists keep their existing caret and accent treatment until their own live design review accepts a stronger focus model.

### Selection frames

An interactive `SELECT` operator block uses the light-purple frame. `INPUT` keeps the host accent frame. Passive, result, warning, and error blocks retain their existing semantic frame behavior.

## Color-independent fallback

Color must never be the only signal. Active horizontal labels keep brackets. Active rows keep `>`. Surface headings retain `[SELECT]`. A host without a callable theme receives the same text and geometry without ANSI escapes.

## Ownership

`extensions/_shared/operator/operator-ui.ts` owns the fixed selection palette, ANSI construction, plain fallback, and `SELECT` frame. Feature components own state and geometry: they decide which label is the active horizontal choice and which row owns the current stage focus.

This split prevents a generic renderer from guessing product semantics. It also prevents feature components from copying raw color sequences.

## Review checklist

- Does purple identify an active choice or current stage focus rather than a saved status?
- Does a staged selector show one primary row focus?
- Do green and yellow retain success and warning meaning?
- Do brackets, `>`, and `[SELECT]` survive without color?
- Do active labels remain readable at narrow widths?
- Does the component reuse the shared selection renderer instead of copying ANSI codes?
- Does a real Pi TUI capture confirm the theme and interaction behavior?

## Code touchpoints

- `extensions/_shared/operator/operator-ui.ts`
- `extensions/workflows/catalog/catalog-viewer.ts`
- `extensions/model/model-role-selector.ts`
