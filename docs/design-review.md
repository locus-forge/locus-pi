# Terminal UI design review

Use this checklist when changing Pi interaction or screen layout. Record observed findings separately from proposed fixes, and preserve truthful lifecycle semantics.

## Reusable evolving design-review questions

1. What is the screen's one primary job and user action now?
2. What should dominate: conversation and composer, navigation, or an actionable interruption?
3. Are transcript, input, status, background activity and command menus distinguishable at a glance?
4. Does every always-visible field help an immediate decision or action? Can it move to detail/help?
5. Is the same state repeated in tool output, start cards, notifications, footer and strip?
6. Are labels truthful: queued versus started, waiting versus working, idle versus closed, completion versus success?
7. Are identifiers readable without exposing raw IDs, full paths, JSON or internal prompts unnecessarily?
8. Does background streaming steal focus, scroll position, viewport space or typed draft?
9. At narrow width and larger terminal font, do input, essential status and the identifying filename survive?
10. Is empty/loading/blocked/error/completed state understandable, with next action where needed?
11. Are selection, status and keyboard focus distinguishable without relying on color alone?
12. Can users discover, enter, cancel and return using predictable keys without accidental destructive exit?
13. Is old/replaced UI or instruction text actually removed rather than duplicated?
14. Are active and historical data distinguishable, fresh and consistently counted?
15. Are repeated/concurrent launches, nested workflows and overflow tested with real terminal pixels?
16. Does the full-screen agent preserve the main interface contract (status, input, navigation) without showing background bleed?
17. Does the design retain essential failure information while hiding non-actionable technical noise?
18. What new failure did this review reveal, and which question/test should prevent recurrence?

## Bounded review gate for UI-changing PRs

- Before edits: capture actual-size current screenshots and record source snapshot, dimensions, scenario.
- Inspect idle, active standalone+workflow, nested/overflow, narrow, error/needs-input and history states as relevant to the change.
- Maintain issue ID, severity, evidence, smallest fix, owner, acceptance and status. Separate observation from hypothesis.
- After edits: compare same scenarios on exact final source; verify keyboard/resize/focus/scroll behaviors in terminal separately from pixel review.
- Block readiness on unresolved P1 visibility/focus/semantic-truth problems; document justified P2 deferrals explicitly.
- Record newly learned questions, avoiding endless generic checklist expansion. This gate runs on UI changes, not a recurring automation.
