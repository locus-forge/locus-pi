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

const SOURCE_CONTRACT = `Before seed creation, the accepted draft supplies the requirements and workspace workflow.mjs is expected to be absent. After the seed is created, workspace workflow.mjs is the only authoritative source artifact. Every accepted source step leaves a complete runnable, Node-parseable and orchestration-only-valid module. Agents edit that file and return only opaque reports or source-free requirement briefs; never return, quote or transport source bytes. The generated source uses unique literal labels, complete prompts, visible bounded control flow and only orchestration-only DSL calls. Never inspect, compare or transform opaque agent answers in source control flow, regex gates or computed return text; route with runtime-owned exact choices, list identity, status or counters, and forward opaque answers whole inside later agent prompts or exact text publication. Preserve the accepted scope and primary output identity while growing the reviewed graph; seed and intermediate source may still lack listed graph nodes or branches. The final source must implement the complete reviewed graph. Mechanical checks and design review stay separate. Write named diagnostic files in the workspace before returning any failed route. Do not publish partial source.`;

const SOURCE_EDIT_PREFLIGHT = `After writing workspace workflow.mjs, run node --check and workflow_check_source with mode orchestration-only on that exact file. If either reports an error, correct the file within this editor call and check again; use at most two local edit-check passes total. Report both check outcomes, remaining diagnostics and edited paths without source bytes. These are writer preflight checks; the independent checker repeats them and alone accepts or rejects the source.`;

/**
 * @param {import("../../../extensions/workflows/runtime/workflow-runtime.js").WorkflowDsl} dsl
 * @param {string} [input]
 */
export default async function runWorkflow(dsl, input = "") {
  const draftText = input;

  dsl.phase("design");
  const design = await dsl.agent(
    `Translate the accepted draft into a concrete node-and-edge ledger. This design stage runs before seed creation: workspace workflow.mjs is expected to be absent and is not a precondition. Use the accepted draft, not an existing source file, to name every role, literal label, input, output, consumer, branch, loop bound, failure exit and primary result. Select complete graph nodes or branches as possible source slices. Do not edit files. Return the complete design, not source code.\n\n${SOURCE_CONTRACT}\n\nAccepted draft:\n${draftText}`,
    { label: "workflow-design", title: "Define the accepted workflow graph" },
  );
  const reviewedDesign = await dsl.agent(
    `Independently correct the proposed workflow design against the accepted draft. The source seed has not been created yet; absence of workspace workflow.mjs is expected and must not block this design review. Check every edge, bound, correction path, failure exit and primary output. Remove unused layers and preserve simple fixed graphs when requested. Do not edit files. Return the complete replacement design, not source code.\n\n${SOURCE_CONTRACT}\n\nAccepted draft:\n${draftText}\n\nProposed design:\n${design}`,
    { label: "workflow-design-review", title: "Review the workflow graph" },
  );

  dsl.phase("build");
  const seed = await dsl.agent(
    `Create workspace workflow.mjs directly as a file from the reviewed design. No prior workflow.mjs is required; this stage owns its first creation in the workflow workspace. Do not launch another workflow or require a saved workflow registration to create the file. Use standard orchestration-only source shape: a literal top-level export const meta with profile "standard", one default async runWorkflow(dsl, input) export, and only supported dsl methods; every dsl.agent call has a unique literal label. Do not use top-level agent/text globals, unlabeled calls, regex policy routes or unsupported expressions. Start with the smallest complete runnable module that preserves the primary output identity and product scope and can grow by whole graph nodes or branches. It may omit later reviewed graph nodes, bounds and review paths, but must not contradict them. For an adaptive design, a temporary single-slice route must not claim final success while the bounded queue is absent; use a fail-closed incomplete route until that graph is built. Write workflow-source-seed.md with the exact path, edit outcome, preserved primary output, and a source-free list of every reviewed graph requirement still missing from this seed. Return only the report and paths, never source bytes. ${SOURCE_EDIT_PREFLIGHT}\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}`,
    { label: "workflow-source-seed", result: "report", title: "Create a valid workflow source seed" },
  );

  dsl.phase("verify");
  const seedCheck = await dsl.agent(
    `Independently check the exact workspace workflow.mjs as a starting seed, not as the final reviewed graph. Run node --check and workflow_check_source with mode orchestration-only. Pass the seed gate only if those checks pass, the module has a runnable route aimed at the reviewed primary output in the declared product scope, and it has no graph contradiction that prevents later source slices. A temporary single-slice route is remaining adaptive graph work if it fails closed rather than claiming final success; the final whole-file review requires the complete bounded route. Missing reviewed nodes, bounds, review and correction paths are remaining source work, not seed-gate failures, when the seed report names them and the current file confirms the gap. Compare the seed report with the actual file and reviewed design. Write workflow-source-seed-check.md with explicit seed gate passed/failed evidence and a separate source-free remaining graph work list. Do not edit or execute source. Return the report and paths, never source bytes. Full design conformance belongs to the source queue and final review.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nSeed evidence:\n${seed}`,
    { label: "workflow-source-seed-check", result: "report", title: "Gate the workflow source seed" },
  );
  const seedRoute = await dsl.agent(
    `Translate the seed gate without rejudging it. Choose passed only when its mechanical, primary-output, scope and noncontradiction checks explicitly passed. A separate list of missing reviewed graph nodes is work for source slices and does not fail this seed gate. Choose failed for any failed seed check or absent gate evidence.\n\n${seedCheck}`,
    {
      label: "workflow-source-seed-route",
      title: "Route the workflow source seed",
      choice: ["passed", "failed"],
    },
  );
  if (seedRoute !== "passed") {
    const seedFix = await dsl.agent(
      `Use the failed seed check to repair exactly its defects in the existing workspace workflow.mjs once. If the file is absent, do not create it here; report that seed creation failed. Otherwise restore standard orchestration-only grammar, the primary output and scope, and a runnable noncontradictory starting route. A partial adaptive route may remain only if it fails closed instead of claiming final success; list its missing graph nodes for later source slices. Preserve source outside the failed criteria. Write workflow-source-seed-fix.md with path, exact edit outcome and remaining source work. Return only report and paths, never source bytes. ${SOURCE_EDIT_PREFLIGHT}\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nFailed seed check:\n${seedCheck}`,
      { label: "workflow-source-seed-fix", result: "report", title: "Repair the source seed once" },
    );
    const seedFixCheck = await dsl.agent(
      `Independently recheck the exact workspace workflow.mjs after the one seed fix. Run node --check and workflow_check_source with mode orchestration-only. Verify the primary output, product scope and a runnable noncontradictory starter route against the reviewed design; missing later graph nodes must be listed, not mistaken for a completed final source. If the file is still absent or any seed criterion fails, report failure. Do not edit or execute source. Write workflow-source-seed-fix-check.md with exact diagnostics and a source-free remaining-work list. Return only report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nInitial failure:\n${seedCheck}\n\nFix evidence:\n${seedFix}`,
      { label: "workflow-source-seed-fix-check", result: "report", title: "Recheck the repaired source seed" },
    );
    const seedFixRoute = await dsl.agent(
      `Translate the independent seed fix check without rejudging it. Choose passed only when every seed criterion now passes; otherwise choose failed. Remaining graph work alone is not a seed failure.\n\n${seedFixCheck}`,
      {
        label: "workflow-source-seed-fix-route",
        title: "Route the repaired source seed",
        choice: ["passed", "failed"],
      },
    );
    if (seedFixRoute !== "passed")
      return {
        ok: false,
        status: "failed",
        stage: "verify",
        reason: "seed_failed",
        source: "workflow.mjs",
        diagnostics: seedFixCheck,
      };
  }

  /** @type {string[]} */
  let previousQueue = [];
  let lastAccepted = "";

  // The seventh pass may prove completion or expose remaining work, but it cannot
  // implement a seventh slice. Every earlier pass can accept at most one slice.
  for (let accepted = 0; accepted <= 6; accepted += 1) {
    /** @type {string[]} */
    const proposedQueue = await dsl.agent(
      `Own the remaining source plan. Read the reviewed design and the actual workspace workflow.mjs. Use the seed check's remaining-work list as baseline evidence; if workflow-source-seed-fix-check.md exists, its later report supersedes that initial check. Re-evaluate either report against the current file on every pass. Return the complete remaining queue in execution order as source-free identity and requirements briefs, one missing or defective node or branch in workspace workflow.mjs per item. These are edits to the workflow source graph, not the product implementation slices that the generated workflow will later execute. A node present in the file but missing required control flow remains work. On the first pass, an empty prior queue and no accepted evidence are the expected baseline. On later passes, preserve unmet identities from the prior queue unless the accepted slice or current file satisfies them. Never include source bytes, quoted source or generated module text. Do not drop requirements to fit the allowance. Return no items only when the actual whole file satisfies every design requirement. Do not edit source.\n\n${SOURCE_CONTRACT}\n\nAccepted slices: ${accepted}; maximum: 6.\nReviewed design:\n${reviewedDesign}\n\nInitial seed check baseline (recheck against current file):\n${seedCheck}\n\nPrior queue identities:\n${previousQueue.join("\n---\n")}\n\nLast accepted evidence:\n${lastAccepted}`,
      { label: "workflow-source-cut", handoffs: {}, title: `Cut remaining source after ${accepted} slices` },
    );
    const proposedAssessment = await dsl.agent(
      `Independently compare the proposed source-free queue with the prior queue identities, the reviewed design and the actual workspace workflow.mjs. On the first pass, no prior identities or accepted evidence exist; do not treat that baseline as a conflict. On later passes, confirm that accepted work is present and every unmet prior identity remains represented. Compare proposed items to missing or defective workflow.mjs graph nodes and branches, not the product slices executed by that graph. A source node whose prompt mentions failure but has no required route is not complete. An empty queue is not proof of completion. Write workflow-source-queue.md with the identity comparison, completed requirements, remaining requirements and any conflict. Return the report and paths, never source bytes. Do not edit source.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nPrior queue identities:\n${previousQueue.join("\n---\n")}\n\nProposed queue:\n${proposedQueue.join("\n---\n")}\n\nLast accepted evidence:\n${lastAccepted}`,
      { label: "workflow-source-queue-assessment", result: "report", title: "Validate the source queue transition" },
    );
    const proposedRoute = await dsl.agent(
      `Translate the queue assessment without rejudging it. Choose work for a complete conflict-free non-empty queue. Choose complete only when the actual whole file satisfies every design requirement and the proposed queue is empty. Choose queue_conflict when an unmet source identity disappeared, an accepted identity returned, the queue contradicts the file or reviewed graph, or completion conflicts with remaining work. An empty prior queue on the first pass is expected and is not a conflict.\n\n${proposedAssessment}`,
      {
        label: "workflow-source-queue-route",
        title: "Route the source queue",
        choice: ["work", "complete", "queue_conflict"],
      },
    );

    const queue = await dsl.agent(
      `Reconcile the source-free queue once using the independent assessment. When the assessment finds no conflict, preserve the proposed queue's identities and order exactly. When it finds a conflict, correct the complete remaining queue using the report. Return edits to workflow.mjs, one missing or defective graph node or branch per item; do not return product implementation slices when those stages already exist in source. Preserve genuinely unmet prior identities and add omitted source-control work. On the first pass there are no prior identities to preserve. Do not edit source or return source bytes. If the conflict cannot be resolved, leave the mismatch visible for independent recheck; do not claim completion.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nInitial route:\n${proposedRoute}\n\nPrior queue identities:\n${previousQueue.join("\n---\n")}\n\nProposed queue:\n${proposedQueue.join("\n---\n")}\n\nAssessment:\n${proposedAssessment}`,
      { label: "workflow-source-queue-repair", handoffs: {}, title: "Reconcile the source queue once" },
    );
    const queueAssessment = await dsl.agent(
      `Independently recheck the reconciled source-free queue against the reviewed design, actual workspace workflow.mjs, prior identities, and first assessment. On the first pass an empty prior queue is expected. Confirm that every unmet source graph node or branch is represented, no completed identity returned, and the queue names source edits rather than product implementation slices. When the first assessment found no conflict, also confirm the proposed queue's identities and order were preserved. A prompt mentioning failure is not an explicit failure route. An empty queue is not proof of completion. Write workflow-source-queue-recheck.md with exact evidence and any remaining conflict. Do not edit source or return source bytes.\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nPrior queue identities:\n${previousQueue.join("\n---\n")}\n\nProposed queue:\n${proposedQueue.join("\n---\n")}\n\nReconciled queue:\n${queue.join("\n---\n")}\n\nInitial route:\n${proposedRoute}\n\nFirst assessment:\n${proposedAssessment}`,
      { label: "workflow-source-queue-recheck", result: "report", title: "Recheck the reconciled source queue" },
    );
    const queueRoute = await dsl.agent(
      `Translate the independent queue recheck without rejudging it. Choose work only for a complete conflict-free non-empty source queue. Choose complete only when the actual whole file satisfies every design requirement and the reconciled queue is empty. Otherwise choose queue_conflict. Do not treat the first pass's empty prior queue as a conflict.\n\n${queueAssessment}`,
      {
        label: "workflow-source-queue-recheck-route",
        title: "Route the reconciled source queue",
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
      `Implement exactly this source slice in the existing workspace workflow.mjs. Read the whole file and reviewed design. Leave one complete runnable, Node-parseable and orchestration-only-valid module; do not rewrite unrelated accepted nodes. Write workflow-source-slice.md with the slice identity, path and edit outcome. Return only the report and paths, never source bytes. ${SOURCE_EDIT_PREFLIGHT}\n\n${SOURCE_CONTRACT}\n\nSlice ${accepted + 1}:\n${slice}\n\nReviewed design:\n${reviewedDesign}`,
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
        `Use workflow-source-check.md to fix exactly the failed mechanical contract in workspace workflow.mjs. Preserve accepted graph nodes outside this slice. This consumes the slice's one mechanical fix allowance; a later distinct design defect may use one design fix after independent review. Write workflow-source-fix.md with the edited path and outcome. Return only the report and paths, never source bytes. ${SOURCE_EDIT_PREFLIGHT}\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nFailed check:\n${mechanical}`,
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
      `Independently inspect the entire current workspace workflow.mjs for the effects of this slice. Read the exact current mechanical evidence from workspace ${currentMechanicalReport}. Check that this slice’s accepted identity is implemented, previously accepted nodes remain correct, every handoff for this slice is visible, and the module stays runnable. Identify unmet design requirements as remaining work for the next source queue; their absence is not a defect in this slice. Do not edit or execute source. Write workflow-source-design-review.md with slice criterion evidence, remaining work, and exact fix guidance for any defect in this slice or regression. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nSlice:\n${slice}\n\nReviewed design:\n${reviewedDesign}`,
      { label: "workflow-source-review", result: "report", title: `Review source slice ${accepted + 1}` },
    );
    const designRoute = await dsl.agent(
      `Translate the slice design review without rejudging it. Choose accept when this slice conforms, previously accepted work remains correct, and the whole module remains runnable, even if later design requirements remain in the source queue. Choose fix for a correctable defect in this slice or regression of accepted work. Choose failed for a scope conflict or mismatch that cannot be corrected within the accepted graph. The final whole-file review alone decides whether the complete design may be published.\n\n${designReview}`,
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
      const designFix = await dsl.agent(
        `Use workflow-source-design-review.md to fix exactly the in-scope design mismatch in workspace workflow.mjs. Preserve accepted nodes outside this slice. This consumes the slice's one design fix allowance, whether or not a separate mechanical fix was used. Write workflow-source-design-fix.md with the edited path and outcome. Return only the report and paths, never source bytes. ${SOURCE_EDIT_PREFLIGHT}\n\n${SOURCE_CONTRACT}\n\nReviewed design:\n${reviewedDesign}\n\nDesign findings:\n${designReview}`,
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
        `Independently recheck the fixed slice and its effects on the whole workspace workflow.mjs. Confirm this slice conforms, previously accepted nodes remain correct, and the module stays runnable. Record unmet future design requirements for the next source queue; do not require them to be implemented in this slice. Do not edit or execute source. Write workflow-source-design-recheck.md with slice criterion evidence and remaining work. Return the report and paths, never source bytes.\n\n${SOURCE_CONTRACT}\n\nSlice:\n${slice}\n\nReviewed design:\n${reviewedDesign}\n\nFix evidence:\n${designFix}`,
        {
          label: "workflow-source-design-recheck",
          result: "report",
          title: `Recheck fixed source design ${accepted + 1}`,
        },
      );
      const designRecheckRoute = await dsl.agent(
        `Translate the independent slice design recheck without rejudging it. Choose accept when this slice and previously accepted work conform and the whole module remains runnable; future queued requirements need not be complete. Otherwise choose failed.\n\n${designRecheck}`,
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
