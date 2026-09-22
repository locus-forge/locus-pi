# Workflow pattern catalog

> **Advanced compatibility archive.** New standard authoring reads the compact
> cards under `skills/locus-pi-workflow-create/references/` after producing an approved
> design. Do not copy this file's raw schemas, validators, parsers, renderers, or
> recovery shapes into standard generated source. This catalog remains shipped
> so existing reviewed workflows can understand their historical techniques.

These are authoring skeletons, not additional Package workflows. Save a reviewed
copy under project `.locus-pi/workflows/` or user `~/.locus-pi/workflows/` before
running it. Workflow JavaScript executes with full Node.js host access and is not
sandboxed.

The Package workflows are whatever `extensions/workflows/examples/` holds —
currently `live-smoke`, `post-code-review` and its children, `stage-loop`, plus `task/draft`
and `task/plan`. A skeleton copied out of this catalog becomes one by being
saved there, with the package-surface review that implies; saved anywhere else
it stays yours.

## New authoring: choose the graph

Use the [current pattern index](../../../skills/locus-pi-workflow-create/references/INDEX.md):
adaptive slices by default for substantive implementation, fixed graphs for fixed work,
reviewer-gated bounded refinement, bounded decomposition or human-gated continuation. Full runnable examples live in [the refinement example](examples/refinement.workflow.mjs).
Recovery is a runtime capability, not another graph pattern, and generated source
is an authoring lifecycle. The historical recipes below remain compatibility
material, not additional standard patterns or a second source grammar.

For new source, brief each agent with its task, relevant context and definition
of done. Ordinary narrative returns as text; structured controls are justified
by actual routing or decomposition. Do not copy a historical recipe's detailed
procedure, output schema or numeric limit without a current consumer need.

## Choose a shape

| Requirement                              | Minimal shape                               |
| ---------------------------------------- | ------------------------------------------- |
| One bounded tool-using task              | one `agent()`                               |
| Cheap classification or draft            | one shaped `agent({ schema })`              |
| Cheap gate before tool work              | shaped `agent()` then conditional `agent()` |
| Yes/no answer the script must branch on  | `agent({ schema })` with an `enum`          |
| A few fixed fields for the next stage    | `agent({ schema })`, closed object          |
| Multi-step work on one subject           | staged text pipeline (see below)            |
| Repeat until an evidenced verdict        | bounded loop plus judge                     |
| Plan, implement, and verify              | planner, writer stages, reviewer loop       |
| Ordered transformation per item          | `pipeline()`                                |
| Independent work followed by synthesis   | fan-out/fan-in — `parallel()` then merge    |
| Independent acceptance votes             | `parallel()` judge panel                    |
| A human decision the run cannot make     | human gate — `awaitOperator()`, two runs    |
| Repeat while a script-visible fact holds | plain-JS loop, `dsl.now()` for the clock    |
| A group that reads as one step           | nested `dsl.workflow()` around the group    |
| One document several views must inform   | consilium — advisors, synthesis, verifier   |

Prefer the staged text pipeline for any requirement that reads "understand X,
then decide about X, then act on X". Reach for a loop, `parallel()`,
`pipeline()`, or a judge panel only when the requirement names work that is
genuinely repeated, independent, or per-item.

When both this row and a group row seem to apply — two independent inventories
that then get compared — stay sequential unless the branches are expensive
enough that the barrier pays for itself. One session that gathers both sides
keeps their vocabulary consistent; two sessions plus a merge stage cost three
calls to save one.

## Staged text pipeline (retired review-family compatibility shape)

This was the compatibility shape used by the retired `review` and `review-fix`
Package workflows. Every stage is one
`agent()` with one coherent cognitive job; each handoff is the previous stage's
exact text; the workflow never parses that text.

Write the prompts inline, in the script, next to the call they belong to. One
file is the whole workflow: the contract every stage shares, the per-stage task,
the agent identities, and the routing between them are read in one pass, and
the retained script snapshot covers the prompt bytes too.

```js
// The contract every stage shares. One constant, prepended to each stage prompt,
// so a rule changes in one place and no stage can quietly disagree with another.
const COMMON = `Work only inside the current repository.

Read first: AGENTS.md, then the entry point named in the task below.

Hard rules:
- Do not commit, push, stage, or switch branches.
- Every factual claim carries a repo-resolvable \`path:line\` citation.
- A claim you could not verify is a finding to report, not a detail to hide.

Your final text is the handoff the next stage receives, not a message to a human.`;

// `workspaceMode` states isolation intent, not authorization or a tool limit.
// Package per-attempt emergency fuses stay host-owned unless the operator asks
// the approved Design for a narrower or raised override.
const READ_OPTIONS = Object.freeze({
  workspaceMode: "project",
});
const PUBLISH_OPTIONS = Object.freeze({
  workspaceMode: "project",
});

phase("resolve-scope");
const scopeText = await agent(
  `${COMMON}

TASK — turn the operator's request into one explicit, self-contained scope.
Do not start the work itself; a later stage does that.

--- BEGIN OPERATOR REQUEST ---
${input}
--- END OPERATOR REQUEST ---

Return Markdown with \`## In scope\`, \`## Out of scope\`, and \`## Unknowns\`.
Write \`- none\` under a heading that has nothing to list.`,
  { ...READ_OPTIONS, label: "resolve scope" },
);

phase("plan-units");
const unitsText = await agent(
  `${COMMON}

TASK — group the scope into atomic units of meaning. Do not judge them and do
not propose fixes.

--- BEGIN SCOPE ---
${scopeText}
--- END SCOPE ---

Return one \`## U<n>\` section per unit, each naming the files it covers.
Return \`## No units\` with a one-line reason when the scope is empty.`,
  { ...READ_OPTIONS, label: "plan units" },
);

phase("verify");
const reportText = await agent(
  `${COMMON}

TASK — reopen the evidence yourself and write the report. The units are a work
map, not evidence: read the source before you assert anything about it.

--- BEGIN SCOPE ---
${scopeText}
--- END SCOPE ---

--- BEGIN UNITS ---
${unitsText}
--- END UNITS ---

Return the reader-facing report: \`## Verdict\`, \`## Findings\` (\`None.\` when
there are none), \`## Coverage and limits\`.`,
  { ...READ_OPTIONS, label: "verify and write report" },
);

phase("publish");
return agent(
  `${COMMON}

TASK — write the report to its artifact path and return a short executive
summary. Do not invent, re-judge, or delete substance.

--- BEGIN REPORT ---
${reportText}
--- END REPORT ---`,
  { ...PUBLISH_OPTIONS, label: "publish package" },
);
```

Reach for a neighboring `./resources/<stage>.prompt.md` through `promptFile()`
in the two cases where a file earns its indirection: a role charter long enough
that inlining it buries the routing (roughly 80 lines and up — the curated
`review` verifier is one), or a prompt genuinely shared by more than one
workflow. Everything else — including every stage of a two- or three-stage
pipeline — belongs in the script. A `promptFile` reference must resolve to a
packaged `*.prompt.md`; a boundary test enforces that, so the escape hatch stays
a real file rather than a guess.

Stage roles, in the order they usually appear:

| Stage       | Owns                                                            | Keep it out of                       |
| ----------- | --------------------------------------------------------------- | ------------------------------------ |
| Resolver    | Free-form operator intent -> one explicit, self-contained scope | Doing the work itself                |
| Inventory   | Proving complete coverage of the subject                        | Grouping or judging                  |
| Planner     | Grouping the inventory into atomic units of meaning             | Findings, verdicts, fixes            |
| Interrogate | Falsifiable questions about each unit                           | Answering its own questions          |
| Implementer | Applying the planned units to source                            | Deciding what to apply               |
| Verifier    | Reopening evidence, answering, and authoring the report         | Formatting and persistence decisions |
| Publisher   | Writing the artifacts and returning an executive summary        | Inventing or deleting substance      |

**Do not ship all seven.** The table is a menu, not a sequence. Two stages is a
complete pipeline: one that produces the substance, one that persists it. Add a
third only when it answers a question the others cannot, and be able to name
that question. `review` needs six because a review is genuinely
coverage-then-grouping-then-questions-then-answers; a workflow that greps two
files and reports needs two. `review-fix` has no inventory or interrogator stage
at all.

Ask of every extra stage: what does it decide that its neighbour cannot? If the
honest answer is "it reformats" or "it restates", delete it.

Rules that make the shape work:

- Every stage inherits the parent run's complete tool surface. Inspection stages
  are told not to modify the repository; the workflow does not maintain a tool
  allowlist for them.
- Separate the two kinds of writing. A stage that mutates source (`review-fix`'s
  implementer, mid-pipeline) and a stage that persists artifacts (the publisher,
  last) are different privileges and different prompts; do not merge them, and
  do not give either one to an inspection stage.
- The publisher is a privilege hop, not a reasoning step. It exists because the
  stage that produced the substance could not write. When a workflow's output is
  useful as the run result alone — `result.json` is durable — you may not need a
  publisher at all.
- Only give a stage `bash` when it must run something: repository checks, or
  proving an output directory is ignored before writing there. A publisher that
  writes into an already-known path does not need a shell.
- Pass forward only the artifacts the next stage needs, never the operator
  conversation, runtime logs, or another stage's scratch reasoning. With a
  resolver, downstream stages read the normalized scope instead of the raw
  request. Without one, only the first stage sees `input`, and its output
  contract must carry forward whatever the later stages need.
- Human-readable ids (`U1`, `U1-Q1`, `F1`, `X1`) exist so a reader can follow a
  unit through the artifacts. Nothing parses them.
- Deterministic workflow code belongs at the edges, and only for what a prompt
  cannot do: confining an operator-supplied path, or refusing to start when
  there is nothing to act on. `review-fix-input.mjs` is the whole of it.
- Decide where artifacts land, and say it in the publisher prompt. The review
  family writes into one local task's `artifacts/` directory and proves
  `.tasks/` is git-ignored first; that is a repository convention, not a runtime
  rule. A workflow with a different natural home says so explicitly instead of
  copying `.tasks/` blindly.
- Add loops, retries, hashes, resumability, or fan-out only after a reproduced
  failure in the simpler shape, or a hard safety boundary where failure would
  mutate source, spend money, or be externally visible.

The old runnable examples are no longer shipped. For the same shape with loops inside it — an
operator clarification round that pauses the run, and a draft/critique loop that
exits on a shaped verdict — read the tracked pair
`extensions/workflows/examples/task/`.

## Writing one stage task

A stage is one `agent()` call plus the prompt written next to it. Writing it is
four decisions and nothing else:

1. **The one question it answers.** Name it in a sentence. If the sentence needs
   an "and", it is two stages — or the second half only restates the first, and
   then it is one.
2. **Its action boundary.** State whether the stage inspects or changes files and
   give it the exact working/output directory. Tools stay inherited; only an
   explicit user request justifies narrowing them.
3. **What it receives.** The shared `COMMON` contract, then the previous stage's
   exact text interpolated between `--- BEGIN <NAME> ---` / `--- END <NAME> ---`
   markers, plus the original operator intent when later stages must not lose the
   focus. Nothing else: not the operator conversation, not runtime logs, not a
   sibling's scratch reasoning.
4. **What it leaves behind.** `label` is the human-readable verb phrase in the
   live panel and the journal; `artifact: "<name>.md"` names the answer in the run
   store. The runtime persists it — no publisher child is needed to save text.

The stage's _task_ lives in its prompt, not in control flow: the question, the
explicit list of what this stage must NOT do, and an output template with a
stated rule for the empty case (`None.`, `- none`, an explicit `## No changes`
declaration). A stage that has no way to say "nothing here" will invent
something. Write that prompt inline in the script — the default above — and move
it to a `*.prompt.md` only for a long role charter or a prompt two workflows
share.

### What the script may check

The script orchestrates and bounds; it does not grade the answer. The whole
allowed set, and every item is about being able to continue at all:

- non-empty text — an empty handoff breaks the next prompt before the model ever
  sees it. Not its length: there is no per-stage character cap, here or in the
  runtime (see [the principle](../../../docs/workflows/agent-results.md#the-principle));
- confining an operator-supplied path, or refusing to start when there is nothing
  to act on;
- host-owned trust: continuation refs, lineage, digests, identity;
- one declaration the script must branch on — and then through
  `agent({ schema })`, where the runtime re-asks the child with the previous
  attempt's validator errors before failing closed. That retry is the only
  correction loop the DSL gives you for free.

**Three tiers, in this order.** Reach for the cheapest one that can express the
rule; drop a tier only when the one above genuinely cannot say it.

1. **A schema keyword.** Anything about one node: type, count, length, pattern,
   enum, uniqueness, blankness.
2. **`validate`** — the script callback on the same `agent({ schema })` call. Any
   rule over the whole answer: referential integrity against data the host owns,
   agreement between two fields, a budget summed across items, graph shape. It
   returns `string[]`, and the runtime feeds a non-empty return back to the child
   in its own repair block. This is script code that no longer ends the run.
3. **A fatal `throw`** — only for the two classes a retry loop can be talked
   past, plus evidence this child did not produce and cannot repair:
   - **self-reported status** — the check accepts the model's word about
     something the host did not verify. The repair bullet explains _why_ the
     success claim was refused, which coaches the model toward a claim the host
     accepts;
   - **verdict coherence** — a model's verdict graded against its own findings
     list. "A `revise` verdict requires at least one finding" has two satisfying
     moves, fabricate a finding or flip the verdict, and both destroy the signal;
   - **host-owned continuation, lineage, digests and identity**, and text a
     _prior_ run's agent wrote.

   The test for tier 2 versus tier 3 is not "does it touch host evidence" — a
   deterministic membership re-check against a host-parsed map runs identically
   on every attempt and cannot be negotiated with, only complied with. The test
   is whether a bullet handed to the model offers it a second way to satisfy the
   check.

Do not write a validator over model prose: no required headings, no id ledgers,
no cross-stage reconciliation, no "the answer must mention every X". Ids like
`C1`, `U1`, `F1` exist so a reader can follow one unit through the artifacts;
nothing parses them. A `throw` over prose grammar has exactly one outcome — the
run dies having paid for every earlier stage, with no way to hand the prompt back
for a correction.

Reference, so the trade-off is known and not rediscovered: until 2026-07 the
curated `review` entry enforced its own Markdown — unique `## C<n>` ids, a
`Coverage:` ledger per unit, `## Coverage reconciliation` and
`## Coverage and limits` sections with the exact unit assignment preserved. On a
clean worktree the inventory honestly answered "no unstaged tracked changes", the
id gate threw, and a legitimately empty scope surfaced as a failed run after
three model calls. Those gates are gone. The prompts still ask for the ids
because they make a review better, and the verifier reports its own coverage. The
cost of dropping them is real — a stage can now under-cover its subject quietly —
and the way to buy it back is a schema or a bounded re-ask loop, never a fatal
throw.

### Bounds belong in the schema, invariants belong in the script

Every count, length, id pattern, and enum goes in `agent({ schema })`, because
the runtime hands a violation back to the child with the validator's own message
and lets it try again. The same rule written as a `throw` ends the run instead.
What stays in script code is what no declared keyword can say.

The retired `review-fix` workflow was the worked example. Its selector schema was:

```js
const FINDING_SELECTOR_SCHEMA = freezeSchema({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SELECTED_FINDINGS,
      uniqueBy: "id",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "note", "dependsOn"],
        properties: {
          id: { type: "string", pattern: FINDING_ID_PATTERN },
          note: { type: "string", maxLength: MAX_NOTE_CHARS },
          dependsOn: {
            type: "array",
            maxItems: MAX_SELECTED_FINDINGS,
            uniqueItems: true,
            items: { type: "string", pattern: FINDING_ID_PATTERN },
          },
        },
      },
    },
  },
});
```

Until 2026-07-26 each of those bounds was a hand-rolled check. Thirteen of them
disappeared into the declared keywords above; seven more (`isRecord`,
`Array.isArray`, `typeof … !== "string"`) were pure restatements of `type:` that
the runtime had already rejected before the validator ever ran.

**Uniqueness is a keyword now, not an invariant.** `uniqueBy: "id"` owns "one
entry per finding" and `uniqueItems` owns "no dependency listed twice"; on a
string array a consumer will trim, `uniqueTrimmedItems` owns it, and `nonBlank`
owns a string that satisfies `minLength: 1` while being pure whitespace. All
four canonicalize with `String.prototype.trim`, the same call a normalizer uses,
so a value the runtime accepted cannot collapse afterwards. Reach for a keyword
before you reach for a `throw`: a repeat the child is told about is usually
repaired on the retry, and a repeat it is not told about ends the run.

What survives is the honest residue — every line of it needs a fact the schema
does not have. It is tier 2, not tier 3: the same rules, now returned as strings
from `findingPlanErrors` and passed as the call's `validate`:

```js
const selection = await agent(prompt, {
  schema: FINDING_SELECTOR_SCHEMA,
  // A per-call-site closure: `findings` was parsed once, before the call.
  validate: (value) => findingPlanErrors(findings, value),
});
const selected = orderFindingPlan(findings, selection);
```

```js
// inside findingPlanErrors — it accumulates and never throws
if (!byId.has(id)) errors.push(`findings[${index}].id: value ${JSON.stringify(id)} is not a finding id in the review`);
// …
if (dependency === id) errors.push(`${at} is the finding's own id`);
else if (!selectedIds.has(dependency)) errors.push(`${at} is not one of the selected findings`);
// …then a fixpoint over the edges, and:
errors.push(`findings: the dependency graph contains a cycle among ${unresolved.join(", ")}`);
```

Referential integrity against the immutable review, self-edges and acyclicity are
still inexpressible as keywords — but that is an argument for tier 2, not for
tier 3. The review text these ids are checked against is embedded verbatim in the
selector's own prompt, so the map is identical on every attempt and the only way
to pass is to name a real id. Splitting the old function in two is what makes it
safe: `findingPlanErrors` decides, `orderFindingPlan` only merges and sorts, and
neither one can quietly do the other's job.

A **cross-field invariant** is the same idea inside one answer. The retired
`review` clarifier declared `decision` and `questions` separately, and no schema
could say that one constrains the other:

```js
// inside clarifierDecisionErrors, this call's `validate`
if (decision === "continue") {
  if (questions.length !== 0) {
    errors.push(`questions: expected 0 item(s) when decision is "continue", got ${questions.length}`);
  }
  return errors;
}
// The upper bound is `maxItems`; this lower bound applies only to this branch.
if (questions.length < 1) {
  errors.push('questions: expected at least 1 item(s) when decision is "needs_operator", got 0');
}
```

The same callback keeps `recommended` honest — it must equal one of the options
in its own question — and enforces a budget summed across prompts, which is a sum
no keyword computes. What it no longer does is check uniqueness or blankness:
`uniqueBy: "id"` on `questions`, `uniqueTrimmedItems` on `options`, and
`nonBlank` on both string fields moved those into the schema on 2026-07-26, so
the trimming that remains only canonicalizes. What it no longer does either is
`throw`: `normalizeClarifierDecision` runs afterwards and rejects nothing, so
every one of these rules reaches the child before the call can fail closed.

Write the messages the way the runtime writes its own — 0-indexed JSON path,
observed value, what would satisfy it. `review clarification questions must be
unique` was the old wording for a check that compared `question.id`; a child
re-asked with that string would reword its prompts and reproduce the collision.

There is **no bound on the size of free text**, and `maxAnswerChars` is gone: the
runtime never refuses an answer a child already produced because of its length.
Shape a stage's output by ASKING for what you want ("one paragraph and three
bullets"), and declare a bound only where a consumer genuinely has one — a
one-line heading through `output: { type: "string", maxLength: 80 }`, or
`maxLength`/`maxItems` inside a `schema`. Those reach the child as a contract it
can satisfy, instead of failing the call after the work is done. Keep
hand-written bounds only for text the workflow itself owns — operator input,
consumed artifacts, and strings the script composes. The whole rule, and the
budget and capability rules beside it, are stated once in
[the principle](../../../docs/workflows/agent-results.md#the-principle).

### Declare the fact, do not scan the prose

The named anti-pattern is a regex over model-authored text that decides
something. It fails in both directions: it misses every paraphrase, and it fires
on innocent sentences that happen to contain the word.

```js
// Anti-pattern: the gate is defeated by wording the model never intended to hide.
const needsOperatorProof = /\b(TUI|manual|manually|operator|by hand)\b/iu.test(planText);
```

"Someone will need to eyeball the dashboard" never matches. Replace the scan with
a declared field, and have a _fresh_ reader check the declaration against the
original request:

```js
// The plan declares the fact; a separate reviewer stage checks the declaration.
schema: {
  type: "object",
  additionalProperties: false,
  required: ["externalEvidenceRequired", "rationale"],
  properties: {
    externalEvidenceRequired: { type: "boolean" },
    rationale: { type: "string", minLength: 1, maxLength: 500 },
  },
}
// …later, deterministically:
if (plan.externalEvidenceRequired && receipts.length === 0) {
  throw new Error("plan requires external evidence that no receipt provides");
}
```

Record what this costs, because it is not free: a regex over the request could
not be lied to, and a declared boolean can. The guarantee moves from one brittle
host check to two independent model readings — weaker against a planner and a
reviewer who err the same way, stronger against everything else. Do not make this
trade silently.

The one regex the shipped examples still run over model text is
`declaredNoChanges()` in `review.workflow.mjs`, and its own comment says why it
is allowed: it is a **cheap early exit, not a gate**. When the inventory declares
`## No changes` and lists no `C<n>`, three later stages have nothing to work
with, so the run finishes instead of paying for them. It cannot fail the run, and
nothing downstream depends on it being right.

## Semantic text input

Both `/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]`
and the `workflow` tool pass one optional bounded semantic string.
Command options precede that input. When semantic input begins with an
option-looking token such as `--resume`, `--output-dir`, or `--`, place the
conventional `--` end-of-options delimiter before it; every character after the
delimiter is forwarded unchanged. Input is the operator's semantic request,
not a command language or serialized parameter object. Let an agent interpret
meaning; keep only explicit deterministic invariants in JavaScript:

```js
export default async function run({ agent, phase }, input) {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, summary: "An audit request is required." };
  }

  phase("audit");
  return agent(`Interpret and perform this audit request exactly:\n\n${input}`, {
    label: "audit",
  });
}
```

Cross-run identity is not embedded in text. The tool may separately attach the
closed host `continuation` control; the runtime verifies its complete artifact
refs before workflow code starts, and the script reads the bound copies through
`dsl.continuationArtifacts()`.

## Single agent

```js
export const meta = { name: "one-agent", description: "Run one bounded tool-using task." };

export default async function run({ agent, phase }, input) {
  phase("work");
  const text = await agent(input, {
    label: "work",
  });
  return text;
}
```

## Cheap gate before further work

```js
// The declared shape is enforced by the runtime, so the script branches on a
// value it did not parse. The child keeps the inherited tool surface.
const gate = await agent(`Classify whether tool work is needed: ${input}`, {
  label: "gate",
  schema: {
    type: "object",
    required: ["needsTools"],
    properties: { needsTools: { type: "boolean" } },
  },
});

if (!gate.needsTools) return { ok: true, skipped: true };

const work = await agent(input, { label: "work" });
return work;
```

## Shaped answer from an agent

Use `agent({ schema })` when the script itself must branch on the answer. The
call runs an ordinary child agent — same catalog agent and inherited tools
— but returns the **validated value** instead of text, and throws
`SchemaValidationError` if the child cannot produce that shape within the retry
budget. Nothing unshaped ever reaches the script.

Yes/no answer — an `enum` leaves the child no room to answer "it depends":

```js
const gate = await agent(`Does this diff need a security review?\n${diff}`, {
  label: "security-gate",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["needsSecurityReview"],
    properties: { needsSecurityReview: { type: "boolean" } },
  },
});

if (!gate.needsSecurityReview) return { ok: true, skipped: "no security surface" };
```

Small fixed field set — one closed object handed to the next stage:

```js
const triage = await agent(`Triage this failure report:\n${report}`, {
  label: "triage",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["severity", "component", "summary"],
    properties: {
      severity: { type: "string", enum: ["low", "medium", "high"] },
      component: { type: "string" },
      summary: { type: "string" },
    },
  },
});

const fix = await agent(`Fix the ${triage.severity} defect in ${triage.component}: ${triage.summary}`, {
  label: "fix",
  workspaceMode: "worktree",
});
```

Keep shaped stages small and closed. `enum`, `additionalProperties: false`, and
a short `required` list are what make the answer machine-checkable; a wide schema
with free-form prose fields is where a weak model spends both attempts and the
stage fails closed. Everything narrative stays a plain `agent()` call.

Add `minLength` / `maxLength` / `pattern` on strings and `minItems` / `maxItems`
on arrays rather than re-checking them afterwards — see "Bounds belong in the
schema, invariants belong in the script" above. An impossible declaration (`minItems` above `maxItems`, a
bound on the wrong type, a `pattern` that does not compile) is refused before the
first child call, so it cannot burn the retry budget and surface as an
unexplained exhaustion.

## Bounded loop plus judge

The retired `review` interrogation rounds and the current `task/plan` drafting
rounds use this shape. Both follow the same three rules —

1. the judge returns a **declared enum** plus the concrete gaps or defects that
   justify another round, never prose the script greps;
2. each round returns the **complete document**, so the script forwards one text
   instead of merging several, and the judge's free text reaches the next round
   verbatim;
3. the result records **which condition stopped the loop** — the judge's verdict
   or the round cap — because those two outcomes mean different things to whoever
   reads the run.

```js
const maxRounds = 3;
for (let round = 1; round <= maxRounds; round += 1) {
  const work = await agent(`Round ${round}: ${input}`, { label: `work:${round}` });

  const judge = await agent(`Is this complete? Reply with done boolean.\n${work}`, {
    label: `judge:${round}`,
    schema: {
      type: "object",
      required: ["done"],
      properties: { done: { type: "boolean" } },
    },
  });
  if (judge.done) return { ok: true, stoppedBy: "judge", round };
}
return { ok: false, stoppedBy: "round-cap", error: "Completion was not proven" };
```

## Plan, build, review

This small one-run form is appropriate only when the plan is an internal
handoff and the whole build is one task:

```js
const plan = await agent(`Plan: ${input}`, { label: "plan" });

const build = await agent(`Implement this plan:\n${plan}`, {
  label: "build",
  workspaceMode: "worktree",
});

const review = await agent(`Review the implementation:\n${build}`, {
  label: "review",
});
return review;
```

When the operator must inspect or edit the intended graph before source exists,
use the shipped task family. `task/draft` publishes a complete editable
`draft.md`; copy or edit that text, then pass it to `task/plan` as semantic
input. `task/plan` designs, reviews, builds, checks, and publishes one concrete
`workflow.mjs`. The group-only `task` root is not runnable, the two Package
children never invoke one another, and neither runs the generated workflow.

## Ordered pipeline

```js
const outputs = await pipeline(
  items,
  async ({ item }) => ({ item, extracted: await agent(`Inspect ${item}`) }),
  async (state) => ({ ...state, classified: await agent(`Classify ${state.extracted}`) }),
);
return { ok: true, outputs };
```

`pipeline()` is fail-closed: an uncaught stage failure rejects the group. Catch
only `WORKFLOW_GROUP_FAILURE` when requirements explicitly accept partial work,
and return `partial: true`; partial is never projected as success.

## Caller-supplied item mini-workflows

```js
async function processItem(dsl, item) {
  const finding = await dsl.agent(`Inspect ${item}`, { label: `inspect:${item}` });
  return dsl.agent(`Write ${item}:\n${finding}`, { label: `write:${item}` });
}

export default function runWorkflow(dsl) {
  const items = dsl.items();
  if (items.length === 0) throw new Error("item-pipeline requires caller-supplied items");
  return dsl.pipeline(items, (item) => dsl.workflow((nested) => processItem(nested, item)));
}
```

Caller-supplied items preserve exact order, bytes, whitespace, empty strings,
and duplicates; source owns any domain-specific guard. Model-discovered handoffs
keep their distinct bounded repair policy. `dsl.workflow()` stays inline under
the same run, budget, scheduler, workspace, and replay request keys.

## Fan-out/fan-in

```js
const findings = await parallel(
  targets.map((target) => () => agent(`Inspect ${target}`, { label: `inspect:${target}` })),
);
const merge = await agent(findings.map((item, index) => `${index + 1}. ${item}`).join("\n"), {
  label: "merge",
});
return merge;
```

The cost is the merge stage and the barrier. `parallel()` preserves input order and
fails closed as a group, so `findings[i]` always belongs to `targets[i]` — but the
branches never see each other, so anything one branch learns that would have changed
another's work is lost, and the merge stage has to reconcile vocabularies rather than
synthesize. Use it when the branches really are independent and expensive; two
sessions plus a merge cost three calls to save one.

See also `## Consilium` below, which is fan-out/fan-in with the merge split into a
synthesizer and a separate reader that checks it.

## Judge panel

```js
const votes = await parallel(
  ["strict", "balanced", "skeptical"].map(
    (perspective) => () =>
      agent(`${perspective} judge: ${input}`, { label: `judge:${perspective}`, schema: VERDICT_SCHEMA }),
  ),
);
const passed = votes.filter((vote) => vote.verdict === "pass").length;
return { ok: passed > votes.length / 2, passed, total: votes.length };
```

Choose majority or unanimity explicitly. If any panel slot fails and partial
panels are not accepted by requirements, let the group fail closed.

## Loop until dry

```js
let emptyStreak = 0;
for (let round = 1; round <= 5; round += 1) {
  const sweep = await agent(`Find remaining work, round ${round}`, { label: `sweep:${round}` });
  const measured = await agent(`Count evidenced remaining items in this report:\n${sweep}`, {
    label: `measure:${round}`,
    schema: {
      type: "object",
      required: ["remaining"],
      properties: { remaining: { type: "number" } },
    },
  });
  const remaining = measured.remaining;
  emptyStreak = remaining === 0 ? emptyStreak + 1 : 0;
  if (emptyStreak >= 2) return { ok: true, stoppedBy: "dry", round };
}
return { ok: false, stoppedBy: "round-cap", error: "Dry state was not proven" };
```

Always separate the measured exit condition from the safety cap and record
which condition stopped the run.

## Human gate

A workflow run cannot stop and ask a person: `ask` refuses when there is no UI and
child agent sessions are headless. The gate is therefore two runs with a host-verified
handoff between them — and the questions themselves are written by an agent, because
"what does the operator have to decide" is a judgement, not a template.

```js
// Run 1 — a shaped stage decides whether a human is needed at all.
const decision = await agent(`${COMMON}\n\nDecide whether this can start.`, {
  label: "decide clarification",
  schema: CLARIFIER_SCHEMA, // { decision: enum["continue","ask"], questions: [...] }
});
if (decision.decision === "continue") return await runTheWork(dsl, input);

// Persist exactly what run 2 must receive, then declare the pause.
const intentRef = publishArtifact("intent.md", input);
const questionsRef = publishArtifact("clarification-questions.md", renderQuestions(decision.questions));
awaitOperator({
  reason: "clarification required",
  operatorHandoff: {
    title: "Clarification",
    questions: decision.questions,
    continuationArtifactRefs: [intentRef, questionsRef],
  },
});
return { mode: "prepared", intentRef, questionsRef };

// Run 2 — the operator's answers arrive as ordinary text, and the two artifacts
// arrive through the host's closed `continuation` control, already verified.
const [intent, questions] = dsl.continuationArtifacts();
```

The cost is real and worth stating before you reach for it. The run ends — there is no
suspended process — so everything run 2 needs must be an artifact run 1 published, and
run 2 must be written to start from those artifacts rather than from memory. In
exchange the pause is durable: the operator can answer an hour later, on another
machine, and the host verifies the references before run 2's code starts.

Two rules keep the gate honest:

- **Never let a model conclude that a human approved something.** The operator's
  answer is text the host carried; a stage's claim that "the user agreed" is prose.
- **Do not re-derive the host's proof of the references in script code.** The host
  checks projection membership, digest and size before your module runs. Assert the
  SHAPE you require — how many artifacts, under which names — and read them.

The retired `review` → `review-fix` pair was the Package example of this shape; the
`excalidraw-pipeline` reference uses a plain file the operator edits instead, which is
the cheaper variant when there is no question list to render.

## Plain-JS loop

The DSL has no loop primitive, and does not need one: a workflow is JavaScript. What
it does have is a replay-safe clock, and that is the part worth knowing.

```js
const deadline = dsl.now() + 10 * 60_000;
let round = 0;
let report = "";
while (round < MAX_ROUNDS && dsl.now() < deadline) {
  round += 1;
  report = await agent(`Sweep round ${round}`, { label: `sweep:${round}` });
  const verdict = await agent(`Is this sweep dry?\n${report}`, {
    label: `measure:${round}`,
    schema: { type: "object", required: ["dry"], properties: { dry: { type: "boolean" } } },
  });
  if (verdict.dry) return { ok: true, stoppedBy: "dry", round, report };
}
return { ok: false, stoppedBy: round >= MAX_ROUNDS ? "round-cap" : "deadline", round, report };
```

Use `dsl.now()` and `dsl.random()`, never `Date.now()` or `Math.random()` directly.
Both record their value on the first run and return the recorded one on `--resume`, so
a resumed run takes the same branches; a direct `Date.now()` is not banned, but a loop
that depends on one will not resume the same way, and the identity analyzer flags the
syntax as replay-unsafe.

The cost of a loop is that every round is a real cost, so a loop needs two exits and
must say which one it took: a measured condition the script can read from a declared
value, and a hard round cap. Reaching the cap is an outcome to report, not a silent
fallthrough. Never make the exit condition a scan of model prose — see
`## Declare the fact, do not scan the prose`.

## Nested `dsl.workflow()`

`dsl.workflow(fn, input)` runs a function with the same DSL handle and brackets it in
the journal with `[workflow:enter]` / `[workflow:exit]`. It creates no new run, no new
budget and no isolation — it is a **readability** boundary, and the honest reason to
use it is that a group of calls belongs together in the record.

```js
const advice = await dsl.workflow(async (nested) =>
  nested.parallel(ADVISORS.map((advisor) => () => nested.agent(brief, advisorOptions(advisor)))),
);
```

The cost is one extra journal line each side and one more level of indentation. Reach
for it when a reader of `journal.ndjson` would otherwise see a flat run of calls with
no sign of which step they belonged to; skip it for a single call.

The caller worth reading is the consilium reference at
`extensions/workflows/references/consilium/consilium.workflow.mjs`, which wraps its
advisor fan-out. That is a repository path, not a link: like `excalidraw-pipeline`,
the reference is tracked in the locus-pi repository and runs by path, and is not one
of the files an install ships — this catalog is.

## Consilium

Fan-out/fan-in for the case where the deliverable is a **document**: independent
advisors, one synthesizer, and a separate reader that checks the synthesis against the
advisor texts before anything is published.

```js
const brief = await agent(frameTask(question), { artifact: "brief.md" });
const advice = await dsl.workflow(async (nested) =>
  nested.parallel(ADVISORS.map((a) => () => nested.agent(`${a.charter}\n\n${brief}`, adviceOptions(a)))),
);
const synthesis = await agent(synthesizeTask(brief, advice), {
  artifact: "synthesis-draft.md", // NOT the terminal name — see below
});
const check = await agent(verifyTask(synthesis, advice), {
  schema: {
    type: "object",
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["accept", "reject"] },
      reason: { type: "string", nonBlank: true, maxLength: 600 },
    },
  },
});
if (check.verdict === "reject") return { ok: false, verdict: "reject", reason: check.reason };
return { ok: true, consiliumRef: publishArtifact("consilium.md", synthesis) };
```

Four things make this different from `## Judge panel`, and each is a decision:

- **The advisors differ by ROLE, not by adjective.** Three "strict / balanced /
  skeptical" copies of one prompt on one model produce three of the same answer, and
  the synthesizer then has nothing to synthesize. Give each advisor a different JOB —
  what is known, what goes wrong, the strongest case for a different answer — and
  three weak advisors still produce three genuinely different texts.
- **The check is an agent, not `filter`.** A judge panel counts votes, which is fine
  for an acceptance decision. A document's quality is not a tally: the failure to
  catch is a synthesizer manufacturing consensus — dropping the advisor who
  disagreed, or attributing a claim to an advisor who never made it — and counting
  cannot see either. The script still branches on exactly one declared enum member.
- **The verifier must be a fresh reader.** Do not fold it into the synthesizer:
  two cognitive jobs in one stage is the definition of an under-decomposed stage, and
  the checker would be grading its own output.
- **Publish the terminal document AFTER the verdict.** If the synthesizer stage
  declares `artifact: "consilium.md"`, that artifact exists whatever the verifier
  said. Naming the draft something else and publishing on `accept` is what makes "a
  rejected run leaves no terminal artifact" true rather than aspirational.

The cost is four stages and N+3 children for one document, plus a framing stage that
answers nothing by itself. Pay it when several views genuinely bear on the answer and
the answer is a document someone will act on; for a yes/no acceptance, a judge panel
is cheaper and enough.

The runnable reference is
`extensions/workflows/references/consilium/consilium.workflow.mjs` in the locus-pi
repository, with its committed fixture question and a README stating what it does not
yet demonstrate. It is tracked and runs by path rather than shipping in an install,
so the skeleton above is the part you have if you arrived here through npm.
