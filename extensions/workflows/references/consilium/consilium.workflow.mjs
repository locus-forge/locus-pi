// consilium.workflow.mjs
//
// N independent advisors answer one hard question, a synthesizer writes the single
// document the operator reads, and a FRESH READER checks that document against the
// advisor texts before anything is published.
//
// The fourth stage is the whole point. A judge panel counts votes in JavaScript,
// which is legal — a runtime-validated declared value is not model prose — but it is
// the wrong shape here: the deliverable is a document, and a document's quality is
// not a tally. The expected failure of a weak synthesizer is manufacturing consensus:
// dropping the advisor who disagreed, or attributing a claim to an advisor who never
// made it. Neither is detectable by counting. So the check is an agent whose one job
// is to read the synthesis against the sources.
//
// This is a REFERENCE, not a Package workflow. It lives under `references/` rather
// than in the scanned `examples/` directory, so it is unreachable by name and runs by
// path only:
//
//   /workflows run extensions/workflows/references/consilium/consilium.workflow.mjs <question>
//
// `fixture-question.md` beside this file is the committed input its test and its
// weak-model run both use, so "it worked" always means the same thing.
//
// Advisors declare portable `modelRole` tiers rather than workstation-specific
// `provider/id` selectors. An assigned role routes to that model; an unassigned role
// inherits the parent with an explicit `modelRoleFallback` record. `agent_end` carries
// the host readback as `executedModel`, so the run evidence names what actually ran.

export const meta = {
  name: "consilium",
  description:
    "Three role-separated advisors answer one question in parallel, a synthesizer writes the document, and a fresh reader verifies it against the advisor texts.",
};

/** Fixed so the reference is reproducible rather than re-invented per run. */
const ADVISORS = Object.freeze([
  Object.freeze({
    label: "evidence advisor",
    artifact: "advisor-evidence.md",
    modelRole: "smol",
    charter: `You are the EVIDENCE advisor. Your one job is to say what is actually known.

Write, in this order:
- What the question presupposes, and whether each presupposition holds.
- The facts, constraints and prior decisions a good answer must respect. Name where
  each one comes from; if you are relying on general knowledge rather than something
  in front of you, say so on that line.
- What you could not establish. An unknown named here is worth more than a confident
  guess, because the next reader can go and settle it.

Do not recommend anything. Do not weigh options. Another advisor does that.`,
  }),
  Object.freeze({
    label: "risk advisor",
    artifact: "advisor-risk.md",
    modelRole: "slow",
    charter: `You are the RISK advisor. Your one job is to say what goes wrong.

Write, in this order:
- The most likely failure of the obvious answer to this question, and what it costs.
- Two further failure modes, each with the condition that triggers it.
- What the obvious answer quietly assumes, and what happens when that assumption is false.

Rank by expected cost, not by how dramatic each one sounds. Do not recommend an
alternative — say what breaks, and let the reader weigh it.`,
  }),
  Object.freeze({
    label: "alternative advisor",
    artifact: "advisor-alternative.md",
    modelRole: "smol",
    charter: `You are the ALTERNATIVE advisor. Your one job is to make the strongest
possible case for a DIFFERENT answer than the obvious one.

Write, in this order:
- The alternative, stated in one sentence a reader could act on.
- The strongest argument for it — the one you would use if you had to win.
- The condition under which the alternative is clearly better than the obvious answer.
- The single fact that would defeat the alternative, stated plainly.

Argue it properly. A weak strawman here is worse than no stage at all, because the
synthesizer will read it as evidence that the obvious answer is safe.`,
  }),
]);

// No per-stage answer ceilings, deliberately.
//
// Every stage here used to declare one and the runtime refused a longer answer after the
// child had already produced it. That is a size policy over finished work, not a budget:
// a brief that needs a paragraph more is not a failure, and discarding a completed
// synthesis for its length loses the whole stage. The stages are shaped by their PROMPTS
// (a brief is short because it is asked to be) and the verdict by its `schema`, which is a
// real consumer contract this script branches on. Nothing below asks a model to "keep it
// under N characters" either — that is the same policy moved into the prompt.

// The question is not measured either. A curated reference workflow is where an author
// first reads what "no size policy" means, so it models the principle end to end: the
// only thing asked of the input is that there IS one. An operator who pastes a long brief
// has given the consilium more to frame, not a malformed request.

const VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: {
    verdict: { type: "string", enum: ["accept", "reject"] },
    // `verdict` is the branch: one declared member of a closed set, which is a real
    // contract. `reason` is carried to the operator verbatim and has no consumer that
    // could be broken by a longer sentence, so it declares only that it is present and
    // non-blank. The prompt, not a `maxLength`, asks for one or two sentences.
    reason: { type: "string", minLength: 1, nonBlank: true },
  },
};

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../runtime/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {unknown} input
 */
export default async function runWorkflow(dsl, input) {
  const { agent, parallel, phase, log, publishArtifact } = dsl;
  const question = typeof input === "string" ? input.trim() : "";
  if (question === "") throw new Error("consilium requires a non-empty question");

  // 1. FRAME. Without it each advisor answers a slightly different question and the
  //    synthesizer's job silently becomes reconciliation — the classic stage only a
  //    strong model survives.
  phase("frame");
  log("Turning the operator's question into one bounded advisory brief.");
  const brief = await agent(
    `You are the FRAMER of a consilium. Work from the question; inherited tools are available if verification is necessary.

Turn the question below into a brief three advisors will each answer separately.

Write exactly these three sections, with these headings:

## Question
One sentence. The question as it must be answered — no restatement of context, no hedging.

## What a usable answer must contain
Three to six bullets. Each names something the answer must settle, not a topic it must
mention. "Whether X is worth the cost" is a bullet; "cost" is not.

## Out of scope
One to three bullets naming what this question is NOT asking, so an advisor does not
spend its answer there.

Do not answer the question. Do not recommend anything.

--- BEGIN OPERATOR QUESTION ---
${question}
--- END OPERATOR QUESTION ---`,
    {
      label: "frame the question",
      artifact: "brief.md",
    },
  );

  // 2. ADVISE. Independent by construction: no advisor sees another's text, so three
  //    weak advisors still produce three genuinely different opinions, which is the
  //    entire reason to have several. Wrapped in a nested workflow so the journal
  //    carries a readable [workflow:enter]/[workflow:exit] boundary around the group.
  phase("advise");
  log(`Asking ${ADVISORS.length} independent advisors in parallel.`);
  const advice = await dsl.workflow(async (nested) =>
    nested.parallel(
      ADVISORS.map(
        (advisor) => () =>
          nested.agent(
            `${advisor.charter}

Answer only from the brief below. Keep to your own job: another advisor covers the
others, and the synthesizer needs your view unmixed with theirs.

--- BEGIN ADVISORY BRIEF ---
${brief}
--- END ADVISORY BRIEF ---`,
            {
              label: advisor.label,
              artifact: advisor.artifact,
              modelRole: advisor.modelRole,
            },
          ),
      ),
    ),
  );

  // `parallel()` preserves input order, so advice[i] belongs to ADVISORS[i].
  const advisorSections = ADVISORS.map(
    (advisor, index) =>
      `--- BEGIN ${advisor.label.toUpperCase()} ---\n${advice[index]}\n--- END ${advisor.label.toUpperCase()} ---`,
  ).join("\n\n");

  // 3. SYNTHESIZE. One document, and the disagreements kept rather than smoothed.
  phase("synthesize");
  log("Composing the single document the operator reads.");
  const synthesis = await agent(
    `You are the SYNTHESIZER of a consilium. Work from the brief and
the three advisor texts alone.

Write the single document the operator will read. Use exactly these headings:

## Answer
The answer to the brief's question, in the first paragraph, stated so a reader could
act on it. Say plainly if the honest answer is "it depends", and on what.

## What is settled
What the advisors agree on. Attribute each point to the advisor that made it.

## Where they disagree
Every point on which the advisors do NOT agree, with both sides stated at their
strongest. If you found no disagreement, say so in one sentence and name what you
checked — do not manufacture one, and do not quietly drop the advisor who dissented.

## What would change the answer
The concrete facts that, if established, would move the answer. Take these from the
evidence advisor's unknowns and the alternative advisor's defeating fact.

Rules:
- Attribute every claim to the advisor that made it. Never attribute a claim to an
  advisor who did not make it, and never introduce a claim no advisor made.
- The alternative is not a footnote. If you reject it, say which fact defeats it.

--- BEGIN ADVISORY BRIEF ---
${brief}
--- END ADVISORY BRIEF ---

${advisorSections}`,
    {
      label: "synthesize the document",
      // Deliberately NOT `consilium.md`: the terminal document is published by this
      // script after verification, so a rejected run leaves no terminal artifact.
      artifact: "synthesis-draft.md",
    },
  );

  // 4. VERIFY. A fresh reader, not a tally, and not the synthesizer grading itself.
  phase("verify");
  log("Checking the synthesis against the advisor texts before publishing it.");
  const verification = await agent(
    `You are the VERIFIER of a consilium. You did not write the document below and you
use the advisor texts as the primary evidence; inherited tools remain available for verification.

Return \`reject\` if ANY of these is true:
- A claim in the document is attributed to an advisor who did not make it.
- A claim appears in the document that no advisor made.
- An advisor's dissent is missing from "Where they disagree", or is stated so weakly
  that a reader could not tell it was a disagreement.
- The document reports agreement the advisor texts do not support.

Otherwise return \`accept\`.

\`reason\` is one or two sentences. On \`reject\` it must name the exact claim or the
exact dropped dissent — a reader has to be able to find it without re-reading
everything. On \`accept\` it names what you checked.

Judge only faithfulness to the sources. Whether the answer is CORRECT is not your
job, and neither is style.

--- BEGIN DOCUMENT UNDER REVIEW ---
${synthesis}
--- END DOCUMENT UNDER REVIEW ---

${advisorSections}`,
    {
      label: "verify the synthesis",
      artifact: "verification.json",
      schema: VERIFICATION_SCHEMA,
    },
  );

  // The script branches on ONE runtime-validated declared value. It never reads the
  // verifier's prose to decide anything; `reason` is carried to the operator verbatim.
  if (verification.verdict === "reject") {
    log(`Verifier rejected the synthesis: ${verification.reason}`);
    return {
      ok: false,
      verdict: "reject",
      reason: verification.reason,
      summary: `consilium verifier rejected the synthesis: ${verification.reason}`,
    };
  }

  // Published EXACTLY as validated, byte for byte. An earlier version appended a trailing
  // newline when the answer lacked one, which made the script read the agent's own bytes to
  // decide what to write; the terminal document is the answer, not a reformatting of it.
  const consiliumRef = publishArtifact("consilium.md", synthesis);
  return {
    ok: true,
    verdict: "accept",
    reason: verification.reason,
    consiliumRef,
    summary: synthesis,
  };
}
