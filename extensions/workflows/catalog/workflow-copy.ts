/**
 * Copy one saved workflow namespace between catalog sources.
 *
 * The namespace is the unit because it owns its optional root, direct children,
 * and resources. Destinations are claimed exclusively and never overwritten.
 */

import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WorkflowCatalogCurrentRow } from "./workflow-catalog.js";
import { readSelectedWorkflowSource } from "./workflow-catalog.js";
import { WORKFLOW_ENTRY_SUFFIX } from "../runtime/workflow-discovery.js";
import { WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME } from "../runtime/workflow-run-layout.js";

export type WorkflowCopyDestination = "project" | "personal";

export type WorkflowCopyResult =
  | {
      status: "copied";
      destination: WorkflowCopyDestination;
      destinationPath: string;
      rootName: string;
    }
  | {
      status: "exists";
      destination: WorkflowCopyDestination;
      destinationPath: string;
      conflictPath: string;
      rootName: string;
    };

/** Destinations that add a new, higher- or lower-scope editable copy. */
export function workflowCopyDestinations(row: WorkflowCatalogCurrentRow): WorkflowCopyDestination[] {
  if (!folderOwnedNamespaceDirectory(row)) return [];
  if (row.source === "project") return ["personal"];
  if (row.source === "personal") return ["project"];
  return ["project", "personal"];
}

/** Copy the selected namespace after revalidating its current identity. */
export function copyWorkflowNamespace(
  selected: WorkflowCatalogCurrentRow,
  destination: WorkflowCopyDestination,
  projectRoot: string,
  workingDirectory: string,
): WorkflowCopyResult {
  if (!workflowCopyDestinations(selected).includes(destination)) {
    throw new Error(
      `Workflow ${JSON.stringify(selected.name)} cannot be copied from ${selected.sourceLabel} to ${copyDestinationLabel(destination)}.`,
    );
  }
  const boundaryRoot = destination === "project" ? path.resolve(projectRoot) : path.resolve(homedir());
  const catalogDirectory = path.join(boundaryRoot, WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME);
  const destinationPath = path.join(catalogDirectory, selected.rootName);
  const flatConflictPath = path.join(catalogDirectory, `${selected.rootName}${WORKFLOW_ENTRY_SUFFIX}`);
  for (const conflictPath of [destinationPath, flatConflictPath]) {
    if (lstatSync(conflictPath, { throwIfNoEntry: false }) !== undefined) {
      return {
        status: "exists",
        destination,
        destinationPath,
        conflictPath,
        rootName: selected.rootName,
      };
    }
  }

  const state = readSelectedWorkflowSource(selected, projectRoot, workingDirectory);
  if (state.kind !== "ready") throw new Error(state.message);

  const sourceDirectory = folderOwnedNamespaceDirectory(selected);
  if (sourceDirectory === undefined || path.resolve(path.dirname(state.path)) !== path.resolve(sourceDirectory)) {
    throw new Error(
      `Workflow namespace ${JSON.stringify(selected.rootName)} changed after catalog selection. Nothing was copied; refresh /workflows list.`,
    );
  }
  assertNamespaceSymlinksConfined(sourceDirectory);

  assertSafeDestinationChain(boundaryRoot, [WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME]);
  mkdirSync(catalogDirectory, { recursive: true });
  assertPathWithinBoundary(realpathSync(catalogDirectory), realpathSync(boundaryRoot));

  let claimed = false;
  try {
    mkdirSync(destinationPath);
    claimed = true;
    for (const entry of readdirSync(sourceDirectory)) {
      cpSync(path.join(sourceDirectory, entry), path.join(destinationPath, entry), {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: true,
      });
    }
  } catch (error) {
    if (claimed) rmSync(destinationPath, { recursive: true, force: true });
    throw error;
  }

  return { status: "copied", destination, destinationPath, rootName: selected.rootName };
}

/** Materialization may follow links only when their targets stay in this namespace. */
function assertNamespaceSymlinksConfined(sourceDirectory: string): void {
  const physicalRoot = realpathSync(sourceDirectory);
  const inspect = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        assertPathWithinBoundary(realpathSync(entryPath), physicalRoot);
      } else if (stat.isDirectory()) {
        inspect(entryPath);
      }
    }
  };
  inspect(sourceDirectory);
}

export function copyDestinationLabel(destination: WorkflowCopyDestination): "Project" | "User" {
  return destination === "project" ? "Project" : "User";
}

function folderOwnedNamespaceDirectory(row: WorkflowCatalogCurrentRow): string | undefined {
  const directory = path.dirname(row.originPath);
  return path.basename(directory) === row.rootName ? directory : undefined;
}

function assertSafeDestinationChain(boundaryRoot: string, relativeParts: readonly string[]): void {
  let current = boundaryRoot;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) throw new Error(`Workflow copy destination contains a symbolic link: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Workflow copy destination is not a directory: ${current}`);
  }
}

function assertPathWithinBoundary(candidate: string, boundary: string): void {
  const relative = path.relative(boundary, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workflow copy destination escapes its allowed root: ${candidate}`);
  }
}
