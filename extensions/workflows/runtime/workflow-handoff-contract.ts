/**
 * workflow-handoff-contract.ts — what a workflow may declare when it hands off
 * to an operator: the question/declaration types and their normalization.
 *
 * Declarations only, never storage. This module must stay free of node:fs,
 * node:path, the journal and the run layout so the DSL core can import it;
 * rule 7 of scripts/check-extension-layers.ts enforces that. Its durable
 * counterpart is workflow-handoff.ts, which turns a normalized declaration into
 * a published envelope and owns the adjacent claim state.
 */

import type { WorkflowArtifactRef } from "./workflow-artifacts.js";

/**
 * Storage-safe identity component: run ids, artifact ids, question ids, handoff
 * ids. These are keys — they name files and index entries — so they stay narrow.
 * Human-facing text (a title, a prompt, an option label, an artifact's display
 * name) is NOT a key and carries no length or alphabet policy: this contract must
 * not reject a question because somebody wrote a long one. A surface that can only
 * draw so much is a rendering concern and bounds itself, with an explicit
 * "N more" indicator, in the layer that draws it.
 */
export const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;

export interface WorkflowOperatorSelectQuestion {
  kind: "select";
  id: string;
  prompt: string;
  detailArtifactRef?: WorkflowArtifactRef;
  options: Array<{ label: string }>;
  recommended?: string;
  allowCustom?: boolean;
}

export interface WorkflowOperatorTextQuestion {
  kind: "text";
  id: string;
  prompt: string;
  detailArtifactRef?: WorkflowArtifactRef;
}

export type WorkflowOperatorQuestion = WorkflowOperatorSelectQuestion | WorkflowOperatorTextQuestion;

export interface WorkflowOperatorHandoffDeclaration {
  title: string;
  questions: WorkflowOperatorQuestion[];
  continuationArtifactRefs: WorkflowArtifactRef[];
}

export interface WorkflowAwaitOperatorDeclaration {
  reason: string;
  operatorHandoff?: WorkflowOperatorHandoffDeclaration;
}
export function normalizeWorkflowAwaitOperatorDeclaration(value: unknown): WorkflowAwaitOperatorDeclaration {
  const record = requireRecord(value, "awaitOperator input");
  const keys = Object.keys(record).sort();
  const hasHandoff = Object.prototype.hasOwnProperty.call(record, "operatorHandoff");
  const expectedKeys = hasHandoff ? ["operatorHandoff", "reason"] : ["reason"];
  if (!sameStrings(keys, expectedKeys)) {
    throw new Error(
      hasHandoff
        ? "awaitOperator input must contain exactly reason and operatorHandoff"
        : "awaitOperator input must contain exactly reason",
    );
  }
  const reason = normalizeRequiredString(record.reason, "awaitOperator reason", true);
  return {
    reason,
    ...(hasHandoff ? { operatorHandoff: normalizeWorkflowOperatorHandoffDeclaration(record.operatorHandoff) } : {}),
  };
}

export function normalizeWorkflowOperatorHandoffDeclaration(value: unknown): WorkflowOperatorHandoffDeclaration {
  const record = requireExactRecord(value, ["continuationArtifactRefs", "questions", "title"], "operatorHandoff");
  const title = normalizeRequiredString(record.title, "operatorHandoff title");
  if (!Array.isArray(record.questions) || record.questions.length < 1) {
    throw new Error("operatorHandoff questions must contain at least one question");
  }
  const questions = record.questions.map(normalizeQuestion);
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`operatorHandoff question id is duplicated: ${question.id}`);
    ids.add(question.id);
  }
  const continuationArtifactRefs = normalizeArtifactRefs(record.continuationArtifactRefs);
  return { title, questions, continuationArtifactRefs };
}
function normalizeQuestion(value: unknown, index: number): WorkflowOperatorQuestion {
  const record = requireRecord(value, `operatorHandoff question ${index + 1}`);
  if (record.kind === "select") {
    const allowed = ["allowCustom", "detailArtifactRef", "id", "kind", "options", "prompt", "recommended"];
    requireAllowedKeys(record, allowed, `operatorHandoff select question ${index + 1}`);
    const id = normalizeQuestionId(record.id);
    const prompt = normalizeRequiredString(record.prompt, `operatorHandoff question ${id} prompt`);
    if (!Array.isArray(record.options) || record.options.length < 1) {
      throw new Error(`operatorHandoff question ${id} options must contain at least one choice`);
    }
    const options = record.options.map((option, optionIndex) => {
      const optionRecord = requireExactRecord(
        option,
        ["label"],
        `operatorHandoff question ${id} option ${optionIndex + 1}`,
      );
      return {
        label: normalizeRequiredString(
          optionRecord.label,
          `operatorHandoff question ${id} option ${optionIndex + 1} label`,
        ),
      };
    });
    if (new Set(options.map((option) => option.label)).size !== options.length) {
      throw new Error(`operatorHandoff question ${id} option labels must be unique`);
    }
    const recommended =
      record.recommended === undefined
        ? undefined
        : normalizeRequiredString(record.recommended, `operatorHandoff question ${id} recommended`);
    if (recommended !== undefined && !options.some((option) => option.label === recommended)) {
      throw new Error(`operatorHandoff question ${id} recommended label must match an option`);
    }
    if (record.allowCustom !== undefined && typeof record.allowCustom !== "boolean") {
      throw new Error(`operatorHandoff question ${id} allowCustom must be boolean`);
    }
    const detailArtifactRef =
      record.detailArtifactRef === undefined ? undefined : normalizeArtifactRef(record.detailArtifactRef);
    return {
      kind: "select",
      id,
      prompt,
      ...(detailArtifactRef !== undefined ? { detailArtifactRef } : {}),
      options,
      ...(recommended !== undefined ? { recommended } : {}),
      ...(record.allowCustom !== undefined ? { allowCustom: record.allowCustom } : {}),
    };
  }
  if (record.kind === "text") {
    requireAllowedKeys(
      record,
      ["detailArtifactRef", "id", "kind", "prompt"],
      `operatorHandoff text question ${index + 1}`,
    );
    const id = normalizeQuestionId(record.id);
    const detailArtifactRef =
      record.detailArtifactRef === undefined ? undefined : normalizeArtifactRef(record.detailArtifactRef);
    return {
      kind: "text",
      id,
      prompt: normalizeRequiredString(record.prompt, `operatorHandoff question ${id} prompt`),
      ...(detailArtifactRef !== undefined ? { detailArtifactRef } : {}),
    };
  }
  throw new Error(`operatorHandoff question ${index + 1} kind must be select or text`);
}
function normalizeQuestionId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error("operatorHandoff question id must be a safe 1-128 character component");
  }
  return value;
}
export function normalizeArtifactRefs(value: unknown, allowEmpty = false): WorkflowArtifactRef[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1)) {
    throw new Error(
      allowEmpty
        ? "operatorHandoff continuationArtifactRefs must be an array of references"
        : "operatorHandoff continuationArtifactRefs must contain at least one reference",
    );
  }
  const refs = value.map(normalizeArtifactRef);
  const identities = new Set<string>();
  for (const ref of refs) {
    const identity = `${ref.runId}\u001f${ref.artifactId}`;
    if (identities.has(identity)) throw new Error("operatorHandoff continuationArtifactRefs contain a duplicate");
    identities.add(identity);
  }
  return refs;
}

function normalizeArtifactRef(value: unknown): WorkflowArtifactRef {
  const record = requireExactRecord(value, ["artifactId", "name", "runId", "sha256"], "workflow artifact ref");
  assertSafeComponent(record.runId, "workflow artifact runId");
  assertSafeComponent(record.artifactId, "workflow artifact artifactId");
  // The artifact's DISPLAY name. `artifactId` above is the storage id, so this one
  // is checked for confinement and non-emptiness, never for length or alphabet.
  if (
    typeof record.name !== "string" ||
    record.name.trim() === "" ||
    record.name.includes("/") ||
    record.name.includes("\\") ||
    // A control character in a name is never a label.
    /[\u0000-\u001f\u007f]/u.test(record.name) ||
    record.name.trim() === "." ||
    record.name.trim() === ".."
  ) {
    throw new Error("Workflow artifact name is invalid");
  }
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    throw new Error("Workflow artifact sha256 is invalid");
  }
  return {
    runId: record.runId,
    artifactId: record.artifactId,
    name: record.name,
    sha256: record.sha256,
  };
}
/**
 * The same four-field identity as `workflowArtifactRef`/`sameWorkflowArtifactRef` in
 * workflow-artifact-format.ts, and deliberately not imported from there: this module
 * is a declared pure module (rule 7 of scripts/check-extension-layers.ts) and the
 * format module reaches node:path and the run layout. Importing the shared helper
 * puts node:path into the DSL core's value closure and the check fails. The type
 * stays shared; only these two four-line projections are restated.
 */
export function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.name === right.name &&
    left.sha256 === right.sha256
  );
}

export function cloneArtifactRef(ref: WorkflowArtifactRef): WorkflowArtifactRef {
  return { runId: ref.runId, artifactId: ref.artifactId, name: ref.name, sha256: ref.sha256 };
}
/**
 * Human-facing text: required and non-blank, of any length. The absent maximum is
 * the point — a handoff is not rejected because the workflow had a lot to say.
 */
function normalizeRequiredString(value: unknown, label: string, collapseWhitespace = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be non-empty`);
  const normalized = collapseWhitespace ? value.replace(/\s+/gu, " ").trim() : value.trim();
  if (normalized === "") throw new Error(`${label} must be non-empty`);
  return normalized;
}

export function assertSafeComponent(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`${label} must be a safe 1-128 character component`);
  }
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  requireAllowedKeys(record, [...keys, ...optionalKeys], label);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${label} must contain ${key}`);
  }
  return record;
}

export function requireAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${label} has unexpected fields`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
