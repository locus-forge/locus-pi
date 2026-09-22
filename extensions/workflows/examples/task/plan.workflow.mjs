// task/plan.workflow.mjs
// Grows one checked workflow source through bounded, whole-file-valid slices.

export const meta = {
  name: "task/plan",
  profile: "standard",
  description: "Turn an accepted workflow brief into a checked workflow.mjs through bounded source slices.",
  phases: [
    { title: "design", detail: "Translate and review the accepted workflow graph." },
    { title: "build", detail: "Seed and extend one complete workspace workflow source." },
    { title: "verify", detail: "Check each source slice and final design conformance." },
    { title: "publish", detail: "Publish the checked workspace workflow.mjs." },
  ],
};

const SOURCE_CONTRACT = `The workspace workflow.mjs is the only authoritative source. Every accepted step leaves a complete runnable, Node-parseable and orchestration-only-valid module. Agents edit that file and return only opaque reports or source-free requirement briefs; never return, quote or transport source bytes. The generated source uses unique literal labels, complete prompts, visible bounded control flow and only orchestration-only DSL calls. Preserve the accepted graph, scope and primary contract. Mechanical checks and design review stay separate. Write named diagnostic files in the workspace before returning any failed route. Do not publish partial source.`;

/**
 * @param {import("../../runtime/workflow-runtime.js").WorkflowDsl} dsl
 * @param {string} [input]
 */
export default async function runWorkflow(dsl, input = "") {
  const draftText = input;

  dsl.phase("design");
  const design = await dsl.agent(
    `Translate the accepted draft into a concrete node-and-edge ledger. Name every role, literal label, input, output, consumer, branch, loop bound, failure exit and primary result. Select complete graph nodes or branches as possible source slices. Do not edit files. Return the complete design, not source code.\n\n${SOURCE_CONTRACT}\n\nAccepted draft:\n${draftText}`,
    { label: "workflow-design", title: "Define the accepted workflow graph" },
  );
  const reviewedDesign = await dsl.agent(
    `Independently correct the proposed workflow design. Check every edge, bound, correction path, failure exit and primary output. Remove unused layers and preserve simple fixed graphs when requested. Do not edit files. Return the complete replacement design, not source code.\n\n${SOURCE_CONTRACT}\n\nAccepted draft:\n${draftText}\n\nProposed design:\n${design}`,
    { label: "workflow-design-review", title: "Review the workflow graph" },
  );

  dsl.phase("build");
  const seed = await dsl.agent(
    `Create workspace workflow.mjs from the reviewed design. Start with the smallest complete runnable module that preserves the promised primary contract and can grow by whole graph nodes or branches. Write workflow-source-seed.md with the exact path and edit outcome. Return only the report and paths, never source bytes. The independent checker owns node --check and workflow_check_source evidence.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}`,
    { label: "workflow-source-seed", result: "report", title: "Create a valid workflow source seed" },
  );

  dsl.phase("verify");
  const seedCheck = await dsl.agent(
    `Independently check the exact workspace workflow.mjs before source slicing. Run node --check and workflow_check_source with mode orchestration-only. Confirm that it is runnable and retains the promised primary contract. Do not edit or execute it. Write workflow-source-seed-check.md with exact diagnostics. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nSeed evidence:\n${seed}`,
    { label: "workflow-source-seed-check", result: "report", title: "Gate the workflow source seed" },
  );
  const seedRoute = await dsl.agent(
    `Translate the seed check without rejudging it. Choose passed only when every named check passed; otherwise choose failed.\n\n${seedCheck}`,
    {
      label: "workflow-source-seed-route",
      title: "Route the workflow source seed",
      choice: ["passed", "failed"],
    },
  );
  if (seedRoute !== "passed")
    return {
      ok: false,
      status: "failed",
      stage: "verify",
      reason: "seed_failed",
      source: "workflow.mjs",
      diagnostics: seedCheck,
    };

  /** @type {string[]} */
  let previousQueue = [];
  let lastAccepted = "";

  // The seventh pass may prove completion or expose remaining work, but it cannot
  // implement a seventh slice. Every earlier pass can accept at most one slice.
  for (let accepted = 0; accepted <= 6; accepted += 1) {
    /** @type {string[]} */
    const queue = await dsl.agent(
      `Own the remaining source plan. Read the reviewed design and the actual workspace workflow.mjs. Return the complete remaining queue in execution order as source-free identity and requirements briefs, one complete graph node or branch per item. Preserve unmet identities from the prior queue unless the accepted slice or current file satisfies them. Never include source bytes, quoted source or generated module text. Do not drop requirements to fit the allowance. Return no items only when the actual whole file satisfies every design requirement. Do not edit source.\n\n${SOURCE_CONTRACT}\n\nAccepted slices: ${accepted}; maximum: 6.\nReviewed design:\n${reviewedDesign}\n\nPrior queue identities:\n${previousQueue.join("\n---\n")}\n\nLast accepted evidence:\n${lastAccepted}`,
      { label: "workflow-source-cut", handoffs: {}, title: `Cut remaining source after ${accepted} slices` },
    );
    const queueAssessment = await dsl.agent(
      `Independently compare the proposed source-free queue with the prior queue identities, the reviewed design and the actual workspace workflow.mjs. Confirm that accepted work is present and every unmet prior identity remains represented. An empty queue is not proof of completion. Write workflow-source-queue.md with the identity comparison, completed requirements, remaining requirements and any conflict. Return the report and paths, never source bytes. Do not edit source.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nPrior queue identities:\n${previousQueue.join("\n---\n")}\n\nProposed queue:\n${queue.join("\n---\n")}\n\nLast accepted evidence:\n${lastAccepted}`,
      { label: "workflow-source-queue-assessment", result: "report", title: "Validate the source queue transition" },
    );
    const queueRoute = await dsl.agent(
      `Translate the queue assessment without rejudging it. Choose work for a complete conflict-free non-empty queue. Choose complete only when the actual whole file satisfies every design requirement and the proposed queue is empty. Choose queue_conflict when an unmet identity disappeared, an accepted identity returned, the queue contradicts the file, or completion conflicts with remaining work.\n\n${queueAssessment}`,
      {
        label: "workflow-source-queue-route",
        title: "Route the source queue",
        choice: ["work", "complete", "queue_conflict"],
      },
    );

    if (queueRoute === "queue_conflict")
      return {
        ok: false,
        status: "failed",
        stage: "build",
        reason: "queue_conflict",
        source: "workflow.mjs",
        diagnostics: queueAssessment,
        remaining: queue,
      };

    if (queueRoute === "complete") {
      if (queue.length !== 0)
        return {
          ok: false,
          status: "failed",
          stage: "build",
          reason: "queue_conflict",
          source: "workflow.mjs",
          diagnostics: queueAssessment,
          remaining: queue,
        };

      dsl.phase("verify");
      const finalCheck = await dsl.agent(
        `Perform the final whole-file mechanical gate on workspace workflow.mjs. Run node --check and workflow_check_source with mode orchestration-only. Do not edit or execute source. Write workflow-source-final-check.md with exact diagnostics. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}`,
        { label: "workflow-source-final-check", result: "report", title: "Run the final mechanical source gate" },
      );
      const finalCheckRoute = await dsl.agent(
        `Translate the final mechanical report without rejudging it. Choose passed only when every named check passed; otherwise choose failed.\n\n${finalCheck}`,
        {
          label: "workflow-source-final-check-route",
          title: "Route the final mechanical source gate",
          choice: ["passed", "failed"],
        },
      );
      if (finalCheckRoute !== "passed")
        return {
          ok: false,
          status: "failed",
          stage: "verify",
          reason: "final_check_failed",
          source: "workflow.mjs",
          diagnostics: finalCheck,
        };

      const finalReview = await dsl.agent(
        `Independently inspect the exact workspace workflow.mjs against every reviewed design criterion and the accepted draft. Confirm that the file is more than an incomplete seed, every edge and bound is present, the primary identity is correct, and no source bytes crossed model-answer handoffs. Do not edit or execute source. Write workflow-source-final-review.md with criterion-by-criterion evidence and next action. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nAccepted draft:\n${draftText}\n\nReviewed design:\n${reviewedDesign}\n\nQueue evidence:\n${queueAssessment}`,
        { label: "workflow-source-final-review", result: "report", title: "Review final design conformance" },
      );
      const finalRoute = await dsl.agent(
        `Translate the final review without rejudging it. Choose publish only when every design criterion is evidenced. Choose empty_queue when the queue ended but the file is still only a seed or otherwise incomplete. Choose design_mismatch for any other design conflict.\n\n${finalReview}`,
        {
          label: "workflow-source-final-route",
          title: "Route final design conformance",
          choice: ["publish", "empty_queue", "design_mismatch"],
        },
      );
      if (finalRoute !== "publish")
        return {
          ok: false,
          status: "failed",
          stage: "verify",
          reason: finalRoute,
          source: "workflow.mjs",
          diagnostics: finalReview,
        };

      dsl.phase("publish");
      return dsl.publishPrimaryFile("workflow.mjs");
    }

    if (queue.length === 0)
      return {
        ok: false,
        status: "failed",
        stage: "build",
        reason: "empty_queue",
        source: "workflow.mjs",
        diagnostics: queueAssessment,
      };
    if (accepted === 6)
      return {
        ok: false,
        status: "incomplete",
        stage: "build",
        reason: "slice_allowance",
        source: "workflow.mjs",
        diagnostics: queueAssessment,
        remaining: queue,
      };

    const slice = queue[0];
    dsl.phase("build");
    const work = await dsl.agent(
      `Implement exactly this source slice in the existing workspace workflow.mjs. Read the whole file and reviewed design. Leave one complete runnable, Node-parseable and orchestration-only-valid module; do not rewrite unrelated accepted nodes. Write workflow-source-slice.md with the slice identity, path and edit outcome. Return only the report and paths, never source bytes. The independent checker owns node --check and workflow_check_source evidence.\n\n${SOURCE_CONTRACT}\n\nSlice ${accepted + 1}:\n${slice}\n\nReviewed design:\n${reviewedDesign}`,
      { label: "workflow-source-slice", result: "report", title: `Implement source slice ${accepted + 1}` },
    );

    dsl.phase("verify");
    const mechanical = await dsl.agent(
      `Independently check the exact workspace workflow.mjs after this slice. Run node --check and workflow_check_source with mode orchestration-only. Do not edit or execute source. Write workflow-source-check.md with exact diagnostics. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nSlice evidence:\n${work}`,
      { label: "workflow-source-check", result: "report", title: `Mechanically check source slice ${accepted + 1}` },
    );
    const mechanicalRoute = await dsl.agent(
      `Translate the mechanical check without rejudging it. Choose passed only when every named check passed. Choose fix for every failed check.\n\n${mechanical}`,
      {
        label: "workflow-source-check-route",
        title: "Route the mechanical source check",
        choice: ["passed", "fix"],
      },
    );
    if (mechanicalRoute === "fix") {
      const fixReport = await dsl.agent(
        `Use workflow-source-check.md to fix exactly the failed mechanical contract in workspace workflow.mjs. Preserve accepted graph nodes outside this slice. This consumes the slice's one fix allowance. Write workflow-source-fix.md with the edited path and outcome. Return only the report and paths, never source bytes. The independent checker owns node --check and workflow_check_source evidence.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nFailed check:\n${mechanical}`,
        { label: "workflow-source-fix", result: "report", title: `Fix source slice ${accepted + 1}` },
      );
      const fixCheck = await dsl.agent(
        `Independently recheck the exact fixed workspace workflow.mjs with node --check and workflow_check_source orchestration-only. Do not edit or execute source. Write workflow-source-fix-check.md with exact diagnostics. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nFix evidence:\n${fixReport}`,
        {
          label: "workflow-source-fix-check",
          result: "report",
          title: `Recheck fixed source slice ${accepted + 1}`,
        },
      );
      const fixRoute = await dsl.agent(
        `Translate the fix recheck without rejudging it. Choose passed only when every named check passed; otherwise choose failed.\n\n${fixCheck}`,
        {
          label: "workflow-source-fix-route",
          title: "Route the fixed mechanical source check",
          choice: ["passed", "failed"],
        },
      );
      if (fixRoute !== "passed")
        return {
          ok: false,
          status: "failed",
          stage: "verify",
          reason: "slice_repair_failed",
          source: "workflow.mjs",
          diagnostics: fixCheck,
        };
    }
    const currentMechanicalReport =
      mechanicalRoute === "fix" ? "workflow-source-fix-check.md" : "workflow-source-check.md";

    const designReview = await dsl.agent(
      `Independently inspect the entire current workspace workflow.mjs and this slice against the reviewed design. Read the exact current mechanical evidence from workspace ${currentMechanicalReport}. Check that the accepted identity is implemented, existing nodes remain correct, every handoff is visible, and the module stays runnable. Do not edit or execute source. Write workflow-source-design-review.md with criterion evidence and exact fix guidance. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nSlice:\n${slice}\n\nReviewed design:\n${reviewedDesign}`,
      { label: "workflow-source-review", result: "report", title: `Review source slice ${accepted + 1}` },
    );
    const designRoute = await dsl.agent(
      `Translate the design review without rejudging it. Choose accept only when the slice and whole file conform. Choose fix for a correctable in-scope mismatch. Choose failed for a scope conflict or design mismatch that cannot be corrected within the accepted graph.\n\n${designReview}`,
      {
        label: "workflow-source-review-route",
        title: "Route source design review",
        choice: ["accept", "fix", "failed"],
      },
    );
    if (designRoute === "failed")
      return {
        ok: false,
        status: "failed",
        stage: "verify",
        reason: "design_mismatch",
        source: "workflow.mjs",
        diagnostics: designReview,
      };
    if (designRoute === "fix") {
      if (mechanicalRoute === "fix")
        return {
          ok: false,
          status: "failed",
          stage: "verify",
          reason: "slice_repair_failed",
          source: "workflow.mjs",
          diagnostics: designReview,
        };
      const designFix = await dsl.agent(
        `Use workflow-source-design-review.md to fix exactly the in-scope design mismatch in workspace workflow.mjs. Preserve accepted nodes outside this slice. This consumes the slice's one fix allowance. Write workflow-source-design-fix.md with the edited path and outcome. Return only the report and paths, never source bytes. The independent checker owns node --check and workflow_check_source evidence.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nDesign findings:\n${designReview}`,
        {
          label: "workflow-source-design-fix",
          result: "report",
          title: `Fix source design slice ${accepted + 1}`,
        },
      );
      const designFixCheck = await dsl.agent(
        `Independently run node --check and workflow_check_source orchestration-only on the fixed workspace workflow.mjs. Do not edit or execute source. Write workflow-source-design-fix-check.md with exact diagnostics. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nFix evidence:\n${designFix}`,
        {
          label: "workflow-source-design-fix-check",
          result: "report",
          title: `Mechanically recheck design fix ${accepted + 1}`,
        },
      );
      const designFixRoute = await dsl.agent(
        `Translate the fixed mechanical check without rejudging it. Choose passed only when every named check passed; otherwise choose failed.\n\n${designFixCheck}`,
        {
          label: "workflow-source-design-fix-route",
          title: "Route the design fix mechanical check",
          choice: ["passed", "failed"],
        },
      );
      if (designFixRoute !== "passed")
        return {
          ok: false,
          status: "failed",
          stage: "verify",
          reason: "slice_repair_failed",
          source: "workflow.mjs",
          diagnostics: designFixCheck,
        };
      const designRecheck = await dsl.agent(
        `Independently recheck the fixed whole workspace workflow.mjs against the reviewed design and this slice. Do not edit or execute source. Write workflow-source-design-recheck.md with criterion evidence. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nSlice:\n${slice}\n\nReviewed design:\n${reviewedDesign}\n\nFix evidence:\n${designFix}`,
        {
          label: "workflow-source-design-recheck",
          result: "report",
          title: `Recheck fixed source design ${accepted + 1}`,
        },
      );
      const designRecheckRoute = await dsl.agent(
        `Translate the independent design recheck without rejudging it. Choose accept only for complete conformance; otherwise choose failed.\n\n${designRecheck}`,
        {
          label: "workflow-source-design-recheck-route",
          title: "Route fixed source design",
          choice: ["accept", "failed"],
        },
      );
      if (designRecheckRoute !== "accept")
        return {
          ok: false,
          status: "failed",
          stage: "verify",
          reason: "design_mismatch",
          source: "workflow.mjs",
          diagnostics: designRecheck,
        };
      lastAccepted = designRecheck;
    } else {
      lastAccepted = designReview;
    }

    previousQueue = queue;
  }
}
