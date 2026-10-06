/**
 * Durable workflow result storage and tolerant, read-only historical readback.
 * `workflow-outcome.ts` owns result meaning; this owner writes and validates the
 * untrusted `runtime/result.json` envelope and its derived verbatim Markdown.
 * The trusted execution result lives in `workflow-runner.ts`, not this envelope.
 * Missing evidence is never repaired here; resume admission belongs to its owner.
 */

import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  assertWorkflowRunId,
  ensureWorkflowDirectoryNoSymlink,
  readWorkflowRunTextFile,
  resolveWorkflowRunDir,
  workflowLegacyRunMigrationMessage,
  workflowRunDir,
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
  workflowRunsRootDir,
  writeWorkflowRunFile,
} from "./workflow-run-layout.js";
import { WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE, safeErrorMessage, serializeJson } from "./workflow-outcome.js";
// The persisted envelope is checked with the SAME predicates the journal line is,
// so a stored shape cannot be admitted here under looser rules than the event
// contract applies next door.
import { isNodeError, type WorkflowPrimaryFileReference } from "./workflow-workspace.js";
import { hasExactFields, isArtifactRef, isRecord } from "./workflow-journal-format.js";
import type { WorkflowArtifactRef } from "./workflow-artifact-format.js";
import { parseWorkflowFailureDiagnostic, type WorkflowFailureDiagnostic } from "./workflow-failure.js";
import type { WorkflowExecutionSource, WorkflowIdentityCoverage } from "./workflow-script-identity.js";
import { parseWorkflowPersistedBinding } from "./workflow-persisted-binding.js";
import { assertWorkflowPhysicalWorkspaceIdentity, isWorkflowPathWithinRoot } from "./workflow-workspace.js";
import { WORKFLOW_BUDGET_AXES, WORKFLOW_BUDGET_UNBOUNDED } from "./workflow-budget.js";

/**
 * The rules half stays importable through this module so a caller that needs
 * both meaning and storage keeps one import. A caller that needs only the rules
 * should import `./workflow-outcome.js` directly.
 */
export {
  WORKFLOW_FINALIZATION_ERROR_MAX_CHARS,
  WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
  WORKFLOW_RESULT_NOT_JSON_SAFE,
  classifyWorkflowReturnedFailure,
  formatWorkflowFailureSummary,
  formatWorkflowResultDetail,
  formatWorkflowResultSummary,
  isWorkflowResultDiagnostic,
  isWorkflowResultExplicitFailure,
  prepareWorkflowResult,
  projectWorkflowDisposition,
  workflowDispositionForCompletion,
  workflowFinalizationError,
} from "./workflow-outcome.js";
export type {
  PreparedWorkflowResult,
  WorkflowCancellationReason,
  WorkflowDisposition,
  WorkflowDispositionProjection,
  WorkflowDispositionStatus,
  WorkflowFinalizationError,
  WorkflowFinalizationStage,
  WorkflowProjectedStatus,
  WorkflowResultDiagnosticSentinel,
  WorkflowReturnedFailure,
  WorkflowReturnedFailureKind,
  WorkflowReturnedFailureStatus,
} from "./workflow-outcome.js";

export const WORKFLOW_RESULT_WRITE_FAILED = "WORKFLOW_RESULT_WRITE_FAILED";

export type WorkflowResultPersistence =
  | { ok: true; path: string }
  | {
      ok: false;
      path: string;
      code: typeof WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE | typeof WORKFLOW_RESULT_WRITE_FAILED;
      message: string;
    };

/** Full prose projection for bounded live surfaces and `/workflows result`. */
export function workflowResultTextFile(runDir: string): string {
  return path.join(workflowRunOutputsDir(runDir), "workflow-result.md");
}

/**
 * The verbatim text of a terminal result, or undefined when the result is not
 * text. A structured result is left to `runtime/result.json`, which already pretty-prints
 * it; inventing a prose rendering for it would be a guess, not evidence.
 */
export function workflowResultText(result: unknown): string | undefined {
  if (typeof result !== "string") return undefined;
  return result.trim() === "" ? undefined : result;
}

function workflowResultTextProjection(result: unknown): string | undefined {
  const text = workflowResultText(result);
  return text === undefined || text.endsWith("\n") ? text : `${text}\n`;
}

/** Return undefined on write failure; the runner promotes that to failed finalization. */
export function writeWorkflowResultText(runDir: string, result: unknown): string | undefined {
  const text = workflowResultTextProjection(result);
  if (text === undefined) return undefined;
  const resultTextPath = workflowResultTextFile(runDir);
  try {
    ensureWorkflowDirectoryNoSymlink(runDir, path.dirname(resultTextPath));
    writeWorkflowRunFile(runDir, resultTextPath, text);
    return resultTextPath;
  } catch {
    return undefined;
  }
}

export function workflowResultFile(runDir: string): string {
  return path.join(workflowRunRuntimeDir(runDir), "result.json");
}

/** Persist one already-normalized run envelope and report failures to the caller. */
export function writeWorkflowResultJson(runDir: string, payload: unknown): WorkflowResultPersistence {
  const resultPath = workflowResultFile(runDir);
  const serialized = serializeJson(payload);
  if (!serialized.ok) {
    return {
      ok: false,
      path: resultPath,
      code: WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
      message: `Workflow result envelope was not persisted: ${serialized.message}`,
    };
  }
  try {
    ensureWorkflowDirectoryNoSymlink(runDir, path.dirname(resultPath));
    writeWorkflowRunFile(runDir, resultPath, `${serialized.json}\n`);
    return { ok: true, path: resultPath };
  } catch (error) {
    return {
      ok: false,
      path: resultPath,
      code: WORKFLOW_RESULT_WRITE_FAILED,
      message: `Workflow result was not persisted: ${safeErrorMessage(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Read side — tolerant readback of the same two files
// ---------------------------------------------------------------------------

export interface WorkflowRunResultEnvelope {
  /** Present for current envelopes; absent is retained as passive legacy evidence. */
  runId?: string;
  storageRootRunId?: string;
  storageRootRunIdInvalid?: string;
  /** Read-side marker: a present envelope runId was malformed or selected another run. */
  runIdInvalid?: string;
  /** Read-side marker: legacy envelope has no runId and cannot prove source authority. */
  runUnbound?: string;
  ok?: boolean;
  okInvalid?: string;
  workspaceDir?: string;
  workspaceDirRelative?: string;
  workspaceDirInvalid?: string;
  /** Present current-run workspace was removed/unavailable; readable, not resumable. */
  workspaceDirUnavailable?: string;
  workspaceDirExplicit?: boolean;
  workspaceDirExplicitInvalid?: string;
  workspacePhysicalIdentity?: string;
  workspacePhysicalIdentityInvalid?: string;
  workspacePhysicalIdentitySchemaVersion?: 1;
  /** Historical placement only; new execution never writes these fields. */
  primaryFile?: WorkflowPrimaryFileReference;
  outputDir?: string;
  outputDirRelative?: string;
  outputDirInvalid?: string;
  /** Present current-run output was removed/unavailable; readable, not resumable. */
  outputDirUnavailable?: string;
  outputPhysicalIdentity?: string;
  outputPhysicalIdentityInvalid?: string;
  outputPhysicalIdentitySchemaVersion?: 1;
  outputSource?: "declared" | "default";
  outputSourceInvalid?: string;
  semanticInputPresent?: boolean;
  semanticInputSha256?: string;
  semanticInputInvalid?: string;
  disposition?: unknown;
  result?: unknown;
  error?: string;
  errorInvalid?: string;
  failureDiagnostic?: WorkflowFailureDiagnostic;
  failureDiagnosticInvalid?: string;
  artifactRefs?: WorkflowArtifactRef[];
  artifactRefsInvalid?: string;
  artifactRefsOmitted?: number;
  artifactRefsOmittedInvalid?: string;
  /** Every budget axis this run applied; an undeclared axis reads `"unbounded"`. */
  budget?: Record<string, number | string>;
  /** Read-side marker: a present budget envelope was not the complete axis record. */
  budgetInvalid?: string;
  resultPersistence?: WorkflowResultPersistence;
  resultPersistenceInvalid?: string;
  target?: {
    kind: "name" | "scriptPath";
    ref: string;
    source: "project" | "personal" | "package";
  };
  /** Read-side marker: the persisted target field was present but malformed. */
  targetInvalid?: string;
  /** Read-side marker: a present script identity field was malformed or unsupported. */
  scriptIdentityInvalid?: string;
  /** Read-side marker: a present disposition was malformed or disagreed with ok. */
  dispositionInvalid?: string;
  scriptIdentity?: {
    schemaVersion: 1 | 2;
    identityPolicy: "legacy-unversioned" | "static-node-only-v1";
    sourcePath: string;
    snapshotPath: string;
    scriptSha256: string;
    identityCoverage: WorkflowIdentityCoverage;
    executionSource: WorkflowExecutionSource;
    nodeVersion: string;
    platform: string;
    arch: string;
    builtinImports: string[];
    unboundDependencies: string[];
  };
}

/**
 * Project one persisted-result envelope's present-but-invalid metadata into a
 * stable read-side diagnostic. Missing fields are legacy compatibility state,
 * not corruption, so only parser-emitted invalid markers participate here.
 */
export function workflowPersistedResultInvalidity(result: WorkflowRunResultEnvelope | null): string | undefined {
  if (result === null) return undefined;
  const invalidFields: Array<[string, string | undefined]> = [
    ["runId is malformed or does not match the selected run", result.runIdInvalid],
    ["storage group is malformed", result.storageRootRunIdInvalid],
    ["target is malformed", result.targetInvalid],
    ["script identity is malformed", result.scriptIdentityInvalid],
    ["disposition is malformed or inconsistent", result.dispositionInvalid],
    ["workspace location is malformed", result.workspaceDirInvalid],
    ["workspaceDirExplicit is malformed", result.workspaceDirExplicitInvalid],
    ["semantic input identity is malformed", result.semanticInputInvalid],
    ["workspace physical identity is malformed", result.workspacePhysicalIdentityInvalid],
    ["output location is malformed", result.outputDirInvalid],
    ["output physical identity is malformed", result.outputPhysicalIdentityInvalid],
    ["output source is malformed", result.outputSourceInvalid],
    ["ok field is malformed", result.okInvalid],
    ["error field is malformed", result.errorInvalid],
    ["failure diagnostic is malformed", result.failureDiagnosticInvalid],
    ["artifact references are malformed", result.artifactRefsInvalid],
    ["artifactRefsOmitted is malformed", result.artifactRefsOmittedInvalid],
    ["result persistence is malformed", result.resultPersistenceInvalid],
    ["budget envelope is malformed", result.budgetInvalid],
  ];
  const invalid = invalidFields.find(([, message]) => message !== undefined);
  return invalid === undefined ? undefined : `${invalid[0]}: ${invalid[1]}`;
}

export type WorkflowRunResultText =
  | { status: "ready"; runId: string; path: string; text: string }
  | { status: "none"; runId: string; message: string }
  | { status: "invalid"; runId: string; message: string };

/**
 * The whole terminal output of one finished run, read from disk.
 * `outputs/workflow-result.md` is the verbatim copy a prose run writes. The
 * canonical `runtime/result.json` envelope authorizes that copy only when its
 * bytes match the writer's projection. It recovers text if the copy was removed.
 * Nothing here is truncated — being readable is the point.
 */
export function readWorkflowRunResultText(projectRoot: string, runId: string): WorkflowRunResultText {
  let runDir: string;
  try {
    runDir = resolveWorkflowRunDir(projectRoot, runId);
  } catch (error) {
    return {
      status: isNodeError(error, "ENOENT") ? "none" : "invalid",
      runId,
      message: workflowLegacyRunMigrationMessage(projectRoot, runId) ?? errorMessage(error),
    };
  }
  const textPath = workflowResultTextFile(runDir);
  const envelope = readWorkflowRunResult(projectRoot, runId, runDir);
  const invalidity = workflowPersistedResultInvalidity(envelope);
  if (invalidity !== undefined) {
    return {
      status: "invalid",
      runId,
      message: `Run ${runId} has malformed persisted workflow metadata (${invalidity}).`,
    };
  }
  const jsonPath = workflowResultFile(runDir);
  if (envelope === null) {
    return {
      status: "none",
      runId,
      message:
        workflowLegacyRunMigrationMessage(projectRoot, runId) ?? `No persisted result was found for run ${runId}.`,
    };
  }
  let text: string | undefined;
  try {
    text = readWorkflowRunTextFile(runDir, textPath);
  } catch {
    // No readable projection: recover from the canonical JSON envelope.
  }
  if (text !== undefined) {
    if (text !== workflowResultTextProjection(envelope.result)) {
      return {
        status: "invalid",
        runId,
        message: `Run ${runId} has a workflow-result.md projection that does not match its canonical result.json.`,
      };
    }
    return { status: "ready", runId, path: textPath, text };
  }
  if (typeof envelope.result === "string" && envelope.result.trim() !== "") {
    return { status: "ready", runId, path: jsonPath, text: envelope.result };
  }
  if (envelope.result !== undefined) {
    try {
      const json = JSON.stringify(envelope.result, null, 2);
      if (json !== undefined) return { status: "ready", runId, path: jsonPath, text: json };
    } catch {
      // An unserializable persisted value falls through to the error/none paths.
    }
  }
  if (envelope.error !== undefined && envelope.error.trim() !== "") {
    return { status: "ready", runId, path: jsonPath, text: `Run failed: ${envelope.error}` };
  }
  return { status: "none", runId, message: `Run ${runId} persisted no readable result text.` };
}

/** Read persisted result detail for `/workflows status <runId>`. Best-effort; never throws. */
export function readWorkflowRunResult(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowRunResultEnvelope | null {
  try {
    const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, runId);
    const parsed: unknown = JSON.parse(readWorkflowRunTextFile(runDir, workflowResultFile(runDir)));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    let storageRootRunId: string | undefined;
    let storageRootRunIdInvalid: string | undefined;
    const physicalStorageRootRunId = path.relative(workflowRunsRootDir(projectRoot), runDir).split(path.sep)[0]!;
    const nestedExecution = path.resolve(runDir) !== path.resolve(workflowRunDir(projectRoot, runId));
    if (Object.prototype.hasOwnProperty.call(record, "storageRootRunId")) {
      try {
        storageRootRunId = assertWorkflowRunId(record.storageRootRunId);
        if (storageRootRunId !== physicalStorageRootRunId)
          throw new Error("storageRootRunId does not match the physical run group");
      } catch (error) {
        storageRootRunId = undefined;
        storageRootRunIdInvalid = errorMessage(error);
      }
    } else if (nestedExecution) {
      storageRootRunIdInvalid = "storageRootRunId is required for nested workflow execution evidence";
    }
    const hasPersistedRunId = Object.prototype.hasOwnProperty.call(record, "runId");
    let persistedRunId: string | undefined;
    let runIdInvalid: string | undefined;
    let runUnbound: string | undefined;
    if (!hasPersistedRunId) {
      runUnbound = "persisted result envelope has no runId";
    } else {
      try {
        persistedRunId = assertWorkflowRunId(record.runId);
        if (persistedRunId !== runId) {
          runIdInvalid = `persisted runId ${JSON.stringify(persistedRunId)} does not match selected run ${JSON.stringify(runId)}`;
        }
      } catch (error) {
        runIdInvalid = errorMessage(error);
      }
    }
    // A malformed/mismatched runId cannot authorize target, workspace, input,
    // artifact, or script metadata. A missing runId remains readable as legacy
    // evidence, but is marked run-unbound so exact consumers can refuse it.
    const exposeBindingMetadata = runIdInvalid === undefined;
    const binding = parseWorkflowPersistedBinding(record, projectRoot, runId, { runDir });
    const target = binding.target;
    const targetInvalid = binding.targetInvalid;
    const scriptIdentity = binding.scriptIdentity;
    const scriptIdentityInvalid = binding.scriptIdentityInvalid;
    const dispositionInvalid = binding.dispositionInvalid;
    const failureDiagnostic = parseWorkflowFailureDiagnostic(record.failureDiagnostic);
    let okInvalid: string | undefined;
    let errorInvalid: string | undefined;
    let failureDiagnosticInvalid: string | undefined;
    let artifactRefsInvalid: string | undefined;
    let artifactRefsOmittedInvalid: string | undefined;
    let resultPersistence: WorkflowResultPersistence | undefined;
    let resultPersistenceInvalid: string | undefined;
    let budget: WorkflowRunResultEnvelope["budget"];
    let budgetInvalid: string | undefined;
    if (Object.prototype.hasOwnProperty.call(record, "ok") && typeof record.ok !== "boolean") {
      okInvalid = "ok must be a boolean when present";
    }
    if (Object.prototype.hasOwnProperty.call(record, "error") && typeof record.error !== "string") {
      errorInvalid = "error must be a string when present";
    }
    if (Object.prototype.hasOwnProperty.call(record, "failureDiagnostic")) {
      if (!isPersistedFailureDiagnostic(record.failureDiagnostic)) {
        failureDiagnosticInvalid = "failureDiagnostic must be a complete known diagnostic object";
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, "artifactRefs")) {
      if (!isArtifactRefArray(record.artifactRefs)) {
        artifactRefsInvalid = "artifactRefs must be an array of at most 20 valid artifact references";
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, "artifactRefsOmitted")) {
      if (
        typeof record.artifactRefsOmitted !== "number" ||
        !Number.isSafeInteger(record.artifactRefsOmitted) ||
        record.artifactRefsOmitted < 1
      ) {
        artifactRefsOmittedInvalid = "artifactRefsOmitted must be a positive safe integer when present";
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, "budget")) {
      budget = parsePersistedBudgetEnvelope(record.budget);
      if (budget === undefined) {
        budgetInvalid =
          `budget must name exactly the axes ${WORKFLOW_BUDGET_AXES.join(", ")}, ` +
          `each a positive safe integer or ${JSON.stringify(WORKFLOW_BUDGET_UNBOUNDED)}`;
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, "resultPersistence")) {
      try {
        resultPersistence = parsePersistedResultPersistence(record.resultPersistence, runDir);
        if (record.ok === true && resultPersistence.ok === false) {
          throw new Error("resultPersistence.ok=false cannot accompany an outer ok=true result");
        }
      } catch (error) {
        resultPersistenceInvalid = errorMessage(error);
        resultPersistence = undefined;
      }
    }
    let workspacePhysicalIdentity: string | undefined;
    let workspacePhysicalIdentityInvalid: string | undefined;
    let workspacePhysicalIdentitySchemaVersion: 1 | undefined;
    let workspaceDirExplicit: boolean | undefined;
    let workspaceDirExplicitInvalid: string | undefined;
    let workspaceDir: string | undefined;
    let workspaceDirRelative: string | undefined;
    let workspaceDirInvalid: string | undefined;
    let workspaceDirUnavailable: string | undefined;
    let resolvedPhysicalWorkspaceRelative: string | undefined;
    const hasWorkspaceDir = Object.prototype.hasOwnProperty.call(record, "workspaceDir");
    const hasWorkspaceDirRelative = Object.prototype.hasOwnProperty.call(record, "workspaceDirRelative");
    if (hasWorkspaceDir || hasWorkspaceDirRelative) {
      if (typeof record.workspaceDir !== "string" || typeof record.workspaceDirRelative !== "string") {
        workspaceDirInvalid = "workspaceDir and workspaceDirRelative must both be strings when present";
      } else if (!path.isAbsolute(record.workspaceDir)) {
        workspaceDirInvalid = "workspaceDir must be an absolute path when present";
      } else {
        try {
          const lexicalRoot = path.resolve(projectRoot);
          const lexicalWorkspace = path.resolve(record.workspaceDir);
          const lexicalRelativePath = path.relative(lexicalRoot, lexicalWorkspace).split(path.sep).join("/");
          if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalWorkspace)) {
            workspaceDirInvalid = "workspaceDir escapes the project root";
          } else {
            const physicalRoot = realpathSync(lexicalRoot);
            let physicalWorkspace: string | undefined;
            try {
              physicalWorkspace = realpathSync(lexicalWorkspace);
            } catch (error) {
              if (!isWorkspaceUnavailableError(error)) throw error;
              workspaceDirUnavailable = `workspaceDir is unavailable: ${errorMessage(error)}`;
            }
            if (physicalWorkspace !== undefined && !isWorkflowPathWithinRoot(physicalRoot, physicalWorkspace)) {
              workspaceDirInvalid = "workspaceDir escapes the project root through a symlink";
            } else {
              if (physicalWorkspace !== undefined) {
                if (!statSync(physicalWorkspace).isDirectory()) {
                  workspaceDirInvalid = "workspaceDir must identify a directory when present";
                }
                resolvedPhysicalWorkspaceRelative = path
                  .relative(physicalRoot, physicalWorkspace)
                  .split(path.sep)
                  .join("/");
              }
              if (
                workspaceDirInvalid === undefined &&
                (lexicalRelativePath === "" ||
                  lexicalRelativePath !== record.workspaceDirRelative ||
                  (resolvedPhysicalWorkspaceRelative !== undefined &&
                    (resolvedPhysicalWorkspaceRelative === "" ||
                      resolvedPhysicalWorkspaceRelative !== record.workspaceDirRelative)))
              ) {
                workspaceDirInvalid =
                  `workspaceDirRelative does not match workspaceDir canonical path or physical identity ` +
                  `(recorded ${JSON.stringify(record.workspaceDirRelative)}, ` +
                  `canonical ${JSON.stringify(lexicalRelativePath)}, ` +
                  `physical ${JSON.stringify(resolvedPhysicalWorkspaceRelative)})`;
              } else if (workspaceDirInvalid === undefined) {
                workspaceDir = record.workspaceDir;
                workspaceDirRelative = record.workspaceDirRelative;
              }
            }
          }
        } catch (error) {
          workspaceDirInvalid = `workspaceDir identity is unavailable: ${errorMessage(error)}`;
        }
      }
    }
    const hasPhysicalIdentitySchema = Object.prototype.hasOwnProperty.call(
      record,
      "workspacePhysicalIdentitySchemaVersion",
    );
    const hasPhysicalIdentity = Object.prototype.hasOwnProperty.call(record, "workspacePhysicalIdentity");
    if (hasPhysicalIdentitySchema || hasPhysicalIdentity) {
      if (!hasWorkspaceDir || !hasWorkspaceDirRelative) {
        if (workspaceDirInvalid === undefined) {
          workspacePhysicalIdentityInvalid =
            "workspaceDir and workspaceDirRelative are required when workspace physical identity is present";
        }
      } else if (!hasPhysicalIdentitySchema) {
        workspacePhysicalIdentityInvalid =
          "workspace physical identity schema version is required when physical identity is present";
      } else if (record.workspacePhysicalIdentitySchemaVersion !== 1) {
        workspacePhysicalIdentityInvalid = "unsupported workspace physical identity schema version";
      } else if (!hasPhysicalIdentity) {
        workspacePhysicalIdentityInvalid = "workspace physical identity is required when schema version is present";
      } else {
        try {
          workspacePhysicalIdentity = assertWorkflowPhysicalWorkspaceIdentity(record.workspacePhysicalIdentity);
          workspacePhysicalIdentitySchemaVersion = 1;
          const expectedPhysicalRelative = resolvedPhysicalWorkspaceRelative ?? workspaceDirRelative;
          if (expectedPhysicalRelative !== undefined && workspacePhysicalIdentity !== expectedPhysicalRelative) {
            workspacePhysicalIdentityInvalid =
              `workspace physical identity does not match workspaceDir ` +
              `(recorded ${JSON.stringify(workspacePhysicalIdentity)}, ` +
              `physical ${JSON.stringify(expectedPhysicalRelative)})`;
            workspacePhysicalIdentity = undefined;
            workspacePhysicalIdentitySchemaVersion = undefined;
          }
        } catch (error) {
          workspacePhysicalIdentityInvalid = errorMessage(error);
        }
      }
    }
    const hasWorkspaceDirExplicit = Object.prototype.hasOwnProperty.call(record, "workspaceDirExplicit");
    if (hasWorkspaceDirExplicit) {
      if (!hasWorkspaceDir && !hasWorkspaceDirRelative) {
        workspaceDirExplicitInvalid = "workspaceDirExplicit requires workspaceDir and workspaceDirRelative";
      } else if (typeof record.workspaceDirExplicit === "boolean") {
        workspaceDirExplicit = record.workspaceDirExplicit;
      } else {
        workspaceDirExplicitInvalid = "workspaceDirExplicit must be a boolean";
      }
    }
    let outputDir: string | undefined;
    let outputDirRelative: string | undefined;
    let outputDirInvalid: string | undefined;
    let outputDirUnavailable: string | undefined;
    let outputPhysicalIdentity: string | undefined;
    let outputPhysicalIdentityInvalid: string | undefined;
    let outputPhysicalIdentitySchemaVersion: 1 | undefined;
    let outputSource: "declared" | "default" | undefined;
    let outputSourceInvalid: string | undefined;
    const outputKeys = [
      "outputDir",
      "outputDirRelative",
      "outputPhysicalIdentity",
      "outputPhysicalIdentitySchemaVersion",
      "outputSource",
    ] as const;
    const hasOutputBinding = outputKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
    if (hasOutputBinding) {
      if (
        typeof record.outputDir !== "string" ||
        !path.isAbsolute(record.outputDir) ||
        typeof record.outputDirRelative !== "string"
      ) {
        outputDirInvalid = "outputDir must be absolute and paired with outputDirRelative";
      } else {
        try {
          const root = path.resolve(projectRoot);
          const absolute = path.resolve(record.outputDir);
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          const physicalRoot = realpathSync(root);
          let physicalRelative: string | undefined;
          try {
            const physical = realpathSync(absolute);
            physicalRelative = path.relative(physicalRoot, physical).split(path.sep).join("/");
            if (!isWorkflowPathWithinRoot(physicalRoot, physical) || !statSync(physical).isDirectory()) {
              outputDirInvalid = "outputDir is not one confined project directory";
            }
          } catch (error) {
            if (!isWorkspaceUnavailableError(error)) throw error;
            outputDirUnavailable = `outputDir is unavailable: ${errorMessage(error)}`;
          }
          if (relative === "" || relative !== record.outputDirRelative || !isWorkflowPathWithinRoot(root, absolute)) {
            outputDirInvalid = "outputDir is not one confined project directory";
          } else if (outputDirInvalid === undefined) {
            outputDir = absolute;
            outputDirRelative = relative;
            if (record.outputPhysicalIdentitySchemaVersion !== 1) {
              outputPhysicalIdentityInvalid = "unsupported output physical identity schema version";
            } else if (
              typeof record.outputPhysicalIdentity !== "string" ||
              (physicalRelative !== undefined && record.outputPhysicalIdentity !== physicalRelative)
            ) {
              outputPhysicalIdentityInvalid = "output physical identity is missing or changed";
            } else {
              outputPhysicalIdentity = record.outputPhysicalIdentity;
              outputPhysicalIdentitySchemaVersion = 1;
            }
          }
        } catch (error) {
          outputDirInvalid = `outputDir identity is unavailable: ${errorMessage(error)}`;
        }
      }
      if (record.outputSource === "declared" || record.outputSource === "default") outputSource = record.outputSource;
      else outputSourceInvalid = 'outputSource must be "declared" or "default"';
    }
    const hasSemanticPresent = Object.prototype.hasOwnProperty.call(record, "semanticInputPresent");
    const hasSemanticHash = Object.prototype.hasOwnProperty.call(record, "semanticInputSha256");
    let semanticInputPresent: boolean | undefined;
    let semanticInputSha256: string | undefined;
    let semanticInputInvalid: string | undefined;
    if (hasSemanticPresent || hasSemanticHash) {
      if (typeof record.semanticInputPresent !== "boolean") {
        semanticInputInvalid = "semanticInputPresent must be a boolean when semantic input identity is present";
      } else if (
        typeof record.semanticInputSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.semanticInputSha256)
      ) {
        semanticInputInvalid =
          "semanticInputSha256 must be a lowercase 64-hex SHA-256 when semantic input identity is present";
      } else {
        semanticInputPresent = record.semanticInputPresent;
        semanticInputSha256 = record.semanticInputSha256;
      }
    }
    return {
      ...(persistedRunId === undefined ? {} : { runId: persistedRunId }),
      ...(storageRootRunId === undefined ? {} : { storageRootRunId }),
      ...(storageRootRunIdInvalid === undefined ? {} : { storageRootRunIdInvalid }),
      ...(runIdInvalid === undefined ? {} : { runIdInvalid }),
      ...(runUnbound === undefined ? {} : { runUnbound }),
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      ...(okInvalid === undefined ? {} : { okInvalid }),
      ...(exposeBindingMetadata
        ? {
            ...(workspaceDir !== undefined &&
            workspaceDirRelative !== undefined &&
            workspaceDirInvalid === undefined &&
            workspacePhysicalIdentityInvalid === undefined
              ? { workspaceDir, workspaceDirRelative }
              : {}),
            ...(workspaceDirExplicit === undefined ? {} : { workspaceDirExplicit }),
            ...(workspaceDirInvalid !== undefined ||
            workspacePhysicalIdentity === undefined ||
            workspacePhysicalIdentitySchemaVersion === undefined
              ? {}
              : { workspacePhysicalIdentity, workspacePhysicalIdentitySchemaVersion }),
            ...(semanticInputPresent === undefined || semanticInputSha256 === undefined
              ? {}
              : { semanticInputPresent, semanticInputSha256 }),
            ...(isLegacyPrimaryFileReference(record.primaryFile) ? { primaryFile: record.primaryFile } : {}),
            ...(outputDir === undefined || outputDirRelative === undefined ? {} : { outputDir, outputDirRelative }),
            ...(outputPhysicalIdentity === undefined || outputPhysicalIdentitySchemaVersion === undefined
              ? {}
              : { outputPhysicalIdentity, outputPhysicalIdentitySchemaVersion }),
            ...(outputSource === undefined ? {} : { outputSource }),
            ...(target === undefined ? {} : { target }),
            ...(scriptIdentity === undefined ? {} : { scriptIdentity }),
          }
        : {}),
      ...(workspaceDirInvalid === undefined ? {} : { workspaceDirInvalid }),
      ...(workspaceDirUnavailable === undefined ? {} : { workspaceDirUnavailable }),
      ...(workspaceDirExplicitInvalid === undefined ? {} : { workspaceDirExplicitInvalid }),
      ...(workspacePhysicalIdentityInvalid === undefined ? {} : { workspacePhysicalIdentityInvalid }),
      ...(semanticInputInvalid === undefined ? {} : { semanticInputInvalid }),
      ...(outputDirInvalid === undefined ? {} : { outputDirInvalid }),
      ...(outputDirUnavailable === undefined ? {} : { outputDirUnavailable }),
      ...(outputPhysicalIdentityInvalid === undefined ? {} : { outputPhysicalIdentityInvalid }),
      ...(outputSourceInvalid === undefined ? {} : { outputSourceInvalid }),
      ...(Object.prototype.hasOwnProperty.call(record, "disposition") ? { disposition: record.disposition } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "result") ? { result: record.result } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(errorInvalid === undefined ? {} : { errorInvalid }),
      ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
      ...(failureDiagnosticInvalid === undefined ? {} : { failureDiagnosticInvalid }),
      ...(exposeBindingMetadata && isArtifactRefArray(record.artifactRefs)
        ? { artifactRefs: record.artifactRefs }
        : {}),
      ...(artifactRefsInvalid === undefined ? {} : { artifactRefsInvalid }),
      ...(exposeBindingMetadata &&
      typeof record.artifactRefsOmitted === "number" &&
      Number.isSafeInteger(record.artifactRefsOmitted) &&
      record.artifactRefsOmitted >= 0
        ? { artifactRefsOmitted: record.artifactRefsOmitted }
        : {}),
      ...(artifactRefsOmittedInvalid === undefined ? {} : { artifactRefsOmittedInvalid }),
      ...(exposeBindingMetadata && resultPersistence !== undefined ? { resultPersistence } : {}),
      ...(resultPersistenceInvalid === undefined ? {} : { resultPersistenceInvalid }),
      // Not gated on `exposeBindingMetadata`: the applied budget describes what the run
      // was ALLOWED to spend, which is true of the envelope whatever its runId says.
      ...(budget === undefined ? {} : { budget }),
      ...(budgetInvalid === undefined ? {} : { budgetInvalid }),
      ...(targetInvalid === undefined ? {} : { targetInvalid }),
      ...(scriptIdentityInvalid === undefined ? {} : { scriptIdentityInvalid }),
      ...(dispositionInvalid === undefined ? {} : { dispositionInvalid }),
    };
  } catch {
    return null;
  }
}

/**
 * The applied-budget envelope, read back exactly as strictly as it is written.
 *
 * The writer emits EVERY axis — an undeclared one as the literal `"unbounded"` —
 * precisely so a reader cannot mistake "nobody declared it" for "this envelope
 * predates the field". A partial or unknown-keyed record would put that ambiguity
 * back, and a reader that rendered it would quietly under-report what a run was
 * allowed to spend. So the key set is closed in both directions: exactly the axes,
 * no more and no fewer, each a positive safe integer or that one word.
 *
 * Returns `undefined` for anything else; the caller records it as `budgetInvalid`
 * rather than throwing, because a malformed budget line does not make the rest of
 * a stored result unreadable.
 */
function parsePersistedBudgetEnvelope(value: unknown): Record<string, number | string> | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== WORKFLOW_BUDGET_AXES.length) return undefined;
  const envelope: Record<string, number | string> = {};
  for (const axis of WORKFLOW_BUDGET_AXES) {
    if (!Object.prototype.hasOwnProperty.call(value, axis)) return undefined;
    const axisValue = value[axis];
    if (axisValue === WORKFLOW_BUDGET_UNBOUNDED) {
      envelope[axis] = WORKFLOW_BUDGET_UNBOUNDED;
      continue;
    }
    if (typeof axisValue !== "number" || !Number.isSafeInteger(axisValue) || axisValue < 1) return undefined;
    envelope[axis] = axisValue;
  }
  return envelope;
}

function isArtifactRefArray(value: unknown): value is WorkflowArtifactRef[] {
  return Array.isArray(value) && value.length <= 20 && value.every(isArtifactRef);
}

function isPersistedFailureDiagnostic(value: unknown): value is WorkflowFailureDiagnostic {
  if (!isRecord(value)) return false;
  const allowed = [
    "origin",
    "message",
    "stage",
    "workflow",
    "scriptPath",
    "evidencePath",
    "journalPath",
    "repairRequest",
    "errorLogPath",
    "errorLogWarning",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (parseWorkflowFailureDiagnostic(value) === undefined) return false;
  return ["stage", "workflow", "scriptPath", "evidencePath", "errorLogPath", "errorLogWarning"].every(
    (field) => !Object.prototype.hasOwnProperty.call(value, field) || typeof value[field] === "string",
  );
}

function parsePersistedResultPersistence(value: unknown, runDir: string): WorkflowResultPersistence {
  if (!isRecord(value)) throw new Error("resultPersistence must be an object");
  const expectedPath = workflowResultFile(runDir);
  if (value.path !== expectedPath) throw new Error("resultPersistence.path does not match the selected run result");
  if (value.ok === true) {
    if (!hasExactFields(value, ["ok", "path"])) throw new Error("resultPersistence success fields are invalid");
    return { ok: true, path: expectedPath };
  }
  if (value.ok === false) {
    if (!hasExactFields(value, ["code", "message", "ok", "path"])) {
      throw new Error("resultPersistence failure fields are invalid");
    }
    if (value.code !== "WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE" && value.code !== "WORKFLOW_RESULT_WRITE_FAILED") {
      throw new Error("resultPersistence failure code is invalid");
    }
    if (typeof value.message !== "string" || value.message.trim() === "") {
      throw new Error("resultPersistence failure message is invalid");
    }
    return {
      ok: false,
      path: expectedPath,
      code: value.code,
      message: value.message,
    };
  }
  throw new Error("resultPersistence.ok must be a boolean");
}

function isWorkspaceUnavailableError(error: unknown): boolean {
  return isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

function isLegacyPrimaryFileReference(value: unknown): value is WorkflowPrimaryFileReference {
  if (!isRecord(value) || typeof value.relativePath !== "string" || value.relativePath === "") return false;
  if (typeof value.absolutePath !== "string" || !path.isAbsolute(value.absolutePath)) return false;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) return false;
  return typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes > 0;
}
