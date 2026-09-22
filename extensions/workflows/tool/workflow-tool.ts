/**
 * Native workflow schema, approval, command-launcher dispatch and terminal result.
 * Cards own tool-call hierarchy; command widgets and overlays remain in /workflows.
 */

import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  type ExtensionAPI,
  type ThemeLike,
  type ToolRenderContext,
  type ToolRenderResultOptions,
  type ToolResult,
  errorResult,
  getProjectRoot,
  getWorkingDirectory,
  isOneShotHostMode,
  registerToolWithErrorResults,
  textResult,
} from "../../_shared/host/pi-api.js";
import { prepareValidatedParams, validateParams } from "../../_shared/host/validation.js";
import { formatWorkflowFailureDiagnosticLines } from "../runtime/workflow-failure.js";
import { applyWorkflowJournalLineToAgentLiveStore } from "../runtime/workflow-live.js";
import { runWorkflowScript, type RunWorkflowScriptResult } from "../runtime/workflow-runner.js";
import { readWorkflowResumeWorkspaceIdentity } from "../runtime/workflow-run-resume.js";
import { resolveWorkflowTarget, type ResolvedWorkflowTarget } from "../runtime/workflow-discovery.js";
import { WORKFLOW_SAVED_NAME_MAX_CHARS, WORKFLOW_SAVED_NAME_PATTERN } from "../runtime/workflow-saved-name.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import {
  WORKFLOW_RUN_NAME_MAX_CHARS,
  WORKFLOW_RUN_NAME_PATTERN,
  resolveNamedWorkflowWorkspacePath,
  resolveWorkflowOutputDirectoryPath,
} from "../runtime/workflow-output.js";
import {
  formatOperatorScriptIdentity,
  safeOperatorSourceRef,
  workflowResultDisposition,
  type OperatorScriptIdentityInput,
} from "../operator/operator-ui.js";
import { renderAgentLiveRowsText } from "../operator/progress-widget.js";
import {
  EmptyWorkflowToolCallComponent,
  renderWorkflowToolCard,
  snapshotWorkflowToolCardAgents,
  type WorkflowToolCardAgent,
  type WorkflowToolCardStatus,
} from "./workflow-tool-card.js";
import type { WorkflowCommandLauncher } from "../launch/workflow-command-launcher.js";
import { createWorkflowTranscript } from "../transcript/workflow-transcript.js";
import {
  readWorkflowRunTextFile,
  WORKFLOW_NESTED_RUN_STORAGE_PATTERN,
  WORKFLOW_RUN_GROUP_STORAGE_PATTERN,
  WORKFLOW_ARTIFACT_DISPLAY_NAME_PATTERN,
  WORKFLOW_SAFE_COMPONENT_PATTERN,
  WORKFLOW_WORKSPACES_STORAGE_PREFIX,
  workflowRunOutputsDir,
} from "../runtime/workflow-run-layout.js";
import {
  resolveWorkflowBudget,
  WORKFLOW_BUDGET_AXES,
  removedWorkflowBudgetKeyMessage,
  WORKFLOW_AGENT_MAX_TURNS,
} from "../runtime/workflow-budget.js";
const WorkflowBudgetParams = Type.Object(
  {
    concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    totalAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    runtimeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    // No policy ceiling: a long explicit deadline runs as a chain of representable
    // waits, so the only bound left is what a number can be.
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    toolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    turns: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_AGENT_MAX_TURNS })),
  },
  { additionalProperties: false },
);
const WorkflowArtifactRefParams = Type.Object(
  {
    runId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    artifactId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    // `artifactId` is the storage id; `name` is the published display label, so it
    // carries confinement (no path separators, no control characters, not blank) and
    // no alphabet or length policy. `Design review.md` is a valid continuation ref.
    name: Type.String({
      description: "Published artifact display label, exactly as the origin run recorded it",
      pattern: WORKFLOW_ARTIFACT_DISPLAY_NAME_PATTERN,
    }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

const WorkflowContinuationParams = Type.Object(
  {
    originRunId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    // At least one ref, and no upper bound: a continuation carries the work the origin
    // run actually produced, and refusing the ninth complete reference would drop evidence
    // the operator already paid for. Identity, completeness and same-origin stay enforced.
    artifactRefs: Type.Array(WorkflowArtifactRefParams, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const WorkflowParams = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        description:
          "Exact saved workflow ref: <workflow> or <workflow>/<child>, 1-200 characters total, interior whitespace allowed, with no edge whitespace, backslash, control characters, or .mjs suffix",
        maxLength: WORKFLOW_SAVED_NAME_MAX_CHARS,
        pattern: WORKFLOW_SAVED_NAME_PATTERN,
      }),
    ),
    // No aggregate character cap on a path. Confinement (inside the project, no
    // traversal, no symlink escape) is the real rule, and the filesystem owns the
    // component and path-length limits — a deep but legal tree is not a bad request.
    scriptPath: Type.Optional(
      Type.String({
        description: "Project-relative .mjs workflow script path",
      }),
    ),
    script: Type.Optional(
      Type.String({
        description: "Legacy compatibility alias for name or project-relative scriptPath",
      }),
    ),
    input: Type.Optional(
      Type.String({
        description: "Optional human semantic request passed unchanged to runWorkflow(dsl, input).",
      }),
    ),
    items: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional exact text work units exposed unchanged and in order through dsl.items(); empty strings and duplicates are preserved.",
      }),
    ),
    outputDir: Type.Optional(
      Type.String({
        description:
          "Optional workflow workspace path. Fresh workflows default to unique .locus-pi/workspaces/<generated-run-name> workspaces; resume repeats the source workspace. Existing legacy .locus-pi/plans/<name> paths are accepted only when already present. A task artifacts directory such as .tasks/<task>/artifacts is a legal explicit workspace. Absolute paths must stay inside the project; ./ paths resolve from the agent working directory; other relative paths resolve from the project root.",
      }),
    ),
    runName: Type.Optional(
      Type.String({
        maxLength: WORKFLOW_RUN_NAME_MAX_CHARS,
        pattern: WORKFLOW_RUN_NAME_PATTERN,
        description: `Optional short workflow run name. The runtime expands new names to ${WORKFLOW_WORKSPACES_STORAGE_PREFIX}<runName> and reuses an existing legacy-only .locus-pi/plans/<runName>. Mutually exclusive with outputDir.`,
      }),
    ),
    continuation: Type.Optional(WorkflowContinuationParams),
    budget: Type.Optional(WorkflowBudgetParams),
    recoverInterrupted: Type.Optional(
      Type.Boolean({
        description:
          "Explicit recovery of a confirmed serial prefix after hard crash; requires resumeFromRunId and identical source/inputs.",
      }),
    ),
    resumeFromRunId: Type.Optional(
      Type.String({
        description: "Optional prior workflow run id used as persisted retry metadata",
        pattern: WORKFLOW_SAFE_COMPONENT_PATTERN,
      }),
    ),
    noOperator: Type.Optional(
      Type.Boolean({
        description:
          "Run-level no-operator mode for unattended launches: any request for operator input " +
          "(dsl.awaitOperator or an agent({ ask: true }) stage) fails closed with a named reason " +
          "instead of pausing the run. Saved children inherit the mode and cannot unset it. " +
          "Defaults to true in a headless (print/json) host, where no operator can be reached; " +
          "pass false there to keep the designed awaitOperator split-run pause.",
      }),
    ),
  },
  { additionalProperties: false },
);

function workflowApprovalDetails(args: unknown, projectRoot: string): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const target = String(record.name ?? record.scriptPath ?? record.script ?? "unspecified");
  let workspace: string;
  if (typeof record.outputDir === "string") {
    workspace = record.outputDir;
  } else if (typeof record.resumeFromRunId === "string") {
    try {
      workspace = readWorkflowResumeWorkspaceIdentity(projectRoot, record.resumeFromRunId).relativePath;
    } catch (error) {
      workspace =
        `recorded source workspace unavailable for run ${record.resumeFromRunId}: ` +
        `${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (typeof record.runName === "string") {
    try {
      workspace = resolveNamedWorkflowWorkspacePath(projectRoot, record.runName);
    } catch (error) {
      workspace = `selection blocked: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    workspace = `${WORKFLOW_WORKSPACES_STORAGE_PREFIX}<generated-run-name>`;
  }
  const declaredBudget =
    record.budget !== null && typeof record.budget === "object"
      ? (record.budget as Parameters<typeof resolveWorkflowBudget>[0])
      : undefined;
  const resolvedBudget = declaredBudget && resolveWorkflowBudget(declaredBudget).budget;
  return [
    `Workflow: ${target}`,
    `Items: ${Array.isArray(record.items) ? String(record.items.length) : "none"}`,
    `Workflow workspace: ${workspace}`,
    ...(declaredBudget !== undefined && Object.keys(declaredBudget).length > 0
      ? [
          `Budget overrides: ${WORKFLOW_BUDGET_AXES.filter((axis) => declaredBudget?.[axis] !== undefined)
            .map((axis) => `${axis}=${resolvedBudget?.[axis]}`)
            .join(" ")}; other axes use launch defaults`,
        ]
      : []),
    ...(record.recoverInterrupted === true
      ? ["Recovery: explicit hard-crash recovery of a confirmed serial prefix; no unresolved child effects allowed"]
      : []),
    "Surface: trusted-file workflow runner",
    "Trust: reviewed JavaScript with full Node.js/module access in the Pi host process",
    "Isolation: none — exec approval is consent, not a sandbox",
  ];
}

/** First removed budget option named by a raw tool argument object, if any. */
function removedWorkflowBudgetKeyName(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const budget = (params as { budget?: unknown }).budget;
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) return undefined;
  return Object.entries(budget as Record<string, unknown>).find(
    ([key, value]) => value !== undefined && removedWorkflowBudgetKeyMessage(key) !== undefined,
  )?.[0];
}

export interface WorkflowToolDependencies {
  commandLauncher: WorkflowCommandLauncher;
  /** Records a started run id so this session owns the questions that run publishes. */
  onRunStarted: (runId: string) => void;
  /** Records a settled run id so the session can prune its live rows later. */
  onRunCompleted: (runId: string) => void;
}

export function registerWorkflowTool(pi: ExtensionAPI, deps: WorkflowToolDependencies): void {
  const { commandLauncher } = deps;
  let approvalProjectRoot = process.cwd();
  pi.on("session_start", (_event, ctx) => {
    approvalProjectRoot = getProjectRoot(ctx);
  });
  registerToolWithErrorResults(pi, {
    name: "workflow",
    label: "workflow",
    description:
      `Run a reviewed trusted-file workflow script by saved name or project-relative path with an optional explicit shared budget, optional semantic text, ` +
      `optional exact text work units exposed through dsl.items(), an optional confined workflow workspace, and optional host-verified continuation artifacts. ` +
      `Fresh workflows default to unique .locus-pi/workspaces/<generated-run-name> workspaces; runName selects .locus-pi/workspaces/<runName> for new names and ` +
      `reuses an existing legacy-only .locus-pi/plans/<runName>; resume repeats the original workspace. Root evidence is stored under ` +
      `${WORKFLOW_RUN_GROUP_STORAGE_PATTERN}{outputs,runtime}; saved children and resume attempts use ${WORKFLOW_NESTED_RUN_STORAGE_PATTERN}{outputs,runtime}. ` +
      `The saved JavaScript executes with full Node.js/module access in the Pi host process; it is not sandboxed, and exec approval is consent rather than ` +
      `capability isolation. A canonical folder <name>/ may own <name>.workflow.mjs plus direct child entries addressable as <name>/<child>, or may be group-only ` +
      `with direct children and no runnable root; the nearest Project namespace wins as a whole, then User, then Package. Existing flat Project/User files remain ` +
      `standalone compatibility entries. The DSL orchestrates sub-agents; bare agent() starts a clean child, while an explicit agent name selects a project or ` +
      `user profile. agent() returns exact non-empty child text or a runtime-owned exact choice, while parallel/pipeline provide fail-closed grouping. A root may ` +
      `invoke one source-bound sibling with invokeWorkflow({ child }); child work shares cancellation, concurrency, physical-call budget, workspace, and durable ` +
      `item checkpoints. Legacy script strings normalize to name or path; arbitrary inline JavaScript is not supported. To AUTHOR a new workflow, use the ` +
      `packaged \`locus-pi-workflow-create\` skill: a raw request writes and reviews .locus-pi/workflows/<name>/<name>.design.md before writing exactly the ` +
      `design-declared entries in the same turn (a declared \`runnable root\` includes the root; \`group-only\` omits it); explicit design-only wording pauses ` +
      `before source, while \`Build design: <exact path>\` and \`Build approved design: <exact path>\` remain build-only forms. Create-only stops at checked source; authorized create-and-run hands it to locus-pi-workflow-run for execution and terminal evidence. ` +
      ` Substantive implementation defaults to adaptive slices with owner re-cutting and outcome-led briefs; fixed graphs are explicit alternatives. The contract is skills/locus-pi-workflow-create/SKILL.md → skills/locus-pi-workflow-create/references/source-boundary.md → docs/workflows/index.md.`,
    parameters: WorkflowParams,
    prepareArguments: (args) => prepareValidatedParams(WorkflowParams, args),
    approval: "exec",
    formatApprovalDetails: (args) => workflowApprovalDetails(args, approvalProjectRoot),
    renderShell: "self",
    renderCall: () => new EmptyWorkflowToolCallComponent(),
    renderResult: renderWorkflowToolResultCard,
    async execute(_toolCallId, params, signal, update, ctx) {
      // BEFORE the schema, because the schema's closed key set would answer a removed
      // budget option with "unexpected property" — true, and useless. The runtime has
      // one named sentence per removed key saying what replaced it; a caller that
      // reaches this surface deserves the same sentence rather than a shape complaint.
      const removedBudgetKey = removedWorkflowBudgetKeyName(params);
      if (removedBudgetKey !== undefined) {
        return errorResult(`workflow: ${removedWorkflowBudgetKeyMessage(removedBudgetKey)!}`, { owner: "workflows" });
      }
      const valid = validateParams(WorkflowParams, params);
      if (!valid.ok) return valid.result;
      const targetFields = [valid.value.name, valid.value.scriptPath, valid.value.script].filter(
        (v) => v !== undefined,
      );
      if (targetFields.length !== 1)
        return errorResult("workflow: exactly one of name, scriptPath, or script is required", { owner: "workflows" });
      if (valid.value.recoverInterrupted === true && valid.value.resumeFromRunId === undefined)
        return errorResult("workflow: recoverInterrupted requires resumeFromRunId", { owner: "workflows" });
      if (valid.value.continuation !== undefined && valid.value.resumeFromRunId !== undefined) {
        return errorResult("workflow: continuation and resumeFromRunId are mutually exclusive", {
          owner: "workflows",
        });
      }
      if (valid.value.outputDir !== undefined && valid.value.runName !== undefined) {
        return errorResult("workflow: runName and outputDir are mutually exclusive", { owner: "workflows" });
      }
      if (valid.value.outputDir !== undefined) {
        try {
          resolveWorkflowOutputDirectoryPath(
            getProjectRoot(ctx),
            valid.value.outputDir,
            workflowTargetLabel(valid.value),
            getWorkingDirectory(ctx),
          );
        } catch (error) {
          return errorResult(`workflow: ${error instanceof Error ? error.message : String(error)}`, {
            owner: "workflows",
          });
        }
      }
      if (commandLauncher.currentLease(ctx) === undefined) {
        return errorResult("workflow: this extension session has already shut down", { owner: "workflows" });
      }
      const transcript = createWorkflowTranscript(ctx, workflowTargetLabel(valid.value), "tool", {
        ...(valid.value.input !== undefined ? { input: valid.value.input } : {}),
      });
      const workflowName = workflowTargetLabel(valid.value);
      const taskTitle = workflowTaskTitle(valid.value.input);
      let targetBinding: ResolvedWorkflowTarget | undefined;
      try {
        targetBinding = resolveWorkflowTarget(
          valid.value.name !== undefined
            ? { name: valid.value.name }
            : valid.value.scriptPath !== undefined
              ? { scriptPath: valid.value.scriptPath }
              : { script: valid.value.script! },
          getProjectRoot(ctx),
          getWorkingDirectory(ctx),
        );
      } catch {
        // Preserve the runner's durable failed-run evidence for resolution errors.
      }
      const launched = commandLauncher.attach<RunWorkflowScriptResult>(ctx, signal, async (background) =>
        runWorkflowScript({
          pi,
          ctx,
          signal: background.signal,
          ...(valid.value.name !== undefined ? { name: valid.value.name } : {}),
          ...(valid.value.scriptPath !== undefined ? { scriptPath: valid.value.scriptPath } : {}),
          ...(valid.value.script !== undefined ? { script: valid.value.script } : {}),
          ...(targetBinding === undefined ? {} : { targetBinding }),
          ...(valid.value.input !== undefined ? { input: valid.value.input } : {}),
          ...(valid.value.items !== undefined ? { items: valid.value.items } : {}),
          ...(valid.value.outputDir !== undefined ? { outputDir: valid.value.outputDir } : {}),
          ...(valid.value.runName !== undefined ? { runName: valid.value.runName } : {}),
          ...(valid.value.budget === undefined ? {} : { budget: valid.value.budget }),
          ...(valid.value.continuation !== undefined ? { continuation: valid.value.continuation } : {}),
          ...(valid.value.resumeFromRunId !== undefined ? { resumeFromRunId: valid.value.resumeFromRunId } : {}),
          ...(valid.value.recoverInterrupted === undefined
            ? {}
            : { recoverInterrupted: valid.value.recoverInterrupted }),
          // Same default as the command surface: in a headless (`print`/`json`)
          // host there is no operator to reach, so the mode is on unless the
          // caller explicitly passes `noOperator: false`.
          ...((valid.value.noOperator ?? isOneShotHostMode(ctx)) ? { noOperator: true as const } : {}),
          onRunStart: ({ runId, runDir }) => {
            background.setRunId(runId);
            deps.onRunStarted(runId);
            transcript.start(runId, runDir);
            update({
              content: [{ type: "text", text: `workflow started\nrunDir: ${runDir}` }],
              details: {
                workflowName,
                status: "running",
                runId,
                runDir,
                agentRows: [],
                ...(taskTitle === undefined ? {} : { taskTitle }),
              },
            });
          },
          onEvent: (line: WorkflowJournalLine) => {
            applyWorkflowJournalLineToAgentLiveStore(line, getProjectRoot(ctx));
            transcript.event(line);
            // Stream renderable `content`, not just `details`: in the interactive TUI the pi SDK's
            // ToolExecutionComponent renders streamed updates via getTextOutput(result.content) — a
            // content-less partial makes it throw `reading 'filter'` on a detached emit tick, which the
            // workflow host-net then mis-attributes as ok:false on an otherwise-successful run. The live
            // agent rows double as the progress text the model/user see for this tool call.
            const liveAgents = renderAgentLiveRowsText();
            update({
              content: [{ type: "text", text: liveAgents }],
              details: {
                workflowName,
                status: "running",
                runId: line.runId,
                lastEvent: line,
                liveAgents,
                agentRows: snapshotWorkflowToolCardAgents(line.runId),
                ...(taskTitle === undefined ? {} : { taskTitle }),
              },
            });
          },
        }),
      );
      if (!launched.ok) {
        return errorResult("workflow: this extension session is stale; retry after Pi finishes reloading", {
          owner: "workflows",
        });
      }
      const settlement = await launched.run.terminal;
      if (settlement.status === "rejected") throw settlement.error;
      const res = settlement.value;
      const transcriptCompletion = transcript.finish(res);
      const cardAgents = snapshotWorkflowToolCardAgents(res.runId);
      deps.onRunCompleted(res.runId);

      // Tool execution may still be inside Pi's streaming turn. Persist the
      // bounded lifecycle through this one native toolResult instead of an
      // out-of-band sendMessage that could schedule or corrupt a model turn.
      const summary = renderWorkflowToolResult(res, transcriptCompletion.digest);
      const transcriptDetails = {
        surface: "tool",
        eventKind: transcriptCompletion.eventKind,
        lineCount: transcriptCompletion.lineCount,
      };
      const disposition = workflowResultDisposition(res);
      const workflowCardDetails = {
        workflowName,
        status: disposition.status,
        summary: disposition.summary,
        agentRows: cardAgents,
        ...(taskTitle === undefined ? {} : { taskTitle }),
      };
      const terminalDetails = {
        ...workflowCardDetails,
        disposition: res.disposition,
        transcript: transcriptDetails,
        runId: res.runId,
        runDir: res.runDir,
        ...(res.workspaceDir !== undefined ? { workspaceDir: res.workspaceDir } : {}),
        ...(res.workspacePhysicalIdentity !== undefined
          ? { workspacePhysicalIdentity: res.workspacePhysicalIdentity }
          : {}),
        ...(res.workspacePhysicalIdentitySchemaVersion !== undefined
          ? { workspacePhysicalIdentitySchemaVersion: res.workspacePhysicalIdentitySchemaVersion }
          : {}),
        outputDir: workflowRunOutputsDir(res.runDir),
        ...(res.stableOutputDir !== undefined ? { stableOutputDir: res.stableOutputDir } : {}),
        ...(res.stableOutputDirRelative !== undefined ? { stableOutputDirRelative: res.stableOutputDirRelative } : {}),
        ...(res.primaryFile !== undefined ? { primaryFile: res.primaryFile } : {}),
        ...(res.lineage !== undefined ? { lineage: res.lineage } : {}),
        ...(res.childRuns !== undefined ? { childRuns: res.childRuns } : {}),
        ...(res.resultTextPath !== undefined ? { resultTextPath: res.resultTextPath } : {}),
        ...(res.primaryOutputPath !== undefined ? { primaryOutputPath: res.primaryOutputPath } : {}),
        resultPath: res.resultPersistence.path,
        resultPersistence: res.resultPersistence,
        ...(res.artifactRefs !== undefined ? { artifactRefs: res.artifactRefs } : {}),
        ...(res.artifactRefsOmitted !== undefined ? { artifactRefsOmitted: res.artifactRefsOmitted } : {}),
        ...(res.resultDiagnostic !== undefined ? { resultDiagnostic: res.resultDiagnostic } : {}),
        journal: res.journal,
        target: operatorWorkflowTarget(res.target),
        ...(res.scriptIdentity !== undefined
          ? { scriptIdentity: operatorScriptIdentity(res.scriptIdentity, res.target?.ref) }
          : {}),
        ...(res.resumeFromRunId !== undefined
          ? {
              resumeFromRunId: res.resumeFromRunId,
              resumeSourceRunSummary: res.resumeSourceRunSummary ?? null,
            }
          : {}),
        ...(res.continuation !== undefined ? { continuation: res.continuation } : {}),
      };
      if (disposition.status === "completed" || disposition.status === "awaiting_operator") {
        return textResult(summary, {
          owner: "workflows",
          ...terminalDetails,
        });
      }
      return errorResult(summary, {
        owner: "workflows",
        ...terminalDetails,
        result: res.result,
        error: res.error,
      });
    },
  });
}

/**
 * The native toolResult owns one semantic completion: the bounded digest. Keep
 * artifact/persistence metadata around it, but do not repeat success/failure or
 * error text before the final workflow_end line.
 */
function renderWorkflowToolResult(res: RunWorkflowScriptResult, digest: string): string {
  const disposition = workflowResultDisposition(res);
  const firstLine =
    disposition.status === "awaiting_operator"
      ? `workflow ${res.runId} · ${disposition.status} · ${disposition.summary}`
      : `workflow ${res.runId} · ${disposition.status}`;
  const lines = [firstLine, `runDir: ${res.runDir}`];
  if (res.workspaceDir !== undefined) lines.push(`workspaceDir: ${res.workspaceDir}`);
  lines.push(`outputsDir: ${workflowRunOutputsDir(res.runDir)}`);
  if (res.primaryFile !== undefined) {
    lines.push(`primary file: ${res.primaryFile.absolutePath} (sha256 ${res.primaryFile.sha256})`);
  }
  if (res.resultTextPath !== undefined) lines.push(`result: ${res.resultTextPath}`);
  if (res.primaryOutputPath !== undefined) lines.push(`primary output: ${res.primaryOutputPath}`);
  if (res.scriptIdentity !== undefined) lines.push(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref));
  if (!res.resultPersistence.ok) {
    lines.push(`persistence: ${res.resultPersistence.code}`);
  }
  if (res.failureDiagnostic !== undefined) {
    lines.push(...formatWorkflowFailureDiagnosticLines(res.failureDiagnostic, { repairRequest: true }));
  }
  if (res.artifactRefs !== undefined && res.artifactRefs.length > 0) {
    lines.push("artifactRefs:", ...res.artifactRefs.map((ref) => JSON.stringify(ref)));
    if (res.artifactRefsOmitted !== undefined) lines.push(`artifactRefsOmitted: ${res.artifactRefsOmitted}`);
  }
  lines.push("", digest);
  return lines.join("\n");
}

/** Human-only transcript card. The model still receives the bounded `content` digest. */
function renderWorkflowToolResultCard(
  result: ToolResult,
  options: ToolRenderResultOptions,
  theme: ThemeLike,
  context: ToolRenderContext,
) {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const workflowName =
    typeof details.workflowName === "string" ? details.workflowName : workflowTargetLabel(renderContextArgs(context));
  const taskTitle =
    typeof details.taskTitle === "string" ? details.taskTitle : workflowTaskTitle(renderContextInput(context));
  const status = workflowToolCardStatus(details.status, options.isPartial, context.isError || result.isError === true);
  const technicalLines: string[] = [];
  if (options.expanded) {
    if (typeof details.runId === "string") technicalLines.push(`run: ${details.runId}`);
    if (typeof details.outputDir === "string") technicalLines.push(`outputs: ${details.outputDir}`);
    if (typeof details.primaryOutputPath === "string")
      technicalLines.push(`primary output: ${details.primaryOutputPath}`);
    if (typeof details.resultTextPath === "string") technicalLines.push(`workflow result: ${details.resultTextPath}`);
  }
  if (
    typeof details.summary === "string" &&
    status !== "running" &&
    status !== "completed" &&
    details.summary.trim() !== ""
  ) {
    technicalLines.push(`reason: ${details.summary}`);
  }
  const persistedResult = readPersistedWorkflowResult(details);
  if (persistedResult?.kind === "technical") technicalLines.push(persistedResult.text);
  if (persistedResult === undefined && details.workflowName === undefined) {
    const firstText = result.content.find((part) => part.type === "text");
    if (firstText?.type === "text")
      technicalLines.push(...firstText.text.split(/\r?\n/u).filter((line) => line !== ""));
  }
  return renderWorkflowToolCard(
    {
      workflowName,
      status,
      ...(taskTitle === undefined ? {} : { taskTitle }),
      agents: readWorkflowToolCardAgents(details.agentRows),
      technicalLines,
      ...(persistedResult?.kind === "model" ? { modelText: persistedResult.text } : {}),
    },
    options,
    theme,
    context,
  );
}

function readPersistedWorkflowResult(
  details: Record<string, unknown>,
): { kind: "model" | "technical"; text: string } | undefined {
  if (
    typeof details.runDir !== "string" ||
    typeof details.outputDir !== "string" ||
    typeof details.resultTextPath !== "string"
  )
    return undefined;
  const runDir = path.resolve(details.runDir);
  const outputDir = workflowRunOutputsDir(runDir);
  if (path.resolve(details.outputDir) !== outputDir) {
    return { kind: "technical", text: "full workflow result unavailable: invalid output path" };
  }
  const resultPath = path.resolve(details.resultTextPath);
  if (resultPath !== path.join(outputDir, "workflow-result.md")) {
    return { kind: "technical", text: "full workflow result unavailable: invalid result path" };
  }
  try {
    return { kind: "model", text: readWorkflowRunTextFile(runDir, resultPath).replace(/\n$/u, "") };
  } catch {
    return { kind: "technical", text: "full workflow result unavailable: result file cannot be read" };
  }
}

function renderContextArgs(context: ToolRenderContext): { name?: string; scriptPath?: string; script?: string } {
  if (context.args === null || typeof context.args !== "object") return {};
  const args = context.args as Record<string, unknown>;
  return {
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(typeof args.scriptPath === "string" ? { scriptPath: args.scriptPath } : {}),
    ...(typeof args.script === "string" ? { script: args.script } : {}),
  };
}

function renderContextInput(context: ToolRenderContext): string | undefined {
  if (context.args === null || typeof context.args !== "object") return undefined;
  const input = (context.args as Record<string, unknown>).input;
  return typeof input === "string" ? input : undefined;
}

const WORKFLOW_TASK_TITLE_MAX_CHARS = 96;

/** First line of the workflow's semantic input, clamped to one card-friendly title. */
function workflowTaskTitle(input: string | undefined): string | undefined {
  const firstLine = (input ?? "").split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (firstLine === "") return undefined;
  if (firstLine.length <= WORKFLOW_TASK_TITLE_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, WORKFLOW_TASK_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

function workflowToolCardStatus(value: unknown, isPartial: boolean, isError: boolean): WorkflowToolCardStatus {
  if (isPartial) return "running";
  if (
    value === "completed" ||
    value === "awaiting_operator" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "unknown"
  ) {
    return value;
  }
  return isError ? "failed" : "completed";
}

function readWorkflowToolCardAgents(value: unknown): WorkflowToolCardAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.name !== "string" ||
      typeof row.work !== "string" ||
      (row.status !== "queued" &&
        row.status !== "working" &&
        row.status !== "done" &&
        row.status !== "cancelled" &&
        row.status !== "error")
    ) {
      return [];
    }
    return [
      {
        name: row.name,
        work: row.work,
        status: row.status,
        ...(typeof row.startedAt === "number" ? { startedAt: row.startedAt } : {}),
        ...(typeof row.elapsedMs === "number" ? { elapsedMs: row.elapsedMs } : {}),
        ...(typeof row.answer === "string" && row.answer !== "" ? { answer: row.answer } : {}),
      },
    ];
  });
}

function operatorScriptIdentity(
  identity: OperatorScriptIdentityInput,
  sourceRef?: string,
): {
  sourceRef: string;
  snapshot: string;
  scriptSha256: string;
  identityCoverage: string;
  executionSource: string;
  nodeVersion: string;
  builtinImportCount: number | null;
  unboundDependencyCount: number | null;
} {
  return {
    sourceRef: safeOperatorSourceRef(sourceRef),
    snapshot: path.basename(identity.snapshotPath),
    scriptSha256: identity.scriptSha256,
    identityCoverage: identity.identityCoverage ?? "entry-only-legacy",
    executionSource: identity.executionSource ?? "source",
    nodeVersion: identity.nodeVersion ?? "unknown",
    builtinImportCount:
      (identity.identityCoverage ?? "entry-only-legacy") === "entry-only-legacy"
        ? null
        : (identity.builtinImports?.length ?? 0),
    unboundDependencyCount:
      (identity.identityCoverage ?? "entry-only-legacy") === "entry-only-legacy"
        ? null
        : (identity.unboundDependencies?.length ?? null),
  };
}

function operatorWorkflowTarget(target: ResolvedWorkflowTarget | undefined): {
  kind: ResolvedWorkflowTarget["kind"];
  ref: string;
  source: ResolvedWorkflowTarget["source"];
} | null {
  if (target === undefined) return null;
  return {
    kind: target.kind,
    ref: safeOperatorSourceRef(target.ref),
    source: target.source,
  };
}

function workflowTargetLabel(value: { name?: string; scriptPath?: string; script?: string }): string {
  return value.name ?? value.scriptPath ?? value.script ?? "unknown";
}
