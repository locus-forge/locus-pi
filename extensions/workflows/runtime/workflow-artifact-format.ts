/**
 * workflow-artifact-format.ts — the PERSISTED artifact format, and nothing that mutates it.
 *
 * This module owns what `artifacts/index.json` is: the version string, the ref,
 * record and index shapes, the strict parsers that refuse an unknown or malformed
 * field, and the ref identity projection every caller needs in order to name one
 * artifact without carrying the rest of its record.
 *
 * It is deliberately the lower half of the split. `workflow-artifacts.ts` owns the
 * single mutable store — index digests, adoption, provenance verification and
 * continuation consumption — and imports this module. This module must never import
 * the store: a format that can parse an index without a store is what lets a viewer,
 * a diagnostic, and the writer agree on one definition of the file.
 *
 * Parsing is NOT verification. Nothing here reads bytes or checks a digest; a parsed
 * record only claims what the index says. `readWorkflowArtifactRecord` in the store
 * is the reader that proves the bytes.
 */

import path from "node:path";
import { isWorkflowArtifactDisplayName, WORKFLOW_SAFE_COMPONENT_PATTERN } from "./workflow-run-layout.js";

export const WORKFLOW_ARTIFACT_INDEX_VERSION = "locus.workflow.artifacts.v1" as const;
const WORKFLOW_ARTIFACT_COMPONENT_REGEX = new RegExp(WORKFLOW_SAFE_COMPONENT_PATTERN, "u");

/** The four fields that identify one artifact. Nothing else names it. */
export interface WorkflowArtifactRef {
  runId: string;
  artifactId: string;
  name: string;
  sha256: string;
}

export type WorkflowArtifactKind =
  "answer" | "transcript" | "result" | "published" | "primary" | "input" | "operator-ask";
export type WorkflowArtifactProvenance = "fresh" | "replay" | "published" | "consumed";

export interface WorkflowArtifactRecord extends WorkflowArtifactRef {
  kind: WorkflowArtifactKind;
  mediaType: string;
  size: number;
  relativePath: string;
  provenance: WorkflowArtifactProvenance;
  createdAt: string;
  callId?: string;
  toolCallId?: string;
  sequence?: number;
  stage?: string;
  childSessionId?: string;
  source?: WorkflowArtifactRef;
  replaySourceRunId?: string;
}

export interface WorkflowArtifactIndex {
  version: typeof WORKFLOW_ARTIFACT_INDEX_VERSION;
  runId: string;
  artifacts: WorkflowArtifactRecord[];
}

/**
 * Project the four identity fields out of anything that carries them — a full
 * record, or a ref that is already exactly this shape. One definition, so a record
 * can never leak its storage fields into a ref and two copies of "the identity
 * fields" cannot drift apart.
 *
 * This is identity only. It knows nothing about how many refs a caller may show:
 * a bounded display projection and the complete set an operator handoff is built
 * from are different decisions, and they stay in the layers that make them.
 */
export function workflowArtifactRef(source: WorkflowArtifactRef): WorkflowArtifactRef {
  return { runId: source.runId, artifactId: source.artifactId, name: source.name, sha256: source.sha256 };
}

/** Equality over exactly those four identity fields. */
export function sameWorkflowArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.name === right.name &&
    left.sha256 === right.sha256
  );
}

export function assertWorkflowArtifactRef(ref: WorkflowArtifactRef): void {
  if (!isPlainObject(ref)) throw new Error("Workflow artifact reference must be an object.");
  assertWorkflowArtifactComponent(ref.runId, "runId");
  assertWorkflowArtifactComponent(ref.artifactId, "artifactId");
  assertWorkflowArtifactName(ref.name);
  if (typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(ref.sha256)) {
    throw new Error("Workflow artifact reference has an invalid sha256.");
  }
  const keys = Object.keys(ref);
  if (keys.some((key) => !["runId", "artifactId", "name", "sha256"].includes(key))) {
    throw new Error("Workflow artifact reference has unexpected fields.");
  }
}

export function parseWorkflowArtifactIndex(raw: string, expectedRunId: string): WorkflowArtifactIndex {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Workflow artifact index is corrupt: ${errorMessage(error)}`);
  }
  if (
    !isPlainObject(value) ||
    value.version !== WORKFLOW_ARTIFACT_INDEX_VERSION ||
    value.runId !== expectedRunId ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error("Workflow artifact index has an invalid envelope.");
  }
  if (hasUnexpectedFields(value, ["version", "runId", "artifacts"])) {
    throw new Error("Workflow artifact index has unexpected fields.");
  }
  const artifacts = value.artifacts.map((entry) => parseWorkflowArtifactRecord(entry, expectedRunId));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const record of artifacts) {
    if (ids.has(record.artifactId) || paths.has(record.relativePath))
      throw new Error("Workflow artifact index has duplicate identities.");
    ids.add(record.artifactId);
    paths.add(record.relativePath);
  }
  return { version: WORKFLOW_ARTIFACT_INDEX_VERSION, runId: expectedRunId, artifacts };
}

export function parseWorkflowArtifactRecord(value: unknown, runId: string): WorkflowArtifactRecord {
  if (!isPlainObject(value) || value.runId !== runId)
    throw new Error("Workflow artifact index has an invalid record run id.");
  const required = [
    "artifactId",
    "name",
    "sha256",
    "kind",
    "mediaType",
    "relativePath",
    "provenance",
    "createdAt",
  ] as const;
  for (const field of required)
    if (typeof value[field] !== "string") throw new Error(`Workflow artifact record has invalid ${field}.`);
  const allowed = [
    "runId",
    ...required,
    "size",
    "callId",
    "toolCallId",
    "sequence",
    "stage",
    "childSessionId",
    "source",
    "replaySourceRunId",
  ];
  if (hasUnexpectedFields(value, allowed)) throw new Error("Workflow artifact record has unexpected fields.");
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0)
    throw new Error("Workflow artifact record has invalid size.");
  assertWorkflowArtifactRef({
    runId,
    artifactId: value.artifactId as string,
    name: value.name as string,
    sha256: value.sha256 as string,
  });
  if (!isArtifactKind(value.kind) || !isProvenance(value.provenance))
    throw new Error("Workflow artifact record has invalid kind/provenance.");
  const relativePath = normalizeWorkflowArtifactRelativePath(value.relativePath as string);
  const callId = optionalSafeComponent(value.callId, "callId");
  const toolCallId = optionalNonEmptyString(value.toolCallId, "toolCallId");
  const sequence = optionalPositiveSafeInteger(value.sequence, "sequence");
  const stage = optionalNonEmptyString(value.stage, "stage");
  const childSessionId = optionalNonEmptyString(value.childSessionId, "childSessionId");
  const replaySourceRunId = optionalSafeComponent(value.replaySourceRunId, "replaySourceRunId");
  if (value.kind === "operator-ask" && (callId === undefined || toolCallId === undefined || sequence === undefined)) {
    throw new Error("Workflow operator-ask artifact record is missing its stable identity.");
  }
  if (value.kind !== "operator-ask" && (toolCallId !== undefined || sequence !== undefined)) {
    throw new Error("Workflow non-operator artifact record has operator-ask identity fields.");
  }
  if (value.source !== undefined) assertWorkflowArtifactRef(value.source as WorkflowArtifactRef);
  return {
    runId,
    artifactId: value.artifactId as string,
    name: value.name as string,
    sha256: value.sha256 as string,
    kind: value.kind as WorkflowArtifactKind,
    mediaType: value.mediaType as string,
    size: value.size as number,
    relativePath,
    provenance: value.provenance as WorkflowArtifactProvenance,
    createdAt: value.createdAt as string,
    ...(callId !== undefined ? { callId } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(childSessionId !== undefined ? { childSessionId } : {}),
    ...(value.source !== undefined ? { source: workflowArtifactRef(value.source as WorkflowArtifactRef) } : {}),
    ...(replaySourceRunId !== undefined ? { replaySourceRunId } : {}),
  };
}

export function cloneWorkflowArtifactRecord(record: WorkflowArtifactRecord): WorkflowArtifactRecord {
  return { ...record, ...(record.source !== undefined ? { source: workflowArtifactRef(record.source) } : {}) };
}

export function cloneWorkflowArtifactIndex(index: WorkflowArtifactIndex): WorkflowArtifactIndex {
  return { ...index, artifacts: index.artifacts.map(cloneWorkflowArtifactRecord) };
}

export function normalizeWorkflowArtifactRelativePath(value: string): string {
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized === ".."
  ) {
    throw new Error("Workflow artifact relative path is unsafe.");
  }
  return normalized;
}

export function assertWorkflowArtifactComponent(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value))
    throw new Error(`Invalid workflow artifact ${field}: ${JSON.stringify(value)}`);
}

/**
 * An artifact name is the author's DISPLAY label, not the storage id. `artifactId`
 * is the storage id: it is generated by the store, it is safe by construction, and it
 * is what every path is built from. So the name carries no length or alphabet policy —
 * "Design review, round 2" is a legitimate name. What it may not do is act like a
 * path or a control sequence, which is confinement, not size. The predicate is shared
 * with every reader (`workflow-journal.ts`, the `workflow` tool schema) so a name this
 * writer accepts cannot become an unreadable reference one layer later.
 */
export function assertWorkflowArtifactName(value: unknown): asserts value is string {
  if (!isWorkflowArtifactDisplayName(value)) {
    throw new Error(`Invalid workflow artifact name: ${JSON.stringify(value)}`);
  }
}

export function hasUnexpectedFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).some((key) => !allowedSet.has(key));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalSafeComponent(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Workflow artifact record has invalid ${field}.`);
  assertWorkflowArtifactComponent(value, field);
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Workflow artifact record has invalid ${field}.`);
  }
  return value;
}

function optionalPositiveSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Workflow artifact record has invalid ${field}.`);
  }
  return value as number;
}

function isArtifactKind(value: unknown): value is WorkflowArtifactKind {
  return (
    value === "answer" ||
    value === "transcript" ||
    value === "result" ||
    value === "published" ||
    value === "primary" ||
    value === "input" ||
    value === "operator-ask"
  );
}

function isProvenance(value: unknown): value is WorkflowArtifactProvenance {
  return value === "fresh" || value === "replay" || value === "published" || value === "consumed";
}
