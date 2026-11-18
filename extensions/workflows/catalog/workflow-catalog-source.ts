import { readFileSync } from "node:fs";
import path from "node:path";
import { readWorkflowRunScriptSnapshot, type WorkflowRunScriptSnapshot } from "../runtime/workflow-journal.js";
import {
  listWorkflowCatalogTargets,
  safeWorkflowSourceLocator,
  type ResolvedWorkflowTarget,
} from "../runtime/workflow-discovery.js";
import { sha256WorkflowBytes } from "../runtime/workflow-script-identity.js";
import type { WorkflowCatalogCurrentRow, WorkflowCatalogHistoryRow } from "./workflow-catalog.js";

export type WorkflowSourceReadState =
  | {
      kind: "ready";
      row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow;
      path: string;
      source: string;
      scriptSha256?: string;
    }
  | {
      kind: "missing" | "shadowed" | "unreadable" | "legacy" | "invalid" | "tampered" | "stale";
      row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow;
      message: string;
    };

/** Revalidate the exact selected first-wins target, then read and hash inert bytes once. */
export function readSelectedWorkflowSource(
  selected: WorkflowCatalogCurrentRow,
  projectRoot: string,
  workingDirectory: string,
): WorkflowSourceReadState {
  const current = listWorkflowCatalogTargets(projectRoot, workingDirectory).find(
    (target) => target.ref === selected.target.ref,
  );
  if (current === undefined) {
    return {
      kind: "missing",
      row: selected,
      message: `Selected workflow ${JSON.stringify(selected.name)} is no longer in the current catalog. Return and refresh /workflows list.`,
    };
  }
  if (!sameResolvedTarget(current, selected.target)) {
    return {
      kind: "shadowed",
      row: selected,
      message: `Selected workflow changed precedence from ${selected.sourceLocator} to ${safeWorkflowSourceLocator(current, projectRoot)}. Nothing was opened; return and refresh /workflows list.`,
    };
  }
  try {
    const sourceBytes = readFileSync(current.path);
    return {
      kind: "ready",
      row: selected,
      path: current.path,
      source: sourceBytes.toString("utf8"),
      scriptSha256: sha256WorkflowBytes(sourceBytes),
    };
  } catch (error) {
    return {
      kind: "unreadable",
      row: selected,
      message: `Selected workflow could not be read: ${errorMessage(error)}. Fix access or return to the catalog.`,
    };
  }
}

/** Read the selected current file or exact run snapshot without importing JavaScript. */
export function readWorkflowCatalogSource(
  selected: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow,
  projectRoot: string,
  workingDirectory: string,
): WorkflowSourceReadState {
  if (selected.kind === "current") return readSelectedWorkflowSource(selected, projectRoot, workingDirectory);
  const snapshot = readWorkflowRunScriptSnapshot(projectRoot, selected.runId);
  if (!sameRunSnapshotIdentity(selected.snapshot, snapshot)) {
    return {
      kind: "stale",
      row: selected,
      message: `Run ${selected.runId} snapshot identity changed after catalog selection. Nothing was opened; return and refresh /workflows list.`,
    };
  }
  if (snapshot.kind === "ready") {
    return {
      kind: "ready",
      row: selected,
      path: snapshot.path,
      source: snapshot.source,
      scriptSha256: snapshot.sha256,
    };
  }
  return { kind: snapshot.kind, row: selected, message: snapshot.message };
}

function sameResolvedTarget(left: ResolvedWorkflowTarget, right: ResolvedWorkflowTarget): boolean {
  return (
    left.kind === right.kind &&
    left.ref === right.ref &&
    left.source === right.source &&
    path.resolve(left.path) === path.resolve(right.path)
  );
}

function sameRunSnapshotIdentity(left: WorkflowRunScriptSnapshot, right: WorkflowRunScriptSnapshot): boolean {
  return (
    left.runId === right.runId &&
    samePersistedTarget(left.target, right.target) &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.identityCoverage === right.identityCoverage
  );
}

function samePersistedTarget(
  left: WorkflowRunScriptSnapshot["target"],
  right: WorkflowRunScriptSnapshot["target"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind && left.ref === right.ref && left.source === right.source;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
