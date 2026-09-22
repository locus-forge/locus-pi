/**
 * workflow-artifacts.ts — the single mutable artifact store for one run.
 *
 * The persisted format lives next door in `workflow-artifact-format.ts`: the
 * version, the ref/record/index shapes, the strict parsers and the ref identity
 * projection. This module owns everything that MUTATES or PROVES that format —
 * index digests, adoption of a child's files, provenance, and continuation
 * consumption — and re-exports the moved names so existing importers keep one
 * import site.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type { WorkflowAskEvidenceRecord } from "./workflow-ask-tool.js";
import { workflowResultFile } from "./workflow-result.js";
import { parseWorkflowPersistedBinding } from "./workflow-persisted-binding.js";
import {
  assertWorkflowArtifactComponent,
  assertWorkflowArtifactName,
  assertWorkflowArtifactRef,
  cloneWorkflowArtifactIndex,
  cloneWorkflowArtifactRecord,
  errorMessage,
  hasUnexpectedFields,
  isPlainObject,
  normalizeWorkflowArtifactRelativePath,
  parseWorkflowArtifactIndex,
  sameWorkflowArtifactRef,
  workflowArtifactRef,
  WORKFLOW_ARTIFACT_INDEX_VERSION,
  type WorkflowArtifactIndex,
  type WorkflowArtifactKind,
  type WorkflowArtifactProvenance,
  type WorkflowArtifactRecord,
  type WorkflowArtifactRef,
} from "./workflow-artifact-format.js";
import {
  assertWorkflowRunDir,
  assertWorkflowRunDirectoryPath,
  ensureWorkflowDirectoryNoSymlink,
  assertWorkflowRunId,
  readWorkflowRunFile,
  removeWorkflowRunFile,
  renameWorkflowRunFile,
  writeWorkflowRunFile,
  workflowRunArtifactsDir,
  resolveWorkflowRunDir,
  workflowRunFileExists,
  workflowRunRuntimeDir,
} from "./workflow-run-layout.js";

/**
 * The format names this module used to declare itself, kept importable from here so
 * every existing caller keeps one import site. Only what was already public moves
 * across: the parsers and the ref helpers stay reachable at their new owner alone,
 * so no name acquires two import paths.
 */
export {
  WORKFLOW_ARTIFACT_INDEX_VERSION,
  type WorkflowArtifactIndex,
  type WorkflowArtifactKind,
  type WorkflowArtifactProvenance,
  type WorkflowArtifactRecord,
  type WorkflowArtifactRef,
} from "./workflow-artifact-format.js";

export interface WorkflowArtifactSourceTarget {
  kind: "name" | "scriptPath";
  ref: string;
  source: "project" | "personal" | "package";
}

export interface WorkflowConsumedTextArtifact {
  ref: WorkflowArtifactRef;
  text: string;
  source: {
    runId: string;
    target: WorkflowArtifactSourceTarget;
    artifact: { kind: WorkflowArtifactKind; stage?: string };
    terminal: {
      result?: unknown;
      artifactRefs: WorkflowArtifactRef[];
    };
  };
}

/** Closed cross-run control input. Semantic workflow input remains a string. */
export interface WorkflowContinuation {
  originRunId: string;
  artifactRefs: WorkflowArtifactRef[];
}

/** One verified source ref bound to the immutable copy created in the current run. */
export interface WorkflowContinuationArtifact {
  readonly sourceRef: Readonly<WorkflowArtifactRef>;
  readonly consumedArtifact: WorkflowReadonlyConsumedTextArtifact;
}

export interface WorkflowReadonlyConsumedTextArtifact {
  readonly ref: Readonly<WorkflowArtifactRef>;
  readonly text: string;
  readonly source: {
    readonly runId: string;
    readonly target: Readonly<WorkflowArtifactSourceTarget>;
    readonly artifact: Readonly<{ kind: WorkflowArtifactKind; stage?: string }>;
    readonly terminal: {
      readonly result?: unknown;
      readonly artifactRefs: readonly Readonly<WorkflowArtifactRef>[];
    };
  };
}

export interface WorkflowBoundContinuation {
  readonly originRunId: string;
  readonly artifacts: readonly WorkflowContinuationArtifact[];
}

export interface WorkflowContinuationJournal {
  originRunId: string;
  artifacts: Array<{ sourceRef: WorkflowArtifactRef; consumedRef: WorkflowArtifactRef }>;
}

export interface WorkflowAgentEvidenceInput {
  callId: string;
  name: string;
  stage?: string;
  text?: string;
  replayed: boolean;
  replaySourceRunId?: string;
  childSessionId?: string;
  childTracePath?: string;
  resultArtifactPath?: string;
}

export interface WorkflowAgentEvidence {
  answer?: WorkflowArtifactRef;
  transcript?: WorkflowArtifactRef;
  result?: WorkflowArtifactRef;
}

export interface WorkflowArtifactPorts {
  recordAgentEvidence(input: WorkflowAgentEvidenceInput): WorkflowAgentEvidence;
  publishText(name: string, text: string, stage?: string, kind?: "published" | "primary"): WorkflowArtifactRef;
  consumeText(ref: WorkflowArtifactRef, stage?: string): WorkflowConsumedTextArtifact;
}

export interface WorkflowOperatorAskEvidencePort {
  recordOperatorAskEvidence(
    callId: string,
    toolCallId: string,
    sequence: number,
    record: WorkflowAskEvidenceRecord,
  ): WorkflowArtifactRef;
}

export interface WorkflowChildEvidenceDestinations extends WorkflowOperatorAskEvidencePort {
  transcriptDir: string;
  resultArtifactsDir: string;
}

export interface WorkflowArtifactStore extends WorkflowArtifactPorts, WorkflowOperatorAskEvidencePort {
  readonly runId: string;
  readonly artifactsDir: string;
  childEvidenceDestinations(callId: string): WorkflowChildEvidenceDestinations;
  list(): WorkflowArtifactRecord[];
  read(ref: WorkflowArtifactRef): Buffer;
}

/** Validate the complete continuation before copying any bytes into the new run. */
export function assertWorkflowContinuation(value: unknown): asserts value is WorkflowContinuation {
  if (!isPlainObject(value)) throw new Error("Workflow continuation must be an object.");
  if (hasUnexpectedFields(value, ["originRunId", "artifactRefs"])) {
    throw new Error("Workflow continuation has unexpected fields.");
  }
  assertWorkflowArtifactComponent(value.originRunId as string, "continuation originRunId");
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length < 1) {
    throw new Error("Workflow continuation must contain at least one artifactRef.");
  }
  const identities = new Set<string>();
  for (const candidate of value.artifactRefs) {
    assertWorkflowArtifactRef(candidate as WorkflowArtifactRef);
    const ref = candidate as WorkflowArtifactRef;
    if (ref.runId !== value.originRunId) {
      throw new Error("Every continuation artifact ref must belong to originRunId.");
    }
    const identity = `${ref.runId}\u001f${ref.artifactId}`;
    if (identities.has(identity)) throw new Error("Workflow continuation has a duplicate artifact identity.");
    identities.add(identity);
  }
}

/** Digest-verify and consume a validated continuation as exact source/current pairs. */
export function consumeWorkflowContinuation(store: WorkflowArtifactStore, value: unknown): WorkflowBoundContinuation {
  assertWorkflowContinuation(value);
  const artifacts = value.artifactRefs.map((sourceRef) => {
    const consumedArtifact = store.consumeText(sourceRef);
    return freezeContinuationArtifact({ sourceRef: workflowArtifactRef(sourceRef), consumedArtifact });
  });
  return Object.freeze({ originRunId: value.originRunId, artifacts: Object.freeze(artifacts) });
}

export function continuationJournalProjection(binding: WorkflowBoundContinuation): WorkflowContinuationJournal {
  return {
    originRunId: binding.originRunId,
    artifacts: binding.artifacts.map(({ sourceRef, consumedArtifact }) => ({
      sourceRef: workflowArtifactRef(sourceRef),
      consumedRef: workflowArtifactRef(consumedArtifact.ref),
    })),
  };
}

export interface CreateWorkflowArtifactStoreOptions {
  projectRoot: string;
  runId: string;
  runDir: string;
  now?: () => string;
}

export type WorkflowArtifactIndexRead =
  { status: "ready"; index: WorkflowArtifactIndex } | { status: "missing" | "invalid"; message: string };

export type WorkflowArtifactRecordRead =
  | { status: "ready"; record: WorkflowArtifactRecord; bytes: Buffer }
  | { status: "missing" | "invalid" | "tampered"; message: string };

/** Side-effect-free persisted index read for viewers and diagnostics. */
export function readWorkflowArtifactIndex(
  projectRoot: string,
  runId: string,
  resolvedRunDir?: string,
): WorkflowArtifactIndexRead {
  try {
    assertWorkflowArtifactComponent(runId, "runId");
    const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, runId);
    const artifactsDir = workflowRunArtifactsDir(runDir);
    const indexPath = path.join(artifactsDir, "index.json");
    if (!workflowRunFileExists(runDir, indexPath)) {
      return { status: "missing", message: `Workflow artifact index is missing for run ${runId}.` };
    }
    const index = parseWorkflowArtifactIndex(readWorkflowRunFile(runDir, indexPath).toString("utf8"), runId);
    return { status: "ready", index: cloneWorkflowArtifactIndex(index) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { status: "missing", message: `Workflow artifact index is missing for run ${runId}.` };
    }
    return { status: "invalid", message: errorMessage(error) };
  }
}

/** Side-effect-free, digest-verifying read of one indexed artifact. */
export function readWorkflowArtifactRecord(
  projectRoot: string,
  runId: string,
  artifactId: string,
  resolvedRunDir?: string,
): WorkflowArtifactRecordRead {
  try {
    assertWorkflowArtifactComponent(artifactId, "artifactId");
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
  try {
    const runDir = resolvedRunDir ?? resolveWorkflowRunDir(projectRoot, runId);
    const indexRead = readWorkflowArtifactIndex(projectRoot, runId, runDir);
    if (indexRead.status !== "ready") return indexRead;
    const record = indexRead.index.artifacts.find((entry) => entry.artifactId === artifactId);
    if (record === undefined) {
      return { status: "missing", message: `Workflow artifact ${artifactId} is not indexed for run ${runId}.` };
    }
    const artifactsDir = workflowRunArtifactsDir(runDir);
    const bytes = readArtifactFile(runDir, artifactsDir, path.join(artifactsDir, record.relativePath));
    if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256) {
      return { status: "tampered", message: `Workflow artifact digest mismatch: ${record.artifactId}` };
    }
    return { status: "ready", record: cloneWorkflowArtifactRecord(record), bytes };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function createWorkflowArtifactStore(options: CreateWorkflowArtifactStoreOptions): WorkflowArtifactStore {
  assertWorkflowArtifactComponent(options.runId, "runId");
  assertWorkflowRunDir(options.projectRoot, options.runId, options.runDir);
  const runtimeDir = workflowRunRuntimeDir(options.runDir);
  const runDir = options.runDir;
  const artifactsDir = workflowRunArtifactsDir(options.runDir);
  const indexPath = path.join(artifactsDir, "index.json");
  const now = options.now ?? (() => new Date().toISOString());
  ensureWorkflowDirectoryNoSymlink(options.runDir, runtimeDir);
  ensureWorkflowDirectoryNoSymlink(runtimeDir, artifactsDir);
  const existingIndexBytes = workflowRunFileExists(options.runDir, indexPath)
    ? readWorkflowRunFile(options.runDir, indexPath)
    : undefined;
  let index =
    existingIndexBytes === undefined
      ? { version: WORKFLOW_ARTIFACT_INDEX_VERSION, runId: options.runId, artifacts: [] }
      : parseWorkflowArtifactIndex(existingIndexBytes.toString("utf8"), options.runId);
  let indexDigest = existingIndexBytes === undefined ? undefined : sha256(existingIndexBytes);

  function verifyIndexUnchanged(): void {
    if (indexDigest === undefined) {
      if (workflowRunFileExists(options.runDir, indexPath)) {
        throw new Error("Workflow artifact index changed outside its owner.");
      }
      return;
    }
    const bytes = readWorkflowRunFile(options.runDir, indexPath);
    if (sha256(bytes) !== indexDigest) throw new Error("Workflow artifact index changed outside its owner.");
  }

  function persistIndex(next: WorkflowArtifactIndex): void {
    verifyIndexUnchanged();
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    const temp = path.join(artifactsDir, `.index-${process.pid}-${Date.now()}.tmp`);
    let tempCreated = false;
    try {
      writeWorkflowRunFile(options.runDir, temp, bytes, { exclusive: true });
      tempCreated = true;
      renameWorkflowRunFile(options.runDir, temp, indexPath);
    } catch (error) {
      if (tempCreated && workflowRunFileExists(options.runDir, temp)) removeWorkflowRunFile(options.runDir, temp);
      throw error;
    }
    index = next;
    indexDigest = sha256(bytes);
  }

  function addRecord(
    input: Omit<WorkflowArtifactRecord, "runId" | "sha256" | "size" | "createdAt" | "relativePath"> & {
      bytes: Buffer;
      relativePath: string;
    },
  ): WorkflowArtifactRef {
    verifyIndexUnchanged();
    assertWorkflowArtifactComponent(input.artifactId, "artifactId");
    assertWorkflowArtifactName(input.name);
    if (
      input.kind === "operator-ask" &&
      (input.callId === undefined || input.toolCallId === undefined || input.sequence === undefined)
    ) {
      throw new Error("Workflow operator-ask artifact requires its stable identity.");
    }
    if (input.kind !== "operator-ask" && (input.toolCallId !== undefined || input.sequence !== undefined)) {
      throw new Error("Workflow non-operator artifact cannot carry operator-ask identity fields.");
    }
    const relativePath = normalizeWorkflowArtifactRelativePath(input.relativePath);
    if (index.artifacts.some((entry) => entry.artifactId === input.artifactId || entry.relativePath === relativePath)) {
      throw new Error(`Duplicate workflow artifact identity: ${input.artifactId}`);
    }
    const destination = path.join(artifactsDir, relativePath);
    ensureWorkflowDirectoryNoSymlink(artifactsDir, path.dirname(destination));
    if (workflowRunFileExists(options.runDir, destination)) {
      throw new Error(`Workflow artifact destination already exists: ${relativePath}`);
    }
    writeWorkflowRunFile(options.runDir, destination, input.bytes, { exclusive: true });
    try {
      const digest = sha256(input.bytes);
      const record: WorkflowArtifactRecord = {
        runId: options.runId,
        artifactId: input.artifactId,
        name: input.name,
        sha256: digest,
        kind: input.kind,
        mediaType: input.mediaType,
        size: input.bytes.byteLength,
        relativePath,
        provenance: input.provenance,
        createdAt: now(),
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
        ...(input.source !== undefined ? { source: workflowArtifactRef(input.source) } : {}),
        ...(input.replaySourceRunId !== undefined ? { replaySourceRunId: input.replaySourceRunId } : {}),
      };
      persistIndex({ ...index, artifacts: [...index.artifacts, record] });
      return workflowArtifactRef(record);
    } catch (error) {
      if (workflowRunFileExists(options.runDir, destination)) removeWorkflowRunFile(options.runDir, destination);
      throw error;
    }
  }

  function adoptFile(input: {
    artifactId: string;
    name: string;
    kind: "transcript" | "result";
    mediaType: string;
    sourcePath: string;
    callId: string;
    stage?: string;
    childSessionId?: string;
  }): WorkflowArtifactRef {
    const bytes = readArtifactFile(options.runDir, artifactsDir, input.sourcePath);
    const relativePath = normalizeWorkflowArtifactRelativePath(path.relative(artifactsDir, input.sourcePath));
    if (input.kind === "transcript") validateTranscript(bytes, input.childSessionId);
    return addExistingRecord({ ...input, relativePath, bytes, provenance: "fresh" });
  }

  function addExistingRecord(input: {
    artifactId: string;
    name: string;
    kind: WorkflowArtifactKind;
    mediaType: string;
    relativePath: string;
    callId: string;
    provenance: WorkflowArtifactProvenance;
    bytes: Buffer;
    stage?: string;
    childSessionId?: string;
  }): WorkflowArtifactRef {
    verifyIndexUnchanged();
    const relativePath = normalizeWorkflowArtifactRelativePath(input.relativePath);
    if (index.artifacts.some((entry) => entry.artifactId === input.artifactId || entry.relativePath === relativePath)) {
      throw new Error(`Duplicate workflow artifact identity: ${input.artifactId}`);
    }
    const record: WorkflowArtifactRecord = {
      runId: options.runId,
      artifactId: input.artifactId,
      name: input.name,
      sha256: sha256(input.bytes),
      kind: input.kind,
      mediaType: input.mediaType,
      size: input.bytes.byteLength,
      relativePath,
      provenance: input.provenance,
      createdAt: now(),
      callId: input.callId,
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
    };
    persistIndex({ ...index, artifacts: [...index.artifacts, record] });
    return workflowArtifactRef(record);
  }

  function recordAgentEvidence(input: WorkflowAgentEvidenceInput): WorkflowAgentEvidence {
    assertWorkflowArtifactComponent(input.callId, "callId");
    assertWorkflowArtifactName(input.name);
    const evidence: WorkflowAgentEvidence = {};
    if (input.text !== undefined && input.text.trim() !== "") {
      const bytes = Buffer.from(input.text, "utf8");
      evidence.answer = addRecord({
        artifactId: `${input.callId}-answer`,
        name: input.name,
        kind: "answer",
        mediaType: "text/markdown; charset=utf-8",
        bytes,
        relativePath: path.join("answers", `${input.callId}-${safeFilename(input.name)}.md`),
        provenance: input.replayed ? "replay" : "fresh",
        callId: input.callId,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.replaySourceRunId !== undefined ? { replaySourceRunId: input.replaySourceRunId } : {}),
      });
    }
    if (input.replayed) return evidence;
    if (input.childSessionId !== undefined && input.childTracePath === undefined) {
      throw new Error(`Fresh child ${input.childSessionId} did not export a transcript.`);
    }
    if (input.childSessionId !== undefined && input.resultArtifactPath === undefined) {
      throw new Error(`Fresh child ${input.childSessionId} did not persist a result envelope.`);
    }
    if (input.childTracePath !== undefined) {
      evidence.transcript = adoptFile({
        artifactId: `${input.callId}-transcript`,
        name: `${input.name}.transcript`,
        kind: "transcript",
        mediaType: "application/x-ndjson",
        sourcePath: input.childTracePath,
        callId: input.callId,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
      });
    }
    if (input.resultArtifactPath !== undefined) {
      evidence.result = adoptFile({
        artifactId: `${input.callId}-result`,
        name: `${input.name}.result`,
        kind: "result",
        mediaType: "application/json",
        sourcePath: input.resultArtifactPath,
        callId: input.callId,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
      });
    }
    return evidence;
  }

  function recordOperatorAskEvidence(
    callId: string,
    toolCallId: string,
    sequence: number,
    record: WorkflowAskEvidenceRecord,
  ): WorkflowArtifactRef {
    assertWorkflowArtifactComponent(callId, "callId");
    if (typeof toolCallId !== "string" || toolCallId.trim() === "") {
      throw new Error("Workflow operator-ask evidence requires a non-empty toolCallId.");
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Workflow operator-ask evidence sequence must be a positive safe integer.");
    }
    if (record.toolCallId !== toolCallId) {
      throw new Error("Workflow operator-ask evidence toolCallId does not match its record.");
    }
    const ordinal = String(sequence).padStart(4, "0");
    const artifactId = `${callId}-operator-ask-${ordinal}`;
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    return addRecord({
      artifactId,
      name: `operator-ask-${ordinal}.json`,
      kind: "operator-ask",
      mediaType: "application/json",
      bytes: Buffer.from(serialized, "utf8"),
      relativePath: path.join("operator-asks", callId, `operator-ask-${ordinal}.json`),
      provenance: "fresh",
      callId,
      toolCallId,
      sequence,
    });
  }

  function publishText(
    name: string,
    text: string,
    stage?: string,
    kind: "published" | "primary" = "published",
  ): WorkflowArtifactRef {
    assertWorkflowArtifactName(name);
    if (kind === "primary" && index.artifacts.some((entry) => entry.kind === "primary")) {
      throw new Error("workflow artifact store already contains a primary output");
    }
    const ordinal =
      index.artifacts.filter((entry) => entry.kind === "published" || entry.kind === "primary").length + 1;
    const artifactId = `published-${String(ordinal).padStart(4, "0")}`;
    return addRecord({
      artifactId,
      name,
      kind,
      mediaType: "text/markdown; charset=utf-8",
      bytes: Buffer.from(text, "utf8"),
      relativePath: path.join("published", `${artifactId}-${markdownFilename(name)}`),
      provenance: "published",
      ...(stage !== undefined ? { stage } : {}),
    });
  }

  function consumeText(ref: WorkflowArtifactRef, stage?: string): WorkflowConsumedTextArtifact {
    assertWorkflowArtifactRef(ref);
    if (ref.runId === options.runId) throw new Error("Workflow artifact self-reference is not allowed.");
    const sourceRunDir = resolveWorkflowRunDir(options.projectRoot, ref.runId);
    const resultBytes = readWorkflowRunFile(sourceRunDir, workflowResultFile(sourceRunDir));
    const sourceEnvelope = parseSourceRunEnvelope(resultBytes, ref.runId, options.projectRoot, sourceRunDir);
    const sourceRead = readWorkflowArtifactRecord(options.projectRoot, ref.runId, ref.artifactId, sourceRunDir);
    if (sourceRead.status !== "ready") throw new Error(sourceRead.message);
    const sourceRecord = sourceRead.record;
    if (!sameWorkflowArtifactRef(sourceRecord, ref))
      throw new Error("Workflow artifact reference does not match its source index.");
    // Admission is the source run's FULL verified index, not the compact projection
    // result.json carries for display: `readWorkflowArtifactRecord` above proved the
    // id, the byte digest and the record's provenance, and the envelope read proved
    // the source run is a real terminal run of a known target. An artifact older than
    // the newest few therefore stays consumable for as long as its bytes exist.
    if (!sourceRecord.mediaType.startsWith("text/")) throw new Error("Workflow artifact is not text media.");
    const bytes = sourceRead.bytes;
    const text = bytes.toString("utf8");
    const ordinal = index.artifacts.filter((entry) => entry.kind === "input").length + 1;
    const artifactId = `input-${String(ordinal).padStart(4, "0")}`;
    const currentRef = addRecord({
      artifactId,
      name: ref.name,
      kind: "input",
      mediaType: sourceRecord.mediaType,
      bytes,
      relativePath: path.join("inputs", `${artifactId}-${markdownFilename(ref.name)}`),
      provenance: "consumed",
      source: workflowArtifactRef(ref),
      ...(stage !== undefined ? { stage } : {}),
    });
    return {
      ref: currentRef,
      text,
      source: {
        runId: ref.runId,
        target: sourceEnvelope.target,
        artifact: {
          kind: sourceRecord.kind,
          ...(sourceRecord.stage !== undefined ? { stage: sourceRecord.stage } : {}),
        },
        terminal: sourceEnvelope.terminal,
      },
    };
  }

  if (indexDigest === undefined) persistIndex(index);

  return {
    runId: options.runId,
    artifactsDir,
    recordAgentEvidence,
    recordOperatorAskEvidence,
    publishText,
    consumeText,
    childEvidenceDestinations(callId) {
      assertWorkflowArtifactComponent(callId, "callId");
      const transcriptDir = path.join(artifactsDir, "transcripts", callId);
      const resultArtifactsDir = path.join(artifactsDir, "results", callId);
      for (const dir of [transcriptDir, resultArtifactsDir]) assertWorkflowRunDirectoryPath(runDir, dir, false);
      return { transcriptDir, resultArtifactsDir, recordOperatorAskEvidence };
    },
    list() {
      verifyIndexUnchanged();
      return index.artifacts.map(cloneWorkflowArtifactRecord);
    },
    read(ref) {
      assertWorkflowArtifactRef(ref);
      if (ref.runId !== options.runId) throw new Error("Workflow artifact belongs to another run.");
      verifyIndexUnchanged();
      const record = index.artifacts.find((entry) => entry.artifactId === ref.artifactId);
      if (record === undefined || !sameWorkflowArtifactRef(record, ref))
        throw new Error("Workflow artifact reference does not match its index.");
      const bytes = readArtifactFile(runDir, artifactsDir, path.join(artifactsDir, record.relativePath));
      if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256) {
        throw new Error(`Workflow artifact digest mismatch: ${record.artifactId}`);
      }
      return bytes;
    },
  };
}

function parseSourceRunEnvelope(
  bytes: Buffer,
  runId: string,
  projectRoot: string,
  runDir: string,
): {
  target: WorkflowArtifactSourceTarget;
  terminal: { result?: unknown; artifactRefs: WorkflowArtifactRef[] };
} {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Source workflow run is not usable: ${runId}: ${errorMessage(error)}`);
  }
  if (!isPlainObject(value) || value.ok !== true || !isPlainObject(value.target)) {
    throw new Error(`Source workflow run is not usable: ${runId}`);
  }
  let persistedRunId: string;
  try {
    persistedRunId = assertWorkflowRunId(value.runId);
  } catch {
    throw new Error(`Source workflow run has no valid persisted runId: ${runId}`);
  }
  if (persistedRunId !== runId) {
    throw new Error(`Source workflow run result belongs to another run: ${runId}`);
  }
  const binding = parseWorkflowPersistedBinding(value, projectRoot, runId, { verifySnapshot: true, runDir });
  if (binding.targetInvalid !== undefined || binding.target === undefined) {
    throw new Error(`Source workflow run has an invalid target identity: ${runId}`);
  }
  if (binding.scriptIdentityInvalid !== undefined) {
    throw new Error(`Source workflow run has malformed script identity: ${runId}: ${binding.scriptIdentityInvalid}`);
  }
  if (binding.dispositionInvalid !== undefined) {
    throw new Error(`Source workflow run has malformed disposition: ${runId}: ${binding.dispositionInvalid}`);
  }
  const target: WorkflowArtifactSourceTarget = binding.target;
  let artifactRefs: WorkflowArtifactRef[] = [];
  if (value.artifactRefs !== undefined) {
    if (!Array.isArray(value.artifactRefs)) {
      throw new Error(`Source workflow run has invalid artifact references: ${runId}`);
    }
    try {
      artifactRefs = value.artifactRefs.map((ref) => {
        assertWorkflowArtifactRef(ref as WorkflowArtifactRef);
        return workflowArtifactRef(ref as WorkflowArtifactRef);
      });
    } catch {
      throw new Error(`Source workflow run has invalid artifact references: ${runId}`);
    }
  }
  return {
    target,
    terminal: {
      ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
      artifactRefs,
    },
  };
}

function readArtifactFile(runDir: string, artifactsDir: string, file: string): Buffer {
  const relative = path.relative(path.resolve(artifactsDir), path.resolve(file));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow artifact path escapes its artifact root.");
  }
  return readWorkflowRunFile(runDir, file);
}

function validateTranscript(bytes: Buffer, childSessionId?: string): void {
  const firstLine = bytes.toString("utf8").split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") throw new Error("Child transcript header is missing.");
  const header = JSON.parse(firstLine) as unknown;
  if (
    !isPlainObject(header) ||
    header.type !== "session" ||
    (childSessionId !== undefined && header.id !== childSessionId)
  ) {
    throw new Error("Child transcript header does not match its session.");
  }
}

/**
 * The longest filename component this derivation emits. Not a policy about the
 * name — the full label stays in the index and in every ref — but the real limit
 * common filesystems enforce on one component (255 bytes), left room for the
 * `artifactId` prefix and an extension.
 */
const MAX_ARTIFACT_FILENAME_COMPONENT_CHARS = 120;

function safeFilename(value: string): string {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "artifact";
  return base.length > MAX_ARTIFACT_FILENAME_COMPONENT_CHARS
    ? base.slice(0, MAX_ARTIFACT_FILENAME_COMPONENT_CHARS).replace(/-+$/u, "")
    : base;
}

function markdownFilename(value: string): string {
  const safe = safeFilename(value);
  return safe.endsWith(".md") ? safe : `${safe}.md`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezeContinuationArtifact(input: {
  sourceRef: WorkflowArtifactRef;
  consumedArtifact: WorkflowConsumedTextArtifact;
}): WorkflowContinuationArtifact {
  const sourceRef = Object.freeze(workflowArtifactRef(input.sourceRef));
  const consumed = input.consumedArtifact;
  const consumedArtifact = Object.freeze({
    ref: Object.freeze(workflowArtifactRef(consumed.ref)),
    text: consumed.text,
    source: Object.freeze({
      runId: consumed.source.runId,
      target: Object.freeze({ ...consumed.source.target }),
      artifact: Object.freeze({ ...consumed.source.artifact }),
      terminal: Object.freeze({
        ...(Object.prototype.hasOwnProperty.call(consumed.source.terminal, "result")
          ? { result: consumed.source.terminal.result }
          : {}),
        artifactRefs: Object.freeze(
          consumed.source.terminal.artifactRefs.map((ref) => Object.freeze(workflowArtifactRef(ref))),
        ),
      }),
    }),
  });
  return Object.freeze({ sourceRef, consumedArtifact });
}
