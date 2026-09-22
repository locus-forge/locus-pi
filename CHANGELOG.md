# Changelog

User-visible changes to the public package.

## [Unreleased]

## [0.9.0] - 2026-09-21

### Changed

- `task/plan` now grows one complete workspace `workflow.mjs` through at most six
  accepted source slices. The owner re-cuts the remaining graph queue after each
  slice. Independent mechanical and design checks gate acceptance, with one
  cumulative `fix` per slice and explicit failure evidence when work remains.
- The checked `task/plan` result is the exact workspace file exposed through
  `primaryFile` with its path, size, and digest. Consumers of the previous primary
  artifact or `outputs/workflow.mjs` must use that file reference instead.
- Workflow authoring and launch skills preserve the user's default model and
  effort unless the user or project requests a routing override.

### Fixed

- `task/plan` no longer accepts verifier prose as workflow source. Source-check,
  workflow, and Fusion errors retain their failure flag and diagnostics; CLI
  children no longer inherit an implicit five-minute process deadline.
- Mechanical and design source fixes use the same `fix` choice, stage names, and
  independent recheck evidence. The one-fix allowance and existing failure result
  remain intact.

## [0.8.0] - 2026-09-20

### Changed

- Agent and workflow terminal rows now show `thinking` only when the Pi host
  confirms the applied value, including success, failure, and cancellation
  results. HTML transcript documentation now describes export as opt-in rather
  than a default side effect of every child run.
- The packaged workflows manifest and authoring guidance now state the mode-scoped
  launch defaults consistently: every run defaults to `concurrency = 4`; headless
  Pi `print`/`json` root launches additionally default to `totalAgents = 10_000`,
  shared across fresh child attempts made by the root, saved children and Fusion;
  TUI/RPC leaves `totalAgents` unbounded, as are all other undeclared workflow
  budget axes. Runtime behavior is unchanged.
- Workflow documentation now ships as a topical manual under `docs/workflows/`.
  Budgets, agent results, DSL, replay and recovery each have a named owner;
  workflow skills link to those pages and explain how to find them through an
  installed skill symlink. Old reference paths retain bookmark anchors, and
  package tests verify the documentation from an unpacked npm tarball.
- Workflow runtime responsibilities now live in named modules for execution state,
  agent calls and attempts, shaped returns, model routing, and run lifecycle. Existing
  module export paths remain available. `check:push` now checks size growth against
  the base branch, with owned exceptions and revisit triggers recorded in the
  topology configuration.
- Structured workflow results are now carried only by same-session acceptance. The
  text-parsed transport is deleted: the runtime no longer appends a shape block to
  the prompt, parses the child's final message as JSON, or spawns a fresh child to
  repair a format. `choice`, `handoffs`, `output` and `schema` all submit their value
  through the `workflow_return` tool in the session that produced it, and `validate`
  works there too. A host that cannot register that tool and read its active tool set
  back now refuses a shaped call **before the child starts**, naming the missing
  capability, instead of silently falling back to text. A model whose transport is
  known not to host Pi tools at all — the Claude Code CLI adapter, which forwards no
  tool allowlist — is refused at the same point, by capability rather than by vendor
  name, so a shaped call on that route costs nothing. Plain text calls on it are
  unaffected.
- `returnVia` is no longer a decision: `returnVia: "tool"` is accepted for one release
  and journaled as redundant and ignored; `returnVia: "text"` is refused by name.
  Plain `agent(prompt)` still returns the child's exact full text, unchanged.
- The runtime stopped rejecting answers for their size. `agent({ maxAnswerChars })`
  and the `answerChars` budget axis are removed and refused by name, with the error
  naming the consumer contract to declare instead (`output.maxLength`, or `maxLength`
  / `maxItems` inside a `schema`). A `maxLength` now has no package default: declare
  one only where a consumer really has a limit, and the child is told about it and can
  correct the value in the same session.
- Shaped declarations lost the invented ceilings they never needed: `choice` accepts
  any number of options of any length (minimum 2), `handoffs` treats `maxItems` as an
  optional consumer declaration and refuses `maxItemChars` by name, a `fusion` panel
  keeps its 2-member minimum with no member/judge/prompt character caps, `attempts` is
  any positive integer, a `validate` callback's error list is checked for type rather
  than size, and workflow input and display titles are no longer length-limited. The
  same went for the surrounding tool surfaces: the `/fusion` tool's question, context
  and output fields and the `task` tool's instructions and inline parent context are
  bounded only by being non-blank, and a continuation may carry as many complete
  artifact refs as its origin run produced rather than the first eight.
- Shaped calls state their correction budget instead of hiding it: the package default
  is exactly one same-session clarification turn, `repair.maxAttempts` raises it with
  no upper bound, and every shaped call journals the applied number and whether it came
  from the package or the author.
- The shaped return contract is versioned, and this release is v2. A replay record
  written under v1 is reported as `return-contract-changed` — named as a release
  boundary in the journal — and that call runs fresh, instead of being blamed on the
  script as a key mismatch.
- **Replay boundary for runs recorded before this release.** Removing the package
  budget defaults changed what a request IS: `timeoutMs`, `toolCalls` and `turns`
  are part of every call's canonical request key, and a call that inherited the old
  `86400000` / `1000` / `1000` now carries `null` on those axes. So a run recorded
  before this release re-runs from its FIRST agent call — plain text calls included,
  not only shaped ones — unless it declared each of those budgets explicitly, in which
  case its keys are unchanged and it replays as before. The miss is reported by name at
  the call where it happens; no historical key is recomputed, no historical record is
  rewritten, and a call recorded as failed is never turned into an accepted one.

- Workflow text artifacts no longer carry a 2 MiB runtime ceiling: a text artifact
  is written, read and consumed at whatever size it is, and a write that cannot be
  stored reports the real storage error. Artifact names became display labels
  (any non-path text) with `artifactId` as the storage identity.
- `artifactRefs` in `result.json` stays a newest-20 display projection, but it no
  longer decides what may be consumed. `consumeTextArtifact()` and operator
  handoffs resolve any artifact of the source run through its full verified index,
  so an artifact older than the newest twenty stays usable.
- Operator handoffs no longer cap the number of questions, options or continuation
  references, nor the length of a title, prompt or option label; `workflow_ask`
  likewise dropped its 10-questions-per-call limit. Identity, types, uniqueness,
  confinement and reference verification are unchanged, and questions are still
  served one at a time.
- Child agents no longer inherit an invented budget: the shared runner stopped
  defaulting `maxTurns` to 5, and the SDK host stopped deriving a wall clock of
  120 seconds per turn from it. A caller that wants a stop passes one; the
  interactive `task`/`spawn_agent` and `/agent run` surfaces now declare the same
  one-hour runtime at their own call site, with no turn or tool-call limit.
  Requests without a declared turn budget record it as `unbounded`.
- Execution budgets follow one [documented policy](extensions/workflows/REFERENCE.md#run-budget).
  Headless (`print`/`json`) root workflows default to `totalAgents: 10_000`, shared
  with saved children; concurrency remains 4. Explicit numbers override defaults,
  with raises journaled. Other undeclared axes remain `unbounded`. Every run opens
  with one header line naming all six axes — an undeclared one reads `unbounded` —
  and the journal, `result.json` and the run report print the same word, so a
  headless launch cannot mistake absence for a number. Declare a budget on the
  `workflow` tool, the command launcher or the individual `agent()` call.
- Reaching an explicit budget is journaled as `stopped by budget <axis>` with every
  answer already received kept and readable. A budget stop is never reported as a
  wrong or invalid answer, and the axis is checked before the next spend, so the
  child that would exceed it never starts.
- `/workflows status` and the run detail block print the applied budget of a finished
  run. The `budget` envelope has been written to `result.json` all along, but nothing
  read it back, so the "budget applied" line never appeared; it now names every axis,
  an undeclared one as `unbounded`, and a malformed envelope is reported as malformed
  instead of rendered as half a budget.
- Replayed calls no longer consume `totalAgents`. A `--resume` projects recorded
  answers without calling a model, so it can no longer die on a cap its original run
  satisfied; the run report counts fresh and replayed attempts separately
  (`N fresh + M replayed (not charged)`).
- One concurrency width instead of two. `parallel()`/`pipeline()` groups take the
  run's effective `concurrency` (package value 4) rather than a separate hidden
  width of the same size, so narrowing the visible number now narrows group fan-out
  too. A local width still applies when the author passes one explicitly.
- A child gets ONE deadline. The declared `timeoutMs` reaches the SDK host unchanged
  instead of being divided by the turn count, widened by a per-turn margin and
  multiplied back — arithmetic that produced a deadline nobody wrote and, with the
  former defaults, a product larger than Node's maximum timer delay, which
  `setTimeout` answers by firing after one millisecond. `ask: true` no longer adds a
  hidden 24-hour allowance: the deadline is wall clock and includes the operator's
  wait, and the wait is recorded in the call's diagnostics.
- A long explicit timeout is honoured rather than refused. Deadlines above Node's
  maximum timer delay run as a chain of representable waits, so a 48-hour timeout is
  a 48-hour timeout; the `WORKFLOW_MAX_TIMEOUT_MS` policy ceiling is gone and
  representability is checked only when a timeout was actually chosen.
- Unknown cost is reported as unknown. `costTotal` is omitted rather than reported as
  `0`, and run evidence prints `cost=unavailable` instead of `$0.0000`. Observed
  token usage is unchanged and still recorded.
- A child granted `tools: ["*"]` now records the tools that remain excluded
  (`spawn_agent`, and the stock `ask` for workflow children) in its run receipt,
  so "all tools" is never an unqualified claim.
- Opt-in agent context extras (`LOCUS_AGENT_CONTEXT_EXTRAS`) pass the selected
  memory and skill files whole instead of clipping them to 200 lines and 16 KiB.
  A large selection adds a visible size note instead of a silent cut.

- A tool-free Fusion panel can now carry a shaped judge. Tool-free means the child
  cannot act — no host tools, no extensions, no skills — and the `workflow_return`
  receipt is not an action, so it stays registered and nothing else does. Before, it
  was cleared with everything else, and a panel with a `schema` ran every member and
  then failed its judge for a transport question that was answerable at the start.
- Explicit `toolCalls` and `turns` budgets are now checked before the next action
  instead of after it. The tool call that would exceed the budget is refused before it
  executes and the generation past the last declared turn is never started; the run
  still ends with the same named budget stop and keeps everything already produced. On
  a host that does not expose the admission seam the previous behaviour remains.
- A finished agent run whose result envelope could not be stored is reported as a
  storage failure instead of `done`. The three notions stay apart: the execution
  outcome is kept beside the storage error, and the answer the child produced travels
  with the failure — `/agent run` shows it on the row, and `spawn_agent` returns it
  under the failure — instead of being lost with the record.
- Artifact display names are readable by every reader. `name` is the author's label and
  `artifactId` is the storage id, so a published `Design review.md` now passes the
  `result.json` reader and the `workflow` tool's continuation parameter, which still
  demanded the storage alphabet and 128 characters. Path separators, control characters
  and blank names are still refused.
- Parent context reaches the child whole. `task`/`spawn_agent` no longer clamps the
  selected context to 16 KiB with a truncation marker — that is the child's input, not a
  display projection — and a large one adds a size note to the run receipt instead.
- `agent({ schemaMaxLength })` is refused by name at the DSL boundary. It was dropped
  while the return contract was assembled, so the call ran and the author kept believing
  a ceiling applied; the error names the consumer contract to declare instead.
- The curated `consilium` reference workflow stopped measuring its own question, and
  aggregate character caps on paths are gone: `outputDir`, `scriptPath` and `script` are
  bounded by confinement and by the filesystem's own limits rather than by 400
  characters.
- A `fusion()` panel served entirely from the replay record no longer reserves or spends
  `totalAgents`. A resume can replay a three-member panel under `totalAgents: 1`, and a
  panel that runs fresh reserves its worst case exactly as before.
- The Claude Code adapter keeps the text a run had already streamed when a timeout or an
  abort cuts it short. The message stays a failure with no content, and the fragment is
  carried in the run diagnostics as `partialResult` with `completeness: "streamed"` and
  the code that interrupted it, beside the existing `complete` case for an answer whose
  storage failed.

- Clarify full-tool defaults across external workflow transports: reviewer roles retain shell/git and report writing, and technical tool failures are repaired before another review attempt.

- Agent and workflow failures now have a bounded project error index with exact evidence pointers. Failure cards and workflow receipts retain the actor, cause and diagnostics even after a handled failure or successful retry; workflow skills share a short diagnosis and repair route.

- Added opt-in plain-text agent execution reports so eligible failed reviewers can reach an arbiter while fatal controls and replay failure records remain intact.
- Separated specification and implementation authoring, clarified ambiguous workflow goals before building, and gave both adaptive references repeated correction with truthful remaining-work handoffs.
- Clarified workflow decision ownership: an arbiter may return its branch directly; a separate translator copies its explicit decision without adding owner-approval conditions or treating missing context as a failed review.

### Fixed

- Workflow artifact writes now reject an existing symlink destination before
  writing, so a prepared path cannot redirect output outside its run directory.

### Removed

- **Breaking:** Removed the unused beta `plan`, `loop`, and `todo-context`
  extensions, their commands and tools, and the beta activation tier. The
  packaged `task/plan` workflow and the `plan` model role remain available, and
  existing user files are not deleted or migrated.
- Removed runtime recognition of legacy `todo_write` session records. Existing
  JSONL files remain untouched; the loader skips that unsupported record and
  continues reading supported records around it.

## [0.7.3] - 2026-09-10

### Changed

- Documented the planned two-workflow authoring model: produce a specification first, then author implementation from its actual artifact. The guide explicitly distinguishes repairable findings from blockers and marks the example changes and live proof as pending.
- Substantive workflow authoring defaults to adaptive slices with outcome-led briefs, folder-level task context, cumulative slice bounds and independent correction checks. Design/implementation references and a procedural alternative show each style.
- Workflow authoring is now discoverable in docs/locus-pi-workflows.md. The former AUTHORING.md is split into a short installed-skill boundary, a runtime source contract and a separate rationale reference.
- Standard source checking permits whole handoff-list carry in bounded loops while preserving opaque item provenance. Scheduling, model routing and continuation APIs remain unchanged.

## [0.7.2] - 2026-09-09

### Changed

- Internal module ownership now matches the dependency graph, with no change to commands, tools, workflows, stored file formats, dependencies, or permissions. The workflow DSL core reaches operator-handoff and result semantics only through filesystem-free contract modules, the shared live agent store and the workflow live projection each own their module instead of living inside the SDK session executor and the durable run journal, and the bounded workflow metadata scanner is loadable without the catalog surface. A new repository check fails when a module declared filesystem-free regains such a dependency.

- The repository workflow source checker now accepts `--mode orchestration-only`
  for exact workflow paths, exposing the same strict authoring validator outside
  a Pi child session without importing or running the target. The workflow
  authoring skill uses this command as its supported fallback when the Pi-native
  `workflow_check_source` tool is unavailable and still fails Build when neither
  route can run or validation fails.

## [0.7.1] - 2026-09-09

### Changed

- Workflow authoring now accepts a task folder as the durable root: `--output-dir .tasks/<task>/artifacts` is a valid workflow workspace, `AUTHORING.md` gains "Stage refusal and fix loops without throw" for a bounded gate that returns `{ ok: false, status }` instead of throwing, and records that rule as decision `D-2026-09-09` alongside the new `stage-loop` Package example.

- Workflow guidance now keeps durable handoffs, final results, review evidence, and explicit resume inputs in the stable workflow workspace while disposable environments, dependency caches, test basetemp, transient renderer output, and staging use ordinary OS or tool temporary and cache locations. Final renderer assets are promoted before scratch expiry, existing Mac fn+Up / fn+Down history hints remain discoverable, and nested workflow_return string values stay readable without changing retained values.

- Workflow repair guidance now distinguishes a legitimate quality refusal from a broken gate. Scoped correction retains existing authorization and valid completed work, then requires fresh independent review and the unchanged quality gate with current evidence; no automatic retry loop is added.

- Workflow review guidance now requires an accessible evidence entrypoint, preserved baseline identity and complete changed-file coverage. Reviewers follow existing readable diff locators before declaring an archive/tool blocker; missing representations are prepared by a tool-capable owner without broadening read-only access or weakening acceptance.

- Workflow CLI-provider children receive the declared call timeout instead of Pi's implicit HTTP idle timeout. Explicit shorter request/settings limits and cancellation still apply; HTTP provider defaults and saved settings are unchanged. Normal Pi shutdown now waits for cancelled workflow runs to persist terminal results before exiting. External-session guidance checks autocomplete dismissal and actual stop dispatch.

- Workflow authoring and launch guidance now verifies the resolved provider, adapter and authentication mode when subscription-backed execution is required. Provider key-limit failures are distinguished from output-contract limits; recovery preserves completed work without a silent paid-API fallback or financial-limit change.

- Added the `external-locus-pi` skill for Codex and Claude Code. External launches default to an interactive Pi session retained by a terminal supervisor, with a manual attachment command and native workflow evidence. The workflow skill installer manages all three skills; JSON print mode remains an explicit non-interactive option.

- External workflow guidance now uses supervised long-running Pi processes with retained exit/signal evidence. An orphaned child requires current-state reconciliation; a verified terminal ancestor can then supply a reusable prefix for a fresh recovery branch. Missing terminal records remain missing, and interrupted-recovery admission is unchanged.

- Recovery after an authorized checkpoint distinguishes content from HEAD/index changes and retains the original step baseline archive for full-step review. A clean post-checkpoint Git diff is not proof that the implementation made no changes, and the checkpoint is not acceptance.

- Workflow authoring distinguishes environment preparation from implementation. After a scoped environment repair, implementation continues; baseline tests do not prove the feature is done. Recovery requires a concrete unresolved blocker or the actual resource-stop reason, without weakening acceptance or adding automatic retries.

- Repair guidance now audits the entire unfinished workflow suffix for repeated narrative-wrapper mistakes while preserving completed-call identity and existing semantic gates. An array example is a correction aid, not proof that a model will submit the required shape.

- Workflow failure diagnostics now link to the failed child's persisted result or transcript instead of borrowing the previous successful answer. Missing or ambiguous child evidence leaves the journal as the diagnostic entry point; rendered pointers use `evidence:`.

- Workflow tool-return corrections now show raw array/object argument syntax, so a JSON-encoded string is not mistaken for the required value. The agent corrects its existing content in the same session; strict validation, attempt limits, and initial replay-key bytes remain unchanged.

- Workflow children now default to 1,000 cumulative SDK model cycles, with explicit `maxTurns` overrides above the former 20-cycle ceiling. Normal tool use and output clarification share this limit on both text and tool-return paths. Computed timer overflow is rejected before a child starts; other budgets remain unchanged. Resuming an older run requires retaining each completed call's recorded turn allowance so its replay key remains valid.

- Workflow authoring now starts from the agent's task, context and definition of done. Ordinary reports return plain text; shaped results and author-selected limits require an actual consumer or user requirement. Independent discovered work units may declare a larger `handoffs.maxItemChars` without another arbitrary ceiling. Runtime derives room for JSON escaping and rejects arithmetic overflow before starting a child. Existing small contracts keep their replay identity; same-session repair and outer execution budgets remain unchanged.

- Text workflow choices now ask for one of the allowed JSON string values instead of showing an enum schema that agents can echo without choosing. Validation still rejects schema-only answers. Workflow authoring guidance selects same-session `returnVia: "tool"` after commands or file writes; simple narrative calls stay unchanged. The new text-choice prompt changes replay identity for those calls. The authoring skill also requires readable per-item agent titles, with mapped-row display covered through the runtime, SDK bridge, fleet renderer, and drill.

- `agent({ returnVia: "tool" })` now also accepts `schema` (a validated object) and `handoffs` (a bounded list of complete strings) through the same `workflow_return` tool: an agent that did the work but returned the wrong shape corrects it in the same child session under the existing `repair.maxAttempts`, and the workflow receives the validated value instead of text. Choice and closed-string contracts, one session, commit-on-completion and replay identity are unchanged; `validate` and transport `attempts` still do not combine with tool return. A correctly shaped record is not evidence that its facts are right.
- The workflow-create skill gained two cards. Repair + Continue explains fixing the stopped `.workflow.mjs` in place, keeping the labels, prompts and order of the completed prefix, and proving reuse from `replayedCalls` and `divergedAtNode`; it names the limits, including the strict prefix, `unnamed-node`, the fusion tail, and the `totalAgents` fuse that replayed answers still spend. Large agent runs states that hundreds of small calls are a legitimate graph, observed through `/ps` and `/workflows status` and stopped only on operator request, with no new cap. The workflow-run skill now opens with preserving completed work before starting over, says that crossing the `totalAgents` fuse on a continuation needs an explicit operator `budget` override, and points `--run-name` at `.locus-pi/workspaces/<name>`.

## [0.7.0] - 2026-09-07

### Changed

- Workflow authoring now has one short router and four explicit forms: fixed graph, bounded refinement, bounded decomposition and split-run human continuation. The source checker admits narrowly bounded whole-value carry and author-owned record fields without making model output inspectable. Runnable examples and negative contract fixtures accompany the change.
- Opt-in `agent({ returnVia: "tool", choice })` or a closed string `output` uses a workflow-only `workflow_return` tool. Invalid/missing submissions receive bounded clarification in the same child session; cumulative child budgets, cancellation and provider failures remain authoritative. Legacy exact text and fresh-session schema repair keep their existing behavior.
- `parallel(thunks, { concurrency, keys, title })` accepts explicit local width and full business-key identity while retaining the global leaf-agent gate and input result order. Agent titles, branch-local phases and distinct queued/start journal events improve inspection. The structured workflow tool exposes the existing shared budget and records validated/fallback choice origin.
- Explicit `recoverInterrupted` adds conservative admission for a fully confirmed serial prefix after missing terminal publication, using root launch bindings and strict replay. It refuses uncertain effects, changed input/source/budget, grouped execution and corrupt results; ordinary Repair + Continue is unchanged. This is not an exactly-once side-effect guarantee.

- Each workflow launch now has one shared folder with a README and a workspace link: saved children live in `children/<runId>/`, and resume attempts in `attempts/<runId>/`. The workspace receives backlinks in the runtime-owned `.workflow-runs.md`. Each execution stores a separate ID and receipt; status, artifacts, replay, and resume locate nested and former flat history without migration. Independent launches in one session are not merged, and `lineage.rootRunId` retains the meaning of the current attempt's root.
- The history listing includes root, attempts, and saved children; `last/latest`, loop source, and stop completions ignore saved children. The group README and workspace backlink are written atomically and durably only under the root lease.
- Workflow documentation and generated navigation now use English; existing Russian workspace backlinks are validated and rewritten without losing links when next updated under the root lease.
- TUI selection now has one documented visual language. Horizontal source, provider, and action choices use the same high-contrast purple fill; interactive `SELECT` blocks use a purple-family frame; and `/model-roles` moves one strong focus from model to role to effort instead of leaving several selected rows on screen. Saved assignments remain green, warnings remain yellow, and plain hosts retain brackets and cursor markers without ANSI.
- Saved workflow names now resolve only from the nearest project `.locus-pi/workflows/`, then user `~/.locus-pi/workflows/`, then Package. The old `.pi/workflows/`, `.claude/workflows/`, and `.agents/workflows/` directories no longer participate in saved-name discovery. Catalog copy, authoring guidance, persisted source validation, and generated-workflow handoff now use the same canonical root; existing old files are not deleted.
- A workflow that stopped at one node can now be repaired in the same file and continued from that node. `--resume <runId>` (tool: `resumeFromRunId`) no longer requires unchanged source bytes: the nodes that already completed return their recorded answers and do not execute again, while the repaired node and the tail after it run fresh. Each recorded agent call carries a `node` name — `[phase, label, occurrence]` — so the run's `runtime/replay.ndjson` says which nodes finished, and the `replay` envelope of `result.json` adds `divergedAtNode`, the node where continuation became fresh. The refusal that used to fire whenever the source bytes differed is gone from the reason list; instead a call the record cannot name, or that the author never labeled, misses with `unnamed-node` and takes the rest of the run with it. Any miss now ends reuse for the remainder of the run, which also means a `fusion()` group standing after that point ends the run with `fusion resume cannot mix recorded and fresh agent calls` instead of running a fresh panel, and a byte-identical resume no longer replays a fusion tail that stood after a recorded failure. The strict `orchestration-only` source check now requires every `agent()` call to declare a unique literal `label`, and the workflow-run skill's recovery procedure has two outcomes, `continue` and `refuse`.
- Project-local locus-pi data now has one readable layout: workflow workspaces use `.locus-pi/workspaces/`, authored `/plan` documents use `.locus-pi/plans/`, run evidence stays under `.locus-pi/runs/`, and saved-child checkpoints stay under `.locus-pi/workflow-state/`. Existing named workspaces keep their old physical path and checkpoint identity; conflicting old/new paths fail closed. Legacy home plan files migrate by verified atomic copy and are never deleted automatically.
- New workflow `result.json` envelopes no longer duplicate the full journal. They keep bounded typed finalization errors for late failures that must survive a best-effort journal write. Live operator answers are indexed, digest-verified run artifacts, and an evidence write failure aborts the child call instead of returning an unrecorded answer.
- Manual workflow loop continuation now returns the exact continuation prompt directly and no longer writes a separate `.locus/runtime/loop/workflow/*.json` file.
- Model roles now have one persistent authority: `~/.pi/agent/model-roles/config.json`. `/model-roles` reads and writes that global user file. Project `.pi/model-roles/config.json`, `settings.json#modelRoles`, and session evidence no longer override it.
- The Package `task` namespace now has one explicit handoff: `task/draft` publishes an editable brief with the graph pattern, agents, handoffs, review bounds, concurrency, failure exits, and primary output; `task/plan` consumes the accepted text and directly publishes a checked `workflow.mjs`.
- The workflow-create skill now authors orchestration-only JavaScript. New workflows may contain visible prompts, agent calls, DSL control flow, and text publication, while project inspection and file work belong to child agents instead of workflow-side file, path, or artifact-reading primitives. Its Build step uses a strict `workflow_check_source` mode; the default compatibility mode still validates existing reviewed workflows.
- Escape from an agent drill opened through `/ps` now returns to `/ps` on the row it was opened from instead of to the editor, and the fleet re-reads its membership on the way back, so agents that arrived during the drill are there. `q` still leaves the agent surface for the editor, and a drill whose row retired while it was open hands the editor back rather than reopening a fleet nobody asked for.
- The workflow progress panel below the editor now shows the run tree instead of a flat list of agents. A fan-out contributes its group heading with the `k/n done · f failed` counters `/ps` already showed, its members read working first, then failed, queued and done, and a group of one keeps its agent and drops the redundant heading. Both surfaces run the same projection, so a run looks the same in the panel and in `/ps`; only the panel collapses anything, because in `/ps` every leaf has to stay reachable by the cursor. Declared stages the run has not reached yet now share one `○ next: <title> (+k planned)` line, unless a single stage is left and keeps its full reading.
- Agent and workflow live trees now draw full recursive branch rails (`├─`, `└─`, `│`) through group, agent, latest-message, and tool-activity lines instead of flattening every child to `↳`.
- The agent screen opened by `/ps` or `/agent drill` now says where the agent is and whether it is alive. Its header names the workflow run, the stage, the enclosing group and the agent, read from the live rows and the run journal rather than from anything the agent wrote; beneath it one status line carries the state icon and word plus how long the work has been running, refreshed once a second and frozen with the rest of the surface in calm rendering. The footer drops `STATUS:` and carries controls only. A row outside a workflow keeps its short one-line heading.
- The agent screen no longer turns on terminal mouse tracking in Pi's regular mode. The wheel and the host terminal's own scrollback stay with the terminal, and the screen's history moves on PageUp/PageDown/Home/End. `LOCUS_DRILL_MOUSE=1` restores the previous wheel capture, and the footer offers `wheel` only where the screen captures it. In Pi fullscreen the screen writes no mouse sequences at all and leaves wheel reports to Pi; a host that supplies a terminal wrapper without a mode is treated the same way, so the variable has no effect there. In fullscreen the history keys are consumed by Pi's own viewport before any component sees them, so the footer there promises no history control at all rather than a key that does nothing.
- The reply box on the agent screen is now Pi's editor component mounted whole, with its own frame and its own key hints, instead of four of its parts with a hand-written `↵ send` hint that named keys an operator's keybindings may never have had. That costs height: the smallest terminal that still offers input is 18 rows rather than 9, and below it the screen says `resize terminal for input`. Once the editor is on screen it is not taken away mid-sentence — the body gives up its rows first.
- A workflow now refuses a second `agent()` call that would occupy a `(phase, label)` slot another call of the same run is still executing, and the refusal names the phase and the label. One slot is one live row and one journal correlation key, so two concurrent occupants collapsed two branches into a single line. Sequential re-entry of the same slot — the loop round `r<N>` — is unaffected; the claim is released on failure, abort and run deadline alike; and a call without a label anchors no slot.
- Mapped `parallel()` and `pipeline()` members can now invoke the same labelled `agent()` callsite concurrently. Each member receives a runtime-owned live-row occurrence, while authored phase/label values, sequential rounds, replay node identity, and the refusal for true duplicate callsites stay unchanged.

### Fixed

- **Workflow agents preserve the runtime lease and sibling handoffs in shared
  workspaces.** Every child task now states that an instruction to write one
  assigned artifact forbids extra writes but never authorizes cleanup. It
  explicitly protects `.locus-pi-workflow.lock` and pre-existing workflow
  files. This prevents a compliant child from deleting the parent's live lease
  or an operator's `style.md` before the next stage starts.

- **Historical post-code reviews no longer attribute descendant policy to the
  reviewed commit.** Scope, boundaries, contracts, necessity, and synthesis
  now keep the base tree, frozen target tree, and current checkout distinct. The
  final verifier rechecks decision-critical positive and `NO_ACTION`
  architecture claims as well as retained defects. Agreement between earlier
  lanes therefore cannot turn a config key added later into evidence that the
  target already admitted a dependency edge.

- Keep the newest streamed assistant text and external CLI progress visible in agent previews instead of truncating away fresh activity. Completed reports retain their opening.

- A fan-out's group heading now counts up while the run is still going. The heading read its `k/n done · f failed` from fields the journal writes only when the group ends, so a nine-member fan-out sat at `0/9 done` until it settled, next to a panel header that was counting correctly. Both surfaces now fold the members' own states into the heading, and a group that reported its own final numbers still wins.
- The group heading no longer disappears from `/ps` once a fan-out is taller than the list's window. The window was anchored on the cursor, and only members take the cursor, so the heading fell out with no key able to bring it back. The nearest heading is now pinned above the window without costing a member row.
- Home and End work on the agent screen in every terminal. The screen matched only the bare key names and one of the three encodings a terminal may send, so in a multiplexer pane both keys did nothing while the manual promised them.
- The agent screen keeps its footer in Pi fullscreen. At full height the screen asked for every row but Pi's status line, and the transcript view refused to give up its last row, so the line carrying `esc close` was clipped off the bottom. Fullscreen now buys the footer with one line of transcript.
- The `message queued` notice no longer outlives the child that could have answered it, and the footer offers the wheel wherever the screen actually captures it rather than only beside an open reply box.
- At normal interactive heights, `/workflows list` now keeps its Project, User, Package, and History tabs at one stable position below the heading instead of moving them with source content height. The existing few-line compact projection is unchanged. Wherever tabs are shown, the active tab has a high-contrast purple background. Parent descriptions now start one column to the right of the child's `└` branch, so each description remains visually attached to its parent.
- A failed run's diagnostic now points at the failing stage's answer file with a path that opens. It was built by joining the artifact's own relative path onto the run directory, which dropped the `runtime/artifacts` segment and produced a pointer to a file that does not exist.
- Live workflow rows no longer fall off the progress panel once finished fan-outs fill it. The roster used to collapse the first settled entry, which a group heading never was; with nothing left to collapse it cut the tail instead and took the running group, its working agents and the pending stage line off the panel, while the finished rows stayed. It now gives up the most expendable settled entry first, so working rows and a live group's heading survive, and a collapsed heading is announced as `(+N earlier groups)` instead of disappearing.

### Removed

- Removed the generic `implement`, plan-template renderers, `task/substep`, and `workflow-creator` Package workflows. The concrete result of the authoring path is now the generated `workflow.mjs`, not another universal execution stage.
- Removed the obsolete `locus-pi-workflow-implement-task` skill; workflow skill sync now owns only create and run.

## [0.6.2] - 2026-08-31

### Changed

- The workflow-run skill now explains how to inspect Pi's available models, persistent settings, hard allowlist, one-process CLI overrides, and project or user child-role assignments. Provider, model, effort, and role choices remain operator-owned; the skill does not prescribe concrete defaults.

## [0.6.1] - 2026-08-30

### Changed

- `post-code-review` now treats proven code-shape defects introduced or worsened by the reviewed change as REQUIRED even when runtime behavior still succeeds. Delete-first contraction, dead surface, fake configurability, duplicated invariant ownership, stale derived documentation, misleading behavior descriptions, and open delete/rewrite/owner moves now block that review gate until remediation and a fresh run; impact remains a separate severity axis, and final QA remains separate.
- Workflow agents may declare `requireModelRole: true` beside an explicit `modelRole`. The opt-in contract refuses an unassigned role before child creation, records the strict request on `agent_start`, and separates its replay identity from ordinary portable role fallback; packaged `post-code-review` uses it for every review child.
- `workflow_check_source` now returns stable compiler-style diagnostics with severity and one-based source spans while preserving the legacy message-only checker API. Non-empty `meta.phases` declarations are checked against literal `phase()` calls; duplicate declarations, case drift, and missing-stage drift fail, while unused declarations and order drift are reported as warnings.
- Global `enabledModels` is now a hard Pi execution allowlist: an explicit `--model` outside the list is stopped before the first LLM request instead of bypassing picker-only scoping. Configured empty, malformed, or unreadable policy fails closed.
- Extension source and tests are now grouped by responsibility under named subdirectories, so large extension roots read as a table of contents without changing entrypoints, runtime behavior, or the npm package boundary.
- Internal package ownership is now reflected by source and test paths: the unreachable replacement-session executor was removed, Fusion was grouped under one owner, the rich question implementation was renamed, and outside workflow consumers now read `hasJournal` instead of raw journal records. The steady-state layer checker gained negative fixtures and explicit topology ceilings for the moved test suites; visible TUI behavior is unchanged.

### Fixed

- A short `/agent drill` transcript now starts directly below its frame header and returns only its real content height instead of pushing the request and result to the bottom with synthetic blank rows. Long transcripts still fill the viewport and keep the same tail-follow and history controls.
- Package-owned SDK child sessions now use Pi's public file-backed session manager under their run/report evidence directory, so workflow and direct-agent children no longer appear in the operator's `pi --resume` catalog while native JSONL/HTML export remains available. Pi's built-in `/export` still requires a materialized operator session with an assistant turn; slash-only workflow export is tracked upstream instead of being worked around with a fabricated turn.
- Fresh workflow completion rows now pair the durable agent identity with the same petname shown in `/ps`. Child JSONL/HTML transcript filenames include bounded stage and petname slugs, HTML exports replace the generic browser title with that identity when possible, and the completion digest points to the shared transcript directory once.
- Workflow completion cards now render one gated Next action beneath the exact result instead of repeating it in the persisted digest. Run separators are presentation-only and fill the live card width instead of stopping at a fixed 64 columns; session/model context keeps the same run identity as plain semantic text.
- `/workflows list` now opens on the current source with the most selectable workflows instead of the first non-empty source; equal counts keep Project → User → Package order, and History is used only when every current source is empty.
- `/ps` now focuses the agent roster already visible below the editor instead of drawing a duplicate list over the workflow panel. The focused roster freezes membership and order for cursor stability, keeps live fields current, and scrolls through every leaf row with explicit earlier/later counts; closing or drilling returns through the normal Pi editor lifecycle.
- The TUI surfaces were aligned after a live design review. A healthy working agent now uses the shared accent tone everywhere instead of the warning tone the progress widget forced, so `/ps` and the widget no longer paint the same agent two colors; the `/ps` cursor is a colored `>` instead of an uncolored `▸`; full-screen viewers (workflow catalog, run viewer) clip to their content instead of padding to the terminal height, so closing them no longer leaves a blank screen; `/agent` renders colored at the live terminal width instead of plain at 80 columns; frames use one rounded glyph set, key hints one `·` separator, and framed headings gained a space before the filler rule; `/model-roles` marks assigned roles green and keeps yellow for unset ones; the completion card gets status tones at render time while its stored text stays plain; long workflow paths are shortened in widget headers so the right-hand hints survive; agent previews strip markdown markers; the `/workflows` palette description is a short phrase; and `skills/.ignore` stops the host from scanning the skills README as a skill at startup.
- Workflow root results, `parallel()` branches, and `pipeline()` stages now classify the same JSON-detached returned outcome: `ok:false`, `partial:true`, and `status: "failed" | "blocked" | "cancelled"` all fail consistently. A direct group value that cannot cross JSON detachment, such as unsupported `BigInt`, a circular value, or throwing `toJSON`, fails separately as a typed group-boundary error while its raw value remains evidence; this is not a fourth returned-outcome kind. This is a one-way compatibility change: those non-JSON-safe direct values and direct group `partial:true` values could previously pass the group barrier and now fail closed; root failure statuses previously completed and now fail; `ok:false` remains failure. Packaged `implement` and `post-code-review` phase declarations now exactly match their emitted phase ids.
- A workflow run starting in the same second as another run could crash with `EEXIST` instead of starting — most visible on `--resume` right after a short run, when both drew the same random run-id suffix. Run-id allocation now serializes global discovery, reserves the execution directory, initializes its journal, and retries fresh ids on collision; resume ids are never re-minted.

## [0.6.0] - 2026-08-23

### Changed

- **Breaking:** `loop`, `plan` (`/plan`, `/mode`, `/goal`, `/goal-ai`, `/review`, `/todos`, and the `goal` tool), and `todo-context` (`/todo`, `todo_read`, `todo_write`) are now beta and disabled by default. They still install and load with the package, but register nothing until the project enables them in `.locus-pi/config.json` with `{"beta": ["loop"]}` or for one session with `LOCUS_PI_BETA=loop`; restart Pi after either. Extension manifests gained a required `tier` field, and the extension reference gained a `Tier` column.
- The package no longer ships a global agent-profile catalog. Bare `spawn_agent` and workflow `agent()` calls now start clean children, while explicit names resolve only from project or user profiles; workflow authoring is owned directly by the packaged workflow skill.
- Workflow skills now use the action-first names `locus-pi-workflow-create`, `locus-pi-workflow-run`, and `locus-pi-workflow-implement-task`.
- The public repository now uses Git as its file inventory. The duplicate `public-repository.json` and generated TXT inventory were removed.
- The npm package allowlist now names owned directories instead of hundreds of individual files.
- The root documentation was reduced to this changelog, the README, the license, and the agent development contract. Third-party notices moved to `docs/third-party-notices.md`.

### Removed

- The `security-gate` extension and its `/security-audit` command were removed. It was an audit-only observer that never blocked a tool call; approvals remain owned by Pi.

### Fixed

- Workflow `agent({ choice })` now reads the bare member text (`completed`) and the schema-echo object (`{"type":"string","value":"completed"}`) as that member instead of failing the whole run after two attempts; the attempt's `schemaValidation` records the reading as `coercion`. Observed on `openai-codex/gpt-5.6-luna` running a generated `implement-plan.workflow.mjs`, where the completed step's run was discarded over quoting. The generated step prompt no longer forbids the JSON answer the runtime contract then asks for.

## [0.5.0] - 2026-08-20

### Changed

- Workflow source validation moved into the workflows extension as the read-only `workflow_check_source` tool.
- The package became extension-only. The standalone `locus-pi` executable and unused `devext-doctor` extension were removed.

## [0.4.0] - 2026-08-20

### Added

- Fresh workflow workspaces now use unique paths under `.locus-pi/plans/`.
- `task/draft` captures intent before the separate planning, rendering, and execution stages.
- `workflow-creator` and modular `post-code-review` workflows joined the packaged catalog.
- Generated extension and workflow catalogs now come from the runtime-owned source lists.
- Headless runs gained explicit no-operator behavior and bounded live operator questions.

### Changed

- `/workflows` became the canonical catalog for Project, User, Package, and History sources.
- Folder-owned workflow namespaces gained direct child execution and persisted source identity.
- `npm run check` became the canonical deterministic repository gate.
- The security extension became an audit surface rather than a permission grader.
- Public documentation moved to cross-cutting guides under `docs/` and manuals beside each extension.

### Fixed

- Workflow workspaces, locks, resumes, handoffs, and saved evidence now remain bound to their original run and source.
- Workflow discovery, parsing, completion, and packaged registration now share the same source rules.

## [0.3.0] - 2026-08-10

### Added

- The package gained durable workflow runs, saved child sessions, bounded retries, Fusion, model roles, and operator handoffs.
- Planning became an explicit graph that stops for review before execution.
- The package added workflow authoring guidance, architecture boundaries, source checks, and installed skills.

### Changed

- Agent cards, `/ps`, drill views, and workflow transcripts now share stable identities and calmer terminal rendering.
- The Package workflow registry now comes from `extensions/workflows/examples/`.
- Workflow code and shared runtime code moved under clear extension and shared-layer owners.
- The supported Pi baseline moved to `0.83.0` with an exact development pin.

### Fixed

- Workflow resume, replay, failure reporting, workspace paths, model evidence, and output retention were made deterministic.
- Packed documentation links and real npm-package loading became executable contracts.

## [0.2.1] - 2026-07-17

### Changed

- Added the `task branch -> dev -> main` delivery path, Git hooks, pull-request templates, and CI policy checks.
- Corrected packaged documentation links and manifest evidence.
- Pinned GitHub Actions and excluded local npm credentials.

## [0.2.0] - 2026-07-14

### Added

- Published the first MIT-licensed `@kroffske/locus-pi` package with ten default extensions.
- Added real npm-tarball inspection, entrypoint loading, source tests, and dependency auditing.
- Added third-party attribution and public package metadata.

### Changed

- Limited the npm package to the supported runtime, documentation, skills, and curated workflows.
- Removed beta modules, private state, reports, evaluations, benchmarks, and local executables from the package.
