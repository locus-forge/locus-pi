// stage-loop.workflow.mjs
// One task stage, carried to a commit without a single `throw`.
//
// The stage is implement -> (review || gate) -> decision -> fix, at most three
// rounds, then a commit. Context travels as paths: the caller passes the task
// file, every agent reads it and the earlier rounds' artifacts itself, and the
// reviewer reads the working tree with its own tools instead of receiving a
// pasted copy of the implementer's report. A stage that cannot finish returns
// `{ ok: false, status: "blocked" }` — the run ends with a named outcome, not a
// JavaScript error.
export const meta = {
  name: "stage-loop",
  profile: "standard",
  description: "Implements one task stage, gates it, fixes it up to three times, then commits.",
  phases: [{ title: "implement" }, { title: "gate" }, { title: "commit" }],
};

export default async function runWorkflow(dsl, input) {
  const { agent, parallel, phase, log, publishArtifact, publishPrimaryArtifact } = dsl;
  const task = input;

  for (let round = 1; round <= 3; round += 1) {
    phase("implement");
    log(`Stage round ${round} for ${task}`);
    const work = await agent(
      `Implement the stage described by the task file at ${task}. Read that file, and read the stage artifacts ` +
        `at the exact paths assigned in the whole input before you start; earlier rounds are recorded there.\n` +
        `On a later round, the previous round's verdict and the exact remaining scope are in its round artifact.\n` +
        `Change only what the stage asks for, run the project's own checks, and report what you changed, what you ran ` +
        `and what remains. Write the complete implementation handoff at its assigned path. Keep dependency caches and test scratch in ordinary OS or tool temporary locations.`,
      { label: "implement", title: `Implement the stage (round ${round})` },
    );

    phase("gate");
    const opinions = await parallel([
      () =>
        agent(
          `Review the current stage of ${task} against its stated scope. Read the change yourself with git diff against ` +
            `the stage base commit, plus the files it touches. Do not edit anything and do not relax the scope.\n` +
            `Write the assigned round review file with, per requirement, the evidence you actually read and exact remaining scope; return it whole too.`,
          { label: "review", title: `Review the change (round ${round})` },
        ),
      () =>
        agent(
          `Check the stage of ${task} for release readiness only: run the project's declared checks, confirm they pass on ` +
            `the current tree, and write the assigned round checks file with each command and its exit status; return it whole too. Do not fix anything you find.`,
          { label: "checks", title: `Run the declared checks (round ${round})` },
        ),
    ]);

    const verdict = await agent(
      `Choose the control identity these two reports support for the stage of ${task}. Do not overrule a failed check ` +
        `or missing evidence, and do not read "no findings" as "verified".\n` +
        `Write the assigned round decision file with full evidence before returning the exact route token. Every named file means its unambiguous exact caller-assigned path; missing files or assignments are blocked without fallback. Whole input:\n${input}\nImplementation report:\n${work}\nReview:\n${opinions[0]}\nDeclared checks:\n${opinions[1]}`,
      {
        label: "decision",
        title: `Stage gate (round ${round})`,
        choice: ["ready", "needs_fix", "blocked"],
        choiceFallback: "blocked",
      },
    );

    const evidence = publishArtifact(
      `round-${round}.md`,
      `Task: ${task}\nRound: ${round}\nVerdict: ${verdict}\n\n## Implementation\n${work}\n\n## Review\n${opinions[0]}\n\n## Declared checks\n${opinions[1]}`,
    );
    log(`Round ${round} verdict: ${verdict}; evidence in round-${round}.md`);

    if (verdict === "ready") {
      phase("commit");
      const committed = await agent(
        `The stage of ${task} passed its gate. Commit exactly the stage's own changes on the current branch with a ` +
          `message naming the task and the stage; do not amend, rebase, push or touch unrelated files. If the tree ` +
          `holds changes that are not part of this stage, commit nothing and say so.\n` +
          `Write the final assigned stage.md through ordinary file tools with the resulting commit, exact owned files and accepted stage summary. Return that complete handoff too.`,
        { label: "commit", title: `Commit the accepted stage (round ${round})` },
      );
      return publishPrimaryArtifact("stage.md", committed);
    }
    if (verdict === "blocked") return { ok: false, status: "blocked", summary: "gate_blocked", evidence };
    if (round === 3) return { ok: false, status: "blocked", summary: "fix_round_cap", evidence };
  }
}
