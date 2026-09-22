# Consilium

Three role-separated advisors answer one hard question independently, a synthesizer
writes the single document the operator reads, and a **fresh reader** checks that
document against the advisor texts before anything is published.

It is **not** a Package workflow. It lives under `references/` rather than in the
scanned `examples/` directory, so it is unreachable by name and runs by path only —
the same construction `excalidraw-pipeline` uses. It is also not in
`package.json#files`, so an `npm i` of the package does not ship it. The consilium
_pattern_ still reaches a foreign author, because
[`../patterns.md`](../patterns.md) is packed.

```
extensions/workflows/references/consilium/
├── consilium.workflow.mjs   entry — all four stages and all three role charters
├── fixture-question.md      the committed input its test and its live run both use
└── README.md
```

## Running it

```
/workflows run extensions/workflows/references/consilium/consilium.workflow.mjs <your question>
```

`/workflows run consilium` does **not** resolve, and that is the design:
`PACKAGED_EXAMPLES_DIR` is `extensions/workflows/examples/`, scanned one level deep,
and a workflow is registered by the existence of its entry file in that one
directory. `references/` is never visited. Placement is the mechanism — there is no
allowlist to edit and nothing to forget.

## The four stages

```
question
   │
   ▼
frame ──────────────▶ brief.md            one advisory brief the advisors answer
   │
   ▼
advise  (parallel, inside a nested dsl.workflow())
   ├─ evidence advisor ───▶ advisor-evidence.md      what is actually known
   ├─ risk advisor ───────▶ advisor-risk.md          what goes wrong
   └─ alternative advisor ▶ advisor-alternative.md   the strongest case for a different answer
   │
   ▼
synthesize ─────────▶ synthesis-draft.md   one document, disagreements kept
   │
   ▼
verify ─────────────▶ verification.json    accept | reject, checked against the sources
   │
   ├─ accept ─▶ publishArtifact("consilium.md")  ── terminal document
   └─ reject ─▶ run ends with the verifier's named reason, nothing published
```

**Why `frame` exists.** Without it each advisor answers a slightly different question
and the synthesizer's job silently becomes reconciliation instead of synthesis — the
classic stage that only a strong model survives.

**Why the advisors are role-separated rather than three copies of one prompt.** Three
identical advisors on the same model produce three of the same answer, and the
synthesizer then has nothing to synthesize. Evidence, risk and alternative are three
genuinely different jobs, so three _weak_ advisors still produce three genuinely
different texts. That is the entire reason to have several.

**Why `verify` is an agent and not a vote count.** The shipped "Judge panel" pattern
counts votes in JavaScript, which is legal — it branches on a runtime-validated
declared value, not on model prose — but it is the wrong shape here. The deliverable
is a document, and a document's quality is not a tally. The expected failure of a weak
synthesizer is manufacturing consensus: dropping the advisor who disagreed, or
attributing a claim to an advisor who never made it. Neither is detectable by
counting. So the check is an agent whose one job is to read the synthesis against the
sources — and the script still branches on exactly one declared enum member.

**Why the terminal document is published by the script, not named as the
synthesizer's `artifact:`.** An automatic answer artifact would exist whatever the
verifier said. Publishing after the verdict is what makes "a rejected run leaves no
terminal artifact" true rather than aspirational.

## Acceptance, in machine-checkable terms

A run is good when:

- `consilium.md` exists as a published artifact, is non-empty, and is **byte-for-byte**
  the synthesis stage's answer at any length — the script publishes what it received and
  reformats nothing, not even a missing trailing newline, so the terminal document is the
  answer rather than the script's rendering of it. No stage declares an answer-length
  bound: the runtime owns no size policy, and this reference must not teach one;
- the verifier's `verdict` is one of the two declared enum members;
- and a `reject` verdict ends the run carrying that verdict's own `reason`, with no
  `consilium.md` published.

`tests/extensions/workflows/references/consilium-reference-workflow.test.ts` drives the file over
both verdicts with a fake agent runner and asserts exactly that.

## Model tiers

The evidence and alternative advisors declare `modelRole: "smol"`; the risk advisor
declares `modelRole: "slow"`. These are portable role names, not concrete
`provider/id` selectors baked into the reference. The operator assigns them in the
normal model-roles configuration. If a role is unassigned, the stage inherits the
parent model and records that fallback explicitly.

Run evidence distinguishes request from execution: `agent_start.modelRole` records the
declared role, while `agent_end.executedModel` records the model the child session
reported. A concrete `model:` selector would instead fail closed on an installation
whose registry cannot resolve it, so this reference does not pin workstation-specific
model ids.

## Stage shape is a hypothesis, not a settled requirement

Four stages is this reference's design claim, not a proven minimum. Its falsifier is a
live run on a deliberately weak model: a stage a weak model cannot complete gets
**split**, never upgraded to a stronger model, and a stage a run shows to be
unnecessary gets removed with this file saying so. `frame` and `verify` in particular
are additions beyond "N advisors plus a synthesizer" and are the two most likely to be
challenged.
