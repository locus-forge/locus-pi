/**
 * Saved-workflow discovery and identity.
 *
 * A directory named `<root>` owns an optional `<root>.workflow.mjs` entry and
 * every sibling `<child>.workflow.mjs` directly inside it. Resolution selects
 * that whole namespace from one source; children never fall through
 * independently. A namespace without its root entry is a group-only catalog
 * namespace: children remain runnable, while the group itself is not.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { assertWorkflowSavedName, isWorkflowSavedName, workflowSavedNameParts } from "./workflow-saved-name.js";
import { WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME } from "./workflow-run-layout.js";

export const WORKFLOW_ENTRY_SUFFIX = ".workflow.mjs";
const PACKAGED_EXAMPLES_DIR = fileURLToPath(new URL("../examples/", import.meta.url));
const PROJECT_WORKFLOW_DIRS: readonly [string, string][] = [[WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME]];

export type WorkflowTargetKind = "name" | "scriptPath";
export type WorkflowTargetSource = "project" | "personal" | "package";

export interface ResolvedWorkflowTarget {
  kind: WorkflowTargetKind;
  ref: string;
  path: string;
  source: WorkflowTargetSource;
}

export interface WorkflowDefinition {
  /** Undefined for a group-only namespace; never synthesize a runnable target. */
  root?: ResolvedWorkflowTarget;
  rootRef: string;
  namespacePath: string;
  children: readonly ResolvedWorkflowTarget[];
  legacyFlat: boolean;
}

export interface PackagedWorkflowEntry {
  name: string;
  path: string;
}

export interface WorkflowTargetComposition {
  rootRef: string;
  role: "root" | "child";
  label: string;
  childRef?: string;
}

interface WorkflowSearchDirectory {
  directory: string;
  source: WorkflowTargetSource;
}

type WorkflowSearchDirectoryState =
  { state: "missing" } | { state: "blocked"; error: string } | { state: "ready"; entries: Dirent[] };

type WorkflowEntryState = "missing" | "regular-file" | "directory" | "invalid";

type WorkflowNamespaceState =
  { state: "missing" } | { state: "blocked"; error: string } | { state: "ready"; definition: WorkflowDefinition };

export class WorkflowNameNotFoundError extends Error {
  readonly workflowName: string;

  constructor(name: string) {
    super(`Workflow name is not saved or registered by the package: ${name}`);
    this.name = "WorkflowNameNotFoundError";
    this.workflowName = name;
  }
}

export class WorkflowGroupOnlyError extends Error {
  readonly workflowName: string;

  constructor(name: string) {
    super(`Workflow namespace is group-only and has no runnable root: ${name}`);
    this.name = "WorkflowGroupOnlyError";
    this.workflowName = name;
  }
}

export function workflowTargetComposition(target: Pick<ResolvedWorkflowTarget, "ref">): WorkflowTargetComposition {
  const { root, child } = workflowSavedNameParts(target.ref);
  return child === undefined
    ? { rootRef: root, role: "root", label: root }
    : { rootRef: root, childRef: child, role: "child", label: child };
}

export function packagedExamplesDir(): string {
  return PACKAGED_EXAMPLES_DIR;
}

export function listPackagedWorkflowEntries(): PackagedWorkflowEntry[] {
  const roots = packageRootNames();
  const entries: PackagedWorkflowEntry[] = [];
  for (const root of roots) {
    const namespace = inspectNamespace(
      { directory: PACKAGED_EXAMPLES_DIR, source: "package" },
      root,
      PACKAGED_EXAMPLES_DIR,
    );
    if (namespace.state === "blocked") throw new Error(namespace.error);
    if (namespace.state === "ready") {
      entries.push(
        ...(namespace.definition.root === undefined ? [] : [namespace.definition.root])
          .concat(namespace.definition.children)
          .map((target) => ({ name: target.ref, path: target.path })),
      );
    }
  }
  return entries;
}

export function packagedWorkflowNames(): string[] {
  return listPackagedWorkflowEntries().map((entry) => entry.name);
}

export function packagedWorkflowPath(name: string): string {
  assertWorkflowSavedName(name);
  const entry = listPackagedWorkflowEntries().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new WorkflowNameNotFoundError(name);
  return entry.path;
}

export function resolveWorkflowTarget(
  target: { name?: string; scriptPath?: string; script?: string },
  projectRoot: string,
  workingDirectory?: string,
): ResolvedWorkflowTarget {
  const supplied = [target.name, target.scriptPath, target.script].filter((value) => value !== undefined);
  if (supplied.length !== 1) {
    throw new Error("Exactly one workflow target field is required: name, scriptPath, or script");
  }
  if (target.name !== undefined) {
    return resolveSavedWorkflowPath(target.name, projectRoot, workingDirectory ?? projectRoot);
  }
  const raw = target.scriptPath ?? target.script;
  if (raw === undefined) throw new Error("Missing workflow target");
  if (target.script !== undefined && !hasPathSeparators(raw) && !hasWorkflowModuleSuffix(raw)) {
    return resolveSavedWorkflowPath(raw, projectRoot, workingDirectory ?? projectRoot);
  }
  const resolved = resolveConfinedScriptPath(raw, projectRoot);
  return { kind: "scriptPath", ref: raw, path: resolved, source: "project" };
}

export function listWorkflowCatalogTargets(
  projectRoot: string,
  workingDirectory = projectRoot,
): ResolvedWorkflowTarget[] {
  return listWorkflowDefinitions(projectRoot, workingDirectory).flatMap((definition) => [
    ...(definition.root === undefined ? [] : [definition.root]),
    ...definition.children,
  ]);
}

/** Discover first-wins namespaces without erasing their root/child ownership. */
export function listWorkflowDefinitions(projectRoot: string, workingDirectory = projectRoot): WorkflowDefinition[] {
  const definitions = new Map<string, WorkflowDefinition>();
  const blockedRoots = new Set<string>();
  for (const search of workflowSearchDirectories(projectRoot, workingDirectory)) {
    const listing = readWorkflowSearchDirectory(search, projectRoot);
    if (listing.state === "missing") continue;
    if (listing.state === "blocked") throw new Error(listing.error);
    const roots = candidateRootNames(listing.entries, search.source);
    for (const root of roots) {
      if (blockedRoots.has(root) || definitions.has(root)) continue;
      const namespace = inspectNamespace(search, root, projectRoot);
      if (namespace.state === "blocked") {
        blockedRoots.add(root);
        continue;
      }
      if (namespace.state === "missing") continue;
      definitions.set(root, namespace.definition);
    }
  }
  return [...definitions.values()];
}

/** Resolve one short child name inside the exact selected root namespace. */
export function resolveOwnedWorkflowChild(
  parent: ResolvedWorkflowTarget,
  child: string,
  projectRoot: string,
  workingDirectory = projectRoot,
): ResolvedWorkflowTarget {
  if (!isWorkflowSavedName(child) || child.includes("/")) {
    throw new Error(`Invalid saved workflow child name: ${JSON.stringify(child)}`);
  }
  if (parent.kind !== "name" || parent.ref.includes("/")) {
    throw new Error("invokeWorkflow child requires a saved root workflow");
  }
  const namespaceDirectory = path.dirname(parent.path);
  const expectedRoot = path.join(namespaceDirectory, `${parent.ref}${WORKFLOW_ENTRY_SUFFIX}`);
  if (path.basename(namespaceDirectory) !== parent.ref || path.resolve(expectedRoot) !== path.resolve(parent.path)) {
    throw new Error(`invokeWorkflow child requires a folder-owned root workflow: ${JSON.stringify(parent.ref)}`);
  }
  const resolved = resolveWorkflowTarget({ name: `${parent.ref}/${child}` }, projectRoot, workingDirectory);
  if (
    resolved.source !== parent.source ||
    path.resolve(path.dirname(resolved.path)) !== path.resolve(namespaceDirectory)
  ) {
    throw new Error(`Owned workflow namespace changed while resolving child ${JSON.stringify(child)}`);
  }
  return resolved;
}

/** Validate a host-owned binding without trusting its path or source fields. */
export function assertResolvedWorkflowTargetBinding(
  binding: unknown,
  request: { name?: string; scriptPath?: string; script?: string },
  projectRoot: string,
  workingDirectory = projectRoot,
): ResolvedWorkflowTarget {
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    throw new Error("Workflow target binding must be an object");
  }
  const record = binding as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "kind,path,ref,source") {
    throw new Error("Workflow target binding has unexpected fields");
  }
  if (record.kind !== "name" && record.kind !== "scriptPath")
    throw new Error("Workflow target binding kind is invalid");
  if (typeof record.ref !== "string" || record.ref === "") throw new Error("Workflow target binding ref is invalid");
  if (record.source !== "project" && record.source !== "personal" && record.source !== "package") {
    throw new Error("Workflow target binding source is invalid");
  }
  if (typeof record.path !== "string" || record.path === "") throw new Error("Workflow target binding path is invalid");

  const publicFields = [request.name, request.scriptPath, request.script].filter((value) => value !== undefined);
  if (publicFields.length !== 1) throw new Error("Workflow target binding requires exactly one public target field");
  const publicRef = publicFields[0]!;
  const expectedKind =
    request.name !== undefined ||
    (request.script !== undefined && !hasPathSeparators(request.script) && !hasWorkflowModuleSuffix(request.script))
      ? "name"
      : "scriptPath";
  if (record.kind !== expectedKind || record.ref !== publicRef) {
    throw new Error("Workflow target binding does not match the public target request");
  }
  if (record.kind === "name") assertWorkflowSavedName(record.ref);

  const sourceRoots: Record<WorkflowTargetSource, string> = {
    project: path.resolve(projectRoot),
    personal: personalWorkflowRoot(),
    package: PACKAGED_EXAMPLES_DIR,
  };
  const lexicalRoot = path.resolve(sourceRoots[record.source]);
  const lexicalPath = path.resolve(record.path);
  if (!isPathWithinRoot(lexicalRoot, lexicalPath)) throw new Error("Workflow target binding escapes the project root");
  if (record.source !== "package") confinedWorkflowSourcePath(lexicalPath, record.source, projectRoot, record.ref);
  assertRegularConfinedFile(lexicalPath, lexicalRoot, "Workflow target binding");

  const resolved = resolveWorkflowTarget(
    request.name !== undefined
      ? { name: request.name }
      : request.scriptPath !== undefined
        ? { scriptPath: request.scriptPath }
        : { script: request.script! },
    projectRoot,
    workingDirectory,
  );
  if (
    resolved.kind !== record.kind ||
    resolved.ref !== record.ref ||
    resolved.source !== record.source ||
    path.resolve(resolved.path) !== lexicalPath
  ) {
    throw new Error("Workflow target binding no longer matches the resolved target");
  }
  return { kind: record.kind, ref: record.ref, source: record.source, path: lexicalPath };
}

export function safeWorkflowSourceLocator(target: ResolvedWorkflowTarget, projectRoot: string): string {
  const root =
    target.source === "package"
      ? PACKAGED_EXAMPLES_DIR
      : target.source === "personal"
        ? personalWorkflowRoot()
        : path.resolve(projectRoot);
  const relative = path.relative(path.resolve(root), path.resolve(target.path)).split(path.sep).join("/");
  if (relative === "" || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    return `${target.source}:${target.ref}`;
  }
  return relative;
}

function resolveSavedWorkflowPath(name: string, projectRoot: string, workingDirectory: string): ResolvedWorkflowTarget {
  assertWorkflowSavedName(name);
  const composition = workflowTargetComposition({ ref: name });
  const searches = workflowSearchDirectories(projectRoot, workingDirectory);
  for (const search of searches) {
    const listing = readWorkflowSearchDirectory(search, projectRoot);
    if (listing.state === "blocked") throw new Error(listing.error);
  }
  for (const search of searches) {
    const namespace = inspectNamespace(search, composition.rootRef, projectRoot);
    if (namespace.state === "missing") continue;
    if (namespace.state === "blocked") throw new Error(namespace.error);
    const candidates = [
      ...(namespace.definition.root === undefined ? [] : [namespace.definition.root]),
      ...namespace.definition.children,
    ];
    const target = candidates.find((candidate) => candidate.ref === name);
    if (target !== undefined) return target;
    if (composition.role === "child") {
      throw new Error(
        `Workflow child ${JSON.stringify(composition.childRef)} does not exist in namespace ${JSON.stringify(composition.rootRef)}`,
      );
    }
    if (namespace.definition.root === undefined) throw new WorkflowGroupOnlyError(name);
  }
  throw new WorkflowNameNotFoundError(name);
}

function inspectNamespace(search: WorkflowSearchDirectory, root: string, projectRoot: string): WorkflowNamespaceState {
  const flatPath = path.join(search.directory, `${root}${WORKFLOW_ENTRY_SUFFIX}`);
  const folderPath = path.join(search.directory, root);
  const flatState = workflowEntryState(flatPath);
  const folderState = workflowEntryState(folderPath);
  const flatPresent = flatState !== "missing";
  const folderPresent = folderState !== "missing";
  if (!flatPresent && !folderPresent) return { state: "missing" };
  if (flatPresent && folderPresent) {
    return { state: "blocked", error: `Workflow namespace is ambiguous (folder and flat entry): ${root}` };
  }
  if (flatPresent) {
    if (search.source === "package") {
      return { state: "blocked", error: `Package workflow must use a folder namespace: ${root}` };
    }
    if (flatState !== "regular-file") {
      return { state: "blocked", error: `Workflow entry is not a regular file: ${flatPath}` };
    }
    try {
      const targetPath = confinedWorkflowSourcePath(
        flatPath,
        search.source,
        projectRoot,
        `${root}${WORKFLOW_ENTRY_SUFFIX}`,
      );
      return {
        state: "ready",
        definition: {
          root: { kind: "name", ref: root, path: targetPath, source: search.source },
          rootRef: root,
          namespacePath: search.directory,
          children: [],
          legacyFlat: true,
        },
      };
    } catch (error) {
      return { state: "blocked", error: errorMessage(error) };
    }
  }
  if (folderState !== "directory") {
    return { state: "blocked", error: `Workflow namespace is not a directory: ${folderPath}` };
  }
  try {
    const safeFolder = confinedWorkflowSourcePath(folderPath, search.source, projectRoot, root);
    const rootPath = path.join(safeFolder, `${root}${WORKFLOW_ENTRY_SUFFIX}`);
    const rootPresent = workflowEntryState(rootPath) !== "missing";
    if (rootPresent && workflowEntryState(rootPath) !== "regular-file") {
      return { state: "blocked", error: `Workflow namespace root entry is not a regular file: ${rootPath}` };
    }
    const targetRoot = rootPresent ? confinedWorkflowSourcePath(rootPath, search.source, projectRoot, root) : undefined;
    const entries = readdirSync(safeFolder, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(WORKFLOW_ENTRY_SUFFIX))
      .sort((left, right) => left.name.localeCompare(right.name));
    const children: ResolvedWorkflowTarget[] = [];
    for (const entry of entries) {
      const child = entry.name.slice(0, -WORKFLOW_ENTRY_SUFFIX.length);
      if (child === root) continue;
      if (!isWorkflowSavedName(child) || child.includes("/")) {
        return { state: "blocked", error: `Workflow namespace contains an invalid child entry: ${entry.name}` };
      }
      const childPath = path.join(safeFolder, entry.name);
      if (workflowEntryState(childPath) !== "regular-file") {
        return { state: "blocked", error: `Workflow child entry is not a regular file: ${childPath}` };
      }
      const safeChild = confinedWorkflowSourcePath(childPath, search.source, projectRoot, entry.name);
      children.push({ kind: "name", ref: `${root}/${child}`, path: safeChild, source: search.source });
    }
    if (targetRoot === undefined && children.length === 0) {
      return { state: "blocked", error: `Workflow namespace has no direct workflow entries: ${safeFolder}` };
    }
    return {
      state: "ready",
      definition: {
        ...(targetRoot === undefined
          ? {}
          : { root: { kind: "name", ref: root, path: targetRoot, source: search.source } }),
        rootRef: root,
        namespacePath: safeFolder,
        children,
        legacyFlat: false,
      },
    };
  } catch (error) {
    return { state: "blocked", error: errorMessage(error) };
  }
}

function candidateRootNames(entries: readonly Dirent[], source: WorkflowTargetSource): string[] {
  const roots = new Set<string>();
  for (const entry of entries) {
    let root: string | undefined;
    if (entry.name.endsWith(WORKFLOW_ENTRY_SUFFIX)) root = entry.name.slice(0, -WORKFLOW_ENTRY_SUFFIX.length);
    else if (entry.isDirectory() || entry.isSymbolicLink()) root = entry.name;
    if (root !== undefined && isWorkflowSavedName(root) && !root.includes("/")) roots.add(root);
  }
  if (source === "package") {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(WORKFLOW_ENTRY_SUFFIX)) {
        const root = entry.name.slice(0, -WORKFLOW_ENTRY_SUFFIX.length);
        if (isWorkflowSavedName(root) && !root.includes("/")) roots.add(root);
      }
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function packageRootNames(): string[] {
  const listing = readWorkflowSearchDirectory(
    { directory: PACKAGED_EXAMPLES_DIR, source: "package" },
    PACKAGED_EXAMPLES_DIR,
  );
  if (listing.state === "blocked") throw new Error(listing.error);
  return listing.state === "ready" ? candidateRootNames(listing.entries, "package") : [];
}

function workflowSearchDirectories(projectRoot: string, workingDirectory: string): WorkflowSearchDirectory[] {
  const directories: WorkflowSearchDirectory[] = [];
  const currentRoot = path.resolve(projectRoot);
  const requestedWorkingDirectory = path.resolve(workingDirectory);
  const workingRelative = path.relative(currentRoot, requestedWorkingDirectory);
  let current =
    workingRelative === "" || (!workingRelative.startsWith("..") && !path.isAbsolute(workingRelative))
      ? requestedWorkingDirectory
      : currentRoot;
  while (true) {
    for (const [first, second] of PROJECT_WORKFLOW_DIRS) {
      directories.push({ directory: path.join(current, first, second), source: "project" });
    }
    if (current === currentRoot) break;
    const parent = path.dirname(current);
    const parentRelative = path.relative(currentRoot, parent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) break;
    current = parent;
  }
  directories.push({ directory: personalWorkflowRoot(), source: "personal" });
  directories.push({ directory: PACKAGED_EXAMPLES_DIR, source: "package" });
  return directories;
}

function readWorkflowSearchDirectory(
  search: WorkflowSearchDirectory,
  projectRoot: string,
): WorkflowSearchDirectoryState {
  let stat;
  try {
    stat = lstatSync(search.directory, { throwIfNoEntry: false });
  } catch {
    return { state: "blocked", error: `Workflow search directory is unreadable: ${search.directory}` };
  }
  if (stat === undefined) return { state: "missing" };
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    return { state: "blocked", error: `Workflow search directory is not a directory: ${search.directory}` };
  }
  try {
    confinedWorkflowSourcePath(search.directory, search.source, projectRoot, search.directory);
    if (!statSync(realpathSync(search.directory)).isDirectory()) {
      return { state: "blocked", error: `Workflow search directory is not a directory: ${search.directory}` };
    }
    return { state: "ready", entries: readdirSync(search.directory, { withFileTypes: true }) };
  } catch (error) {
    if (
      error instanceof Error &&
      /escapes (?:project root|personal workflow root|the home directory)/u.test(error.message)
    ) {
      return { state: "blocked", error: error.message };
    }
    return { state: "blocked", error: `Workflow search directory is unsafe or unreadable: ${search.directory}` };
  }
}

function personalWorkflowRoot(): string {
  return path.join(homedir(), WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME);
}

function confinedWorkflowSourcePath(
  sourcePath: string,
  source: WorkflowTargetSource,
  projectRoot: string,
  displayRef: string,
): string {
  if (source === "project") return resolveConfinedSourcePath(sourcePath, projectRoot, displayRef, "project root");
  if (source === "package")
    return resolveConfinedSourcePath(sourcePath, PACKAGED_EXAMPLES_DIR, displayRef, "Package root");
  const homeRoot = path.resolve(homedir());
  const root = personalWorkflowRoot();
  const physicalRoot = realpathSync(root);
  if (!isPathWithinRoot(realpathSync(homeRoot), physicalRoot)) {
    throw new Error(`Personal workflow root escapes the home directory: ${root}`);
  }
  return resolveConfinedSourcePath(sourcePath, root, displayRef, "personal workflow root");
}

function resolveConfinedScriptPath(scriptPath: string, projectRoot: string, displayRef = scriptPath): string {
  return resolveConfinedSourcePath(path.resolve(projectRoot, scriptPath), projectRoot, displayRef, "project root");
}

function resolveConfinedSourcePath(
  sourcePath: string,
  sourceRoot: string,
  displayRef: string,
  rootLabel: string,
): string {
  const lexicalRoot = path.resolve(sourceRoot);
  const resolved = path.resolve(sourcePath);
  const subject = rootLabel === "project root" ? "Script path" : "Workflow source";
  if (!isPathWithinRoot(lexicalRoot, resolved)) throw new Error(`${subject} escapes ${rootLabel}: ${displayRef}`);
  const state = workflowEntryState(resolved);
  if (state === "missing") return resolved;
  let physicalRoot: string;
  let physicalTarget: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
    physicalTarget = realpathSync(resolved);
  } catch {
    return resolved;
  }
  if (!isPathWithinRoot(physicalRoot, physicalTarget)) {
    throw new Error(`${subject} escapes ${rootLabel} through a symlink: ${displayRef}`);
  }
  return resolved;
}

function assertRegularConfinedFile(filePath: string, root: string, label: string): void {
  let current = path.resolve(root);
  for (const part of path.relative(root, filePath).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (!stat.isSymbolicLink() && current !== filePath && !stat.isDirectory()) {
      throw new Error(`${label} ancestor is not a directory`);
    }
  }
  const physicalRoot = realpathSync(root);
  const physicalPath = realpathSync(filePath);
  if (!isPathWithinRoot(physicalRoot, physicalPath)) throw new Error(`${label} escapes the physical project root`);
  if (!statSync(physicalPath).isFile()) throw new Error(`${label} is not a regular file`);
}

function workflowEntryState(filePath: string): WorkflowEntryState {
  let leaf;
  try {
    leaf = lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    return "invalid";
  }
  if (leaf === undefined) return "missing";
  if (leaf.isFile()) return "regular-file";
  if (leaf.isDirectory()) return "directory";
  if (!leaf.isSymbolicLink()) return "invalid";
  try {
    const target = lstatSync(realpathSync(filePath));
    if (target.isFile()) return "regular-file";
    if (target.isDirectory()) return "directory";
    return "invalid";
  } catch {
    return "invalid";
  }
}

function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasPathSeparators(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function hasWorkflowModuleSuffix(value: string): boolean {
  return /\.mjs$/iu.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
