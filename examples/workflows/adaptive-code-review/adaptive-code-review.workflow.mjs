export const meta = {
  name: "adaptive-code-review",
  description: "Select only justified code and design review assignments, then publish one report.",
  profile: "dataflow-v1",
  inputSchema: {
    type: "object",
    properties: {
      reviewMode: { type: "string", enum: ["adaptive", "full"] },
      task: { type: "string" },
      change: { type: "string" },
      repositoryInstructions: { type: "string" },
      reviewScope: { type: "string" },
    },
    required: ["reviewMode"],
    additionalProperties: false,
  },
  phases: [
    { title: "context", detail: "Resolve the task, change, owners, consumers, impact, and evidence." },
    { title: "selection", detail: "Choose the smallest justified assignment set or honor full mode." },
    { title: "review", detail: "Run independent selected assignments behind one parallel barrier." },
    { title: "synthesis", detail: "Deduplicate evidence and compose the final review document." },
    { title: "publish", detail: "Persist one primary adaptive-code-review.md artifact." },
  ],
  info: [
    {
      title: "Purpose",
      detail: "Review one task/change through code-standard, codebase-design, or both without a fixed lane checklist.",
    },
    {
      title: "Inputs",
      detail:
        "Use --input-json with required reviewMode and optional task, change, repositoryInstructions, and reviewScope strings; omitted context is resolved from repository evidence or requested only when essential.",
    },
    {
      title: "Selection",
      detail:
        "Adaptive mode emits a bounded structured assignment list plus selected/skipped reasons for both lenses; workers receive the explicit context pack and assignment contract.",
    },
    {
      title: "Full review",
      detail:
        "Set reviewMode to full to require at least one code-standard and one codebase-design assignment; callers never author the lane list.",
    },
    {
      title: "Models",
      detail:
        "Assign task and agent through /model-roles; lead calls require task:xhigh and assignment calls require agent:high, with no fallback or provider/model id in source.",
    },
    {
      title: "Compatibility",
      detail:
        "Structured intake and selection require Pi >=1.0.0 and a task-role model on the Pi coding-agent SDK openai-codex Responses route with verified v4 capabilities; incompatible routes fail output-contract-unavailable before prompting.",
    },
    {
      title: "Artifact",
      detail:
        "Synthesis publishes one primary adaptive-code-review.md containing scope, selected and skipped lanes, severity findings, evidence and impact, both skill conclusions, residual risks, and verdict.",
    },
    {
      title: "Continuation",
      detail:
        "Missing essential context creates one actionable awaitOperator handoff; continuation preserves the typed input and supplies a host-authenticated operatorAnswer, while complete no-operator runs never stop for input.",
    },
  ],
};

/** @typedef {"adaptive" | "full"} ReviewMode */
/**
 * @typedef {object} AdaptiveReviewInput
 * @property {ReviewMode} reviewMode
 * @property {string=} task
 * @property {string=} change
 * @property {string=} repositoryInstructions
 * @property {string=} reviewScope
 */
/**
 * @typedef {object} ReviewIntake
 * @property {"ready" | "needs_input"} status
 * @property {ReviewMode} reviewMode
 * @property {string} taskGoal
 * @property {string} changeTarget
 * @property {string} repositoryInstructions
 * @property {string} reviewScope
 * @property {string} changedOwnersAndContracts
 * @property {string} callersAndConsumers
 * @property {string} likelyImpact
 * @property {string} evidenceSources
 * @property {string} missingContextQuestion
 */
/**
 * @typedef {object} ReviewAssignment
 * @property {string} id
 * @property {"code-standard" | "codebase-design"} lens
 * @property {string} question
 * @property {string} scope
 * @property {string} evidenceTargets
 * @property {string} resultContract
 * @property {string} reason
 */
/** @typedef {{disposition: "selected" | "skipped", reason: string}} ReviewLane */
/**
 * @typedef {object} ReviewSelection
 * @property {ReviewMode} mode
 * @property {string} summary
 * @property {ReviewLane} codeStandard
 * @property {ReviewLane} codebaseDesign
 * @property {ReviewAssignment[]} assignments
 */

const INTAKE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "needs_input"] },
    reviewMode: { type: "string", enum: ["adaptive", "full"] },
    taskGoal: { type: "string" },
    changeTarget: { type: "string" },
    repositoryInstructions: { type: "string" },
    reviewScope: { type: "string" },
    changedOwnersAndContracts: { type: "string" },
    callersAndConsumers: { type: "string" },
    likelyImpact: { type: "string" },
    evidenceSources: { type: "string" },
    missingContextQuestion: { type: "string" },
  },
  required: [
    "status",
    "reviewMode",
    "taskGoal",
    "changeTarget",
    "repositoryInstructions",
    "reviewScope",
    "changedOwnersAndContracts",
    "callersAndConsumers",
    "likelyImpact",
    "evidenceSources",
    "missingContextQuestion",
  ],
  additionalProperties: false,
};

const LANE_SCHEMA = {
  type: "object",
  properties: {
    disposition: { type: "string", enum: ["selected", "skipped"] },
    reason: { type: "string" },
  },
  required: ["disposition", "reason"],
  additionalProperties: false,
};

const SELECTION_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["adaptive", "full"] },
    summary: { type: "string" },
    codeStandard: LANE_SCHEMA,
    codebaseDesign: LANE_SCHEMA,
    assignments: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          lens: { type: "string", enum: ["code-standard", "codebase-design"] },
          question: { type: "string" },
          scope: { type: "string" },
          evidenceTargets: { type: "string" },
          resultContract: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "lens", "question", "scope", "evidenceTargets", "resultContract", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["mode", "summary", "codeStandard", "codebaseDesign", "assignments"],
  additionalProperties: false,
};

/**
 * @param {ReviewSelection} selection
 * @param {ReviewMode} requestedMode
 * @returns {ReviewSelection}
 */
function checkedSelection(selection, requestedMode) {
  const ids = selection.assignments.map((assignment) => assignment.id);
  if (ids.some((id, index) => id.trim() === "" || ids.indexOf(id) !== index)) {
    throw new Error("Review assignment ids must be unique and nonblank");
  }
  if (
    selection.summary.trim() === "" ||
    selection.codeStandard.reason.trim() === "" ||
    selection.codebaseDesign.reason.trim() === ""
  ) {
    throw new Error("Review selection summary and lane reasons must be nonblank");
  }
  const hasIncompleteAssignment = selection.assignments.some(
    (assignment) =>
      assignment.question.trim() === "" ||
      assignment.scope.trim() === "" ||
      assignment.evidenceTargets.trim() === "" ||
      assignment.resultContract.trim() === "" ||
      assignment.reason.trim() === "",
  );
  if (hasIncompleteAssignment) {
    throw new Error("Every review assignment must have a complete nonblank contract");
  }
  if (selection.mode !== requestedMode) throw new Error("Review selection mode must match typed input");
  const hasCodeStandard = selection.assignments.some((assignment) => assignment.lens === "code-standard");
  const hasCodebaseDesign = selection.assignments.some((assignment) => assignment.lens === "codebase-design");
  const selectedCodeStandard = selection.codeStandard.disposition === "selected";
  const selectedCodebaseDesign = selection.codebaseDesign.disposition === "selected";
  if (hasCodeStandard !== selectedCodeStandard || hasCodebaseDesign !== selectedCodebaseDesign) {
    throw new Error("Lane dispositions must match the selected assignments");
  }
  if (requestedMode === "full" && (!hasCodeStandard || !hasCodebaseDesign)) {
    throw new Error("Full review mode requires both review lenses");
  }
  return selection;
}

/**
 * @param {ReviewIntake} intake
 * @param {ReviewMode} requestedMode
 * @returns {ReviewIntake}
 */
function checkedIntake(intake, requestedMode) {
  if (intake.reviewMode !== requestedMode) throw new Error("Review intake mode must match typed input");
  const questionIsBlank = intake.missingContextQuestion.trim() === "";
  if (intake.status === "needs_input") {
    if (questionIsBlank) throw new Error("Missing review context requires one nonblank operator question");
    return intake;
  }
  if (!questionIsBlank) throw new Error("Ready review context must not retain an operator question");
  if (
    intake.taskGoal.trim() === "" ||
    intake.changeTarget.trim() === "" ||
    intake.repositoryInstructions.trim() === "" ||
    intake.reviewScope.trim() === "" ||
    intake.changedOwnersAndContracts.trim() === "" ||
    intake.callersAndConsumers.trim() === "" ||
    intake.likelyImpact.trim() === "" ||
    intake.evidenceSources.trim() === ""
  ) {
    throw new Error("Ready review context must provide every explicit context field");
  }
  return intake;
}

/** @param {unknown} value */
function renderJSON(value) {
  return JSON.stringify(value, null, 2);
}

/** @param {ReviewIntake} intake */
function renderIntakeHandoff(intake) {
  return `# Adaptive code review intake\n\n${renderJSON(intake)}`;
}

/**
 * @param {import("../../../extensions/workflows/runtime/workflow-runtime.js").WorkflowDsl} dsl
 * @param {AdaptiveReviewInput} input
 * @param {{readonly operatorAnswer: string}=} context
 */
export default async function runWorkflow(dsl, input, context) {
  const { agent, awaitOperator, log, parallel, phase, publishArtifact, publishPrimaryArtifact } = dsl;
  const inputText = renderJSON(input);
  const operatorAnswer = context !== undefined ? context.operatorAnswer : "No operator answer was supplied.";

  phase("context");
  const intake = checkedIntake(
    /** @type {ReviewIntake} */ (
      await agent(
        `Build the explicit context pack for an adaptive code and codebase-design review.

Typed request:
${inputText}

Host-authenticated operator answer, when this is a continuation:
${operatorAnswer}

Inspect the actual project, Git state, repository instructions, task/change evidence, changed owners and contracts, real callers and consumers, likely downstream impact, and available evidence sources. Resolve omitted fields from source when safe. Preserve the exact reviewMode from typed input. Use status needs_input only when one material fact is still required to choose a trustworthy review scope; then ask one precise question in missingContextQuestion and do not bundle optional questions. Otherwise use status ready and an empty missingContextQuestion. Treat the repository and Git state as read-only: do not edit, create, or delete files; change Git state; install or update dependencies; run write-producing commands or checks; or delegate to another agent. Return only the declared context record.`,
        {
          label: "collect-review-context",
          title: "Collect review context",
          modelRole: "task:xhigh",
          requireModelRole: true,
          schema: INTAKE_SCHEMA,
        },
      )
    ),
    input.reviewMode,
  );

  if (intake.status === "needs_input") {
    const handoff = publishArtifact("adaptive-code-review-intake.md", renderIntakeHandoff(intake));
    awaitOperator({
      reason: "Essential review context is missing",
      operatorHandoff: {
        title: "Complete adaptive review context",
        questions: [
          {
            kind: "text",
            id: "missing-review-context",
            prompt: "Answer the specific missing-context question shown in the verified intake detail.",
            detailArtifactRef: handoff,
          },
        ],
        continuationArtifactRefs: [handoff],
      },
    });
    return handoff;
  }

  const contextText = renderJSON(intake);
  phase("selection");
  const selection = checkedSelection(
    /** @type {ReviewSelection} */ (
      await agent(
        `Select the minimum non-duplicative review assignments justified by this context pack.

Context pack:
${contextText}

In adaptive mode, skip a lens unless a concrete question needs it. In full mode, select both code-standard and codebase-design. Do not emit generic duplicate reviews. Each assignment must have a stable unique id, exactly one lens, one falsifiable question or claim, bounded scope/paths, evidence targets, the worker result contract, and the reason this assignment is necessary. Record a selected or skipped disposition and reason for both lenses. Treat the repository and Git state as read-only: do not edit, create, or delete files; change Git state; install or update dependencies; run write-producing commands or checks; or delegate to another agent. Return only the declared selection record.`,
        {
          label: "select-review-assignments",
          title: "Select review assignments",
          modelRole: "task:xhigh",
          requireModelRole: true,
          schema: SELECTION_SCHEMA,
        },
      )
    ),
    input.reviewMode,
  );

  phase("review");
  const reviews = await parallel(
    selection.assignments.map(
      (assignment) => () =>
        agent(
          `Execute one bounded adaptive review assignment.

Context pack:
${contextText}

Assignment id: ${assignment.id}
Required lens/skill: ${assignment.lens}
Question or claim: ${assignment.question}
Scope and paths: ${assignment.scope}
Evidence targets: ${assignment.evidenceTargets}
Expected result contract: ${assignment.resultContract}
Selection reason: ${assignment.reason}

Resolve the installed skill named by Required lens/skill. Read its complete SKILL.md and every mandatory example or reference it names before reaching conclusions. If any required skill material is unavailable, return BLOCKED with the missing source. Inspect real callers, contracts, ownership boundaries, and downstream impact within the assigned scope. Do not start another general review or delegate to another agent. Treat the repository and Git state as read-only: do not edit, create, or delete files; change Git state; install or update dependencies; or run write-producing commands or checks. Return one self-contained report headed by the assignment id and lens, with FINDINGS, NO_FINDING, or BLOCKED status; severity; concrete repository-resolvable evidence/location; impact; conclusion; residual risk; and explicit limits.`,
          {
            label: "review-assignment",
            title: "Review selected assignment",
            modelRole: "agent:high",
            requireModelRole: true,
            result: "report",
          },
        ),
    ),
    {
      keys: selection.assignments.map((assignment) => assignment.id),
      title: "Selected adaptive review assignments",
    },
  );

  const selectionText = renderJSON(selection);
  const reviewText = reviews.join("\n\n---\n\n");
  log(`Selected ${selection.assignments.length} adaptive review assignment(s).`);

  phase("synthesis");
  const report = await agent(
    `Write the one durable final adaptive code review report.

Context pack:
${contextText}

Structured selection, including selected and skipped reasons:
${selectionText}

Complete report-mode assignment observations:
${reviewText}

Deduplicate shared causes without dropping distinct evidence. Verify decision-critical claims against the actual source, but do not create a new generic review lane. Treat the repository and Git state as read-only: do not edit, create, or delete files; change Git state; install or update dependencies; run write-producing commands or checks; or delegate to another agent. Preserve eligible failed/blocked assignment observations as missing coverage and residual risk; never turn them into a clean result. Return complete standalone Markdown only, with: reviewed scope; selected assignments and skipped lenses with short reasons; findings ordered by severity with assignment id, lens, concrete evidence/location, impact, and simplest justified remedy; code-standard conclusion; codebase-design conclusion or the evidence-backed reason it was skipped; residual risks and limits; and exactly one verdict READY, READY_WITH_RECOMMENDATIONS, CHANGES_REQUIRED, or BLOCKED. The document must remain useful without the workflow transcript.`,
    {
      label: "synthesize-adaptive-review",
      title: "Synthesize adaptive review",
      modelRole: "task:xhigh",
      requireModelRole: true,
    },
  );

  phase("publish");
  return publishPrimaryArtifact("adaptive-code-review.md", report);
}
