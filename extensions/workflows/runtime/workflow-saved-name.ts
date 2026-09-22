/**
 * Canonical identity grammar for saved workflow names.
 *
 * One predicate owns the boundary shared by runtime resolution, catalog
 * discovery, command/tool surfaces, and persisted-run history. Names are
 * identity values: callers must pass the exact string; no trimming or other
 * normalization is allowed.
 */

import path from "node:path";
import { realpathSync } from "node:fs";
import { WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT } from "./workflow-run-layout.js";

export const WORKFLOW_SAVED_NAME_MAX_CHARS = 200;
export const WORKFLOW_SAVED_NAME_PATTERN =
  "^(?=[\\s\\S]{1,200}$)(?!\\s)(?![^/]*\\s/)(?![^/]*/\\s)(?![\\s\\S]*\\s$)(?![\\s\\S]*\\\\)(?![\\s\\S]*[\\u0000-\\u001F\\u007F-\\u009F])(?!\\.{1,2}(?:/|$))(?![^/]+/\\.{1,2}$)(?![^/]*\\.[mM][jJ][sS](?:/|$))(?![^/]+/[^/]*\\.[mM][jJ][sS]$)[^/]+(?:/[^/]+)?$";
const WORKFLOW_SAVED_NAME_REGEX = new RegExp(WORKFLOW_SAVED_NAME_PATTERN);

export function isWorkflowSavedName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= WORKFLOW_SAVED_NAME_MAX_CHARS && WORKFLOW_SAVED_NAME_REGEX.test(value)
  );
}

export function assertWorkflowSavedName(value: unknown): asserts value is string {
  if (!isWorkflowSavedName(value)) {
    throw new Error(`Invalid saved workflow name: ${JSON.stringify(value)}`);
  }
}

export interface WorkflowSavedNameParts {
  root: string;
  child?: string;
}

/** Parse one already-valid logical ref without inferring filesystem layout. */
export function workflowSavedNameParts(value: string): WorkflowSavedNameParts {
  assertWorkflowSavedName(value);
  const [root, child] = value.split("/");
  return child === undefined ? { root: root! } : { root: root!, child };
}

export type WorkflowTargetKind = "name" | "scriptPath";
export type WorkflowTargetSource = "project" | "personal" | "package";

export interface WorkflowTargetIdentity {
  kind: WorkflowTargetKind;
  ref: string;
  source: WorkflowTargetSource;
}

export interface WorkflowTargetIdentityProjectionOptions {
  /** Validated execution path. When present, its physical target owns identity. */
  resolvedPath?: string | undefined;
  /** Project root used to express project paths canonically and relatively. */
  projectRoot?: string | undefined;
}

const POST_CODE_REVIEW_PROJECT_REFS = new Set([`${WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT}/post-code-review.workflow.mjs`]);
const POST_CODE_REVIEW_PROJECT_DIRS = [`${WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT}/post-code-review/`] as const;

/** Owner identity for the post-code-review namespace policy. */
export function isPostCodeReviewTargetIdentity(target: WorkflowTargetIdentity, projectRoot?: string): boolean {
  return isPostCodeReviewTargetProjection(target, { projectRoot });
}

/**
 * Stable target identity shared by live resolution and persisted comparisons.
 * Raw `ref` stays available for display; callers with a validated execution
 * path pass it so internal symlink aliases use the same physical owner path.
 */
export function workflowTargetIdentityKey(
  target: WorkflowTargetIdentity,
  options: WorkflowTargetIdentityProjectionOptions = {},
): string {
  const ref = canonicalWorkflowTargetRef(target, options);
  const physicallyResolved = canonicalTargetPath(options.resolvedPath, options.projectRoot) !== undefined;
  const projectRelativeScript =
    target.kind === "scriptPath" &&
    options.projectRoot !== undefined &&
    normalizeProjectWorkflowRef(target.ref.replaceAll("\\", "/"), options.projectRoot) !== undefined;
  const kind = physicallyResolved || projectRelativeScript ? "resolvedPath" : target.kind;
  return `${kind}\0${target.source}\0${ref}`;
}

/** Owner predicate using the same projection as resume/replay/handoff keys. */
export function isPostCodeReviewTargetProjection(
  target: WorkflowTargetIdentity,
  options: WorkflowTargetIdentityProjectionOptions = {},
): boolean {
  if (target.kind === "name") {
    return (
      (target.source === "project" || target.source === "package") &&
      (target.ref === "post-code-review" || target.ref.startsWith("post-code-review/"))
    );
  }
  if (target.source !== "project") return false;
  const ref = canonicalWorkflowTargetRef(target, options);
  return (
    POST_CODE_REVIEW_PROJECT_REFS.has(ref) ||
    POST_CODE_REVIEW_PROJECT_DIRS.some((directory) => ref.startsWith(directory))
  );
}

export function canonicalWorkflowTargetRef(
  target: WorkflowTargetIdentity,
  options: WorkflowTargetIdentityProjectionOptions = {},
): string {
  let ref = target.ref.replaceAll("\\", "/");
  const canonicalPath = canonicalTargetPath(options.resolvedPath, options.projectRoot);
  if (canonicalPath !== undefined) {
    // A validated execution path is the resolved identity for both name and
    // scriptPath targets; kind/ref remain presentation fields only.
    ref = canonicalPath;
  } else if (target.kind === "scriptPath") {
    ref = normalizeProjectWorkflowRef(ref, options.projectRoot) ?? ref;
  }
  return ref;
}

function canonicalTargetPath(resolvedPath: string | undefined, projectRoot: string | undefined): string | undefined {
  if (resolvedPath === undefined) return undefined;
  try {
    const physicalPath = realpathSync(resolvedPath).replaceAll("\\", "/");
    if (projectRoot === undefined) return physicalPath;
    const physicalRoot = realpathSync(projectRoot);
    const relative = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
    if (relative === "" || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative))
      return undefined;
    return relative;
  } catch {
    return undefined;
  }
}

function normalizeProjectWorkflowRef(ref: string, projectRoot?: string): string | undefined {
  if (path.isAbsolute(ref)) {
    if (projectRoot === undefined) return undefined;
    const relative = path.relative(path.resolve(projectRoot), path.resolve(ref));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    ref = relative;
  }
  const parts: string[] = [];
  for (const part of ref.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Parse the persisted target identity shared by result, artifact, and handoff
 * readers. `path` is a runner-only enrichment and is deliberately discarded;
 * identity remains exactly `{kind, ref, source}`. Unknown fields are rejected
 * (the runner's optional `path` enrichment is type-checked and discarded).
 * A script path is always project-owned; name refs use the exact saved-name
 * grammar and are never trimmed or otherwise canonicalized. Script-path
 * confinement remains owned by target resolution, while this parser enforces
 * the persisted kind/source pairing and preserves the raw ref.
 */
export function parseWorkflowTargetIdentity(value: unknown): WorkflowTargetIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workflow target must be an object.");
  }
  const record = value as Record<string, unknown>;
  const unknownField = Object.keys(record).find((field) => !["kind", "ref", "source", "path"].includes(field));
  if (unknownField !== undefined) throw new Error(`Workflow target field ${unknownField} is not allowed.`);
  if (record.kind !== "name" && record.kind !== "scriptPath") {
    throw new Error("Workflow target kind is invalid.");
  }
  if (typeof record.ref !== "string" || record.ref === "") {
    throw new Error("Workflow target ref is invalid.");
  }
  if (record.source !== "project" && record.source !== "personal" && record.source !== "package") {
    throw new Error("Workflow target source is invalid.");
  }
  if (record.kind === "name") {
    if (!isWorkflowSavedName(record.ref)) throw new Error(`Invalid saved workflow name: ${JSON.stringify(record.ref)}`);
  } else if (record.source !== "project") {
    throw new Error("Workflow scriptPath target must use project source.");
  }
  if (Object.prototype.hasOwnProperty.call(record, "path") && typeof record.path !== "string") {
    throw new Error("Workflow target path is invalid.");
  }
  return { kind: record.kind, ref: record.ref, source: record.source };
}
